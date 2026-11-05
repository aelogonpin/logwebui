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
  timeMode: "quick", // "quick" | "custom" | "live" — mutually exclusive
  quickMinutes: 1440,
  timezone: "browser", // "browser" | "UTC" | any IANA zone name — display/input zone, set below
  lastQueryMeta: null, // re-rendered when the timezone changes, see renderQueryMeta()
  live: {
    eventSource: null,
    active: false, // a live tail is running (independent of momentary drops)
    paused: false, // user scrolled away from the bottom — auto-follow suspended
    reconnectTimer: null,
    loadingOlder: false,
    reachedBeginning: false,
  },
};

// Buffer caps for Directo (modo live): the soft cap only trims while the
// user is following along (they're not looking at what gets dropped); the
// hard cap trims regardless, purely to protect browser memory if "Directo"
// is left open and scrolled back for a long time. Both enforced client
// side only — the backend never buffers anything, see internal/api/live.go.
const LIVE_SOFT_CAP = 20000;
const LIVE_HARD_CAP = 100000;
const LIVE_RECONNECT_DELAY_MS = 3000;
const LIVE_DEFAULT_BACKFILL_MS = 5 * 60 * 1000;
const LIVE_OLDER_PAGE_SIZE = 500;
// Expanding lookback windows tried, in order, when paging older history:
// Loki streams have gaps, so "the 15 minutes right before what's loaded"
// may well be empty even though older data exists further back.
const LIVE_OLDER_WINDOWS_MS = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
];
const SCROLL_BOTTOM_THRESHOLD_PX = 40;
const SCROLL_TOP_THRESHOLD_PX = 80;

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
  discoverTenantsBtn: document.getElementById("discoverTenantsBtn"),
  discoverTenantsError: document.getElementById("discoverTenantsError"),
  matchers: document.getElementById("matchers"),
  addMatcher: document.getElementById("addMatcher"),
  timeModeToggle: document.getElementById("timeModeToggle"),
  quickRange: document.getElementById("quickRange"),
  customRangeRow: document.getElementById("customRangeRow"),
  startTime: document.getElementById("startTime"),
  endTime: document.getElementById("endTime"),
  liveStartRow: document.getElementById("liveStartRow"),
  liveStartTime: document.getElementById("liveStartTime"),
  tzHintCustom: document.getElementById("tzHintCustom"),
  tzHintLive: document.getElementById("tzHintLive"),
  olderLoader: document.getElementById("olderLoader"),
  olderEndHint: document.getElementById("olderEndHint"),
  jumpToLiveBtn: document.getElementById("jumpToLiveBtn"),
  autoScrollToggle: document.getElementById("autoScrollToggle"),
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
  timezoneSelect: document.getElementById("timezoneSelect"),
  timeRangeControls: document.getElementById("timeRangeControls"),
  limitControls: document.getElementById("limitControls"),
  limitFields: document.getElementById("limitFields"),
  lifecycleExportToggle: document.getElementById("lifecycleExportToggle"),
  lifecycleExportPanel: document.getElementById("lifecycleExportPanel"),
  lifecycleLookback: document.getElementById("lifecycleLookback"),
  lifecycleExportStart: document.getElementById("lifecycleExportStart"),
  lifecycleProgress: document.getElementById("lifecycleProgress"),
  lifecycleProgressFill: document.getElementById("lifecycleProgressFill"),
  lifecycleProgressText: document.getElementById("lifecycleProgressText"),
  lifecycleExportCancel: document.getElementById("lifecycleExportCancel"),
  lifecycleExportError: document.getElementById("lifecycleExportError"),
  rangeDownloadProgress: document.getElementById("rangeDownloadProgress"),
  rangeDownloadNotice: document.getElementById("rangeDownloadNotice"),
  rangeDownloadFill: document.getElementById("rangeDownloadFill"),
  rangeDownloadText: document.getElementById("rangeDownloadText"),
  rangeDownloadCancel: document.getElementById("rangeDownloadCancel"),
};

// ---------- Timezone ----------
//
// Grafana-style global timezone picker: everything shown or typed as a
// wall-clock time (the per-line badges, "rango:" in the query meta, and
// the Desde/Hasta/"Comenzar desde" datetime-local fields) is interpreted
// in this single zone instead of always assuming the browser's own zone,
// so a UTC-only Loki tenant or a team in another timezone doesn't have to
// convert by hand. The backend is untouched — it only ever sees/returns
// UTC instants (RFC3339); this is purely a client-side display/input
// concern.
//
// No date library: the project has zero external dependencies on
// purpose (see go.mod), and Intl.DateTimeFormat already supports
// arbitrary IANA zones natively in every evergreen browser, so
// implementing the (well-known) two-pass wall-clock<->UTC conversion
// below is cheaper than pulling one in.

const TIMEZONE_STORAGE_KEY = "lokiviews.timezone";

function loadStoredTimezone() {
  try {
    return localStorage.getItem(TIMEZONE_STORAGE_KEY) || "browser";
  } catch (_) {
    return "browser";
  }
}

// undefined means "let the runtime use its own local zone" — the exact
// pre-existing behavior of plain Date/toLocaleString calls, kept as the
// default so nothing changes for anyone who never touches the picker.
function effectiveTimeZone() {
  return state.timezone === "browser" ? undefined : state.timezone;
}

function timezoneDisplayLabel() {
  if (state.timezone === "browser") {
    try {
      return `navegador (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
    } catch (_) {
      return "navegador";
    }
  }
  return state.timezone;
}

// How far `timeZone`'s wall clock is ahead of UTC, in ms, at the instant
// `date` (e.g. Europe/Madrid in August is CEST, UTC+2, so +7200000).
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - date.getTime();
}

// Converts wall-clock components (as typed by a user, meant to be read in
// `timeZone`) into the Date representing that actual instant. Two passes:
// right around a DST transition the offset at the first guess can differ
// from the offset at the corrected instant, so the second pass re-derives
// it from the corrected instant instead of trusting the first one blindly.
function zonedTimeToUtc(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const corrected = guess - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - tzOffsetMs(new Date(corrected), timeZone));
}

// Parses a <input type="datetime-local"> value ("YYYY-MM-DDTHH:MM"),
// interpreting it as wall-clock time in `timeZone` (undefined = browser's
// own local zone, i.e. the pre-existing `new Date(value)` behavior).
function parseZonedInputValue(value, timeZone) {
  if (!value) return null;
  const [datePart, timePart] = value.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = (timePart || "00:00").split(":").map(Number);
  if (!timeZone) return new Date(y, mo - 1, d, h, mi, 0, 0);
  return zonedTimeToUtc(y, mo, d, h, mi, 0, timeZone);
}

// Inverse of parseZonedInputValue: formats an absolute instant as the
// "YYYY-MM-DDTHH:MM" wall-clock it corresponds to in `timeZone`, for
// populating a datetime-local input.
function toZonedInputValue(date, timeZone) {
  if (!timeZone) return toLocalInputValue(date);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// Formats an absolute instant as HH:MM:SS.mmm in `timeZone` (undefined =
// browser local), for the per-line timestamp badge.
function formatTimeInZone(date, timeZone) {
  const pad = (n) => String(n).padStart(2, "0");
  if (!timeZone) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
  }
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}:${p.second}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

// Common zones covering most timezone offsets, used only as a fallback
// for browsers without Intl.supportedValuesOf (Safari < 15.4) — everyone
// else gets the full IANA list straight from the runtime.
const FALLBACK_TIMEZONES = [
  "Europe/Madrid", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Lisbon",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Mexico_City", "America/Bogota", "America/Sao_Paulo", "America/Argentina/Buenos_Aires",
  "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore",
  "Australia/Sydney", "Pacific/Auckland",
];

function initTimezoneSelect() {
  const makeOption = (value, label) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    return opt;
  };

  let browserLabel = "Navegador (zona local)";
  try {
    browserLabel = `Navegador (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  } catch (_) {
    // keep generic label
  }
  el.timezoneSelect.appendChild(makeOption("browser", browserLabel));
  el.timezoneSelect.appendChild(makeOption("UTC", "UTC"));

  let zones = [];
  try {
    zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch (_) {
    zones = [];
  }
  if (zones.length === 0) zones = FALLBACK_TIMEZONES;

  const group = document.createElement("optgroup");
  group.label = "Otras zonas";
  zones
    .filter((z) => z !== "UTC")
    .sort()
    .forEach((z) => group.appendChild(makeOption(z, z)));
  el.timezoneSelect.appendChild(group);

  state.timezone = loadStoredTimezone();
  el.timezoneSelect.value = state.timezone;
  if (el.timezoneSelect.value !== state.timezone) {
    // Stored zone isn't in this browser's list — fall back rather than
    // silently keep a selection the <select> can't actually represent.
    state.timezone = "browser";
    el.timezoneSelect.value = "browser";
  }
  updateTzHints();
}

// Small reminder under the datetime-local fields of which zone their
// typed values are read in — the fields themselves are plain
// "YYYY-MM-DDTHH:MM" with no zone indicator of their own, so without this
// it's easy to forget which zone a value you typed a while ago means.
function updateTzHints() {
  const text = `Hora introducida en: ${timezoneDisplayLabel()}`;
  el.tzHintCustom.textContent = text;
  el.tzHintCustom.hidden = state.timeMode !== "custom";
  el.tzHintLive.textContent = text;
  el.tzHintLive.hidden = state.timeMode !== "live";
}

el.timezoneSelect.addEventListener("change", () => {
  const oldTz = effectiveTimeZone();
  const newTzValue = el.timezoneSelect.value;
  const newTz = newTzValue === "browser" ? undefined : newTzValue;

  // Re-interpret whatever is currently typed in the datetime-local fields
  // under the OLD zone, then re-render it as it appears in the NEW zone,
  // so the switch preserves the actual instant selected instead of
  // silently reinterpreting the same digits under a different zone.
  [el.startTime, el.endTime, el.liveStartTime].forEach((input) => {
    if (!input.value) return;
    const instant = parseZonedInputValue(input.value, oldTz);
    if (instant) input.value = toZonedInputValue(instant, newTz);
  });

  state.timezone = newTzValue;
  try {
    localStorage.setItem(TIMEZONE_STORAGE_KEY, newTzValue);
  } catch (_) {
    // best-effort only — a private-browsing tab just won't remember it
  }

  updateTzHints();

  // Re-render whatever's already on screen so the switch is visible
  // immediately, without forcing a new search.
  if (state.entries.length > 0) renderLogs();
  if (state.lastQueryMeta) renderQueryMeta(state.lastQueryMeta);
});

initTimezoneSelect();

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
      item.title = opt; // full name on hover — long values get cut off with an ellipsis
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
  const round = (iso) => {
    const d = new Date(iso);
    d.setSeconds(0, 0);
    return d.toISOString();
  };

  // While configuring a full-lifecycle export, discovery should look
  // back as far as THAT export will (e.g. 30 days) instead of the main
  // search's time range (often just the last 24h). Otherwise a pod that
  // was recreated a week ago under a new name (a new rollout gets a new
  // ReplicaSet hash) never shows up as a suggestion, even though it's
  // exactly the kind of past incarnation this feature exists to find.
  if (!el.lifecycleExportPanel.hidden) {
    const days = Number(el.lifecycleLookback.value) || 30;
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { start: round(start.toISOString()), end: round(end.toISOString()) };
  }

  // Directo has no fixed range to resolve — scope discovery to "what's
  // active right now", same criterion the Rápido mode already uses.
  if (state.timeMode === "live") {
    const end = new Date();
    const start = new Date(end.getTime() - LIVE_DEFAULT_BACKFILL_MS);
    return { start: round(start.toISOString()), end: round(end.toISOString()) };
  }

  try {
    const range = resolveTimeRange();
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

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const data = await res.json();
    // Always assign (never conditionally): browsers restore a text
    // input's previous value on reload on their own, independent of any
    // caching we do (we don't cache the Org ID anywhere — see below).
    // Only writing this when defaultOrgId is truthy meant a
    // browser-restored stale value from a PREVIOUS session (e.g. one
    // where LOKI_ORG_ID/MIMIR_* were set) would silently survive even
    // after those env vars were removed and the server restarted.
    el.orgIdInput.value = data.defaultOrgId || "";
    // Only shown when MIMIR_URL is configured server-side — without it,
    // /api/tenants 404s, so there's nothing this button could do.
    el.discoverTenantsBtn.hidden = !data.mimirEnabled;
    if (data.mimirEnabled) {
      enableTenantAutocomplete();
    }
  } catch (_) {
    // /api/config itself failed — still clear whatever the browser
    // restored, same reasoning as above.
    el.orgIdInput.value = "";
  }
}

el.orgIdInput.addEventListener("change", () => {
  loadLabelNames();
});

// ---------- Tenant (Org ID) autodiscovery via Mimir ----------
//
// Optional: reads the "tenant" label off Loki's own self-monitoring
// metrics back from Mimir (see internal/mimir), so the Org ID field can
// suggest tenants that actually have data instead of being typed blind.
// Fetched once per click (not automatically) since it's a comparatively
// heavy query on infra the user may not always have configured.

let discoveredTenants = null;
let tenantAutocompleteEnabled = false;

// Only wired up once /api/config confirms MIMIR_URL is actually set
// (see loadConfig above). Attaching this unconditionally would make the
// Org ID field pop up an (always-empty) "Sin coincidencias" dropdown on
// focus even with the feature fully disabled server-side — a visible
// hint that this discovery mechanism exists at all, worth avoiding.
function enableTenantAutocomplete() {
  if (tenantAutocompleteEnabled) return;
  tenantAutocompleteEnabled = true;
  createAutocomplete(el.orgIdInput, { getOptions: () => discoveredTenants || [] });
}

el.discoverTenantsBtn.addEventListener("click", async () => {
  el.discoverTenantsError.hidden = true;
  el.discoverTenantsBtn.disabled = true;
  const originalHTML = el.discoverTenantsBtn.innerHTML;
  el.discoverTenantsBtn.textContent = "Buscando tenants…";

  try {
    const res = await fetch("/api/tenants");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

    discoveredTenants = data.tenants || [];
    if (discoveredTenants.length === 0) {
      el.discoverTenantsError.textContent = "Mimir no devolvió ningún tenant con datos recientes.";
      el.discoverTenantsError.hidden = false;
    } else {
      el.orgIdInput.focus(); // opens the dropdown via the existing focus handler
    }
  } catch (err) {
    el.discoverTenantsError.textContent = err.message || "No se pudo consultar Mimir.";
    el.discoverTenantsError.hidden = false;
  } finally {
    el.discoverTenantsBtn.disabled = false;
    el.discoverTenantsBtn.innerHTML = originalHTML;
  }
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

// Limit/direction don't apply to Directo (the buffer cap is fixed, and
// entries only ever arrive forward) — reuses the same visual "locked"
// treatment already used to dim search controls while the lifecycle-export
// panel is open (setSearchControlsLocked() below), but scoped to
// #limitFields rather than the whole #limitControls: that outer container
// also holds searchBtn, and .search-controls.locked sets
// pointer-events:none on everything except a #searchBtn already showing
// "Cancelar" — which would make "Iniciar directo" unclickable if the lock
// were applied there instead.
function setLimitControlsLocked(locked) {
  el.limitFields.classList.toggle("locked", locked);
  [el.limitSelect, el.limitCustomInput, el.directionSelect].forEach((control) => {
    control.disabled = locked;
  });
}

// In a custom range the choice is the whole date range (the default) or a
// specific number of lines; the presets only apply to the other modes.
// Leaving it restores the earlier choice, unless the user typed a number.
let limitBeforeCustomMode = null;

function applyLimitOptionsForMode(previousMode, mode) {
  const isCustomRange = mode === "custom";
  [...el.limitSelect.options].forEach((option) => {
    const available = option.value === "custom" || (option.value === "all") === isCustomRange;
    option.hidden = !available;
    option.disabled = !available;
  });

  if (isCustomRange && previousMode !== "custom") {
    limitBeforeCustomMode = el.limitSelect.value;
    el.limitSelect.value = "all";
  } else if (!isCustomRange && el.limitSelect.value === "all") {
    el.limitSelect.value = limitBeforeCustomMode;
  }
  el.limitCustomInput.hidden = el.limitSelect.value !== "custom";
}

function setTimeMode(mode) {
  if (state.timeMode === "live" && mode !== "live") {
    stopLiveTail();
  }

  applyLimitOptionsForMode(state.timeMode, mode);
  state.timeMode = mode;
  [...el.timeModeToggle.children].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  el.quickRange.hidden = mode !== "quick";
  el.customRangeRow.hidden = mode !== "custom";
  el.liveStartRow.hidden = mode !== "live";
  setLimitControlsLocked(mode === "live");
  updateSearchBtnForMode();
  updateTzHints();

  if (mode === "custom" && !el.startTime.value && !el.endTime.value) {
    // Seed the custom fields with the currently selected quick range so
    // switching modes doesn't present an empty, ambiguous range.
    const end = new Date();
    const start = new Date(end.getTime() - state.quickMinutes * 60 * 1000);
    const tz = effectiveTimeZone();
    el.startTime.value = toZonedInputValue(start, tz);
    el.endTime.value = toZonedInputValue(end, tz);
  }
}

el.timeModeToggle.addEventListener("click", (evt) => {
  const btn = evt.target.closest(".mode-btn");
  if (!btn) return;
  setTimeMode(btn.dataset.mode);
});

// Resolves the optional "Comenzar desde" instant for Directo (null =
// start now, with a small default backfill applied by runLiveTail), or
// throws with a user-facing message if it's set but invalid/future-dated.
function resolveLiveStart() {
  if (!el.liveStartTime.value) return null;
  const d = parseZonedInputValue(el.liveStartTime.value, effectiveTimeZone());
  if (!d || Number.isNaN(d.getTime())) {
    throw new Error("La fecha de 'Comenzar desde' no es válida.");
  }
  if (d.getTime() > Date.now()) {
    throw new Error("'Comenzar desde' no puede estar en el futuro.");
  }
  return d.toISOString();
}

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
  const tz = effectiveTimeZone();
  return {
    start: parseZonedInputValue(el.startTime.value, tz).toISOString(),
    end: parseZonedInputValue(el.endTime.value, tz).toISOString(),
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
// if a custom number is selected but left empty/invalid. "Whole range" is
// just over the preview cap: that makes the search count the lines first,
// so it either fits in the viewer in full or downloads the whole range.
function resolveLineLimit() {
  if (el.limitSelect.value === "all") {
    return MAX_PREVIEW_LINES + 1;
  }
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

// Download name: tenant, filtered label values and extraction date, e.g.
// Clarel-pro_comerzzia-pro_my-container_2026-11-05_14-34.txt
function logFileName() {
  const labelValues = collectMatchers()
    .filter((m) => m.op === "=" || m.op === "=~")
    .map((m) => m.value);
  const name = [el.orgIdInput.value.trim(), ...labelValues]
    .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, ""))
    .filter(Boolean)
    .join("_")
    .slice(0, 150);
  const date = toZonedInputValue(new Date(), effectiveTimeZone()).replace("T", "_").replace(":", "-");
  return `${name || "logs"}_${date}.txt`;
}

function setStatus(mode, text) {
  const dot = el.connStatus.querySelector(".dot");
  dot.className = `dot dot-${mode}`;
  el.connStatus.querySelector(".status-text").textContent = text;
}

// Above this many lines a search downloads to a file instead of opening
// in the viewer, which creates one DOM node per line and would hang the tab.
const MAX_PREVIEW_LINES = 100000;

// Null when the count isn't available: the search then proceeds as usual.
async function countLines(payload, signal) {
  try {
    const res = await fetch("/api/count", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()).count;
  } catch (err) {
    if (err.name === "AbortError") throw err;
    return null;
  }
}

function restoreResultsView() {
  if (state.entries.length > 0) {
    el.logLines.hidden = false;
  } else {
    el.emptyState.hidden = false;
  }
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

function formatRangeLocal(isoStr) {
  if (!isoStr) return "?";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;
  return d.toLocaleString("es-ES", {
    timeZone: effectiveTimeZone(),
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function renderQueryMeta(meta) {
  state.lastQueryMeta = meta || null;
  if (!meta) {
    el.queryMeta.hidden = true;
    return;
  }
  const emptyNote = meta.count === 0
    ? `<span class="meta-empty">⚠ 0 resultados — revisa Org ID, labels o rango.</span>\n`
    : "";
  // meta.start/end vienen del backend en UTC (RFC3339). Se muestran en la
  // zona elegida en el selector de cabecera (igual que los timestamps de
  // cada línea y los campos de fecha del formulario) para que el rango
  // visible coincida con lo que se pidió, en vez de forzar al usuario a
  // convertir zonas mentalmente.
  el.queryMeta.innerHTML =
    `${emptyNote}query: ${escapeHtml(meta.query || "(sin selector)")}\n` +
    `orgId: ${escapeHtml(meta.orgId || "(vacío — sin cabecera X-Scope-OrgID)")}\n` +
    `rango: ${escapeHtml(formatRangeLocal(meta.start))} → ${escapeHtml(formatRangeLocal(meta.end))} (zona: ${escapeHtml(timezoneDisplayLabel())})`;
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
    el.searchError.textContent = "Añade al menos un label con su valor (ej. namespace = backend).";
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

  // A finished download's notice no longer describes the current search.
  if (activeExport?.ui.progress !== el.rangeDownloadProgress) {
    el.rangeDownloadProgress.hidden = true;
  }

  const controller = new AbortController();
  state.abortController = controller;
  state.searching = true;
  setLoading(true);
  try {
    if (limit > MAX_PREVIEW_LINES) {
      const total = await countLines(payload, controller.signal);
      if (total > MAX_PREVIEW_LINES) {
        startRangeDownload(payload, total);
        restoreResultsView();
        return;
      }
    }

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
    restoreResultsView();
  } finally {
    state.searching = false;
    state.abortController = null;
    setLoading(false);
  }
}

el.searchBtn.addEventListener("click", () => {
  if (state.timeMode === "live") {
    if (state.live.active) {
      stopLiveTail();
      setStatus("idle", "Listo");
    } else {
      runLiveTail();
    }
    return;
  }
  if (state.searching) {
    state.abortController?.abort();
  } else {
    runSearch();
  }
});
el.addMatcher.addEventListener("click", () => createMatcherRow());

// ---------- Live tail (modo Directo) ----------
//
// Loki's native tail is a WebSocket endpoint, but this project has zero
// external dependencies on purpose (see go.mod) and the Go standard
// library has no WebSocket client — hand-rolling RFC6455 framing just for
// this would be a lot of protocol code for a small ops tool. Instead the
// backend (/api/live, internal/api/live.go) polls query_range at a fixed
// low cadence and relays only the new lines over Server-Sent Events, so
// each poll is cheap regardless of how long the tail runs.
//
// Reconnection is handled here by hand (not via EventSource's built-in
// retry) so every reconnect attempt can resume from the last entry
// actually seen instead of replaying from the original start.

function nanosToISO(nanoStr) {
  const millis = Number(BigInt(nanoStr) / 1000000n);
  return new Date(millis).toISOString();
}

function updateSearchBtnForMode() {
  const isLive = state.timeMode === "live";
  const running = isLive && state.live.active;
  el.autoScrollToggle.hidden = !running;

  if (state.searching) return; // a point query is in flight — leave it alone
  el.searchBtn.classList.toggle("btn-primary", !running);
  el.searchBtn.classList.toggle("btn-danger", running);
  el.searchBtnLabel.textContent = running
    ? "✕ Detener directo"
    : isLive
      ? "▶ Iniciar directo"
      : "Buscar logs";
}

// Single source of truth for "is Directo auto-following new lines right
// now", kept in sync across the three ways it can change: scrolling away
// from / back to the bottom, the explicit toggle button, and the floating
// "Volver al directo" button — all three funnel through here instead of
// touching state.live.paused directly, so the toggle's label, the
// floating button's visibility, and the actual scroll position can never
// drift out of sync with each other.
function setLivePaused(paused) {
  state.live.paused = paused;
  el.jumpToLiveBtn.hidden = !paused;
  el.autoScrollToggle.classList.toggle("active", !paused);
  el.autoScrollToggle.textContent = paused ? "▶ Auto-scroll pausado" : "⏸ Auto-scroll activo";
  if (!paused) {
    el.terminal.scrollTop = el.terminal.scrollHeight;
  }
}

function stopLiveTail() {
  if (state.live.eventSource) {
    state.live.eventSource.close();
    state.live.eventSource = null;
  }
  if (state.live.reconnectTimer) {
    clearTimeout(state.live.reconnectTimer);
    state.live.reconnectTimer = null;
  }
  state.live.active = false;
  el.jumpToLiveBtn.hidden = true;
  updateSearchBtnForMode();
}

// Caps the in-browser buffer so an unattended Directo tab can't grow
// without bound — the backend never buffers anything itself (see
// internal/api/live.go), so this is the only place the cap is enforced.
function trimLiveBuffer() {
  const cap = state.live.paused ? LIVE_HARD_CAP : LIVE_SOFT_CAP;
  const excess = state.entries.length - cap;
  if (excess <= 0) return;
  state.entries.splice(0, excess);
  for (let i = 0; i < excess; i++) {
    el.logLines.firstElementChild?.remove();
  }
}

function appendLiveEntries(newEntries) {
  if (!newEntries || newEntries.length === 0) return;

  const wasEmpty = state.entries.length === 0;
  const frag = document.createDocumentFragment();
  newEntries.forEach((e) => {
    const entry = { ...e, level: detectSeverity(e.line) };
    state.entries.push(entry);
    frag.appendChild(buildLogLineEl(entry));
  });
  el.logLines.appendChild(frag);

  if (wasEmpty) {
    el.emptyState.hidden = true;
    el.logLines.hidden = false;
  }

  trimLiveBuffer();
  applyFilters();

  if (!state.live.paused) {
    el.terminal.scrollTop = el.terminal.scrollHeight;
  }
}

function connectLive(matchers, orgId, sinceIso) {
  const qs = new URLSearchParams();
  qs.set("matchers", JSON.stringify(matchers));
  if (orgId) qs.set("orgId", orgId);
  if (sinceIso) qs.set("start", sinceIso);

  const es = new EventSource(`/api/live?${qs.toString()}`);
  state.live.eventSource = es;

  const reconnect = () => {
    if (!state.live.active || state.live.eventSource !== es) return;
    es.close();
    setStatus("error", "Reconectando…");
    const lastEntry = state.entries[state.entries.length - 1];
    const resumeIso = lastEntry ? nanosToISO(lastEntry.timestamp) : sinceIso;
    state.live.reconnectTimer = setTimeout(() => {
      connectLive(matchers, orgId, resumeIso);
    }, LIVE_RECONNECT_DELAY_MS);
  };

  es.addEventListener("connected", () => {
    setStatus("ok", state.live.paused ? "En directo (pausado)" : "En directo");
  });

  es.addEventListener("heartbeat", () => {
    if (!state.live.paused) setStatus("ok", "En directo");
  });

  es.addEventListener("entries", (evt) => {
    const data = JSON.parse(evt.data);
    appendLiveEntries(data.entries);
    if (!state.live.paused) setStatus("ok", "En directo");
  });

  es.addEventListener("failed", (evt) => {
    let message = "Error en el directo.";
    try {
      message = JSON.parse(evt.data).error || message;
    } catch (_) {
      // keep default message
    }
    el.searchError.textContent = message;
    el.searchError.hidden = false;
    reconnect();
  });

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) reconnect();
  };
}

function runLiveTail() {
  const matchers = collectMatchers();
  el.searchError.hidden = true;

  if (matchers.length === 0) {
    el.searchError.textContent = "Añade al menos un label con su valor (ej. namespace = backend).";
    el.searchError.hidden = false;
    return;
  }

  let sinceIso;
  try {
    sinceIso = resolveLiveStart() || new Date(Date.now() - LIVE_DEFAULT_BACKFILL_MS).toISOString();
  } catch (err) {
    el.searchError.textContent = err.message;
    el.searchError.hidden = false;
    return;
  }

  stopLiveTail();
  state.entries = [];
  state.live.reachedBeginning = false;
  el.olderEndHint.hidden = true;
  el.queryMeta.hidden = true;
  renderLogs();
  setLivePaused(false);

  state.live.active = true;
  updateSearchBtnForMode();
  setStatus("loading", "Conectando…");

  connectLive(matchers, el.orgIdInput.value.trim(), sinceIso);
}

// ---------- Scroll: auto-follow / pausa, e histórico infinito hacia atrás ----------

el.terminal.addEventListener("scroll", () => {
  if (state.timeMode !== "live") return;

  const distanceFromBottom = el.terminal.scrollHeight - el.terminal.scrollTop - el.terminal.clientHeight;
  const atBottom = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
  if (atBottom && state.live.paused) {
    setLivePaused(false);
  } else if (!atBottom && !state.live.paused && state.live.active) {
    setLivePaused(true);
  }

  if (el.terminal.scrollTop <= SCROLL_TOP_THRESHOLD_PX) {
    loadOlderEntries();
  }
});

el.jumpToLiveBtn.addEventListener("click", () => setLivePaused(false));

// Manual on/off for auto-follow, independent of scroll position — e.g.
// freeze the view while sitting at the bottom without having to scroll
// away first. Scrolling back to the bottom (see listener above) or
// clicking this again both re-sync state.live.paused the same way.
el.autoScrollToggle.addEventListener("click", () => setLivePaused(!state.live.paused));

function prependOlderEntries(entries) {
  const prevScrollHeight = el.terminal.scrollHeight;
  const prevScrollTop = el.terminal.scrollTop;

  const withLevel = entries.map((e) => ({ ...e, level: detectSeverity(e.line) }));
  state.entries = withLevel.concat(state.entries);

  const frag = document.createDocumentFragment();
  withLevel.forEach((entry) => frag.appendChild(buildLogLineEl(entry)));
  el.logLines.insertBefore(frag, el.logLines.firstChild);

  applyFilters();

  // Keep whatever the user was looking at in the same visual spot instead
  // of letting the newly-inserted content push it down out of view.
  el.terminal.scrollTop = prevScrollTop + (el.terminal.scrollHeight - prevScrollHeight);
}

// Pages further back in history on demand — no new endpoint: reuses
// POST /api/query exactly like Personalizado does, just walked backward
// one page at a time. Loki streams have gaps, so the window searched
// widens (LIVE_OLDER_WINDOWS_MS) until one actually returns something.
async function loadOlderEntries() {
  if (state.timeMode !== "live") return;
  if (state.live.loadingOlder || state.live.reachedBeginning) return;
  if (state.entries.length === 0) return;

  const matchers = collectMatchers();
  if (matchers.length === 0) return;

  const endMs = Number(BigInt(state.entries[0].timestamp) / 1000000n);
  const orgId = el.orgIdInput.value.trim();

  state.live.loadingOlder = true;
  el.olderLoader.hidden = false;

  try {
    let found = [];
    for (const windowMs of LIVE_OLDER_WINDOWS_MS) {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchers,
          limit: LIVE_OLDER_PAGE_SIZE,
          direction: "backward",
          orgId,
          start: new Date(endMs - windowMs).toISOString(),
          end: new Date(endMs).toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      if ((data.entries || []).length > 0) {
        found = data.entries;
        break;
      }
    }

    if (found.length === 0) {
      state.live.reachedBeginning = true;
      el.olderEndHint.hidden = false;
      return;
    }

    prependOlderEntries(found);
  } catch (err) {
    el.searchError.textContent = err.message || "No se pudo cargar histórico anterior.";
    el.searchError.hidden = false;
  } finally {
    state.live.loadingOlder = false;
    el.olderLoader.hidden = true;
  }
}

// ---------- Rendering & filtering ----------

function formatTimestamp(nanoStr) {
  const nanos = BigInt(nanoStr);
  const millis = Number(nanos / 1000000n);
  return formatTimeInZone(new Date(millis), effectiveTimeZone());
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

function buildLogLineEl(entry) {
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
  return row;
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
  state.entries.forEach((entry) => frag.appendChild(buildLogLineEl(entry)));

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
  a.href = url;
  a.download = logFileName();
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
const PANEL_MAX_WIDTH = 720;

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

// Only one export runs at a time: { source, ui }.
let activeExport = null;
let lifecycleStartedAt = null;

// Linear ETA from real, measured progress: elapsed wall-clock time so far
// divided by the (real, server-computed) fraction complete, minus what's
// already elapsed. Not an animation or a guess — it's derived entirely
// from how long this specific export has actually taken so far, so it
// naturally adjusts if Loki speeds up or slows down. Skipped below ~2%
// progress since dividing by a near-zero fraction produces a wildly
// unstable estimate that's more misleading than useful.
function formatDuration(ms) {
  const totalSeconds = Math.max(Math.round(ms / 1000), 0);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function estimateRemaining(percent) {
  if (!lifecycleStartedAt || percent < 2) return "";
  const elapsedMs = Date.now() - lifecycleStartedAt;
  const totalEstimatedMs = elapsedMs / (percent / 100);
  const remainingMs = totalEstimatedMs - elapsedMs;
  return ` · ~${formatDuration(remainingMs)} restantes (estimado)`;
}

// The lifecycle export only ever uses the current matchers/Org ID — it
// ignores the time range, line limit and direction entirely (it always
// fetches everything, from first log to last). Leaving those controls
// looking active while this panel is open would wrongly suggest they
// still affect the export, so they're visually dimmed and made
// non-interactive for as long as the panel stays open.
function setSearchControlsLocked(locked) {
  el.timeRangeControls.classList.toggle("locked", locked);
  el.limitControls.classList.toggle("locked", locked);
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

function resetExportUI(ui) {
  if (ui.startBtn) ui.startBtn.disabled = false;
  ui.progress.hidden = true;
  ui.fill.style.width = "0%";
}

function stopExport() {
  if (activeExport) {
    activeExport.source.close();
    activeExport = null;
  }
  lifecycleStartedAt = null;
}

// Runs /api/export and saves the result, reporting through ui's elements:
// { progress, fill, text, error, startBtn? }, plus initialText/onError.
function startExport(qs, ui) {
  if (activeExport) {
    const previousUI = activeExport.ui;
    stopExport();
    resetExportUI(previousUI);
  }

  // Named now: the form may have changed by the time the export finishes.
  const fileName = logFileName();

  if (ui.startBtn) ui.startBtn.disabled = true;
  ui.progress.hidden = false;
  ui.fill.style.width = "0%";
  ui.text.textContent = ui.initialText;
  lifecycleStartedAt = Date.now();

  const source = new EventSource(`/api/export?${qs.toString()}`);
  activeExport = { source, ui };

  const failWith = (message) => {
    ui.error.textContent = message;
    ui.error.hidden = false;
    stopExport();
    resetExportUI(ui);
  };

  source.addEventListener("started", (evt) => {
    const data = JSON.parse(evt.data);
    ui.text.textContent = `Encontrado: ${data.firstSeen} → ${data.lastSeen}. Descargando…`;
  });

  source.addEventListener("progress", (evt) => {
    const data = JSON.parse(evt.data);
    const pct = data.percent.toFixed(1);
    ui.fill.style.width = `${pct}%`;
    ui.text.textContent =
      `${pct}% — ${data.lines.toLocaleString("es-ES")} líneas descargadas` + estimateRemaining(data.percent);
  });

  source.addEventListener("done", (evt) => {
    const data = JSON.parse(evt.data);
    ui.fill.style.width = "100%";
    ui.text.textContent =
      `Completado: ${data.lines.toLocaleString("es-ES")} líneas` +
      (data.truncated ? " (cortado por el límite de seguridad — el objeto tiene aún más historial)" : "");
    stopExport();
    if (ui.startBtn) ui.startBtn.disabled = false;
    // A normal browser download, not a JS Blob — the file can be huge and
    // this streams straight to disk instead of holding it all in memory.
    window.location.href =
      `/api/export/download?id=${encodeURIComponent(data.downloadId)}&filename=${encodeURIComponent(fileName)}`;
  });

  source.addEventListener("failed", (evt) => {
    let message = "Error durante la exportación.";
    try {
      message = JSON.parse(evt.data).error || message;
    } catch (_) {
      // keep default message
    }
    failWith(message);
  });

  source.onerror = () => {
    // Fires on a genuine connection drop — "done"/"failed" already close
    // the stream themselves before this would have a chance to matter.
    if (activeExport?.source !== source) return;
    failWith("Se perdió la conexión durante la exportación.");
  };
}

el.lifecycleExportStart.addEventListener("click", () => {
  const matchers = collectMatchers();
  el.lifecycleExportError.hidden = true;

  if (matchers.length === 0) {
    el.lifecycleExportError.textContent = "Añade al menos un label con su valor.";
    el.lifecycleExportError.hidden = false;
    return;
  }

  const qs = new URLSearchParams();
  qs.set("matchers", JSON.stringify(matchers));
  const orgId = el.orgIdInput.value.trim();
  if (orgId) qs.set("orgId", orgId);
  qs.set("lookbackDays", el.lifecycleLookback.value);

  startExport(qs, {
    progress: el.lifecycleProgress,
    fill: el.lifecycleProgressFill,
    text: el.lifecycleProgressText,
    error: el.lifecycleExportError,
    startBtn: el.lifecycleExportStart,
    initialText: "Buscando la primera y última aparición…",
  });
});

el.lifecycleExportCancel.addEventListener("click", () => {
  stopExport();
  el.lifecycleProgressText.textContent = "Cancelado.";
  el.lifecycleExportStart.disabled = false;
});

// Saves a search too big for the viewer: the whole time range, oldest
// first, regardless of the line limit and order selected.
function startRangeDownload(payload, total) {
  const qs = new URLSearchParams();
  qs.set("matchers", JSON.stringify(payload.matchers));
  if (payload.orgId) qs.set("orgId", payload.orgId);
  qs.set("start", payload.start);
  qs.set("end", payload.end);

  el.rangeDownloadNotice.textContent =
    `Ojo: esta búsqueda tiene ${total.toLocaleString("es-ES")} líneas, demasiadas para verlas en la web ` +
    `(máx. ${MAX_PREVIEW_LINES.toLocaleString("es-ES")}). No habrá previa: se descarga directamente todo el rango en un .txt.`;

  startExport(qs, {
    progress: el.rangeDownloadProgress,
    fill: el.rangeDownloadFill,
    text: el.rangeDownloadText,
    error: el.searchError,
    initialText: "Preparando la descarga…",
  });
}

el.rangeDownloadCancel.addEventListener("click", () => {
  stopExport();
  resetExportUI({ progress: el.rangeDownloadProgress, fill: el.rangeDownloadFill });
});

// ---------- Init ----------

// Clear immediately, synchronously — before even asking the server for
// its default — so a value the browser restored from a previous page
// load (its own "remember what I typed" behavior, nothing this app
// stores) never has a chance to flash on screen while loadConfig()'s
// fetch is still in flight.
el.orgIdInput.value = "";

createMatcherRow("namespace");
loadConfig().then(loadLabelNames);
initResizablePanel();
