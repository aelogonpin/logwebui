// Command server runs the LokiViews web application: a Go backend that
// queries Loki, cleans the response, and serves an embedded static
// frontend for browsing and downloading logs.
package main

import (
	"io/fs"
	"log"
	"net/http"

	lokiviews "github.com/eloygonzalezdeiris/lokiviews"
	"github.com/eloygonzalezdeiris/lokiviews/internal/api"
	"github.com/eloygonzalezdeiris/lokiviews/internal/config"
	"github.com/eloygonzalezdeiris/lokiviews/internal/loki"
	"github.com/eloygonzalezdeiris/lokiviews/internal/mimir"
)

func main() {
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
