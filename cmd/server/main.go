// Command server runs the LokiViews web application: a Go backend that
// queries Loki, cleans the response, and serves an embedded static
// frontend for browsing and downloading logs.
package main

import (
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	lokiviews "github.com/eloygonzalezdeiris/lokiviews"
	"github.com/eloygonzalezdeiris/lokiviews/internal/api"
	"github.com/eloygonzalezdeiris/lokiviews/internal/config"
	"github.com/eloygonzalezdeiris/lokiviews/internal/loki"
	"github.com/eloygonzalezdeiris/lokiviews/internal/mimir"
)

func main() {
	// Invoked as `lokiviews -healthcheck` by the Dockerfile's HEALTHCHECK
	// instruction (exec form, so it never needs a shell) — the runtime
	// image is distroless and has no curl/wget to do this externally.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		runHealthcheck()
		return
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	client := loki.NewClient(cfg.LokiURL, cfg.LokiUser, cfg.LokiPass, cfg.DefaultLokiOrgID)

	var mimirClient *mimir.Client
	if cfg.MimirURL != "" {
		mimirClient = mimir.NewClient(cfg.MimirURL, cfg.MimirUser, cfg.MimirPass, cfg.MimirOrgID)
	}

	webFS, err := fs.Sub(lokiviews.WebFiles, "web")
	if err != nil {
		log.Fatalf("failed to load embedded web assets: %v", err)
	}

	router := api.NewRouter(client, cfg.DefaultLokiOrgID, mimirClient, webFS)

	addr := ":" + cfg.Port
	log.Printf("lokiviews listening on %s (loki=%s, tenant autodiscovery=%v)", addr, cfg.LokiURL, mimirClient != nil)
	log.Fatal(http.ListenAndServe(addr, router))
}

// runHealthcheck hits this same process's own /api/health over loopback
// and exits 0/1 accordingly, so `docker inspect --format='{{.State.Health.Status}}'`
// (and orchestrators reading the same status) reflect whether the server
// is actually accepting requests, not just that the process is alive.
func runHealthcheck() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/health")
	if err != nil {
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
