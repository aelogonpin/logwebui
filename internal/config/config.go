// Package config loads the application configuration exclusively from
// environment variables, following the 12-Factor App methodology.
package config

import (
	"fmt"
	"os"
)

// Config holds every runtime setting the application needs.
type Config struct {
	LokiURL  string
	LokiUser string
	LokiPass string
	Port     string

	// DefaultLokiOrgID is optional. X-Scope-OrgID is entered per-query in
	// the web UI (Loki tenants can vary per request); this only pre-fills
	// that field when set, it is never enforced as a fixed value.
	DefaultLokiOrgID string

	// MimirURL enables the "discover tenants" feature when set: the app
	// queries Mimir for the tenant label on Loki's own self-monitoring
	// metrics to list which Org IDs actually have data. Entirely optional
	// and independent from LOKI_*; when empty the feature is hidden.
	MimirURL  string
	MimirUser string
	MimirPass string
	// MimirOrgID is the X-Scope-OrgID Mimir itself expects (only needed if
	// Mimir is multi-tenant), separate from any Loki org ID.
	MimirOrgID string
}

// Load reads and validates the required environment variables. It fails
// fast (returns an error) if any mandatory variable is missing, so
// misconfiguration is caught at startup instead of on the first request.
func Load() (*Config, error) {
	cfg := &Config{
		LokiURL:          os.Getenv("LOKI_URL"),
		LokiUser:         os.Getenv("LOKI_USER"),
		LokiPass:         os.Getenv("LOKI_PASS"),
		DefaultLokiOrgID: os.Getenv("LOKI_ORG_ID"),
		Port:             os.Getenv("PORT"),
		MimirURL:         os.Getenv("MIMIR_URL"),
		MimirUser:        os.Getenv("MIMIR_USER"),
		MimirPass:        os.Getenv("MIMIR_PASS"),
		MimirOrgID:       os.Getenv("MIMIR_ORG_ID"),
	}

	if cfg.Port == "" {
		cfg.Port = "8080"
	}

	var missing []string
	if cfg.LokiURL == "" {
		missing = append(missing, "LOKI_URL")
	}
	if cfg.LokiUser == "" {
		missing = append(missing, "LOKI_USER")
	}
	if cfg.LokiPass == "" {
		missing = append(missing, "LOKI_PASS")
	}

	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required environment variables: %v", missing)
	}

	return cfg, nil
}
