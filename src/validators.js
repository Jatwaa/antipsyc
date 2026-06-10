import { access, stat, readFile, readdir } from "node:fs/promises";
import { constants }              from "node:fs";
import { execFile }               from "node:child_process";
import { promisify }              from "node:util";
import { lookup as dnsLookup }    from "node:dns/promises";
import { join as pathJoin }       from "node:path";
import vm                         from "node:vm";
import { validateBaseDir, validateLocalPath } from "./contracts.js";

const execFileAsync = promisify(execFile);

// ── Validator catalog ──────────────────────────────────────────────────────
const validatorCatalog = {
  // Filesystem
  "filesystem.exists":  { description: "Confirms a local path exists.",                            required: ["path"] },
  "filesystem.stat":    { description: "Captures local file or directory metadata.",                required: ["path"] },
  // File content (C1: validator reads the file — AI does not supply the text)
  "file.contains":      { description: "Reads a file and checks for a substring.",                  required: ["path", "contains"] },
  "file.matches":       { description: "Reads a file and checks a regex pattern.",                  required: ["path", "pattern"] },
  // Math
  "math.evaluate":      { description: "Evaluates deterministic arithmetic expressions.",           required: ["expression", "expected"] },
  // HTTP (H5: hardened with timeout, redirect limit, DNS SSRF)
  "http.fetch":         { description: "Fetches an HTTP endpoint and compares the status code.",    required: ["url"] },
  // Text (AI-supplied — realityWeight capped; kept for backward compat)
  "text.contains":      { description: "Checks whether AI-supplied text contains a substring. Use file.contains for grounded checks.", required: ["text", "contains"] },
  // Code execution (C2)
  "code.run":           { description: "Runs JavaScript in a vm sandbox and asserts on console output.", required: ["code"] },
  // Process (H3: allowlist-gated)
  "process.run":        { description: "Runs an allowlisted shell command and asserts on exit code.", required: ["command"] },
  // Git (H1)
  "git.file_exists":    { description: "Confirms a file exists at a git ref.",                     required: ["path"] },
  "git.contains":       { description: "Reads a file at a git ref and checks for a substring.",    required: ["path", "contains"] },
  "git.branch_exists":  { description: "Confirms a git branch exists.",                            required: ["branch"] },
  // JSON / Structure (H2)
  "json.valid":         { description: "Reads a file and confirms it parses as valid JSON.",        required: ["path"] },
  "json.path":          { description: "Reads a JSON file and asserts a dot-notation key value.",   required: ["path", "keyPath"] },
  // Interaction chain
  "interaction.chain":  { description: "Bundles multiple checks into one causal evidence record.", required: ["checks"] },
  // G0: Codebase-scoped search
  "codebase.contains":  { description: "Searches all files matching a glob pattern for a substring or regex.",  required: ["glob"] },
  // G8: Git history
  "git.log_contains":   { description: "Checks whether recent commit messages contain a given string.",         required: ["message"] },
  "git.last_modified":  { description: "Returns when a file was last committed in git history.",                required: ["path"] },
  "git.blame_line":     { description: "Returns which commit last touched a specific line number in a file.",   required: ["path", "line"] },
  // #12: Retrieve and ground
  "retrieve_and_ground": { description: "Fetches a URL and checks whether key claim terms appear in the response body.", required: ["url", "claim"] },
};

export function listValidators() {
  return validatorCatalog;
}

// ── C4: Validator-type enforcement ─────────────────────────────────────────
// Maps explicit claim types to their permitted validators.
// Claim types that equal the validator name (self-declaring) are always allowed.
// Type "general" or null/undefined allows any validator.
const PERMITTED_VALIDATORS = {
  "filesystem.exists":   ["filesystem.exists"],
  "filesystem.stat":     ["filesystem.stat"],
  "filesystem.content":  ["file.contains", "file.matches"],
  "math.assertion":      ["math.evaluate"],
  "http.reachability":   ["http.fetch"],
  "http.response":       ["http.fetch"],
  "code.correctness":    ["code.run"],
  "process.assertion":   ["process.run"],
  "text.assertion":      ["text.contains"],
  "git.file":            ["git.file_exists", "git.contains"],
  "git.branch":          ["git.branch_exists"],
  "json.structure":      ["json.valid", "json.path"],
  "interaction.chain":   ["interaction.chain"],
  "codebase.search":     ["codebase.contains"],
  "git.history":         ["git.log_contains", "git.last_modified", "git.blame_line"],
  "retrieve.grounding":  ["retrieve_and_ground"],
};

export function checkValidatorPermitted(claimType, validator) {
  if (!claimType || claimType === "general") return true;
  if (claimType === validator) return true;               // self-declaring
  const permitted = PERMITTED_VALIDATORS[claimType];
  if (!permitted) return false;                            // v5: unknown type — fail closed
  return permitted.includes(validator);
}

// ── C3: Per-validator TTL (seconds). null = no expiry (deterministic). ─────
export const VALIDATOR_TTL_SECONDS = {
  "filesystem.exists":  15 * 60,
  "filesystem.stat":    15 * 60,
  "file.contains":      30 * 60,
  "file.matches":       30 * 60,
  "math.evaluate":      null,
  "text.contains":      null,
  "http.fetch":          5 * 60,
  "code.run":           60 * 60,
  "process.run":        30 * 60,
  "git.file_exists":    15 * 60,
  "git.contains":       30 * 60,
  "git.branch_exists":  10 * 60,
  "json.valid":         30 * 60,
  "json.path":          30 * 60,
  "interaction.chain":  10 * 60,
  "codebase.contains":  30 * 60,
  "git.log_contains":   10 * 60,
  "git.last_modified":     60 * 60,
  "git.blame_line":        60 * 60,
  "retrieve_and_ground":    5 * 60,
};

// ── Dispatcher ─────────────────────────────────────────────────────────────
export async function verifyWithValidator(input) {
  const validator = input.validator || input.type;
  switch (validator) {
    case "filesystem.exists":  return filesystemExists(input);
    case "filesystem.stat":    return filesystemStat(input);
    case "file.contains":      return fileContains(input);
    case "file.matches":       return fileMatches(input);
    case "math.evaluate":      return mathEvaluate(input);
    case "http.fetch":         return httpFetch(input);
    case "text.contains":      return textContains(input);
    case "code.run":           return codeRun(input);
    case "process.run":        return processRun(input);
    case "git.file_exists":    return gitFileExists(input);
    case "git.contains":       return gitContains(input);
    case "git.branch_exists":  return gitBranchExists(input);
    case "json.valid":         return jsonValid(input);
    case "json.path":          return jsonPath(input);
    case "codebase.contains":  return codebaseContains(input);
    case "git.log_contains":   return gitLogContains(input);
    case "git.last_modified":  return gitLastModified(input);
    case "git.blame_line":       return gitBlameLine(input);
    case "retrieve_and_ground":  return retrieveAndGround(input);
    default:
      return unverifiable(validator, { error: `Unknown validator: ${validator}` });
  }
}

// v2 + v3: parallel interaction chain
export async function verifyInteraction(input) {
  const checks = Array.isArray(input.checks) ? input.checks : [];
  const schema = input.causalSchema || input.schema || null;
  if (!schema) {
    return {
      validator: "interaction.chain",
      verified: false,
      contradicted: false,
      status: "unverifiable",
      confidence: 0,
      realityWeight: 0.05,
      result: {
        error: "interaction.chain requires causalSchema in v5.",
        required: {
          causalSchema: "Name the physical/digital causal model being verified.",
          checks: "Every check must include role and source fields."
        }
      }
    };
  }
  const missingCausalMetadata = checks.some(check => !check.role || !check.source);
  if (missingCausalMetadata) {
    return {
      validator: "interaction.chain",
      verified: false,
      contradicted: false,
      status: "irrelevant",
      confidence: 0,
      realityWeight: 0.05,
      result: {
        causalSchema: schema,
        error: "Every interaction check must include causal role and evidence source.",
        checksReceived: checks.length
      }
    };
  }
  const results = await Promise.all(checks.map(verifyWithValidator));
  const verifiedCount    = results.filter(r => r.verified).length;
  const contradictedCount = results.filter(r => r.contradicted).length;
  const promotableCount = results.filter(r => !["syntactic", "simulated", "irrelevant", "blocked", "failed", "unverifiable"].includes(r.status || "")).length;
  const confidence = checks.length ? verifiedCount / checks.length : 0;
  return {
    validator: "interaction.chain",
    verified:     checks.length > 0 && verifiedCount === checks.length && promotableCount === checks.length,
    contradicted: contradictedCount > 0,
    confidence,
    realityWeight: promotableCount === checks.length ? Math.min(0.9, 0.35 + confidence * 0.5) : 0.25,
    status: promotableCount === checks.length ? undefined : "partial",
    result: {
      causalSchema: schema,
      summary: `${verifiedCount}/${checks.length} checks verified; ${promotableCount}/${checks.length} promotable`,
      checks: results
    }
  };
}

// ── Filesystem validators ──────────────────────────────────────────────────
async function filesystemExists(input) {
  const policy = validateLocalPath(input.path, "filesystem.exists");
  if (!policy.ok) return blocked("filesystem.exists", policy);
  try {
    await access(policy.path, constants.F_OK);
    return accepted("filesystem.exists", 0.96, { path: policy.path, exists: true });
  } catch (error) {
    return contradicted("filesystem.exists", 0.93, { path: policy.path, exists: false, error: error.code });
  }
}

async function filesystemStat(input) {
  const policy = validateLocalPath(input.path, "filesystem.stat");
  if (!policy.ok) return blocked("filesystem.stat", policy);
  try {
    const info = await stat(policy.path);
    return accepted("filesystem.stat", 0.97, {
      path: policy.path, exists: true, size: info.size,
      isFile: info.isFile(), isDirectory: info.isDirectory(),
      modifiedAt: info.mtime.toISOString()
    });
  } catch (error) {
    return contradicted("filesystem.stat", 0.93, { path: policy.path, exists: false, error: error.code });
  }
}

// ── C1: File-reading validators (AI cannot supply the text) ────────────────
async function fileContains(input) {
  if (!input.path)     return failed("file.contains", { error: "path is required" });
  if (!input.contains) return failed("file.contains", { error: "contains is required" });
  const policy = validateLocalPath(input.path, "file.contains");
  if (!policy.ok) return blocked("file.contains", policy);
  try {
    const text     = await readFile(policy.path, "utf8");
    const verified = text.includes(input.contains);
    return {
      validator: "file.contains", verified, contradicted: !verified,
      confidence: 0.95, realityWeight: 0.90,
      result: { path: policy.path, contains: input.contains, matched: verified, fileSize: text.length }
    };
  } catch (error) {
    return failed("file.contains", { path: policy.path, error: error.message });
  }
}

async function fileMatches(input) {
  if (!input.path)    return failed("file.matches", { error: "path is required" });
  if (!input.pattern) return failed("file.matches", { error: "pattern is required" });
  const policy = validateLocalPath(input.path, "file.matches");
  if (!policy.ok) return blocked("file.matches", policy);
  try {
    const text = await readFile(policy.path, "utf8");
    let regex;
    try { regex = new RegExp(input.pattern, input.flags || ""); }
    catch (e) { return failed("file.matches", { error: `Invalid regex: ${e.message}` }); }
    // Reject patterns that trivially match everything (including the empty string)
    if (regex.test("")) {
      return failed("file.matches", { error: "Pattern trivially matches every string — use a more specific pattern." });
    }
    let verified;
    try {
      // Run inside a vm sandbox so a timeout kills catastrophic backtracking (ReDoS guard)
      verified = vm.runInNewContext("re.test(text)", { re: regex, text }, { timeout: 500 });
    } catch {
      return failed("file.matches", { path: policy.path, error: "Pattern execution timed out (possible ReDoS)." });
    }
    return {
      validator: "file.matches", verified, contradicted: !verified,
      confidence: 0.95, realityWeight: 0.90,
      result: { path: policy.path, pattern: input.pattern, matched: verified, fileSize: text.length }
    };
  } catch (error) {
    return failed("file.matches", { path: policy.path, error: error.message });
  }
}

// ── Math validator (v2: vm.runInNewContext) ────────────────────────────────
function mathEvaluate(input) {
  const expression = String(input.expression || "");
  if (!/^[\d\s().+\-*/%^]+$/.test(expression)) {
    return contradicted("math.evaluate", 0.85, { expression, error: "Expression contains unsupported characters." });
  }
  const normalized = expression.replaceAll("^", "**");
  try {
    const observed = vm.runInNewContext(normalized, Object.create(null), { timeout: 100 });
    if (typeof observed !== "number" || !Number.isFinite(observed)) {
      return contradicted("math.evaluate", 0.85, { expression, error: "Expression did not produce a finite number." });
    }
    const expected  = Number(input.expected);
    // Tolerance must be in [0, 1]; values above 1 make claims trivially verifiable
    const rawTol   = Number(input.tolerance ?? 0);
    if (!Number.isFinite(rawTol) || rawTol < 0 || rawTol > 1) {
      return contradicted("math.evaluate", 0.85, { expression, error: "tolerance must be a finite number in [0, 1]." });
    }
    const tolerance = rawTol;
    const verified  = Math.abs(observed - expected) <= tolerance;
    return {
      validator: "math.evaluate", verified, contradicted: !verified,
      confidence: 0.99, realityWeight: 0.88,
      result: { expression, observed, expected, tolerance }
    };
  } catch (error) {
    return contradicted("math.evaluate", 0.80, { expression, error: error.message });
  }
}

// ── H5: Hardened HTTP fetch (timeout, redirect limit, DNS SSRF) ────────────
async function httpFetch(input) {
  const initialUrl = normalizeHttpUrl(input.url);
  if (!initialUrl.ok) return failed("http.fetch", { url: input.url, error: initialUrl.error });

  const ssrf = detectPrivateHost(initialUrl.url);
  if (ssrf) {
    return contradicted("http.fetch", 0.99, {
      url: initialUrl.url,
      error: `SSRF protection: request to private/reserved address blocked (${ssrf}).`
    });
  }

  // DNS-resolution SSRF check (closes DNS-rebinding gap from v2)
  const dnsBlock = await detectPrivateViaDNS(initialUrl.url);
  if (dnsBlock) {
    return contradicted("http.fetch", 0.99, {
      url: initialUrl.url,
      error: `SSRF protection: resolved IP is private/reserved (${dnsBlock}).`
    });
  }

  const timeoutMs  = Number(process.env.ANTIPSYC_HTTP_TIMEOUT_MS || 5000);
  const maxRedirects = Number(process.env.ANTIPSYC_HTTP_MAX_REDIRECTS || 3);
  const redirectChain = [];
  let currentUrl = initialUrl.url;

  try {
    let response;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const policy = await validateOutboundUrl(currentUrl);
      if (!policy.ok) {
        return contradicted("http.fetch", 0.99, {
          url: currentUrl,
          redirectChain,
          error: policy.error
        });
      }
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetch(currentUrl, {
          method:   input.method || "GET",
          redirect: "manual",
          signal:   controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, currentUrl).toString();
      redirectChain.push({ from: currentUrl, to: nextUrl, status: response.status });
      if (redirectChain.length > maxRedirects) {
        return failed("http.fetch", { url: initialUrl.url, error: `Redirect limit exceeded (${maxRedirects})`, redirectChain });
      }
      currentUrl = nextUrl;
    }
    const expectedStatus = Number(input.expectedStatus || 200);
    const verified = response.status === expectedStatus;
    return {
      validator: "http.fetch", verified, contradicted: !verified,
      confidence: 0.82, realityWeight: 0.62,
      result: {
        url: currentUrl, initialUrl: initialUrl.url, method: input.method || "GET",
        status: response.status, expectedStatus,
        contentType: response.headers.get("content-type"),
        redirectChain
      }
    };
  } catch (error) {
    const isTimeout = error.name === "AbortError";
    return failed("http.fetch", {
      url: currentUrl,
      error: isTimeout ? `Request timed out after ${timeoutMs}ms` : error.message
    });
  }
}

// ── Text (AI-supplied — backward compat, capped realityWeight) ─────────────
function textContains(input) {
  const text     = String(input.text || "");
  const contains = String(input.contains || "");
  const verified = text.includes(contains);
  return {
    validator: "text.contains", verified, contradicted: !verified,
    confidence: 0.90,
    // Cap at 0.55 (single model assertion) — text is AI-supplied
    realityWeight: 0.55,
    result: { contains, observedLength: text.length, matched: verified }
  };
}

// ── C2: Code execution (JS via vm) ─────────────────────────────────────────
// F7: no host-realm objects are injected into the context. The fresh context
// has its own intrinsics (Math, JSON, Object…), and console.log is defined
// INSIDE the context, so no host object crosses the boundary for a
// constructor-chain escape. Note: vm is still not a hard security boundary —
// which is why this evidence class is capped as "simulated" (rw ≤ 0.7).
function codeRun(input) {
  const code    = String(input.code || "");
  const timeout = Math.min(Number(input.timeout || 3000), 10000);
  try {
    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: true, wasm: false }
    });
    vm.runInContext(
      `"use strict";
       globalThis.__logs = [];
       globalThis.console = { log: (...a) => { __logs.push(a.map(String).join(" ")); } };`,
      context, { timeout: 200 }
    );
    vm.runInContext(code, context, { timeout });
    const observed = String(vm.runInContext(`__logs.join("\\n")`, context, { timeout: 200 }));
    const expected = input.expectedOutput !== undefined ? String(input.expectedOutput) : null;
    const verified = expected === null || observed.trim() === expected.trim();
    return {
      validator: "code.run", verified, contradicted: !verified && expected !== null,
      confidence: 0.95, realityWeight: 0.85,
      result: { language: "javascript", observed, expected }
    };
  } catch (error) {
    return failed("code.run", {
      language: "javascript",
      error: error.message,
      code: code.slice(0, 120)
    });
  }
}

// ── H3: Process/command execution (allowlist-gated) ───────────────────────
async function processRun(input) {
  const rawAllowlist = process.env.ANTIPSYC_ALLOWED_COMMANDS || "";
  const allowlist    = rawAllowlist.split(",").map(s => s.trim()).filter(Boolean);
  const structured = normalizeProcessCommand(input);
  const command      = structured.command;

  if (!allowlist.length) {
    return {
      validator: "process.run", verified: false, contradicted: false,
      status: "failed", confidence: 0, realityWeight: 0,
      result: { error: "process.run is disabled. Set ANTIPSYC_ALLOWED_COMMANDS to enable.", command }
    };
  }

  const permitted = allowlist.some(a => command === a || structured.bin === a);
  if (!permitted) {
    return {
      validator: "process.run", verified: false, contradicted: false,
      status: "failed", confidence: 0, realityWeight: 0,
      result: { error: `Command not in allowlist: "${command}"`, allowlist }
    };
  }

  const { bin, args } = structured;

  // Guard: reject args containing shell metacharacters or exceeding max length
  const SHELL_META = /[&;|$`<>(){}[\]!\\'"]/;
  const MAX_ARG_LEN = 512;
  for (const arg of args) {
    if (arg.length > MAX_ARG_LEN) {
      return failed("process.run", { command, error: `Argument exceeds max length (${MAX_ARG_LEN}): ${arg.slice(0, 50)}…` });
    }
    if (SHELL_META.test(arg)) {
      return failed("process.run", { command, error: `Argument contains shell metacharacter: ${arg.slice(0, 50)}` });
    }
  }

  const expectedExit   = Number(input.expectedExitCode ?? 0);

  const cwdPolicy = validateLocalPath(input.cwd || process.cwd(), "process.run");
  if (!cwdPolicy.ok) return blocked("process.run", cwdPolicy);

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: Number(input.timeout || 10000),
      cwd:     cwdPolicy.path
    });
    const exitCode = 0; // execFileAsync resolves on exit 0
    const observed = stdout.trim();
    const verified = exitCode === expectedExit &&
      (!input.expectedOutput || observed.includes(input.expectedOutput));
    return {
      validator: "process.run", verified, contradicted: !verified,
      confidence: 0.93, realityWeight: 0.80,
      result: { command, exitCode, expectedExit, observed, stderr: stderr.trim() }
    };
  } catch (error) {
    const exitCode = error.code ?? 1;
    const verified = exitCode === expectedExit;
    if (!verified) {
      return failed("process.run", { command, exitCode, error: error.message });
    }
    return accepted("process.run", 0.93, { command, exitCode, expectedExit });
  }
}

// ── H1: Git validators ─────────────────────────────────────────────────────
async function gitFileExists(input) {
  const ref  = input.ref || "HEAD";
  const path = input.path;
  const repoPolicy = validateRepo(input.repo);
  if (!repoPolicy.ok) return blocked("git.file_exists", repoPolicy);
  try {
    await execFileAsync("git", ["cat-file", "-e", `${ref}:${path}`], {
      cwd: repoPolicy.path, timeout: 5000
    });
    return accepted("git.file_exists", 0.97, { path, ref, exists: true });
  } catch {
    return contradicted("git.file_exists", 0.95, { path, ref, exists: false });
  }
}

async function gitContains(input) {
  const ref  = input.ref || "HEAD";
  const path = input.path;
  const repoPolicy = validateRepo(input.repo);
  if (!repoPolicy.ok) return blocked("git.contains", repoPolicy);
  try {
    const { stdout } = await execFileAsync("git", ["show", `${ref}:${path}`], {
      cwd: repoPolicy.path, timeout: 5000
    });
    const verified = stdout.includes(input.contains);
    return {
      validator: "git.contains", verified, contradicted: !verified,
      confidence: 0.95, realityWeight: 0.90,
      result: { path, ref, contains: input.contains, matched: verified }
    };
  } catch (error) {
    return failed("git.contains", { path, ref, error: error.message });
  }
}

async function gitBranchExists(input) {
  const repoPolicy = validateRepo(input.repo);
  if (!repoPolicy.ok) return blocked("git.branch_exists", repoPolicy);
  try {
    await execFileAsync("git", ["rev-parse", "--verify", input.branch], {
      cwd: repoPolicy.path, timeout: 5000
    });
    return accepted("git.branch_exists", 0.97, { branch: input.branch, exists: true });
  } catch {
    return contradicted("git.branch_exists", 0.95, { branch: input.branch, exists: false });
  }
}

// ── H2: JSON/structure validators ──────────────────────────────────────────
async function jsonValid(input) {
  const policy = validateLocalPath(input.path, "json.valid");
  if (!policy.ok) return blocked("json.valid", policy);
  try {
    const text = await readFile(policy.path, "utf8");
    JSON.parse(text);
    return accepted("json.valid", 0.97, { path: policy.path, valid: true });
  } catch (error) {
    const isParseError = error instanceof SyntaxError;
    if (isParseError) return contradicted("json.valid", 0.97, { path: policy.path, valid: false, error: error.message });
    return failed("json.valid", { path: policy.path, error: error.message });
  }
}

async function jsonPath(input) {
  const policy = validateLocalPath(input.path, "json.path");
  if (!policy.ok) return blocked("json.path", policy);
  try {
    const text = await readFile(policy.path, "utf8");
    const obj  = JSON.parse(text);
    const observed = getByDotPath(obj, input.keyPath);
    if (observed === undefined) {
      return contradicted("json.path", 0.95, {
        path: policy.path, keyPath: input.keyPath, found: false, expected: input.expected
      });
    }
    const expected = input.expected;
    const verified = expected === undefined
      ? true
      : String(observed) === String(expected) || observed === expected;
    return {
      validator: "json.path", verified, contradicted: !verified,
      confidence: 0.95, realityWeight: 0.90,
      result: { path: policy.path, keyPath: input.keyPath, observed, expected, found: true }
    };
  } catch (error) {
    return failed("json.path", { path: policy.path, keyPath: input.keyPath, error: error.message });
  }
}

// ── G0: Codebase-scoped search (glob across files) ────────────────────────

// Convert a glob pattern string to a RegExp.
// Handles: ** (any segments), * (within segment), ? (single char within segment).
function globToRegex(pattern) {
  const norm = pattern.replace(/\\/g, "/");
  let re = "";
  let i  = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (norm[i] === "/") i++;        // consume trailing slash after **
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".cache", "build", "out", "coverage", ".next", ".nuxt"]);

async function findFilesMatchingGlob(baseDir, pattern) {
  const regex   = globToRegex(pattern);
  const results = [];

  async function walk(dir, relDir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(pathJoin(dir, name), relDir ? `${relDir}/${name}` : name);
      } else if (entry.isFile()) {
        const rel = relDir ? `${relDir}/${name}` : name;
        if (regex.test(rel)) results.push(pathJoin(dir, name));
      }
    }
  }

  await walk(baseDir, "");
  return results;
}

async function codebaseContains(input) {
  if (!input.glob)                      return failed("codebase.contains", { error: "glob is required" });
  if (!input.contains && !input.pattern) return failed("codebase.contains", { error: "contains or pattern is required" });

  const basePolicy = validateBaseDir(input.baseDir || process.cwd());
  if (!basePolicy.ok) return blocked("codebase.contains", basePolicy);
  const baseDir = basePolicy.path;
  let files;
  try { files = await findFilesMatchingGlob(baseDir, input.glob); }
  catch (error) { return failed("codebase.contains", { error: error.message }); }

  // F6: zero files scanned proves nothing — a typo'd glob must not produce a
  // high-confidence contradiction. Inconclusive = failed, not contradicted.
  if (!files.length) {
    return failed("codebase.contains", {
      glob: input.glob, baseDir, scannedFiles: 0,
      error: "Glob matched zero files — cannot verify or contradict. Check the glob pattern and baseDir."
    });
  }

  const matchedFiles = [];
  let regex;
  if (input.pattern) {
    try { regex = new RegExp(input.pattern, input.flags || ""); }
    catch (e) { return failed("codebase.contains", { error: `Invalid regex: ${e.message}` }); }
  }

  for (const filePath of files) {
    try {
      const text = await readFile(filePath, "utf8");
      const hit  = input.contains ? text.includes(input.contains) : regex.test(text);
      if (hit) matchedFiles.push(filePath.replace(/\\/g, "/"));
    } catch { /* skip binary / permission-denied files */ }
  }

  const verified = matchedFiles.length > 0;
  return {
    validator: "codebase.contains", verified, contradicted: !verified,
    confidence: 0.93, realityWeight: 0.90,
    result: {
      glob: input.glob, baseDir,
      contains: input.contains || null, pattern: input.pattern || null,
      matchedFiles, matchCount: matchedFiles.length, scannedFiles: files.length
    }
  };
}

// ── G8: Git history validators ─────────────────────────────────────────────

async function gitLogContains(input) {
  if (!input.message) return failed("git.log_contains", { error: "message is required" });
  const since = input.since || "HEAD~10";
  const repoPolicy = validateRepo(input.repo);
  if (!repoPolicy.ok) return blocked("git.log_contains", repoPolicy);
  const cwd = repoPolicy.path;

  // Build log command: try range first; fall back to full log if ref is ambiguous
  // (happens when the repo has fewer commits than HEAD~N depth).
  async function runLog(args) {
    const { stdout } = await execFileAsync("git", ["log", ...args, "--format=%s%n%b%n---END---"],
      { cwd, timeout: 5000 });
    return stdout;
  }

  let stdout = "";
  try {
    stdout = await runLog([`${since}..HEAD`]);
  } catch (err) {
    const ambiguous = err.stderr?.includes("ambiguous") || err.stderr?.includes("bad revision")
      || err.message?.includes("ambiguous") || err.message?.includes("bad revision");
    if (ambiguous) {
      // Fewer commits than requested depth — search entire history
      try { stdout = await runLog([]); }
      catch (e2) { return failed("git.log_contains", { error: e2.message, since }); }
    } else {
      return failed("git.log_contains", { error: err.message, since });
    }
  }

  const search  = input.caseSensitive ? input.message : input.message.toLowerCase();
  const log     = input.caseSensitive ? stdout : stdout.toLowerCase();
  const matched = log.includes(search);
  const commits = stdout.split("---END---").filter(s => s.trim()).length;

  return {
    validator: "git.log_contains", verified: matched, contradicted: !matched,
    confidence: 0.93, realityWeight: 0.88,
    result: { message: input.message, since, matched, commitsSearched: commits }
  };
}

async function gitLastModified(input) {
  if (!input.path) return failed("git.last_modified", { error: "path is required" });
  const repoPolicy = validateRepo(input.repo);
  if (!repoPolicy.ok) return blocked("git.last_modified", repoPolicy);
  const cwd = repoPolicy.path;

  try {
    const { stdout } = await execFileAsync("git", [
      "log", "-1", "--format=%H%n%aI%n%s", "--", input.path
    ], { cwd, timeout: 5000 });

    if (!stdout.trim()) {
      return contradicted("git.last_modified", 0.90, {
        path: input.path, found: false,
        error: "File has no git history or does not exist in this repo"
      });
    }

    const [hash, isoDate, ...msgParts] = stdout.trim().split("\n");
    return accepted("git.last_modified", 0.95, {
      path: input.path, hash: hash?.trim(), commitDate: isoDate?.trim(),
      message: msgParts.join(" ").trim(), found: true
    });
  } catch (error) {
    return failed("git.last_modified", { path: input.path, error: error.message });
  }
}

async function gitBlameLine(input) {
  if (!input.path) return failed("git.blame_line", { error: "path is required" });
  if (!input.line) return failed("git.blame_line", { error: "line (number) is required" });
  const repoPolicy = validateRepo(input.repo);
  if (!repoPolicy.ok) return blocked("git.blame_line", repoPolicy);
  const cwd  = repoPolicy.path;
  const line = Number(input.line);

  try {
    const { stdout } = await execFileAsync("git", [
      "blame", `-L${line},${line}`, "--porcelain", "--", input.path
    ], { cwd, timeout: 5000 });

    const hashMatch    = stdout.match(/^([0-9a-f]{40})/);
    const authorMatch  = stdout.match(/^author (.+)$/m);
    const timeMatch    = stdout.match(/^author-time (\d+)$/m);
    const summaryMatch = stdout.match(/^summary (.+)$/m);

    if (!hashMatch) {
      return contradicted("git.blame_line", 0.90, { path: input.path, line, found: false });
    }
    return accepted("git.blame_line", 0.93, {
      path:   input.path, line,
      hash:   hashMatch[1],
      author: authorMatch?.[1]?.trim(),
      commitDate: timeMatch ? new Date(Number(timeMatch[1]) * 1000).toISOString() : null,
      summary: summaryMatch?.[1]?.trim(),
      found:  true
    });
  } catch (error) {
    return failed("git.blame_line", { path: input.path, line, error: error.message });
  }
}

// ── #12: Retrieve and ground ───────────────────────────────────────────────
// Fetches a URL and measures how well key claim terms are covered in the body.
async function retrieveAndGround(input) {
  if (!input.url)   return failed("retrieve_and_ground", { error: "url is required" });
  if (!input.claim) return failed("retrieve_and_ground", { error: "claim is required — the statement being grounded" });

  const urlResult = normalizeHttpUrl(input.url);
  if (!urlResult.ok) return failed("retrieve_and_ground", { url: input.url, error: urlResult.error });

  const ssrf = detectPrivateHost(urlResult.url);
  if (ssrf) return contradicted("retrieve_and_ground", 0.99, { url: urlResult.url, error: `SSRF blocked: ${ssrf}` });

  const dnsBlock = await detectPrivateViaDNS(urlResult.url);
  if (dnsBlock) return contradicted("retrieve_and_ground", 0.99, { url: urlResult.url, error: `SSRF DNS blocked: ${dnsBlock}` });

  const allowlistCheck = await validateOutboundUrl(urlResult.url);
  if (!allowlistCheck.ok) return failed("retrieve_and_ground", { url: urlResult.url, error: allowlistCheck.error });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.ANTIPSYC_HTTP_TIMEOUT_MS || 8000));

  let bodyText = "";
  let httpStatus;
  try {
    const resp = await fetch(urlResult.url, { signal: controller.signal, redirect: "follow" });
    httpStatus = resp.status;
    const buf  = await resp.arrayBuffer();
    bodyText   = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf).slice(0, 65536));
  } catch (err) {
    return failed("retrieve_and_ground", { url: urlResult.url, error: err.name === "AbortError" ? "Request timed out" : err.message });
  } finally {
    clearTimeout(timer);
  }

  // Term-frequency grounding: count how many meaningful claim words appear in body
  const claim      = String(input.claim);
  const terms      = [...new Set(claim.toLowerCase().split(/\W+/).filter(w => w.length > 4))];
  const bodyLower  = bodyText.toLowerCase();
  const matched    = terms.filter(t => bodyLower.includes(t));
  const coverage   = terms.length ? matched.length / terms.length : 0;
  const minCoverage = Number(input.threshold ?? 0.30);
  const verified   = coverage >= minCoverage;
  const realityWeight = verified
    ? Math.min(0.78, 0.30 + coverage * 0.60)
    : Math.max(0.05, coverage * 0.30);

  return {
    validator: "retrieve_and_ground", verified, contradicted: !verified && coverage < 0.05,
    confidence: 0.68, realityWeight,
    result: {
      url: urlResult.url, httpStatus, claim,
      coverage: Math.round(coverage * 100) / 100,
      matchedTerms: matched.slice(0, 15),
      totalTerms: terms.length,
      bodyLength: bodyText.length,
      threshold: minCoverage,
    }
  };
}

// ── Result helpers ─────────────────────────────────────────────────────────
function accepted(validator, confidence, result) {
  return { validator, verified: true, contradicted: false, confidence, realityWeight: confidence, result };
}

function contradicted(validator, confidence, result) {
  return { validator, verified: false, contradicted: true, confidence, realityWeight: confidence, result };
}

// H7: failed — validator could not execute (distinct from contradicted)
function failed(validator, result) {
  return {
    validator, verified: false, contradicted: false,
    status: "failed", confidence: 0, realityWeight: 0, result
  };
}

function blocked(validator, result) {
  return {
    validator, verified: false, contradicted: false,
    status: "blocked", confidence: 0, realityWeight: 0, result
  };
}

// H7: unverifiable — no permitted validator for this claim type
function unverifiable(validator, result) {
  return {
    validator, verified: false, contradicted: false,
    status: "unverifiable", confidence: 0, realityWeight: 0.05, result
  };
}

// ── SSRF helpers ───────────────────────────────────────────────────────────
// Opt-in local verification: an agent that just started a dev server must be
// able to verify "my server responds 200" — the most common hallucinated
// runtime claim. ANTIPSYC_ALLOW_LOCAL_HTTP=true permits LOOPBACK ONLY
// (localhost / 127.x / ::1); RFC-1918, link-local, and broadcast ranges stay
// blocked unconditionally.
function allowLocalHttp() {
  return process.env.ANTIPSYC_ALLOW_LOCAL_HTTP === "true";
}

function detectPrivateHost(urlString) {
  let hostname;
  try { hostname = new URL(urlString).hostname; }
  catch { return "invalid URL"; }

  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1) : hostname;

  if (bare === "localhost")  return allowLocalHttp() ? null : "localhost";
  if (bare === "::1")        return allowLocalHttp() ? null : "IPv6 loopback";
  if (/^fe[89ab][0-9a-f]:/i.test(bare)) return "IPv6 link-local";
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return "IPv6 unique-local";

  const m = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0)                          return "non-routable 0.x.x.x";
    if (a === 10)                         return "RFC-1918 10/8";
    if (a === 127)                        return allowLocalHttp() ? null : "loopback 127/8";
    if (a === 169 && b === 254)           return "link-local 169.254/16";
    if (a === 172 && b >= 16 && b <= 31) return "RFC-1918 172.16/12";
    if (a === 192 && b === 168)           return "RFC-1918 192.168/16";
    if (a === 255)                        return "broadcast 255.x.x.x";
  }
  return null;
}

// H5: DNS-resolution SSRF — resolves hostname and checks the actual IP
async function detectPrivateViaDNS(urlString) {
  let hostname;
  try { hostname = new URL(urlString).hostname; } catch { return null; }

  // Skip if already caught by hostname check
  if (detectPrivateHost(urlString)) return null;

  try {
    const { address } = await dnsLookup(hostname);
    return detectPrivateHost(`http://${address}/`);
  } catch {
    return null; // DNS failure is handled by the fetch timeout
  }
}

async function validateOutboundUrl(urlString) {
  const ssrf = detectPrivateHost(urlString);
  if (ssrf) return { ok: false, error: `SSRF protection: private/reserved address blocked (${ssrf}).` };
  const dnsBlock = await detectPrivateViaDNS(urlString);
  if (dnsBlock) return { ok: false, error: `SSRF protection: resolved IP is private/reserved (${dnsBlock}).` };
  const allowlist = String(process.env.ANTIPSYC_HTTP_ALLOWLIST || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length) {
    const host = new URL(urlString).hostname.toLowerCase();
    const allowed = allowlist.some(entry => host === entry || host.endsWith(`.${entry}`));
    if (!allowed) return { ok: false, error: `HTTP host is not in ANTIPSYC_HTTP_ALLOWLIST: ${host}` };
  }
  return { ok: true };
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol)) {
      return { ok: false, error: `Unsupported URL protocol: ${url.protocol}` };
    }
    return { ok: true, url: url.toString() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function validateRepo(repo) {
  return validateLocalPath(repo || process.cwd(), "git.repo");
}

function normalizeProcessCommand(input) {
  if (input.bin) {
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    return { bin: String(input.bin), args, command: [String(input.bin), ...args].join(" ") };
  }
  const command = String(input.command || "").trim();
  const [bin, ...args] = command.split(/\s+/);
  return { bin, args, command };
}

// Dot-notation key accessor for JSON paths (e.g. "dependencies.express")
function getByDotPath(obj, dotPath) {
  return String(dotPath).split(".").reduce(
    (cur, key) =>
      cur !== null && cur !== undefined && Object.prototype.hasOwnProperty.call(cur, key)
        ? cur[key]
        : undefined,
    obj
  );
}
