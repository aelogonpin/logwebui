// Package config loads the application configuration exclusively from
// environment variables, following the 12-Factor App methodology.
package config

import (
	"fmt"
	"os"
)

// Config holds every runtime setting the application needs.
type Config struct {
	LokiURL   string
	LokiUser  string
	LokiPass  string
	LokiOrgID string
	Port      string
}

// Load reads and validates the required environment variables. It fails
// fast (returns an error) if any mandatory variable is missing, so
// misconfiguration is caught at startup instead of on the first request.
func Load() (*Config, error) {
	cfg := &Config{
		LokiURL:   os.Getenv("LOKI_URL"),
		LokiUser:  os.Getenv("LOKI_USER"),
		LokiPass:  os.Getenv("LOKI_PASS"),
		LokiOrgID: os.Getenv("LOKI_ORG_ID"),
		Port:      os.Getenv("PORT"),
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
	if cfg.LokiOrgID == "" {
		missing = append(missing, "LOKI_ORG_ID")
	}

	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required environment variables: %v", missing)
	}

	return cfg, nil
}
