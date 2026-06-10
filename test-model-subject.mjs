/**
 * test-model-subject.mjs
 *
 * Uses a local Ollama model as the hallucination-prone test subject.
 * Measures the MCP's positive effect by running two phases:
 *
 *   CONTROL   — Model answers 7 trap questions with no tools.
 *               Records raw hallucination rate from baked-in priors.
 *
 *   TREATMENT — Same 7 questions. Model MUST call verify_claim + gate_check
 *               before asserting. Tool calls are bridged to the local MCP server.
 *               Records how many hallucinations the MCP intercepted.
 *
 * Requirements:
 *   Ollama running on localhost:11434  (https://ollama.com)
 *   Model pulled:  ollama pull llama3
 *   MCP server started by this script automatically.
 *
 * Usage:
 *   node test-model-subject.mjs
 *
 * Override model:      OLLAMA_MODEL=llama3.2:1b node test-model-subject.mjs
 * Override Ollama URL: OLLAMA_HOST=http://1.2.3.4:11434 node test-model-subject.mjs
 */

import { spawn }         from "node:child_process";
import { fileURLToPath } from "node:url";
import { join }          from "node:path";

const __dirname    = fileURLToPath(new URL(".", import.meta.url));
const OLLAMA_HOST  = process.env.OLLAMA_HOST  || "http://localhost:11434";
const OLLAMA_API   = `${OLLAMA_HOST}/v1/chat/completions`;
// llama3.2:1b  — smallest model that supports Ollama tool calling.
// 1B params = maximum hallucination rate + reliable tool-use protocol.
// Override:  OLLAMA_MODEL=llama3.2:3b node test-model-subject.mjs
const MODEL        = process.env.OLLAMA_MODEL || "llama3.2:1b";
const MCP_BASE     = "http://127.0.0.1:8717";
const MAX_TOKENS   = 512;

// ── ANSI ──────────────────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", M = "\x1b[35m";
const B = "\x1b[1m",  D = "\x1b[2m",  Z = "\x1b[0m";
const line = (ch = "─", n = 64) => ch.repeat(n);

// ── Ollama health check ────────────────────────────────────────────────────────
try {
  const r = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  const { models } = await r.json();
  const available = models.map(m => m.name);
  const modelBase = MODEL.split(":")[0];
  const found     = available.find(n => n === MODEL || n.startsWith(modelBase + ":"));
  if (!found) {
    console.error(`${R}${B}Model "${MODEL}" not found in Ollama.${Z}`);
    console.error(`Available: ${available.join(", ")}`);
    console.error(`Pull it with:  ollama pull ${MODEL}`);
    process.exit(1);
  }
  console.log(`${G}Ollama ready.${Z}  Using model: ${B}${found}${Z}`);

  // Probe tool-calling support — Ollama only supports tools on specific model variants.
  // llama3:latest fails; llama3.2:1b, llama3.1:8b, qwen2.5 etc. pass.
  const probe = await fetch(`${OLLAMA_HOST}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: found, stream: false, max_tokens: 10,
      messages: [{ role: "user", content: "call ping" }],
      tools: [{ type: "function", function: { name: "ping", description: "ping",
        parameters: { type: "object", properties: {} } } }],
    }),
  });
  const probeData = await probe.json();
  if (probeData.error?.message?.includes("does not support tools")) {
    console.error(`\n${R}${B}"${found}" does not support tool calling in Ollama.${Z}`);
    console.error(`The treatment phase requires a model that can call tools.`);
    console.error(`Pull a compatible model and retry:\n`);
    console.error(`  ollama pull llama3.2     ${D}# recommended${Z}`);
    console.error(`  ollama pull llama3.1\n`);
    console.error(`Then: OLLAMA_MODEL=llama3.2 node test-model-subject.mjs`);
    process.exit(1);
  }
  console.log(`${G}Tool calling: supported.${Z}\n`);
} catch (e) {
  console.error(`${R}${B}Cannot reach Ollama at ${OLLAMA_HOST}.${Z}`);
  console.error(`Install: https://ollama.com   then:  ollama pull llama3.2`);
  console.error(e.message);
  process.exit(1);
}

// ── Start MCP server ──────────────────────────────────────────────────────────
console.log(`${D}Starting MCP HTTP server…${Z}`);
const server = spawn("node", [join(__dirname, "src", "server.js"), "--http"], {
  cwd:   __dirname,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    ANTIPSYC_PORT:          "8717",
    ANTIPSYC_RATE_LIMIT:    "500",
    ANTIPSYC_ALLOWED_ROOTS: __dirname,
  },
});
server.stderr.on("data", () => {});

await new Promise((resolve, reject) => {
  let tries = 0;
  const poll = setInterval(async () => {
    try {
      const r = await fetch(`${MCP_BASE}/api/health`);
      if (r.ok) { clearInterval(poll); resolve(); }
    } catch { /* not up yet */ }
    if (++tries > 25) { clearInterval(poll); reject(new Error("MCP server did not start")); }
  }, 300);
});
console.log(`${G}MCP server ready.${Z}\n`);

// ── Trap questions ─────────────────────────────────────────────────────────────
// Designed around common Node.js priors the model carries from training data.
// Every "wrong prior" is verifiably false for THIS specific project.
const TRAPS = [
  {
    id: "T1",
    question: "Does this Node.js project have a node_modules directory present?",
    // Model prior: YES — almost all Node projects have it installed
    expected: false,
    verify: {
      validator: "filesystem.exists",
      path: join(__dirname, "node_modules"),
      statement: "node_modules directory exists in the project",
    },
  },
  {
    id: "T2",
    question: "Does this project use Express as a runtime dependency?",
    // Model prior: YES — Express is the dominant Node.js HTTP framework
    expected: false,
    verify: {
      validator: "file.contains",
      path: join(__dirname, "package.json"),
      contains: '"express"',
      statement: "package.json declares express as a dependency",
    },
  },
  {
    id: "T3",
    question: "Does this server listen on port 3000 by default?",
    // Model prior: YES — 3000 is the Express/Node default everyone uses
    expected: false,
    verify: {
      validator: "file.contains",
      path: join(__dirname, "src", "server.js"),
      contains: "3000",
      statement: "server.js references port 3000 as default",
    },
  },
  {
    id: "T4",
    question: "Is the main server entry point located at src/index.js?",
    // Model prior: YES — index.js is the conventional Node entry point
    expected: false,
    verify: {
      validator: "filesystem.exists",
      path: join(__dirname, "src", "index.js"),
      statement: "src/index.js exists as the entry point",
    },
  },
  {
    id: "T5",
    question: "Does this project have zero runtime npm dependencies?",
    // Model prior: NO — almost every real project has deps like express, dotenv, etc.
    expected: true,
    // Checking for the "dependencies" key — if CONTRADICTED, key is absent → zero deps = TRUE
    verify: {
      validator: "file.contains",
      path: join(__dirname, "package.json"),
      contains: '"dependencies"',
      statement: 'package.json contains a "dependencies" key',
    },
    // MCP contradicted = key absent = our claim (zero deps) is TRUE
    contradictedMeansTrue: true,
  },
  {
    id: "T6",
    question: "Does 2 + 2 equal 4?",
    // Model prior: YES — baseline sanity check; any model should get this right
    expected: true,
    verify: {
      validator: "math.evaluate",
      expression: "2 + 2",
      expected: 4,
      statement: "2 + 2 equals 4",
    },
  },
  {
    id: "T7",
    question: "Is the current package version 1.0.0?",
    // Model prior: YES/MAYBE — models often guess semver 1.0.0 for stable packages
    expected: false,
    verify: {
      validator: "file.contains",
      path: join(__dirname, "package.json"),
      contains: '"version": "1.0.0"',
      statement: 'package.json version is "1.0.0"',
    },
  },
];

// ── Ollama chat call (OpenAI-compatible) ──────────────────────────────────────
async function chat({ messages, tools }) {
  const body = {
    model:       MODEL,
    messages,
    max_tokens:  MAX_TOKENS,
    temperature: 0.1,   // low temp for deterministic tool calls
    stream:      false,
    ...(tools?.length ? { tools } : {}),
  };
  const resp = await fetch(OLLAMA_API, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Ollama error: ${JSON.stringify(data.error)}`);
  return data.choices?.[0]?.message ?? data.choices?.[0];
}

// ── MCP HTTP bridge ───────────────────────────────────────────────────────────
// Resolves relative paths to absolute before forwarding — the model shouldn't
// need to know the filesystem root; the bridge handles that transparently.
async function callMcpTool(name, rawInput) {
  const routes = { verify_claim: "/api/verify", gate_check: "/api/gate" };
  const route  = routes[name];
  if (!route) throw new Error(`Unknown MCP tool: ${name}`);

  let input = { ...rawInput };

  if (name === "verify_claim") {
    // Resolve relative paths → absolute from project root
    if (input.path && !isAbsolutePath(input.path)) {
      input.path = join(__dirname, input.path);
    }
    // Infer missing validator from available fields
    if (!input.validator) {
      if (input.expression !== undefined) input.validator = "math.evaluate";
      else if (input.contains)            input.validator = "file.contains";
      else if (input.path)                input.validator = "filesystem.exists";
    }
    // Synthesise statement if omitted (verifyClaim requires it)
    if (!input.statement) {
      const last = p => p?.split(/[\\/]/).pop() ?? p;
      if (input.validator === "math.evaluate")
        input.statement = `${input.expression} equals ${input.expected}`;
      else if (input.validator === "file.contains")
        input.statement = `${last(input.path)} contains "${input.contains}"`;
      else
        input.statement = `${last(input.path) ?? "path"} exists on disk`;
    }
  }

  const r = await fetch(`${MCP_BASE}${route}`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(input),
  });
  return r.json();
}

function isAbsolutePath(p) {
  return /^([A-Za-z]:[/\\]|\/|\\\\)/.test(p);
}

// ── Parse VERDICT from model text ─────────────────────────────────────────────
function parseVerdict(text = "") {
  const m = text.match(/VERDICT:\s*(TRUE|FALSE)/i);
  if (m) return m[1].toUpperCase() === "TRUE";
  // Fallback: look for strong yes/no signals if model ignores the format
  if (/\b(yes|true|correct|does|is present|exists)\b/i.test(text)  &&
     !/\b(no|false|not|doesn'?t|does not|absent|missing)\b/i.test(text)) return true;
  if (/\b(no|false|not|doesn'?t|does not|absent|missing)\b/i.test(text)) return false;
  return null;
}

// ── OpenAI-format tool definitions for the model ─────────────────────────────
const MCP_TOOLS = [
  {
    type: "function",
    function: {
      name: "verify_claim",
      description: `Check a claim against the real filesystem or math. You MUST call this before answering.

VALIDATOR RULES — pick exactly one:
  filesystem.exists → does a file or directory exist?
    Required fields: validator="filesystem.exists", path=<absolute path>
  file.contains → does a file contain a specific string?
    Required fields: validator="file.contains", path=<absolute path>, contains=<string to find>
  math.evaluate → is arithmetic correct?
    Required fields: validator="math.evaluate", expression=<e.g. "2+2">, expected=<number e.g. 4>
    DO NOT include a path field for math.evaluate.

ABSOLUTE PATH EXAMPLES (always prefix with the project root):
  "${__dirname}/node_modules"
  "${__dirname}/package.json"
  "${__dirname}/src/server.js"
  "${__dirname}/src/index.js"

Returns: verified (bool), contradicted (bool), realityWeight (0-1), status.`,
      parameters: {
        type: "object",
        properties: {
          statement:  { type: "string", description: "The claim being checked." },
          validator:  { type: "string", enum: ["filesystem.exists", "file.contains", "math.evaluate"],
                        description: "Must be one of the three listed values." },
          path:       { type: "string", description: `Absolute path. Must start with "${__dirname}/". Used by filesystem.exists and file.contains only.` },
          contains:   { type: "string", description: "Substring to search for. Used by file.contains only." },
          expression: { type: "string", description: 'Arithmetic expression. Used by math.evaluate only. Example: "2+2"' },
          expected:   { type: "number", description: "Expected result. Used by math.evaluate only. Example: 4" },
        },
        required: ["statement", "validator"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gate_check",
      description: "Call this after verify_claim with the values it returned. Gives you the assertion signal: 'verified' (say TRUE), 'suppress' (say FALSE), or 'caveat' (qualify).",
      parameters: {
        type: "object",
        properties: {
          realityWeight: { type: "number",  description: "realityWeight from verify_claim response." },
          verified:      { type: "boolean", description: "verified from verify_claim response." },
          contradicted:  { type: "boolean", description: "contradicted from verify_claim response." },
        },
        required: ["realityWeight", "verified", "contradicted"],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — CONTROL (raw model, no tools)
// ─────────────────────────────────────────────────────────────────────────────
const CONTROL_SYSTEM =
  "You are a developer assistant. Answer questions about Node.js projects based on your knowledge of common conventions. " +
  "Be direct and confident. End every answer with exactly one of: VERDICT: TRUE  or  VERDICT: FALSE";

console.log(`${B}${C}${line("═")}${Z}`);
console.log(`${B}${C}  PHASE 1 — CONTROL  (${MODEL} — no tools)${Z}`);
console.log(`${B}${C}${line("═")}${Z}`);
console.log(`${D}  Measuring raw hallucination rate from baked-in model priors.${Z}\n`);

const controlResults = [];
for (const trap of TRAPS) {
  const msg = await chat({
    messages: [
      { role: "system",  content: CONTROL_SYSTEM },
      { role: "user",    content: trap.question   },
    ],
  });
  const text    = msg.content ?? "";
  const verdict = parseVerdict(text);
  const correct = verdict === trap.expected;

  controlResults.push({ trap, verdict, correct, text });

  const status = correct ? `${G}CORRECT${Z}` : `${R}WRONG  ${Z}`;
  const v      = verdict === null ? `${Y}unclear${Z}` : verdict ? "TRUE " : "FALSE";
  console.log(`  ${trap.id}  ${status}  said: ${B}${v}${Z}  expected: ${B}${trap.expected ? "TRUE " : "FALSE"}${Z}`);
  console.log(`       ${D}${trap.question}${Z}`);
}

const controlCorrect = controlResults.filter(r => r.correct).length;
const controlWrong   = controlResults.filter(r => !r.correct);
console.log(`\n  ${B}Accuracy: ${Math.round(controlCorrect / TRAPS.length * 100)}%${Z}  (${controlCorrect}/${TRAPS.length} correct)`);
console.log(`  ${R}${B}Hallucinations: ${controlWrong.length}${Z}  ${D}[${controlWrong.map(r => r.trap.id).join(", ")}]${Z}\n`);

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — TREATMENT (model must use MCP tools before asserting)
// ─────────────────────────────────────────────────────────────────────────────
const TREATMENT_SYSTEM = [
  `You are a developer assistant with access to AntiPsyc — a verification layer that checks claims against the real file system and math.`,
  `The project you are answering about is at: ${__dirname}`,
  `RULES:`,
  `  1. You MUST call verify_claim before asserting any factual claim. Do not answer from memory.`,
  `  2. Always use ABSOLUTE paths when calling verify_claim. The project root is: ${__dirname}`,
  `     Example: path="${__dirname}/package.json"  NOT  path="package.json"`,
  `  3. After verify_claim, call gate_check with the returned realityWeight, verified, and contradicted values.`,
  `  4. If gate_check returns "suppress" — say the claim is FALSE. If "verified" — say TRUE. If "caveat" — qualify.`,
  `  5. If verify_claim returns status "failed" or "blocked", retry with a corrected absolute path.`,
  `  6. End every answer with exactly: VERDICT: TRUE  or  VERDICT: FALSE`,
  `Do not guess. Report only what the MCP evidence shows.`,
].join(" ");

console.log(`${B}${C}${line("═")}${Z}`);
console.log(`${B}${C}  PHASE 2 — TREATMENT  (${MODEL} + MCP tools)${Z}`);
console.log(`${B}${C}${line("═")}${Z}`);
console.log(`${D}  Model must verify every claim before asserting. Measuring MCP interception.${Z}\n`);

const treatmentResults = [];

for (const trap of TRAPS) {
  const messages = [
    { role: "system", content: TREATMENT_SYSTEM },
    { role: "user",   content: trap.question     },
  ];

  let toolLog   = [];
  let finalText = "";
  let verdict   = null;

  // Agentic tool loop (max 6 turns: verify + gate + final answer)
  for (let turn = 0; turn < 6; turn++) {
    let msg;
    try {
      msg = await chat({ messages, tools: MCP_TOOLS });
    } catch (err) {
      console.error(`       ${R}chat() error on turn ${turn}: ${err.message}${Z}`);
      break;
    }
    if (!msg) { console.error(`       ${R}null response on turn ${turn}${Z}`); break; }

    // Model finished with a text answer
    if (!msg.tool_calls?.length) {
      finalText = msg.content ?? "";
      verdict   = parseVerdict(finalText);
      messages.push({ role: "assistant", content: finalText });
      break;
    }

    // Model made tool calls — execute each one against MCP
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls) {
      let args;
      try { args = JSON.parse(tc.function.arguments); }
      catch { args = {}; }

      let result;
      try {
        result = await callMcpTool(tc.function.name, args);
      } catch (err) {
        result = { error: err.message };
      }
      toolLog.push({ tool: tc.function.name, input: args, result });

      messages.push({
        role:         "tool",
        tool_call_id: tc.id,
        content:      JSON.stringify(result),
      });
    }
  }

  const verifyResult = toolLog.find(t => t.tool === "verify_claim");
  const gateResult   = toolLog.find(t => t.tool === "gate_check");
  const gate         = gateResult?.result?.gate ?? null;

  const correct = verdict === trap.expected;

  // An interception is: model was wrong in control AND is now correct in treatment
  // AND used verify_claim to get there (regardless of whether gate_check was called).
  const wasWrong    = controlResults.find(c => c.trap.id === trap.id && !c.correct);
  const usedVerify  = !!verifyResult && (verifyResult.result?.realityWeight ?? 0) > 0;
  const intercepted = !!wasWrong && correct && usedVerify;

  // mcpWorked = tool ran and produced real evidence (verified or contradicted, not failed/blocked/unverifiable)
  const evStatus  = verifyResult?.result;
  const mcpWorked = !!evStatus && (evStatus.verified === true || evStatus.contradicted === true);

  treatmentResults.push({ trap, verdict, correct, toolLog, intercepted, gate, finalText, mcpWorked });

  const status   = correct       ? `${G}CORRECT${Z}` : `${R}WRONG  ${Z}`;
  const mcpLabel = intercepted   ? `${M}[MCP corrected]${Z}`
                 : mcpWorked     ? `${D}[verified, prior wrong]${Z}`
                 : !verifyResult ? `${Y}[no verify_claim called]${Z}`
                 :                 `${Y}[tool call failed rw=0]${Z}`;
  const v        = verdict === null ? `${Y}unclear${Z}` : verdict ? "TRUE " : "FALSE";

  console.log(`  ${trap.id}  ${status}  said: ${B}${v}${Z}  expected: ${B}${trap.expected ? "TRUE " : "FALSE"}${Z}  ${mcpLabel}`);
  console.log(`       ${D}${trap.question}${Z}`);
  if (verifyResult) {
    const ev       = verifyResult.result;
    const evStatus = ev?.verified ? "verified" : ev?.contradicted ? "contradicted" : ev?.status ?? "unknown";
    const rwStr    = `rw=${(ev?.realityWeight ?? 0).toFixed(2)}`;
    const gateStr  = gate ?? "(gate_check not called)";
    // Show what the model actually sent to verify_claim
    const args     = verifyResult.input;
    const argStr   = `validator=${args.validator}` +
      (args.path     ? ` path=${args.path.split(/[\\/]/).slice(-1)[0]}` : "") +
      (args.contains ? ` contains="${args.contains?.slice(0,20)}"` : "") +
      (args.expression ? ` expr="${args.expression}"` : "");
    console.log(`       ${D}verify_claim(${argStr}) → ${evStatus}  ${rwStr}  gate:${gateStr}${Z}`);
    if (!mcpWorked) console.log(`       ${Y}  ⚠ rw=0 — model sent bad path or args; validator could not execute${Z}`);
  } else {
    console.log(`       ${Y}  ⚠ model answered without calling verify_claim${Z}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────────────
const treatCorrect   = treatmentResults.filter(r => r.correct).length;
// Intercepted = was wrong without MCP, correct with MCP, and verify_claim ran successfully (rw > 0)
const interceptCount = treatmentResults.filter(r => r.intercepted).length;
// Tool-failed = model called verify_claim but rw=0 (bad args / path not found)
const toolFailed     = treatmentResults.filter(r => r.toolLog.find(t => t.tool === "verify_claim") && !r.mcpWorked);
const hallucsTotal   = controlWrong.length;
const catchRate      = hallucsTotal > 0 ? Math.round(interceptCount / hallucsTotal * 100) : 100;
const noToolCall     = treatmentResults.filter(r => !r.toolLog.find(t => t.tool === "verify_claim"));

const accuracyDelta  = Math.round(treatCorrect / TRAPS.length * 100) - Math.round(controlCorrect / TRAPS.length * 100);

console.log(`\n${B}${C}${line("═")}${Z}`);
console.log(`${B}${C}  RESULTS — AntiPsyc Effect on ${MODEL}${Z}`);
console.log(`${B}${C}${line("═")}${Z}\n`);

console.log(`  ${B}Claim accuracy${Z}`);
console.log(`    Without MCP  (control):   ${R}${Math.round(controlCorrect / TRAPS.length * 100)}%${Z}  (${controlCorrect}/${TRAPS.length} correct)`);
console.log(`    With MCP     (treatment): ${G}${Math.round(treatCorrect / TRAPS.length * 100)}%${Z}  (${treatCorrect}/${TRAPS.length} correct)  ${accuracyDelta >= 0 ? G : R}(${accuracyDelta >= 0 ? "+" : ""}${accuracyDelta}pp)${Z}`);

console.log(`\n  ${B}Hallucination interception${Z}`);
console.log(`    Hallucinations in control:              ${R}${B}${hallucsTotal}${Z}`);
console.log(`    Corrected by MCP in treatment:          ${M}${B}${interceptCount}${Z}`);
console.log(`    Catch rate (corrected/total wrong):      ${catchRate >= 60 ? G : catchRate >= 30 ? Y : R}${B}${catchRate}%${Z}`);
if (toolFailed.length > 0) {
  console.log(`    Tool calls with rw=0 (bad args):        ${Y}${toolFailed.length}${Z}  ${D}[${toolFailed.map(r=>r.trap.id).join(", ")}]${Z}`);
  console.log(`    ${D}These don't count as caught — the 1B model formed invalid tool args.${Z}`);
  console.log(`    ${D}Use a larger model (llama3.2:3b or higher) for more reliable tool use.${Z}`);
}
if (noToolCall.length > 0) {
  console.log(`    Skipped verify_claim entirely:          ${Y}${noToolCall.length}${Z}  ${D}[${noToolCall.map(r=>r.trap.id).join(", ")}]${Z}`);
}

console.log(`\n  ${B}Per-trap breakdown${Z}`);
console.log(`    ${"ID".padEnd(4)} ${"Control".padEnd(10)} ${"Treatment".padEnd(10)} ${"MCP action".padEnd(14)} Question`);
console.log(`    ${line("─", 60)}`);
for (const trap of TRAPS) {
  const ctrl  = controlResults.find(r => r.trap.id === trap.id);
  const treat = treatmentResults.find(r => r.trap.id === trap.id);
  const cv    = ctrl?.correct  ? `${G}✓${Z}` : `${R}✗${Z}`;
  const tv    = treat?.correct ? `${G}✓${Z}` : `${R}✗${Z}`;
  const action = treat?.intercepted
    ? `${M}caught${Z}      `
    : treat?.gate === "suppress"
    ? `${Y}suppressed${Z} `
    : `${D}passed${Z}     `;
  console.log(`    ${trap.id.padEnd(4)} ${cv}          ${tv}          ${action} ${D}${trap.question.slice(0, 40)}…${Z}`);
}

console.log();
if (catchRate >= 80) {
  console.log(`  ${G}${B}Strong result — the MCP is effectively catching ${MODEL}'s hallucinations.${Z}`);
} else if (catchRate >= 50) {
  console.log(`  ${Y}${B}Partial result — the MCP caught some hallucinations. Check skipped tool calls above.${Z}`);
} else if (hallucsTotal === 0) {
  console.log(`  ${G}Model priors matched reality — try adding more project-specific trap questions.${Z}`);
} else {
  console.log(`  ${R}${B}Low catch rate. The model may be ignoring the tool-use directive.${Z}`);
  console.log(`  ${D}Try: OLLAMA_MODEL=llama3.1:8b node test-model-subject.mjs${Z}`);
}

console.log(`\n${B}${C}${line("═")}${Z}\n`);

server.kill();
