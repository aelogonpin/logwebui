package api

import (
	"io/fs"
	"log"
	"net/http"
	"time"

	"github.com/eloygonzalezdeiris/lokiviews/internal/loki"
)

// NewRouter builds the full HTTP handler: the JSON API under /api/* plus
// the embedded frontend served as static files at /.
func NewRouter(client *loki.Client, webFS fs.FS) http.Handler {
	h := NewHandlers(client)
	mux := http.NewServeMux()

	mux.HandleFunc("/api/health", Health)
	mux.HandleFunc("/api/query", h.Query)
	mux.HandleFunc("/api/labels", h.Labels)
	mux.HandleFunc("/api/label-values", h.LabelValues)

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
