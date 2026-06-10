/**
 * AntiPsyc — Hallucination Test
 *
 * Submits claims an AI might confidently assert about this project
 * that are actually false, then shows how the evidence layer catches them.
 */
import { spawn }         from "node:child_process";
import { readFileSync }  from "node:fs";
import { fileURLToPath } from "node:url";
import { join }          from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(__dirname, "src", "server.js");

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM  = "\x1b[2m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const MAGENTA = "\x1b[35m";

// ── Spawn MCP ──────────────────────────────────────────────────────────────
const child = spawn("node", [serverPath, "--mcp"], { stdio: ["pipe","pipe","pipe"] });
child.stderr.on("data", () => {}); // suppress server startup noise

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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("Timeout")); } }, 6000);
  });
}

async function verifyClaim(args) {
  const res = await rpc("tools/call", { name: "verify_claim", arguments: args });
  return JSON.parse(res.content[0].text);
}

function verdict(ev) {
  if (ev.verified)     return `${GREEN}${BOLD}VERIFIED${R}    confidence ${ev.confidence.toFixed(2)}`;
  if (ev.contradicted) return `${RED}${BOLD}CONTRADICTED${R} confidence ${ev.confidence.toFixed(2)}`;
  return `${YELLOW}${BOLD}PARTIAL${R}`;
}

function printClaim(label, assertion, ev) {
  console.log(`\n${BOLD}${CYAN}Claim:${R} ${label}`);
  console.log(`${DIM}  AI asserts: "${assertion}"${R}`);
  console.log(`  Result:     ${verdict(ev)}`);
  if (ev.result?.error)    console.log(`  ${MAGENTA}Detail:${R} ${ev.result.error}`);
  if (ev.result?.observed !== undefined) {
    console.log(`  ${MAGENTA}Observed:${R} ${JSON.stringify(ev.result.observed)}  |  Expected: ${JSON.stringify(ev.result.expected)}`);
  }
  if (ev.result?.exists !== undefined && !ev.verified) {
    console.log(`  ${MAGENTA}Path:${R} ${ev.result.path}  →  exists: ${ev.result.exists}`);
  }
  if (ev.result?.matched !== undefined) {
    console.log(`  ${MAGENTA}Substring found:${R} ${ev.result.matched}  |  searched for: "${ev.result.contains}"`);
  }
}

// ── Initialize ─────────────────────────────────────────────────────────────
await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "hallucination-test" }, capabilities: {} });

console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════════╗`);
console.log(`║      AntiPsyc — Hallucination Detection Test            ║`);
console.log(`╚══════════════════════════════════════════════════════════════╝${R}`);
console.log(`${DIM}Each claim below is something an AI might assert with confidence.`);
console.log(`The evidence layer tests each one against reality.${R}`);

// Read package.json as text for text.contains tests
const pkgText = readFileSync(join(__dirname, "package.json"), "utf8");

// ── FALSE CLAIMS ───────────────────────────────────────────────────────────
console.log(`\n${BOLD}${RED}━━━ FALSE CLAIMS (expect CONTRADICTED) ━━━${R}`);

// 1. Wrong entry-point filename — AI often guesses "index.js"
const ev1 = await verifyClaim({
  statement:  "The server entry point is src/index.js",
  validator:  "filesystem.exists",
  path:       join(__dirname, "src", "index.js")
});
printClaim(
  "Wrong entry-point filename",
  "The server entry point is src/index.js",
  ev1
);

// 2. node_modules exists — AI assumes npm install was run
const ev2 = await verifyClaim({
  statement:  "A node_modules directory exists (npm packages are installed)",
  validator:  "filesystem.exists",
  path:       join(__dirname, "node_modules")
});
printClaim(
  "Assumes node_modules present",
  "npm packages are installed in node_modules/",
  ev2
);

// 3. Floating-point trap — 0.1 + 0.2 = 0.3 (classic LLM math error)
const ev3 = await verifyClaim({
  statement:  "0.1 + 0.2 equals exactly 0.3",
  validator:  "math.evaluate",
  expression: "0.1 + 0.2",
  expected:   0.3,
  tolerance:  0
});
printClaim(
  "Floating-point trap: 0.1 + 0.2 = 0.3",
  "0.1 + 0.2 equals exactly 0.3 (no tolerance)",
  ev3
);

// 4. Wrong default port — AI might guess 3000 (common Express default)
const ev4 = await verifyClaim({
  statement:  "The default server port is 3000",
  validator:  "text.contains",
  text:       pkgText,
  contains:   "3000"
});
printClaim(
  "Wrong default port",
  "The server defaults to port 3000 (like a typical Express app)",
  ev4
);

// 5. Wrong package name — AI might call it "epistemic-server" or "antipsyc-server"
const ev5 = await verifyClaim({
  statement:  "The npm package is named epistemic-server",
  validator:  "text.contains",
  text:       pkgText,
  contains:   '"name": "epistemic-server"'
});
printClaim(
  "Wrong package name",
  'The npm package name is "epistemic-server"',
  ev5
);

// 6. Wrong version — AI might hallucinate "1.0.0" as the version
const ev6 = await verifyClaim({
  statement:  "The package version is 1.0.0",
  validator:  "text.contains",
  text:       pkgText,
  contains:   '"version": "1.0.0"'
});
printClaim(
  "Wrong version number",
  'The package is at version 1.0.0 (stable release)',
  ev6
);

// 7. Dependencies exist — AI might hallucinate Express/Fastify as a dependency
const ev7 = await verifyClaim({
  statement:  "The project uses Express as a dependency",
  validator:  "text.contains",
  text:       pkgText,
  contains:   '"express"'
});
printClaim(
  "Hallucinated dependency",
  "The project uses Express.js for routing",
  ev7
);

// ── TRUE CLAIMS (contrast) ─────────────────────────────────────────────────
console.log(`\n${BOLD}${GREEN}━━━ TRUE CLAIMS (expect VERIFIED — for contrast) ━━━${R}`);

// 8. Correct entry point
const ev8 = await verifyClaim({
  statement:  "The server entry point is src/server.js",
  validator:  "filesystem.exists",
  path:       serverPath
});
printClaim(
  "Correct entry-point filename",
  "The server entry point is src/server.js",
  ev8
);

// 9. Correct port in source
const ev9 = await verifyClaim({
  statement:  "The default port 8717 is referenced in package.json scripts",
  validator:  "text.contains",
  text:       readFileSync(serverPath, "utf8"),
  contains:   "8717"
});
printClaim(
  "Correct default port (8717)",
  "The server listens on port 8717 by default",
  ev9
);

// 10. Zero dependencies confirmed
const ev10 = await verifyClaim({
  statement:  "The package has no runtime dependencies (zero-dependency project)",
  validator:  "text.contains",
  text:       pkgText,
  contains:   '"dependencies"'
});
// text.contains verified=true means the word IS there — we want it absent.
// Invert the logic: we check that "dependencies" does NOT appear as a key.
// Since text.contains checks for presence, a CONTRADICTED result here means
// the substring was NOT found — which is the proof of zero dependencies.
console.log(`\n${BOLD}${CYAN}Claim:${R} Zero-dependency confirmation`);
console.log(`${DIM}  AI asserts: "There are no runtime dependencies declared"${R}`);
const zeroDeps = !ev10.verified; // contradicted = substring absent = claim is TRUE
console.log(`  Result:     ${zeroDeps ? `${GREEN}${BOLD}CONFIRMED${R}` : `${RED}${BOLD}DEPENDENCY KEY FOUND${R}`} — "dependencies" key ${zeroDeps ? "absent" : "present"} in package.json`);
console.log(`  ${MAGENTA}Logic:${R} text.contains("dependencies") → ${ev10.verified ? "FOUND (has deps)" : "NOT FOUND (zero deps ✓)"}`);

// ── Summary ────────────────────────────────────────────────────────────────
const falseOnes = [ev1, ev2, ev3, ev4, ev5, ev6, ev7];
const trueOnes  = [ev8, ev9];
const caught    = falseOnes.filter(e => e.contradicted).length;

console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════════╗`);
console.log(`║  Summary                                                     ║`);
console.log(`╠══════════════════════════════════════════════════════════════╣`);
console.log(`║  ${RED}False claims caught (contradicted):  ${caught}/7${R}${BOLD}                    ║`);
console.log(`║  ${GREEN}True claims verified:                ${trueOnes.filter(e=>e.verified).length}/2${R}${BOLD}                    ║`);
console.log(`║                                                              ║`);
console.log(`║  Every claim that felt true was tested against reality.      ║`);
console.log(`║  The model cannot promote its own output to fact.            ║`);
console.log(`╚══════════════════════════════════════════════════════════════╝${R}\n`);

child.kill();
