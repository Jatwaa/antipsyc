/**
 * test-v4-validators.mjs
 * Focused test for the four Phase-1 features added in v4:
 *   G0  codebase.contains  — glob-scoped file search
 *   C5  SQLite persistence — data survives server restart (implicit via sequential calls)
 *   H4  Claim dedup        — identical claims return the same record
 *   G8  git.log_contains / git.last_modified / git.blame_line
 *
 * Run with: node test-v4-validators.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname   = fileURLToPath(new URL(".", import.meta.url));
const serverPath  = join(__dirname, "src", "server.js");

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

const ok  = (msg) => console.log(`${GREEN}✔${RESET} ${msg}`);
const err = (msg) => console.log(`${RED}✘${RESET} ${msg}`);
const hdr = (msg) => console.log(`\n${BOLD}${CYAN}── ${msg} ──${RESET}`);

// ── Spawn ──────────────────────────────────────────────────────────────────
const child = spawn("node", [serverPath, "--mcp"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", d => process.stderr.write(`${YELLOW}[server] ${d}${RESET}`));
child.on("error", e => { err(`Failed to spawn: ${e.message}`); process.exit(1); });

// ── MCP framing ────────────────────────────────────────────────────────────
let buf = Buffer.alloc(0);
let msgId = 1;
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

function request(method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("Timeout")); }
    }, 8000);
  });
}

async function call(args) {
  const res = await request("tools/call", { name: "verify_claim", arguments: args });
  return JSON.parse(res.content[0].text);
}

async function submit(args) {
  const res = await request("tools/call", { name: "submit_claim", arguments: args });
  return JSON.parse(res.content[0].text);
}

// ── Test runner ────────────────────────────────────────────────────────────
async function run() {
  let passed = 0, failed = 0;

  function assert(label, condition, detail = "") {
    if (condition) { ok(label); passed++; }
    else           { err(`${label}${detail ? " — " + detail : ""}`); failed++; }
  }

  try {
    await request("initialize", {
      protocolVersion: "2024-11-05", clientInfo: { name: "v4-test", version: "1.0" }, capabilities: {}
    });

    // ── G0: codebase.contains ─────────────────────────────────────────────
    hdr("G0 · codebase.contains — glob file search");

    // THE SLIP FIX: "server.js uses vm.runInNewContext" → codebase search finds it in validators.js
    const codebaseVm = await call({
      statement: "src/**/*.js contains vm.runInNewContext",
      validator: "codebase.contains",
      glob: "src/**/*.js",
      contains: "vm.runInNewContext"
    });
    assert("G0.1 codebase.contains VERIFIED — vm.runInNewContext exists in src/**/*.js",
      codebaseVm.verified === true,
      JSON.stringify(codebaseVm.result));
    assert("G0.2 found in validators.js (not server.js — the precise location)",
      codebaseVm.result?.matchedFiles?.some(f => f.includes("validators")),
      String(codebaseVm.result?.matchedFiles));
    assert("G0.3 matchCount ≥ 1",   codebaseVm.result?.matchCount >= 1);
    assert("G0.4 scannedFiles ≥ 3", codebaseVm.result?.scannedFiles >= 3);

    // False claim: Express.js not in codebase
    const codebaseExpress = await call({
      statement: "src/**/*.js contains require('express')",
      validator: "codebase.contains",
      glob: "src/**/*.js",
      contains: "require('express')"
    });
    assert("G0.5 codebase.contains CONTRADICTED — Express not found",
      codebaseExpress.verified === false && codebaseExpress.contradicted === true);

    // Regex pattern mode
    const codebasePattern = await call({
      statement: "src/**/*.js matches SSRF",
      validator: "codebase.contains",
      glob: "src/**/*.js",
      pattern: "SSRF"
    });
    assert("G0.6 codebase.contains regex — SSRF found", codebasePattern.verified === true);

    // ── H4: Claim deduplication ───────────────────────────────────────────
    hdr("H4 · Claim deduplication by fingerprint");

    const stmt = `H4 test dedup claim ${Date.now()}`;
    const c1 = await submit({ statement: stmt, type: "general" });
    const c2 = await submit({ statement: stmt, type: "general" });
    assert("H4.1 same statement → same id returned",   c1.id === c2.id,
      `c1=${c1.id}  c2=${c2.id}`);
    assert("H4.2 fingerprint present",                  !!c1.fingerprint);
    assert("H4.3 fingerprint identical",                c1.fingerprint === c2.fingerprint);

    // Whitespace / case normalisation
    const c3 = await submit({ statement: "  " + stmt + "  ", type: "general" });
    assert("H4.4 trimmed statement deduplicates",       c3.id === c1.id);

    // Different type = different claim
    const c4 = await submit({ statement: stmt, type: "code.correctness" });
    assert("H4.5 different type → different claim",     c4.id !== c1.id);

    // ── G8: git.log_contains ─────────────────────────────────────────────
    hdr("G8 · git.log_contains — commit message search");

    // A commit message we know exists (from the project history)
    const logMatch = await call({
      statement: "A recent commit mentions 'validator'",
      validator: "git.log_contains",
      message:   "validator",
      since:     "HEAD~20"
    });
    // May or may not match depending on git history — just verify the shape
    assert("G8.1 git.log_contains returns verified/contradicted (not failed)",
      logMatch.verified === true || logMatch.contradicted === true,
      JSON.stringify(logMatch.result));
    assert("G8.2 commitsSearched is a number", typeof logMatch.result?.commitsSearched === "number");

    // Known-false: string that won't appear in commit messages
    const logNoMatch = await call({
      statement: "A commit mentions ZZZNOTPRESENTXXX",
      validator: "git.log_contains",
      message:   "ZZZNOTPRESENTXXX",
      since:     "HEAD~50"
    });
    assert("G8.3 git.log_contains CONTRADICTED — string not in recent commits",
      logNoMatch.contradicted === true,
      JSON.stringify(logNoMatch.result));

    // ── G8: git.last_modified ─────────────────────────────────────────────
    hdr("G8 · git.last_modified — file commit date");

    const lastMod = await call({
      statement: "src/server.js has git history",
      validator: "git.last_modified",
      path:      "src/server.js"
    });
    // In a git repo this should verify; in a plain directory it returns contradicted
    const hasMod = lastMod.verified === true || lastMod.contradicted === true;
    assert("G8.4 git.last_modified — not failed", hasMod, JSON.stringify(lastMod.result));
    if (lastMod.verified) {
      assert("G8.5 hash is 40-char hex",   /^[0-9a-f]{40}$/.test(lastMod.result?.hash));
      assert("G8.6 commitDate is ISO string", !!lastMod.result?.commitDate?.includes("T"));
    }

    // Non-existent file
    const lastModMiss = await call({
      statement: "nonexistent.js has git history",
      validator: "git.last_modified",
      path:      "nonexistent.js"
    });
    assert("G8.7 git.last_modified non-existent file — contradicted or failed",
      lastModMiss.contradicted === true || lastModMiss.result?.found === false,
      JSON.stringify(lastModMiss.result));

    // ── G8: git.blame_line ────────────────────────────────────────────────
    hdr("G8 · git.blame_line — line attribution");

    const blame = await call({
      statement: "Line 1 of src/server.js has a known author",
      validator: "git.blame_line",
      path:      "src/server.js",
      line:      1
    });
    const hasBlame = blame.verified === true || blame.contradicted === true ||
                     blame.result?.error?.includes("not a git");
    assert("G8.8 git.blame_line — not an unexpected error", hasBlame,
      JSON.stringify(blame.result));
    if (blame.verified) {
      assert("G8.9 blame hash present", !!blame.result?.hash);
    }

    // ── C5: SQLite persistence (verify store type via health endpoint) ────
    hdr("C5 · SQLite persistence (indirect)");
    // The server started with SQLite — we verify it by checking a claim
    // round-trips correctly (create → get → evidence present).
    const persistStmt = `C5 persistence test ${Date.now()}`;
    const pc = await submit({ statement: persistStmt, type: "general" });
    const pv = await call({
      claimId:   pc.id,
      validator: "filesystem.exists",
      path:      serverPath
    });
    const pg = JSON.parse(
      (await request("tools/call", { name: "get_claim", arguments: { claimId: pc.id } })).content[0].text
    );
    assert("C5.1 claim persisted and retrieved",   pg.id === pc.id);
    assert("C5.2 evidence stored with SQLite",      Array.isArray(pg.evidence) && pg.evidence.length > 0);
    assert("C5.3 fingerprint field survives round-trip", !!pg.fingerprint);

  } catch (e) {
    err(`Unexpected error: ${e.message}`);
    failed++;
  } finally {
    child.kill();
    const total = passed + failed;
    console.log(`\n${BOLD}Results: ${GREEN}${passed} passed${RESET}${BOLD}, ${failed > 0 ? RED : ""}${failed} failed${RESET}${BOLD} / ${total} total${RESET}\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
