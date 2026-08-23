// Package mimir is a minimal client for discovering Loki tenants via a
// Mimir (or any Prometheus-compatible) query API. It doesn't talk to Loki
// at all: it reads Loki's own self-monitoring metrics back out of Mimir,
// where the "tenant" label on loki_distributor_bytes_received_total lists
// every tenant that has recently sent logs.
package mimir

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// tenantsQuery aggregates by the "tenant" label so the response contains
// exactly one series per known tenant, regardless of how many distributor
// replicas contributed to it.
const tenantsQuery = `count by (tenant) (loki_distributor_bytes_received_total)`

// Client talks to a single Mimir instance's Prometheus-compatible query API.
type Client struct {
	baseURL string
	user    string
	pass    string
	orgID   string
	http    *http.Client
}

// NewClient builds a Mimir client. user/pass may be empty to skip Basic
// Auth; orgID may be empty to skip the X-Scope-OrgID header (only needed
// when Mimir itself is multi-tenant).
func NewClient(baseURL, user, pass, orgID string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		user:    user,
		pass:    pass,
		orgID:   orgID,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

// Tenants queries Mimir for the distinct "tenant" label seen on Loki's own
// distributor metrics, returning every known tenant sorted alphabetically.
func (c *Client) Tenants(ctx context.Context) ([]string, error) {
	q := url.Values{}
	q.Set("query", tenantsQuery)

	endpoint := c.baseURL + "/prometheus/api/v1/query?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if c.user != "" || c.pass != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	if c.orgID != "" {
		req.Header.Set("X-Scope-OrgID", c.orgID)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("mimir request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read mimir response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mimir returned status %d: %s", resp.StatusCode, truncate(string(body), 500))
	}

	var parsed queryResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse mimir response: %w", err)
	}
	if parsed.Status != "success" {
		return nil, fmt.Errorf("mimir query was not successful (status=%s)", parsed.Status)
	}

	tenants := make([]string, 0, len(parsed.Data.Result))
	for _, r := range parsed.Data.Result {
		if t := r.Metric["tenant"]; t != "" {
			tenants = append(tenants, t)
		}
	}
	sort.Strings(tenants)
	return tenants, nil
}

type queryResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
		} `json:"result"`
	} `json:"data"`
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
