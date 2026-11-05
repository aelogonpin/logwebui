package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/eloygonzalezdeiris/lokiviews/internal/loki"
	"github.com/eloygonzalezdeiris/lokiviews/internal/mimir"
)

const (
	queryTimeout = 25 * time.Second
	metaTimeout  = 15 * time.Second
)

// Handlers wires the Loki client into HTTP endpoints.
type Handlers struct {
	loki             *loki.Client
	defaultLokiOrgID string
	exports          *exportStore
	// mimir is nil unless MIMIR_URL is configured, which disables the
	// tenant-autodiscover feature entirely (see Tenants and Config below).
	mimir *mimir.Client
}

// NewHandlers builds a Handlers bound to the given Loki client.
// defaultLokiOrgID (from LOKI_ORG_ID, optional) is only exposed via
// /api/config so the frontend can pre-fill the Org ID field; it is never
// enforced server-side. mimirClient may be nil to disable tenant
// autodiscovery.
func NewHandlers(c *loki.Client, defaultLokiOrgID string, mimirClient *mimir.Client) *Handlers {
	return &Handlers{loki: c, defaultLokiOrgID: defaultLokiOrgID, exports: newExportStore(), mimir: mimirClient}
}

type queryRequest struct {
	Matchers  []loki.LabelMatcher `json:"matchers"`
	Start     string              `json:"start"`
	End       string              `json:"end"`
	Limit     int                 `json:"limit"`
	Direction string              `json:"direction"`
	OrgID     string              `json:"orgId"`
}

// Query handles POST /api/query: builds a LogQL selector from the posted
// label matchers, queries Loki, and returns clean log entries as JSON.
func (h *Handlers) Query(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed, use POST")
		return
	}

	var req queryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	// Built up front (before calling Loki) so it's available both for the
	// diagnostic response fields and for the log line below, and so a bad
	// matcher set fails fast with a clear 400 instead of a generic 502.
	selector, err := loki.BuildSelector(req.Matchers)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	effectiveOrgID := req.OrgID
	if effectiveOrgID == "" {
		effectiveOrgID = h.defaultLokiOrgID
	}

	// queryTimeout is per Loki call; large limits take several of them.
	// Doubled because a window that fills up is fetched again, split.
	pages := 2 * ((req.Limit-1)/loki.MaxPageSize + 1)
	if pages < 1 {
		pages = 1
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(pages)*queryTimeout)
	defer cancel()

	params := loki.QueryParams{
		Matchers:  req.Matchers,
		Start:     req.Start,
		End:       req.End,
		Limit:     req.Limit,
		Direction: req.Direction,
		OrgID:     req.OrgID,
	}
	log.Printf("loki request: %s", h.loki.QueryRangeCurl(params))

	entries, err := h.loki.QueryRange(ctx, params)
	if err != nil {
		log.Printf("query failed: selector=%s orgId=%s start=%s end=%s: %v", selector, effectiveOrgID, req.Start, req.End, err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	log.Printf("query ok: selector=%s orgId=%s start=%s end=%s -> %d entries", selector, effectiveOrgID, req.Start, req.End, len(entries))

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"count":   len(entries),
		"entries": entries,
		"query":   selector,
		"orgId":   effectiveOrgID,
		"start":   req.Start,
		"end":     req.End,
	})
}

// Count handles POST /api/count: how many lines match the posted matchers
// and range, so the frontend can tell whether a result fits in the viewer
// before fetching it.
func (h *Handlers) Count(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed, use POST")
		return
	}

	var req queryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	params := loki.QueryParams{
		Matchers: req.Matchers,
		Start:    req.Start,
		End:      req.End,
		OrgID:    req.OrgID,
	}
	log.Printf("loki request: %s", h.loki.CountLinesCurl(params))

	count, err := h.loki.CountLines(ctx, params)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"count": count})
}

// Labels handles GET /api/labels, listing known label names for the
// search-form autocomplete. An optional ?query=<selector> scopes the
// result to labels that co-occur with matchers already picked elsewhere
// in the form (e.g. only labels seen on namespace="monitoring" streams).
func (h *Handlers) Labels(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), metaTimeout)
	defer cancel()

	labels, err := h.loki.Labels(ctx, r.URL.Query().Get("orgId"), r.URL.Query().Get("query"), r.URL.Query().Get("start"), r.URL.Query().Get("end"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"labels": labels})
}

// LabelValues handles GET /api/label-values?name=..., listing known values
// for a given label name. An optional ?query=<selector> scopes the result
// the same way Labels does (see above).
func (h *Handlers) LabelValues(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "missing required 'name' query parameter")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), metaTimeout)
	defer cancel()

	values, err := h.loki.LabelValues(ctx, r.URL.Query().Get("orgId"), name, r.URL.Query().Get("query"), r.URL.Query().Get("start"), r.URL.Query().Get("end"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"values": values})
}

// Config handles GET /api/config, exposing non-secret runtime defaults the
// frontend needs: the optional LOKI_ORG_ID fallback used to pre-fill the
// Org ID field, and whether tenant autodiscovery (MIMIR_URL) is available.
func (h *Handlers) Config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"defaultOrgId": h.defaultLokiOrgID,
		"mimirEnabled": h.mimir != nil,
	})
}

// Tenants handles GET /api/tenants: lists Loki Org IDs that have recently
// sent logs, by reading the "tenant" label off Loki's own self-monitoring
// metrics back from Mimir. 404s when MIMIR_URL isn't configured.
func (h *Handlers) Tenants(w http.ResponseWriter, r *http.Request) {
	if h.mimir == nil {
		writeError(w, http.StatusNotFound, "tenant autodiscovery is not configured (set MIMIR_URL to enable it)")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), metaTimeout)
	defer cancel()

	tenants, err := h.mimir.Tenants(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"tenants": tenants})
}

// Health handles GET /api/health for container/orchestrator liveness checks.
func Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
