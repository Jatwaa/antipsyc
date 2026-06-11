/**
 * Conscience Module — 20 Anti-Hallucination Tactics
 *
 * Auto-applied hooks (wired into submitClaim / verifyClaim in server.js):
 *   #3  detectContradiction      — flags new claims that conflict with verified ledger evidence
 *   #6  isDestructiveClaim       — detects delete/remove/wipe patterns; requires double-verify
 *   #8  scoreReasoningTrace      — penalises claims submitted without a reasoning field
 *   #9  recordCalibration        — tracks claimed-vs-actual confidence drift per validator
 *   #10 detectSycophancy         — flags echo / leading-question framing
 *   #20 constitutionalViolations — checks claim+validator against operator-defined principles
 *
 * Explicit MCP tools (exported for use in server.js tool handlers):
 *   #1  declareAction / confirmDone / listIntents
 *   #2  pauseAndVerify
 *   #4  runVerificationChain
 *   #5/#15 retrievalGate
 *   #7  constitutionalCheck
 *   #11 consistencyVote
 *   #13 humanAttest / getAttestation
 *   #14 planVerification  (Chain-of-Verification)
 *   #16 semanticChallenge
 *   #17 startActionTrace / addTraceCycle / completeActionTrace / getTrace
 *   #18 iterativeVerify
 *   #19 verifyExecution   (returns a verify_claim plan — runs nothing itself)
 *       calibrationReport
 */

import { randomUUID } from "node:crypto";
import { VALIDATOR_TTL_SECONDS } from "./validators.js";

// ── In-memory session state ────────────────────────────────────────────────
const intentStore = new Map();   // intentId → intent record
const traceStore  = new Map();   // traceId  → trace record
const attestStore = new Map();   // claimId  → attestation
const gateStore   = new Map();   // gateId   → forced-validation gate record
const calibLog    = [];          // rolling window of calibration records

const MAX_CALIB = 200;
// F9: long-running servers must not leak — evict oldest entries beyond cap.
const MAX_SESSION_RECORDS = 500;
function capMap(map, max = MAX_SESSION_RECORDS) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// F5a: word-boundary scope matching (shared with contracts.js semantics) —
// "pass" must not fire inside "Compass", "user" not inside "user-service".
function scopeWordInText(text, word) {
  const esc = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w-])${esc}(?:[^\\w-]|$)`, "i").test(String(text));
}

// ── Destructive action vocabulary ─────────────────────────────────────────
const DESTRUCTIVE_WORDS = new Set([
  "delete", "deleted", "deletes", "deleting",
  "remove", "removed", "removes", "removing",
  "clear",  "cleared",  "clears",  "clearing",
  "drop",   "dropped",  "drops",   "dropping",
  "reset",  "truncate", "truncated",
  "destroy","destroyed","wipe",    "wiped",
  "erase",  "erased",   "purge",   "purged",
]);

// ── Sycophancy patterns ────────────────────────────────────────────────────
const SYCOPHANCY_PATTERNS = [
  /\bright\??\s*$/i,
  /\bcorrect\??\s*$/i,
  /\bas expected\??\s*$/i,
  /\bisn'?t it\??\s*$/i,
  /\bdon'?t you think\??\s*$/i,
  /\bwould you agree\??\s*$/i,
  /^confirm that\b/i,
  /^verify that i\b/i,
  /^please confirm\b/i,
  /as you (said|requested|asked|mentioned)\b/i,
  /that'?s? (what you|what we|correct|right)\b/i,
  /\bjust as (i|we) (said|described|expected)\b/i,
];

// ── Scope mismatch: qualitative words that narrow validators cannot prove ──
const SCOPE_MISMATCH = {
  secure:      ["filesystem.exists","filesystem.stat","file.contains","file.matches","git.file_exists","git.contains","git.log_contains","codebase.contains"],
  security:    ["filesystem.exists","filesystem.stat","file.contains","file.matches","git.file_exists","git.contains","codebase.contains"],
  safe:        ["filesystem.exists","filesystem.stat","file.contains","file.matches"],
  safely:      ["filesystem.exists","filesystem.stat","file.contains","file.matches"],
  healthy:     ["filesystem.exists","filesystem.stat","file.contains"],
  health:      ["filesystem.exists","filesystem.stat","file.contains"],
  correct:     ["filesystem.exists","filesystem.stat","file.contains","file.matches"],
  correctly:   ["filesystem.exists","filesystem.stat","file.contains","file.matches"],
  valid:       ["filesystem.exists","filesystem.stat"],
  complete:    ["filesystem.exists","filesystem.stat","file.contains"],
  compliant:   ["filesystem.exists","filesystem.stat","file.contains","file.matches","git.log_contains"],
  compliance:  ["filesystem.exists","filesystem.stat","file.contains","file.matches","git.log_contains"],
  passing:     ["filesystem.exists","filesystem.stat","file.contains","file.matches"],
  deployed:    ["filesystem.exists","filesystem.stat","file.contains"],
  operational: ["filesystem.exists","filesystem.stat","file.contains"],
  production:  ["filesystem.exists","filesystem.stat","file.contains"],
  stable:      ["filesystem.exists","filesystem.stat","file.contains"],
  approved:    ["filesystem.exists","filesystem.stat","file.contains","git.log_contains"],
};

// ── Validator domain descriptions ─────────────────────────────────────────
const VALIDATOR_DOMAINS = {
  "filesystem.exists": "path existence only",
  "filesystem.stat":   "file metadata (size, dates, type)",
  "file.contains":     "presence of a literal substring in file text",
  "file.matches":      "presence of a regex pattern in file text",
  "code.run":          "JavaScript execution output in a VM sandbox",
  "http.fetch":        "HTTP response status code",
  "text.contains":     "AI-supplied text content (low trust — not grounded)",
  "json.path":         "value at a dot-notation JSON key",
  "git.file_exists":   "file existence at a git ref",
  "git.contains":      "substring in a file at a git ref",
  "git.log_contains":  "substring in recent commit messages",
  "math.evaluate":     "arithmetic expression result",
  "codebase.contains": "substring/pattern across files matching a glob",
  "process.run":       "process exit code and stdout",
  "retrieve_and_ground": "claim terms present in a fetched URL's body text",
};

// ── Runtime-state validators (can prove service is live) ──────────────────
const RUNTIME_VALIDATORS = new Set(["http.fetch", "process.run"]);

// ── Constitutional principles ─────────────────────────────────────────────
function loadPrinciples() {
  const defaults = [
    {
      id: "P1",
      rule: "File content claims require file.contains or file.matches evidence",
      claimPattern: /\b(contains?|includes?|has the text|written to|inside|found in)\b/i,
      requiredValidators: ["file.contains", "file.matches", "codebase.contains"],
    },
    {
      id: "P2",
      rule: "Code correctness claims require code.run evidence",
      claimPattern: /\b(works?|runs?|executes?|outputs?|returns?|computes?|produces?|prints?)\b/i,
      requiredValidators: ["code.run"],
    },
    {
      id: "P3",
      rule: "HTTP reachability claims require http.fetch evidence",
      claimPattern: /\b(reachable|accessible|returns? 200|responds?|is up|is live|is running|online)\b/i,
      requiredValidators: ["http.fetch"],
    },
    {
      id: "P4",
      rule: "Git state claims require git validator evidence",
      claimPattern: /\b(committed|pushed|merged|in git|in version control|in the repo|branched)\b/i,
      requiredValidators: ["git.file_exists","git.contains","git.branch_exists","git.log_contains","git.last_modified"],
    },
    {
      id: "P5",
      rule: "Package dependency claims require json.path or file.contains evidence",
      claimPattern: /\b(installed|depends? on|requires?|package|dependency|npm|yarn)\b/i,
      requiredValidators: ["json.path", "file.contains"],
    },
  ];

  try {
    const raw = process.env.ANTIPSYC_PRINCIPLES;
    if (raw) return [...defaults, ...JSON.parse(raw)];
  } catch { /* ignore invalid JSON */ }

  return defaults;
}

// ── Action manifests (declare_action) ─────────────────────────────────────
const ACTION_MANIFESTS = {
  file_write: ({ path, contains }) => [
    { step: 1, validator: "filesystem.exists", path, description: `Confirm ${path} was created` },
    ...(contains ? [{ step: 2, validator: "file.contains", path, contains, description: "Confirm written content is present" }] : []),
  ],
  file_delete: ({ path }) => [
    { step: 1, validator: "filesystem.exists", path, expectAbsent: true, description: `Confirm ${path} no longer exists` },
  ],
  file_edit: ({ path, contains }) => [
    { step: 1, validator: "filesystem.exists", path, description: `Confirm ${path} still exists` },
    ...(contains ? [{ step: 2, validator: "file.contains", path, contains, description: "Confirm edit is present in file" }] : []),
  ],
  code_run: ({ code, expectedOutput }) => [
    { step: 1, validator: "code.run", code, expectedOutput, description: "Confirm code produces expected output" },
  ],
  http_check: ({ url, expectedStatus }) => [
    { step: 1, validator: "http.fetch", url, expectedStatus: expectedStatus || 200, description: `Confirm ${url} responds ${expectedStatus || 200}` },
  ],
  package_install: ({ lib }) => [
    { step: 1, validator: "file.contains", path: "package.json", contains: `"${lib}"`, description: `Confirm "${lib}" appears in package.json` },
  ],
  git_commit: ({ path }) => [
    { step: 1, validator: "git.last_modified", path: path || ".", description: "Confirm file has recent git commit" },
  ],
};

function inferActionType(action) {
  const a = String(action).toLowerCase();
  if (/\b(delete|remov|clear|drop|reset|wipe|erase|purg)\b/.test(a)) return "file_delete";
  if (/\b(install|add.*depend|npm install|yarn add)\b/.test(a)) return "package_install";
  if (/\b(commit|push|merge)\b/.test(a)) return "git_commit";
  if (/\b(write|create|generate|save)\b.*\.(js|ts|jsx|tsx|py|json|md|css|html|sh|yaml|yml)/.test(a)) return "file_write";
  if (/\b(edit|modif|update|change|patch)\b.*\.(js|ts|jsx|tsx|py|json|md|css|html)/.test(a)) return "file_edit";
  if (/\b(run|execute|test)\b.*\b(code|script|function|snippet)\b/.test(a)) return "code_run";
  if (/\b(fetch|ping|check|request)\b.*\bhttp/.test(a)) return "http_check";
  return "generic";
}

// ── Shared HALT builder ───────────────────────────────────────────────────
function halt(tactic, directive, required_steps = [], opts = {}) {
  return {
    gate:           "HALT",
    tactic,
    directive,
    required_steps,
    resume_when:    opts.resumeWhen || "Complete all required_steps (each must return verified=true), then proceed.",
    do_not_assert:  true,
    timestamp:      new Date().toISOString(),
    ...opts,
  };
}

// ── Text extraction helpers ───────────────────────────────────────────────
function extractFilePaths(text) {
  // The trailing (?![A-Za-z0-9]) forces the extension to be COMPLETE — without
  // it the alternation matches ".js" inside ".json" (and ".c" inside ".cpp"),
  // so "package.json" was mis-extracted as "package.js".
  const rx = /(?:^|[\s"'`(])((\.{0,2}\/)?[\w\-]+(?:\/[\w\-]+)*\.(?:jsx|tsx|js|ts|py|json|md|css|html|sh|yaml|yml|env|txt|go|rs|rb|java|cpp|c|h)(?![A-Za-z0-9]))/g;
  return [...text.matchAll(rx)].map(m => m[1]).filter(Boolean);
}

function extractUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s"'`<>)]+/g)].map(m => m[0]);
}

function extractQuotedStrings(text) {
  return [...text.matchAll(/["'`]([^"'`]{3,80})["'`]/g)].map(m => m[1]).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────
// #1  Intent tracking — declare_action / confirm_done
// ─────────────────────────────────────────────────────────────────────────

export function declareAction(input) {
  if (!input.action) throw new Error("action is required");
  const actionType = input.actionType || inferActionType(input.action);
  const manifestFn = ACTION_MANIFESTS[actionType];
  const manifest   = manifestFn ? manifestFn(input.parameters || {}) : [];

  const intent = {
    id:         randomUUID(),
    action:     String(input.action),
    actionType,
    parameters: input.parameters || {},
    manifest,
    openedAt:   new Date().toISOString(),
    closedAt:   null,
    status:     "open",
  };
  intentStore.set(intent.id, intent);
  capMap(intentStore);

  return {
    intentId:   intent.id,
    action:     intent.action,
    actionType,
    status:     "open",
    manifest,
    step_count: manifest.length,
    directive:  manifest.length
      ? `You must run ${manifest.length} verification step(s) using verify_claim before claiming this action is complete. Then call confirm_done.`
      : "No standard manifest for this action type. Call confirm_done and provide evidenceClaimIds.",
    resume_when: "Call confirm_done(intentId) after all manifest verifications return verified=true.",
  };
}

export function confirmDone(input) {
  if (!input.intentId) throw new Error("intentId is required");
  const intent = intentStore.get(input.intentId);
  if (!intent) {
    return halt("confirm_done",
      `Intent "${input.intentId}" not found. Use declare_action first to register your intent.`,
      [{ action: "Call declare_action to register what you are about to do before claiming completion." }]
    );
  }
  if (intent.status === "closed") {
    return { gate: "PROCEED", tactic: "intent_tracking", intentId: intent.id, message: "Intent already closed.", closedAt: intent.closedAt };
  }
  intent.closedAt = new Date().toISOString();
  intent.status   = "closed";
  intentStore.set(intent.id, intent);
  return {
    gate:     "PROCEED",
    tactic:   "intent_tracking",
    intentId: intent.id,
    action:   intent.action,
    closedAt: intent.closedAt,
    message:  "Intent closed. Evidence chain recorded. You may now assert completion.",
  };
}

export function listIntents() {
  return [...intentStore.values()];
}

// ─────────────────────────────────────────────────────────────────────────
// #2  Deliberation gate — pause_and_verify
// ─────────────────────────────────────────────────────────────────────────

export function pauseAndVerify(input) {
  const claim  = String(input.claim || input.statement || "");
  const paths  = extractFilePaths(claim);
  const urls   = extractUrls(claim);
  const quoted = extractQuotedStrings(claim);
  const isDestr = isDestructiveClaim(claim);

  const steps = [];
  let i = 1;

  for (const p of [...new Set(paths)].slice(0, 4)) {
    steps.push({ step: i++, action: `verify_claim { validator: "filesystem.exists", path: "${p}" }` });
    if (quoted.length) {
      steps.push({ step: i++, action: `verify_claim { validator: "file.contains", path: "${p}", contains: "${quoted[0].slice(0, 60)}" }` });
    }
  }
  for (const u of [...new Set(urls)].slice(0, 2)) {
    steps.push({ step: i++, action: `verify_claim { validator: "http.fetch", url: "${u}", expectedStatus: 200 }` });
  }
  if (!paths.length && !urls.length) {
    steps.push({ step: i++, action: "Identify the external artifact this claim refers to (file path, URL, git ref, math expression)" });
    steps.push({ step: i++, action: "Call verify_claim with the appropriate validator for that artifact" });
  }
  if (isDestr) {
    steps.push({ step: i++, action: "DESTRUCTIVE CLAIM: run a second independent validator confirming the destruction (e.g. filesystem.exists returning false)" });
  }
  steps.push({ step: i++, action: "Call gate_check with verified=true and the returned realityWeight — proceed only when gate returns 'verified'" });

  return halt(
    "pause_and_verify",
    `STOP. Before asserting: "${claim.slice(0, 120)}${claim.length > 120 ? "…" : ""}" — complete every step below.`,
    steps,
    { resumeWhen: "gate_check returns gate: 'verified' for this claim." }
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Forced validation — a confirmation creates a fresh gate on the fly
//
// A "confirmation" is an input that asserts something is done / correct /
// successful and asks the system to accept it (explicit type:"confirmation",
// confirmation:true, or completion/echo phrasing). A model's confirmation is
// NOT evidence, so instead of accepting it the system mints a brand-new
// validation gate — a registered gate object with concrete verify_claim steps
// that must pass before the confirmation may be asserted.
// ─────────────────────────────────────────────────────────────────────────

// Phrases that mark an input as a confirmation seeking the system's blessing.
const CONFIRMATION_PATTERNS = [
  /\bconfirm(s|ed|ing)?\b/i,
  /\b(is|are|was|were)\s+(it|this|that|the\s+[\w.-]+|everything)\s+(correct|right|done|complete|finished|working|ready|ok|okay|good)\b/i,
  /\b(did|does|has|have)\s+([\w.-]+|it|this|that|the\s+[\w.-]+)\s+(work|works|worked|succeed|succeeded|pass|passed|complete|completed|finish|finished)\b/i,
  /\b(everything|it|the\s+[\w.-]+|task|job|build|migration|deployment|tests?|change|update|fix|feature)\s+(is|are|was|were)?\s*(done|complete|completed|finished|ready|working|passing|passed|successful|succeeded|resolved|fixed|deployed|created|installed)\b/i,
  /\b(successfully|all\s+set|good\s+to\s+go|ready\s+to\s+ship)\b/i,
  ...SYCOPHANCY_PATTERNS,
];

// Detect whether an input is a confirmation. Explicit markers win; otherwise
// the statement is matched against the confirmation phrasings.
export function detectConfirmation(input = {}) {
  const markers = [input.type, input.kind, input.intent, input.source]
    .map(v => String(v || "").toLowerCase());
  if (input.confirmation === true || markers.includes("confirmation") || markers.includes("confirm")) {
    return { confirmation: true, signal: "explicit", matched: String(input.type || input.kind || input.intent || "confirmation") };
  }
  const text = String(
    input.statement || input.claim ||
    (typeof input.confirmation === "string" ? input.confirmation : "") || ""
  );
  for (const pat of CONFIRMATION_PATTERNS) {
    const m = text.match(pat);
    if (m) return { confirmation: true, signal: "phrasing", matched: m[0].trim().slice(0, 60) };
  }
  return null;
}

// Build the concrete verify_claim steps the gate will force, derived from the
// external artifacts the confirmation references.
function forcedValidationSteps(statement) {
  const text   = String(statement || "");
  const paths  = [...new Set(extractFilePaths(text))].slice(0, 5);
  const urls   = [...new Set(extractUrls(text))].slice(0, 3);
  const quoted = extractQuotedStrings(text);
  const steps  = [];
  let i = 1;

  for (const p of paths) {
    steps.push({ step: i++, validator: "filesystem.exists", params: { path: p }, why: `Confirm ${p} actually exists on disk` });
    if (quoted.length) {
      steps.push({ step: i++, validator: "file.contains", params: { path: p, contains: quoted[0].slice(0, 80) }, why: `Confirm ${p} really contains the asserted content` });
    }
  }
  for (const u of urls) {
    steps.push({ step: i++, validator: "http.fetch", params: { url: u, expectedStatus: 200 }, why: `Confirm ${u} actually responds` });
  }
  if (/\b(commit|committed|pushed|merged|in git|version control)\b/i.test(text)) {
    steps.push({ step: i++, validator: "git.log_contains", params: { message: "<commit message fragment>" }, why: "Confirm the change is really in git history" });
  }
  if (/\b(tests?|suite|spec|ci)\b/i.test(text)) {
    steps.push({ step: i++, validator: "process.run", params: { command: "<test command>", expectedExitCode: 0 }, why: "Run the tests — do not accept 'passing' on faith" });
  }
  if (/\b(output|prints?|returns?|computes?|produces?|equals?)\b/i.test(text)) {
    steps.push({ step: i++, validator: "code.run", params: { code: "<code>", expectedOutput: "<expected>" }, why: "Execute the code and compare real output" });
  }
  if (!steps.length) {
    steps.push({ step: i++, validator: "<choose validator>", params: {}, why: "Identify the external artifact behind this confirmation (file, URL, git ref, command, expression) and verify it with the matching validator." });
  }
  return steps;
}

// Create a brand-new forced-validation gate for a confirmation and register it.
export function forceValidation(input = {}) {
  const statement = String(
    input.statement || input.claim ||
    (typeof input.confirmation === "string" ? input.confirmation : "") || ""
  ).trim();
  if (!statement) throw new Error("statement (or claim) is required to force validation");

  const detected = detectConfirmation(input) || { confirmation: true, signal: "forced", matched: null };
  const required_steps = forcedValidationSteps(statement);

  const gate = {
    id:            `gate_${randomUUID()}`,
    statement,
    trigger:       detected.signal,
    matched:       detected.matched,
    status:        "open",
    requiredSteps: required_steps,
    createdAt:     new Date().toISOString(),
    satisfiedBy:   [],
  };
  gateStore.set(gate.id, gate);
  capMap(gateStore);

  return {
    gate:        "HALT",
    tactic:      "forced_validation",
    gateId:      gate.id,
    reason:      `A confirmation was received (${detected.signal}${detected.matched ? `: "${detected.matched}"` : ""}). A model's confirmation is not evidence — a new validation gate was created to force grounded checks.`,
    directive:   `Do NOT accept this confirmation. Complete the ${required_steps.length} required validation step(s) with verify_claim, then call resolve_forced_gate({ gateId: "${gate.id}", claimIds: [...] }).`,
    statement:   statement.slice(0, 160),
    required_steps,
    resume_when: "Every required step returns verified=true and resolve_forced_gate returns gate:PROCEED.",
    do_not_assert: true,
    timestamp:   gate.createdAt,
  };
}

export function getForcedGate(gateId) {
  return gateStore.get(gateId) || null;
}

export function listForcedGates() {
  return [...gateStore.values()];
}

// ── Strict resolution helpers ─────────────────────────────────────────────
function gateBasename(p) {
  return String(p || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

// Validators that produce real, observed external evidence. text.contains is
// excluded (self-supplied); code.run is "simulated" (excluded by status anyway).
const GROUNDED_VALIDATORS = new Set([
  "filesystem.exists", "filesystem.stat", "file.contains", "file.matches",
  "json.valid", "json.path", "codebase.contains",
  "git.file_exists", "git.contains", "git.branch_exists",
  "git.log_contains", "git.last_modified", "git.blame_line",
  "http.fetch", "math.evaluate", "process.run", "retrieve_and_ground",
]);

// An evidence record only counts if it is FRESH, GROUNDED, and fully VERIFIED.
// status must be exactly "verified" — this excludes stale, simulated, syntactic,
// partial, irrelevant, blocked, and failed evidence.
function isUsableEvidence(r, minRw) {
  if (!r || r.verified !== true) return false;
  if (r.status !== "verified") return false;
  if ((r.realityWeight ?? 0) < minRw) return false;
  if (!GROUNDED_VALIDATORS.has(r.validator)) return false;
  if (r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

function recordCoversPath(r, artifactBase) {
  const res = r.result || {};
  if (res.path && gateBasename(res.path).toLowerCase() === artifactBase) return true;
  if (r.validator === "codebase.contains" && Array.isArray(res.matchedFiles)) {
    return res.matchedFiles.some(f => gateBasename(f).toLowerCase() === artifactBase);
  }
  return false;
}
function recordCoversUrl(r, url) {
  const res = r.result || {};
  if (!res.url) return false;
  try {
    const a = new URL(res.url), b = new URL(url);
    return a.host === b.host && a.pathname === b.pathname;
  } catch { return String(res.url).includes(url); }
}
function recordCoversQuoted(r, q) {
  const res = r.result || {};
  return String(res.contains || "").toLowerCase() === String(q).toLowerCase();
}

// Resolve a forced gate STRICTLY. PROCEED only when EVERY artifact the
// confirmation names (file, URL, or quoted value) is independently backed by a
// distinct fresh, grounded, fully-verified evidence record, and nothing is
// contradicted. Unrelated true facts, partial coverage, weak/stale evidence, and
// vague confirmations that name nothing checkable can never pass.
export function resolveForcedGate(input = {}, evidence = []) {
  const gate = gateStore.get(input.gateId);
  if (!gate) {
    return halt("forced_validation",
      `Forced gate "${input.gateId}" not found. Call force_validation first (or it was evicted).`,
      [{ action: "Re-create the gate with force_validation, then complete its required_steps." }]);
  }
  if (gate.status === "satisfied") {
    return { gate: "PROCEED", tactic: "forced_validation", gateId: gate.id, message: "Gate already satisfied.", satisfiedAt: gate.satisfiedAt };
  }

  const minRw   = Number(process.env.ANTIPSYC_FORCED_MIN_RW || 0.75);
  const records = Array.isArray(evidence) ? evidence.filter(Boolean) : [];

  // 1. Any contradiction at all kills the confirmation outright.
  if (records.some(r => r.contradicted === true)) {
    return {
      ...halt("forced_validation",
        "Validation CONTRADICTED the confirmation. Do not assert — it was checked and found false.",
        [{ action: "Fix the underlying state or retract the confirmation, then start a new gate." }],
        { gateId: gate.id }),
      verdict: "contradicted",
    };
  }

  const usable = records.filter(r => isUsableEvidence(r, minRw));

  // 2. Identify the concrete artifacts the confirmation NAMES.
  const stmt   = gate.statement;
  const paths  = [...new Set(extractFilePaths(stmt).map(p => gateBasename(p).toLowerCase()).filter(Boolean))];
  const urls   = [...new Set(extractUrls(stmt))];
  const quoted = [...new Set(extractQuotedStrings(stmt))];

  // 3. A confirmation that names nothing checkable cannot be grounded by tools.
  if (!paths.length && !urls.length && !quoted.length) {
    return {
      ...halt("forced_validation",
        "This confirmation names no checkable artifact (file, URL, or quoted value), so tools cannot ground it. A vague confirmation can never be auto-validated.",
        [{ action: "Restate it as concrete claims that each name a specific file, URL, command, or value, then verify every one with verify_claim and resolve again." }],
        { gateId: gate.id }),
      verdict: "unverifiable_by_tools",
    };
  }

  // 4. Every named artifact must be covered by its OWN distinct usable record.
  const used = new Set();
  const missing = [];
  const claimRecord = (pred) => {
    const idx = usable.findIndex((r, i) => !used.has(i) && pred(r));
    if (idx === -1) return false;
    used.add(idx);
    return true;
  };
  for (const base of paths) {
    if (!claimRecord(r => recordCoversPath(r, base))) {
      missing.push({ artifact: base, need: `a fresh verified filesystem/file/git/codebase check for "${base}"` });
    }
  }
  for (const u of urls) {
    if (!claimRecord(r => recordCoversUrl(r, u))) {
      missing.push({ artifact: u, need: `a fresh verified http.fetch for "${u}"` });
    }
  }
  for (const q of quoted) {
    if (!claimRecord(r => recordCoversQuoted(r, q))) {
      missing.push({ artifact: q, need: `a fresh verified file.contains proving the exact text "${q}" exists` });
    }
  }

  if (missing.length) {
    return {
      ...halt("forced_validation",
        `Not every artifact named in the confirmation is independently verified — ${missing.length} still unproven. The confirmation cannot be asserted.`,
        missing.map((m, i) => ({ step: i + 1, artifact: m.artifact, action: m.need })),
        { gateId: gate.id, resumeWhen: `Every named artifact has fresh, grounded, verified evidence (status "verified", realityWeight ≥ ${minRw}).` }),
      verdict: "incomplete",
      missing,
      artifactsNamed: paths.length + urls.length + quoted.length,
      artifactsVerified: used.size,
    };
  }

  // 5. Every artifact independently grounded, nothing contradicted → PROCEED.
  gate.status      = "satisfied";
  gate.satisfiedAt = new Date().toISOString();
  gate.satisfiedBy = [...used].map(i => usable[i].claimId || usable[i].id).filter(Boolean);
  gateStore.set(gate.id, gate);
  return {
    gate:              "PROCEED",
    tactic:            "forced_validation",
    gateId:            gate.id,
    verdict:           "validated",
    artifactsVerified: paths.length + urls.length + quoted.length,
    message:           "Every artifact named in the confirmation is independently grounded by fresh verified evidence. You may assert it.",
    satisfiedAt:       gate.satisfiedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Response-level linting — turn free text into checkable claims (roadmap #1)
//
// extract_claims is deterministic (no LLM): it sweeps a draft for the
// assertions a validator can actually check and emits ready-to-run verify_claim
// payloads. audit_response runs them and returns a send/REVISE verdict. This
// makes grounding the default path — the model pipes its own prose through the
// gate instead of having to think of each claim.
// ─────────────────────────────────────────────────────────────────────────

const SYMBOL_STOPWORDS = new Set([
  "the", "and", "is", "are", "was", "were", "a", "an", "of", "to", "in", "on",
  "for", "with", "that", "this", "it", "as", "from", "function", "class",
  "const", "let", "var", "export", "exported", "exports", "method", "default",
]);

function extractSymbols(text) {
  const out = new Set();
  const rx = /\b(?:export(?:ed|s)?|function|class|const|method)\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s+(?:is\s+)?(?:export(?:ed)?|function)\b/gi;
  for (const m of text.matchAll(rx)) {
    const sym = m[1] || m[2];
    if (sym && sym.length >= 2 && !SYMBOL_STOPWORDS.has(sym.toLowerCase())) out.add(sym);
  }
  return [...out];
}

// Deterministically extract checkable claims from free text, each as a
// ready-to-run verify_claim payload. Pairing is sentence-scoped so a path and
// the thing asserted about it stay together.
export function extractClaims(input = {}) {
  const text = String(input.text || input.draft || input.statement || "");
  if (!text.trim()) return { text: "", claimCount: 0, claims: [] };

  const claims = [];
  const seen = new Set();
  const add = (c) => {
    const key = `${c.validator}|${(c.path || c.url || c.glob || "")}|${(c.contains || c.symbol || c.expected || c.expression || "")}`.toLowerCase();
    if (!seen.has(key)) { seen.add(key); claims.push(c); }
  };

  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const paths  = [...new Set(extractFilePaths(s))].slice(0, 6);
    const urls   = [...new Set(extractUrls(s))].slice(0, 4);
    const quoted = [...new Set(extractQuotedStrings(s))];
    const symbols = extractSymbols(s);

    for (const p of paths) {
      add({ statement: `${p} exists`, validator: "filesystem.exists", path: p });
      for (const q of quoted.slice(0, 4)) {
        add({ statement: `${p} contains "${q}"`, validator: "file.contains", path: p, contains: q });
      }
      for (const sym of symbols.slice(0, 4)) {
        add({ statement: `${sym} is declared in ${p}`, validator: "symbol.exists", path: p, symbol: sym });
      }
    }
    for (const u of urls) {
      add({ statement: `${u} responds with HTTP 200`, validator: "http.fetch", url: u, expectedStatus: 200 });
    }

    // package.json version ("version 2.1.0", "bumped to v2.1.0")
    const ver = s.match(/\bv(?:ersion)?\.?\s*(?:to\s+|=\s*)?["']?(\d+\.\d+\.\d+)["']?/i) || s.match(/\bv(\d+\.\d+\.\d+)\b/);
    if (ver) {
      add({ statement: `package.json version is ${ver[1]}`, validator: "json.path", path: "package.json", keyPath: "version", expected: ver[1] });
    }

    // arithmetic ("2 + 2 = 4", "10 * 3 equals 30")
    for (const m of s.matchAll(/(\d+(?:\.\d+)?(?:\s*[-+*/]\s*\d+(?:\.\d+)?)+)\s*(?:=|==|equals?|is)\s*(\d+(?:\.\d+)?)/gi)) {
      add({ statement: `${m[1]} = ${m[2]}`, validator: "math.evaluate", expression: m[1].replace(/\s+/g, ""), expected: Number(m[2]) });
    }
  }

  return { text: text.slice(0, 400), claimCount: claims.length, claims };
}

// Audit a whole draft response: extract its checkable claims, verify each, and
// return a send/REVISE verdict. verifyFn is the server's verifyClaim.
export async function auditResponse(input, verifyFn) {
  const { claims } = extractClaims(input);
  if (!claims.length) {
    return {
      tactic:  "audit_response",
      verdict: "NO_CHECKABLE_CLAIMS",
      checked: 0,
      message: "No externally-checkable claims were found in the text. Nothing to verify — but the absence of checkable claims is not a guarantee of correctness. Prefer making concrete, checkable assertions.",
    };
  }

  const results = await Promise.all(claims.map(async (c) => {
    let ev;
    try { const r = await verifyFn({ ...c }); ev = r.evidence || r; }
    catch (e) { ev = { verified: false, contradicted: false, status: "failed", realityWeight: 0, result: { error: e.message } }; }
    return {
      statement:     c.statement,
      validator:     c.validator,
      verified:      ev.verified === true && ev.status === "verified",
      contradicted:  ev.contradicted === true,
      status:        ev.status,
      realityWeight: ev.realityWeight,
      gate:          ev.gate?.gate || null,
    };
  }));

  const grounded     = results.filter(r => r.verified && !r.contradicted);
  const contradicted = results.filter(r => r.contradicted);
  const ungrounded   = results.filter(r => !r.verified && !r.contradicted);
  const verdict      = (contradicted.length || ungrounded.length) ? "REVISE" : "OK";

  return {
    tactic:  "audit_response",
    verdict,
    checked: results.length,
    counts:  { grounded: grounded.length, contradicted: contradicted.length, ungrounded: ungrounded.length },
    contradicted,
    ungrounded,
    grounded,
    directive: verdict === "OK"
      ? "Every checkable claim in the draft is grounded by fresh verified evidence. Safe to send."
      : `Do NOT send as-is. ${contradicted.length} contradicted and ${ungrounded.length} unverified claim(s). Remove them, correct them, or qualify them as unverified before sending.`,
    do_not_assert: verdict !== "OK",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #3  Contradiction detection (auto-applied hook)
// ─────────────────────────────────────────────────────────────────────────

export function detectContradiction(statement, existingClaims) {
  const stmt   = String(statement || "").toLowerCase();
  const tokens = stmt.split(/\W+/).filter(w => w.length > 3);
  const NEG_RE = /\b(not|no|never|doesn'?t|didn'?t|won'?t|isn'?t|aren'?t|wasn'?t|absent|missing|doesn't exist)\b/;

  for (const claim of existingClaims) {
    // Use claim-level realityWeight (set by appendEvidence on each verify run)
    // listClaims() returns these fields directly — no evidence hydration needed.
    const rw = claim.realityWeight ?? 0;
    if (rw < 0.75) continue;
    if (!["verified", "contradicted"].includes(claim.status ?? "")) continue;

    const existingStmt = String(claim.statement || "").toLowerCase();
    const overlap = tokens.filter(t => existingStmt.includes(t)).length / Math.max(tokens.length, 1);
    if (overlap < 0.35) continue;

    const newNeg = NEG_RE.test(stmt);
    const oldNeg = NEG_RE.test(existingStmt);
    if (newNeg === oldNeg) continue; // same polarity — not a contradiction

    return {
      contradictionDetected: true,
      conflicting_claim: {
        id:            claim.id,
        statement:     claim.statement,
        realityWeight: rw,
        status:        claim.status,
      },
      directive: `A prior ${claim.status} claim (rw=${rw}) contradicts this new claim. Resolve or provide superseding evidence.`,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// #4  Verification chain
// ─────────────────────────────────────────────────────────────────────────

export async function runVerificationChain(input, verifyFn) {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) throw new Error("steps[] is required — each element is a verify_claim input object");

  const results = [];
  for (const [i, step] of steps.entries()) {
    const r  = await verifyFn(step);
    const ev = r.evidence || r;
    results.push({ step: i + 1, label: step.description || step.validator, evidence: ev });

    if (!ev.verified) {
      return halt(
        "verification_chain",
        `Chain failed at step ${i + 1}: "${step.description || step.validator}". Fix and re-run the full chain.`,
        [{ step: i + 1, action: `Re-verify: ${JSON.stringify({ validator: step.validator, ...step })}` }],
        { completedSteps: i, totalSteps: steps.length, resumeWhen: "All chain steps verified." }
      );
    }
  }

  return {
    gate:    "PROCEED",
    tactic:  "verification_chain",
    message: `All ${steps.length} chain step(s) verified.`,
    steps:   results,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #5 / #15  Retrieval gate
// ─────────────────────────────────────────────────────────────────────────

export function retrievalGate(input, existingClaims = []) {
  const validator = String(input.validator || "");
  const stmt      = String(input.statement || "").toLowerCase();

  // UNSUPPORTABLE: scope word + narrow validator mismatch
  for (const [word, narrowList] of Object.entries(SCOPE_MISMATCH)) {
    if (scopeWordInText(stmt, word) && narrowList.includes(validator)) {
      return {
        signal:    "UNSUPPORTABLE",
        reason:    `Claim contains "${word}" — a qualitative scope word "${validator}" cannot verify.`,
        directive: `Remove "${word}" from the claim statement or use a semantic/execution validator.`,
      };
    }
  }

  const claim = existingClaims.find(c => c.id === input.claimId || c.statement === input.statement);
  if (!claim?.evidence?.length) {
    return { signal: "MISSING", reason: "No evidence exists for this claim. Run verify_claim first." };
  }

  const latest = [...claim.evidence].reverse().find(e => e.validator === validator);
  if (!latest) {
    return { signal: "MISSING", reason: `No "${validator}" evidence found for this claim.` };
  }

  const ttl = VALIDATOR_TTL_SECONDS[validator];
  if (ttl === null) return { signal: "FRESH", reason: "Deterministic validator — evidence never expires.", realityWeight: latest.realityWeight };

  const ageSeconds = (Date.now() - new Date(latest.timestamp ?? 0).getTime()) / 1000;
  if (ageSeconds > ttl) {
    return {
      signal:    "STALE",
      ageMinutes: Math.round(ageSeconds / 60),
      ttlMinutes: Math.round(ttl / 60),
      reason:    `Evidence is ${Math.round(ageSeconds / 60)}m old (TTL ${Math.round(ttl / 60)}m). Re-verify before asserting.`,
      directive: halt("retrieval_gate", "Evidence is stale. Re-verify before asserting.",
        [{ action: `Call verify_claim with validator: "${validator}" to refresh evidence.` }]),
    };
  }

  return {
    signal:        "FRESH",
    ageMinutes:    Math.round(ageSeconds / 60),
    ttlMinutes:    Math.round(ttl / 60),
    realityWeight: latest.realityWeight,
    verifiedAt:    latest.timestamp,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #6  Destructive claim detection (auto-applied hook)
// ─────────────────────────────────────────────────────────────────────────

export function isDestructiveClaim(statement) {
  const words = String(statement || "").toLowerCase().split(/\W+/);
  return words.some(w => DESTRUCTIVE_WORDS.has(w));
}

export function destructiveClaimDirective(statement) {
  return halt(
    "destructive_double_verify",
    `Destructive action detected in: "${String(statement).slice(0, 100)}". Two independent validators required before asserting.`,
    [
      { step: 1, action: "Run primary validator confirming the destruction/removal state" },
      { step: 2, action: "Run a SECOND independent validator (e.g. filesystem.exists returning false, or git.last_modified showing removal commit)" },
    ],
    { resumeWhen: "Both validators return consistent results confirming the destructive state." }
  );
}

// ─────────────────────────────────────────────────────────────────────────
// #7  Constitutional check
// ─────────────────────────────────────────────────────────────────────────

export function constitutionalCheck(input) {
  const statement  = String(input.statement || "");
  const validator  = String(input.validator || "");
  const principles = loadPrinciples();
  const violations = [];

  for (const p of principles) {
    if (!p.claimPattern.test(statement)) continue;
    if (!p.requiredValidators.length)    continue;
    if (p.requiredValidators.includes(validator)) continue;
    violations.push({
      principleId: p.id,
      rule:        p.rule,
      required:    p.requiredValidators,
      provided:    validator || "(none)",
      resolution:  `Use one of: ${p.requiredValidators.join(", ")}`,
    });
  }

  if (!violations.length) return { passed: true, principlesChecked: principles.length };

  return {
    passed:        false,
    violations,
    gate:          "HALT",
    tactic:        "constitutional_check",
    directive:     `${violations.length} constitutional principle(s) violated. Resolve before asserting.`,
    do_not_assert: true,
    timestamp:     new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #8  Reasoning trace (auto-applied hook — returns penalty applied to rw)
// ─────────────────────────────────────────────────────────────────────────

export function scoreReasoningTrace(input) {
  const r = String(input.reasoning || "").trim();
  if (!r)           return { penalty: 0.25, reason: "No reasoning field — claim starts at reduced realityWeight." };
  if (r.length < 60)  return { penalty: 0.15, reason: "Reasoning too brief to be substantive." };
  if (r.length < 150) return { penalty: 0.05, reason: "Reasoning is present but brief." };
  return { penalty: 0, reason: "Adequate reasoning provided." };
}

// ─────────────────────────────────────────────────────────────────────────
// #9  Calibration tracking (auto-applied hook)
// ─────────────────────────────────────────────────────────────────────────

export function recordCalibration(validator, claimedConfidence, actualRealityWeight) {
  if (claimedConfidence == null) return;
  calibLog.push({
    validator,
    claimed:    Number(claimedConfidence),
    actual:     Number(actualRealityWeight),
    divergence: Number(claimedConfidence) - Number(actualRealityWeight),
    timestamp:  new Date().toISOString(),
  });
  if (calibLog.length > MAX_CALIB) calibLog.shift();
}

export function getCalibrationAlert(validator) {
  const recent = calibLog.filter(r => r.validator === validator).slice(-10);
  if (recent.length < 3) return null;
  const avg = recent.reduce((s, r) => s + r.divergence, 0) / recent.length;
  if (avg <= 0.20) return null;
  return {
    alert:         "calibration_drift",
    validator,
    avgDivergence: Math.round(avg * 100) / 100,
    sampleSize:    recent.length,
    message:       `You are consistently overclaiming confidence for "${validator}" by ~${Math.round(avg * 100)}%. Lower claimedConfidence for this validator type.`,
  };
}

export function calibrationReport() {
  const byValidator = {};
  for (const r of calibLog) {
    (byValidator[r.validator] ??= []).push(r.divergence);
  }
  return Object.entries(byValidator).map(([v, divs]) => {
    const avg = divs.reduce((s, d) => s + d, 0) / divs.length;
    return {
      validator:     v,
      samples:       divs.length,
      avgDivergence: Math.round(avg * 100) / 100,
      status:        avg > 0.20 ? "overclaiming" : avg < -0.10 ? "underclaiming" : "calibrated",
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// #10  Sycophancy detection (auto-applied hook)
// ─────────────────────────────────────────────────────────────────────────

export function detectSycophancy(statement) {
  const stmt = String(statement || "");
  for (const pat of SYCOPHANCY_PATTERNS) {
    if (pat.test(stmt)) {
      return {
        sycophancyDetected: true,
        pattern:   pat.toString(),
        rwPenalty: 0.15,
        directive: "Claim appears to be framed as a confirmation request or echo. Verify independently — do not derive the claim from conversation context alone.",
      };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// #11  Consistency vote
// ─────────────────────────────────────────────────────────────────────────

export async function consistencyVote(input, verifyFn) {
  const n     = Math.min(Math.max(Number(input.n || 3), 2), 5);
  const check = input.check;
  if (!check?.validator) throw new Error("check.validator is required");

  const results = [];
  for (let i = 0; i < n; i++) {
    // force:true bypasses the fresh-evidence cache — a consistency vote
    // exists to RE-observe, so cached results would defeat its purpose.
    const r  = await verifyFn({ ...check, force: true });
    const ev = r.evidence || r;
    results.push({
      run:          i + 1,
      verified:     ev.verified     ?? false,
      contradicted: ev.contradicted ?? false,
      realityWeight: ev.realityWeight ?? 0,
    });
  }

  const vCount = results.filter(r => r.verified).length;
  const cCount = results.filter(r => r.contradicted).length;
  const avgRw  = results.reduce((s, r) => s + r.realityWeight, 0) / n;

  if (vCount === n) return { gate: "PROCEED", tactic: "consistency_vote", verdict: "unanimous_verified",     runs: n, avgRealityWeight: avgRw, results };
  if (cCount === n) return { ...halt("consistency_vote", `Claim unanimously contradicted across ${n} runs.`, [], { resumeWhen: "Investigate and correct the underlying issue." }), verdict: "unanimous_contradicted", results };

  return halt(
    "consistency_vote",
    `Inconsistent results across ${n} runs (${vCount} verified, ${cCount} contradicted, ${n - vCount - cCount} inconclusive). Do not assert until consistent.`,
    [{ action: "Investigate why validator results differ. The claim may be ill-formed or the artifact state is non-deterministic." }],
    { verdict: "inconsistent", runs: n, results }
  );
}

// ─────────────────────────────────────────────────────────────────────────
// #13  Human attestation
// ─────────────────────────────────────────────────────────────────────────

export function humanAttest(input) {
  if (!input.claimId)        throw new Error("claimId is required");
  if (input.approved == null) throw new Error("approved (boolean) is required");

  // F3: a "human" attestation callable by the model itself is no attestation.
  // When ANTIPSYC_ATTEST_KEY is set, the caller must present it. The key
  // must be supplied by the human operator out-of-band — never placed in the
  // model's context or system prompt.
  const requiredKey = process.env.ANTIPSYC_ATTEST_KEY;
  if (requiredKey && String(input.operatorKey || "") !== requiredKey) {
    return halt(
      "human_attest",
      "Attestation rejected: missing or invalid operatorKey. Human attestation requires the ANTIPSYC_ATTEST_KEY credential supplied by the operator out-of-band.",
      [{ action: "Ask the human operator to submit the attestation with their operatorKey (e.g. via the web UI or a direct API call)." }]
    );
  }

  const attest = {
    claimId:      String(input.claimId),
    approved:     Boolean(input.approved),
    reason:       String(input.reason || ""),
    operatorNote: input.operatorNote || null,
    attestedAt:   new Date().toISOString(),
    rwDelta:      input.approved ? 0.15 : -1.0,
  };
  attestStore.set(attest.claimId, attest);
  capMap(attestStore);

  return {
    attestation:   attest,
    gate:          input.approved ? "PROCEED" : "HALT",
    tactic:        "human_attest",
    directive:     input.approved
      ? "Human operator approved. realityWeight boosted by +0.15."
      : `Human operator REJECTED: "${input.reason}". Mark this claim as CONTRADICTED. Do not assert.`,
    do_not_assert: !input.approved,
  };
}

export function getAttestation(claimId) {
  return attestStore.get(claimId) || null;
}

// ─────────────────────────────────────────────────────────────────────────
// #14  Plan verification — Chain-of-Verification (CoVe)
// ─────────────────────────────────────────────────────────────────────────

export function planVerification(input) {
  const claim     = String(input.claim || input.statement || "");
  const claimType = String(input.claimType || input.type || "general");
  const paths     = extractFilePaths(claim);
  const urls      = extractUrls(claim);
  const quoted    = extractQuotedStrings(claim);

  const steps = [];
  let i = 1;

  // Also extract bare "contains X" patterns not wrapped in quotes
  const containsMatch = claim.match(/\bcontains?\s+([`"']?)(\w[\w\s]{2,40})\1/i);
  const containsHint  = quoted[0] || containsMatch?.[2] || null;

  for (const p of [...new Set(paths)].slice(0, 5)) {
    steps.push({ step: i++, question: `Does ${p} exist?`,             validator: "filesystem.exists", params: { path: p } });
    if (containsHint) {
      steps.push({ step: i++, question: `Does ${p} contain the expected content?`, validator: "file.contains", params: { path: p, contains: containsHint.slice(0, 80) } });
    }
  }

  for (const u of [...new Set(urls)].slice(0, 3)) {
    steps.push({ step: i++, question: `Does ${u} return HTTP 200?`,   validator: "http.fetch", params: { url: u, expectedStatus: 200 } });
  }

  if (/\b(output|returns?|prints?|computes?|produces?)\b/i.test(claim) || claimType === "code.correctness") {
    steps.push({ step: i++, question: "Does the code produce the expected output?", validator: "code.run", params: { code: "<your_code_here>", expectedOutput: "<expected_output>" } });
  }

  if (/\b(committed?|pushed?|in git|version control)\b/i.test(claim)) {
    steps.push({ step: i++, question: "Does git history confirm this?", validator: "git.log_contains", params: { message: "<commit_message_fragment>" } });
  }

  if (/\b(package|library|module|dependency|installed)\b/i.test(claim)) {
    steps.push({ step: i++, question: "Is the package listed in package.json?", validator: "json.path", params: { path: "package.json", keyPath: "dependencies.<libname>", expected: "<version>" } });
  }

  if (/\b(math|calculate|compute|equals?|result)\b/i.test(claim)) {
    steps.push({ step: i++, question: "Does the arithmetic check out?", validator: "math.evaluate", params: { expression: "<expression>", expected: "<result>" } });
  }

  if (!steps.length) {
    steps.push({ step: 1, question: "What external artifact proves this claim?", validator: "<choose: filesystem.exists | file.contains | code.run | http.fetch | git.log_contains | math.evaluate>", params: {} });
  }

  return {
    tactic:      "plan_verification",
    claim:       claim.slice(0, 200),
    checklistId: randomUUID(),
    step_count:  steps.length,
    steps,
    directive:   `Execute all ${steps.length} verification step(s) using verify_claim. Do not assert this claim until every step returns verified=true.`,
    resume_when: "All steps verified → call gate_check to confirm presentability.",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #16  Semantic challenge
// ─────────────────────────────────────────────────────────────────────────

export function semanticChallenge(input) {
  const statement = String(input.statement || "");
  const validator = String(input.validator || "");
  const stmt      = statement.toLowerCase();
  const challenges = [];

  // Scope mismatch
  for (const [word, narrowList] of Object.entries(SCOPE_MISMATCH)) {
    if (scopeWordInText(stmt, word) && narrowList.includes(validator)) {
      challenges.push({
        type:       "scope_mismatch",
        word,
        validatorProvides: VALIDATOR_DOMAINS[validator] || validator,
        reason:     `"${validator}" can only prove ${VALIDATOR_DOMAINS[validator] || "its specific domain"} — it cannot speak to "${word}".`,
        suggestion: `Remove "${word}" from the claim, or use a validator that can verify qualitative properties.`,
      });
    }
  }

  // Runtime-state claims with non-runtime validators
  if (/\b(running|started|deployed|live|online|up and running)\b/i.test(statement) && !RUNTIME_VALIDATORS.has(validator)) {
    challenges.push({
      type:       "runtime_state_mismatch",
      reason:     `"${validator}" cannot verify runtime state (running/deployed/live). It reads static artifacts.`,
      suggestion: "Use http.fetch to check a live endpoint, or process.run to check a process.",
    });
  }

  // AI-supplied text used for file claims
  if (validator === "text.contains" && /\b(file|path|directory|source|code)\b/i.test(statement)) {
    challenges.push({
      type:       "grounding_weakness",
      reason:     `"text.contains" checks AI-supplied text, not an actual file. The model can fabricate the text field.`,
      suggestion: `Use "file.contains" with a real file path to ground this claim in external reality.`,
    });
  }

  if (!challenges.length) {
    return { challenged: false, statement, validator, message: "No semantic scope violations detected.", domain: VALIDATOR_DOMAINS[validator] || null };
  }

  return {
    challenged:    true,
    statement,
    validator,
    challenges,
    gate:          "HALT",
    tactic:        "semantic_challenge",
    directive:     `${challenges.length} semantic challenge(s): the validator cannot prove what the claim asserts. Resolve before asserting.`,
    do_not_assert: true,
    timestamp:     new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #17  Action trace — Reason → Act → Observe
// ─────────────────────────────────────────────────────────────────────────

export function startActionTrace(input) {
  const trace = {
    id:        randomUUID(),
    claimId:   input.claimId || null,
    purpose:   String(input.purpose || ""),
    cycles:    [],
    startedAt: new Date().toISOString(),
    complete:  false,
  };
  traceStore.set(trace.id, trace);
  capMap(traceStore);
  return { traceId: trace.id, message: "Trace started. Call add_trace_cycle for each Reason → Act → Observe cycle before completing." };
}

export function addTraceCycle(input) {
  const trace = traceStore.get(input.traceId);
  if (!trace)          throw new Error(`Trace "${input.traceId}" not found. Call start_action_trace first.`);
  if (trace.complete)  throw new Error("Trace is already complete.");
  if (!input.reason)      throw new Error("reason is required");
  if (!input.action)      throw new Error("action is required");
  if (input.observation == null) throw new Error("observation is required");

  trace.cycles.push({
    cycle:       trace.cycles.length + 1,
    reason:      String(input.reason),
    action:      String(input.action),
    observation: input.observation,
    timestamp:   new Date().toISOString(),
  });
  traceStore.set(trace.id, trace);
  return { traceId: trace.id, cycleCount: trace.cycles.length, lastCycle: trace.cycles.at(-1) };
}

export function completeActionTrace(input) {
  const trace = traceStore.get(input.traceId);
  if (!trace) throw new Error(`Trace "${input.traceId}" not found.`);

  if (!trace.cycles.length) {
    return halt(
      "action_trace",
      "Cannot complete a trace with zero Reason → Act → Observe cycles. You must record at least one cycle before claiming the action is done.",
      [{ action: "Call add_trace_cycle with reason, action, and observation before completing the trace." }]
    );
  }

  trace.complete    = true;
  trace.completedAt = new Date().toISOString();
  traceStore.set(trace.id, trace);

  return {
    gate:        "PROCEED",
    tactic:      "action_trace",
    traceId:     trace.id,
    purpose:     trace.purpose,
    cycles:      trace.cycles.length,
    completedAt: trace.completedAt,
    summary:     trace.cycles.map(c =>
      `[${c.cycle}] Reason: ${c.reason.slice(0, 50)} → Act: ${c.action.slice(0, 50)} → Observed: ${JSON.stringify(c.observation).slice(0, 60)}`
    ),
  };
}

export function getTrace(traceId) {
  return traceStore.get(traceId) || null;
}

// ─────────────────────────────────────────────────────────────────────────
// #18  Iterative verify
// ─────────────────────────────────────────────────────────────────────────

export async function iterativeVerify(input, verifyFn) {
  const maxRounds = Math.min(Number(input.maxRounds || 3), 5);
  const threshold = Number(input.threshold || 0.75);
  if (!input.validator) throw new Error("validator is required");

  const history = [];
  for (let round = 1; round <= maxRounds; round++) {
    // force:true — each round must re-observe, not replay cached evidence.
    const r  = await verifyFn({ ...input, force: true });
    const ev = r.evidence || r;
    const rw = ev.realityWeight ?? 0;
    history.push({ round, realityWeight: rw, verified: ev.verified ?? false, contradicted: ev.contradicted ?? false });

    // Contradiction must be checked BEFORE the threshold: contradicted
    // evidence carries a HIGH realityWeight ("confidently false"), which the
    // threshold test would otherwise read as success. PROCEED additionally
    // requires verified=true — weight alone is not verification.
    if (ev.verified === true && !ev.contradicted && rw >= threshold) {
      return { gate: "PROCEED", tactic: "iterative_verify", rounds: round, finalRealityWeight: rw, threshold, evidence: ev, history };
    }
    if (ev.contradicted) {
      return {
        ...halt("iterative_verify",
          `Claim CONTRADICTED on round ${round}. Do not retry without investigating.`,
          [{ action: "Investigate why the validator returned contradicted. Correct the claim or the artifact, then retry." }],
          { resumeWhen: "Understand the contradiction. Fix either the claim or the external artifact, then retry." }
        ),
        rounds: round, history, evidence: ev,
      };
    }
  }

  return {
    gate:          "UNVERIFIABLE",
    tactic:        "iterative_verify",
    directive:     `After ${maxRounds} rounds, realityWeight (${history.at(-1).realityWeight.toFixed(2)}) never reached threshold (${threshold}). Disclose uncertainty to the user — do not assert this claim.`,
    do_not_assert: true,
    rounds:        maxRounds,
    threshold,
    history,
    timestamp:     new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #19  Verify execution — returns a ready-made verify_claim call plan
// ─────────────────────────────────────────────────────────────────────────

export function verifyExecution(input) {
  if (!input.code)         throw new Error("code is required");
  if (input.statedOutput == null) throw new Error("statedOutput is required — what the AI claims the code outputs");

  return {
    tactic:    "verify_execution",
    directive: "Execute the verify_claim call below to confirm your stated output is correct. Do not assert until verified.",
    verifyCall: {
      statement:      `Code execution produces: ${String(input.statedOutput).slice(0, 80)}`,
      type:           "code.correctness",
      validator:      "code.run",
      code:           input.code,
      expectedOutput: String(input.statedOutput),
    },
  };
}
