# AntiPsyc

**Claims remain provisional until tools produce evidence.**

AntiPsyc is an anti-hallucination validation layer for AI systems. It sits between a model and the outside world and enforces one rule: nothing a model asserts is accepted as true until an external, grounded validator has checked it and produced an immutable, append-only evidence record.

A model that says "the file exists," "the API returns 200," or "the test passes" is making a claim. AntiPsyc treats every such statement as a hypothesis. Only after a real tool — reading the filesystem, making an HTTP request, running code — produces a matching result does the claim earn a confidence score, a reality weight, and permission to be presented to a user.

---

## The Problem It Solves

Large language models — and especially smaller, faster models — routinely assert things that are not true. They confuse memory with observation, simulation with measurement, and fluency with fact. A model that "remembers" a file existed may not know it was deleted. A model that "knows" the API returns 200 may not have checked since the service went down. A model that says tests pass may be extrapolating from patterns, not running them.

The failure mode is not lying. It is not knowing the difference between believing and knowing.

AntiPsyc makes that difference structural. A claim without evidence cannot reach a user as fact. A claim with contradicted evidence is permanently marked as false. A claim with stale evidence decays toward uncertainty rather than staying confidently cached. The model may propose anything; validators must confirm everything.

---

## How It Works

### The Claim Lifecycle

```
Model asserts something
        │
        ▼
  submit_claim / verify_claim
        │
        ▼
  Claim stored as "provisional"
  realityWeight = 0.1
        │
        ▼
  Validator runs against the real world
  (filesystem, git, HTTP, math, code…)
        │
        ▼
  Evidence record created
  status: verified | contradicted | failed | blocked | syntactic | simulated
        │
        ▼
  Claim promoted or demoted
  realityWeight updated (0 – 1)
        │
        ▼
  gate_check → verified | caveat | suppress
        │
        ▼
  Model presents result with correct confidence
```

### Three Core Concepts

**Claims** are statements submitted by a model or caller. Every claim gets a `type` (what kind of thing is being asserted), a `status` (where it stands in the evidence pipeline), a `confidence` score, and a `realityWeight` — a number from 0 to 1 representing how well-grounded in external reality the claim currently is. Claims start at `realityWeight 0.1` and can only go higher through verified evidence.

**Evidence records** are immutable. Every validator run appends a new record to the claim's history. Records are never deleted. Superseded records link to their successors. The full chain is readable at any time, so you can see exactly how a claim's confidence evolved and which validator runs drove each change.

**The gate** translates a raw `realityWeight` into a presentability signal: `verified` (assert confidently, rw ≥ 0.75), `caveat` (qualify before asserting, rw ≥ 0.4), or `suppress` (disclaim or omit). A contradicted claim always suppresses regardless of its realityWeight. The gate requires the caller to pass the `verified` and `contradicted` flags from the evidence record — if those flags are absent, the gate defaults to `suppress` rather than assuming optimism.

---

## Evidence Statuses

| Status | Meaning |
|--------|---------|
| `provisional` | No validator has run yet. This is the starting state. |
| `verified` | A grounded validator confirmed the claim against external reality. |
| `contradicted` | A grounded validator found the claim to be false. |
| `syntactic` | The evidence is self-supplied text — it proves string containment, not real-world truth. realityWeight capped at 0.25. |
| `simulated` | A code sandbox ran but cannot prove external state. realityWeight capped at 0.7. |
| `stale` | The evidence has expired past its TTL. realityWeight decays toward 0.1 over 24 hours. |
| `irrelevant` | The validator's evidence does not match the scope of the claim. |
| `blocked` | A security policy (path restriction, SSRF guard) prevented the validator from running. |
| `failed` | The validator could not execute (e.g. file not found, git error, network timeout). |
| `unverifiable` | No permitted validator exists for this claim type. |
| `partial` | An interaction chain ran but not all sub-checks verified. |

---

## Validators

Each validator corresponds to a grounded check against external state. The claim type constrains which validators may be used — you cannot verify a filesystem claim with an HTTP validator, and you cannot verify an HTTP claim with a text assertion.

### Filesystem

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `filesystem.exists` | `filesystem.exists` | Whether a path exists on disk. |
| `filesystem.stat` | `filesystem.stat` | File or directory metadata: size, timestamps, type. |
| `file.contains` | `filesystem.content` | Reads the file and checks for a substring. The validator reads the file itself — the model cannot supply the text. |
| `file.matches` | `filesystem.content` | Reads the file and tests a regex pattern. Trivially-matching patterns (those that match the empty string) are rejected. Pattern execution is sandboxed against ReDoS. |

### JSON and Structure

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `json.valid` | `json.structure` | Reads a file and confirms it parses as valid JSON. |
| `json.path` | `json.structure` | Reads a JSON file and asserts the value of a dot-notation key path (e.g. `dependencies.express`). Only own-properties are traversed — prototype chain keys like `toString` or `constructor` are explicitly blocked. |

### Code and Process

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `code.run` | `code.correctness` | Runs JavaScript in an isolated vm sandbox with no file or network access, and asserts on `console.log` output. Evidence is classified as `simulated` — realityWeight capped at 0.7. Requires `expectedOutput`. |
| `process.run` | `process.assertion` | Runs an allowlisted shell command and asserts on exit code and/or stdout. Disabled unless `ANTIPSYC_ALLOWED_COMMANDS` is configured. The working directory is validated against allowed roots. |

### Codebase

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `codebase.contains` | `codebase.search` | Searches all files matching a glob pattern (e.g. `src/**/*.js`) for a substring or regex. Skips `node_modules`, `.git`, `dist`, and similar build directories. |

### Git

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `git.file_exists` | `git.file` | Confirms a file exists at a given git ref. |
| `git.contains` | `git.file` | Reads a file at a git ref and checks for a substring. |
| `git.branch_exists` | `git.branch` | Confirms a branch ref resolves in the repository. |
| `git.log_contains` | `git.history` | Searches recent commit messages for a string. Case-insensitive by default. |
| `git.last_modified` | `git.history` | Returns the commit hash, date, and message for the last commit that touched a file. |
| `git.blame_line` | `git.history` | Returns the commit hash, author, and date for the last commit that touched a specific line number. |

### Network

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `http.fetch` | `http.reachability` or `http.response` | Makes an HTTP/HTTPS request and compares the response status code. SSRF-protected: loopback, RFC-1918, link-local, and IPv6 private addresses are blocked at both the hostname and DNS-resolution levels. Redirects are followed up to a configurable limit, with SSRF policy re-checked at each hop. |
| `http.json_path` | `http.json` | Fetches a URL, parses the JSON body, and asserts a dot-notation key value (e.g. `data.status`). Status 200 alone says nothing about the body; this checks the actual payload. Same SSRF protection as `http.fetch`. |

### Content Integrity & Structure

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `file.hash` | `file.hash` | Computes a file's content hash (sha256 by default; sha1/sha512/md5 supported) and, when `expectedHash` is given, compares it. Proves "I did not modify X" and exact-content claims. |
| `symbol.exists` | `symbol.declaration` | Checks whether a named symbol is **declared/exported** in a source file (`export function X`, `class X`, `const X =`, `def X`…) — not merely present as a substring, which `file.contains` would match inside a comment or a usage. |
| `glob.count` | `codebase.count` | Counts the files matching a glob pattern and compares to an `expectedCount` (with optional `tolerance`). Catches fabricated quantities ("there are 12 components"). |

### Text (Low-Confidence)

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `text.contains` | `text.assertion` | Checks whether caller-supplied text contains a substring. Because the text is self-supplied, this is syntactic evidence only — realityWeight capped at 0.25. Use `file.contains` for grounded checks. |

### Math

| Validator | Claim Type | What It Checks |
|-----------|-----------|----------------|
| `math.evaluate` | `math.assertion` | Evaluates a deterministic arithmetic expression in a sandboxed vm context and compares the result to an expected value. The expression must contain only digits, operators (`+ - * / % ^`), and parentheses. Tolerance must be in `[0, 1]`. |

---

## The Relevance Contract

Every validator has a **claim contract**: a set of rules that check whether the claim's statement is actually about what the validator measured. This is what prevents a model from writing "The system is healthy and package.json exists" and using a `filesystem.exists` check to verify the health claim.

The contract checks three things:

1. **Scope words.** The claim statement must not contain words whose scope the validator cannot cover — physical words (`robot`, `sensor`, `database`, `production`) and qualitative assertions (`secure`, `healthy`, `compliant`, `deployed`, `stable`, `audit`, `pass`, `remediated`, and others). If the statement contains a scope word the validator cannot speak to, the evidence is demoted to `irrelevant`.

2. **Payload terms.** The claim statement must mention the specific artifacts being verified: the file path (or its basename), the search string, the URL, or the expression. A claim about "package.json" that verifies a different file is irrelevant.

3. **Structural slots.** Validators with required inputs (e.g. `math.evaluate` requires `expression` and `expected`) check that those values are present in both the assertion and the observed evidence, and that they match.

A claim that passes all three checks earns the validator's full confidence. A claim that fails any check is demoted to `irrelevant` regardless of what the validator found.

---

## Evidence TTL and Decay

Evidence is time-limited. A filesystem check verified at 9 AM does not mean the file exists at noon. Each validator has a TTL:

| Validator category | TTL |
|--------------------|-----|
| `filesystem.exists`, `filesystem.stat`, `git.file_exists`, `git.branch_exists` | 15 minutes |
| `file.contains`, `file.matches`, `json.*`, `process.run`, `codebase.contains` | 30 minutes |
| `http.fetch` | 5 minutes |
| `git.log_contains`, `interaction.chain` | 10 minutes |
| `code.run` | 1 hour |
| `git.last_modified`, `git.blame_line` | 1 hour |
| `math.evaluate`, `text.contains` | Never (deterministic) |

When evidence expires it is marked `stale` and `realityWeight` decays toward 0.1 over 24 hours. The raw evidence records are never deleted; decay is computed at read time. To refresh a stale claim, run the validator again.

---

## Claim Deduplication

Identical claims — same statement and type, case-insensitive and whitespace-normalised — are deduplicated by fingerprint. Submitting the same claim twice returns the existing live record instead of creating a duplicate. Evidence accumulates on one canonical claim. Stale and failed claims are not deduplicated: a new attempt creates a fresh record.

## Fresh-Evidence Cache

Re-verifying a claim whose latest evidence (same validator, same inputs) is still within its TTL returns that ledger evidence immediately — `cached: true` with `ageSeconds` — instead of re-running the validator. Repeat verification is free; the gate is still included. Pass `force: true` to bypass the cache and re-observe. `consistency_vote` and `iterative_verify` always bypass it, since their purpose is re-observation.

---

## The Confidence Gate

**Every verification response embeds its gate.** The evidence record returned by `verify_claim`, `use_template`, `verify_batch`, and `verify_interaction` includes a `gate` field — verdict and presentation guidance in a single round trip. You rarely need a separate gate call.

To re-check an existing claim, call `gate_check` (HTTP: `POST /api/gate`, MCP: `gate_check`) **with the `claimId`** — the gate then reads `verified`, `contradicted`, and `realityWeight` from the evidence ledger itself and marks the response `attested: true`. Raw caller-supplied numbers are still accepted, but the response is marked `attested: false`: a model cannot bless its own invented confidence. The gate returns one of three signals:

| Signal | Condition | What to do |
|--------|-----------|------------|
| `verified` | `verified=true` and `realityWeight ≥ 0.75` | Assert the claim directly. |
| `caveat` | `verified=true` and `realityWeight ≥ 0.4` | Qualify with "based on available evidence" or state the confidence level. |
| `suppress` | Everything else, or `contradicted=true` | Disclaim or omit. Do not assert. |

The gate requires explicit `verified` and `contradicted` flags. If those flags are absent — as when a caller passes only `realityWeight` — the gate defaults to `suppress`. A contradicted claim always suppresses regardless of its realityWeight.

---

## Forced Validation — Confirmations Mint a Gate on the Fly

A **confirmation** is an input that asserts something is *done*, *correct*, *passing*, or *successful* and asks the system to accept it — either explicitly (`type: "confirmation"` / `confirmation: true`) or by phrasing ("the migration completed successfully", "tests are passing", "confirm that the file was written"). A model's confirmation is not evidence, so AntiPsyc refuses to take it on faith: when a confirmation is detected, it **creates a brand-new validation gate on the fly**.

The gate is a registered object with its own `gateId` and a set of concrete `verify_claim` steps derived from whatever external artifacts the confirmation references (file paths → `filesystem.exists` / `file.contains`, URLs → `http.fetch`, "tests" → `process.run`, "committed" → `git.log_contains`, and so on). Until those steps produce grounded, verified evidence, the confirmation cannot be asserted.

Two ways it triggers:

- **Automatically.** A confirmation submitted through `submit_claim` *without* a grounding validator gets a `forcedValidation` HALT attached to the claim. (A confirmation already routed through a real validator is left alone — it is already validating.)
- **Explicitly.** Call `force_validation({ statement })` (MCP) or `POST /api/conscience/force-validation` to mint the gate yourself.

To close the gate, run the required steps with `verify_claim`, then call `resolve_forced_gate({ gateId, claimIds })` (MCP) or `POST /api/conscience/resolve-gate`. **Resolution is strict** — it returns `gate: "PROCEED"` only when **every artifact the confirmation names** (file, URL, or quoted value) is independently backed by a *distinct* fresh, grounded, fully-`verified` record (`status: "verified"`, `realityWeight ≥ 0.75`, not expired). It refuses to pass on:

- **unrelated true facts** — verifying that `2+2=4` does not satisfy a confirmation about `package.json`;
- **partial coverage** — if the confirmation names two files, both must be verified;
- **weak evidence** — `stale`, `simulated`, `syntactic`, or self-supplied `text.contains` evidence is ignored;
- **any contradiction** — one contradicted record hard-fails the gate (`verdict: "contradicted"`);
- **vague confirmations** — one that names nothing checkable ("everything works") returns `verdict: "unverifiable_by_tools"` and can *never* auto-pass; it must be decomposed into concrete, named claims.

Raise the bar further with `ANTIPSYC_FORCED_MIN_RW` (default `0.75`).

```json
POST /api/conscience/force-validation
{ "statement": "The build is done and the tests are passing" }
// → { gate: "HALT", gateId: "gate_…", required_steps: [ … ] }

POST /api/conscience/resolve-gate
{ "gateId": "gate_…", "claimIds": ["claim_…"] }
// → { gate: "PROCEED", verdict: "validated" }  (only with grounded evidence)
```

---

## Response Auditing — Lint a Whole Draft Before You Send It

Every other mechanism is opt-in per claim. **`audit_response`** closes that gap: give it a draft answer and it extracts every checkable assertion, verifies each with a real validator, and returns a single verdict.

```json
POST /api/audit
{ "text": "I created src/auth.js with a validateToken export and bumped the version to 2.1.0." }
→ {
  "verdict": "REVISE",
  "checked": 3,
  "counts": { "grounded": 1, "contradicted": 1, "ungrounded": 1 },
  "contradicted": [ { "statement": "validateToken is declared in src/auth.js", … } ],
  "directive": "Do NOT send as-is. 1 contradicted and 1 unverified claim(s). …"
}
```

The extractor (`extract_claims` / `POST /api/extract`) is deterministic — no second model in the loop. It sweeps the text, sentence by sentence, for files, file content, exported symbols, URLs, the package version, and arithmetic, and emits ready-to-run `verify_claim` payloads. The recommended habit for any agent is **audit before you answer**: re-audit until `verdict: "OK"`, then send.

## Negative Claims — `expectAbsent`

Any `verify_claim` call accepts `expectAbsent: true`, which flips verified/contradicted so that **absence is success**. For example, to prove a dependency is *not* present:

```json
POST /api/verify
{ "validator": "file.contains", "path": "package.json", "contains": "express", "expectAbsent": true }
// → verified = true  (express is absent)
```

---

## Templates

Templates are named shortcuts for common claim patterns. They let smaller models submit a short `{ template, fill }` object instead of constructing a full validator payload. Available templates:

| Template | What it verifies |
|----------|-----------------|
| `file-exists` | A path exists on disk. |
| `file-contains` | A file contains a substring. |
| `file-matches` | A file matches a regex. |
| `code-output` | JavaScript produces expected `console.log` output. |
| `package-version` | `package.json` declares a specific version string. |
| `package-name` | `package.json` has a specific name. |
| `json-key` | A dot-notation key in any JSON file has a specific value. |
| `has-dependency` | A library appears in `package.json`. |
| `no-dependency` | A library is absent from `package.json` (verified = absent). |
| `codebase-has` | Any file matching a glob contains a substring. |
| `codebase-matches` | Any file matching a glob matches a regex. |
| `git-commit-has` | A recent commit message contains a string. |
| `git-file-touched` | A file has git history (returns last-modified metadata). |
| `math-equals` | An arithmetic expression evaluates to an expected result. |
| `url-returns-200` | A URL responds with HTTP 200. |

Use `GET /api/templates` or the `get_templates` MCP tool to list all templates with their required fill fields and examples before calling `use_template`.

---

## API Reference

All `/api/*` routes except `/api/health`, `/api/version`, `/api/templates`, and `/api/gate` require authentication when `ANTIPSYC_API_KEY` is set.

### Always Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Server status, version, auth mode, and validator catalog. |
| `GET` | `/api/version` | Full version history and changelog. |
| `GET` | `/api/templates` | Template catalog with fill fields and examples. |
| `POST` | `/api/gate` | Compute the presentability signal for a given `realityWeight`. |

### Claims and Evidence

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/claims` | List all claims, newest first. Accepts `?q=term` for text search. |
| `GET` | `/api/claims/:id` | Fetch one claim with its full evidence history (decay applied). |
| `POST` | `/api/claims` | Submit a provisional claim without verifying it. |
| `POST` | `/api/verify` | Submit and immediately verify a claim. Returns the evidence record. |
| `POST` | `/api/verify/batch` | Verify multiple claims in parallel. Body: `{ checks: [...], parallel: true }`. |
| `POST` | `/api/verify/template` | Resolve a template and verify. Body: `{ template, fill, statement? }`. |
| `POST` | `/api/interactions` | Verify a causal chain of checks as one interaction record. |

### Request Shapes

**Submit a claim:**
```json
POST /api/claims
{
  "statement": "package.json exists",
  "type": "filesystem.exists",
  "source": "model",
  "tags": ["startup"]
}
```

**Verify a claim inline:**
```json
POST /api/verify
{
  "statement": "package.json exists",
  "type": "filesystem.exists",
  "validator": "filesystem.exists",
  "path": "package.json"
}
```

**Verify using an existing claim ID:**
```json
POST /api/verify
{
  "claimId": "claim_abc123",
  "validator": "filesystem.exists",
  "path": "package.json"
}
```

**Verify via template:**
```json
POST /api/verify/template
{
  "template": "package-version",
  "fill": { "version": "0.6.0" }
}
```

**Check the gate:**
```json
POST /api/gate
{
  "realityWeight": 0.9,
  "verified": true,
  "contradicted": false
}
```

---

## MCP Tools

When running in MCP mode (`npm run mcp` or `npm start`), the server exposes these tools over the stdio MCP protocol:

| Tool | Description |
|------|-------------|
| `submit_claim` | Record a provisional claim without verifying it. |
| `verify_claim` | Run a validator against a claim and store the evidence. |
| `verify_batch` | Verify multiple claims in parallel. |
| `verify_interaction` | Verify a causal chain of related checks. |
| `get_claim` | Fetch a claim and its full evidence history. |
| `search_evidence` | Full-text search across the evidence ledger. |
| `get_templates` | List available templates. Call this before `use_template`. |
| `use_template` | Verify a claim using a named template shortcut. |
| `gate_check` | Translate a `realityWeight` into a presentability signal. |
| `force_validation` | Send a confirmation; mint a new validation gate with the required `verify_claim` steps. |
| `resolve_forced_gate` | Close a forced gate — `PROCEED` only when grounded verified evidence exists. |

### Recommended Model Workflow

```
1. Receive a task or produce a claim.
2. Call get_templates to discover available shortcuts.
3. Call use_template (or verify_claim directly) to verify the claim.
4. Read the returned evidence: check status, realityWeight, verified, contradicted.
5. Call gate_check with those values.
6. Present the result according to the gate signal:
     verified  → assert directly
     caveat    → qualify before asserting
     suppress  → disclaim or omit until re-verified
```

Never present a claim whose evidence status is `provisional`, `stale`, `failed`, `syntactic`, or `unverifiable` as established fact.

---

## Security Model

### Filesystem Boundaries

All filesystem and git validators are restricted to `ANTIPSYC_ALLOWED_ROOTS`. In development, this defaults to the server's working directory. In production mode, it must be set explicitly. Paths outside the allowed roots return `blocked` evidence rather than an error that leaks path information.

### SSRF Protection

The `http.fetch` validator blocks requests to:
- Loopback addresses (`127.x.x.x`, `::1`)
- RFC-1918 private ranges (`10/8`, `172.16/12`, `192.168/16`)
- Link-local ranges (`169.254/16`)
- IPv6 unique-local and link-local ranges
- The unroutable `0.x.x.x` block

Protection applies at the hostname level and again after DNS resolution, closing the DNS-rebinding gap. Every redirect hop is re-validated before the request proceeds. An optional `ANTIPSYC_HTTP_ALLOWLIST` restricts HTTP targets to a comma-separated list of approved hostnames.

### Process Execution

`process.run` is disabled by default. To enable it, set `ANTIPSYC_ALLOWED_COMMANDS` to a comma-separated list of permitted binary names or full command strings. The working directory is validated against `ANTIPSYC_ALLOWED_ROOTS`.

### Math Sandbox

`math.evaluate` expressions are restricted to digits, whitespace, parentheses, and arithmetic operators. No letters, no function calls, no property access. The expression runs in a `vm.runInNewContext` sandbox with a 100ms timeout.

### Regex Safety

`file.matches` rejects patterns that match the empty string (trivially universal patterns like `.*` or `(?:)`). Pattern execution runs in a `vm.runInNewContext` sandbox with a 500ms timeout to kill catastrophically backtracking (ReDoS) patterns before they block the event loop.

### API Authentication

Set `ANTIPSYC_API_KEY` to require a `Authorization: Bearer <key>` header on all `/api/*` routes except the public endpoints listed above. Auth is disabled in development mode (when the env var is not set). The static UI and health check are always public.

### Production Startup Guard

Setting `ANTIPSYC_PROFILE=production` causes the server to refuse to start unless both `ANTIPSYC_API_KEY` and `ANTIPSYC_ALLOWED_ROOTS` are configured. This prevents accidentally running an open server in a sensitive environment.

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ANTIPSYC_PORT` | `8717` | HTTP listen port. |
| `ANTIPSYC_BIND` | `127.0.0.1` | HTTP listen address. Set `0.0.0.0` for containers. |
| `ANTIPSYC_API_KEY` | *(unset)* | Bearer token for API authentication. When unset, auth is disabled. |
| `ANTIPSYC_ATTEST_KEY` | *(unset)* | Operator credential required by `human_attest`. Supply it out-of-band — never place it in the model's context. When unset, attestation is open (dev only). |
| `ANTIPSYC_ALLOW_LOCAL_HTTP` | *(unset)* | `true` permits `http.fetch` / `retrieve_and_ground` against **loopback only** so an agent can verify its own dev server. RFC-1918, link-local, and broadcast stay blocked. |
| `ANTIPSYC_TOOLSET` | *(unset)* | `core` exposes a reduced 12-tool MCP surface for token-sensitive clients. |
| `ANTIPSYC_FORCED_MIN_RW` | `0.75` | Minimum realityWeight a verified record needs to satisfy a forced-validation gate. Raise toward `1.0` for stricter confirmations. |
| `ANTIPSYC_RATE_LIMIT_LOCAL` | *(unset)* | `true` applies the rate limiter to loopback callers too (exempt by default — the intended caller is a local agent doing batch verification). |
| `ANTIPSYC_ALLOWED_ROOTS` | Server working directory | Semicolon-separated list of filesystem roots accessible to validators. |
| `ANTIPSYC_ALLOWED_COMMANDS` | *(empty)* | Comma-separated list of commands permitted by `process.run`. Empty = disabled. |
| `ANTIPSYC_HTTP_ALLOWLIST` | *(empty)* | Comma-separated list of hostnames permitted for `http.fetch`. Empty = all non-private hosts allowed. |
| `ANTIPSYC_HTTP_TIMEOUT_MS` | `5000` | HTTP request timeout in milliseconds. |
| `ANTIPSYC_HTTP_MAX_REDIRECTS` | `3` | Maximum redirect hops before `http.fetch` gives up. |
| `ANTIPSYC_PROFILE` | `dev` | Set to `production` to enforce required configuration on startup. |

---

## Getting Started

**Requirements:** Node.js 18 or later. Node.js 22 or later enables SQLite persistence (recommended). No npm dependencies.

**Install and run:**
```powershell
# Windows (PowerShell)
.\deploy.ps1
```

```bash
# Unix / macOS
node src/server.js --http
```

**Run in MCP + HTTP mode (both simultaneously):**
```bash
node src/server.js --http --mcp
```

**Smoke test:**
```bash
node src/server.js --smoke
```

**Run the adversarial test suite:**
```bash
node test-v5-adversarial.mjs
node test-v6-conscious-logic.mjs
```

**With Docker:**
```bash
docker build -t antipsyc .
docker run -p 8717:8717 \
  -e ANTIPSYC_API_KEY=your-key \
  -e ANTIPSYC_ALLOWED_ROOTS=/app \
  -e ANTIPSYC_PROFILE=production \
  antipsyc
```

---

## What to Expect

### When a claim is verified correctly

The evidence record will have `status: "verified"`, a `realityWeight` between 0.75 and 1.0 (depending on the validator), and `evidenceClass: "observed"`. The gate returns `verified`. You can assert the claim directly.

### When a claim is contradicted

The status is `contradicted`, `realityWeight` stays at the validator's confidence level (e.g. 0.95 for a filesystem check), and `verified: false`. The gate always returns `suppress` for contradicted evidence. Do not assert the claim. You may note that it was checked and found to be false.

### When a claim is rejected by the contract

The status is `irrelevant` and `realityWeight` drops to 0.05. This means the validator ran but the evidence does not support the claim as written — either the claim contains scope words the validator cannot speak to (database, production, security, healthy, deployed…) or the claim statement does not reference the specific artifact that was verified. Rewrite the claim to match exactly what the validator can confirm.

### When evidence is self-supplied

Using `text.contains` with caller-supplied text always produces `status: "syntactic"` and `realityWeight ≤ 0.25`. This is by design. Self-supplied text can prove string containment; it cannot prove real-world truth. The gate will return `suppress`. To raise the confidence, use a file-reading validator that reads the actual content from disk.

### When evidence is stale

A previously verified claim that has passed its TTL will show `status: "stale"` and a decayed `realityWeight`. Re-run the same validator to refresh it. The old evidence records remain in the ledger.

Because decay is gradual, stale evidence can still carry a high realityWeight for a while after expiry — so the gate is **status-aware**: stale evidence can never return `verified`. It caps at `caveat` (with a re-verify directive) and falls to `suppress` once its realityWeight has decayed. Don't present a stale observation as current fact; re-verify.

### When a path is blocked

The status is `blocked` and `realityWeight` is 0. The requested path falls outside the configured allowed roots. Either the path is wrong or `ANTIPSYC_ALLOWED_ROOTS` needs to be updated to include the location you intend to verify.

---

## Persistence

By default, claims and evidence are stored in `data/claims.json` and `data/evidence.jsonl`. On Node.js 22 or later, the server automatically uses a SQLite database (`data/antipsyc.db`) instead. The SQLite backend is indexed for fast lookups and is preferred in production. On first start with existing JSON files, the server migrates data automatically.

The evidence ledger is append-only. No record is ever deleted. This means the full history of every claim — including corrections, contradictions, and retries — is always available.

---

## Repository Layout

```
src/
  server.js          — HTTP and MCP server, routing, and business logic
  validators.js      — All validator implementations and the SSRF/path-guard helpers
  contracts.js       — Claim contracts, relevance checking, scope word filter
  store.js           — JSON file evidence store (Node < 22 fallback)
  store-sqlite.js    — SQLite evidence store (Node 22+, preferred)
  templates.js       — Template registry and confidence gate
  changelog.js       — Version history
web/
  index.html         — Evidence UI shell
  app.js             — UI frontend (no build step, vanilla JS)
  styles.css         — UI styles
data/                — Runtime evidence storage (gitignored)
docs/                — Design documents and hardening reports
test-*.mjs           — Adversarial and regression test suites
deploy.ps1           — Windows one-command deploy script
Dockerfile           — Container deployment
```

---

## Design Principles

**Assertion is not evidence.** A model saying something confidently is not a signal about whether it is true. Confidence scores from a model are priors. Validator results are posteriors. The gate uses posteriors.

**Evidence is grounded or it does not count.** Every non-trivial evidence class requires the validator — not the model — to read the file, make the request, run the command. The model supplies the claim; the validator supplies the observation.

**Scope must match.** A validator that confirms a file exists cannot confirm the system is healthy, even if the file is a healthcheck marker. The claim must be as narrow as the evidence. Broad claims against narrow evidence are demoted, not promoted.

**Evidence decays.** The world changes. A fact that was true 20 minutes ago may not be true now. Evidence is time-limited. Stale evidence is disclaimed, not silently trusted.

**Contradictions are permanent.** A claim that has been contradicted carries that record forever, even if it is later verified. The full history is available to any caller who wants to understand how a claim's status evolved.
