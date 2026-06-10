#!/usr/bin/env node
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { listValidators, verifyInteraction, verifyWithValidator, checkValidatorPermitted } from "./validators.js";
import { changelog, currentVersion, currentLabel } from "./changelog.js";
import { CLAIM_TEMPLATES, resolveTemplate, computeGate } from "./templates.js";
import { assessClaimEvidence, buildClaimContract, normalizeClaimType, profileForValidator } from "./contracts.js";
import {
  // auto-applied hooks
  detectContradiction, detectSycophancy, scoreReasoningTrace,
  isDestructiveClaim, destructiveClaimDirective,
  recordCalibration, getCalibrationAlert,
  constitutionalCheck,
  // explicit tools
  declareAction, confirmDone, listIntents,
  pauseAndVerify,
  runVerificationChain,
  retrievalGate,
  humanAttest, getAttestation,
  planVerification,
  semanticChallenge,
  startActionTrace, addTraceCycle, completeActionTrace, getTrace,
  iterativeVerify,
  consistencyVote,
  verifyExecution,
  calibrationReport,
} from "./conscience.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir   = resolve(join(__dirname, ".."));
const webDir    = resolve(join(rootDir, "web"));
const port      = Number(process.env.ANTIPSYC_PORT || 8717);
const args      = new Set(process.argv.slice(2));
let   httpServer = null;

// C5: createStore() selects SQLite (Node 22+) or falls back to JSON files
validateStartupConfig();
const store = await createStore();

if (args.has("--smoke")) {
  await runSmoke();
} else if (args.has("--demo")) {
  await runDemo();
} else {
  if (args.has("--http") || !args.has("--mcp")) startHttpServer();
  if (args.has("--mcp")) startMcpServer();
}

// ── Rate limiter ───────────────────────────────────────────────────────────
class RateLimiter {
  #windows = new Map();
  #limit; #windowMs;
  constructor(limit, windowMs) { this.#limit = limit; this.#windowMs = windowMs; }
  check(key) {
    const now = Date.now();
    const e = this.#windows.get(key) || { count: 0, start: now };
    if (now - e.start > this.#windowMs) { e.count = 0; e.start = now; }
    e.count++;
    this.#windows.set(key, e);
    return e.count <= this.#limit;
  }
  cleanup() {
    const now = Date.now();
    for (const [k, e] of this.#windows) if (now - e.start > this.#windowMs * 2) this.#windows.delete(k);
  }
}

const rateLimiter = new RateLimiter(
  Number(process.env.ANTIPSYC_RATE_LIMIT     || 120),
  Number(process.env.ANTIPSYC_RATE_WINDOW_MS || 60_000)
);
setInterval(() => rateLimiter.cleanup(), 5 * 60 * 1000).unref();

// ── Structured request logger ──────────────────────────────────────────────
function logRequest(req, res, startMs) {
  res.on("finish", () => {
    let path = req.url || "/";
    try { path = new URL(req.url, `http://${req.headers.host}`).pathname; } catch { /* malformed url */ }
    console.error(JSON.stringify({
      ts:     new Date().toISOString(),
      method: req.method,
      path,
      status: res.statusCode,
      ms:     Date.now() - startMs,
      ip:     req.socket?.remoteAddress || "unknown",
    }));
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────
function startHttpServer() {
  httpServer = http.createServer(async (req, res) => {
    logRequest(req, res, Date.now());
    try { await routeHttp(req, res); }
    catch (error) { sendJson(res, error.status || 500, { error: error.message }); }
  });
  // F16: bind address is configurable — containers need 0.0.0.0 to be reachable.
  const bindHost = process.env.ANTIPSYC_BIND || "127.0.0.1";
  httpServer.listen(port, bindHost, () => {
    console.error(`AntiPsyc ${currentLabel} (${currentVersion})  →  http://${bindHost}:${port}`);
  });
  process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
  process.on("SIGINT",  () => httpServer.close(() => process.exit(0)));
}

// ── C6: API key authentication ─────────────────────────────────────────────
// Auth is disabled when ANTIPSYC_API_KEY is not set (development mode).
// Static files and health check are always public.
function requireAuth(req, res) {
  const key = process.env.ANTIPSYC_API_KEY;
  if (!key) return true;
  const header   = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided !== key) {
    sendJson(res, 401, { error: "Unauthorized. Provide: Authorization: Bearer <ANTIPSYC_API_KEY>" });
    return false;
  }
  return true;
}

// ── HTTP router ────────────────────────────────────────────────────────────
async function routeHttp(req, res) {
  const ip = req.socket.remoteAddress || "unknown";
  // F16: the intended caller is a local agent doing batch verification —
  // don't throttle loopback unless explicitly requested.
  const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const limitLocal = process.env.ANTIPSYC_RATE_LIMIT_LOCAL === "true";
  if ((!isLoopback || limitLocal) && !rateLimiter.check(ip)) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    res.end(JSON.stringify({ error: "Too many requests. Retry after 60 seconds." }));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  // Always public
  if (pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true, version: currentVersion, label: currentLabel,
      auth: !!process.env.ANTIPSYC_API_KEY,
      validators: listValidators()
    });
  }
  if (pathname === "/api/version") {
    return sendJson(res, 200, { current: currentVersion, label: currentLabel, versions: changelog });
  }

  // AI accessibility — always public (no auth required for discoverability)
  if (pathname === "/api/orientation" && method === "GET") {
    return sendJson(res, 200, buildOrientation());
  }
  if (pathname === "/api/openapi.json" && method === "GET") {
    const baseUrl = `${req.socket.encrypted ? "https" : "http"}://${req.headers.host || `127.0.0.1:${port}`}`;
    return sendJson(res, 200, buildOpenApiSpec(baseUrl));
  }
  if (pathname === "/.well-known/ai-plugin.json" && method === "GET") {
    const baseUrl = `${req.socket.encrypted ? "https" : "http"}://${req.headers.host || `127.0.0.1:${port}`}`;
    return sendJson(res, 200, buildAiPlugin(baseUrl));
  }

  // U3: template catalog — always public (read-only)
  if (pathname === "/api/templates" && method === "GET") {
    return sendJson(res, 200, Object.entries(CLAIM_TEMPLATES).map(([id, t]) => ({
      id,
      description: t.description,
      fill:        t.fill,
      example:     t.example,
      expectAbsent: t.expectAbsent || false
    })));
  }

  // U2: confidence gate — always public. With a claimId the gate is computed
  // from the evidence ledger (attested); raw numbers are accepted but flagged.
  if (pathname === "/api/gate" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await gateCheck(body));
  }

  // Static web files — always public
  if (!pathname.startsWith("/api/")) {
    return serveStatic(pathname, res);
  }

  // All /api/* routes require auth
  if (!requireAuth(req, res)) return;

  if (pathname === "/api/claims" && method === "GET") {
    const q      = url.searchParams.get("q")      || "";
    const limit  = Number(url.searchParams.get("limit")  || 0);
    const offset = Number(url.searchParams.get("offset") || 0);
    const all    = await store.listClaims(q);
    if (!limit) return sendJson(res, 200, all);
    return sendJson(res, 200, {
      data:    all.slice(offset, offset + limit),
      total:   all.length,
      limit,
      offset,
      hasMore: offset + limit < all.length,
    });
  }
  if (pathname.startsWith("/api/claims/") && method === "GET") {
    const id    = decodeURIComponent(pathname.split("/").pop());
    const claim = await store.getClaim(id);
    return claim ? sendJson(res, 200, claim) : sendJson(res, 404, { error: "Claim not found." });
  }
  if (pathname === "/api/claims" && method === "POST") {
    return sendJson(res, 201, await submitClaim(await readJson(req)));
  }
  if (pathname === "/api/verify" && method === "POST") {
    return sendJson(res, 200, await verifyClaim(await readJson(req)));
  }
  // H8: batch verification
  if (pathname === "/api/verify/batch" && method === "POST") {
    return sendJson(res, 200, await verifyBatch(await readJson(req)));
  }
  // U3: template-based verification
  if (pathname === "/api/verify/template" && method === "POST") {
    return sendJson(res, 200, await verifyTemplate(await readJson(req)));
  }
  if (pathname === "/api/interactions" && method === "POST") {
    return sendJson(res, 200, await verifyInteractionClaim(await readJson(req)));
  }

  // ── Conscience endpoints ───────────────────────────────────────────────
  if (pathname === "/api/conscience/declare"  && method === "POST") return sendJson(res, 200, declareAction(await readJson(req)));
  if (pathname === "/api/conscience/confirm"  && method === "POST") return sendJson(res, 200, confirmDone(await readJson(req)));
  if (pathname === "/api/conscience/intents"  && method === "GET")  return sendJson(res, 200, listIntents());
  if (pathname === "/api/conscience/pause"    && method === "POST") return sendJson(res, 200, pauseAndVerify(await readJson(req)));
  if (pathname === "/api/conscience/chain"    && method === "POST") return sendJson(res, 200, await runVerificationChain(await readJson(req), verifyClaim));
  if (pathname === "/api/conscience/gate"     && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await hydratedRetrievalGate(body));
  }
  if (pathname === "/api/conscience/constitutional" && method === "POST") return sendJson(res, 200, constitutionalCheck(await readJson(req)));
  if (pathname === "/api/conscience/vote"     && method === "POST") return sendJson(res, 200, await consistencyVote(await readJson(req), verifyClaim));
  if (pathname === "/api/conscience/attest"   && method === "POST") return sendJson(res, 200, humanAttest(await readJson(req)));
  if (pathname === "/api/conscience/plan"     && method === "POST") return sendJson(res, 200, planVerification(await readJson(req)));
  if (pathname === "/api/conscience/challenge"&& method === "POST") return sendJson(res, 200, semanticChallenge(await readJson(req)));
  if (pathname === "/api/conscience/trace/start"    && method === "POST") return sendJson(res, 200, startActionTrace(await readJson(req)));
  if (pathname === "/api/conscience/trace/cycle"    && method === "POST") return sendJson(res, 200, addTraceCycle(await readJson(req)));
  if (pathname === "/api/conscience/trace/complete" && method === "POST") return sendJson(res, 200, completeActionTrace(await readJson(req)));
  if (pathname.startsWith("/api/conscience/trace/") && method === "GET") return sendJson(res, 200, getTrace(pathname.split("/").pop()) || { error: "Not found." });
  if (pathname === "/api/conscience/iterate"  && method === "POST") return sendJson(res, 200, await iterativeVerify(await readJson(req), verifyClaim));
  if (pathname === "/api/conscience/execution"&& method === "POST") return sendJson(res, 200, verifyExecution(await readJson(req)));
  if (pathname === "/api/conscience/calibration" && method === "GET") return sendJson(res, 200, calibrationReport());

  return sendJson(res, 404, { error: "Not found." });
}

// ── Business logic ─────────────────────────────────────────────────────────

// P3 (F11): every evidence record carries its own gate signal so a consuming
// model gets verdict + presentation guidance in ONE round trip. gate_check
// remains available for re-checking cached/ledger claims.
function withGate(record) {
  if (record && typeof record === "object") {
    record.gate = computeGate(record.realityWeight, undefined, record.verified, record.contradicted);
  }
  return record;
}

// P2 (F2): ledger-backed gate. When a claimId is supplied, the gate reads
// verified/contradicted/realityWeight from the evidence ledger itself instead
// of trusting caller-supplied numbers (which a hallucinating model can invent).
async function gateCheck(args = {}) {
  if (args.claimId) {
    const claim = await store.getClaim(args.claimId);
    if (!claim) {
      return { gate: "suppress", label: "Disclaim or omit", attested: false, error: `Claim not found: ${args.claimId}` };
    }
    const latest = claim.evidence?.[0] || null;
    if (!latest) {
      return {
        gate: "suppress", label: "Disclaim or omit", attested: true, claimId: claim.id,
        realityWeight: claim.realityWeight,
        suggestion: "No evidence exists in the ledger for this claim — it is provisional. Run verify_claim first."
      };
    }
    return {
      ...computeGate(latest.realityWeight, args.threshold, latest.verified, latest.contradicted),
      attested: true,
      claimId: claim.id,
      evidenceId: latest.id,
      validator: latest.validator,
      evidenceStatus: latest.status,
      evidenceTimestamp: latest.timestamp
    };
  }
  return {
    ...computeGate(args.realityWeight, args.threshold, args.verified, args.contradicted),
    attested: false,
    note: "Gate computed from caller-supplied values (unattested). Pass claimId to compute from the evidence ledger instead."
  };
}

// P6 (F12): fresh-evidence cache. If the latest ledger evidence for the same
// validator + same inputs is still within TTL, reuse it instead of re-running
// the validator. Pass force:true to bypass (consistency_vote and
// iterative_verify always bypass — they exist to re-observe).
function evidenceMatchesInput(evidence, input) {
  const r = evidence.result || {};
  const KEYS = ["url", "expression", "contains", "pattern", "glob", "keyPath", "message", "branch", "line", "expectedStatus", "command"];
  for (const k of KEYS) {
    if (input[k] === undefined) continue;
    if (r[k] === undefined || r[k] === null) return false;
    if (String(input[k]) !== String(r[k])) return false;
  }
  if (input.path !== undefined) {
    if (!r.path) return false;
    try {
      if (resolve(String(input.path)).toLowerCase() !== String(r.path).toLowerCase()) return false;
    } catch { return false; }
  }
  if (input.code !== undefined && r.code === undefined) return false; // code.run result omits code — never cache
  return true;
}

async function findCachedEvidence(claimId, validator, input) {
  const full = await store.getClaim(claimId);
  const latest = full?.evidence?.find(e => e.validator === validator);
  if (!latest) return null;
  if (!["verified", "contradicted"].includes(latest.status)) return null;       // only promoted evidence
  if (latest.expiresAt && new Date(latest.expiresAt).getTime() <= Date.now()) return null; // expired
  if (!evidenceMatchesInput(latest, input)) return null;
  return {
    ...latest,
    cached: true,
    ageSeconds: Math.max(0, Math.round((Date.now() - new Date(latest.timestamp).getTime()) / 1000))
  };
}

// F21: retrieval_gate previously received claims WITHOUT their evidence arrays
// (listClaims doesn't hydrate), so it always answered MISSING. Hydrate the
// matching claim via getClaim before gating.
async function hydratedRetrievalGate(args) {
  let match = null;
  if (args.claimId) {
    match = await store.getClaim(args.claimId);
  } else if (args.statement) {
    const candidates = await store.listClaims(args.statement);
    const found = candidates.find(c => c.statement === args.statement) || candidates[0];
    if (found) match = await store.getClaim(found.id);
  }
  return retrievalGate(args, match ? [match] : []);
}

async function submitClaim(input) {
  if (!input.statement) throw new Error("statement is required");
  const validator = input.validator || input.type || "general";

  // #8 Reasoning trace — compute penalty carried into verifyClaim
  const reasoningScore = scoreReasoningTrace(input);

  // #10 Sycophancy detection
  const sycoWarning = detectSycophancy(input.statement);

  const claim = await store.createClaim({
    ...input,
    claimedConfidence: input.confidence,
    contract: buildClaimContract(input.statement, { ...input, validator }),
    type: normalizeClaimType(input.type, validator),
    reasoning: input.reasoning || null,
    _rwPenalty: reasoningScore.penalty + (sycoWarning?.rwPenalty || 0),
    _reasoningNote: reasoningScore.reason,
  });

  // #3 Contradiction detection — non-blocking warning attached to result.
  // P11 (F10): only high-confidence promoted claims can contradict, so query
  // just those instead of scanning the full ledger on every submission.
  try {
    const all = typeof store.listPromotedClaims === "function"
      ? await store.listPromotedClaims(0.75)
      : await store.listClaims("");
    const contradiction = detectContradiction(input.statement, all.filter(c => c.id !== claim.id));
    if (contradiction) claim.conscienceWarning = { tactic: "contradiction_detection", ...contradiction };
  } catch { /* non-blocking */ }

  if (sycoWarning) claim.sycophancyWarning = sycoWarning;

  return claim;
}

async function verifyClaim(input) {
  const claim = input.claimId
    ? await store.getClaim(input.claimId)
    : await submitClaim(input);
  if (!claim) throw new Error("claim not found");

  const validator = input.validator || input.type || claim.type;

  // C4: enforce permitted validators
  if (!checkValidatorPermitted(claim.type, validator)) {
    const ev = {
      validator, verified: false, contradicted: false,
      status: "unverifiable", confidence: 0, realityWeight: 0.05,
      result: {
        error: `Validator "${validator}" is not permitted for claim type "${claim.type}".`
      }
    };
    return withGate(await store.appendEvidence(claim.id, ev));
  }

  // P6: serve fresh matching evidence from the ledger without re-running the validator
  if (input.force !== true && input.cache !== false) {
    const cached = await findCachedEvidence(claim.id, validator, input);
    if (cached) {
      // #9 calibration still tracks claimed-vs-actual even on cache hits
      recordCalibration(validator, input.claimedConfidence ?? claim.claimedConfidence, cached.realityWeight);
      return withGate(cached);
    }
  }

  // #7 Constitutional check — non-blocking warning
  const constitutional = constitutionalCheck({ statement: claim.statement, validator });

  // #16 Semantic challenge — non-blocking warning
  const semantic = semanticChallenge({ statement: claim.statement, validator });

  // #6 Destructive double-verify — warn if first evidence, require second for promotion
  const destructive = isDestructiveClaim(claim.statement);

  const rawEvidence = await verifyWithValidator({ ...input, type: claim.type });

  // #9 Calibration recording
  recordCalibration(validator, input.claimedConfidence ?? claim.claimedConfidence, rawEvidence.realityWeight);
  const calibAlert = getCalibrationAlert(validator);

  // #8 + #10: compute rw penalties from the current input, falling back to
  // the reasoning persisted on the claim (F20).
  const _reasoningScore = scoreReasoningTrace({ reasoning: input.reasoning ?? claim.reasoning });
  const _sycoWarn       = detectSycophancy(claim.statement);

  // F17: grounded OBSERVED evidence is a posterior — the validator physically
  // observed external reality. A prior about prose quality (missing reasoning
  // field) or framing (sycophancy) must not drag a grounded observation below
  // the gate band. Penalties apply only to non-observed evidence classes
  // (syntactic, simulated, self-supplied); warnings are surfaced either way.
  const _profile  = profileForValidator(validator);
  const _grounded = _profile?.status === "observed" && !_profile?.selfSupplied;
  const rwPenalty = _grounded ? 0 : _reasoningScore.penalty + (_sycoWarn?.rwPenalty ?? 0);
  const adjustedRw = Math.max(0, (rawEvidence.realityWeight ?? 0) - rwPenalty);

  const adjustedEvidence = {
    ...rawEvidence,
    realityWeight: rwPenalty > 0 ? adjustedRw : rawEvidence.realityWeight,
    conscienceFlags: {
      rwPenalty:          rwPenalty || undefined,
      reasoningNote:      _reasoningScore.penalty > 0 ? _reasoningScore.reason : undefined,
      sycophancyWarning:  _sycoWarn?.directive || undefined,
      calibrationAlert:   calibAlert || undefined,
      constitutionalViolations: !constitutional.passed ? constitutional.violations : undefined,
      semanticChallenges: semantic.challenged ? semantic.challenges : undefined,
      destructiveWarning: destructive ? "Two independent validators required for destructive claims." : undefined,
    }
  };

  const evidence = assessClaimEvidence({ claim, input, validator, evidence: adjustedEvidence });
  return withGate(await store.appendEvidence(claim.id, evidence));
}

// H8: batch verification — runs in parallel by default
async function verifyBatch(input) {
  const checks   = Array.isArray(input.checks) ? input.checks : [];
  const parallel = input.parallel !== false;
  if (parallel) {
    return Promise.all(checks.map(check => verifyClaim(check)));
  }
  const results = [];
  for (const check of checks) results.push(await verifyClaim(check));
  return results;
}

// U3: resolve a template and verify it, with expectAbsent inversion support
async function verifyTemplate(input) {
  if (!input.template) throw new Error("template is required");
  const { expectAbsent, statement, ...validatorArgs } = resolveTemplate(
    input.template,
    input.fill || {},
    input.statement || null
  );
  const validator = validatorArgs.validator;
  const claim = await submitClaim({ statement, type: validator, ...validatorArgs });

  if (!checkValidatorPermitted(claim.type, validator)) {
    const ev = {
      validator, verified: false, contradicted: false,
      status: "unverifiable", confidence: 0, realityWeight: 0.05,
      result: { error: `Validator "${validator}" is not permitted for claim type "${claim.type}".` }
    };
    return withGate(await store.appendEvidence(claim.id, ev));
  }

  const rawEvidence = await verifyWithValidator({ ...validatorArgs, type: claim.type });
  const semanticRaw = expectAbsent && (rawEvidence.verified || rawEvidence.contradicted)
    ? {
        ...rawEvidence,
        verified: rawEvidence.contradicted,
        contradicted: rawEvidence.verified,
        result: {
          ...rawEvidence.result,
          expectAbsent: true,
          note: "verified/contradicted flipped before persistence: verified = target is absent"
        }
      }
    : rawEvidence;
  const evidence = assessClaimEvidence({ claim, input: { ...validatorArgs, statement }, validator, evidence: semanticRaw });
  return withGate(await store.appendEvidence(claim.id, evidence));
}

async function verifyInteractionClaim(input) {
  const claim = input.claimId
    ? await store.getClaim(input.claimId)
    : await submitClaim({
        statement: input.statement || "Interaction chain",
        type: "interaction.chain",
        tags: input.tags || ["interaction"]
      });
  if (!claim) throw new Error("claim not found");
  const rawEvidence = await verifyInteraction(input);
  const evidence = assessClaimEvidence({
    claim,
    input,
    validator: "interaction.chain",
    evidence: rawEvidence
  });
  return withGate(await store.appendEvidence(claim.id, evidence));
}

// ── Static file server (v2: path traversal guard) ─────────────────────────
async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(webDir, safePath.replace(/^\/+/, "")));
  if (!filePath.startsWith(webDir + sep)) {
    return sendJson(res, 403, { error: "Forbidden." });
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found." });
  }
}

// ── MCP stdio server ───────────────────────────────────────────────────────
function startMcpServer() {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", async chunk => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const parsed = readFramedMessage(buffer);
      if (!parsed) break;
      buffer = parsed.rest;
      await handleMcpMessageEnvelope(parsed.message);
    }
  });
}

function readFramedMessage(buffer) {
  const sep = buffer.indexOf("\r\n\r\n");
  if (sep === -1) {
    const text    = buffer.toString("utf8");
    const newline = text.indexOf("\n");
    if (newline === -1) return null;
    const line = text.slice(0, newline).trim();
    if (!line.startsWith("{")) return null;
    return { message: JSON.parse(line), rest: Buffer.from(text.slice(newline + 1), "utf8") };
  }
  const header = buffer.slice(0, sep).toString("utf8");
  const match  = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error("Missing Content-Length header.");
  const length = Number(match[1]);
  const start  = sep + 4;
  const end    = start + length;
  if (buffer.length < end) return null;
  return { message: JSON.parse(buffer.slice(start, end).toString("utf8")), rest: buffer.slice(end) };
}

async function handleMcpMessageEnvelope(message) {
  try {
    const result = await handleMcpMessage(message);
    if (message.id !== undefined) writeMcp({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    writeMcp({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32000, message: error.message } });
  }
}

// MCP stdio framing is newline-delimited JSON (one message per line).
// The reader (readFramedMessage) still accepts legacy Content-Length frames
// from old clients, but everything we emit is spec-compliant NDJSON.
function writeMcp(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// Protocol versions this server can speak. We echo the client's requested
// version when we support it; otherwise we answer with our latest.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

async function handleMcpMessage(message) {
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    return {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "antipsyc", version: currentVersion },
      instructions: [
        "AntiPsyc — anti-hallucination conscience layer.",
        "",
        "CORE RULE: Every claim you assert must pass through this MCP first.",
        "gate:HALT = STOP. Complete required_steps before proceeding.",
        "",
        "CLAIM WORKFLOW:",
        "  1. pause_and_verify({ claim }) → mandatory checklist",
        "  2. verify_claim for each checklist step",
        "  3. gate_check({ realityWeight, verified, contradicted })",
        "  4. Assert only when gate='verified'. Caveat on 'caveat'. Suppress otherwise.",
        "",
        "ACTION WORKFLOW (write / delete / run / install):",
        "  1. declare_action({ action, actionType, parameters }) → manifest",
        "  2. verify_claim for every manifest step",
        "  3. confirm_done({ intentId })",
        "",
        "REALITY WEIGHT: ≥0.85 assert | ≥0.70 caveat | ≥0.40 qualify | <0.40 suppress",
        "",
        "Call get_orientation for the full reference guide with all validators and examples.",
      ].join("\n"),
    };
  }
  if (message.method === "tools/list")  return { tools: mcpTools() };
  if (message.method === "tools/call")  return callMcpTool(message.params.name, message.params.arguments || {});
  return {};
}

async function callMcpTool(name, input) {
  const handlers = {
    submit_claim:       submitClaim,
    verify_claim:       verifyClaim,
    verify_batch:       verifyBatch,
    verify_interaction: verifyInteractionClaim,
    search_evidence:    args => store.searchEvidence(args.query || ""),
    get_claim:          args => store.getClaim(args.claimId),
    // U3: template shortcuts
    use_template:       verifyTemplate,
    get_templates:      () => Object.entries(CLAIM_TEMPLATES).map(([id, t]) => ({
                          id, description: t.description, fill: t.fill,
                          example: t.example, expectAbsent: t.expectAbsent || false
                        })),
    // U2: confidence gate — ledger-backed when claimId is given (P2)
    gate_check:             args => gateCheck(args),

    // ── Orientation (always the first tool to call on connection) ───────
    get_orientation:        ()   => buildOrientation(),

    // ── Conscience tools ────────────────────────────────────────────────
    // #1 Intent tracking
    declare_action:         args => declareAction(args),
    confirm_done:           args => confirmDone(args),
    list_intents:           ()   => listIntents(),
    // #2 Deliberation gate
    pause_and_verify:       args => pauseAndVerify(args),
    // #4 Verification chain
    run_verification_chain: args => runVerificationChain(args, verifyClaim),
    // #5/#15 Retrieval gate (F21: hydrated with evidence)
    retrieval_gate:         args => hydratedRetrievalGate(args),
    // #7 Constitutional check (explicit call)
    constitutional_check:   args => constitutionalCheck(args),
    // #11 Consistency vote
    consistency_vote:       args => consistencyVote(args, verifyClaim),
    // #13 Human attestation
    human_attest:           args => humanAttest(args),
    get_attestation:        args => getAttestation(args.claimId),
    // #14 Chain-of-Verification
    plan_verification:      args => planVerification(args),
    // #16 Semantic challenge (explicit call)
    semantic_challenge:     args => semanticChallenge(args),
    // #17 Action trace
    start_action_trace:     args => startActionTrace(args),
    add_trace_cycle:        args => addTraceCycle(args),
    complete_action_trace:  args => completeActionTrace(args),
    get_trace:              args => getTrace(args.traceId),
    // #18 Iterative verify
    iterative_verify:       args => iterativeVerify(args, verifyClaim),
    // #19 Verify execution plan
    verify_execution:       args => verifyExecution(args),
    // #9 Calibration report
    calibration_report:     ()   => calibrationReport(),
  };
  if (!handlers[name]) throw new Error(`Unknown tool: ${name}`);
  const result = await handlers[name](input);
  return {
    // F13: compact JSON — pretty-printing is pure token overhead for the
    // consuming model on every single tool call.
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result
  };
}

// F14: pure-query tools are annotated readOnlyHint so clients (e.g. Claude
// Code) can auto-approve them — permission prompts are the largest perceived
// latency cost. Verification tools append to the server's own ledger, so they
// are non-destructive and idempotent, but not strictly read-only.
const READ_ONLY_TOOLS = new Set([
  "get_orientation", "get_templates", "get_claim", "search_evidence",
  "gate_check", "list_intents", "pause_and_verify", "retrieval_gate",
  "constitutional_check", "get_attestation", "plan_verification",
  "semantic_challenge", "get_trace", "verify_execution", "calibration_report"
]);

// F15: a reduced surface for small models / token-sensitive clients.
// Set ANTIPSYC_TOOLSET=core to expose only the documented core workflow.
const CORE_TOOLS = new Set([
  "get_orientation", "submit_claim", "verify_claim", "verify_batch",
  "use_template", "get_templates", "gate_check", "get_claim",
  "search_evidence", "declare_action", "confirm_done", "pause_and_verify"
]);

function annotateTool(tool) {
  const readOnly = READ_ONLY_TOOLS.has(tool.name);
  return {
    ...tool,
    annotations: {
      readOnlyHint:    readOnly,
      destructiveHint: false,
      idempotentHint:  true,
      openWorldHint:   !readOnly   // verification tools may touch fs/git/network
    }
  };
}

function mcpTools() {
  const all = allMcpTools().map(annotateTool);
  if (String(process.env.ANTIPSYC_TOOLSET || "").toLowerCase() === "core") {
    return all.filter(t => CORE_TOOLS.has(t.name));
  }
  return all;
}

function allMcpTools() {
  return [
    {
      name: "get_orientation",
      description: "Complete reference guide for using AntiPsyc — call this first when connecting. Returns workflow, gate meanings, realityWeight guide, all validators, quickstart examples, and HTTP API details.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "submit_claim",
      description: "Record a provisional claim without accepting it as true.",
      inputSchema: objectSchema({
        statement: "string", type: "string", source: "string", tags: "array"
      }, ["statement"])
    },
    {
      name: "verify_claim",
      description: "Verify a claim using an external validator and store the evidence.",
      inputSchema: objectSchema({
        claimId: "string", statement: "string", type: "string",
        validator: "string", path: "string", url: "string",
        expression: "string", expected: "number",
        text: "string", contains: "string", pattern: "string",
        code: "string", expectedOutput: "string",
        command: "string", bin: "string", args: "array", expectedExitCode: "number",
        branch: "string", ref: "string", keyPath: "string",
        // G0: codebase.contains
        glob: "string", baseDir: "string",
        // G8: git history
        message: "string", since: "string", line: "number",
        repo: "string", caseSensitive: "boolean"
      }, [])
    },
    {
      name: "verify_batch",
      description: "Verify multiple claims in parallel. Each check is a verify_claim input.",
      inputSchema: objectSchema({ checks: "array", parallel: "boolean" }, ["checks"])
    },
    {
      name: "verify_interaction",
      description: "Verify a causal chain of related checks as one interaction.",
      inputSchema: objectSchema({ claimId: "string", statement: "string", checks: "array" }, ["checks"])
    },
    {
      name: "search_evidence",
      description: "Search the evidence ledger by text.",
      inputSchema: objectSchema({ query: "string" }, [])
    },
    {
      name: "get_claim",
      description: "Fetch one claim and its full evidence history (with decay applied).",
      inputSchema: objectSchema({ claimId: "string" }, ["claimId"])
    },
    // U3
    {
      name: "get_templates",
      description: "List all available claim templates with their fill fields and examples. Call this first to discover what templates exist before using use_template.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "use_template",
      description: "Verify a claim using a named template — simpler than verify_claim. Provide the template id and a fill object. Call get_templates to see available templates and their required fill keys.",
      inputSchema: {
        type: "object",
        properties: {
          template:  { type: "string",  description: "Template id (e.g. 'package-version', 'file-exists', 'codebase-has')" },
          statement: { type: "string",  description: "Optional human-readable claim statement (auto-generated if omitted)" },
          fill:      { type: "object",  description: "Key-value pairs for the template's required fill fields",
                       additionalProperties: { type: "string" } }
        },
        required: ["template", "fill"]
      }
    },
    // ── Conscience tools ────────────────────────────────────────────────────
    // #1 Intent tracking
    {
      name: "declare_action",
      description: "Register an intent BEFORE performing an action. Returns a verification manifest — the specific verify_claim steps you must complete before calling confirm_done.",
      inputSchema: objectSchema({ action: "string", actionType: "string", parameters: "object" }, ["action"])
    },
    {
      name: "confirm_done",
      description: "Close an open intent after completing all manifest verifications. Returns gate: PROCEED when the evidence chain is complete, HALT if the intent was never declared.",
      inputSchema: objectSchema({ intentId: "string" }, ["intentId"])
    },
    {
      name: "list_intents",
      description: "List all open and closed intents for this session.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    // #2 Deliberation gate
    {
      name: "pause_and_verify",
      description: "STOP and generate a mandatory verification checklist for a claim before asserting it. Always returns a HALT directive with specific verify_claim steps to run.",
      inputSchema: objectSchema({ claim: "string", statement: "string", validator: "string" }, [])
    },
    // #4 Verification chain
    {
      name: "run_verification_chain",
      description: "Run a sequence of verify_claim steps. Returns gate: PROCEED only if every step returns verified=true. Fails fast at the first failing step.",
      inputSchema: objectSchema({ steps: "array" }, ["steps"])
    },
    // #5/#15 Retrieval gate
    {
      name: "retrieval_gate",
      description: "Check whether existing evidence is FRESH, STALE, MISSING, or UNSUPPORTABLE for a given claim and validator before asserting. STALE and MISSING return a HALT directive.",
      inputSchema: objectSchema({ statement: "string", validator: "string", claimId: "string" }, ["validator"])
    },
    // #7 Constitutional check
    {
      name: "constitutional_check",
      description: "Check whether a claim+validator pair violates any operator-defined principles. Returns passed:true or a list of violations with resolution guidance.",
      inputSchema: objectSchema({ statement: "string", validator: "string" }, ["statement", "validator"])
    },
    // #11 Consistency vote
    {
      name: "consistency_vote",
      description: "Run the same validator N times (2–5) and check for unanimous agreement. Mixed results return HALT — inconsistency means the claim is non-deterministic or ill-formed.",
      inputSchema: {
        type: "object",
        properties: {
          n:     { type: "number",  description: "Number of runs (2–5, default 3)" },
          check: { type: "object",  description: "A verify_claim input object (must include validator)" }
        },
        required: ["check"]
      }
    },
    // #13 Human attestation
    {
      name: "human_attest",
      description: "Record a human operator's explicit approval or rejection of a verified claim. Approval boosts realityWeight by +0.15; rejection forces CONTRADICTED.",
      inputSchema: objectSchema({ claimId: "string", approved: "boolean", reason: "string", operatorNote: "string" }, ["claimId", "approved"])
    },
    {
      name: "get_attestation",
      description: "Retrieve the human attestation record for a claim.",
      inputSchema: objectSchema({ claimId: "string" }, ["claimId"])
    },
    // #14 Chain-of-Verification
    {
      name: "plan_verification",
      description: "Generate a Chain-of-Verification checklist for a claim — the specific verify_claim steps the MCP determines are needed. Run every step before asserting.",
      inputSchema: objectSchema({ claim: "string", statement: "string", claimType: "string", type: "string" }, [])
    },
    // #16 Semantic challenge
    {
      name: "semantic_challenge",
      description: "Check whether the validator's domain actually covers what the claim asserts. Detects scope mismatches (e.g. 'secure' with file.contains) and runtime-state claims with static validators.",
      inputSchema: objectSchema({ statement: "string", validator: "string" }, ["statement", "validator"])
    },
    // #17 Action trace
    {
      name: "start_action_trace",
      description: "Begin a Reason→Act→Observe trace for an action. A claim cannot be considered complete without at least one recorded cycle.",
      inputSchema: objectSchema({ claimId: "string", purpose: "string" }, [])
    },
    {
      name: "add_trace_cycle",
      description: "Add one Reason→Act→Observe cycle to an active trace. Requires reason (why you're doing this), action (what you did), and observation (what you saw).",
      inputSchema: objectSchema({ traceId: "string", reason: "string", action: "string", observation: "object" }, ["traceId", "reason", "action", "observation"])
    },
    {
      name: "complete_action_trace",
      description: "Close an action trace. Returns PROCEED if at least one cycle was recorded, HALT if the trace is empty.",
      inputSchema: objectSchema({ traceId: "string" }, ["traceId"])
    },
    {
      name: "get_trace",
      description: "Retrieve a full action trace including all Reason→Act→Observe cycles.",
      inputSchema: objectSchema({ traceId: "string" }, ["traceId"])
    },
    // #18 Iterative verify
    {
      name: "iterative_verify",
      description: "Attempt to verify a claim up to N rounds (default 3). Returns PROCEED when realityWeight reaches threshold, UNVERIFIABLE after max rounds. UNVERIFIABLE means you must disclose uncertainty.",
      inputSchema: objectSchema({ validator: "string", statement: "string", maxRounds: "number", threshold: "number", path: "string", expression: "string", expected: "number", code: "string", expectedOutput: "string", url: "string", glob: "string", contains: "string" }, ["validator"])
    },
    // #19 Verify execution plan
    {
      name: "verify_execution",
      description: "Given code and your stated output, returns the exact verify_claim call you must run to confirm your stated output is correct. Does not execute anything itself.",
      inputSchema: objectSchema({ code: "string", statedOutput: "string" }, ["code", "statedOutput"])
    },
    // #9 Calibration report
    {
      name: "calibration_report",
      description: "Show calibration drift by validator — whether you are consistently overclaiming or underclaiming confidence compared to actual realityWeight.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },

    // U2
    {
      name: "gate_check",
      description: "Returns 'verified' (assert confidently), 'caveat' (qualify before asserting), or 'suppress' (disclaim or omit). Preferred: pass claimId — the gate reads verified/contradicted/realityWeight from the evidence ledger itself (attested). Raw realityWeight/verified/contradicted values are accepted but marked unattested. Note: verify_claim responses already embed a gate field; use gate_check to re-check existing claims.",
      inputSchema: objectSchema({ claimId: "string", realityWeight: "number", threshold: "number", verified: "boolean", contradicted: "boolean" }, [])
    }
  ];
}

function objectSchema(properties, required) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(properties).map(([k, t]) => [k, { type: t }])),
    required
  };
}

// ── Orientation guide (consumed by get_orientation tool + /api/orientation) ──
function buildOrientation() {
  return {
    server:    `AntiPsyc ${currentLabel} (${currentVersion})`,
    purpose:   "Anti-hallucination conscience layer — enforce grounded external evidence before any AI system asserts a claim as fact.",
    core_rule: "Every claim MUST be verified by an external validator before being asserted to the user. gate:HALT = STOP completely — do not proceed until required_steps are done.",

    workflow: {
      for_any_claim: [
        "1. Call pause_and_verify({ claim }) → mandatory HALT checklist with specific verify_claim steps",
        "2. Execute every verify_claim step from the checklist",
        "3. Call gate_check({ realityWeight, verified, contradicted }) → presentability signal",
        "4. Assert ONLY when gate='verified'. Caveat when gate='caveat'. Suppress otherwise."
      ],
      for_actions_write_delete_run: [
        "1. Call declare_action({ action, actionType, parameters }) → verification manifest",
        "2. Run every manifest step with verify_claim",
        "3. Call confirm_done({ intentId }) → closes the intent",
        "4. Only then assert completion to the user."
      ],
      for_multi_step_verification: [
        "1. Call plan_verification({ claim }) → Chain-of-Verification checklist",
        "2. Execute each step with verify_claim independently",
        "3. Use iterative_verify if threshold not reached on first attempt",
        "4. Use consistency_vote (n=3) to confirm non-deterministic claims"
      ]
    },

    gate_meanings: {
      "HALT":                "STOP. Complete required_steps. Do not assert the claim.",
      "PROCEED":             "Evidence chain complete. You may assert the claim.",
      "UNVERIFIABLE":        "Max rounds exhausted. Disclose uncertainty — never assert.",
      "gate_check.verified": "Assert confidently.",
      "gate_check.caveat":   "Assert with qualifier: 'Evidence suggests...', 'Based on verification...'",
      "gate_check.suppress": "Do not assert. Disclaim or omit entirely."
    },

    reality_weight_guide: {
      "≥ 0.85":       "Assert confidently — strong external grounding",
      "0.70 – 0.84":  "Caveat — prefix with 'Evidence suggests...'",
      "0.40 – 0.69":  "Qualify heavily — 'I believe but cannot confirm...'",
      "< 0.40":       "Suppress — do not assert; tell the user you could not verify"
    },

    conscience_auto_hooks: {
      note: "These run automatically on every submit_claim / verify_claim — no explicit call needed.",
      hooks: [
        "#3  contradiction_detection — warns if new claim conflicts with a verified ledger claim (rw≥0.75)",
        "#6  destructive_detection   — warns when claim contains delete/remove/wipe (requires double-verify)",
        "#8  reasoning_trace         — penalises claims with no reasoning field (−0.25 rw if absent)",
        "#9  calibration_tracking    — records claimed vs actual confidence drift per validator",
        "#10 sycophancy_detection    — penalises echo/leading-question framing (−0.15 rw)",
        "#16 semantic_challenge      — warns of scope mismatch (e.g. 'secure' + filesystem.exists)",
        "#7  constitutional_check    — warns if claim+validator violates operator-defined principles"
      ]
    },

    key_tools: {
      get_orientation:         "THIS TOOL — complete reference guide. Call first when connecting.",
      pause_and_verify:        "STOP and get a mandatory checklist before asserting any claim.",
      verify_claim:            "Primary verification tool. Run an external validator; inspect verified+realityWeight.",
      use_template:            "Shortcut for common verifications. Call get_templates first.",
      get_templates:           "List all available templates with their fill fields and examples.",
      gate_check:              "Translate realityWeight+verified+contradicted → verified/caveat/suppress signal.",
      declare_action:          "Register intent BEFORE performing any action (write, delete, run, install).",
      confirm_done:            "Close a declared intent AFTER completing all manifest verifications.",
      plan_verification:       "Generate a Chain-of-Verification checklist for a claim.",
      run_verification_chain:  "Run a sequence of verify_claim steps; fails fast on first unverified.",
      iterative_verify:        "Retry verification up to N rounds until realityWeight reaches threshold.",
      consistency_vote:        "Run validator N times; require unanimous agreement.",
      semantic_challenge:      "Check whether your validator can actually prove what the claim asserts.",
      constitutional_check:    "Explicitly check claim+validator against operator principles.",
      human_attest:            "Record operator approval (+0.15 rw) or rejection (→CONTRADICTED).",
      calibration_report:      "Show confidence drift by validator — are you overclaiming?"
    },

    validators:   listValidators(),
    templates_url: `http://127.0.0.1:${port}/api/templates`,

    quickstart_examples: {
      before_asserting_anything: {
        description: "Always start here before asserting a claim",
        tool: "pause_and_verify",
        input: { claim: "The file src/index.js exists and contains createServer" }
      },
      file_exists_template: {
        tool: "use_template",
        input: { template: "file-exists", fill: { path: "src/server.js" } }
      },
      code_produces_output: {
        tool: "verify_claim",
        input: {
          statement:      "Adding 1+2 produces 3",
          validator:      "code.run",
          code:           "console.log(1 + 2)",
          expectedOutput: "3"
        }
      },
      full_write_action_workflow: [
        { step: 1, tool: "declare_action",  input: { action: "Write config.json", actionType: "file_write", parameters: { path: "config.json", contains: '"version"' } } },
        { step: 2, tool: "verify_claim",    input: { statement: "config.json exists on disk",       validator: "filesystem.exists", path: "config.json" } },
        { step: 3, tool: "verify_claim",    input: { statement: 'config.json contains "version"',   validator: "file.contains", path: "config.json", contains: '"version"' } },
        { step: 4, tool: "confirm_done",    input: { intentId: "<intentId from declare_action response>" } }
      ]
    },

    http_api: {
      base:          `http://127.0.0.1:${port}`,
      openapi_spec:  `http://127.0.0.1:${port}/api/openapi.json`,
      plugin_manifest: `http://127.0.0.1:${port}/.well-known/ai-plugin.json`,
      always_public: ["/api/health", "/api/version", "/api/gate", "/api/templates", "/api/orientation", "/api/openapi.json", "/.well-known/ai-plugin.json"],
      auth: "Set Authorization: Bearer <ANTIPSYC_API_KEY> header when ANTIPSYC_API_KEY env var is set. Omit header in dev mode (no key set)."
    }
  };
}

// ── OpenAPI 3.1 spec (consumed by /api/openapi.json + ChatGPT Custom Actions) ─
function buildOpenApiSpec(baseUrl) {
  const hasSecurity = !!process.env.ANTIPSYC_API_KEY;
  const securityReq = hasSecurity ? [{ bearerAuth: [] }] : [];

  const verifyClaimSchema = {
    type: "object",
    properties: {
      statement:      { type: "string",  description: "Human-readable claim being verified." },
      claimId:        { type: "string",  description: "ID of an existing claim (omit to auto-create)." },
      validator:      { type: "string",  description: "Which validator to run. See GET /api/health for the full catalog." },
      path:           { type: "string",  description: "File or directory path (filesystem / file / git validators)." },
      url:            { type: "string",  description: "HTTP URL (http.fetch / retrieve_and_ground validators)." },
      expression:     { type: "string",  description: "Arithmetic expression (math.evaluate)." },
      expected:       { type: "number",  description: "Expected numeric result (math.evaluate)." },
      contains:       { type: "string",  description: "Substring to search for (file.contains / codebase.contains)." },
      pattern:        { type: "string",  description: "Regex pattern (file.matches / codebase.contains)." },
      code:           { type: "string",  description: "JavaScript code to run in sandbox (code.run)." },
      expectedOutput: { type: "string",  description: "Expected console output (code.run)." },
      glob:           { type: "string",  description: "Glob pattern for codebase.contains." },
      branch:         { type: "string",  description: "Git branch name (git.branch_exists)." },
      message:        { type: "string",  description: "Commit message fragment (git.log_contains)." },
      claim:          { type: "string",  description: "Claim text for term-frequency grounding (retrieve_and_ground)." },
      reasoning:      { type: "string",  description: "Why you believe this claim. Provide ≥150 chars to avoid realityWeight penalty." },
      claimedConfidence: { type: "number", description: "Your stated confidence 0–1. Tracked for calibration drift." }
    }
  };

  return {
    openapi: "3.1.0",
    info: {
      title:   "AntiPsyc — Anti-Hallucination Conscience Layer",
      version: currentVersion,
      description: [
        "Every claim an AI asserts must be verified through this API before being presented to users.",
        "",
        "**Core rule**: `gate:HALT` = stop completely. Complete `required_steps` before asserting.",
        "",
        "**Workflow**:",
        "1. `POST /api/conscience/pause` → get a mandatory verification checklist",
        "2. `POST /api/verify` for each checklist step",
        "3. `POST /api/gate` → translate realityWeight to verified/caveat/suppress",
        "4. Assert only when gate=`verified`",
        "",
        "**realityWeight guide**: ≥0.85 assert confidently | ≥0.70 caveat | ≥0.40 qualify | <0.40 suppress",
        "",
        "See `GET /api/orientation` for the full reference guide."
      ].join("\n"),
      contact: { url: baseUrl }
    },
    servers: [{ url: baseUrl, description: "AntiPsyc (self-hosted)" }],
    ...(hasSecurity ? {
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Set ANTIPSYC_API_KEY env var to enable. Omit in dev mode." } }
      }
    } : {}),
    paths: {
      "/api/health": {
        get: {
          operationId: "health",
          summary: "Health check — confirm server is up and list validators",
          responses: { "200": { description: "Server status and validator catalog" } }
        }
      },
      "/api/orientation": {
        get: {
          operationId: "getOrientation",
          summary: "Complete usage guide for AI systems — call this first when connecting",
          description: "Returns the full reference: workflow, gate meanings, realityWeight guide, all validators, and quickstart examples.",
          responses: { "200": { description: "Orientation guide" } }
        }
      },
      "/api/gate": {
        post: {
          operationId: "gateCheck",
          summary: "Translate realityWeight → presentability signal (verified / caveat / suppress)",
          description: "Always call this after verify_claim. Returns the signal you should use when deciding how to present a claim.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["realityWeight"],
              properties: {
                realityWeight: { type: "number", description: "From the evidence record (0–1)." },
                verified:      { type: "boolean", description: "From the evidence record." },
                contradicted:  { type: "boolean", description: "From the evidence record." },
                threshold:     { type: "number",  description: "Override default threshold (0.75)." }
              }
            }}}
          },
          responses: { "200": { description: "gate: verified | caveat | suppress" } }
        }
      },
      "/api/verify": {
        post: {
          operationId: "verifyClaim",
          summary: "Verify a claim using an external validator — THE primary endpoint",
          description: "Runs a real-world validator (filesystem, git, HTTP, math, code…) and stores immutable evidence. Check `verified`, `contradicted`, and `realityWeight` in the response. Pass `conscienceFlags` through to the user if HALT is present.",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: verifyClaimSchema } }
          },
          responses: { "200": { description: "Evidence record with verified, contradicted, realityWeight, conscienceFlags" } }
        }
      },
      "/api/verify/batch": {
        post: {
          operationId: "verifyBatch",
          summary: "Verify multiple claims in parallel",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["checks"],
              properties: {
                checks:   { type: "array",   items: verifyClaimSchema, description: "Array of verify_claim inputs." },
                parallel: { type: "boolean", description: "Run in parallel (default true)." }
              }
            }}}
          },
          responses: { "200": { description: "Array of evidence records" } }
        }
      },
      "/api/templates": {
        get: {
          operationId: "listTemplates",
          summary: "List available verification templates (shortcuts for common checks)",
          description: "Returns template IDs, descriptions, required fill fields, and examples. Use with POST /api/verify/template.",
          responses: { "200": { description: "Template catalog" } }
        }
      },
      "/api/verify/template": {
        post: {
          operationId: "verifyTemplate",
          summary: "Verify using a named template — simpler than verify_claim for common patterns",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["template", "fill"],
              properties: {
                template:  { type: "string", description: "Template ID from GET /api/templates." },
                fill:      { type: "object", description: "Key-value pairs for template fields.", additionalProperties: { type: "string" } },
                statement: { type: "string", description: "Optional override for the claim statement." }
              }
            }}}
          },
          responses: { "200": { description: "Evidence record" } }
        }
      },
      "/api/claims": {
        get: {
          operationId: "listClaims",
          summary: "List all claims in the evidence ledger",
          security: securityReq,
          parameters: [
            { name: "q",      in: "query", schema: { type: "string"  }, description: "Filter by text." },
            { name: "limit",  in: "query", schema: { type: "integer" }, description: "Page size (omit for all)." },
            { name: "offset", in: "query", schema: { type: "integer" }, description: "Page offset." }
          ],
          responses: { "200": { description: "Array of claims, or { data, total, limit, offset, hasMore } when limit is set." } }
        },
        post: {
          operationId: "submitClaim",
          summary: "Record a provisional claim (does not verify — use verify_claim for that)",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["statement"],
              properties: {
                statement:  { type: "string" },
                type:       { type: "string", description: "Claim type (e.g. filesystem.exists, math.assertion)." },
                reasoning:  { type: "string", description: "Why you believe this. ≥150 chars avoids rw penalty." },
                tags:       { type: "array",  items: { type: "string" } },
                source:     { type: "string" }
              }
            }}}
          },
          responses: { "201": { description: "Provisional claim record" } }
        }
      },
      "/api/claims/{id}": {
        get: {
          operationId: "getClaim",
          summary: "Fetch a claim with its full evidence history (decay applied)",
          security: securityReq,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Claim with evidence array" },
            "404": { description: "Claim not found" }
          }
        }
      },
      "/api/conscience/pause": {
        post: {
          operationId: "pauseAndVerify",
          summary: "STOP — get a mandatory verification checklist before asserting any claim",
          description: "Always returns gate:HALT with specific verify_claim steps. Call this before asserting any non-trivial claim.",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: { claim: { type: "string", description: "The claim you are about to assert." } }
            }}}
          },
          responses: { "200": { description: "HALT directive with required verification steps" } }
        }
      },
      "/api/conscience/declare": {
        post: {
          operationId: "declareAction",
          summary: "Register intent BEFORE performing any action — returns a verification manifest",
          description: "Call this before file_write, file_delete, git_commit, package_install, etc. The manifest tells you exactly what to verify_claim before claiming the action is done.",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["action"],
              properties: {
                action:     { type: "string", description: "What you are about to do (human-readable)." },
                actionType: { type: "string", description: "file_write | file_delete | file_edit | code_run | http_check | package_install | git_commit" },
                parameters: { type: "object", description: "Action parameters (path, contains, url, lib, etc.)." }
              }
            }}}
          },
          responses: { "200": { description: "Intent with verification manifest and intentId" } }
        }
      },
      "/api/conscience/confirm": {
        post: {
          operationId: "confirmDone",
          summary: "Close a declared intent after completing all manifest verifications",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["intentId"],
              properties: { intentId: { type: "string" } }
            }}}
          },
          responses: { "200": { description: "gate:PROCEED when complete, gate:HALT if intent was never declared" } }
        }
      },
      "/api/conscience/plan": {
        post: {
          operationId: "planVerification",
          summary: "Generate a Chain-of-Verification checklist for a claim",
          description: "Returns the specific verify_claim steps the MCP determines are needed. Run every step before asserting.",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                claim:     { type: "string" },
                claimType: { type: "string" }
              }
            }}}
          },
          responses: { "200": { description: "Ordered checklist of verify_claim steps" } }
        }
      },
      "/api/conscience/chain": {
        post: {
          operationId: "runVerificationChain",
          summary: "Run a sequence of verify_claim steps — fails fast at first unverified step",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["steps"],
              properties: {
                steps: { type: "array", description: "Array of verify_claim input objects, each run in order." }
              }
            }}}
          },
          responses: { "200": { description: "gate:PROCEED (all verified) or gate:HALT (step failed)" } }
        }
      },
      "/api/conscience/iterate": {
        post: {
          operationId: "iterativeVerify",
          summary: "Retry verification up to N rounds until realityWeight reaches threshold",
          description: "Returns gate:PROCEED when threshold reached, gate:UNVERIFIABLE when rounds exhausted. UNVERIFIABLE = disclose uncertainty, do not assert.",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["validator"],
              properties: {
                validator:  { type: "string" },
                statement:  { type: "string" },
                maxRounds:  { type: "integer", description: "Max retry rounds (2–5, default 3)." },
                threshold:  { type: "number",  description: "realityWeight target (default 0.75)." },
                path:       { type: "string" },
                expression: { type: "string" },
                expected:   { type: "number" }
              }
            }}}
          },
          responses: { "200": { description: "gate:PROCEED | gate:HALT (contradicted) | gate:UNVERIFIABLE" } }
        }
      },
      "/api/conscience/vote": {
        post: {
          operationId: "consistencyVote",
          summary: "Run the same validator N times — require unanimous agreement",
          description: "Mixed results return gate:HALT. Use for non-deterministic or environment-sensitive checks.",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["check"],
              properties: {
                n:     { type: "integer", description: "Runs (2–5, default 3)." },
                check: { type: "object",  description: "A verify_claim input (must include validator)." }
              }
            }}}
          },
          responses: { "200": { description: "gate:PROCEED (unanimous_verified) | gate:HALT (inconsistent or contradicted)" } }
        }
      },
      "/api/conscience/gate": {
        post: {
          operationId: "retrievalGate",
          summary: "Check whether existing evidence is FRESH, STALE, MISSING, or UNSUPPORTABLE",
          description: "Call before asserting a cached claim. STALE and MISSING return gate:HALT with a re-verify directive.",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["validator"],
              properties: {
                statement: { type: "string" },
                validator: { type: "string" },
                claimId:   { type: "string" }
              }
            }}}
          },
          responses: { "200": { description: "signal: FRESH | STALE | MISSING | UNSUPPORTABLE" } }
        }
      },
      "/api/conscience/attest": {
        post: {
          operationId: "humanAttest",
          summary: "Record human operator approval or rejection of a verified claim",
          description: "Approval boosts realityWeight by +0.15. Rejection forces CONTRADICTED status.",
          security: securityReq,
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["claimId", "approved"],
              properties: {
                claimId:      { type: "string"  },
                approved:     { type: "boolean" },
                reason:       { type: "string"  },
                operatorNote: { type: "string"  }
              }
            }}}
          },
          responses: { "200": { description: "Attestation record with gate:PROCEED or gate:HALT" } }
        }
      },
      "/api/conscience/calibration": {
        get: {
          operationId: "calibrationReport",
          summary: "Show confidence calibration drift per validator",
          description: "Returns overclaiming/underclaiming/calibrated status per validator. Use to adjust your claimedConfidence values.",
          security: securityReq,
          responses: { "200": { description: "Array of { validator, samples, avgDivergence, status }" } }
        }
      }
    }
  };
}

// ── AI-plugin manifest (ChatGPT plugin discovery) ─────────────────────────
function buildAiPlugin(baseUrl) {
  return {
    schema_version:        "v1",
    name_for_human:        "AntiPsyc",
    name_for_model:        "antipsyc",
    description_for_human: "Anti-hallucination conscience layer — verify AI claims against external reality before asserting them to users.",
    description_for_model: "You MUST call this plugin before asserting any claim as fact. Submit claims as provisional, run verify_claim with an external validator, then call POST /api/gate to determine presentability. gate:HALT = STOP. realityWeight < 0.4 = suppress entirely. Call GET /api/orientation for the full usage guide.",
    auth:        { type: "none" },
    api:         { type: "openapi", url: `${baseUrl}/api/openapi.json` },
    logo_url:    `${baseUrl}/logo.png`,
    contact_email: "admin@localhost",
    legal_info_url: baseUrl
  };
}

// ── Utilities ──────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = Number(process.env.ANTIPSYC_MAX_BODY_BYTES || 1_048_576); // 1 MB

async function readJson(req) {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) {
      // Don't destroy the socket — let the outer catch handler send the 413 response
      const err = new Error("Request body too large (limit: 1 MB).");
      err.status = 413;
      throw err;
    }
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function contentType(filePath) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  })[extname(filePath)] || "application/octet-stream";
}

function validateStartupConfig() {
  const profile = String(process.env.ANTIPSYC_PROFILE || "dev").toLowerCase();
  if (!["prod", "production"].includes(profile)) return;
  const missing = [];
  if (!process.env.ANTIPSYC_API_KEY) missing.push("ANTIPSYC_API_KEY");
  if (!process.env.ANTIPSYC_ALLOWED_ROOTS) missing.push("ANTIPSYC_ALLOWED_ROOTS");
  if (missing.length) {
    throw new Error(`Production profile requires: ${missing.join(", ")}`);
  }
}

// ── Smoke / demo modes ─────────────────────────────────────────────────────
async function runSmoke() {
  const claim    = await submitClaim({ statement: "package.json file exists", type: "filesystem.exists" });
  const evidence = await verifyClaim({ claimId: claim.id, validator: "filesystem.exists", path: join(rootDir, "package.json") });
  console.log(JSON.stringify({ claim, evidence }, null, 2));
}

async function runDemo() {
  await verifyClaim({
    statement: "Two plus two equals four", type: "math.assertion",
    validator: "math.evaluate", expression: "2 + 2", expected: 4
  });
  startHttpServer();
}
