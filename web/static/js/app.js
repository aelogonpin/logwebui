"use strict";

/**
 * LokiViews frontend.
 *
 * All state lives in memory: the last query's raw entries, the active
 * severity filter, and the free-text filter. Filtering/download always
 * operate on what's currently rendered, never re-fetching from the server.
 */

const state = {
  entries: [], // [{ timestamp, line, labels, level }]
  severityFilter: "all",
  textFilter: "",
  searching: false,
  timeMode: "quick", // "quick" | "custom" — mutually exclusive, never both
  quickMinutes: 1440,
};

const SEVERITY_PATTERNS = [
  { level: "error", regex: /\b(ERROR|ERR|FATAL|EXCEPTION|PANIC)\b/i },
  { level: "warn", regex: /\b(WARN|WARNING)\b/i },
  { level: "info", regex: /\b(INFO|NOTICE)\b/i },
  { level: "debug", regex: /\b(DEBUG|TRACE)\b/i },
];

function detectSeverity(line) {
  for (const { level, regex } of SEVERITY_PATTERNS) {
    if (regex.test(line)) return level;
  }
  return "unknown";
}

// ---------- DOM refs ----------

const el = {
  orgIdInput: document.getElementById("orgIdInput"),
  matchers: document.getElementById("matchers"),
  addMatcher: document.getElementById("addMatcher"),
  timeModeToggle: document.getElementById("timeModeToggle"),
  quickRange: document.getElementById("quickRange"),
  customRangeRow: document.getElementById("customRangeRow"),
  startTime: document.getElementById("startTime"),
  endTime: document.getElementById("endTime"),
  queryMeta: document.getElementById("queryMeta"),
  limitSelect: document.getElementById("limitSelect"),
  directionSelect: document.getElementById("directionSelect"),
  searchBtn: document.getElementById("searchBtn"),
  searchBtnLabel: document.getElementById("searchBtnLabel"),
  searchError: document.getElementById("searchError"),
  resultCount: document.getElementById("resultCount"),
  terminal: document.getElementById("terminal"),
  emptyState: document.getElementById("emptyState"),
  logLines: document.getElementById("logLines"),
  freeFilter: document.getElementById("freeFilter"),
  downloadBtn: document.getElementById("downloadBtn"),
  connStatus: document.getElementById("connStatus"),
};

const labelNamesCacheByOrg = new Map();

// ---------- Matcher rows ----------

function createMatcherRow(prefillKey = "") {
  const row = document.createElement("div");
  row.className = "matcher-row";
  row.innerHTML = `
    <input type="text" class="matcher-key" list="labelNamesList" placeholder="label (ej. namespace)" value="${escapeHtml(prefillKey)}" />
    <select class="matcher-op">
      <option value="=">=</option>
      <option value="!=">!=</option>
      <option value="=~">=~</option>
      <option value="!~">!~</option>
    </select>
    <input type="text" class="matcher-value" placeholder="valor" />
    <button type="button" class="remove-matcher" title="Eliminar">×</button>
  `;

  row.querySelector(".remove-matcher").addEventListener("click", () => {
    if (el.matchers.children.length > 1) {
      row.remove();
    } else {
      row.querySelector(".matcher-key").value = "";
      row.querySelector(".matcher-value").value = "";
    }
  });

  const keyInput = row.querySelector(".matcher-key");
  const valueInput = row.querySelector(".matcher-value");
  keyInput.addEventListener("change", () => attachValueAutocomplete(keyInput, valueInput));

  el.matchers.appendChild(row);
  return row;
}

function ensureLabelNamesDatalist() {
  if (document.getElementById("labelNamesList")) return;
  const dl = document.createElement("datalist");
  dl.id = "labelNamesList";
  document.body.appendChild(dl);
}

async function attachValueAutocomplete(keyInput, valueInput) {
  const name = keyInput.value.trim();
  if (!name) return;
  try {
    const orgId = el.orgIdInput.value.trim();
    const qs = new URLSearchParams({ name });
    if (orgId) qs.set("orgId", orgId);
    const res = await fetch(`/api/label-values?${qs.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    const listId = `values-${cssSafeId(name)}`;
    let dl = document.getElementById(listId);
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = listId;
      document.body.appendChild(dl);
    }
    dl.innerHTML = "";
    (data.values || []).forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      dl.appendChild(opt);
    });
    valueInput.setAttribute("list", listId);
  } catch (_) {
    // Autocomplete is a convenience only — silently ignore failures.
  }
}

function cssSafeId(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function loadLabelNames() {
  const orgId = el.orgIdInput.value.trim();
  if (labelNamesCacheByOrg.has(orgId)) {
    return labelNamesCacheByOrg.get(orgId);
  }
  try {
    const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const res = await fetch(`/api/labels${qs}`);
    if (!res.ok) return [];
    const data = await res.json();
    const names = data.labels || [];
    labelNamesCacheByOrg.set(orgId, names);
    const dl = document.getElementById("labelNamesList");
    dl.innerHTML = "";
    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      dl.appendChild(opt);
    });
    return names;
  } catch (_) {
    return [];
  }
}

async function loadDefaultOrgId() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const data = await res.json();
    if (data.defaultOrgId) {
      el.orgIdInput.value = data.defaultOrgId;
    }
  } catch (_) {
    // No default configured server-side — the field just stays empty.
  }
}

el.orgIdInput.addEventListener("change", () => {
  loadLabelNames();
});

// ---------- Time range ----------
//
// Quick range and custom dates are mutually exclusive: only one mode is
// active at a time, both in the UI and in what gets sent to the backend.
// Quick range is recomputed from "now" at search time, not frozen when the
// chip was clicked, so "últimas 24h" always means the 24h up to the click.

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setTimeMode(mode) {
  state.timeMode = mode;
  [...el.timeModeToggle.children].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  el.quickRange.hidden = mode !== "quick";
  el.customRangeRow.hidden = mode !== "custom";

  if (mode === "custom" && !el.startTime.value && !el.endTime.value) {
    // Seed the custom fields with the currently selected quick range so
    // switching modes doesn't present an empty, ambiguous range.
    const end = new Date();
    const start = new Date(end.getTime() - state.quickMinutes * 60 * 1000);
    el.startTime.value = toLocalInputValue(start);
    el.endTime.value = toLocalInputValue(end);
  }
}

el.timeModeToggle.addEventListener("click", (evt) => {
  const btn = evt.target.closest(".mode-btn");
  if (!btn) return;
  setTimeMode(btn.dataset.mode);
});

el.quickRange.addEventListener("click", (evt) => {
  const btn = evt.target.closest(".chip");
  if (!btn) return;
  [...el.quickRange.children].forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  state.quickMinutes = Number(btn.dataset.minutes);
});

// Resolves the effective start/end for the search about to run, or throws
// with a user-facing message if the custom range is incomplete.
function resolveTimeRange() {
  if (state.timeMode === "quick") {
    const end = new Date();
    const start = new Date(end.getTime() - state.quickMinutes * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (!el.startTime.value || !el.endTime.value) {
    throw new Error("En modo Personalizado, rellena tanto 'Desde' como 'Hasta'.");
  }
  return {
    start: new Date(el.startTime.value).toISOString(),
    end: new Date(el.endTime.value).toISOString(),
  };
}

// ---------- Search ----------

function collectMatchers() {
  const rows = [...el.matchers.querySelectorAll(".matcher-row")];
  return rows
    .map((row) => ({
      key: row.querySelector(".matcher-key").value.trim(),
      op: row.querySelector(".matcher-op").value,
      value: row.querySelector(".matcher-value").value.trim(),
    }))
    .filter((m) => m.key && m.value);
}

function setStatus(mode, text) {
  const dot = el.connStatus.querySelector(".dot");
  dot.className = `dot dot-${mode}`;
  el.connStatus.querySelector(".status-text").textContent = text;
}

function setLoading(isLoading) {
  el.searchBtn.disabled = isLoading;
  el.searchBtnLabel.textContent = isLoading ? "Buscando… (espera a que termine)" : "Buscar logs";
  setStatus(isLoading ? "loading" : "idle", isLoading ? "Consultando Loki…" : "Listo");
}

function renderQueryMeta(meta) {
  if (!meta) {
    el.queryMeta.hidden = true;
    return;
  }
  const emptyNote = meta.count === 0
    ? `<span class="meta-empty">⚠ 0 resultados — revisa Org ID, labels o rango.</span>\n`
    : "";
  el.queryMeta.innerHTML =
    `${emptyNote}query: ${escapeHtml(meta.query || "(sin selector)")}\n` +
    `orgId: ${escapeHtml(meta.orgId || "(vacío — sin cabecera X-Scope-OrgID)")}\n` +
    `rango: ${escapeHtml(meta.start || "?")} → ${escapeHtml(meta.end || "?")}`;
  el.queryMeta.hidden = false;
}

async function runSearch() {
  // Hard guard against overlapping searches: a second click while one is
  // still in flight is a no-op, so we never fire concurrent requests at
  // Loki (the button is also disabled, but this covers e.g. Enter-key
  // double submits or race conditions).
  if (state.searching) return;

  const matchers = collectMatchers();
  el.searchError.hidden = true;

  if (matchers.length === 0) {
    el.searchError.textContent = "Añade al menos un label con su valor (ej. namespace = clarel-pro).";
    el.searchError.hidden = false;
    return;
  }

  let range;
  try {
    range = resolveTimeRange();
  } catch (err) {
    el.searchError.textContent = err.message;
    el.searchError.hidden = false;
    return;
  }

  const payload = {
    matchers,
    limit: Number(el.limitSelect.value),
    direction: el.directionSelect.value,
    orgId: el.orgIdInput.value.trim(),
    start: range.start,
    end: range.end,
  };

  state.searching = true;
  setLoading(true);
  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Error ${res.status}`);
    }

    state.entries = (data.entries || []).map((e) => ({
      ...e,
      level: detectSeverity(e.line),
    }));
    setStatus("ok", `${state.entries.length} líneas`);
    renderQueryMeta({
      query: data.query,
      orgId: data.orgId,
      start: data.start,
      end: data.end,
      count: data.count,
    });
    renderLogs();
  } catch (err) {
    setStatus("error", "Error de consulta");
    el.searchError.textContent = err.message || "No se pudo consultar Loki.";
    el.searchError.hidden = false;
    el.queryMeta.hidden = true;
  } finally {
    state.searching = false;
    setLoading(false);
  }
}

el.searchBtn.addEventListener("click", runSearch);
el.addMatcher.addEventListener("click", () => createMatcherRow());

// ---------- Rendering & filtering ----------

function formatTimestamp(nanoStr) {
  const nanos = BigInt(nanoStr);
  const millis = Number(nanos / 1000000n);
  const d = new Date(millis);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function renderLogs() {
  if (state.entries.length === 0) {
    el.emptyState.hidden = false;
    el.logLines.hidden = true;
    el.logLines.innerHTML = "";
    el.resultCount.textContent = "Sin resultados todavía";
    el.downloadBtn.disabled = true;
    return;
  }

  el.emptyState.hidden = true;
  el.logLines.hidden = false;

  const frag = document.createDocumentFragment();
  state.entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = `log-line level-${entry.level}`;
    row.dataset.level = entry.level;
    row.dataset.text = entry.line.toLowerCase();

    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = formatTimestamp(entry.timestamp);

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = entry.level === "unknown" ? "LOG" : entry.level.toUpperCase();

    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = entry.line;

    row.append(ts, badge, msg);
    frag.appendChild(row);
  });

  el.logLines.innerHTML = "";
  el.logLines.appendChild(frag);

  applyFilters();
}

function applyFilters() {
  const rows = el.logLines.querySelectorAll(".log-line");
  let visible = 0;

  rows.forEach((row) => {
    const matchesSeverity = state.severityFilter === "all" || row.dataset.level === state.severityFilter;
    const matchesText = !state.textFilter || row.dataset.text.includes(state.textFilter);
    const show = matchesSeverity && matchesText;
    row.classList.toggle("hidden-by-filter", !show);
    if (show) visible += 1;
  });

  el.resultCount.textContent = `${visible} / ${state.entries.length} líneas`;
  el.downloadBtn.disabled = visible === 0;
}

document.querySelectorAll(".sev-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".sev-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.severityFilter = chip.dataset.sev;
    applyFilters();
  });
});

el.freeFilter.addEventListener("input", () => {
  state.textFilter = el.freeFilter.value.trim().toLowerCase();
  applyFilters();
});

// ---------- Download ----------

el.downloadBtn.addEventListener("click", () => {
  const visibleRows = [...el.logLines.querySelectorAll(".log-line:not(.hidden-by-filter)")];
  if (visibleRows.length === 0) return;

  const lines = visibleRows.map((row) => {
    const ts = row.querySelector(".ts").textContent;
    const msg = row.querySelector(".msg").textContent;
    return `${ts}  ${msg}`;
  });

  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `lokiviews-logs-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ---------- Init ----------

ensureLabelNamesDatalist();
createMatcherRow("namespace");
loadDefaultOrgId().then(loadLabelNames);
