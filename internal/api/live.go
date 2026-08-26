package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/eloygonzalezdeiris/lokiviews/internal/loki"
)

const (
	// livePollInterval is how often the backend re-polls Loki for entries
	// newer than the last one seen. Deliberately not per-request/per-tick
	// but a fixed cheap cadence: each poll only asks for the small window
	// since the last cursor, never the whole history, so a slow interval
	// still means low load on Loki even with several tabs open.
	livePollInterval = 5 * time.Second
	// liveHeartbeatInterval keeps the SSE connection alive through
	// proxies/ingress that close idle connections, and lets the frontend
	// tell "connected, nothing new yet" apart from a real disconnect.
	liveHeartbeatInterval = 15 * time.Second
	// liveTickTimeout bounds a single poll's Loki call so one slow
	// response can't stall the tail loop indefinitely.
	liveTickTimeout = 10 * time.Second
	// livePageSize caps how many lines a single poll can return, as a
	// safety net against an unexpectedly bursty selector.
	livePageSize = 5000
	// liveIngestLag is how far behind real time the cursor is allowed to
	// advance. Log shippers (Promtail, Fluent Bit, Vector...) batch lines
	// before pushing them to Loki, so a line's own timestamp can predate
	// the moment it actually becomes queryable by a few seconds. Without
	// this lag, a poll that finds nothing in [cursor, now) would advance
	// the cursor straight to "now" — and a line that lands moments later
	// with a timestamp inside that already-skipped window is then gone
	// for good, since every future poll starts strictly after the cursor.
	// Capping how far the cursor can reach keeps re-checking that trailing
	// window until it's old enough to be trusted as settled.
	liveIngestLag = 10 * time.Second
)

// LiveTail handles GET /api/live: streams newly-arrived log lines matching
// a selector as Server-Sent Events, polling query_range at a low, fixed
// cadence instead of holding one request open per tick. Each poll only
// asks Loki for the window since the last entry seen, so the load on Loki
// stays small and constant regardless of how long the tail runs.
//
// It's a GET (not the POST /api/query uses) for the same reason
// /api/export is: the browser's EventSource API only makes GET requests.
func (h *Handlers) LiveTail(w http.ResponseWriter, r *http.Request) {
	var matchers []loki.LabelMatcher
	if raw := r.URL.Query().Get("matchers"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &matchers); err != nil {
			http.Error(w, "invalid matchers JSON", http.StatusBadRequest)
			return
		}
	}
	orgID := r.URL.Query().Get("orgId")

	selector, err := loki.BuildSelector(matchers)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cursorNs := time.Now().UnixNano()
	if start := r.URL.Query().Get("start"); start != "" {
		parsed, err := time.Parse(time.RFC3339Nano, start)
		if err != nil {
			http.Error(w, "invalid 'start' parameter: "+err.Error(), http.StatusBadRequest)
			return
		}
		cursorNs = parsed.UnixNano()
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	send := func(event string, payload interface{}) {
		data, _ := json.Marshal(payload)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		flusher.Flush()
	}
	fail := func(msg string) { send("failed", map[string]string{"error": msg}) }

	ctx := r.Context()
	send("connected", map[string]string{"query": selector})

	pollTicker := time.NewTicker(livePollInterval)
	defer pollTicker.Stop()
	heartbeatTicker := time.NewTicker(liveHeartbeatInterval)
	defer heartbeatTicker.Stop()

	var lastWrittenTs, lastWrittenLine string

	for {
		select {
		case <-ctx.Done():
			// Client closed the EventSource (mode switch, tab close, new
			// live search) — nothing more to do.
			return

		case <-heartbeatTicker.C:
			send("heartbeat", nil)

		case <-pollTicker.C:
			endNs := time.Now().UnixNano() - int64(liveIngestLag)
			if endNs <= cursorNs {
				// Real time hasn't caught up past the lag buffer yet since
				// the last tick (e.g. right after connecting) — nothing
				// safe to query this tick.
				continue
			}

			tickCtx, cancel := context.WithTimeout(ctx, liveTickTimeout)
			batch, err := h.loki.QueryRange(tickCtx, loki.QueryParams{
				Matchers: matchers, OrgID: orgID, Direction: "forward", Limit: livePageSize,
				Start: nsToRFC3339(cursorNs), End: nsToRFC3339(endNs),
			})
			cancel()
			if err != nil {
				fail(err.Error())
				return
			}

			newEntries := make([]loki.Entry, 0, len(batch))
			for _, e := range batch {
				// Same edge case export.go guards against: a
				// coarser-than-nanosecond timestamp source can cause the
				// last entry of the previous poll to reappear at the
				// start of this one (the cursor couldn't move past its
				// bucket) — skip re-sending it.
				if e.Timestamp == lastWrittenTs && e.Line == lastWrittenLine {
					continue
				}
				newEntries = append(newEntries, e)
			}

			if len(newEntries) > 0 {
				send("entries", map[string]interface{}{"entries": newEntries})
				last := newEntries[len(newEntries)-1]
				lastWrittenTs, lastWrittenLine = last.Timestamp, last.Line
				cursorNs = mustParseNs(last.Timestamp) + 1
			} else {
				// Confirmed empty up to endNs (already lag-safe, so this
				// isn't a premature guess) — advance the cursor there so
				// the next poll only scans forward from this point, never
				// re-scanning the whole elapsed history since the tail
				// started.
				cursorNs = endNs
			}
		}
	}
}
