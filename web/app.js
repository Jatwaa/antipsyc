// ── Constants (before top-level awaits — const is NOT hoisted) ───────────
const CATEGORY_ICON = {
  security:    "🔒",
  fix:         "🔧",
  improvement: "⬆️",
  feature:     "✨"
};

const FORM_HINTS = {
  "filesystem.exists": { path: "Absolute file or directory path",              expected: "",                             needsExpected: false },
  "filesystem.stat":   { path: "Absolute file or directory path",              expected: "",                             needsExpected: false },
  "file.contains":     { path: "Absolute file path",                           expected: "Substring to find in file",    needsExpected: true  },
  "file.matches":      { path: "Absolute file path",                           expected: "Regex pattern",                needsExpected: true  },
  "code.run":          { path: "JavaScript code  (e.g. console.log(2+2))",     expected: "Expected console output",      needsExpected: true  },
  "process.run":       { path: "Command  (must be in ANTIPSYC_ALLOWED_COMMANDS)", expected: "Expected exit code (def 0)", needsExpected: true },
  "git.file_exists":   { path: "Repo-relative path  (e.g. src/server.js)",    expected: "",                             needsExpected: false },
  "git.contains":      { path: "Repo-relative path",                           expected: "Substring to find",            needsExpected: true  },
  "git.branch_exists": { path: "Branch name  (e.g. main)",                    expected: "",                             needsExpected: false },
  "http.fetch":        { path: "URL  (e.g. https://example.com)",              expected: "Expected status (def 200)",    needsExpected: true  },
  "json.valid":        { path: "Absolute path to JSON file",                   expected: "",                             needsExpected: false },
  "json.path":         { path: "Absolute path to JSON file",                   expected: "Dot-path  (e.g. version)",     needsExpected: true  },
  "math.evaluate":     { path: "Arithmetic expression  (e.g. 2 + 2)",         expected: "Expected numeric result",       needsExpected: true  },
  "text.contains":     { path: "Text to search (AI-supplied, lower trust)",    expected: "Substring that must appear",   needsExpected: true  },
  // G0
  "codebase.contains": { path: "Glob pattern  (e.g. src/**/*.js)",             expected: "Substring to find in files",   needsExpected: true  },
  // G8
  "git.log_contains":  { path: "Since ref  (e.g. HEAD~10 or leave blank)",     expected: "String to find in commits",    needsExpected: true  },
  "git.last_modified": { path: "Repo-relative file path",                       expected: "",                             needsExpected: false },
  "git.blame_line":    { path: "Repo-relative file path",                       expected: "Line number",                  needsExpected: true  },
};

// ── Element refs ──────────────────────────────────────────────────────────
const search         = document.querySelector("#search");
const claimsEl       = document.querySelector("#claims");
const claimsError    = document.querySelector("#claims-error");
const detailsEl      = document.querySelector("#details");
const form           = document.querySelector("#claim-form");
const formError      = document.querySelector("#form-error");
const verifyBtn      = document.querySelector("#verify-btn");
const versionBadge   = document.querySelector("#version-badge");
const changelogBtn   = document.querySelector("#changelog-btn");
const changelogDlg   = document.querySelector("#changelog-dialog");
const changelogBody  = document.querySelector("#changelog-body");
const changelogClose = document.querySelector("#changelog-close");
const validatorSel   = document.querySelector("#validator-select");
const pathInput      = document.querySelector("#path-input");
const expectedInput  = document.querySelector("#expected-input");

let selectedId = null;

// ── Boot ──────────────────────────────────────────────────────────────────
await loadVersion();
await refresh();

// ── Event listeners ───────────────────────────────────────────────────────
search.addEventListener("input", () => refresh(search.value));
validatorSel.addEventListener("change", updateFormHints);
updateFormHints();

form.addEventListener("submit", async event => {
  event.preventDefault();
  formError.hidden = true;
  verifyBtn.disabled = true;
  verifyBtn.textContent = "Verifying…";
  try {
    const data     = Object.fromEntries(new FormData(form).entries());
    const payload  = buildPayload(data);
    const response = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(err.error || `HTTP ${response.status}`);
    }
    const result = await response.json();
    selectedId = result.claimId;
    form.reset();
    updateFormHints();
    await refresh(search.value);
    await inspect(selectedId);
  } catch (err) {
    showFormError(err.message);
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.textContent = "Verify";
  }
});

changelogBtn.addEventListener("click", () => changelogDlg.showModal());
changelogClose.addEventListener("click", () => changelogDlg.close());
changelogDlg.addEventListener("click", e => { if (e.target === changelogDlg) changelogDlg.close(); });

// ── Data loading ──────────────────────────────────────────────────────────
async function loadVersion() {
  try {
    const response = await fetch("/api/version");
    if (!response.ok) return;
    const data = await response.json();
    versionBadge.textContent = data.label || data.current;
    changelogBody.innerHTML  = renderChangelog(data.versions);
  } catch {
    versionBadge.textContent  = "v?";
    changelogBody.textContent = "Could not load changelog.";
  }
}

async function refresh(q = "") {
  claimsError.hidden = true;
  try {
    const response = await fetch(`/api/claims?q=${encodeURIComponent(q)}`);
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    const claims = await response.json();
    claimsEl.innerHTML = claims.map(renderClaim).join("") ||
      `<div class="claim empty">No claims recorded.</div>`;
    for (const row of claimsEl.querySelectorAll(".claim[data-id]")) {
      row.addEventListener("click", () => inspect(row.dataset.id));
    }
  } catch (err) {
    claimsError.textContent = `Error loading claims: ${err.message}`;
    claimsError.hidden = false;
  }
}

async function inspect(id) {
  selectedId = id;
  for (const row of claimsEl.querySelectorAll(".claim")) {
    row.classList.toggle("active", row.dataset.id === id);
  }
  try {
    const response = await fetch(`/api/claims/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    detailsEl.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (err) {
    detailsEl.textContent = `Error loading evidence: ${err.message}`;
  }
}

// ── Renderers ─────────────────────────────────────────────────────────────
function renderClaim(claim) {
  return `
    <article class="claim ${claim.id === selectedId ? "active" : ""}" data-id="${escapeHtml(claim.id)}">
      <strong>${escapeHtml(claim.statement)}</strong>
      <div class="meta">
        <span class="pill ${escapeHtml(claim.status)}">${statusLabel(claim.status)}</span>
        <span class="pill">${escapeHtml(claim.type)}</span>
        <span class="pill">confidence ${formatNumber(claim.confidence)}</span>
        <span class="pill">weight ${formatNumber(claim.realityWeight)}</span>
      </div>
    </article>
  `;
}

// H7: human-readable status labels for full taxonomy
function statusLabel(status) {
  const labels = {
    verified:      "✓ verified",
    contradicted:  "✗ contradicted",
    partial:       "◑ partial",
    provisional:   "◌ provisional",
    failed:        "⚠ failed",
    stale:         "⏱ stale",
    unverifiable:  "? unverifiable",
    blocked:       "blocked",
    irrelevant:    "irrelevant",
    syntactic:     "syntactic",
    simulated:     "simulated",
  };
  return labels[status] || escapeHtml(status);
}

function renderChangelog(versions) {
  if (!versions?.length) return "<p>No changelog available.</p>";
  return [...versions].reverse().map(v => `
    <section class="cl-version">
      <div class="cl-version-header">
        <span class="version-badge">${escapeHtml(v.label)}</span>
        <strong>${escapeHtml(v.version)}</strong>
        <span class="cl-date">${escapeHtml(v.released)}</span>
        <span class="cl-summary">${escapeHtml(v.summary)}</span>
      </div>
      <ul class="cl-changes">
        ${(v.changes || []).map(c => `
          <li class="cl-change cl-${escapeHtml(c.category)}">
            <span class="cl-icon">${CATEGORY_ICON[c.category] || "•"}</span>
            <span>${escapeHtml(c.description)}</span>
            ${c.ref ? `<span class="cl-ref">${escapeHtml(c.ref)}</span>` : ""}
          </li>
        `).join("")}
      </ul>
    </section>
  `).join("");
}

// ── Form helpers ──────────────────────────────────────────────────────────
function updateFormHints() {
  const hints = FORM_HINTS[validatorSel.value] || { path: "", expected: "", needsExpected: false };
  pathInput.placeholder     = hints.path;
  expectedInput.placeholder = hints.expected;
  expectedInput.style.visibility = hints.needsExpected ? "visible" : "hidden";
}

function buildPayload(data) {
  const base = { statement: data.statement, validator: data.validator, type: data.validator };
  switch (data.validator) {
    case "filesystem.exists":
    case "filesystem.stat":
    case "json.valid":         return { ...base, path: data.path };
    case "file.contains":      return { ...base, path: data.path, contains: data.expected };
    case "file.matches":       return { ...base, path: data.path, pattern: data.expected };
    case "git.file_exists":    return { ...base, path: data.path };
    case "git.branch_exists":  return { ...base, branch: data.path };
    case "git.contains":       return { ...base, path: data.path, contains: data.expected };
    case "json.path":          return { ...base, path: data.path, keyPath: data.expected };
    case "http.fetch":         return { ...base, url: data.path, expectedStatus: Number(data.expected || 200) };
    case "math.evaluate":      return { ...base, expression: data.path, expected: Number(data.expected) };
    case "text.contains":      return { ...base, text: data.path, contains: data.expected };
    case "code.run":           return { ...base, code: data.path, expectedOutput: data.expected, language: "javascript" };
    case "process.run":        return { ...base, command: data.path, expectedExitCode: Number(data.expected || 0) };
    // G0
    case "codebase.contains":  return { ...base, glob: data.path, contains: data.expected };
    // G8
    case "git.log_contains":   return { ...base, since: data.path || "HEAD~10", message: data.expected };
    case "git.last_modified":  return { ...base, path: data.path };
    case "git.blame_line":     return { ...base, path: data.path, line: Number(data.expected) };
    default:                   return base;
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────
function showFormError(message) {
  formError.textContent = `Error: ${message}`;
  formError.hidden = false;
}

function formatNumber(value) {
  return Number(value || 0).toFixed(2);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
