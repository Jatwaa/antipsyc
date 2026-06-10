# Changelog

All notable changes to **AntiPsyc** are documented here.  
The in-app changelog is served from `GET /api/version` and populated from [`src/changelog.js`](src/changelog.js).

---

## v4 — 0.4.0 · 2026-05-27

**Codebase-scope search, SQLite persistence, claim deduplication, git history validators, scrolling UI.**

Derived from the v4 diagnostic probe (`test-v4-probe.mjs`): 30/31 caught correctly, 1 slip (file-scope vs codebase-scope claim), 10 structural gaps documented. Phase 1 of the v4 plan closes the slip, adds git history coverage, and upgrades persistence.

### ✨ New Validators

- **G0 — `codebase.contains`** — Searches all files matching a glob pattern (e.g. `src/**/*.js`) for a substring or regex. Closes the one slip from the v4 diagnostic probe: an AI claiming *"the codebase uses X"* no longer needs to know which file — the validator searches the entire project and reports which files matched. Skips `node_modules`, `.git`, `dist`, and other noise directories automatically.

- **G8 — `git.log_contains`** — Searches recent commit messages for a string, with a configurable `since` ref (default `HEAD~10`). Gracefully handles repos with fewer commits than the requested depth by falling back to full history. Covers claims like *"this feature was added in the last commit"* or *"the mutex fix is in git history"*.

- **G8 — `git.last_modified`** — Returns the commit hash, ISO timestamp, and commit message for the last commit that touched a given file path. Covers *"this file hasn't changed in months"* or *"this was recently updated"* claims.

- **G8 — `git.blame_line`** — Returns the commit hash, author name, and commit date for the last commit that touched a specific line number in a file. Covers *"Alice wrote this function"* attribution claims.

### 🗄️ Persistence

- **C5 — SQLite persistence** — `node:sqlite` (stable in Node 23.4+, available in Node 22+ with flag) replaces the `claims.json` + `evidence.jsonl` file pair with a properly indexed SQLite database (`data/antipsyc.db`). Fingerprint index (`idx_claims_fp`) makes claim dedup an O(1) lookup. Evidence index (`idx_ev_claim`, `idx_ev_ts`) makes per-claim queries fast as the ledger grows. On first start with existing JSON files, all data is automatically migrated. On Node < 22, falls back transparently to the original file-based store — no configuration required.

### 🔧 Fixes

- **H4 — Claim deduplication by fingerprint** — Identical claims (same statement + type, with whitespace trimmed and case-folded) are fingerprinted with SHA-256. Submitting the same claim repeatedly returns the existing live record rather than polluting the ledger. Evidence accumulates on one canonical record. Agents in tight loops checking the same fact no longer produce thousands of orphan provisional claims.

- **`git.log_contains` shallow-repo fallback** — When the requested `since` ref (e.g. `HEAD~10`) is deeper than the actual history, git returns an "ambiguous argument" error. The validator now catches this and retries with the full log, so single-commit repos work correctly.

### ⬆️ Improvements

- **Store factory** — `createStore()` auto-selects `SqliteStore` (Node 22+) or `EvidenceStore` (JSON fallback). Server startup logs which backend is active to stderr.

- **UI — scrolling panels** — Claims and Evidence panels are now fixed height (`calc(100vh - 248px)`) with independent overflow scrolling. The UI no longer grows unbounded as the evidence ledger fills. Both panes retain their fixed position while their content scrolls.

- **UI — 4 new validators in form** — `codebase.contains`, `git.log_contains`, `git.last_modified`, `git.blame_line` added to the validator dropdown with correct field-hint labels and a new *Codebase* optgroup.

- **Test suite** — `test-v4-validators.mjs` (23 tests, 23/23 passing) covers G0, H4, G8, and C5. `test-mcp.mjs` updated to v4 expectations (34/34 passing).

- **U3 — Claim templates** — `src/templates.js` ships 15 named shortcut templates (`file-exists`, `package-version`, `codebase-has`, `no-dependency`, `has-dependency`, `code-output`, `math-equals`, `url-returns-200`, and more). A smaller model submits `{ template: "package-version", fill: { version: "0.4.0" } }` instead of constructing the full validator JSON. `GET /api/templates` lists the catalog (always public). `POST /api/verify/template` resolves and runs a template with full `expectAbsent` inversion support. MCP tools: `get_templates`, `use_template`.

- **U2 — Confidence gate** — `computeGate(realityWeight, threshold, verified, contradicted)` maps a `realityWeight` to a presentability signal: `"verified"` (≥ 0.75 — assert confidently), `"caveat"` (≥ threshold — qualify before asserting), `"suppress"` (disclaim or omit). CONTRADICTED claims always return `"suppress"` regardless of realityWeight — high confidence that a claim is false must never become "assert confidently". `POST /api/gate` (always public, pure computation). MCP tool: `gate_check`.

- **Deterministic test salvo** — `test-deterministic-salvo.mjs`: 94 assertions covering every validator, all 15 templates, the U2 gate workflow, deduplication, type enforcement, SSRF protection, and a full small-model `verify → gate → action` loop. **94/94 passing.**

---

## v3 — 0.3.0 · 2026-05-27

**Honest grounding core — new validators, evidence TTL, type enforcement, API auth, batch verification.**

Derived from v3 implementation plan (`ImplementationPlan_v3.md`). Core thesis: validators must read files themselves — the AI cannot supply text for the validator to confirm its own claims.

### 🔒 Security

- **C1 — File-reading validators** — `file.contains` and `file.matches` read the target file directly. The AI supplies a path and a search term, not the file content. This closes the circularity where an AI could pass fabricated text to a `text.contains` validator to "verify" its own hallucination.

- **C4 — Validator-type enforcement** — Claim type now constrains which validators are permitted. Submitting a `filesystem.exists` claim and then verifying it with `text.contains` returns `unverifiable`, not a misleading `contradicted`. Prevents validator misuse from producing false confidence.

- **C6 — API key authentication** — All `/api/*` routes require `Authorization: Bearer <key>` when `ANTIPSYC_API_KEY` is set in the environment. Auth is off by default (development mode). Static files and `/api/health` are always public.

- **H5 — HTTP validator hardened** — `http.fetch` now: enforces a 5-second timeout, limits redirects to 3, and resolves DNS before connecting to close the DNS-rebinding SSRF gap from v2. The resolved IP is checked against all private ranges, not just the URL hostname.

### ✨ New Validators

- **C2 — `code.run`** — Executes JavaScript in a `vm.runInNewContext` sandbox, captures `console.log` output, and asserts on the result. Catches the most common small-model hallucinations: `typeof null`, `NaN === NaN`, float equality, `Array(n)` holes, Promise synchrony, and more. `realityWeight: 0.85`.

- **H1 — Git validators** — `git.file_exists`, `git.contains`, `git.branch_exists`: verify repository state via the `git` CLI. The AI never sees file content — it states a claim, the validator reads from git.

- **H2 — JSON validators** — `json.valid` confirms a file parses as JSON. `json.path` asserts on a dot-notation key value (e.g. `version`, `dependencies.express`). Used to verify `package.json`, config files, and API responses.

- **H3 — `process.run`** — Executes shell commands from an explicit allowlist (`ANTIPSYC_ALLOWED_COMMANDS` env var). Disabled by default — opt-in only. Asserts on exit code and optionally on stdout content.

### 🔧 Fixes

- **C3 — Evidence TTL and confidence decay** — Every evidence record now has an `expiresAt` field computed from a per-validator TTL map (e.g. `http.fetch`: 5 min, `filesystem.exists`: 15 min, `math.evaluate`: no expiry). Stale evidence decays toward `realityWeight 0.1` over 24h and is marked `stale` rather than silently trusted forever.

- **H6 — Evidence invalidation chain** — Each evidence record links to the previous record via a `supersedes` field. Contradictions are preserved in the ledger and traceable; nothing is deleted.

- **H7 — Full error taxonomy** — `verified`, `contradicted`, `partial`, `failed`, `stale`, `unverifiable` all implemented as distinct states. Validator execution failures no longer silently appear as `contradicted`.

### ⬆️ Improvements

- **H8 — Batch verification** — `POST /api/verify/batch` and `verify_batch` MCP tool run multiple checks in parallel (`Promise.all`), returning all evidence records. Sequential mode available via `parallel: false`.

- `text.contains` (AI-supplied text) `realityWeight` capped at 0.55 — text is AI-supplied, not externally read.

- UI validator dropdown expanded to 14 validators with dynamic per-validator field hints (`FORM_HINTS` map). Labels update when validator type changes.

- `stale`, `failed`, `unverifiable` status styles added to the evidence UI.

- `.env.example` added with all supported env vars (`ANTIPSYC_API_KEY`, `ANTIPSYC_PORT`, `ANTIPSYC_HTTP_TIMEOUT_MS`, `ANTIPSYC_ALLOWED_COMMANDS`).

---

## v2 — 0.2.0 · 2026-05-27

**Security hardening, concurrency fixes, and in-app changelog.**

Derived from code review (`REVIEW.md`). Addressed all Critical and High severity issues plus several Medium improvements.

### 🔒 Security

- **Fixed path traversal** in static file server — resolved paths are now verified to lie within `web/` before reading. ([REVIEW #1](REVIEW.md))

- **Replaced `Function()` eval** with `vm.runInNewContext()` in `math.evaluate` — eliminates sandbox-escape risk from expression injection. ([REVIEW #2](REVIEW.md))

- **Added SSRF protection** to `http.fetch` — loopback (`127.0.0.1`), RFC-1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16), and IPv6 loopback are blocked at the hostname level. ([REVIEW #3](REVIEW.md))

### 🔧 Fixes

- Static file server returns HTTP **404** (not 500) for missing files; error messages no longer leak absolute filesystem paths. ([REVIEW #7](REVIEW.md))

- Added **write mutex** (`#withLock`) to `EvidenceStore` — concurrent claim creation and evidence appends are serialised via a promise-chain queue, preventing lost-update races on `claims.json`. ([REVIEW #4](REVIEW.md))

- Cached `EvidenceStore.init()` with `#initialized` flag — eliminates redundant `mkdir` + `readFile` calls on every claim read. ([REVIEW #5](REVIEW.md))

### ⬆️ Improvements

- `verifyInteraction` executes independent validator checks **in parallel** via `Promise.all` instead of a sequential `for-await` loop. ([REVIEW #9](REVIEW.md))

- Frontend fetch calls handle network errors and non-2xx responses with **visible inline error messages** instead of silently failing. ([REVIEW #12](REVIEW.md))

- **Dockerfile CMD** changed to `--http` only (`--mcp` over stdio is not useful in a container); added `ENV NODE_ENV=production`. ([REVIEW #14](REVIEW.md))

- Added **`.dockerignore`** to exclude `data/`, `node_modules/`, and markdown files from container image layers. ([REVIEW #14](REVIEW.md))

- Validator form field placeholder and `expected` input **update dynamically** when the validator type changes.

### ✨ New

- `GET /api/version` — returns full version history, release dates, per-change categories, and review references.

- `GET /api/health` — now includes `version` and `label` fields.

- In-app **Changelog viewer** — accessible from the toolbar; shows all versions and changes without leaving the UI.

- `src/changelog.js` — canonical version data module; single source of truth for the API and the in-app UI.

---

## v1 — 0.1.0 · 2026-05-27

**Initial MVP release.**

### ✨ Features

- MCP stdio server exposing: `submit_claim`, `verify_claim`, `verify_interaction`, `search_evidence`, `get_claim`.
- HTTP API: `GET /api/health`, `GET /api/claims`, `GET /api/claims/:id`, `POST /api/claims`, `POST /api/verify`, `POST /api/interactions`.
- Searchable evidence UI showing claims, status, confidence, and reality-weight pills.
- Append-only JSONL evidence ledger with full provenance per record.
- Validators: `filesystem.exists`, `filesystem.stat`, `math.evaluate`, `http.fetch`, `text.contains`, `interaction.chain`.
- Interaction chain bundles multiple validator checks into one causal evidence record.
- Zero npm dependencies — runs with bare Node 18+.
- One-command deploy via `deploy.ps1` (PowerShell) and `deploy.cmd` (CMD wrapper).
- Dockerfile for containerised HTTP deployment.
