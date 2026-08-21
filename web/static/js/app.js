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
  abortController: null,
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
  layout: document.getElementById("layout"),
  searchPanel: document.getElementById("searchPanel"),
  resizeHandle: document.getElementById("resizeHandle"),
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
  limitCustomInput: document.getElementById("limitCustomInput"),
  directionSelect: document.getElementById("directionSelect"),
  searchBtn: document.getElementById("searchBtn"),
  searchBtnLabel: document.getElementById("searchBtnLabel"),
  searchError: document.getElementById("searchError"),
  resultCount: document.getElementById("resultCount"),
  terminal: document.getElementById("terminal"),
  loadingState: document.getElementById("loadingState"),
  emptyState: document.getElementById("emptyState"),
  logLines: document.getElementById("logLines"),
  freeFilter: document.getElementById("freeFilter"),
  downloadBtn: document.getElementById("downloadBtn"),
  connStatus: document.getElementById("connStatus"),
  searchControls: document.getElementById("searchControls"),
  lifecycleExportToggle: document.getElementById("lifecycleExportToggle"),
  lifecycleExportPanel: document.getElementById("lifecycleExportPanel"),
  lifecycleLookback: document.getElementById("lifecycleLookback"),
  lifecycleExportStart: document.getElementById("lifecycleExportStart"),
  lifecycleProgress: document.getElementById("lifecycleProgress"),
  lifecycleProgressFill: document.getElementById("lifecycleProgressFill"),
  lifecycleProgressText: document.getElementById("lifecycleProgressText"),
  lifecycleExportCancel: document.getElementById("lifecycleExportCancel"),
  lifecycleExportError: document.getElementById("lifecycleExportError"),
};

const labelNamesCacheByOrg = new Map();
const labelValuesCache = new Map(); // key: `${orgId}::${labelName}`

// ---------- Custom autocomplete dropdown ----------
//
// We deliberately don't use the native <datalist> element here: Safari's
// support for it is unreliable (it often only shows suggestions once you
// start typing, not on a plain click/focus, and can miss options added to
// the datalist dynamically after the page loads). This small dropdown is
// fully controlled by us, so "click the field, see what's available"
// works the same in every browser.

function createAutocomplete(input, { getOptions }) {
  const wrap = input.parentElement; // .autocomplete-wrap, position:relative
  const dropdown = document.createElement("div");
  dropdown.className = "autocomplete-dropdown";
  dropdown.hidden = true;
  wrap.appendChild(dropdown);

  let currentOptions = [];
  let activeIndex = -1;

  function renderOptions(options) {
    currentOptions = options;
    activeIndex = -1;
    dropdown.innerHTML = "";
    if (options.length === 0) {
      const empty = document.createElement("div");
      empty.className = "autocomplete-empty";
      empty.textContent = "Sin coincidencias";
      dropdown.appendChild(empty);
      return;
    }
    options.forEach((opt) => {
      const item = document.createElement("div");
      item.className = "autocomplete-item";
      item.textContent = opt;
      // mousedown (not click) + preventDefault fires before the input's
      // blur, so selecting an option never gets swallowed by blur-hiding
      // the dropdown first.
      item.addEventListener("mousedown", (evt) => {
        evt.preventDefault();
        input.value = opt;
        hide();
      });
      dropdown.appendChild(item);
    });
  }

  function highlight(index) {
    activeIndex = index;
    [...dropdown.children].forEach((child, i) => {
      child.classList.toggle("active", i === activeIndex);
    });
  }

  // Focusing the field always shows every available option, even if the
  // field already has text in it (e.g. the prefilled "namespace" key) —
  // clicking in should mean "show me what's possible", not "filter by
  // what's already there". Typing afterwards narrows the list down.
  async function showAll() {
    renderOptions((await getOptions()) || []);
    dropdown.hidden = false;
  }

  async function showFiltered() {
    const all = (await getOptions()) || [];
    const q = input.value.trim().toLowerCase();
    const filtered = q ? all.filter((o) => o.toLowerCase().includes(q)) : all;
    renderOptions(filtered);
    dropdown.hidden = false;
  }

  function hide() {
    dropdown.hidden = true;
  }

  input.addEventListener("focus", showAll);
  input.addEventListener("input", showFiltered);
  input.addEventListener("blur", () => setTimeout(hide, 120));
  input.addEventListener("keydown", (evt) => {
    if (dropdown.hidden) return;
    if (evt.key === "ArrowDown") {
      evt.preventDefault();
      highlight(Math.min(activeIndex + 1, currentOptions.length - 1));
    } else if (evt.key === "ArrowUp") {
      evt.preventDefault();
      highlight(Math.max(activeIndex - 1, 0));
    } else if (evt.key === "Enter" && activeIndex >= 0 && currentOptions[activeIndex] !== undefined) {
      evt.preventDefault();
      input.value = currentOptions[activeIndex];
      hide();
    } else if (evt.key === "Escape") {
      hide();
    }
  });
}

// ---------- Matcher rows ----------

function createMatcherRow(prefillKey = "") {
  const row = document.createElement("div");
  row.className = "matcher-row";
  row.innerHTML = `
    <div class="autocomplete-wrap">
      <input type="text" class="matcher-key" placeholder="label (ej. namespace)" value="${escapeHtml(prefillKey)}" autocomplete="off" />
    </div>
    <select class="matcher-op">
      <option value="=">=</option>
      <option value="!=">!=</option>
      <option value="=~">=~</option>
      <option value="!~">!~</option>
    </select>
    <div class="autocomplete-wrap">
      <input type="text" class="matcher-value" placeholder="valor" autocomplete="off" />
    </div>
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

  // Scoped to whatever the OTHER rows already have filled in (e.g. once
  // namespace="monitoring" is set, this row's suggestions only show
  // labels/values that actually co-occur with that namespace — not
  // everything in the tenant). Reads live at call time, so it stays
  // correct as other rows change.
  createAutocomplete(keyInput, { getOptions: () => loadLabelNames(row) });
  createAutocomplete(valueInput, { getOptions: () => loadLabelValues(keyInput.value.trim(), row) });

  el.matchers.appendChild(row);
  return row;
}

// Builds a LogQL selector from every OTHER fully-filled matcher row (key
// and value both present), used to scope label/value discovery to what's
// already been picked elsewhere in the form. Empty string if there's
// nothing else to scope by yet.
function buildContextSelector(excludeRow) {
  const rows = [...el.matchers.querySelectorAll(".matcher-row")].filter((r) => r !== excludeRow);
  const parts = rows
    .map((row) => ({
      key: row.querySelector(".matcher-key").value.trim(),
      op: row.querySelector(".matcher-op").value,
      value: row.querySelector(".matcher-value").value.trim(),
    }))
    .filter((m) => m.key && m.value)
    .map((m) => `${m.key}${m.op}${JSON.stringify(m.value)}`);
  return parts.length > 0 ? `{${parts.join(", ")}}` : "";
}

// Like Grafana's Explore/log browser: label and value suggestions are
// scoped to the currently selected time range, not just to other
// matchers. If a pod died at 5pm and you're searching from 6pm onward,
// it has no log lines in that window, so Loki won't list it — dead
// pods/labels from outside the selected range simply don't show up.
// Rounded to the minute so autocomplete calls made moments apart (e.g.
// while typing) hit the cache instead of refetching on every keystroke.
function currentDiscoveryTimeRange() {
  try {
    const range = resolveTimeRange();
    const round = (iso) => {
      const d = new Date(iso);
      d.setSeconds(0, 0);
      return d.toISOString();
    };
    return { start: round(range.start), end: round(range.end) };
  } catch (_) {
    // Custom mode with an incomplete range — let Loki fall back to its
    // own default window rather than blocking autocomplete on it.
    return { start: "", end: "" };
  }
}

async function loadLabelValues(name, excludeRow) {
  if (!name) return [];
  const orgId = el.orgIdInput.value.trim();
  const contextQuery = buildContextSelector(excludeRow);
  const { start, end } = currentDiscoveryTimeRange();
  const cacheKey = `${orgId}::${contextQuery}::${start}::${end}::${name}`;
  if (labelValuesCache.has(cacheKey)) {
    return labelValuesCache.get(cacheKey);
  }
  try {
    const qs = new URLSearchParams({ name });
    if (orgId) qs.set("orgId", orgId);
    if (contextQuery) qs.set("query", contextQuery);
    if (start) qs.set("start", start);
    if (end) qs.set("end", end);
    const res = await fetch(`/api/label-values?${qs.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();
    const values = data.values || [];
    labelValuesCache.set(cacheKey, values);
    return values;
  } catch (_) {
    return [];
  }
}

async function loadLabelNames(excludeRow) {
  const orgId = el.orgIdInput.value.trim();
  const contextQuery = buildContextSelector(excludeRow);
  const { start, end } = currentDiscoveryTimeRange();
  const cacheKey = `${orgId}::${contextQuery}::${start}::${end}`;
  if (labelNamesCacheByOrg.has(cacheKey)) {
    return labelNamesCacheByOrg.get(cacheKey);
  }
  try {
    const qs = new URLSearchParams();
    if (orgId) qs.set("orgId", orgId);
    if (contextQuery) qs.set("query", contextQuery);
    if (start) qs.set("start", start);
    if (end) qs.set("end", end);
    const res = await fetch(`/api/labels?${qs.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();
    const names = data.labels || [];
    labelNamesCacheByOrg.set(cacheKey, names);
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

// ---------- Line limit (preset or custom) ----------

el.limitSelect.addEventListener("change", () => {
  el.limitCustomInput.hidden = el.limitSelect.value !== "custom";
  if (el.limitSelect.value === "custom") {
    el.limitCustomInput.focus();
  }
});

// Resolves the effective line limit, or throws with a user-facing message
// if "Personalizado" is selected but left empty/invalid. No artificial
// ceiling on the custom value here — Loki's own configured max decides
// what's actually allowed, and a too-high value just comes back as a
// normal error instead of us silently clamping it to a guess.
function resolveLineLimit() {
  if (el.limitSelect.value !== "custom") {
    return Number(el.limitSelect.value);
  }
  const custom = Number(el.limitCustomInput.value);
  if (!Number.isInteger(custom) || custom < 1) {
    throw new Error("Indica un número de líneas válido (entero, mayor que 0) en el límite personalizado.");
  }
  return custom;
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
  // The button stays clickable throughout: while searching it turns into
  // a Cancel action instead of being disabled, so a search that looks
  // stuck can always be aborted.
  el.searchBtn.disabled = false;
  el.searchBtn.classList.toggle("btn-primary", !isLoading);
  el.searchBtn.classList.toggle("btn-danger", isLoading);
  el.searchBtnLabel.textContent = isLoading ? "✕ Cancelar búsqueda" : "Buscar logs";
  setStatus(isLoading ? "loading" : "idle", isLoading ? "Consultando Loki…" : "Listo");

  if (isLoading) {
    // Hide whatever was previously shown (old results or the empty hint)
    // and show a clear spinner so it's obvious the app is waiting on Loki,
    // not stuck. Success/error handling restores the right view afterwards.
    el.loadingState.hidden = false;
    el.emptyState.hidden = true;
    el.logLines.hidden = true;
  } else {
    el.loadingState.hidden = true;
  }
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
  let limit;
  try {
    range = resolveTimeRange();
    limit = resolveLineLimit();
  } catch (err) {
    el.searchError.textContent = err.message;
    el.searchError.hidden = false;
    return;
  }

  const payload = {
    matchers,
    limit,
    direction: el.directionSelect.value,
    orgId: el.orgIdInput.value.trim(),
    start: range.start,
    end: range.end,
  };

  const controller = new AbortController();
  state.abortController = controller;
  state.searching = true;
  setLoading(true);
  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
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
    const wasCancelled = err.name === "AbortError";
    setStatus(wasCancelled ? "idle" : "error", wasCancelled ? "Cancelada" : "Error de consulta");
    el.searchError.textContent = wasCancelled
      ? "Búsqueda cancelada."
      : err.message || "No se pudo consultar Loki.";
    el.searchError.hidden = false;
    el.queryMeta.hidden = true;
    // setLoading(true) hid whatever was on screen; since this search
    // didn't complete, state.entries is unchanged, so just re-sync the
    // view to it (old results reappear, or the empty hint if there were none).
    if (state.entries.length > 0) {
      el.logLines.hidden = false;
    } else {
      el.emptyState.hidden = false;
    }
  } finally {
    state.searching = false;
    state.abortController = null;
    setLoading(false);
  }
}

el.searchBtn.addEventListener("click", () => {
  if (state.searching) {
    state.abortController?.abort();
  } else {
    runSearch();
  }
});
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

// ---------- Resizable search panel ----------
//
// Uses Pointer Events (not separate mouse/touch listeners) so dragging
// works the same with a mouse, trackpad, or a finger on a touch screen.
// The chosen width is clamped and persisted so it survives a reload.

const PANEL_WIDTH_KEY = "lokiviews.searchPanelWidth";
const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 640;

function applyPanelWidth(px) {
  const clamped = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, px));
  el.layout.style.setProperty("--search-panel-w", `${clamped}px`);
  return clamped;
}

function initResizablePanel() {
  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  if (saved) applyPanelWidth(saved);

  let dragging = false;

  el.resizeHandle.addEventListener("pointerdown", (evt) => {
    dragging = true;
    el.resizeHandle.setPointerCapture(evt.pointerId);
    document.body.classList.add("resizing-panel");
  });

  el.resizeHandle.addEventListener("pointermove", (evt) => {
    if (!dragging) return;
    const rect = el.searchPanel.getBoundingClientRect();
    applyPanelWidth(evt.clientX - rect.left);
  });

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing-panel");
    const width = el.searchPanel.getBoundingClientRect().width;
    localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
  };
  el.resizeHandle.addEventListener("pointerup", stopDragging);
  el.resizeHandle.addEventListener("pointercancel", stopDragging);
}

// ---------- Full lifecycle export ----------
//
// Downloads *everything* a stream selector has ever logged, from its
// first known line to its last, by paging through /api/export (Server-
// Sent Events) — not meant for on-screen preview, only for saving to
// disk. Progress is the real fraction of the object's observed lifetime
// (first log to last log) covered so far, computed server-side from the
// actual timestamps being paged through — never an animated/fake guess.

let lifecycleEventSource = null;

// The lifecycle export only ever uses the current matchers/Org ID — it
// ignores the time range, line limit and direction entirely (it always
// fetches everything, from first log to last). Leaving those controls
// looking active while this panel is open would wrongly suggest they
// still affect the export, so they're visually dimmed and made
// non-interactive for as long as the panel stays open.
function setSearchControlsLocked(locked) {
  el.searchControls.classList.toggle("locked", locked);
  const controls = [
    ...el.timeModeToggle.querySelectorAll(".mode-btn"),
    ...el.quickRange.querySelectorAll(".chip"),
    el.startTime,
    el.endTime,
    el.limitSelect,
    el.limitCustomInput,
    el.directionSelect,
  ];
  controls.forEach((control) => {
    control.disabled = locked;
  });
  // Never disable the search button while it's actively showing "Cancelar
  // búsqueda" — the user must always be able to stop a search that's
  // already in flight, even with the lifecycle panel open.
  if (!state.searching) {
    el.searchBtn.disabled = locked;
  }
}

el.lifecycleExportToggle.addEventListener("click", () => {
  const willBeOpen = el.lifecycleExportPanel.hidden;
  el.lifecycleExportPanel.hidden = !willBeOpen;
  setSearchControlsLocked(willBeOpen);
});

function resetLifecycleUI() {
  el.lifecycleExportStart.disabled = false;
  el.lifecycleProgress.hidden = true;
  el.lifecycleProgressFill.style.width = "0%";
}

function stopLifecycleExport() {
  if (lifecycleEventSource) {
    lifecycleEventSource.close();
    lifecycleEventSource = null;
  }
}

el.lifecycleExportStart.addEventListener("click", () => {
  const matchers = collectMatchers();
  el.lifecycleExportError.hidden = true;

  if (matchers.length === 0) {
    el.lifecycleExportError.textContent = "Añade al menos un label con su valor.";
    el.lifecycleExportError.hidden = false;
    return;
  }

  stopLifecycleExport();

  const qs = new URLSearchParams();
  qs.set("matchers", JSON.stringify(matchers));
  const orgId = el.orgIdInput.value.trim();
  if (orgId) qs.set("orgId", orgId);
  qs.set("lookbackDays", el.lifecycleLookback.value);

  el.lifecycleExportStart.disabled = true;
  el.lifecycleProgress.hidden = false;
  el.lifecycleProgressFill.style.width = "0%";
  el.lifecycleProgressText.textContent = "Buscando la primera y última aparición…";

  lifecycleEventSource = new EventSource(`/api/export?${qs.toString()}`);

  lifecycleEventSource.addEventListener("started", (evt) => {
    const data = JSON.parse(evt.data);
    el.lifecycleProgressText.textContent = `Encontrado: ${data.firstSeen} → ${data.lastSeen}. Descargando…`;
  });

  lifecycleEventSource.addEventListener("progress", (evt) => {
    const data = JSON.parse(evt.data);
    const pct = data.percent.toFixed(1);
    el.lifecycleProgressFill.style.width = `${pct}%`;
    el.lifecycleProgressText.textContent = `${pct}% — ${data.lines.toLocaleString("es-ES")} líneas descargadas`;
  });

  lifecycleEventSource.addEventListener("done", (evt) => {
    const data = JSON.parse(evt.data);
    el.lifecycleProgressFill.style.width = "100%";
    el.lifecycleProgressText.textContent =
      `Completado: ${data.lines.toLocaleString("es-ES")} líneas` +
      (data.truncated ? " (cortado por el límite de seguridad — el objeto tiene aún más historial)" : "");
    stopLifecycleExport();
    el.lifecycleExportStart.disabled = false;
    // A normal browser download, not a JS Blob — the file can be huge and
    // this streams straight to disk instead of holding it all in memory.
    window.location.href = `/api/export/download?id=${encodeURIComponent(data.downloadId)}`;
  });

  lifecycleEventSource.addEventListener("failed", (evt) => {
    let message = "Error durante la exportación.";
    try {
      message = JSON.parse(evt.data).error || message;
    } catch (_) {
      // keep default message
    }
    el.lifecycleExportError.textContent = message;
    el.lifecycleExportError.hidden = false;
    stopLifecycleExport();
    resetLifecycleUI();
  });

  lifecycleEventSource.onerror = () => {
    // Fires on a genuine connection drop — "done"/"failed" already close
    // the stream themselves before this would have a chance to matter.
    if (!lifecycleEventSource) return;
    el.lifecycleExportError.textContent = "Se perdió la conexión durante la exportación.";
    el.lifecycleExportError.hidden = false;
    stopLifecycleExport();
    resetLifecycleUI();
  };
});

el.lifecycleExportCancel.addEventListener("click", () => {
  stopLifecycleExport();
  el.lifecycleProgressText.textContent = "Cancelado.";
  el.lifecycleExportStart.disabled = false;
});

// ---------- Init ----------

createMatcherRow("namespace");
loadDefaultOrgId().then(loadLabelNames);
initResizablePanel();
