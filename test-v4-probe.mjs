/**
 * AntiPsyc — v4 Diagnostic Probe
 *
 * Purpose: Run True/False claims across every validator category.
 * For each category, deliberately include claims that slip through
 * the current system to surface v4 requirements.
 *
 * Sections:
 *   A. Code execution (code.run)          — v3 new
 *   B. File content (file.contains)       — v3 new
 *   C. JSON structure (json.path)         — v3 new
 *   D. Validator-type enforcement (C4)    — v3 new
 *   E. Evidence TTL (C3)                  — v3 new
 *   F. Small-model hallucination patterns — JS type coercion, edge cases
 *   G. GAPS — claims the system cannot currently verify
 */

import { spawn }         from "node:child_process";
import { readFileSync }  from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const __dirname  = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(__dirname, "src", "server.js");
const pkgPath    = join(__dirname, "package.json");
const pkgText    = readFileSync(pkgPath, "utf8");

// ── Colours ───────────────────────────────────────────────────────────────
const R = "\x1b[0m", B = "\x1b[1m", DIM = "\x1b[2m";
const G = "\x1b[32m", RED = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", M = "\x1b[35m";

// ── Spawn MCP ─────────────────────────────────────────────────────────────
const child = spawn("node", [serverPath, "--mcp"], { stdio: ["pipe","pipe","pipe"] });
child.stderr.on("data", () => {});

let buf = Buffer.alloc(0), msgId = 1;
const pending = new Map();

child.stdout.on("data", chunk => {
  // Server emits spec-compliant newline-delimited JSON (one message per line).
  buf = Buffer.concat([buf, chunk]);
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).toString("utf8").trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith("{")) continue;
    let payload;
    try { payload = JSON.parse(line); } catch { continue; }
    if (payload.id !== undefined && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      payload.error ? reject(new Error(payload.error.message)) : resolve(payload.result);
    }
  }
});

function rpc(method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("Timeout")); } }, 8000);
  });
}

async function call(_label, args) {
  const statement = args.statement || `v4-probe: ${args.validator} check`;
  const res = await rpc("tools/call", { name: "verify_claim", arguments: { ...args, statement } });
  return JSON.parse(res.content[0].text);
}

await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "v4-probe" }, capabilities: {} });

// ── Result tracking ───────────────────────────────────────────────────────
const results  = [];
let   section  = "";

function row(label, expected, ev, note = "") {
  const status   = ev.status || (ev.verified ? "verified" : ev.contradicted ? "contradicted" : "unknown");
  const caught   = (expected === "CAUGHT")   ? ev.contradicted || status === "unverifiable" || status === "failed"
                 : (expected === "VERIFIED") ? ev.verified
                 : false;
  const icon     = caught ? `${G}✔${R}` : `${RED}✘${R}`;
  const statusFmt = status === "verified"     ? `${G}VERIFIED${R}`
                  : status === "contradicted"  ? `${RED}CONTRADICTED${R}`
                  : status === "failed"        ? `${Y}FAILED${R}`
                  : status === "unverifiable"  ? `${M}UNVERIFIABLE${R}`
                  : status === "stale"         ? `${DIM}STALE${R}`
                  : `${Y}${status.toUpperCase()}${R}`;
  console.log(
    `  ${icon} ${B}${label}${R}\n` +
    `     expect=${expected.padEnd(12)} got=${statusFmt}  conf=${(ev.confidence||0).toFixed(2)}  rw=${(ev.realityWeight||0).toFixed(2)}` +
    (note ? `\n     ${DIM}${note}${R}` : "")
  );
  results.push({ section, label, expected, caught, status, confidence: ev.confidence || 0 });
}

function sec(name) {
  section = name;
  console.log(`\n${B}${C}━━━ ${name} ━━━${R}`);
}

function gap(label, reason) {
  console.log(`  ${M}◈ GAP${R} ${B}${label}${R}\n    ${DIM}${reason}${R}`);
  results.push({ section, label, expected: "GAP", caught: false, status: "gap", gap: reason });
}

// ═══════════════════════════════════════════════════════════════════
console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗`);
console.log(`║  AntiPsyc v3 — Diagnostic Probe for v4 Planning         ║`);
console.log(`╚══════════════════════════════════════════════════════════════╝${R}`);

// ── A. Code Execution (code.run) ──────────────────────────────────────────
sec("A · code.run — JS type coercions & edge cases (small-model traps)");

row("typeof null === 'null' [FALSE — famous JS trap]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `console.log(typeof null === 'null')`,
  expectedOutput: "true"
}), "typeof null is 'object', not 'null'");

row("typeof NaN === 'number' [TRUE — counterintuitive]", "VERIFIED", await call("verify", {
  validator: "code.run",
  code: `console.log(typeof NaN === 'number')`,
  expectedOutput: "true"
}), "NaN is technically type number in JS");

row("0.1 + 0.2 === 0.3 [FALSE — float trap]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `console.log(0.1 + 0.2 === 0.3)`,
  expectedOutput: "true"
}), "IEEE 754: 0.1+0.2 = 0.30000000000000004");

row("null == undefined [TRUE — loose equality]", "VERIFIED", await call("verify", {
  validator: "code.run",
  code: `console.log(null == undefined)`,
  expectedOutput: "true"
}), "Abstract equality: null == undefined is true");

row("[1,2,3].includes(1,2) returns true [FALSE — fromIndex param]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `console.log([1,2,3].includes(1, 2))`,
  expectedOutput: "true"
}), "Second arg is fromIndex=2; 1 only appears at index 0");

row("Array(3).map returns 3 squares [FALSE — Array(n) is holey]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `console.log(JSON.stringify(Array(3).map((_,i)=>i*i)))`,
  expectedOutput: "[0,1,4]"
}), "Array(3) creates holes — map skips them, returns [,,]");

row("'5' + 3 === '53' [TRUE — string coercion]", "VERIFIED", await call("verify", {
  validator: "code.run",
  code: `console.log('5' + 3 === '53')`,
  expectedOutput: "true"
}));

row("'5' - 3 === 2 [TRUE — numeric coercion]", "VERIFIED", await call("verify", {
  validator: "code.run",
  code: `console.log('5' - 3 === 2)`,
  expectedOutput: "true"
}), "Minus coerces string to number");

row("[...'hello'].length === 5 [TRUE]", "VERIFIED", await call("verify", {
  validator: "code.run",
  code: `console.log([...'hello'].length === 5)`,
  expectedOutput: "true"
}));

row("{} + [] returns 0 [FALSE — context-dependent]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `console.log(({}) + [] === 0)`,
  expectedOutput: "true"
}), "In expression context, {}+[] = '[object Object]' (string)");

// ── B. File Content (file.contains) ─────────────────────────────────────
sec("B · file.contains — AI source code assumptions");

row("server.js uses vm.runInNewContext [TRUE]", "VERIFIED", await call("verify", {
  validator: "file.contains",
  path: serverPath,
  contains: "vm.runInNewContext"
}));

row("server.js uses Express.js [FALSE]", "CAUGHT", await call("verify", {
  validator: "file.contains",
  path: serverPath,
  contains: "require('express')"
}), "Zero-dependency — no Express");

row("validators.js uses require() [FALSE — ESM project]", "CAUGHT", await call("verify", {
  validator: "file.contains",
  path: join(__dirname, "src", "validators.js"),
  contains: "require("
}), "Project uses ES modules (import), not CommonJS");

row("server.js binds to 0.0.0.0 [FALSE — loopback only]", "CAUGHT", await call("verify", {
  validator: "file.contains",
  path: serverPath,
  contains: "0.0.0.0"
}), "Server binds to 127.0.0.1 only");

row("package.json has a test script [FALSE]", "CAUGHT", await call("verify", {
  validator: "file.contains",
  path: pkgPath,
  contains: '"test":'
}), "Package has smoke/demo/mcp/ui — no 'test' script");

row("store.js uses #writeLock mutex [TRUE — v2+]", "VERIFIED", await call("verify", {
  validator: "file.contains",
  path: join(__dirname, "src", "store.js"),
  contains: "#writeLock"
}));

// ── C. JSON path ──────────────────────────────────────────────────────────
sec("C · json.path — config/package assertions");

row("package name is 'antipsyc' [TRUE]", "VERIFIED", await call("verify", {
  validator: "json.path",
  path: pkgPath,
  keyPath: "name",
  expected: "antipsyc"
}));

row("package version is '1.0.0' [FALSE]", "CAUGHT", await call("verify", {
  validator: "json.path",
  path: pkgPath,
  keyPath: "version",
  expected: "1.0.0"
}), "Current version is 0.3.0");

row("package license is 'MIT' [TRUE]", "VERIFIED", await call("verify", {
  validator: "json.path",
  path: pkgPath,
  keyPath: "license",
  expected: "MIT"
}));

row("package type is 'commonjs' [FALSE — ESM]", "CAUGHT", await call("verify", {
  validator: "json.path",
  path: pkgPath,
  keyPath: "type",
  expected: "commonjs"
}), "package.json declares type: module (ESM)");

row("node engine requires >=16 [FALSE]", "CAUGHT", await call("verify", {
  validator: "json.path",
  path: pkgPath,
  keyPath: "engines.node",
  expected: ">=16"
}), "Requires >=18");

// ── D. Validator-type enforcement (C4) ───────────────────────────────────
sec("D · type enforcement — wrong validator for claim type");

const enforcedClaim = await rpc("tools/call", {
  name: "submit_claim",
  arguments: { statement: "Filesystem claim verified with wrong validator", type: "filesystem.exists" }
});
const enforcedId = JSON.parse(enforcedClaim.content[0].text).id;

const wrongValidator = await rpc("tools/call", {
  name: "verify_claim",
  arguments: { claimId: enforcedId, validator: "text.contains", text: "anything", contains: "x" }
});
const wvEv = JSON.parse(wrongValidator.content[0].text);
row("filesystem.exists claim verified with text.contains [BLOCKED]", "CAUGHT", wvEv,
  `Type enforcement returns: ${wvEv.status}`);

// ── E. Evidence TTL / decay metadata ─────────────────────────────────────
sec("E · evidence TTL — expiresAt written, supersedes chain");

const ttlClaim = await rpc("tools/call", {
  name: "verify_claim",
  arguments: { statement: "TTL probe", validator: "filesystem.exists", path: pkgPath }
});
const ttlEv = JSON.parse(ttlClaim.content[0].text);
const hasExpiry = !!ttlEv.expiresAt;
const hasSupersedes = "supersedes" in ttlEv;
console.log(`  ${hasExpiry ? `${G}✔${R}` : `${RED}✘${R}`} ${B}expiresAt field present${R}  value: ${ttlEv.expiresAt}`);
console.log(`  ${hasSupersedes ? `${G}✔${R}` : `${RED}✘${R}`} ${B}supersedes field present${R}  value: ${ttlEv.supersedes}`);
results.push({ section, label: "expiresAt on evidence", expected: "VERIFIED", caught: hasExpiry, status: hasExpiry ? "verified" : "missing" });
results.push({ section, label: "supersedes on evidence", expected: "VERIFIED", caught: hasSupersedes, status: hasSupersedes ? "verified" : "missing" });

// ── F. Small-model hallucination patterns ────────────────────────────────
sec("F · small-model patterns — common confident errors");

row("parseInt('08') returns 8 [TRUE — modern JS]", "VERIFIED", await call("verify", {
  validator: "code.run",
  code: `console.log(parseInt('08') === 8)`,
  expectedOutput: "true"
}), "Old gotcha: pre-ES5 parseInt('08') was 0 in octal mode — fixed in ES5+");

row("[] == false [TRUE — type coercion chain]", "VERIFIED", await call("verify", {
  validator: "code.run",
  code: `console.log([] == false)`,
  expectedOutput: "true"
}), "[] → '' → 0 → false via abstract equality steps");

row("NaN === NaN [FALSE — NaN is never equal to itself]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `console.log(NaN === NaN)`,
  expectedOutput: "true"
}), "NaN is the only value not equal to itself");

row("JSON.stringify({a:undefined}) returns '{\"a\":undefined}' [FALSE]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `console.log(JSON.stringify({a:undefined}))`,
  expectedOutput: '{"a":undefined}'
}), "undefined properties are omitted: result is '{}'");

row("'abc'[10] throws RangeError [FALSE]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `try { let x = 'abc'[10]; console.log('no error: ' + x); } catch(e){ console.log('error'); }`,
  expectedOutput: "error"
}), "String index out of bounds returns undefined — no exception");

row("Object.keys({}) returns null [FALSE]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `console.log(Object.keys({}) === null)`,
  expectedOutput: "true"
}), "Returns [] (empty array)");

row("Promise.resolve(1).then(v=>v*2) sync result is 2 [FALSE — async]", "CAUGHT", await call("verify", {
  validator: "code.run",
  code: `let result = 'pending'; Promise.resolve(1).then(v => { result = v*2; }); console.log(result)`,
  expectedOutput: "2"
}), "Promise callbacks are microtasks — result is still 'pending' synchronously");

// ── G. GAPS — what v3 cannot verify ──────────────────────────────────────
sec("G · GAPS — v3 cannot verify these (v4 targets)");

gap(
  "Semantic code correctness: 'The SSRF check covers ALL private ranges'",
  "v3 can verify specific strings exist in the file but cannot audit the logic for completeness. Needs: static analysis validator or structured code-property checker."
);
gap(
  "Cross-file consistency: 'Every validator in the catalog has a matching case in verifyWithValidator'",
  "Requires reading and comparing two parts of the same file programmatically. Needs: AST/structural analysis validator."
);
gap(
  "API contract: 'appendEvidence always returns a record with id, claimId, and timestamp'",
  "Requires running the function with controlled inputs and inspecting the return object shape. Needs: function-level contract validator (input → output shape assertion)."
);
gap(
  "Performance: 'The server handles 50 concurrent verify requests without data loss'",
  "Needs: load test runner validator (e.g. run N parallel fetches, assert all evidence records created)."
);
gap(
  "Dependency chain: 'node:vm provides complete sandbox isolation'",
  "This is FALSE (vm is not fully isolated in Node.js) but no current validator can detect it. Needs: known-limitations knowledge base / LLM critic with security expertise."
);
gap(
  "Documentation accuracy: 'The README accurately describes the current API'",
  "Requires diffing prose descriptions against actual route definitions. Needs: doc-to-code consistency validator."
);
gap(
  "Natural language claim: 'This project is production-ready'",
  "Composite qualitative claim — cannot be decomposed into existing atomic validators without human-defined rubric. Needs: claim decomposition engine + rubric runner."
);
gap(
  "Hallucination from context: 'The last commit added file.contains'",
  "Temporal/git-history claim requiring git.log parsing. git.file_exists only checks current HEAD."
);
gap(
  "Streaming validation: validate claims AS the AI generates tokens",
  "Current system requires complete claim submission. Needs: streaming claim intake with partial-match validators."
);
gap(
  "Cross-model agreement: 'Three different models agree the mutex is correct'",
  "Requires calling multiple inference endpoints and comparing answers. Needs: multi-model consensus validator."
);

// ── Summary ───────────────────────────────────────────────────────────────
const verified  = results.filter(r => r.expected !== "GAP" && r.caught);
const missed    = results.filter(r => r.expected !== "GAP" && !r.caught);
const gaps      = results.filter(r => r.expected === "GAP");

console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗`);
console.log(`║  Results                                                     ║`);
console.log(`╠══════════════════════════════════════════════════════════════╣`);
console.log(`║  ${G}Caught / verified correctly:  ${verified.length.toString().padEnd(3)}${R}${B}                            ║`);
console.log(`║  ${RED}Slipped through:              ${missed.length.toString().padEnd(3)}${R}${B}                            ║`);
console.log(`║  ${M}Structural gaps (v4 targets): ${gaps.length.toString().padEnd(3)}${R}${B}                            ║`);
console.log(`╚══════════════════════════════════════════════════════════════╝${R}`);

if (missed.length > 0) {
  console.log(`\n${B}${RED}Claims that slipped through:${R}`);
  missed.forEach(r => console.log(`  ${RED}✘${R} [${r.section}] ${r.label}`));
}

console.log(`\n${B}${M}Structural gaps — things no current validator can verify:${R}`);
gaps.forEach(r => console.log(`  ${M}◈${R} ${r.label}`));

child.kill();
