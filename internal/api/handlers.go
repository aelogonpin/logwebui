package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/eloygonzalezdeiris/lokiviews/internal/loki"
)

const (
	queryTimeout = 25 * time.Second
	metaTimeout  = 15 * time.Second
)

// Handlers wires the Loki client into HTTP endpoints.
type Handlers struct {
	loki             *loki.Client
	defaultLokiOrgID string
}

// NewHandlers builds a Handlers bound to the given Loki client.
// defaultLokiOrgID (from LOKI_ORG_ID, optional) is only exposed via
// /api/config so the frontend can pre-fill the Org ID field; it is never
// enforced server-side.
func NewHandlers(c *loki.Client, defaultLokiOrgID string) *Handlers {
	return &Handlers{loki: c, defaultLokiOrgID: defaultLokiOrgID}
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

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	entries, err := h.loki.QueryRange(ctx, loki.QueryParams{
		Matchers:  req.Matchers,
		Start:     req.Start,
		End:       req.End,
		Limit:     req.Limit,
		Direction: req.Direction,
		OrgID:     req.OrgID,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"count":   len(entries),
		"entries": entries,
	})
}

// Labels handles GET /api/labels, listing known label names for the
// search-form autocomplete.
func (h *Handlers) Labels(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), metaTimeout)
	defer cancel()

	labels, err := h.loki.Labels(ctx, r.URL.Query().Get("orgId"), r.URL.Query().Get("start"), r.URL.Query().Get("end"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"labels": labels})
}

// LabelValues handles GET /api/label-values?name=..., listing known values
// for a given label name.
func (h *Handlers) LabelValues(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "missing required 'name' query parameter")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), metaTimeout)
	defer cancel()

	values, err := h.loki.LabelValues(ctx, r.URL.Query().Get("orgId"), name, r.URL.Query().Get("start"), r.URL.Query().Get("end"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"values": values})
}

// Config handles GET /api/config, exposing non-secret runtime defaults the
// frontend needs — currently just the optional LOKI_ORG_ID fallback used
// to pre-fill the Org ID field.
func (h *Handlers) Config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"defaultOrgId": h.defaultLokiOrgID,
	})
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
