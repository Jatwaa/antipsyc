/**
 * v6 conscious-logic regression tests.
 *
 * These tests cover bypasses that require the MCP to reason about promotion,
 * not merely validator execution.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(__dirname, "src", "server.js");
const nonce = `v6-${Date.now()}`;
const redirectPort = 9866;

const redirectServer = createServer((req, res) => {
  if (req.url === "/redirect-local") {
    res.writeHead(302, { location: "http://127.0.0.1:8717/api/health" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});
await new Promise(resolve => redirectServer.listen(redirectPort, "127.0.0.1", resolve));

const child = spawn("node", [serverPath, "--mcp"], {
  cwd: __dirname,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ANTIPSYC_ALLOWED_ROOTS: __dirname,
    ANTIPSYC_HTTP_ALLOWLIST: "example.com"
  }
});

let buf = Buffer.alloc(0);
let msgId = 1;
const pending = new Map();
const failures = [];

child.stderr.on("data", d => process.stderr.write(`[server] ${d}`));
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
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }
    }, 8000);
  });
}

async function callTool(name, args) {
  const res = await request("tools/call", { name, arguments: args });
  return JSON.parse(res.content[0].text);
}

function ok(condition, message, details = "") {
  if (condition) console.log(`PASS ${message}`);
  else {
    failures.push(`${message}${details ? ` :: ${details}` : ""}`);
    console.error(`FAIL ${message}${details ? ` :: ${details}` : ""}`);
  }
}

try {
  await request("initialize", {});

  const gate = await callTool("gate_check", {
    realityWeight: 0.99,
    verified: false,
    contradicted: true
  });
  ok(gate.gate === "suppress", "MCP gate_check suppresses contradicted high-weight evidence", JSON.stringify(gate));

  const mixed = await callTool("verify_claim", {
    statement: `${nonce} package.json exists and the production database contains no admin users`,
    validator: "filesystem.exists",
    path: join(__dirname, "package.json")
  });
  ok(mixed.verified === false && mixed.status === "irrelevant",
    "structured contract rejects unsupported extra claim clauses",
    JSON.stringify(mixed));

  const absent = await callTool("use_template", {
    template: "no-dependency",
    fill: { lib: `definitely-not-installed-${nonce}` }
  });
  const absentClaim = await callTool("get_claim", { claimId: absent.claimId });
  ok(absent.verified === true && absentClaim.status === "verified",
    "expectAbsent template persists semantic verified status",
    JSON.stringify({ absent, claimStatus: absentClaim.status }));

  const gitProbe = await callTool("verify_claim", {
    statement: `${nonce} outside repo branch exists`,
    validator: "git.branch_exists",
    repo: "C:\\Windows",
    branch: "HEAD"
  });
  ok(gitProbe.status === "blocked" && gitProbe.verified === false,
    "git repo input is constrained by allowed roots",
    JSON.stringify(gitProbe));

  const redirected = await callTool("verify_claim", {
    statement: `${nonce} http://127.0.0.1:${redirectPort}/redirect-local returns 200`,
    validator: "http.fetch",
    url: `http://127.0.0.1:${redirectPort}/redirect-local`,
    expectedStatus: 200
  });
  ok(redirected.verified === false && redirected.contradicted === true,
    "HTTP validator blocks private redirect targets",
    JSON.stringify(redirected));

  if (failures.length) {
    console.error(`\n${failures.length} v6 conscious-logic regression(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll v6 conscious-logic regressions passed.");
  }
} finally {
  child.kill();
  await new Promise(resolve => redirectServer.close(resolve));
}
