package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/eloygonzalezdeiris/lokiviews/internal/loki"
)

const (
	// exportMaxLines is a hard safety cap so one export request can't run
	// forever or fill the disk if a selector matches an enormous stream.
	exportMaxLines = 2_000_000
)

var unsafeFilenameChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// Export handles GET /api/export: streams the *entire* history of a log
// stream selector (or just the start/end range, when both are given) as
// Server-Sent Events with real progress, then hands
// back a one-time download id. "Real progress" here means the fraction of
// the object's actual observed lifetime (first log line to last log line)
// that has been paged through so far — not a guessed/animated percentage.
//
// It's a GET (not the POST /api/query uses) because the browser's native
// EventSource API can only make GET requests.
func (h *Handlers) Export(w http.ResponseWriter, r *http.Request) {
	var matchers []loki.LabelMatcher
	if raw := r.URL.Query().Get("matchers"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &matchers); err != nil {
			http.Error(w, "invalid matchers JSON", http.StatusBadRequest)
			return
		}
	}
	orgID := r.URL.Query().Get("orgId")
	lookbackDays, _ := strconv.Atoi(r.URL.Query().Get("lookbackDays"))
	if lookbackDays <= 0 {
		lookbackDays = 30
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

	selector, err := loki.BuildSelector(matchers)
	if err != nil {
		fail(err.Error())
		return
	}

	windowEnd := time.Now().UTC()
	windowStart := windowEnd.Add(-time.Duration(lookbackDays) * 24 * time.Hour)
	noDataMessage := fmt.Sprintf("no se han encontrado logs para este selector en los últimos %d días", lookbackDays)
	if start, end := r.URL.Query().Get("start"), r.URL.Query().Get("end"); start != "" && end != "" {
		if windowStart, err = time.Parse(time.RFC3339Nano, start); err != nil {
			fail("invalid start: " + err.Error())
			return
		}
		if windowEnd, err = time.Parse(time.RFC3339Nano, end); err != nil {
			fail("invalid end: " + err.Error())
			return
		}
		noDataMessage = "no se han encontrado logs para este selector en el rango indicado"
	}

	// Find the object's first and last known log line within the lookback
	// window — our best available proxy for "since it started" to "until
	// it died", since Loki has no concept of container lifecycle itself.
	firstEntries, err := h.loki.QueryRange(ctx, loki.QueryParams{
		Matchers: matchers, OrgID: orgID, Direction: "forward", Limit: 1,
		Start: windowStart.Format(time.RFC3339Nano), End: windowEnd.Format(time.RFC3339Nano),
	})
	if err != nil {
		fail(err.Error())
		return
	}
	if len(firstEntries) == 0 {
		fail(noDataMessage)
		return
	}
	lastEntries, err := h.loki.QueryRange(ctx, loki.QueryParams{
		Matchers: matchers, OrgID: orgID, Direction: "backward", Limit: 1,
		Start: windowStart.Format(time.RFC3339Nano), End: windowEnd.Format(time.RFC3339Nano),
	})
	if err != nil {
		fail(err.Error())
		return
	}

	firstNs, err := strconv.ParseInt(firstEntries[0].Timestamp, 10, 64)
	if err != nil {
		fail("unexpected timestamp format from loki")
		return
	}
	lastNs, err := strconv.ParseInt(lastEntries[0].Timestamp, 10, 64)
	if err != nil {
		fail("unexpected timestamp format from loki")
		return
	}

	totalSpanNs := lastNs - firstNs
	if totalSpanNs <= 0 {
		totalSpanNs = 1 // a single instant — avoid a divide-by-zero below
	}

	tmpFile, err := os.CreateTemp("", "lokiviews-export-*.txt")
	if err != nil {
		fail("no se pudo crear el archivo temporal: " + err.Error())
		return
	}
	defer tmpFile.Close()

	send("started", map[string]interface{}{
		"query":     selector,
		"firstSeen": nsToRFC3339(firstNs),
		"lastSeen":  nsToRFC3339(lastNs),
	})

	totalLines := 0
	truncated := false

	// The window bounds, not firstNs/lastNs, delimit the walk: those two
	// are only used to report progress.
	params := loki.QueryParams{
		Matchers: matchers, OrgID: orgID, Direction: "forward", Limit: loki.MaxPageSize,
		Start: windowStart.Format(time.RFC3339Nano), End: windowEnd.Format(time.RFC3339Nano),
	}
	log.Printf("loki request: %s", h.loki.QueryRangeCurl(params))

	err = h.loki.WalkRange(ctx, params, func(batch []loki.Entry, reachedNs int64) bool {
		for _, e := range batch {
			fmt.Fprintf(tmpFile, "%s  %s\n", nsToRFC3339(mustParseNs(e.Timestamp)), e.Line)
		}
		totalLines += len(batch)

		percent := float64(reachedNs-firstNs) / float64(totalSpanNs) * 100
		if percent < 0 {
			percent = 0
		} else if percent > 100 {
			percent = 100
		}
		send("progress", map[string]interface{}{
			"percent": percent,
			"lines":   totalLines,
		})

		if totalLines >= exportMaxLines {
			truncated = true
			return false
		}
		return true
	})
	if ctx.Err() != nil {
		// Client cancelled / disconnected: nothing more to send.
		return
	}
	if err != nil {
		fail(err.Error())
		return
	}

	id, err := randomExportID()
	if err != nil {
		fail("no se pudo finalizar la exportación: " + err.Error())
		return
	}
	h.exports.put(id, tmpFile.Name())

	send("done", map[string]interface{}{
		"downloadId": id,
		"lines":      totalLines,
		"truncated":  truncated,
	})
}

// ExportDownload handles GET /api/export/download?id=..., streaming back
// the temp file produced by a finished Export call and deleting it
// afterwards — each export can only be downloaded once.
func (h *Handlers) ExportDownload(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing required 'id' query parameter")
		return
	}
	path, ok := h.exports.take(id)
	if !ok {
		writeError(w, http.StatusNotFound, "export not found, already downloaded, or expired")
		return
	}
	defer os.Remove(path)

	f, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to open export file: "+err.Error())
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	name := downloadFilename(r.URL.Query().Get("filename"))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	http.ServeContent(w, r, name, time.Now(), f)
}

// downloadFilename makes a caller-supplied name safe for a response header.
func downloadFilename(name string) string {
	name = unsafeFilenameChars.ReplaceAllString(name, "-")
	if name == "" || name == ".txt" || !strings.HasSuffix(name, ".txt") {
		return "lokiviews-logs.txt"
	}
	return name
}

func nsToRFC3339(ns int64) string {
	return time.Unix(0, ns).UTC().Format(time.RFC3339Nano)
}

func mustParseNs(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func randomExportID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
