/**
 * C5: SQLite-backed evidence store.
 * Uses node:sqlite (stable in Node 23.4+, experimental with --experimental-sqlite on Node 22).
 * Automatically migrates existing claims.json + evidence.jsonl on first use.
 * H4: fingerprint dedup is built into createClaim().
 * H6: supersedes chain maintained in evidence table.
 * C3: TTL / decay applied at read time.
 */
import { DatabaseSync }            from "node:sqlite";
import { mkdir, readFile }         from "node:fs/promises";
import { join }                    from "node:path";
import { randomUUID, createHash }  from "node:crypto";
import { fileURLToPath }           from "node:url";
import { VALIDATOR_TTL_SECONDS }   from "./validators.js";
import { clamp01, isPromotableEvidence } from "./contracts.js";

const DEFAULT_DATA_DIR = new URL("../data", import.meta.url);

// ── H4: deterministic fingerprint ─────────────────────────────────────────
function fingerprint(statement, type) {
  return createHash("sha256")
    .update(`${String(statement).trim().toLowerCase()}:${type || "general"}`)
    .digest("hex")
    .slice(0, 16);
}

// ── C3: decay applied at read time ────────────────────────────────────────
function applyDecay(record) {
  if (!record.expiresAt) return record;
  const now     = Date.now();
  const expires = new Date(record.expiresAt).getTime();
  if (now < expires) return record;
  const elapsed = now - expires;
  const maxAge  = 24 * 60 * 60 * 1000;
  const factor  = Math.max(0.1, 1 - (elapsed / maxAge) * 0.9);
  return {
    ...record,
    status:        "stale",
    confidence:    Number((record.confidence    * factor).toFixed(3)),
    realityWeight: Math.max(0.1, Number((record.realityWeight * factor).toFixed(3)))
  };
}

// ── Row mappers ────────────────────────────────────────────────────────────
function rowToClaim(row) {
  if (!row) return null;
  return {
    id:            row.id,
    statement:     row.statement,
    type:          row.type,
    status:        row.status,
    confidence:    row.confidence,
    realityWeight: row.reality_weight,
    tags:          JSON.parse(row.tags || "[]"),
    source:        row.source,
    reasoning:     row.reasoning ?? null,
    fingerprint:   row.fingerprint,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
    latestResult:  row.latest_result ? JSON.parse(row.latest_result) : null
  };
}

function rowToEvidence(row) {
  if (!row) return null;
  const status = row.status ||
    (row.verified    ? "verified"    :
     row.contradicted ? "contradicted" : "provisional");
  return {
    id:            row.id,
    claimId:       row.claim_id,
    timestamp:     row.timestamp,
    supersedes:    row.supersedes   ?? null,
    expiresAt:     row.expires_at   ?? null,
    validator:     row.validator,
    verified:      row.verified    === 1,
    contradicted:  row.contradicted === 1,
    status,
    confidence:    row.confidence,
    realityWeight: row.reality_weight,
    result:        JSON.parse(row.result || "{}")
  };
}

// ── SqliteStore ────────────────────────────────────────────────────────────
export class SqliteStore {
  #db;
  #initialized = false;

  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir instanceof URL ? fileURLToPath(dataDir) : dataDir;
  }

  async init() {
    if (this.#initialized) return;
    await mkdir(this.dataDir, { recursive: true });
    this.#db = new DatabaseSync(join(this.dataDir, "antipsyc.db"));
    this.#createSchema();
    await this.#migrate();
    this.#initialized = true;
    console.error("[antipsyc] SQLite persistence active");
  }

  #createSchema() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id             TEXT PRIMARY KEY,
        statement      TEXT NOT NULL,
        type           TEXT NOT NULL DEFAULT 'general',
        status         TEXT NOT NULL DEFAULT 'provisional',
        confidence     REAL NOT NULL DEFAULT 0.1,
        reality_weight REAL NOT NULL DEFAULT 0.1,
        tags           TEXT NOT NULL DEFAULT '[]',
        source         TEXT NOT NULL DEFAULT 'model',
        fingerprint    TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        latest_result  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_claims_fp  ON claims(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_claims_upd ON claims(updated_at DESC);

      CREATE TABLE IF NOT EXISTS evidence (
        id             TEXT PRIMARY KEY,
        claim_id       TEXT NOT NULL REFERENCES claims(id),
        timestamp      TEXT NOT NULL,
        supersedes     TEXT,
        expires_at     TEXT,
        validator      TEXT NOT NULL,
        verified       INTEGER NOT NULL DEFAULT 0,
        contradicted   INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT '',
        confidence     REAL NOT NULL DEFAULT 0,
        reality_weight REAL NOT NULL DEFAULT 0,
        result         TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_ev_claim ON evidence(claim_id);
      CREATE INDEX IF NOT EXISTS idx_ev_ts    ON evidence(timestamp DESC);
    `);
    // F20: persist the reasoning trace so re-verification by claimId can see
    // it. ALTER is a no-op error when the column already exists.
    try { this.#db.exec("ALTER TABLE claims ADD COLUMN reasoning TEXT"); } catch { /* exists */ }
  }

  // One-time migration from the legacy JSON/JSONL files into SQLite.
  async #migrate() {
    const claimsPath   = join(this.dataDir, "claims.json");
    const evidencePath = join(this.dataDir, "evidence.jsonl");

    // Only migrate if SQLite is still empty
    const { n } = this.#db.prepare("SELECT COUNT(*) AS n FROM claims").get();
    if (n > 0) return;

    let claimsJson;
    try { claimsJson = await readFile(claimsPath, "utf8"); }
    catch { return; }  // No legacy file — fresh start

    let claims;
    try { claims = JSON.parse(claimsJson); }
    catch { return; }
    if (!claims.length) return;

    const insertClaim = this.#db.prepare(`
      INSERT OR IGNORE INTO claims
        (id, statement, type, status, confidence, reality_weight,
         tags, source, fingerprint, created_at, updated_at, latest_result)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const c of claims) {
      const fp = c.fingerprint || fingerprint(c.statement, c.type || "general");
      insertClaim.run(
        c.id, c.statement, c.type || "general", c.status || "provisional",
        c.confidence ?? 0.1, c.realityWeight ?? 0.1,
        JSON.stringify(c.tags || []), c.source || "model",
        fp,
        c.createdAt || new Date().toISOString(),
        c.updatedAt || new Date().toISOString(),
        c.latestResult ? JSON.stringify(c.latestResult) : null
      );
    }

    // Migrate evidence JSONL
    try {
      const raw  = await readFile(evidencePath, "utf8");
      const rows = raw.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
      const insertEv = this.#db.prepare(`
        INSERT OR IGNORE INTO evidence
          (id, claim_id, timestamp, supersedes, expires_at, validator,
           verified, contradicted, status, confidence, reality_weight, result)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const e of rows) {
        insertEv.run(
          e.id, e.claimId, e.timestamp,
          e.supersedes ?? null, e.expiresAt ?? null,
          e.validator,
          e.verified     ? 1 : 0,
          e.contradicted ? 1 : 0,
          e.status || "",
          e.confidence    ?? 0,
          e.realityWeight ?? 0,
          JSON.stringify(e.result || {})
        );
      }
    } catch { /* no evidence file yet — that's fine */ }

    console.error(`[antipsyc] Migrated ${claims.length} claims from JSON files to SQLite`);
  }

  // ── Public API ─────────────────────────────────────────────────────────
  async listClaims(query = "") {
    await this.init();
    let rows;
    if (query) {
      const q = `%${query.toLowerCase()}%`;
      rows = this.#db.prepare(`
        SELECT * FROM claims
        WHERE lower(statement) LIKE ? OR lower(type) LIKE ?
           OR lower(source) LIKE ? OR lower(status) LIKE ?
        ORDER BY updated_at DESC
      `).all(q, q, q, q);
    } else {
      rows = this.#db.prepare("SELECT * FROM claims ORDER BY updated_at DESC").all();
    }
    const claims = rows.map(rowToClaim);
    return Promise.all(claims.map(c => this.#applyStaleStatus(c)));
  }

  // P11 (F10): indexed prefilter for contradiction detection — only promoted
  // high-confidence claims can contradict, so never scan the full ledger.
  async listPromotedClaims(minRw = 0.75, limit = 500) {
    await this.init();
    const rows = this.#db.prepare(`
      SELECT * FROM claims
      WHERE reality_weight >= ? AND status IN ('verified','contradicted')
      ORDER BY updated_at DESC LIMIT ?
    `).all(minRw, limit);
    return rows.map(rowToClaim);
  }

  async getClaim(id) {
    await this.init();
    const row = this.#db.prepare("SELECT * FROM claims WHERE id = ?").get(id);
    if (!row) return null;
    const claim    = rowToClaim(row);
    const evidence = await this.getEvidenceForClaim(id);
    return { ...await this.#applyStaleStatus(claim), evidence };
  }

  async createClaim(input) {
    await this.init();
    if (!input.statement) throw new Error("statement is required");

    // H4: return existing fresh claim if fingerprint matches
    const fp = fingerprint(input.statement, input.type || "general");
    const existing = this.#db.prepare(`
      SELECT * FROM claims
      WHERE fingerprint = ? AND status NOT IN ('stale','failed','unverifiable')
      ORDER BY updated_at DESC LIMIT 1
    `).get(fp);
    if (existing) return rowToClaim(existing);

    const now = new Date().toISOString();
    const id  = input.id || `claim_${randomUUID()}`;
    const conf = clamp01(input.confidence, 0.1);

    const reasoning = input.reasoning ? String(input.reasoning) : null;
    this.#db.prepare(`
      INSERT INTO claims
        (id, statement, type, status, confidence, reality_weight,
         tags, source, reasoning, fingerprint, created_at, updated_at, latest_result)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, input.statement, input.type || "general", "provisional",
      conf, 0.1,
      JSON.stringify(Array.isArray(input.tags) ? input.tags : []),
      input.source || "model",
      reasoning,
      fp, now, now, null
    );

    return {
      id, statement: input.statement, type: input.type || "general",
      status: "provisional", confidence: conf, realityWeight: 0.1,
      tags: Array.isArray(input.tags) ? input.tags : [],
      source: input.source || "model", reasoning,
      fingerprint: fp, createdAt: now, updatedAt: now, latestResult: null
    };
  }

  async appendEvidence(claimId, evidence) {
    await this.init();
    const now = new Date().toISOString();

    // H6: link to previous evidence record
    const prev = this.#db.prepare(
      "SELECT id FROM evidence WHERE claim_id = ? ORDER BY timestamp DESC LIMIT 1"
    ).get(claimId);

    // C3: TTL
    const ttl       = VALIDATOR_TTL_SECONDS[evidence.validator] ?? null;
    const expiresAt = ttl !== null ? new Date(Date.now() + ttl * 1000).toISOString() : null;

    const evStatus = evidence.status || (
      evidence.verified    ? "verified"    :
      evidence.contradicted ? "contradicted" : ""
    );

    const record = {
      id:            evidence.id || `evidence_${randomUUID()}`,
      claimId,
      timestamp:     now,
      supersedes:    prev?.id ?? null,
      expiresAt,
      validator:     evidence.validator,
      verified:      !!evidence.verified,
      contradicted:  !!evidence.contradicted,
      status:        evStatus,
      confidence:    evidence.confidence    ?? 0,
      realityWeight: evidence.realityWeight ?? 0,
      result:        evidence.result        || {}
    };

    this.#db.prepare(`
      INSERT INTO evidence
        (id, claim_id, timestamp, supersedes, expires_at, validator,
         verified, contradicted, status, confidence, reality_weight, result)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      record.id, record.claimId, record.timestamp,
      record.supersedes, record.expiresAt,
      record.validator,
      record.verified     ? 1 : 0,
      record.contradicted ? 1 : 0,
      record.status,
      record.confidence, record.realityWeight,
      JSON.stringify(record.result)
    );

    this.#updateClaimFromEvidence(claimId, record);
    // Pass conscience flags through in the response without altering the schema
    if (evidence.conscienceFlags) record.conscienceFlags = evidence.conscienceFlags;
    return record;
  }

  async getEvidenceForClaim(claimId) {
    await this.init();
    const rows = this.#db.prepare(
      "SELECT * FROM evidence WHERE claim_id = ? ORDER BY timestamp DESC"
    ).all(claimId);
    return rows.map(rowToEvidence).map(applyDecay);
  }

  async searchEvidence(query = "") {
    await this.init();
    let rows;
    if (query) {
      const q = `%${query.toLowerCase()}%`;
      rows = this.#db.prepare(`
        SELECT * FROM evidence
        WHERE lower(validator) LIKE ? OR lower(claim_id) LIKE ? OR lower(result) LIKE ?
        ORDER BY timestamp DESC
      `).all(q, q, q);
    } else {
      rows = this.#db.prepare("SELECT * FROM evidence ORDER BY timestamp DESC").all();
    }
    return rows.map(rowToEvidence).map(applyDecay);
  }

  // ── Private helpers ──────────────────────────────────────────────────────
  #updateClaimFromEvidence(claimId, evidence) {
    const es = evidence.status;
    const status =
      es === "failed"       ? "failed"       :
      es === "unverifiable" ? "unverifiable" :
      es === "blocked"      ? "blocked"      :
      es === "irrelevant"   ? "irrelevant"   :
      es === "syntactic"    ? "syntactic"    :
      es === "simulated"    ? "simulated"    :
      isPromotableEvidence(evidence) && evidence.verified     ? "verified"     :
      isPromotableEvidence(evidence) && evidence.contradicted ? "contradicted" :
                              "partial";

    this.#db.prepare(`
      UPDATE claims
      SET status = ?, confidence = ?, reality_weight = ?,
          latest_result = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      clamp01(evidence.confidence),
      clamp01(evidence.realityWeight),
      JSON.stringify(evidence.result),
      evidence.timestamp,
      claimId
    );
  }

  async #applyStaleStatus(claim) {
    if (!["verified", "contradicted", "partial"].includes(claim.status)) return claim;
    const evidence = await this.getEvidenceForClaim(claim.id);
    if (!evidence.length) return claim;
    if (!evidence.every(e => e.status === "stale")) return claim;
    return { ...claim, status: "stale", realityWeight: Math.max(0.1, claim.realityWeight * 0.5) };
  }
}
