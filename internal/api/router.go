package api

import (
	"io/fs"
	"log"
	"net/http"
	"time"

	"github.com/eloygonzalezdeiris/lokiviews/internal/loki"
	"github.com/eloygonzalezdeiris/lokiviews/internal/mimir"
)

// NewRouter builds the full HTTP handler: the JSON API under /api/* plus
// the embedded frontend served as static files at /. mimirClient may be
// nil, which disables /api/tenants (tenant autodiscovery).
func NewRouter(client *loki.Client, defaultLokiOrgID string, mimirClient *mimir.Client, webFS fs.FS) http.Handler {
	h := NewHandlers(client, defaultLokiOrgID, mimirClient)
	mux := http.NewServeMux()

	mux.HandleFunc("/api/health", Health)
	mux.HandleFunc("/api/config", h.Config)
	mux.HandleFunc("/api/query", h.Query)
	mux.HandleFunc("/api/count", h.Count)
	mux.HandleFunc("/api/labels", h.Labels)
	mux.HandleFunc("/api/label-values", h.LabelValues)
	mux.HandleFunc("/api/export", h.Export)
	mux.HandleFunc("/api/export/download", h.ExportDownload)
	mux.HandleFunc("/api/live", h.LiveTail)
	mux.HandleFunc("/api/tenants", h.Tenants)

	mux.Handle("/", http.FileServer(http.FS(webFS)))

	return withLogging(mux)
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start))
	})
}
