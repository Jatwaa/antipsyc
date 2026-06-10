/**
 * AntiPsyc — stdio test harness
 * Spawns the MCP server as a child process and exercises the full protocol.
 * Run with: node test-mcp.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(__dirname, "src", "server.js");

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

const ok  = (msg) => console.log(`${GREEN}✔${RESET} ${msg}`);
const err = (msg) => console.log(`${RED}✘${RESET} ${msg}`);
const hdr = (msg) => console.log(`\n${BOLD}${CYAN}── ${msg} ──${RESET}`);

// ── Spawn MCP child process ────────────────────────────────────────────────
const child = spawn("node", [serverPath, "--mcp"], {
  stdio: ["pipe", "pipe", "pipe"]
});

child.stderr.on("data", (d) => process.stderr.write(`${YELLOW}[server] ${d}${RESET}`));
child.on("error", (e) => { err(`Failed to spawn server: ${e.message}`); process.exit(1); });

// ── MCP framing helpers ────────────────────────────────────────────────────
function send(msg) {
  const body = JSON.stringify(msg);
  const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  child.stdin.write(frame);
}

let buf = Buffer.alloc(0);
let msgId = 1;
const pending = new Map();   // id → { resolve, reject }

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
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("Timeout waiting for response"));
      }
    }, 5000);
  });
}

// ── Test runner ─────────────────────────────────────────────────────────────
async function run() {
  let passed = 0, failed = 0;

  function assert(label, condition, detail = "") {
    if (condition) { ok(label); passed++; }
    else           { err(`${label}${detail ? " — " + detail : ""}`); failed++; }
  }

  try {
    // 1. initialize
    hdr("initialize");
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test-harness", version: "1.0" },
      capabilities: {}
    });
    assert("Server name is antipsyc",        init.serverInfo?.name === "antipsyc");
    assert("Protocol version echoed back",         init.protocolVersion === "2024-11-05");
    assert("Server version present",               /^\d+\.\d+\.\d+$/.test(init.serverInfo?.version || ""));
    console.log(`   serverInfo: ${JSON.stringify(init.serverInfo)}`);

    // 2. tools/list
    hdr("tools/list");
    const { tools } = await request("tools/list");
    const names = tools.map(t => t.name);
    assert("submit_claim tool present",            names.includes("submit_claim"));
    assert("verify_claim tool present",            names.includes("verify_claim"));
    assert("verify_interaction tool present",      names.includes("verify_interaction"));
    assert("search_evidence tool present",         names.includes("search_evidence"));
    assert("get_claim tool present",               names.includes("get_claim"));
    assert("At least 6 tools exposed",             tools.length >= 6);
    assert("Tools carry annotations",              tools.every(t => t.annotations && typeof t.annotations.readOnlyHint === "boolean"));
    console.log(`   Tools: ${names.join(", ")}`);

    // 3. submit_claim
    hdr("tools/call → submit_claim");
    // Use a timestamp suffix so H4 dedup always produces a fresh provisional claim per run
    const uniqueStatement = `MCP test: server.js exists at project root (${Date.now()})`;
    const submitRes = await request("tools/call", {
      name: "submit_claim",
      arguments: {
        statement: uniqueStatement,
        type: "filesystem.exists",
        tags: ["mcp-test"]
      }
    });
    const claim = JSON.parse(submitRes.content[0].text);
    assert("Claim created with id",                !!claim.id);
    assert("Status is provisional",                claim.status === "provisional");
    assert("Source is model",                      claim.source === "model");
    assert("Tag mcp-test present",                 claim.tags?.includes("mcp-test"));
    console.log(`   Claim id: ${claim.id}`);

    // 4. verify_claim (filesystem.exists — should pass)
    hdr("tools/call → verify_claim (filesystem.exists — expect verified)");
    const verifyRes = await request("tools/call", {
      name: "verify_claim",
      arguments: {
        claimId:   claim.id,
        validator: "filesystem.exists",
        path:      serverPath
      }
    });
    const evidence = JSON.parse(verifyRes.content[0].text);
    assert("Evidence has claimId",                 evidence.claimId === claim.id);
    assert("Validator is filesystem.exists",        evidence.validator === "filesystem.exists");
    assert("verified = true (file exists)",         evidence.verified === true);
    assert("contradicted = false",                  evidence.contradicted === false);
    assert("Confidence ≥ 0.9",                     evidence.confidence >= 0.9);
    console.log(`   confidence: ${evidence.confidence}  realityWeight: ${evidence.realityWeight}`);

    // 5. verify_claim (filesystem.exists — should fail)
    hdr("tools/call → verify_claim (filesystem.exists — expect contradicted)");
    const verifyFail = await request("tools/call", {
      name: "verify_claim",
      arguments: {
        statement:  "MCP test: ghost-mcp-test.txt exists",
        validator:  "filesystem.exists",
        path:       join(__dirname, "ghost-mcp-test.txt")
      }
    });
    const evFail = JSON.parse(verifyFail.content[0].text);
    assert("verified = false (file absent)",        evFail.verified === false);
    assert("contradicted = true",                   evFail.contradicted === true);

    // 6. verify_claim (math.evaluate)
    hdr("tools/call → verify_claim (math.evaluate)");
    const mathRes = await request("tools/call", {
      name: "verify_claim",
      arguments: {
        statement:  "MCP test: (3 + 4) * 2 equals 14",
        validator:  "math.evaluate",
        expression: "(3 + 4) * 2",
        expected:   14
      }
    });
    const mathEv = JSON.parse(mathRes.content[0].text);
    assert("Math claim verified",                   mathEv.verified === true);
    assert("observed === 14",                       mathEv.result?.observed === 14);

    // 7. verify_interaction (chain)
    hdr("tools/call → verify_interaction (2-step chain)");
    const chainRes = await request("tools/call", {
      name: "verify_interaction",
      arguments: {
        statement: "MCP test: server + package both exist",
        causalSchema: "filesystem state of two project files",   // required in v5+
        checks: [
          { validator: "filesystem.exists", path: serverPath, role: "primary", source: "filesystem" },
          { validator: "filesystem.exists", path: join(__dirname, "package.json"), role: "secondary", source: "filesystem" }
        ]
      }
    });
    const chainEv = JSON.parse(chainRes.content[0].text);
    assert("Chain verified (both checks passed)",   chainEv.verified === true);
    assert("Confidence = 1.0 (2/2)",               chainEv.confidence === 1);
    assert("Result summary starts '2/2 checks verified'", chainEv.result?.summary?.startsWith("2/2 checks verified"));

    // 8. search_evidence
    // Note: evidence records contain validator, claimId, result etc. — not claim tags.
    // Search by a term guaranteed to appear in the evidence produced above.
    hdr("tools/call → search_evidence");
    const searchRes = await request("tools/call", {
      name: "search_evidence",
      arguments: { query: "filesystem.exists" }
    });
    const rows = JSON.parse(searchRes.content[0].text);
    assert("Evidence search returns array",        Array.isArray(rows));
    assert("At least one filesystem.exists result", rows.length >= 1);
    assert("Results contain expected validator",   rows.some(r => r.validator === "filesystem.exists"));

    // 9. get_claim
    hdr("tools/call → get_claim");
    const getRes = await request("tools/call", {
      name: "get_claim",
      arguments: { claimId: claim.id }
    });
    const full = JSON.parse(getRes.content[0].text);
    assert("get_claim returns correct id",         full.id === claim.id);
    assert("Status updated to verified",           full.status === "verified");
    assert("Evidence array populated",             Array.isArray(full.evidence) && full.evidence.length > 0);

    // 10. SSRF protection
    hdr("tools/call → verify_claim (http.fetch SSRF — expect blocked)");
    const ssrfRes = await request("tools/call", {
      name: "verify_claim",
      arguments: {
        statement:  "MCP test: SSRF attempt to loopback",
        validator:  "http.fetch",
        url:        "http://127.0.0.1:1234"
      }
    });
    const ssrfEv = JSON.parse(ssrfRes.content[0].text);
    assert("SSRF blocked (verified = false)",       ssrfEv.verified === false);
    assert("SSRF blocked (contradicted = true)",    ssrfEv.contradicted === true);
    assert("Error mentions SSRF protection",        ssrfEv.result?.error?.includes("SSRF"));
    console.log(`   Error: ${ssrfEv.result?.error}`);

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
