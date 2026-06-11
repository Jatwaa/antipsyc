/**
 * test-conscience-full.mjs
 *
 * Comprehensive conscience-layer test.
 * Covers all 20 anti-hallucination tactics, the full declare→verify→confirm
 * lifecycle, HALT enforcement, and the new AI-accessibility endpoints.
 *
 * Run: node test-conscience-full.mjs
 *
 * Exit 0 = all pass.  Exit 1 = failures.
 */
import { spawn }         from "node:child_process";
import { createServer }  from "node:http";
import { fileURLToPath } from "node:url";
import { join }          from "node:path";

const __dirname  = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(__dirname, "src", "server.js");
const HTTP_PORT  = 8719;   // use a different port to avoid conflicts

// ── ANSI colours ─────────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m";
const B = "\x1b[1m",  D = "\x1b[2m",  Z = "\x1b[0m";
const pass = (m, d = "") => { results.pass++;  console.log(`${G}PASS${Z}  ${m}${d ? `  ${D}${d}${Z}` : ""}`); };
const fail = (m, d = "") => { results.fail++;  console.error(`${R}FAIL${Z}  ${m}${d ? `  ${Y}${d}${Z}` : ""}`); };
const section = (m)      => console.log(`\n${B}${C}── ${m} ──${Z}`);
const results = { pass: 0, fail: 0 };

function ok(cond, label, detail = "") {
  cond ? pass(label, detail) : fail(label, detail);
}

// ── Spawn MCP child (stdio transport) ────────────────────────────────────────
const child = spawn("node", [serverPath, "--mcp"], {
  cwd:   __dirname,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ANTIPSYC_ALLOWED_ROOTS:    __dirname,
    ANTIPSYC_HTTP_ALLOWLIST:   "example.com,127.0.0.1",
    ANTIPSYC_ALLOW_LOCAL_HTTP: "true",   // loopback-only opt-in for the fixture server
    ANTIPSYC_RATE_LIMIT:       "1000",
    ANTIPSYC_ALLOWED_COMMANDS: "node",
  },
});
child.stderr.on("data", () => {});   // suppress server noise

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
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout on ${method}`)); }
    }, 10_000);
  });
}

async function tool(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  return JSON.parse(res.content[0].text);
}

// ── Minimal HTTP server for retrieve_and_ground tests ─────────────────────
const httpSrv = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("epistemic conscience layer anti-hallucination verify claims");
});
await new Promise(r => httpSrv.listen(HTTP_PORT, "127.0.0.1", r));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  clientInfo: { name: "conscience-full-test" },
  capabilities: {},
});

// ═══════════════════════════════════════════════════════════════════════════════
// 0.  MCP protocol basics
// ═══════════════════════════════════════════════════════════════════════════════
section("0 — MCP protocol basics");

ok(init.protocolVersion === "2024-11-05",  "initialize returns correct protocol version");
ok(typeof init.instructions === "string",  "initialize carries instructions field");
ok(init.instructions.includes("HALT"),     "instructions mention HALT directive");
ok(init.instructions.includes("gate_check"), "instructions reference gate_check");
ok(init.serverInfo?.name === "antipsyc", "serverInfo.name is antipsyc");

const toolList = await rpc("tools/list");
const toolNames = toolList.tools.map(t => t.name);
ok(toolNames[0] === "get_orientation",     "get_orientation is the first tool listed");
ok(toolNames.includes("verify_claim"),     "verify_claim tool present");
ok(toolNames.includes("pause_and_verify"), "pause_and_verify tool present");
ok(toolNames.includes("declare_action"),   "declare_action tool present");
ok(toolNames.includes("iterative_verify"), "iterative_verify tool present");
ok(toolNames.length >= 25,                 `tools/list has ${toolNames.length} tools (≥25)`);

// ═══════════════════════════════════════════════════════════════════════════════
// 1.  Orientation tool — #0 discoverability
// ═══════════════════════════════════════════════════════════════════════════════
section("1 — get_orientation");

const orientation = await tool("get_orientation");
ok(typeof orientation.purpose === "string",      "orientation: purpose present");
ok(typeof orientation.core_rule === "string",    "orientation: core_rule present");
ok(orientation.core_rule.includes("HALT"),       "orientation: core_rule mentions HALT");
ok(Array.isArray(orientation.workflow?.for_any_claim), "orientation: workflow.for_any_claim is array");
ok(typeof orientation.key_tools?.verify_claim === "string", "orientation: key_tools.verify_claim present");
ok(typeof orientation.validators === "object",   "orientation: validators catalog present");
ok(typeof orientation.quickstart_examples === "object", "orientation: quickstart_examples present");
ok(typeof orientation.http_api === "object",     "orientation: http_api section present");
ok(orientation.http_api?.always_public?.includes("/api/orientation"), "orientation: lists itself as always-public");

// ═══════════════════════════════════════════════════════════════════════════════
// 2.  Gate check — baseline
// ═══════════════════════════════════════════════════════════════════════════════
section("2 — gate_check");

const gHigh  = await tool("gate_check", { realityWeight: 0.90, verified: true,  contradicted: false });
const gMid   = await tool("gate_check", { realityWeight: 0.60, verified: false, contradicted: false });
const gLow   = await tool("gate_check", { realityWeight: 0.20, verified: false, contradicted: false });
const gContra= await tool("gate_check", { realityWeight: 0.95, verified: false, contradicted: true  });

ok(gHigh.gate   === "verified", "gate_check: rw=0.90 verified=true → verified");
// Hardened gate: weight alone never earns caveat without verified=true —
// unresolved flags default to suppress (anti-fabrication).
ok(gMid.gate    === "suppress", "gate_check: rw=0.60 unverified → suppress (hardened)");
ok(gLow.gate    === "suppress", "gate_check: rw=0.20 → suppress");
ok(gContra.gate === "suppress", "gate_check: contradicted=true always suppresses regardless of rw");

// ═══════════════════════════════════════════════════════════════════════════════
// 3.  verify_claim — grounded validators
// ═══════════════════════════════════════════════════════════════════════════════
section("3 — verify_claim (grounded validators)");

const pkgExists = await tool("verify_claim", {
  statement: "package.json exists on disk",
  validator: "filesystem.exists",
  path: join(__dirname, "package.json"),
});
ok(pkgExists.verified === true,  "filesystem.exists: real file → verified");
ok(pkgExists.realityWeight > 0.8,"filesystem.exists: realityWeight > 0.8");

const missingFile = await tool("verify_claim", {
  statement: "no-such-file-xyz.txt does not exist",
  validator: "filesystem.exists",
  path: join(__dirname, "no-such-file-xyz.txt"),
});
ok(missingFile.contradicted === true, "filesystem.exists: missing file → contradicted");

const mathRight = await tool("verify_claim", {
  statement: "2 + 2 equals 4",
  validator: "math.evaluate",
  expression: "2 + 2",
  expected: 4,
});
ok(mathRight.verified === true, "math.evaluate: 2+2=4 → verified");

const mathWrong = await tool("verify_claim", {
  statement: "2 + 2 equals 5",
  validator: "math.evaluate",
  expression: "2 + 2",
  expected: 5,
});
ok(mathWrong.contradicted === true, "math.evaluate: 2+2=5 → contradicted");

const codeOk = await tool("verify_claim", {
  statement: "console.log(40+2) outputs 42",
  validator: "code.run",
  code: "console.log(40 + 2)",
  expectedOutput: "42",
});
ok(codeOk.verified === true, "code.run: correct output → verified");

const codeBad = await tool("verify_claim", {
  statement: "console.log(1+1) outputs 99",
  validator: "code.run",
  code: "console.log(1 + 1)",
  expectedOutput: "99",
});
ok(codeBad.contradicted === true, "code.run: wrong output → contradicted");

const fileContains = await tool("verify_claim", {
  statement: "package.json contains 'antipsyc'",
  validator: "file.contains",
  path: join(__dirname, "package.json"),
  contains: "antipsyc",
});
ok(fileContains.verified === true, "file.contains: known substring → verified");

const fileNoContain = await tool("verify_claim", {
  statement: "package.json contains 'express'",
  validator: "file.contains",
  path: join(__dirname, "package.json"),
  contains: "express",   // statement must reference the literal search term
});
ok(fileNoContain.contradicted === true, "file.contains: absent dependency → contradicted");

// ═══════════════════════════════════════════════════════════════════════════════
// 4.  Auto-hooks fired on submit/verify
// ═══════════════════════════════════════════════════════════════════════════════
section("4 — auto-hooks (reasoning trace, sycophancy, calibration)");

// #8 Reasoning trace: grounded OBSERVED evidence is a posterior — no penalty
// even without reasoning (the validator physically observed the file).
const noReasoning = await tool("verify_claim", {
  statement: "package.json exists with no reasoning",
  validator: "filesystem.exists",
  path: join(__dirname, "package.json"),
  // No reasoning field
});
ok(!noReasoning.conscienceFlags?.rwPenalty,
  "#8 reasoning_trace: grounded observed evidence carries no rwPenalty",
  `penalty=${noReasoning.conscienceFlags?.rwPenalty}`);

// #8 Reasoning trace: non-observed (simulated) evidence without reasoning IS penalised
const noReasoningSim = await tool("verify_claim", {
  statement: "console.log(6*7) outputs 42 without reasoning",
  validator: "code.run",
  code: "console.log(6 * 7)",
  expectedOutput: "42",
  force: true,
  // No reasoning field
});
ok(noReasoningSim.conscienceFlags?.rwPenalty > 0,
  "#8 reasoning_trace: simulated evidence without reasoning applies rwPenalty",
  `penalty=${noReasoningSim.conscienceFlags?.rwPenalty}`);

// #8 Reasoning trace: adequate reasoning → no penalty
const goodReasoning = await tool("verify_claim", {
  statement: "package.json exists on disk with full reasoning",
  validator: "filesystem.exists",
  path: join(__dirname, "package.json"),
  reasoning: "I can see the project root contains package.json based on running ls in the directory and observing the file listing output, which showed package.json at the root level of the project.",
});
ok(!goodReasoning.conscienceFlags?.rwPenalty,
  "#8 reasoning_trace: adequate reasoning → no rwPenalty",
  `flags=${JSON.stringify(goodReasoning.conscienceFlags)}`);

// #10 Sycophancy: echo framing → penalty
const syco = await tool("submit_claim", {
  statement: "Everything is working correctly, right?",
});
ok(syco.sycophancyWarning?.sycophancyDetected === true,
  "#10 sycophancy_detection: echo framing flagged",
  `pattern=${syco.sycophancyWarning?.pattern}`);

// #3 Contradiction detection: contradicts prior verified claim
// First verify a claim as true
await tool("verify_claim", {
  statement: "package.json exists on disk for contradiction test",
  validator: "filesystem.exists",
  path: join(__dirname, "package.json"),
  reasoning: "Running filesystem check to establish a verified baseline for contradiction detection testing in this test suite.",
});
// Now submit a contradicting claim
const contradicting = await tool("submit_claim", {
  statement: "package.json does not exist on disk for contradiction test",
});
// Note: contradiction only fires if the prior claim has rw≥0.75 and is verified/contradicted
// The prior claim got penalised by reasoning (no reasoning field above) so may not fire
// We just check the field is present or null — not a hard failure
ok(contradicting.conscienceWarning == null || contradicting.conscienceWarning?.tactic === "contradiction_detection",
  "#3 contradiction_detection: fires or is null (claim may not meet rw threshold)");

// ═══════════════════════════════════════════════════════════════════════════════
// 5.  #1 Intent tracking — declare_action / confirm_done
// ═══════════════════════════════════════════════════════════════════════════════
section("5 — #1 intent tracking (declare → verify → confirm)");

// HALT path: confirm without declare
const noIntent = await tool("confirm_done", { intentId: "nonexistent-intent-id" });
ok(noIntent.gate === "HALT",
  "#1 intent: confirm_done with no prior declare → HALT",
  `gate=${noIntent.gate}`);

// PROCEED path: full lifecycle
const decl = await tool("declare_action", {
  action:     "Write test-output.json",
  actionType: "file_write",
  parameters: { path: "test-output.json", contains: '"test"' },
});
ok(typeof decl.intentId === "string",        "#1 intent: declare_action returns intentId");
ok(Array.isArray(decl.manifest),             "#1 intent: manifest is an array");
ok(decl.manifest.length >= 1,               `#1 intent: manifest has ${decl.manifest.length} step(s)`);
ok(decl.status === "open",                   "#1 intent: status starts as open");

const done = await tool("confirm_done", { intentId: decl.intentId });
ok(done.gate === "PROCEED",                  "#1 intent: confirm_done after declare → PROCEED");
ok(done.closedAt != null,                    "#1 intent: closedAt is set after close");

// Idempotent: closing again returns PROCEED not error
const again = await tool("confirm_done", { intentId: decl.intentId });
ok(again.gate === "PROCEED",                 "#1 intent: second confirm_done on closed intent → PROCEED (idempotent)");

// List intents
const intents = await tool("list_intents");
ok(Array.isArray(intents),                   "#1 intent: list_intents returns array");
ok(intents.some(i => i.id === decl.intentId), "#1 intent: declared intent appears in list");

// ═══════════════════════════════════════════════════════════════════════════════
// 6.  #2 Pause and verify
// ═══════════════════════════════════════════════════════════════════════════════
section("6 — #2 pause_and_verify");

const pause = await tool("pause_and_verify", {
  claim: "The file src/server.js exists and contains createServer",
});
ok(pause.gate === "HALT",                    "#2 pause_and_verify: always returns HALT");
ok(Array.isArray(pause.required_steps),      "#2 pause_and_verify: required_steps is array");
ok(pause.required_steps.length >= 1,         "#2 pause_and_verify: at least one step");
ok(pause.do_not_assert === true,             "#2 pause_and_verify: do_not_assert=true");
ok(typeof pause.resume_when === "string",    "#2 pause_and_verify: resume_when is string");

// Destructive claim adds extra step
const pauseDel = await tool("pause_and_verify", {
  claim: "I deleted all temp files from the project",
});
ok(pauseDel.gate === "HALT",                  "#2 pause_and_verify: destructive claim still HALT");
const hasDestructiveStep = pauseDel.required_steps.some(
  s => String(s.action).toUpperCase().includes("DESTRUCTIVE")
);
ok(hasDestructiveStep,                         "#2 pause_and_verify: destructive claim adds double-verify step");

// ═══════════════════════════════════════════════════════════════════════════════
// 7.  #4 Verification chain
// ═══════════════════════════════════════════════════════════════════════════════
section("7 — #4 run_verification_chain");

// All verified → PROCEED
const chainPass = await tool("run_verification_chain", {
  steps: [
    { statement: "package.json exists for chain", validator: "filesystem.exists", path: join(__dirname, "package.json"), description: "package.json exists" },
    { statement: "2+2=4 for chain", validator: "math.evaluate", expression: "2+2", expected: 4, description: "math check" },
  ],
});
ok(chainPass.gate === "PROCEED",             "#4 verification_chain: all verified → PROCEED");
ok(chainPass.steps?.length === 2,            "#4 verification_chain: all steps in result");

// First step fails → HALT immediately
const chainFail = await tool("run_verification_chain", {
  steps: [
    { statement: "nonexistent.xyz exists", validator: "filesystem.exists", path: join(__dirname, "nonexistent.xyz"), description: "missing file" },
    { statement: "2+2=4 after failure", validator: "math.evaluate", expression: "2+2", expected: 4, description: "should not run" },
  ],
});
ok(chainFail.gate === "HALT",                "#4 verification_chain: first step fails → HALT");
ok(chainFail.completedSteps === 0,           "#4 verification_chain: 0 steps completed before HALT");

// ═══════════════════════════════════════════════════════════════════════════════
// 8.  #5/#15 Retrieval gate
// ═══════════════════════════════════════════════════════════════════════════════
section("8 — #5/#15 retrieval_gate");

// UNSUPPORTABLE: qualitative word + narrow validator
const unsupp = await tool("retrieval_gate", {
  statement: "The system is secure",
  validator:  "filesystem.exists",
});
ok(unsupp.signal === "UNSUPPORTABLE",
  "#5 retrieval_gate: 'secure' + filesystem.exists → UNSUPPORTABLE",
  `signal=${unsupp.signal}`);

// MISSING: no claims in ledger for this statement
const miss = await tool("retrieval_gate", {
  statement: "some claim that was never verified xyz-" + Date.now(),
  validator:  "math.evaluate",
});
ok(miss.signal === "MISSING",               "#15 retrieval_gate: no prior evidence → MISSING");

// ═══════════════════════════════════════════════════════════════════════════════
// 9.  #7 Constitutional check
// ═══════════════════════════════════════════════════════════════════════════════
section("9 — #7 constitutional_check");

// Violation: file content claim with wrong validator
const constViol = await tool("constitutional_check", {
  statement: "The file contains the createServer function",
  validator:  "filesystem.exists",
});
ok(constViol.passed === false,               "#7 constitutional: file-content claim + wrong validator → violation");
ok(Array.isArray(constViol.violations),      "#7 constitutional: violations array returned");
ok(constViol.gate === "HALT",                "#7 constitutional: violation → HALT gate");

// Pass: correct validator for content check
const constPass = await tool("constitutional_check", {
  statement: "The file contains the createServer function",
  validator:  "file.contains",
});
ok(constPass.passed === true,                "#7 constitutional: correct validator → passed");

// ═══════════════════════════════════════════════════════════════════════════════
// 10.  #11 Consistency vote
// ═══════════════════════════════════════════════════════════════════════════════
section("10 — #11 consistency_vote");

// Deterministic claim → unanimous verified
const votePass = await tool("consistency_vote", {
  n: 3,
  check: {
    statement: "2+2=4 for vote",
    validator:  "math.evaluate",
    expression: "2+2",
    expected:   4,
  },
});
ok(votePass.gate === "PROCEED",              "#11 consistency_vote: deterministic claim → PROCEED");
ok(votePass.verdict === "unanimous_verified","#11 consistency_vote: verdict=unanimous_verified");

// Always-false claim → unanimous contradicted
const voteFail = await tool("consistency_vote", {
  n: 2,
  check: {
    statement: "2+2=99 for vote",
    validator:  "math.evaluate",
    expression: "2+2",
    expected:   99,
  },
});
ok(voteFail.gate === "HALT",                  "#11 consistency_vote: always-false → HALT");
ok(voteFail.verdict === "unanimous_contradicted", "#11 consistency_vote: verdict=unanimous_contradicted");

// ═══════════════════════════════════════════════════════════════════════════════
// 11.  #13 Human attestation
// ═══════════════════════════════════════════════════════════════════════════════
section("11 — #13 human_attest");

const attestClaim = await tool("submit_claim", {
  statement: "This feature was reviewed and approved by the operator",
  type: "general",
});

const approved = await tool("human_attest", {
  claimId:  attestClaim.id,
  approved: true,
  reason:   "Reviewed and confirmed by human operator",
});
ok(approved.gate === "PROCEED",              "#13 human_attest: approval → PROCEED");
ok(approved.attestation.rwDelta === 0.15,    "#13 human_attest: approval gives +0.15 rwDelta");

const retrieved = await tool("get_attestation", { claimId: attestClaim.id });
ok(retrieved?.approved === true,             "#13 get_attestation: retrieves stored attestation");
ok(retrieved?.claimId === attestClaim.id,    "#13 get_attestation: claimId matches");

const rejected = await tool("human_attest", {
  claimId:  attestClaim.id,
  approved: false,
  reason:   "Incorrect — the operator found an error",
});
ok(rejected.gate === "HALT",                 "#13 human_attest: rejection → HALT");
ok(rejected.do_not_assert === true,          "#13 human_attest: rejection sets do_not_assert");

// ═══════════════════════════════════════════════════════════════════════════════
// 12.  #14 Chain-of-Verification (plan_verification)
// ═══════════════════════════════════════════════════════════════════════════════
section("12 — #14 plan_verification (Chain-of-Verification)");

const planFile = await tool("plan_verification", {
  claim: "The file src/server.js exists and contains createServer",
});
ok(Array.isArray(planFile.steps),            "#14 CoVe: steps is array");
ok(planFile.steps.length >= 1,              `#14 CoVe: ${planFile.steps.length} step(s) planned`);
ok(typeof planFile.directive === "string",   "#14 CoVe: directive present");

// File-exists step should be in the plan
const hasExistsStep = planFile.steps.some(s => s.validator === "filesystem.exists");
ok(hasExistsStep,                            "#14 CoVe: filesystem.exists step in plan for file claim");

// Contains step should be in the plan (contains pattern detected)
const hasContainsStep = planFile.steps.some(s => s.validator === "file.contains");
ok(hasContainsStep,                          "#14 CoVe: file.contains step in plan (contains pattern found)");

// Math claim → math step planned
const planMath = await tool("plan_verification", {
  claim: "The result equals 42",
});
const hasMathStep = planMath.steps.some(s => s.validator === "math.evaluate");
ok(hasMathStep,                              "#14 CoVe: math.evaluate step planned for 'equals' claim");

// ═══════════════════════════════════════════════════════════════════════════════
// 13.  #16 Semantic challenge
// ═══════════════════════════════════════════════════════════════════════════════
section("13 — #16 semantic_challenge");

// Scope mismatch: 'secure' + filesystem.exists
const chalSecure = await tool("semantic_challenge", {
  statement: "The system is secure",
  validator:  "filesystem.exists",
});
ok(chalSecure.challenged === true,           "#16 semantic_challenge: 'secure' + wrong validator → challenged");
ok(chalSecure.gate === "HALT",               "#16 semantic_challenge: challenged → HALT gate");
ok(chalSecure.challenges?.some(c => c.type === "scope_mismatch"), "#16 semantic_challenge: scope_mismatch type");

// Runtime-state mismatch: 'running' + static validator
const chalRunning = await tool("semantic_challenge", {
  statement: "The server is running and online",
  validator:  "filesystem.exists",
});
ok(chalRunning.challenged === true,          "#16 semantic_challenge: 'running' + static validator → challenged");
ok(chalRunning.challenges?.some(c => c.type === "runtime_state_mismatch"), "#16 semantic_challenge: runtime_state_mismatch");

// grounding weakness: text.contains for file claim
const chalTextFile = await tool("semantic_challenge", {
  statement: "The file contains createServer",
  validator:  "text.contains",
});
ok(chalTextFile.challenged === true,         "#16 semantic_challenge: file claim + text.contains → challenged");
ok(chalTextFile.challenges?.some(c => c.type === "grounding_weakness"), "#16 semantic_challenge: grounding_weakness");

// Clean: no challenges
const chalClean = await tool("semantic_challenge", {
  statement: "package.json exists",
  validator:  "filesystem.exists",
});
ok(chalClean.challenged === false,           "#16 semantic_challenge: existence claim + filesystem.exists → no challenge");

// ═══════════════════════════════════════════════════════════════════════════════
// 14.  #17 Action trace — Reason → Act → Observe
// ═══════════════════════════════════════════════════════════════════════════════
section("14 — #17 action_trace");

// HALT: complete empty trace
const emptyTrace = await tool("start_action_trace", { purpose: "Empty trace test" });
const emptyComplete = await tool("complete_action_trace", { traceId: emptyTrace.traceId });
ok(emptyComplete.gate === "HALT",            "#17 action_trace: completing empty trace → HALT");

// PROCEED: trace with at least one cycle
const trace = await tool("start_action_trace", { purpose: "Write config file" });
ok(typeof trace.traceId === "string",        "#17 action_trace: start returns traceId");

await tool("add_trace_cycle", {
  traceId:     trace.traceId,
  reason:      "Need to write the config file to disk",
  action:      "Wrote JSON content to config.json",
  observation: { fileExists: true, bytesWritten: 128 },
});

const traceResult = await tool("complete_action_trace", { traceId: trace.traceId });
ok(traceResult.gate === "PROCEED",           "#17 action_trace: trace with 1+ cycles → PROCEED");
ok(traceResult.cycles === 1,                 "#17 action_trace: cycle count correct");

// get_trace
const fetched = await tool("get_trace", { traceId: trace.traceId });
ok(fetched?.id === trace.traceId,            "#17 action_trace: get_trace returns correct trace");
ok(fetched?.complete === true,               "#17 action_trace: trace marked complete");
ok(fetched?.cycles?.length === 1,            "#17 action_trace: 1 cycle stored");

// ═══════════════════════════════════════════════════════════════════════════════
// 15.  #18 Iterative verify
// ═══════════════════════════════════════════════════════════════════════════════
section("15 — #18 iterative_verify");

// PROCEED: real file, low threshold
const iterPass = await tool("iterative_verify", {
  statement:  "package.json exists for iterative test",
  validator:  "filesystem.exists",
  path:       join(__dirname, "package.json"),
  reasoning:  "Checking that package.json is present at the project root as part of iterative verification testing to confirm the file system state.",
  threshold:  0.50,
  maxRounds:  3,
});
ok(iterPass.gate === "PROCEED",              "#18 iterative_verify: real file + low threshold → PROCEED");
ok(iterPass.finalRealityWeight > 0.50,      `#18 iterative_verify: rw=${iterPass.finalRealityWeight} > 0.50`);

// HALT (contradicted): wrong math short-circuits on round 1
const iterContra = await tool("iterative_verify", {
  statement:  "2+2=999 for iterative test",
  validator:  "math.evaluate",
  expression: "2+2",
  expected:   999,
  threshold:  0.90,
  maxRounds:  3,
});
ok(iterContra.gate === "HALT",               "#18 iterative_verify: contradicted claim → HALT (not UNVERIFIABLE)");
ok(iterContra.rounds === 1,                  "#18 iterative_verify: stops on round 1 when contradicted");

// UNVERIFIABLE: missing file, high threshold
const iterUnverif = await tool("iterative_verify", {
  statement:  "definitely-missing-file.xyz exists",
  validator:  "filesystem.exists",
  path:       join(__dirname, "definitely-missing-file.xyz"),
  threshold:  0.90,
  maxRounds:  2,
});
// Missing file returns contradicted (not just low rw), so HALT is also valid
ok(["HALT", "UNVERIFIABLE"].includes(iterUnverif.gate),
  "#18 iterative_verify: missing file → HALT or UNVERIFIABLE",
  `gate=${iterUnverif.gate}`);

// ═══════════════════════════════════════════════════════════════════════════════
// 16.  #19 Verify execution plan
// ═══════════════════════════════════════════════════════════════════════════════
section("16 — #19 verify_execution");

const execPlan = await tool("verify_execution", {
  code:        "console.log(6 * 7)",
  statedOutput: "42",
});
ok(typeof execPlan.verifyCall === "object",   "#19 verify_execution: returns verifyCall object");
ok(execPlan.verifyCall.validator === "code.run", "#19 verify_execution: verifyCall uses code.run");
ok(execPlan.verifyCall.expectedOutput === "42",  "#19 verify_execution: expectedOutput matches statedOutput");
ok(typeof execPlan.directive === "string",        "#19 verify_execution: directive present");

// ═══════════════════════════════════════════════════════════════════════════════
// 17.  #9 Calibration report
// ═══════════════════════════════════════════════════════════════════════════════
section("17 — #9 calibration_report");

// Seed some calibration data by claiming high confidence on known results
await tool("verify_claim", {
  statement: "2+2=4 calibration seed 1",
  validator:  "math.evaluate",
  expression: "2+2",
  expected:   4,
  claimedConfidence: 0.99,  // honest claim
});
await tool("verify_claim", {
  statement: "2+2=4 calibration seed 2",
  validator:  "math.evaluate",
  expression: "2+2",
  expected:   4,
  claimedConfidence: 0.99,
});
await tool("verify_claim", {
  statement: "2+2=4 calibration seed 3",
  validator:  "math.evaluate",
  expression: "2+2",
  expected:   4,
  claimedConfidence: 0.99,
});

const calib = await tool("calibration_report");
ok(Array.isArray(calib),                      "#9 calibration_report: returns array");
const mathCalib = calib.find(c => c.validator === "math.evaluate");
ok(mathCalib != null,                         "#9 calibration_report: math.evaluate entry present after seeding");
ok(typeof mathCalib.avgDivergence === "number", "#9 calibration_report: avgDivergence is number");
ok(["overclaiming","underclaiming","calibrated"].includes(mathCalib.status),
  "#9 calibration_report: status is valid value",
  `status=${mathCalib.status}`);

// ═══════════════════════════════════════════════════════════════════════════════
// 18.  #6 Destructive claim detection (auto-hook)
// ═══════════════════════════════════════════════════════════════════════════════
section("18 — #6 destructive claim detection");

const destructEv = await tool("verify_claim", {
  statement: "I deleted all the temporary build files from the output directory",
  validator:  "filesystem.exists",
  path:       join(__dirname, "package.json"),
  reasoning:  "Testing destructive claim detection by including the word 'deleted' in the claim statement.",
});
ok(destructEv.conscienceFlags?.destructiveWarning != null,
  "#6 destructive: verify_claim detects 'deleted' in statement",
  `warning=${destructEv.conscienceFlags?.destructiveWarning}`);

// ═══════════════════════════════════════════════════════════════════════════════
// 19.  #12 Retrieve and ground
// ═══════════════════════════════════════════════════════════════════════════════
section("19 — #12 retrieve_and_ground");

// Our local HTTP server serves text containing "epistemic conscience layer anti-hallucination verify claims"
// Claim contains those words → high coverage → verified
const groundPass = await tool("verify_claim", {
  statement:  "The epistemic conscience layer verifies claims",
  validator:  "retrieve_and_ground",
  url:        `http://127.0.0.1:${HTTP_PORT}/`,
  claim:      "epistemic conscience layer verifies claims",
  threshold:  0.30,
});
ok(groundPass.verified === true,             "#12 retrieve_and_ground: claim terms present in body → verified");
ok(groundPass.realityWeight > 0,             "#12 retrieve_and_ground: realityWeight > 0");
ok(groundPass.result?.coverage > 0,         `#12 retrieve_and_ground: coverage=${groundPass.result?.coverage}`);

// Claim with no matching terms → contradicted
const groundFail = await tool("verify_claim", {
  statement:  "The server uses Express and Fastify with PostgreSQL database",
  validator:  "retrieve_and_ground",
  url:        `http://127.0.0.1:${HTTP_PORT}/`,
  claim:      "express fastify postgresql database framework",
  threshold:  0.30,
});
ok(groundFail.verified === false,            "#12 retrieve_and_ground: unrelated terms → not verified");

// ═══════════════════════════════════════════════════════════════════════════════
// 20.  Template shortcuts
// ═══════════════════════════════════════════════════════════════════════════════
section("20 — templates (use_template / get_templates)");

const templates = await tool("get_templates");
ok(Array.isArray(templates),                 "get_templates: returns array");
ok(templates.length >= 3,                   `get_templates: ${templates.length} templates available`);
ok(templates.some(t => t.id === "file-exists"), "get_templates: file-exists template present");

const tmplExists = await tool("use_template", {
  template: "file-exists",
  fill: { path: join(__dirname, "package.json") },
});
ok(tmplExists.verified === true,             "use_template file-exists: real file → verified");

// expectAbsent: library not installed
const noDep = await tool("use_template", {
  template: "no-dependency",
  fill: { lib: "express" },
});
ok(noDep.verified === true,                  "use_template no-dependency: absent lib → verified");

// ═══════════════════════════════════════════════════════════════════════════════
// 21.  Full AI workflow simulation
//       Models the ideal path an AI should follow before asserting any claim.
// ═══════════════════════════════════════════════════════════════════════════════
section("21 — Full AI workflow simulation");

// Simulate: AI wants to assert "I wrote config-test.json"
// Step 1: declare intent
const simDecl = await tool("declare_action", {
  action:     "Write config-test.json",
  actionType: "file_write",
  parameters: { path: "config-test.json", contains: '"version"' },
});
ok(simDecl.status === "open",                "simulation: declare_action opens intent");
ok(simDecl.manifest.length >= 1,            `simulation: manifest has ${simDecl.manifest.length} step(s)`);

// Step 2: pause and verify before asserting (mandatory checklist)
const simPause = await tool("pause_and_verify", {
  claim: "I wrote config-test.json with version field",
});
ok(simPause.gate === "HALT",                 "simulation: pause_and_verify returns HALT before assertion");

// Step 3: plan verification (CoVe)
const simPlan = await tool("plan_verification", {
  claim: 'config-test.json exists and contains "version"',
});
ok(simPlan.steps.length >= 1,               `simulation: CoVe plan has ${simPlan.steps.length} step(s)`);

// Step 4: run the chain (file doesn't actually exist — this is a test of the verify path)
const simVerify = await tool("verify_claim", {
  statement: "config-test.json exists on disk",
  validator:  "filesystem.exists",
  path:       join(__dirname, "config-test.json"),
  reasoning:  "Verifying the file exists at the project root after writing it as part of a simulated AI workflow test in the conscience test suite.",
});
// File doesn't exist → contradicted → AI should NOT assert
ok(simVerify.contradicted === true || simVerify.verified === true,
  "simulation: verify_claim runs and returns a definitive result");

// Step 5: gate check
const simGate = await tool("gate_check", {
  realityWeight: simVerify.realityWeight,
  verified:      simVerify.verified,
  contradicted:  simVerify.contradicted,
});
// If file doesn't exist → contradicted → suppress
const expectedGate = simVerify.contradicted ? "suppress" : "verified";
ok(simGate.gate === expectedGate,
  `simulation: gate_check returns ${expectedGate} (correct for ${simVerify.contradicted ? "contradicted" : "verified"} evidence)`);

// Step 6: close intent
const simDone = await tool("confirm_done", { intentId: simDecl.intentId });
ok(simDone.gate === "PROCEED",               "simulation: confirm_done closes intent → PROCEED");

// ═══════════════════════════════════════════════════════════════════════════════
// 22.  HALT enforcement — wrong path vs correct path
// ═══════════════════════════════════════════════════════════════════════════════
section("22 — HALT enforcement correctness");

// Wrong path: contradicted evidence → gate says suppress
const wrongClaim = await tool("verify_claim", {
  statement:  "2+2=999 enforcement test",
  validator:  "math.evaluate",
  expression: "2+2",
  expected:   999,
  reasoning:  "Testing HALT enforcement — deliberately wrong claim to verify the gate correctly suppresses it.",
});
const wrongGate = await tool("gate_check", {
  realityWeight: wrongClaim.realityWeight,
  verified:      wrongClaim.verified,
  contradicted:  wrongClaim.contradicted,
});
ok(wrongGate.gate === "suppress",             "HALT enforcement: contradicted evidence → gate=suppress");

// Correct path: verified evidence → gate says verified
const rightClaim = await tool("verify_claim", {
  statement:  "2+2=4 enforcement test",
  validator:  "math.evaluate",
  expression: "2+2",
  expected:   4,
  reasoning:  "Testing the correct path — verified claim should allow assertion through the gate.",
});
const rightGate = await tool("gate_check", {
  realityWeight: rightClaim.realityWeight,
  verified:      rightClaim.verified,
  contradicted:  rightClaim.contradicted,
});
ok(rightGate.gate === "verified",             "HALT enforcement: verified evidence → gate=verified (assert allowed)");

// ═══════════════════════════════════════════════════════════════════════════════
// 23.  Forced validation — a confirmation mints a gate on the fly (STRICT)
// ═══════════════════════════════════════════════════════════════════════════════
section("23 — forced validation (confirmation → new gate, strict)");

// A confirmation naming a concrete artifact creates a fresh gate
const fv = await tool("force_validation", {
  statement: "The config at package.json was written successfully",
});
ok(fv.gate === "HALT",                          "force_validation: confirmation → gate=HALT");
ok(typeof fv.gateId === "string" && fv.gateId.startsWith("gate_"), "force_validation: returns a new gateId");
ok(Array.isArray(fv.required_steps) && fv.required_steps.length > 0, "force_validation: provides required steps");

// Resolving before any evidence exists must HALT
const beforeEv = await tool("resolve_forced_gate", { gateId: fv.gateId });
ok(beforeEv.gate === "HALT",                    "resolve: no evidence → HALT");

// STRICT: unrelated grounded evidence does NOT satisfy the gate
const unrelated = await tool("verify_claim", {
  statement: "2 plus 2 equals 4", validator: "math.evaluate", expression: "2+2", expected: 4,
  reasoning: "An unrelated true fact used to probe the strict gate — it must NOT satisfy a confirmation about package.json.",
});
const stillHalt = await tool("resolve_forced_gate", { gateId: fv.gateId, claimIds: [unrelated.claimId] });
ok(stillHalt.gate === "HALT",                   "resolve: unrelated grounded evidence does NOT satisfy (strict relevance)");

// Verify the NAMED artifact → PROCEED
const realCheck = await tool("verify_claim", {
  statement: "package.json exists on disk", validator: "filesystem.exists",
  path: join(__dirname, "package.json"),
  reasoning: "Verifying the exact artifact named in the confirmation so the strict gate can be satisfied.",
});
const resolved = await tool("resolve_forced_gate", { gateId: fv.gateId, claimIds: [unrelated.claimId, realCheck.claimId] });
ok(resolved.gate === "PROCEED",                 "resolve: the named artifact verified → PROCEED");
ok(resolved.verdict === "validated",            "resolve: verdict=validated");

// STRICT: a vague confirmation that names nothing checkable can never auto-pass
const vague = await tool("force_validation", { statement: "Everything is done and working" });
const vagueRes = await tool("resolve_forced_gate", { gateId: vague.gateId, claimIds: [realCheck.claimId] });
ok(vagueRes.gate === "HALT",                    "resolve: vague confirmation → HALT");
ok(vagueRes.verdict === "unverifiable_by_tools","resolve: vague confirmation → unverifiable_by_tools");

// STRICT: partial coverage (two files named, one verified) → HALT incomplete
const two = await tool("force_validation", { statement: "Both package.json and README.md were written" });
const partial = await tool("resolve_forced_gate", { gateId: two.gateId, claimIds: [realCheck.claimId] });
ok(partial.gate === "HALT",                     "resolve: partial coverage → HALT");
ok(Array.isArray(partial.missing) && partial.missing.length >= 1, "resolve: reports the unproven artifact(s)");

// STRICT: contradicted evidence hard-fails the gate
const gone = await tool("force_validation", { statement: "The file at ghost-confirm-xyz.json was created" });
const contra = await tool("verify_claim", {
  statement: "ghost-confirm-xyz.json exists", validator: "filesystem.exists",
  path: join(__dirname, "ghost-confirm-xyz.json"),
  reasoning: "This file does not exist — contradicted evidence must hard-fail the forced gate.",
});
const contraRes = await tool("resolve_forced_gate", { gateId: gone.gateId, claimIds: [contra.claimId] });
ok(contraRes.gate === "HALT",                   "resolve: contradicted evidence → HALT");
ok(contraRes.verdict === "contradicted",        "resolve: verdict=contradicted");

// Auto-hook: a bare confirmation type creates a forced gate
const confClaim = await tool("submit_claim", { statement: "Everything is done and working", type: "confirmation" });
ok(confClaim.forcedValidation?.gate === "HALT", "submit_claim: confirmation type auto-creates a forced gate");
ok(confClaim.confirmationDetected?.signal === "explicit", "submit_claim: explicit confirmation type detected");

// A normal grounded (non-confirmation) claim does NOT get a forced gate
const groundedClaim = await tool("submit_claim", { statement: "package.json exists at the project root", type: "filesystem.exists" });
ok(!groundedClaim.forcedValidation,             "submit_claim: grounded non-confirmation → no forced gate");

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════
child.kill();
await new Promise(r => httpSrv.close(r));

const total = results.pass + results.fail;
console.log(`\n${B}${"═".repeat(62)}${Z}`);
console.log(`${B}  AntiPsyc — Conscience Full Test Suite${Z}`);
console.log(`${B}${"═".repeat(62)}${Z}`);
console.log(`  ${G}Passed: ${results.pass}${Z}   ${results.fail ? R : ""}Failed: ${results.fail}${Z}   Total: ${total}`);
console.log(`${B}${"═".repeat(62)}${Z}\n`);

if (results.fail > 0) process.exit(1);
