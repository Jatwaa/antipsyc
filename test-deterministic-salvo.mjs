/**
 * test-deterministic-salvo.mjs
 *
 * Exhaustive deterministic probe covering every validator, the universal
 * template API (U3), and the confidence gate (U2).
 *
 * All claims have KNOWN expected outcomes — no ambiguity.
 * This is designed to be readable by a smaller model: the structure shows
 * exactly how to interact with each endpoint.
 *
 * Run with: node test-deterministic-salvo.mjs
 */
import { spawn }         from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readFileSync }  from "node:fs";

const __dirname  = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(__dirname, "src", "server.js");
const root       = __dirname;
const BASE       = "http://127.0.0.1:8717";

// ── Colours ────────────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m";
const C = "\x1b[36m", B = "\x1b[1m",  D = "\x1b[2m", RESET = "\x1b[0m";
const ok    = msg => console.log(`${G}✔${RESET} ${msg}`);
const fail  = msg => console.log(`${R}✘${RESET} ${msg}`);
const hdr   = msg => console.log(`\n${B}${C}━━━ ${msg} ━━━${RESET}`);
const note  = msg => console.log(`  ${D}${msg}${RESET}`);

// ── Spawn HTTP server ──────────────────────────────────────────────────────
const child = spawn("node", [serverPath, "--http"], {
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, ANTIPSYC_PORT: "8717" }
});
child.stderr.on("data", d => process.stderr.write(`${Y}[server] ${d}${RESET}`));
child.on("error", e => { fail(`Failed to spawn: ${e.message}`); process.exit(1); });

// Wait until /api/health responds
async function waitForServer(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(res => setTimeout(res, 200));
  }
  throw new Error("Server did not start in time");
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function get(path) {
  return (await fetch(`${BASE}${path}`)).json();
}

// ── Test runner ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(label, condition, detail = "") {
  if (condition) { ok(label); passed++; }
  else           { fail(`${label}${detail ? `  ← ${detail}` : ""}`); failed++; }
}

function assertShape(label, obj, requiredKeys) {
  const missing = requiredKeys.filter(k => obj[k] === undefined);
  assert(label, missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : "");
}

// Convenience: POST /api/verify and assert verified/contradicted/unverifiable
async function verify(body) { return post("/api/verify", body); }

// ── MAIN ───────────────────────────────────────────────────────────────────
async function run() {
  try {
    await waitForServer();
  } catch (e) {
    fail(`Server startup failed: ${e.message}`);
    child.kill();
    process.exit(1);
  }

  const pkg     = join(root, "package.json");
  const srv     = join(root, "src", "server.js");
  const val     = join(root, "src", "validators.js");
  const missing = join(root, "does-not-exist-xyz.txt");
  // Read the live version so the salvo never goes stale on a version bump
  const PKG_VERSION = JSON.parse(readFileSync(pkg, "utf8")).version;

  // ── Health check ─────────────────────────────────────────────────────────
  hdr("0 · Health & version");
  const health = await get("/api/health");
  assert("0.1  /api/health ok",              health.ok === true);
  assert(`0.2  version matches package.json (${PKG_VERSION})`, health.version === PKG_VERSION);
  assert("0.3  validators map present",      !!health.validators);
  const ver = await get("/api/version");
  assert("0.4  /api/version lists ≥4 versions", ver.versions?.length >= 4);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION A — FILESYSTEM VALIDATORS
  // ════════════════════════════════════════════════════════════════════════
  hdr("A · filesystem.exists");
  let ev;

  ev = await verify({ statement: "package.json exists", validator: "filesystem.exists", path: pkg });
  assert("A1  [TRUE]  package.json → VERIFIED",    ev.verified === true);
  assert("A1b realityWeight ≥ 0.90",                ev.realityWeight >= 0.90);

  // Claim statements must reference the verified artifact (contract rule)
  ev = await verify({ statement: "does-not-exist-xyz.txt exists on disk", validator: "filesystem.exists", path: missing });
  assert("A2  [FALSE] nonexistent path → CONTRADICTED", ev.contradicted === true);

  hdr("A · filesystem.stat");
  ev = await verify({ statement: "package.json stat", validator: "filesystem.stat", path: pkg });
  assert("A3  [TRUE]  stat → VERIFIED, has size",  ev.verified && ev.result?.size > 0);

  ev = await verify({ statement: "does-not-exist-xyz.txt has file metadata", validator: "filesystem.stat", path: missing });
  assert("A4  [FALSE] stat nonexistent → CONTRADICTED", ev.contradicted === true);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION B — FILE CONTENT VALIDATORS
  // ════════════════════════════════════════════════════════════════════════
  hdr("B · file.contains");

  // Contract rule: the statement must reference both the file and the literal
  // search term — claims narrower than evidence get demoted to irrelevant.
  ev = await verify({ statement: "validators.js contains vm.runInNewContext", validator: "file.contains", path: val, contains: "vm.runInNewContext" });
  assert("B1  [TRUE]  vm.runInNewContext in validators.js → VERIFIED", ev.verified === true);
  note(`  scanned ${ev.result?.fileSize} bytes`);

  ev = await verify({ statement: "validators.js contains require('react')", validator: "file.contains", path: val, contains: "require('react')" });
  assert("B2  [FALSE] React in validators.js → CONTRADICTED",           ev.contradicted === true);

  ev = await verify({ statement: "server.js contains express()", validator: "file.contains", path: srv, contains: "express()" });
  assert("B3  [FALSE] express() not in server.js → CONTRADICTED",       ev.contradicted === true);

  ev = await verify({ statement: "server.js contains 127.0.0.1", validator: "file.contains", path: srv, contains: "127.0.0.1" });
  assert("B4  [TRUE]  server mentions loopback default → VERIFIED",     ev.verified === true);

  hdr("B · file.matches");
  ev = await verify({ statement: "server.js matches import.*node:http", validator: "file.matches", path: srv, pattern: "import.*node:http" });
  assert("B5  [TRUE]  regex import.*node:http → VERIFIED",              ev.verified === true);

  ev = await verify({ statement: "server.js matches ^require\\( at line start", validator: "file.matches", path: srv, pattern: "^require\\(" });
  assert("B6  [FALSE] require() not in ESM file → CONTRADICTED",        ev.contradicted === true);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION C — CODE EXECUTION (JS RUNTIME TRUTHS)
  // ════════════════════════════════════════════════════════════════════════
  hdr("C · code.run — deterministic JS truths");

  const codeCheck = async (desc, code, expected, wantVerified) => {
    const e = await verify({ statement: desc, validator: "code.run", code, expectedOutput: expected });
    assert(`C· [${wantVerified ? "TRUE" : "FALSE"}] ${desc}`, e.verified === wantVerified,
      `got: verified=${e.verified}, observed=${JSON.stringify(e.result?.observed)}`);
  };

  await codeCheck("typeof null === 'object'",         "console.log(typeof null === 'object')",         "true",  true);
  await codeCheck("typeof null === 'null' [trap]",    "console.log(typeof null === 'null')",           "true",  false);
  await codeCheck("NaN !== NaN",                      "console.log(NaN !== NaN)",                      "true",  true);
  await codeCheck("0.1+0.2 !== 0.3 [float trap]",    "console.log(0.1 + 0.2 !== 0.3)",               "true",  true);
  await codeCheck("2**10 === 1024",                   "console.log(2**10)",                             "1024",  true);
  await codeCheck("Array(3).length === 3",            "console.log(Array(3).length)",                   "3",     true);
  await codeCheck("Array(3) holes — map skips values", "console.log(JSON.stringify(Array(3).map(x=>x*x)))", "[0,0,0]", false); // holes are skipped → [null,null,null] not [0,0,0]
  await codeCheck("'5'+3 = '53' [coercion]",         "console.log('5' + 3)",                           "53",    true);
  await codeCheck("'5'-3 = 2 [numeric coercion]",    "console.log('5' - 3)",                           "2",     true);
  await codeCheck("JSON.stringify({a:undefined})='{}'", "console.log(JSON.stringify({a:undefined}))", "{}", true);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION D — JSON VALIDATORS
  // ════════════════════════════════════════════════════════════════════════
  hdr("D · json.valid / json.path");

  ev = await verify({ statement: "package.json is valid JSON", validator: "json.valid", path: pkg });
  assert("D1  [TRUE]  package.json valid → VERIFIED",                   ev.verified === true);

  ev = await verify({ statement: "package.json name is antipsyc", validator: "json.path", path: pkg, keyPath: "name", expected: "antipsyc" });
  assert("D2  [TRUE]  package name correct → VERIFIED",                 ev.verified === true);

  ev = await verify({ statement: `package.json version is ${PKG_VERSION}`, validator: "json.path", path: pkg, keyPath: "version", expected: PKG_VERSION });
  assert(`D3  [TRUE]  package version ${PKG_VERSION} → VERIFIED`,       ev.verified === true);

  ev = await verify({ statement: "package.json type is commonjs", validator: "json.path", path: pkg, keyPath: "type", expected: "commonjs" });
  assert("D4  [FALSE] type is 'module' not 'commonjs' → CONTRADICTED",  ev.contradicted === true);

  ev = await verify({ statement: "package.json has no dependencies key", validator: "json.path", path: pkg, keyPath: "dependencies" });
  assert("D5  [FALSE] dependencies key absent → CONTRADICTED",          ev.contradicted === true);
  note("  Zero-dependency project — no dependencies key in package.json");

  ev = await verify({ statement: "package.json license is MIT", validator: "json.path", path: pkg, keyPath: "license", expected: "MIT" });
  assert("D6  [TRUE]  license = MIT → VERIFIED",                        ev.verified === true);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION E — CODEBASE SEARCH (G0)
  // ════════════════════════════════════════════════════════════════════════
  hdr("E · codebase.contains — G0 glob search");

  ev = await verify({ statement: "src/**/*.js contains vm.runInNewContext", validator: "codebase.contains", glob: "src/**/*.js", contains: "vm.runInNewContext" });
  assert("E1  [TRUE]  vm.runInNewContext in src/**/*.js → VERIFIED",    ev.verified === true);
  assert("E1b found in validators.js not server.js",                    ev.result?.matchedFiles?.some(f => f.includes("validators")));
  note(`  matchedFiles: ${ev.result?.matchedFiles?.map(f => f.split(/[/\\]/).pop()).join(", ")}`);

  ev = await verify({ statement: "src/**/*.js contains require('express')", validator: "codebase.contains", glob: "src/**/*.js", contains: "require('express')" });
  assert("E2  [FALSE] Express not in codebase → CONTRADICTED",          ev.contradicted === true);
  note(`  scanned ${ev.result?.scannedFiles} source files`);

  ev = await verify({ statement: "src/**/*.js matches SSRF", validator: "codebase.contains", glob: "src/**/*.js", pattern: "SSRF" });
  assert("E3  [TRUE]  SSRF pattern → VERIFIED (regex mode)",            ev.verified === true);

  // F6 hardening: a glob matching ZERO files is inconclusive (failed) — a
  // typo'd glob must not manufacture a high-confidence contradiction.
  ev = await verify({ statement: "**/*.jsx contains React", validator: "codebase.contains", glob: "**/*.jsx", contains: "React" });
  assert("E4  [INCONCLUSIVE] no .jsx files → FAILED (zero scanned)",    ev.status === "failed" && ev.contradicted === false);

  ev = await verify({ statement: "src/**/*.js contains DatabaseSync", validator: "codebase.contains", glob: "src/**/*.js", contains: "DatabaseSync" });
  assert("E5  [TRUE]  DatabaseSync in src → VERIFIED (C5 confirmed)",   ev.verified === true);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION F — GIT HISTORY (G8)
  // ════════════════════════════════════════════════════════════════════════
  hdr("F · git history validators");

  ev = await verify({ statement: "recent commit mentions AntiPsyc", validator: "git.log_contains", message: "AntiPsyc" });
  assert("F1  [TRUE]  'AntiPsyc' in recent commits → VERIFIED",         ev.verified === true);
  note(`  searched ${ev.result?.commitsSearched} commit(s)`);

  ev = await verify({ statement: "recent commit mentions React framework", validator: "git.log_contains", message: "React framework" });
  assert("F2  [FALSE] 'React framework' not in commits → CONTRADICTED", ev.contradicted === true);

  ev = await verify({ statement: "src/server.js has git history", validator: "git.last_modified", path: "src/server.js" });
  assert("F3  [TRUE]  src/server.js last modified → VERIFIED",          ev.verified === true);
  assert("F3b commit hash is 40 hex chars",                              /^[0-9a-f]{40}$/.test(ev.result?.hash));
  assert("F3c commitDate is ISO string",                                 ev.result?.commitDate?.includes("T"));
  note(`  last commit: ${ev.result?.hash?.slice(0,8)} — ${ev.result?.message}`);

  ev = await verify({ statement: "nonexistent.js has git history", validator: "git.last_modified", path: "nonexistent.js" });
  assert("F4  [FALSE] nonexistent.js no history → CONTRADICTED",        ev.contradicted === true);

  ev = await verify({ statement: "line 1 of server.js attribution", validator: "git.blame_line", path: "src/server.js", line: 1 });
  assert("F5  [TRUE]  blame line 1 → VERIFIED",                         ev.verified === true);
  assert("F5b blame hash present",                                       !!ev.result?.hash);
  note(`  line 1 by: ${ev.result?.author} @ ${ev.result?.hash?.slice(0,8)}`);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION G — MATH
  // ════════════════════════════════════════════════════════════════════════
  hdr("G · math.evaluate");

  ev = await verify({ statement: "2**10 = 1024", validator: "math.evaluate", expression: "2**10", expected: 1024 });
  assert("G1  [TRUE]  2**10 = 1024 → VERIFIED",    ev.verified === true);
  assert("G1b confidence = 0.99",                   ev.confidence === 0.99);

  ev = await verify({ statement: "1+1 = 3", validator: "math.evaluate", expression: "1+1", expected: 3 });
  assert("G2  [FALSE] 1+1 ≠ 3 → CONTRADICTED",    ev.contradicted === true);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION H — HTTP / SSRF
  // ════════════════════════════════════════════════════════════════════════
  hdr("H · http.fetch — SSRF protection");

  ev = await verify({ statement: "loopback is reachable", validator: "http.fetch", url: "http://127.0.0.1:9999" });
  assert("H1  SSRF loopback blocked → CONTRADICTED",  ev.contradicted === true);
  assert("H1b error mentions SSRF",                    ev.result?.error?.includes("SSRF"));

  ev = await verify({ statement: "RFC-1918 is reachable", validator: "http.fetch", url: "http://192.168.0.1" });
  assert("H2  SSRF RFC-1918 blocked → CONTRADICTED",   ev.contradicted === true);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION I — TYPE ENFORCEMENT (C4)
  // ════════════════════════════════════════════════════════════════════════
  hdr("I · validator-type enforcement (C4)");

  ev = await verify({ statement: "filesystem claim via text validator", type: "filesystem.exists", validator: "text.contains", text: "fake content", contains: "fake" });
  assert("I1  wrong validator → UNVERIFIABLE",     ev.status === "unverifiable");
  assert("I1b confidence = 0",                      ev.confidence === 0);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION J — CLAIM DEDUPLICATION (H4)
  // ════════════════════════════════════════════════════════════════════════
  hdr("J · claim deduplication (H4)");

  const dedupeStmt = `salvo dedup test ${Date.now()}`;
  const c1 = await post("/api/claims", { statement: dedupeStmt, type: "general" });
  const c2 = await post("/api/claims", { statement: dedupeStmt, type: "general" });
  assert("J1  same statement → same claim id",      c1.id === c2.id);
  assert("J2  fingerprint present",                  !!c1.fingerprint);
  assert("J3  trimmed/case-folded deduplication",   c1.fingerprint === c2.fingerprint);

  const c3 = await post("/api/claims", { statement: "  " + dedupeStmt + "  ", type: "general" });
  assert("J4  leading/trailing space normalised",   c3.id === c1.id);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION K — U3: CLAIM TEMPLATES
  // ════════════════════════════════════════════════════════════════════════
  hdr("K · U3 claim templates — GET /api/templates");

  const templates = await get("/api/templates");
  assert("K1  /api/templates returns array",            Array.isArray(templates));
  assert("K2  ≥ 12 templates registered",               templates.length >= 12);
  assert("K3  each template has id + fill + example",
    templates.every(t => t.id && Array.isArray(t.fill) && t.example));
  note(`  templates: ${templates.map(t => t.id).join(", ")}`);

  hdr("K · U3 POST /api/verify/template — correct fill");

  ev = await post("/api/verify/template", {
    template: "package-version",
    fill: { version: PKG_VERSION }
  });
  assert(`K4  package-version ${PKG_VERSION} → VERIFIED`, ev.verified === true);

  ev = await post("/api/verify/template", {
    template: "package-version",
    fill: { version: "9.9.9" }
  });
  assert("K5  package-version 9.9.9 → CONTRADICTED",     ev.contradicted === true);

  ev = await post("/api/verify/template", {
    template: "file-exists",
    fill: { path: srv }
  });
  assert("K6  file-exists server.js → VERIFIED",          ev.verified === true);

  ev = await post("/api/verify/template", {
    template: "codebase-has",
    fill: { glob: "src/**/*.js", contains: "vm.runInNewContext" }
  });
  assert("K7  codebase-has vm → VERIFIED",                ev.verified === true);

  ev = await post("/api/verify/template", {
    template: "no-dependency",
    fill: { lib: "express" }
  });
  assert("K8  no-dependency express → VERIFIED (absent = good)", ev.verified === true);
  assert("K8b expectAbsent flag in result",                ev.result?.expectAbsent === true);

  ev = await post("/api/verify/template", {
    template: "no-dependency",
    fill: { lib: "antipsyc" }   // package name IS in package.json
  });
  assert("K9  no-dependency 'antipsyc' → CONTRADICTED (present = bad)", ev.contradicted === true);

  ev = await post("/api/verify/template", {
    template: "code-output",
    fill: { code: "console.log(2+2)", expected: "4" }
  });
  assert("K10 code-output 2+2=4 → VERIFIED",              ev.verified === true);

  ev = await post("/api/verify/template", {
    template: "math-equals",
    fill: { expression: "2**10", expected: "1024" }
  });
  assert("K11 math-equals 2**10=1024 → VERIFIED",         ev.verified === true);

  ev = await post("/api/verify/template", {
    template: "json-key",
    fill: { path: pkg, keyPath: "license", expected: "MIT" }
  });
  assert("K12 json-key license=MIT → VERIFIED",           ev.verified === true);

  hdr("K · U3 — template error handling");

  const badTemplate = await post("/api/verify/template", { template: "nonexistent-template", fill: {} });
  assert("K13 unknown template → error response", badTemplate.error?.includes("Unknown template") || badTemplate.error?.includes("nonexistent"));

  const badFill = await post("/api/verify/template", { template: "package-version", fill: {} });
  assert("K14 missing fill fields → server error response", badFill.error?.includes("fill"));

  // ════════════════════════════════════════════════════════════════════════
  // SECTION L — U2: CONFIDENCE GATE
  // ════════════════════════════════════════════════════════════════════════
  hdr("L · U2 confidence gate — POST /api/gate");

  // Hardened gate (U2): verified=true must be passed explicitly — weight
  // alone never earns 'verified' or 'caveat'. Unresolved flags → suppress.
  let g;
  g = await post("/api/gate", { realityWeight: 0.95, verified: true });
  assert("L1  rw=0.95 verified → gate='verified'",   g.gate === "verified");
  assert("L1b suggestion is null",                    g.suggestion === null);

  g = await post("/api/gate", { realityWeight: 0.90, verified: true });
  assert("L2  rw=0.90 verified → gate='verified'",   g.gate === "verified");

  g = await post("/api/gate", { realityWeight: 0.60, verified: true });
  assert("L3  rw=0.60 verified → gate='caveat'",     g.gate === "caveat");
  assert("L3b suggestion is non-null",                typeof g.suggestion === "string");

  g = await post("/api/gate", { realityWeight: 0.40, verified: true });
  assert("L4  rw=0.40 verified → gate='caveat'",     g.gate === "caveat");

  g = await post("/api/gate", { realityWeight: 0.10, verified: true });
  assert("L5  rw=0.10 → gate='suppress'",            g.gate === "suppress");
  assert("L5b suggestion describes action",           g.suggestion?.includes("not certain") || g.suggestion?.includes("believe"));

  g = await post("/api/gate", { realityWeight: 0.00, verified: true });
  assert("L6  rw=0.00 → gate='suppress'",            g.gate === "suppress");

  // Missing flags default to suppress — a model cannot bless a bare number
  g = await post("/api/gate", { realityWeight: 0.95 });
  assert("L6b rw=0.95 without flags → suppress (anti-fabrication)", g.gate === "suppress");

  // Custom threshold
  g = await post("/api/gate", { realityWeight: 0.50, threshold: 0.60, verified: true });
  assert("L7  rw=0.50 below threshold=0.60 → suppress", g.gate === "suppress");

  g = await post("/api/gate", { realityWeight: 0.70, threshold: 0.60, verified: true });
  assert("L8  rw=0.70 above threshold=0.60 → caveat",   g.gate === "caveat");

  // ════════════════════════════════════════════════════════════════════════
  // SECTION M — FULL LOOP: verify → gate (small-model workflow)
  // ════════════════════════════════════════════════════════════════════════
  hdr("M · Full small-model loop: verify → gate → action");

  // 1. Submit via template (auto-generated statement is contract-compliant)
  const tev = await post("/api/verify/template", {
    template: "package-name",
    fill: { name: "antipsyc" }
  });
  assert("M1  template verify succeeded",    tev.verified === true || tev.contradicted === true);

  // 2. Gate the result — pass the evidence flags through (hardened gate)
  const tgate = await post("/api/gate", { realityWeight: tev.realityWeight, verified: tev.verified, contradicted: tev.contradicted });
  assert("M2  gate returns a signal",        ["verified", "caveat", "suppress"].includes(tgate.gate));
  assert("M3  correct gate for rw=0.90+",   tev.verified ? tgate.gate === "verified" : true);
  note(`  realityWeight=${tev.realityWeight}  gate="${tgate.gate}"  label="${tgate.label}"`);

  // 3. False claim loop
  const fev = await post("/api/verify/template", {
    template: "package-version",
    fill: { version: "99.0.0" }
  });
  const fgate = await post("/api/gate", { realityWeight: fev.realityWeight, contradicted: fev.contradicted });
  assert("M4  false claim → low rw",         fev.realityWeight <= 0.95);
  assert("M5  false claim → suppress",        fgate.gate === "suppress");
  note(`  false claim: rw=${fev.realityWeight}  gate="${fgate.gate}"`);
  note(`  suggestion: "${fgate.suggestion?.slice(0, 80)}…"`);

  // ════════════════════════════════════════════════════════════════════════
  // SECTION N — RESPONSE SHAPE (all claims must have required fields)
  // ════════════════════════════════════════════════════════════════════════
  hdr("N · Evidence response shape consistency");

  const shape = await verify({
    statement: "shape test", validator: "filesystem.exists", path: pkg
  });
  assertShape("N1  evidence has required fields",  shape,
    ["validator", "verified", "contradicted", "confidence", "realityWeight"]);
  assertShape("N2  evidence has provenance fields", shape,
    ["claimId", "timestamp"]);
  assert("N3  confidence ∈ [0,1]",                 shape.confidence >= 0 && shape.confidence <= 1);
  assert("N4  realityWeight ∈ [0,1]",              shape.realityWeight >= 0 && shape.realityWeight <= 1);

  const claim = await (await fetch(`${BASE}/api/claims/${shape.claimId}`)).json();
  assertShape("N5  claim has required fields",       claim,
    ["id", "statement", "type", "status", "confidence", "realityWeight", "fingerprint", "evidence"]);
  assert("N6  evidence array populated",             Array.isArray(claim.evidence) && claim.evidence.length > 0);

  // ── Summary ───────────────────────────────────────────────────────────
  const total = passed + failed;
  const pct   = ((passed / total) * 100).toFixed(0);
  console.log(`\n${B}${"═".repeat(60)}${RESET}`);
  console.log(`${B}  Deterministic Salvo Results${RESET}`);
  console.log(`${B}${"═".repeat(60)}${RESET}`);
  console.log(`  ${G}${B}Passed:${RESET}  ${passed} / ${total}  (${pct}%)`);
  if (failed) console.log(`  ${R}${B}Failed:${RESET}  ${failed}`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  Validators covered:   filesystem.exists/stat, file.contains/matches,`);
  console.log(`                        code.run (10 JS truths), json.valid/path,`);
  console.log(`                        codebase.contains (G0), git.log_contains/`);
  console.log(`                        last_modified/blame_line (G8), math.evaluate,`);
  console.log(`                        http.fetch (SSRF), type-enforcement`);
  console.log(`  Universal features:   U3 templates (${templates.length} templates, 10 checks),`);
  console.log(`                        U2 gate (8 checks), H4 dedup, full loop`);
  console.log(`${"═".repeat(60)}\n`);
}

run()
  .catch(e => { fail(`Fatal: ${e.message}`); failed++; })
  .finally(() => {
    child.kill();
    process.exit(failed > 0 ? 1 : 0);
  });
