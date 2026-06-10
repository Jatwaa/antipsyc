/**
 * U3 — Claim Templates for Common AI Errors
 *
 * Pre-built templates that map natural-language claim patterns to full
 * validator argument objects. A smaller model can submit:
 *   { template: "package-version", fill: { version: "0.4.0" } }
 * without constructing the full validator JSON.
 *
 * U2 — Confidence Gate
 * Maps a realityWeight to a presentability signal so a model knows
 * whether to assert, caveat, or suppress a claim before presenting it.
 */

// ── U3: Template registry ──────────────────────────────────────────────────
export const CLAIM_TEMPLATES = {

  // ── Filesystem ─────────────────────────────────────────────────────────
  "file-exists": {
    description: "Check whether a file or directory exists at a given path.",
    fill: ["path"],
    example: { path: "src/server.js" },
    build: ({ path }) => ({ validator: "filesystem.exists", path })
  },

  "file-contains": {
    description: "Check whether a file contains a specific substring.",
    fill: ["path", "contains"],
    example: { path: "src/server.js", contains: "createServer" },
    build: ({ path, contains }) => ({ validator: "file.contains", path, contains })
  },

  "file-matches": {
    description: "Check whether a file matches a regex pattern.",
    fill: ["path", "pattern"],
    example: { path: "src/server.js", pattern: "import.*http" },
    build: ({ path, pattern }) => ({ validator: "file.matches", path, pattern })
  },

  // ── Code ───────────────────────────────────────────────────────────────
  "code-output": {
    description: "Run JavaScript and assert on console.log output.",
    fill: ["code", "expected"],
    example: { code: "console.log(2 + 2)", expected: "4" },
    build: ({ code, expected }) => ({ validator: "code.run", code, expectedOutput: expected })
  },

  // ── Package / JSON ──────────────────────────────────────────────────────
  "package-version": {
    description: "Check that package.json declares a specific version string.",
    fill: ["version"],
    example: { version: "0.4.0" },
    build: ({ version }) => ({
      validator: "json.path",
      path: "package.json",
      keyPath: "version",
      expected: version
    })
  },

  "package-name": {
    description: "Check the package name in package.json.",
    fill: ["name"],
    example: { name: "antipsyc" },
    build: ({ name }) => ({
      validator: "json.path",
      path: "package.json",
      keyPath: "name",
      expected: name
    })
  },

  "json-key": {
    description: "Assert the value of any dot-notation key in any JSON file.",
    fill: ["path", "keyPath", "expected"],
    example: { path: "package.json", keyPath: "license", expected: "MIT" },
    build: ({ path, keyPath, expected }) => ({ validator: "json.path", path, keyPath, expected })
  },

  "has-dependency": {
    description: "Check whether a library appears as a dependency in package.json.",
    fill: ["lib"],
    example: { lib: "express" },
    build: ({ lib }) => ({
      validator: "file.contains",
      path: "package.json",
      contains: `"${lib}"`
    })
  },

  "no-dependency": {
    description: "Verify a library is NOT in package.json dependencies. Returns verified when the library is absent.",
    fill: ["lib"],
    example: { lib: "express" },
    expectAbsent: true,     // flip verified↔contradicted so "absent = verified"
    build: ({ lib }) => ({
      validator: "file.contains",
      path: "package.json",
      contains: `"${lib}"`
    })
  },

  // ── Codebase search ────────────────────────────────────────────────────
  "codebase-has": {
    description: "Check whether any source file matching a glob contains a substring.",
    fill: ["glob", "contains"],
    example: { glob: "src/**/*.js", contains: "createServer" },
    build: ({ glob, contains }) => ({ validator: "codebase.contains", glob, contains })
  },

  "codebase-matches": {
    description: "Check whether any source file matching a glob matches a regex pattern.",
    fill: ["glob", "pattern"],
    example: { glob: "src/**/*.js", pattern: "import.*http" },
    build: ({ glob, pattern }) => ({ validator: "codebase.contains", glob, pattern })
  },

  // ── Git history ────────────────────────────────────────────────────────
  "git-commit-has": {
    description: "Check whether a recent commit message contains a given string.",
    fill: ["message"],
    example: { message: "feat:" },
    build: ({ message }) => ({ validator: "git.log_contains", message })
  },

  "git-file-touched": {
    description: "Return the last commit date/hash for a file (verifies the file has git history).",
    fill: ["path"],
    example: { path: "src/server.js" },
    build: ({ path }) => ({ validator: "git.last_modified", path })
  },

  // ── Math ───────────────────────────────────────────────────────────────
  "math-equals": {
    description: "Evaluate an arithmetic expression and assert the result.",
    fill: ["expression", "expected"],
    example: { expression: "2 ** 10", expected: "1024" },
    build: ({ expression, expected }) => ({
      validator: "math.evaluate",
      expression,
      expected: Number(expected)
    })
  },

  // ── Network ────────────────────────────────────────────────────────────
  "url-returns-200": {
    description: "Check that a URL responds with HTTP 200.",
    fill: ["url"],
    example: { url: "https://example.com" },
    build: ({ url }) => ({ validator: "http.fetch", url, expectedStatus: 200 })
  }
};

/**
 * Resolve a template into a verify_claim-compatible argument object.
 * @param {string} templateId
 * @param {Record<string,string>} fill
 * @param {string|null} [statement]
 * @returns {{ statement, validator, expectAbsent, ...validatorArgs }}
 */
export function resolveTemplate(templateId, fill = {}, statement = null) {
  const tmpl = CLAIM_TEMPLATES[templateId];
  if (!tmpl) {
    const ids = Object.keys(CLAIM_TEMPLATES).join(", ");
    throw new Error(`Unknown template "${templateId}". Available: ${ids}`);
  }

  const missing = tmpl.fill.filter(k =>
    fill[k] === undefined || fill[k] === null || String(fill[k]).trim() === ""
  );
  if (missing.length) {
    throw new Error(
      `Template "${templateId}" requires fill fields: ${missing.join(", ")}. ` +
      `Received: ${JSON.stringify(fill)}`
    );
  }

  const validatorArgs = tmpl.build(fill);
  const autoStatement = statement ||
    `[${templateId}] ` +
    [
      ...Object.entries(fill).map(([k, v]) => `${k}=${v}`),
      ...Object.entries(validatorArgs)
        .filter(([k, v]) => ["path", "contains", "pattern", "keyPath", "url", "expectedStatus", "glob", "message", "branch"].includes(k) && v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${v}`)
    ].join(", ");

  return {
    statement: autoStatement,
    expectAbsent: tmpl.expectAbsent || false,
    ...validatorArgs
  };
}

// ── U2: Confidence gate ────────────────────────────────────────────────────
// realityWeight bands:
//   ≥ 0.75  → "verified"  — assert confidently
//   ≥ 0.40  → "caveat"    — present with qualifier
//   < 0.40  → "suppress"  — disclaim or omit

const GATE_BANDS = [
  {
    minRw: 0.75,
    gate: "verified",
    label: "Assert confidently",
    suggestion: null
  },
  {
    minRw: 0.40,
    gate: "caveat",
    label: "Qualify before asserting",
    suggestion:
      "Partial verification. Qualify with 'based on available evidence' or note the confidence level."
  },
  {
    minRw: 0,
    gate: "suppress",
    label: "Disclaim or omit",
    suggestion:
      "Claim could not be verified. Preface with 'I believe' or 'I'm not certain', " +
      "or omit until external confirmation is available."
  }
];

/**
 * U2: Compute the presentability gate for a given realityWeight.
 *
 * Pass `verified` and `contradicted` from the evidence record for accurate
 * signals — a CONTRADICTED claim with high realityWeight means "confidently
 * false", which should always suppress the original assertion.
 *
 * @param {number}       realityWeight
 * @param {number}       [threshold=0.40]  Minimum rw for a "caveat" signal
 * @param {boolean|null} [verified=null]   evidence.verified
 * @param {boolean|null} [contradicted=null] evidence.contradicted
 * @returns {{ gate, label, realityWeight, threshold, suggestion }}
 */
export function computeGate(realityWeight, threshold = 0.40, verified = null, contradicted = null) {
  // Clamp realityWeight to [0, 1] — reject fabricated out-of-range values
  const raw = Number(realityWeight ?? 0);
  const rw  = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  const th  = Number(threshold ?? 0.40);

  // A CONTRADICTED result means "we are confident the claim is FALSE".
  // No matter how high the realityWeight, the original claim should be suppressed.
  if (contradicted === true) {
    return {
      ...GATE_BANDS[2],
      realityWeight: rw,
      threshold: th,
      suggestion:
        "This claim was CONTRADICTED by evidence. Do not assert it. " +
        "If relevant, you may note that it was checked and found to be false."
    };
  }

  // Require explicit verified=true to assert confidently.
  // If neither verified nor contradicted is supplied, treat as unresolved → suppress.
  if (verified !== true) {
    return {
      ...GATE_BANDS[2],
      realityWeight: rw,
      threshold: th,
      suggestion:
        "Evidence flags (verified/contradicted) were not provided. " +
        "Pass the verified and contradicted fields from your evidence record before asserting."
    };
  }

  // A VERIFIED result uses realityWeight to grade confidence level.
  if (rw >= 0.75) return { ...GATE_BANDS[0], realityWeight: rw, threshold: th };
  if (rw >= th)   return { ...GATE_BANDS[1], realityWeight: rw, threshold: th };
  return             { ...GATE_BANDS[2], realityWeight: rw, threshold: th };
}
