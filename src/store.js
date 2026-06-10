import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { dirname, join }  from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath }  from "node:url";
import { VALIDATOR_TTL_SECONDS } from "./validators.js";
import { clamp01, isPromotableEvidence } from "./contracts.js";

// H4: fingerprint — 16 hex chars from sha256 of (normalised statement + type)
function fingerprint(statement, type) {
  return createHash("sha256")
    .update(`${String(statement).trim().toLowerCase()}:${type || "general"}`)
    .digest("hex")
    .slice(0, 16);
}

const DEFAULT_DATA_DIR = new URL("../data", import.meta.url);

export class EvidenceStore {
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir      = dataDir instanceof URL ? fileURLToPath(dataDir) : dataDir;
    this.claimsPath   = join(this.dataDir, "claims.json");
    this.evidencePath = join(this.dataDir, "evidence.jsonl");
    this.#initialized = false;
    this.#writeLock   = Promise.resolve();
  }

  #initialized;
  #writeLock;

  async init() {
    if (this.#initialized) return;
    await mkdir(dirname(this.claimsPath), { recursive: true });
    try { await readFile(this.claimsPath, "utf8"); }
    catch { await writeFile(this.claimsPath, "[]\n", "utf8"); }
    try { await readFile(this.evidencePath, "utf8"); }
    catch { await writeFile(this.evidencePath, "", "utf8"); }
    this.#initialized = true;
  }

  async listClaims(query = "") {
    const claims = await this.#readClaims();
    const withStatus = await Promise.all(claims.map(c => this.#applyStaleStatus(c)));
    if (!query) return withStatus.sort(sortNewest);
    const q = query.toLowerCase();
    return withStatus
      .filter(c => JSON.stringify(c).toLowerCase().includes(q))
      .sort(sortNewest);
  }

  // P11 (F10): cheap prefilter for contradiction detection (no evidence
  // hydration, no stale recomputation — warnings are advisory).
  async listPromotedClaims(minRw = 0.75, limit = 500) {
    const claims = await this.#readClaims();
    return claims
      .filter(c => (c.realityWeight ?? 0) >= minRw && ["verified", "contradicted"].includes(c.status))
      .sort(sortNewest)
      .slice(0, limit);
  }

  async getClaim(id) {
    const claims = await this.#readClaims();
    const claim  = claims.find(c => c.id === id);
    if (!claim) return null;
    const evidence = await this.getEvidenceForClaim(id);
    return { ...await this.#applyStaleStatus(claim), evidence };
  }

  async createClaim(input) {
    return this.#withLock(async () => {
      // H4: dedup by fingerprint — return existing fresh claim if one matches
      const fp     = fingerprint(input.statement, input.type || "general");
      const claims = await this.#readClaims();
      const STALE_STATUSES = new Set(["stale", "failed", "unverifiable"]);
      const existing = claims.find(c => c.fingerprint === fp && !STALE_STATUSES.has(c.status));
      if (existing) return existing;

      const now   = new Date().toISOString();
      const claim = {
        id:            input.id || `claim_${randomUUID()}`,
        statement:     input.statement,
        type:          input.type || "general",
        status:        "provisional",
        confidence:    clamp01(input.confidence, 0.1),
        realityWeight: 0.1,
        tags:          Array.isArray(input.tags) ? input.tags : [],
        source:        input.source || "model",
        reasoning:     input.reasoning ? String(input.reasoning) : null,  // F20
        fingerprint:   fp,  // H4
        createdAt:     now,
        updatedAt:     now,
        latestResult:  null
      };
      claims.push(claim);
      await this.#writeClaims(claims);
      return claim;
    });
  }

  // H6: invalidation chain — links new evidence to the previous record it supersedes.
  // C3: computes expiresAt from per-validator TTL.
  async appendEvidence(claimId, evidence) {
    const now = new Date().toISOString();

    // Find the most recent previous evidence for this claim (for H6 chain)
    const existing = await this.getEvidenceForClaim(claimId);
    const previous = existing[0]?.id ?? null;

    // Compute TTL expiry (C3)
    const ttl      = VALIDATOR_TTL_SECONDS[evidence.validator] ?? null;
    const expiresAt = (ttl !== null)
      ? new Date(Date.now() + ttl * 1000).toISOString()
      : null;

    const record = {
      id:         evidence.id || `evidence_${randomUUID()}`,
      claimId,
      timestamp:  now,
      supersedes: previous,   // H6
      expiresAt,              // C3
      ...evidence
    };

    await appendFile(this.evidencePath, `${JSON.stringify(record)}\n`, "utf8");
    await this.#withLock(() => this.#updateClaimFromEvidence(claimId, record));
    return record;
  }

  async getEvidenceForClaim(claimId) {
    const all = await this.searchEvidence("");
    return all
      .filter(r => r.claimId === claimId)
      .map(applyDecay)
      .sort(sortNewest);
  }

  async searchEvidence(query = "") {
    await this.init();
    const raw  = await readFile(this.evidencePath, "utf8");
    const rows = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const decayed = rows.map(applyDecay);
    if (!query) return decayed.sort(sortNewest);
    const q = query.toLowerCase();
    return decayed
      .filter(r => JSON.stringify(r).toLowerCase().includes(q))
      .sort(sortNewest);
  }

  // ── Private helpers ────────────────────────────────────────────────────
  async #readClaims() {
    await this.init();
    return JSON.parse(await readFile(this.claimsPath, "utf8"));
  }

  async #writeClaims(claims) {
    await writeFile(this.claimsPath, `${JSON.stringify(claims, null, 2)}\n`, "utf8");
  }

  // H7: full status taxonomy; H6: handles stale propagation
  async #updateClaimFromEvidence(claimId, evidence) {
    const claims = await this.#readClaims();
    const index  = claims.findIndex(c => c.id === claimId);
    if (index === -1) return;

    // Determine status from evidence — H7 full taxonomy
    const evidenceStatus = evidence.status; // may be "failed" or "unverifiable"
    const status = evidenceStatus === "failed"       ? "failed"
      : evidenceStatus === "unverifiable"            ? "unverifiable"
      : evidenceStatus === "blocked"                 ? "blocked"
      : evidenceStatus === "irrelevant"              ? "irrelevant"
      : evidenceStatus === "syntactic"               ? "syntactic"
      : evidenceStatus === "simulated"               ? "simulated"
      : isPromotableEvidence(evidence) && evidence.verified     ? "verified"
      : isPromotableEvidence(evidence) && evidence.contradicted ? "contradicted"
                                                     : "partial";

    claims[index] = {
      ...claims[index],
      status,
      confidence:    clamp01(evidence.confidence),
      realityWeight: clamp01(evidence.realityWeight),
      latestResult:  evidence.result,
      updatedAt:     evidence.timestamp
    };
    await this.#writeClaims(claims);
  }

  // C3: check if all evidence for a claim is stale and promote claim status
  async #applyStaleStatus(claim) {
    if (!["verified", "contradicted", "partial"].includes(claim.status)) return claim;
    const evidence = await this.getEvidenceForClaim(claim.id);
    if (!evidence.length) return claim;
    const allStale = evidence.every(e => e.status === "stale");
    if (!allStale) return claim;
    return {
      ...claim,
      status:        "stale",
      realityWeight: Math.max(0.1, claim.realityWeight * 0.5)
    };
  }

  async #withLock(fn) {
    let unlock;
    const ticket = new Promise(resolve => { unlock = resolve; });
    const prev   = this.#writeLock;
    this.#writeLock = ticket;
    await prev;
    try { return await fn(); }
    finally { unlock(); }
  }
}

// ── C3: Decay applied at read time ─────────────────────────────────────────
// Evidence is never deleted — decay is computed from expiresAt.
function applyDecay(record) {
  if (!record.expiresAt) return record;           // deterministic — no expiry
  const now     = Date.now();
  const expires = new Date(record.expiresAt).getTime();
  if (now < expires) return record;               // still fresh

  const elapsed = now - expires;
  const maxAge  = 24 * 60 * 60 * 1000;           // full decay over 24h
  const factor  = Math.max(0.1, 1 - (elapsed / maxAge) * 0.9);

  return {
    ...record,
    status:        "stale",
    confidence:    Number((record.confidence    * factor).toFixed(3)),
    realityWeight: Math.max(0.1, Number((record.realityWeight * factor).toFixed(3)))
  };
}

function sortNewest(a, b) {
  return String(b.timestamp || b.updatedAt || b.createdAt)
    .localeCompare(String(a.timestamp || a.updatedAt || a.createdAt));
}

// ── C5: Store factory — prefers SQLite (Node 22+), falls back to JSON files ─
// Dynamic import means the try/catch catches cases where node:sqlite is absent.
export async function createStore(dataDir) {
  try {
    const { SqliteStore } = await import("./store-sqlite.js");
    const store = new SqliteStore(dataDir);
    await store.init();
    return store;
  } catch {
    // node:sqlite unavailable (Node < 22, or flag not set) — use file-based store
    const store = new EvidenceStore(dataDir);
    await store.init();
    return store;
  }
}
