/**
 * v5 adversarial regression tests.
 *
 * Replays the bypasses from docs/adversarial-test-report.md and asserts they
 * no longer promote weak, unrelated, self-supplied, or policy-blocked evidence.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serverPath = join(__dirname, "src", "server.js");
const nonce = `v5-${Date.now()}`;

const child = spawn("node", [serverPath, "--mcp"], {
  cwd: __dirname,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ANTIPSYC_ALLOWED_ROOTS: __dirname
  }
});

let buf = Buffer.alloc(0);
let msgId = 1;
const pending = new Map();
const failures = [];

child.stderr.on("data", d => process.stderr.write(`[server] ${d}`));
child.on("error", e => fail(`server failed to spawn: ${e.message}`));

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
  if (condition) {
    console.log(`PASS ${message}`);
  } else {
    fail(`${message}${details ? ` :: ${details}` : ""}`);
  }
}

function fail(message) {
  failures.push(message);
  console.error(`FAIL ${message}`);
}

try {
  await request("initialize", {});

  const valid = await callTool("verify_claim", {
    statement: `${nonce} package.json file exists`,
    validator: "filesystem.exists",
    path: join(__dirname, "package.json")
  });
  ok(valid.verified === true && valid.status === "verified", "positive control still verifies");

  const unrelated = await callTool("verify_claim", {
    statement: `${nonce} The production database contains no admin users`,
    validator: "math.evaluate",
    type: "math.evaluate",
    expression: "2 + 2",
    expected: 4
  });
  ok(unrelated.verified === false && unrelated.status === "irrelevant",
    "unrelated math cannot verify broad operational claim",
    JSON.stringify(unrelated));

  const selfText = await callTool("verify_claim", {
    statement: `${nonce} The moon is made of cheese`,
    validator: "text.contains",
    type: "text.contains",
    text: "The moon is made of cheese",
    contains: "moon is made of cheese"
  });
  ok(selfText.verified === false && selfText.status === "syntactic",
    "self-supplied text cannot verify real-world claim",
    JSON.stringify(selfText));

  const fsProbe = await callTool("verify_claim", {
    statement: `${nonce} Windows hosts file metadata can be observed`,
    validator: "filesystem.stat",
    path: "C:\\Windows\\System32\\drivers\\etc\\hosts"
  });
  ok(fsProbe.status === "blocked" && fsProbe.verified === false,
    "filesystem validators block paths outside allowed roots",
    JSON.stringify(fsProbe));

  const localhost = await callTool("verify_claim", {
    statement: `${nonce} http://127.0.0.1:8717/api/health is reachable`,
    validator: "http.fetch",
    url: "http://127.0.0.1:8717/api/health",
    expectedStatus: 200
  });
  ok(localhost.verified === false && localhost.contradicted === true,
    "HTTP validator blocks loopback SSRF probes",
    JSON.stringify(localhost));

  const confidence = await callTool("submit_claim", {
    statement: `${nonce} I am almost certainly true without evidence`,
    type: "general",
    confidence: 999999
  });
  ok(confidence.confidence <= 1 && confidence.confidence >= 0,
    "provisional confidence is clamped to 0..1",
    JSON.stringify(confidence));

  const chain = await callTool("verify_interaction", {
    statement: `${nonce} A physical robot moved 3 meters`,
    checks: [
      { validator: "math.evaluate", expression: "1 + 1", expected: 2 },
      { validator: "text.contains", text: "robot moved 3 meters", contains: "robot moved" }
    ]
  });
  ok(chain.verified === false && ["unverifiable", "irrelevant"].includes(chain.status),
    "interaction chain without causal schema cannot verify physical event",
    JSON.stringify(chain));

  if (failures.length) {
    console.error(`\n${failures.length} v5 adversarial regression(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll v5 adversarial regressions passed.");
  }
} finally {
  child.kill();
}
