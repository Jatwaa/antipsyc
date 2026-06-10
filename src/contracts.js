import { resolve, relative, isAbsolute, basename as pathBasename } from "node:path";

const REAL_WORLD_WORDS = [
  "database", "production", "admin", "user", "robot", "moved", "physical",
  "sensor", "camera", "world", "moon", "cheese", "server", "endpoint",
  "file", "directory", "path", "package", "json", "git", "commit", "branch"
];

const VALIDATOR_PROFILES = {
  "filesystem.exists": {
    status: "observed",
    claimTypes: ["filesystem.exists"],
    requiredSlots: ["path"]
  },
  "filesystem.stat": {
    status: "observed",
    claimTypes: ["filesystem.stat"],
    requiredSlots: ["path"]
  },
  "file.contains": {
    status: "observed",
    claimTypes: ["filesystem.content", "text.assertion"]
  },
  "file.matches": {
    status: "observed",
    claimTypes: ["filesystem.content", "text.assertion"]
  },
  "math.evaluate": {
    status: "syntactic",
    claimTypes: ["math.assertion"],
    requiredSlots: ["expression", "expected"]
  },
  "http.fetch": {
    status: "observed",
    claimTypes: ["http.reachability", "http.response"]
  },
  "text.contains": {
    status: "syntactic",
    claimTypes: ["text.assertion"],
    selfSupplied: true
  },
  "code.run": {
    status: "simulated",
    claimTypes: ["code.correctness"],
    requiredSlots: ["expectedOutput"]
  },
  "process.run": {
    status: "observed",
    claimTypes: ["process.assertion"],
    requiredSlots: ["command"]
  },
  "git.file_exists": {
    status: "observed",
    claimTypes: ["git.file"]
  },
  "git.contains": {
    status: "observed",
    claimTypes: ["git.file"]
  },
  "git.branch_exists": {
    status: "observed",
    claimTypes: ["git.branch"]
  },
  "json.valid": {
    status: "observed",
    claimTypes: ["json.structure"]
  },
  "json.path": {
    status: "observed",
    claimTypes: ["json.structure"]
  },
  "codebase.contains": {
    status: "observed",
    claimTypes: ["codebase.search"]
  },
  "git.log_contains": {
    status: "observed",
    claimTypes: ["git.history"]
  },
  "git.last_modified": {
    status: "observed",
    claimTypes: ["git.history"]
  },
  "git.blame_line": {
    status: "observed",
    claimTypes: ["git.history"]
  },
  "interaction.chain": {
    status: "observed",
    claimTypes: ["interaction.chain"],
    requiredSlots: ["causalSchema"]
  },
  // F23: retrieve_and_ground shipped in v6 without a contract profile, so
  // every result was demoted "unverifiable" — the validator was dead on
  // arrival. It fetches a real URL (observed); its weak term-frequency
  // grounding is already expressed through the validator's rw cap (≤ 0.78).
  "retrieve_and_ground": {
    status: "observed",
    claimTypes: ["retrieve.grounding"],
    requiredSlots: ["claim"]
  }
};

export function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function normalizeClaimType(inputType, validator) {
  if (!inputType || inputType === "general") {
    return defaultClaimTypeForValidator(validator);
  }
  if (inputType === validator) {
    // Self-declaring validator name (type "filesystem.exists" + validator
    // "filesystem.exists") maps to that validator's claim type. But a CLAIM
    // TYPE with no validator profile (e.g. "code.correctness" submitted
    // without a validator) must keep its declared type — collapsing it to
    // "general" broke type-scoped dedup AND loosened validator enforcement.
    const profile = profileForValidator(validator);
    return profile?.claimTypes?.[0] || inputType;
  }
  return inputType;
}

export function defaultClaimTypeForValidator(validator) {
  const profile = VALIDATOR_PROFILES[validator];
  return profile?.claimTypes?.[0] || "general";
}

export function profileForValidator(validator) {
  return VALIDATOR_PROFILES[validator] || null;
}

export function assessClaimEvidence({ claim, input, validator, evidence }) {
  const profile = profileForValidator(validator);
  if (!profile) {
    return demote(evidence, "unverifiable", "No claim contract exists for this validator.");
  }

  if (["blocked", "failed", "unverifiable"].includes(evidence.status)) {
    return {
      ...evidence,
      verified: false,
      contradicted: false,
      confidence: clamp01(evidence.confidence),
      realityWeight: clamp01(evidence.realityWeight),
      result: {
        ...evidence.result,
        evidenceClass: evidence.status,
        promotionBlocked: true
      }
    };
  }

  if (evidence.contradicted && String(evidence.result?.error || "").includes("SSRF protection")) {
    return {
      ...evidence,
      status: "contradicted",
      confidence: clamp01(evidence.confidence),
      realityWeight: clamp01(evidence.realityWeight),
      result: {
        ...evidence.result,
        evidenceClass: "policy_contradiction",
        relevance: "network policy directly contradicts reachability claim"
      }
    };
  }

  if (!profile.claimTypes.includes(claim.type)) {
    return demote(
      evidence,
      "irrelevant",
      `Validator "${validator}" is not contracted to verify claim type "${claim.type}".`
    );
  }

  const relevance = statementRelevance(claim.statement, input, validator, profile, evidence);
  if (!relevance.ok) {
    return demote(evidence, "irrelevant", relevance.reason);
  }

  if (profile.selfSupplied) {
    return {
      ...evidence,
      verified: false,
      contradicted: false,
      status: "syntactic",
      confidence: Math.min(clamp01(evidence.confidence), 0.55),
      realityWeight: Math.min(clamp01(evidence.realityWeight), 0.25),
      result: {
        ...evidence.result,
        evidenceClass: "self_supplied_syntactic",
        promotionBlocked: true,
        note: "User/model supplied text can prove string containment, not real-world truth."
      }
    };
  }

  if (profile.status === "syntactic" && containsRealWorldScope(claim.statement)) {
    return demote(
      evidence,
      "irrelevant",
      "A syntactic validator cannot promote a broad real-world claim."
    );
  }

  if (profile.status === "simulated") {
    return {
      ...evidence,
      status: evidence.verified ? "simulated" : evidence.contradicted ? "contradicted" : evidence.status,
      realityWeight: Math.min(clamp01(evidence.realityWeight), 0.7),
      result: { ...evidence.result, evidenceClass: "simulated" }
    };
  }

  return {
    ...evidence,
    status: evidence.verified ? "verified" : evidence.contradicted ? "contradicted" : evidence.status,
    confidence: clamp01(evidence.confidence),
    realityWeight: clamp01(evidence.realityWeight),
    result: {
      ...evidence.result,
      evidenceClass: profile.status,
      relevance: relevance.reason || "contract matched"
    }
  };
}

export function isPromotableEvidence(evidence) {
  return evidence.status === "verified" || evidence.status === "contradicted";
}

export function buildClaimContract(statement, input = {}) {
  const validator = input.validator || input.type || "general";
  const type = normalizeClaimType(input.type, validator);
  const assertion = extractAssertionSlots(statement, input, validator);
  return {
    version: 1,
    type,
    validator,
    assertion,
    requiredSlots: VALIDATOR_PROFILES[validator]?.requiredSlots || []
  };
}

export function validateLocalPath(pathValue, validator) {
  if (!pathValue) return { ok: false, status: "failed", error: "path is required" };
  const candidate = resolve(String(pathValue));
  const roots = allowedRoots();
  const allowed = roots.some((root) => isInside(candidate, root));
  if (!allowed) {
    return {
      ok: false,
      status: "blocked",
      error: `Path is outside allowed roots for ${validator}.`,
      path: redactPath(candidate),
      allowedRoots: roots.map(redactPath)
    };
  }
  return { ok: true, path: candidate };
}

export function validateBaseDir(baseDir) {
  return validateLocalPath(baseDir || process.cwd(), "codebase.contains");
}

function allowedRoots() {
  const configured = String(process.env.ANTIPSYC_ALLOWED_ROOTS || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return (configured.length ? configured : [process.cwd()]).map((item) => resolve(item));
}

function isInside(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function statementRelevance(statement, input, validator, profile, evidence) {
  const text = String(statement || "").toLowerCase();
  // F5a: scrub artifact identifiers (the verified path/glob/url/branch…) out
  // of the statement before scope scanning, so a file literally named
  // "user-service.js" or "production.config.js" is not mistaken for a
  // qualitative real-world claim. Search terms (contains/pattern/message) are
  // deliberately NOT scrubbed — a smuggled qualitative word must not become
  // excusable by also searching for that word.
  const scrubbed = scrubArtifactTerms(text, input);
  const unsupported = unsupportedScopeReason(scrubbed, validator);
  if (unsupported) return { ok: false, reason: unsupported };
  const assertion = extractAssertionSlots(statement, input, validator);
  const observed = extractObservedSlots(evidence, validator);
  const structural = compareSlots(assertion, observed, validator, profile.requiredSlots || []);
  if (!structural.ok) return structural;
  if (structural.strong) return structural;

  // F5b: a path slot is satisfied by mentioning the basename OR the full
  // path. Previously the raw (often absolute) path string was required
  // verbatim alongside the basename, demoting honest claims to irrelevant.
  if (input.path !== undefined && input.path !== null && !mentionsPath(text, input.path)) {
    return { ok: false, reason: "Statement must mention the verified file path or its basename." };
  }
  const pathForms = new Set([
    String(input.path || "").toLowerCase(),
    basename(input.path).toLowerCase()
  ]);
  const payloadTerms = payloadRelevanceTerms(input, validator)
    .map((term) => String(term || "").toLowerCase())
    .filter((term) => term.length >= 3 && !pathForms.has(term));

  if (!payloadTerms.length && input.path !== undefined && input.path !== null) {
    return { ok: true, strong: false, reason: "statement references the verified file path" };
  }
  if (payloadTerms.length && payloadTerms.every((term) => text.includes(term))) {
    return { ok: true, strong: false, reason: "statement references all required validator payload terms" };
  }

  return {
    ok: false,
    reason: `Claim statement does not satisfy the structured contract for ${validator}.`
  };
}

// F5a: remove the verified artifact's own identifiers from the statement
// before scanning for qualitative scope words.
function scrubArtifactTerms(text, input) {
  const terms = [input.path, basename(input.path), input.glob, input.url, input.keyPath, input.branch]
    .map((t) => String(t || "").toLowerCase().replace(/\\/g, "/"))
    .filter((t) => t.length >= 3);
  let out = text.replace(/\\/g, "/");
  for (const term of terms) out = out.split(term).join(" ");
  return out;
}

// F5a: word-boundary scope matching. "pass" must not fire inside "Compass",
// "user" must not fire inside "user-service". Hyphen/underscore-joined
// identifiers are treated as single words; tokens with non-word characters
// (e.g. "http://") fall back to substring matching.
function scopeWordHit(text, word) {
  if (!/^[a-z0-9_-]+$/i.test(word)) return text.includes(word);
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w-])${esc}(?:[^\\w-]|$)`, "i").test(text);
}

// Qualitative assertion words that a 2B model commonly smuggles in front of verifiable facts.
// These words indicate the REAL claim is about a broader state that the validator cannot prove.
const QUALITATIVE_SCOPE_WORDS = [
  "secure", "security", "safe", "safely", "audit", "audited",
  "healthy", "health", "correct", "correctly", "complete", "compliant", "compliance",
  "pass", "passed", "passing", "clean", "verified", "strong",
  "remediated", "patched", "fixed", "resolved", "deployed", "operational",
  "successful", "succeeded", "functional", "stable", "ready", "approved"
];

function unsupportedScopeReason(text, validator) {
  const BASE_PHYSICAL = ["database", "production", "admin", "user", "robot", "moved", "physical",
    "sensor", "camera", "moon", "cheese"];
  const scopeWordsByValidator = {
    "filesystem.exists": [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS, "http://", "https://"],
    "filesystem.stat":   [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS, "http://", "https://"],
    "file.contains":     [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "file.matches":      [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "json.valid":        [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "json.path":         [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "codebase.contains": [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "git.file_exists":   [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "git.contains":      [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "git.last_modified": [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "git.blame_line":    [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "git.log_contains":  [...BASE_PHYSICAL, ...QUALITATIVE_SCOPE_WORDS],
    "math.evaluate":     REAL_WORLD_WORDS
  };
  const unsupported = scopeWordsByValidator[validator] || [];
  const hit = unsupported.find((word) => scopeWordHit(text, word));
  return hit ? `Claim contains unsupported scope "${hit}" for ${validator}. Split the claim and verify that part separately.` : null;
}

function extractAssertionSlots(statement, input, validator) {
  const text = String(statement || "");
  switch (validator) {
    case "filesystem.exists":
    case "filesystem.stat":
    case "file.contains":
    case "file.matches":
    case "json.valid":
    case "json.path":
    case "git.file_exists":
    case "git.contains":
    case "git.last_modified":
    case "git.blame_line":
      return {
        path: canonicalPathLike(input.path),
        pathMentioned: mentionsPath(text, input.path),
        contains: input.contains,
        pattern: input.pattern,
        keyPath: input.keyPath
      };
    case "math.evaluate":
      return {
        expression: normalizeMath(input.expression),
        expected: normalizeComparable(input.expected)
      };
    case "http.fetch":
      return {
        url: normalizeUrl(input.url),
        expectedStatus: normalizeComparable(input.expectedStatus || 200)
      };
    case "text.contains":
      return { contains: String(input.contains || "") };
    case "codebase.contains":
      return { glob: input.glob, contains: input.contains, pattern: input.pattern };
    case "git.log_contains":
      return { message: input.message };
    case "git.branch_exists":
      return { branch: input.branch };
    case "process.run":
      return { command: String(input.command || input.bin || "") };
    case "code.run":
      return { expectedOutput: String(input.expectedOutput ?? "") };
    case "interaction.chain":
      return { causalSchema: String(input.causalSchema || input.schema || "") };
    case "retrieve_and_ground":
      return { claim: String(input.claim || "") };
    default:
      return {};
  }
}

function extractObservedSlots(evidence, validator) {
  const result = evidence?.result || {};
  switch (validator) {
    case "filesystem.exists":
    case "filesystem.stat":
    case "file.contains":
    case "file.matches":
    case "json.valid":
    case "json.path":
    case "git.file_exists":
    case "git.contains":
    case "git.last_modified":
    case "git.blame_line":
      return {
        path: canonicalPathLike(result.path),
        contains: result.contains,
        pattern: result.pattern,
        keyPath: result.keyPath
      };
    case "math.evaluate":
      return {
        expression: normalizeMath(result.expression),
        expected: normalizeComparable(result.expected)
      };
    case "http.fetch":
      return {
        url: normalizeUrl(result.url),
        expectedStatus: normalizeComparable(result.expectedStatus)
      };
    case "text.contains":
      return { contains: result.contains };
    case "codebase.contains":
      return { glob: result.glob, contains: result.contains, pattern: result.pattern };
    case "git.log_contains":
      return { message: result.message };
    case "git.branch_exists":
      return { branch: result.branch };
    case "process.run":
      return { command: String(result.command || "") };
    case "code.run":
      return { expectedOutput: String(result.expected ?? "") };
    case "interaction.chain":
      return { causalSchema: String(result.causalSchema || "") };
    case "retrieve_and_ground":
      return { claim: String(result.claim || "") };
    default:
      return {};
  }
}

function compareSlots(assertion, observed, validator, requiredSlots) {
  for (const slot of requiredSlots) {
    if (assertion[slot] === undefined || assertion[slot] === null || assertion[slot] === "") {
      return { ok: false, reason: `Claim contract missing required assertion slot "${slot}".` };
    }
    if (observed[slot] !== undefined && observed[slot] !== null && observed[slot] !== "" &&
        String(assertion[slot]) !== String(observed[slot])) {
      return { ok: false, reason: `Claim assertion slot "${slot}" does not match observed evidence.` };
    }
  }
  if (["filesystem.exists", "filesystem.stat", "file.contains", "file.matches", "json.valid", "json.path"].includes(validator)) {
    if (!assertion.pathMentioned) {
      return { ok: false, reason: "Filesystem-style claims must mention the exact file path or basename being verified." };
    }
  }
  if (validator === "http.fetch" && !assertion.url) {
    return { ok: false, reason: "HTTP claims must include the target URL in the assertion contract." };
  }
  return { ok: true, strong: requiredSlots.length > 0, reason: "structured claim contract matched observed evidence" };
}

function payloadRelevanceTerms(input, validator) {
  switch (validator) {
    case "math.evaluate": return [input.expression, input.expected];
    case "filesystem.exists":
    case "filesystem.stat":
    case "file.contains":
    case "file.matches":
    case "git.file_exists":
    case "git.contains":
    case "json.valid":
    case "json.path":
    case "git.last_modified":
    case "git.blame_line":
      return [input.path, basename(input.path), input.contains, input.pattern, input.keyPath];
    case "http.fetch": return [input.url, input.expectedStatus];
    case "text.contains": return [input.contains];
    case "codebase.contains": return [input.glob, input.contains, input.pattern];
    case "git.log_contains": return [input.message];
    case "git.branch_exists": return [input.branch];
    case "code.run": return [input.expectedOutput].filter(v => v !== undefined && v !== null);
    case "process.run": return [input.command || input.bin].filter(Boolean);
    case "interaction.chain": return [input.causalSchema || input.schema].filter(Boolean);
    default: return [];
  }
}

function basename(pathValue) {
  return String(pathValue || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

function canonicalPathLike(pathValue) {
  if (!pathValue) return "";
  try { return resolve(String(pathValue)).toLowerCase(); }
  catch { return String(pathValue).toLowerCase(); }
}

function mentionsPath(statement, pathValue) {
  if (!pathValue) return false;
  const text = statement.toLowerCase().replace(/\\/g, "/");
  const raw = String(pathValue).toLowerCase().replace(/\\/g, "/");
  const base = pathBasename(raw).toLowerCase();
  return text.includes(raw) || (base.length >= 3 && text.includes(base));
}

function normalizeMath(value) {
  return String(value || "").replace(/\s+/g, "");
}

function normalizeComparable(value) {
  if (value === undefined || value === null) return "";
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value);
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    return url.toString();
  } catch {
    return String(value || "");
  }
}

function containsRealWorldScope(statement) {
  const text = String(statement || "").toLowerCase();
  return REAL_WORLD_WORDS.some((word) => scopeWordHit(text, word));
}

function demote(evidence, status, reason) {
  return {
    ...evidence,
    verified: false,
    contradicted: false,
    status,
    confidence: 0,
    realityWeight: status === "blocked" ? 0 : 0.05,
    result: {
      ...evidence.result,
      promotionBlocked: true,
      evidenceClass: status,
      reason
    }
  };
}

function redactPath(pathValue) {
  const text = String(pathValue || "");
  const cwd = process.cwd();
  if (text.startsWith(cwd)) return text;
  return text.replace(/^([A-Za-z]:\\|\/).*/, "[redacted-outside-allowed-root]");
}
