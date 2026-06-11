/**
 * Canonical version history for AntiPsyc.
 * Each entry is the source of truth consumed by GET /api/version
 * and the in-app changelog viewer.
 */

export const changelog = [
  {
    version: "0.1.0",
    label: "v1",
    released: "2026-05-27",
    summary: "Initial MVP release",
    changes: [
      { category: "feature", description: "MCP stdio server exposing submit_claim, verify_claim, verify_interaction, search_evidence, get_claim tools." },
      { category: "feature", description: "HTTP API: GET /api/health, GET /api/claims, GET /api/claims/:id, POST /api/claims, POST /api/verify, POST /api/interactions." },
      { category: "feature", description: "Searchable evidence UI showing claims, status, confidence, and reality-weight pills." },
      { category: "feature", description: "Append-only JSONL evidence ledger with full provenance per record." },
      { category: "feature", description: "Validators: filesystem.exists, filesystem.stat, math.evaluate, http.fetch, text.contains, interaction.chain." },
      { category: "feature", description: "Interaction chain bundles multiple validator checks into one causal evidence record." },
      { category: "feature", description: "Zero npm dependencies — runs with bare Node 18+." },
      { category: "feature", description: "One-command deploy via deploy.ps1 (PowerShell) and deploy.cmd (CMD wrapper)." },
      { category: "feature", description: "Dockerfile for containerised HTTP deployment." }
    ]
  },
  {
    version: "0.2.0",
    label: "v2",
    released: "2026-05-27",
    summary: "Security hardening, concurrency fixes, and in-app changelog",
    changes: [
      {
        category: "security",
        description: "Fixed path traversal in static file server: resolved paths are now verified to lie within web/ before reading (REVIEW #1).",
        ref: "REVIEW #1"
      },
      {
        category: "security",
        description: "Replaced Function() / eval with vm.runInNewContext() in math.evaluate, eliminating the risk of sandbox escape via expression injection (REVIEW #2).",
        ref: "REVIEW #2"
      },
      {
        category: "security",
        description: "Added SSRF protection to http.fetch validator: loopback, RFC-1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16), and IPv6 loopback addresses are blocked (REVIEW #3).",
        ref: "REVIEW #3"
      },
      {
        category: "fix",
        description: "Static file server now returns HTTP 404 (not 500) for missing paths, and error messages no longer leak absolute filesystem paths (REVIEW #7).",
        ref: "REVIEW #7"
      },
      {
        category: "fix",
        description: "Added write mutex to EvidenceStore — concurrent claim creation and evidence appends are now serialised, preventing lost-update races on claims.json (REVIEW #4).",
        ref: "REVIEW #4"
      },
      {
        category: "fix",
        description: "Cached EvidenceStore.init() initialized state — eliminated redundant mkdir and readFile calls on every claim read (REVIEW #5).",
        ref: "REVIEW #5"
      },
      {
        category: "improvement",
        description: "verifyInteraction now executes independent validator checks in parallel via Promise.all instead of a sequential for-await loop (REVIEW #9).",
        ref: "REVIEW #9"
      },
      {
        category: "improvement",
        description: "Frontend fetch calls now handle network errors and non-2xx responses with visible inline error messages instead of silently failing (REVIEW #12).",
        ref: "REVIEW #12"
      },
      {
        category: "improvement",
        description: "Dockerfile CMD changed to --http only (--mcp over stdio is not useful in a container); added ENV NODE_ENV=production (REVIEW #14).",
        ref: "REVIEW #14"
      },
      {
        category: "improvement",
        description: "Added .dockerignore to exclude data/, node_modules/, and markdown files from container image layers (REVIEW #14).",
        ref: "REVIEW #14"
      },
      {
        category: "feature",
        description: "Added GET /api/version endpoint returning full version history, release dates, per-change categories, and review references."
      },
      {
        category: "feature",
        description: "Added in-app changelog viewer accessible from the toolbar — shows all versions and changes without leaving the UI."
      }
    ]
  },
  {
    version: "0.3.0",
    label: "v3",
    released: "2026-05-27",
    summary: "Honest grounding core — new validators, evidence TTL, type enforcement, API auth, batch verification",
    changes: [
      { category: "security",     ref: "C1", description: "file.contains and file.matches validators read files themselves — the AI can no longer pass fabricated text to validate its own claims." },
      { category: "feature",      ref: "C2", description: "code.run validator executes JavaScript in an isolated vm sandbox and asserts on console output." },
      { category: "feature",      ref: "C3", description: "Evidence TTL and confidence decay — stale evidence decays toward realityWeight 0.1 and is marked 'stale' rather than silently trusted forever." },
      { category: "security",     ref: "C4", description: "Validator-type enforcement — claim type now constrains which validators are permitted; mismatched verifications return 'unverifiable' evidence." },
      { category: "security",     ref: "C6", description: "HTTP API key authentication via Authorization: Bearer — set ANTIPSYC_API_KEY in environment to enable." },
      { category: "feature",      ref: "H1", description: "Git validators: git.file_exists, git.contains, git.branch_exists — verify repository state without the AI touching file contents." },
      { category: "feature",      ref: "H2", description: "JSON validators: json.valid and json.path — verify structure and dot-notation key values in JSON files." },
      { category: "feature",      ref: "H3", description: "process.run validator executes commands from an explicit allowlist (ANTIPSYC_ALLOWED_COMMANDS env var); defaults to empty — opt-in only." },
      { category: "security",     ref: "H5", description: "HTTP validator hardened: 5s timeout, 3-redirect limit, DNS-resolution SSRF protection — resolved IPs are checked, closing the DNS rebinding gap from v2." },
      { category: "fix",          ref: "H6", description: "Evidence invalidation chain — every evidence record links to the previous via 'supersedes'; contradictions are preserved, never hidden." },
      { category: "fix",          ref: "H7", description: "Full error taxonomy: verified, contradicted, partial, failed, stale, unverifiable — validator failures no longer silently appear as contradicted." },
      { category: "feature",      ref: "H8", description: "Batch verification: POST /api/verify/batch and verify_batch MCP tool run multiple checks in parallel and return all evidence records." }
    ]
  },
  {
    version: "0.4.0",
    label: "v4",
    released: "2026-05-27",
    summary: "Codebase-scope search, SQLite persistence, claim deduplication, git history validators",
    changes: [
      {
        category: "feature", ref: "G0",
        description: "codebase.contains: searches all files matching a glob pattern (e.g. src/**/*.js) for a substring or regex. Closes the file-scope vs codebase-scope precision gap — the AI can now say 'the project uses X' without knowing which file, and the validator finds it."
      },
      {
        category: "feature", ref: "C5",
        description: "SQLite persistence via node:sqlite (Node 22+): replaces claims.json + evidence.jsonl with a properly indexed SQLite database. First start auto-migrates all existing data. Falls back transparently to the JSON file store on Node < 22."
      },
      {
        category: "feature", ref: "H4",
        description: "Claim deduplication by fingerprint: identical claims (same statement + type, normalised) return the existing live claim instead of creating duplicates. Fingerprint = sha256(trimmed lowercase statement + type). Evidence accumulates on one canonical record."
      },
      {
        category: "feature", ref: "G8",
        description: "git.log_contains: searches recent commit messages for a string. Handles shallow repos (fewer commits than requested depth) with graceful fallback to full history search."
      },
      {
        category: "feature", ref: "G8",
        description: "git.last_modified: returns the commit hash, ISO date, and commit message for the last commit that touched a given file. Covers 'this file hasn't changed in months' and 'this was recently updated' claims."
      },
      {
        category: "feature", ref: "G8",
        description: "git.blame_line: returns the commit hash, author, and date for the last commit that touched a specific line number. Covers 'Alice wrote this function' attribution claims."
      },
      {
        category: "improvement",
        description: "Store factory pattern: createStore() auto-selects SqliteStore (Node 22+) or EvidenceStore (JSON file fallback). Server startup prints which backend is active."
      },
      {
        category: "improvement",
        description: "UI form and validator dropdown updated with all 4 new validators (codebase.contains, git.log_contains, git.last_modified, git.blame_line) including per-validator field hints."
      },
      {
        category: "improvement",
        description: "Claims panel and Evidence panel are now fixed-height and independently scrollable — the UI no longer grows unbounded as the ledger fills."
      },
      {
        category: "feature",
        description: "test-v4-validators.mjs: dedicated 23-case test suite covering all Phase-1 features. 23/23 passing. test-mcp.mjs updated to 0.4.0 — 34/34 passing."
      },
      {
        category: "feature", ref: "U3",
        description: "Claim templates (src/templates.js): 15 named shortcut templates (file-exists, package-version, codebase-has, no-dependency, math-equals, url-returns-200, and more). Smaller models fill simple key-value pairs instead of constructing full validator JSON. GET /api/templates lists the catalog; POST /api/verify/template resolves and runs a template. MCP tool: use_template and get_templates."
      },
      {
        category: "feature", ref: "U2",
        description: "Confidence gate (computeGate): maps realityWeight to a presentability signal — 'verified' (≥0.75, assert confidently), 'caveat' (≥threshold, qualify before asserting), or 'suppress' (disclaim or omit). CONTRADICTED claims always suppress regardless of realityWeight. POST /api/gate (always public). MCP tool: gate_check."
      },
      {
        category: "feature",
        description: "test-deterministic-salvo.mjs: 94-assertion exhaustive probe covering every validator, all 15 templates, the U2 gate workflow, deduplication, type enforcement, SSRF protection, and a full small-model verify→gate→action loop. 94/94 passing."
      }
    ]
  },
  {
    version: "0.5.0",
    label: "v5",
    released: "2026-05-27",
    summary: "Adversarial hardening: claim contracts, relevance firewall, scoped validators, and safe promotion rules",
    changes: [
      {
        category: "security",
        ref: "V5-1",
        description: "Added claim contracts and relevance checks. Validator output must match the claim type and statement payload before it can promote a claim."
      },
      {
        category: "security",
        ref: "V5-2",
        description: "Fail-closed validator permission model. Unknown claim types no longer permit arbitrary validators."
      },
      {
        category: "security",
        ref: "V5-3",
        description: "Filesystem, file, JSON, and codebase validators are restricted to ANTIPSYC_ALLOWED_ROOTS, defaulting to the server working directory."
      },
      {
        category: "security",
        ref: "V5-4",
        description: "User/model supplied text containment is classified as syntactic evidence and cannot verify real-world claims."
      },
      {
        category: "fix",
        ref: "V5-5",
        description: "Claim confidence and reality weight are clamped to 0..1. Caller supplied provisional confidence is no longer allowed to create impossible confidence values."
      },
      {
        category: "fix",
        ref: "V5-6",
        description: "Store promotion rules now respect blocked, irrelevant, syntactic, simulated, failed, and unverifiable evidence statuses instead of treating any verified flag as truth."
      },
      {
        category: "security",
        ref: "V5-7",
        description: "Interaction chains now require causalSchema plus role/source metadata on every check, preventing non-causal checks from verifying physical or operational events."
      },
      {
        category: "test",
        description: "Added test-v5-adversarial.mjs to replay the successful v4 bypasses as regression tests."
      }
    ]
  },
  {
    version: "0.6.0",
    label: "v6",
    released: "2026-05-27",
    summary: "Conscious logic hardening: structured contracts, semantic template persistence, redirect-safe HTTP, and policy-scoped git/process validators",
    changes: [
      {
        category: "security",
        ref: "V6-1",
        description: "Structured claim contracts now compare assertion slots to observed evidence slots. Promotion is no longer based on simple lexical overlap."
      },
      {
        category: "fix",
        ref: "V6-2",
        description: "MCP gate_check now passes verified/contradicted into computeGate, matching the HTTP gate behavior."
      },
      {
        category: "fix",
        ref: "V6-3",
        description: "expectAbsent template semantics are applied before evidence persistence, keeping returned truth and ledger truth aligned."
      },
      {
        category: "security",
        ref: "V6-4",
        description: "HTTP validator now handles redirects manually and checks SSRF/DNS/allowlist policy on every redirect hop."
      },
      {
        category: "security",
        ref: "V6-5",
        description: "Git validators now validate input.repo against ANTIPSYC_ALLOWED_ROOTS."
      },
      {
        category: "security",
        ref: "V6-6",
        description: "process.run supports structured bin/args inputs and allowlisting by exact command or binary."
      },
      {
        category: "security",
        ref: "V6-7",
        description: "Production profile startup now fails unless ANTIPSYC_API_KEY and ANTIPSYC_ALLOWED_ROOTS are configured."
      }
    ]
  },
  {
    version: "0.7.0",
    label: "v7",
    released: "2026-06-10",
    summary: "Protocol compliance, ledger-backed gate, zero-latency caching, contract fairness",
    changes: [
      { category: "fix",      ref: "F1",  description: "MCP stdio transport now emits spec-compliant newline-delimited JSON (was LSP-style Content-Length framing, unreadable by standard MCP clients). Protocol version is negotiated by echoing the client's requested version." },
      { category: "security", ref: "F2",  description: "gate_check accepts a claimId and computes the signal from the evidence ledger itself (attested) instead of trusting caller-supplied realityWeight/verified/contradicted, which a hallucinating model could fabricate." },
      { category: "security", ref: "F3",  description: "human_attest requires the ANTIPSYC_ATTEST_KEY operator credential when configured — the model being policed can no longer attest its own claims." },
      { category: "feature",  ref: "F11", description: "Every verify_claim / use_template / verify_batch / verify_interaction response embeds its gate signal — verdict and presentation guidance in one round trip instead of a second gate_check call." },
      { category: "feature",  ref: "F12", description: "Fresh-evidence cache: re-verifying an identical claim within its TTL returns the ledger evidence instantly (cached:true, ageSeconds) instead of re-running the validator. force:true bypasses; consistency_vote and iterative_verify always re-observe." },
      { category: "fix",      ref: "F5",  description: "Claim contracts use word-boundary scope matching with artifact-term scrubbing ('pass' no longer fires inside Compass.js, 'user' inside user-service.js), and a path slot is satisfied by basename mention — absolute-path claims are no longer demoted to irrelevant." },
      { category: "fix",      ref: "F17", description: "Reasoning/sycophancy realityWeight penalties no longer apply to grounded OBSERVED evidence — a validator that physically observed reality is a posterior; prose-quality priors cannot drag it below the gate band. Warnings still surface in conscienceFlags." },
      { category: "fix",      ref: "F6",  description: "codebase.contains with a glob matching zero files returns status 'failed' (inconclusive) instead of a high-confidence contradiction." },
      { category: "fix",      ref: "F21", description: "retrieval_gate now hydrates claim evidence before gating — it previously always answered MISSING because listClaims does not include evidence arrays." },
      { category: "fix",      ref: "F23", description: "retrieve_and_ground gained a claim contract profile — it previously demoted every result to 'unverifiable' (dead on arrival in v6)." },
      { category: "fix",      ref: "H4",  description: "Unknown self-declaring claim types (e.g. 'code.correctness' without a validator) keep their declared type instead of collapsing to 'general' — restores type-scoped dedup and tightens validator enforcement." },
      { category: "fix",      description: "iterative_verify checks contradiction BEFORE the realityWeight threshold — contradicted evidence carries high weight ('confidently false') and previously returned PROCEED." },
      { category: "security", ref: "F7",  description: "code.run sandbox no longer injects host-realm objects (Math, JSON, Object…) into the vm context, closing the constructor-chain escape path. vm remains a soft boundary; evidence stays capped as 'simulated'." },
      { category: "feature",  ref: "F16", description: "ANTIPSYC_BIND configures the listen address (containers need 0.0.0.0); loopback callers are exempt from rate limiting unless ANTIPSYC_RATE_LIMIT_LOCAL=true." },
      { category: "feature",            description: "ANTIPSYC_ALLOW_LOCAL_HTTP=true permits http.fetch / retrieve_and_ground against loopback ONLY — an agent can verify the dev server it just started. RFC-1918, link-local, and broadcast ranges stay blocked unconditionally." },
      { category: "feature",  ref: "F14", description: "All MCP tools carry annotations (readOnlyHint/destructiveHint/idempotentHint/openWorldHint) so clients can auto-approve pure-query tools; ANTIPSYC_TOOLSET=core exposes a reduced 12-tool surface for token-sensitive clients." },
      { category: "perf",     ref: "F10", description: "Contradiction detection queries only promoted high-confidence claims (indexed, capped) instead of scanning the full ledger on every submission; tool responses use compact JSON; calibration is recorded even on cache hits." },
      { category: "fix",      ref: "F20", description: "Claim reasoning is persisted (SQLite column / JSON field) so re-verification by claimId can see it; intent/trace/attestation session stores are capped at 500 records with FIFO eviction." }
    ]
  },
  {
    version: "0.8.0",
    label: "v8",
    released: "2026-06-10",
    summary: "Forced validation — confirmations mint a fresh gate on the fly",
    changes: [
      { category: "feature", description: "Confirmation detection: an input marked type:\"confirmation\" / confirmation:true, or phrased as a completion/echo claim (\"the migration completed successfully\", \"tests are passing\", \"confirm that…\"), is recognized as a confirmation seeking the system's blessing." },
      { category: "feature", description: "force_validation: a confirmation creates a brand-new validation gate on the fly — a registered gate object (gateId) carrying the concrete verify_claim steps required to ground it. A model's confirmation is never accepted as evidence." },
      { category: "feature", description: "Auto-hook: a confirmation submitted via submit_claim WITHOUT a grounding validator automatically attaches forcedValidation (a HALT gate) to the claim; confirmations already routed through a real validator are left alone." },
      { category: "feature", description: "resolve_forced_gate is STRICT: gate:PROCEED only when EVERY artifact the confirmation names (file, URL, or quoted value) is independently backed by a distinct fresh, grounded, fully-verified record (status \"verified\", realityWeight ≥ 0.75, not expired). Unrelated true facts, partial coverage, and weak/stale/simulated evidence do not satisfy it; any contradiction hard-fails it; and a vague confirmation that names nothing checkable returns UNVERIFIABLE_BY_TOOLS and can never auto-pass. Raise the bar further with ANTIPSYC_FORCED_MIN_RW." },
      { category: "feature", description: "New MCP tools force_validation / resolve_forced_gate / list_forced_gates / get_forced_gate and HTTP routes POST /api/conscience/force-validation, POST /api/conscience/resolve-gate, GET /api/conscience/gates. Orientation gains a confirmations workflow." },
      { category: "fix", description: "extractFilePaths matched a partial extension (\".js\" inside \".json\", \".c\" inside \".cpp\"), so confirmations and pause_and_verify / plan_verification mis-extracted paths like package.json as package.js. Extensions must now be complete." }
    ]
  },
  {
    version: "0.9.0",
    label: "v9",
    released: "2026-06-11",
    summary: "Response-level auditing, stronger validators, and the stale-evidence gate fix",
    changes: [
      { category: "fix", description: "STALE-EVIDENCE GATE FIX: decay is gradual, so a record one minute past its TTL still carried rw ≈ 0.96 and gated as 'verified' for hours after expiry — the gate never consulted the stale status. computeGate is now status-aware: stale evidence caps at 'caveat' (with a re-verify directive) and falls to 'suppress' once decayed, and can never return 'verified'." },
      { category: "feature", description: "audit_response (POST /api/audit): lint a whole draft before sending — extracts every checkable claim, verifies each with a real validator, and returns verdict OK or REVISE with the grounded / contradicted / unverified breakdown. The natural integration point: audit before you answer." },
      { category: "feature", description: "extract_claims (POST /api/extract): deterministic, no-LLM extractor that turns free text into ready-to-run verify_claim payloads (files, file content, exported symbols, URLs, package version, arithmetic), sentence-scoped so each artifact stays paired with what is asserted about it." },
      { category: "feature", description: "First-class expectAbsent on verify_claim: assert that a target is ABSENT (verified = absent), e.g. file.contains + expectAbsent to prove a dependency is NOT present. Previously only the no-dependency template had this." },
      { category: "feature", description: "New grounded validators: http.json_path (assert a dot-path value in a JSON response body, not just status 200); file.hash (sha256/sha1/sha512/md5 content hash, optionally compared); symbol.exists (a symbol is DECLARED/exported, not merely present as a substring); glob.count (number of files matching a glob vs an expected count). Each has a full contract profile, TTL, and type enforcement." },
      { category: "fix", description: "extractFilePaths now requires complete extensions everywhere, improving claim extraction for confirmations, pause_and_verify, plan_verification, and the new extract_claims/audit_response tools." }
    ]
  }
];

export const currentVersion = changelog.at(-1).version;
export const currentLabel   = changelog.at(-1).label;
