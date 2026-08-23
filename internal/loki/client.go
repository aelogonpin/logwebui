// Package loki is a minimal, dependency-free client for Loki's HTTP query
// API. It deliberately never builds a LogQL pipeline (no "| line_format",
// no template functions): the upstream Nginx WAF blocks any request body
// or query string containing "{{" as a Server-Side Template Injection
// guard, and Loki's line_format syntax uses exactly that token. Instead,
// this client sends a bare stream selector to Loki, receives the raw
// JSON, and extracts/cleans the log message in Go before it ever reaches
// the frontend.
package loki

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const defaultLimit = 1000

// Client talks to a single Loki instance.
type Client struct {
	baseURL      string
	user         string
	pass         string
	defaultOrgID string
	http         *http.Client
}

// NewClient builds a Loki client. user/pass may be empty to skip Basic Auth.
// defaultOrgID is only a fallback used when a call doesn't specify its own
// orgID (the web UI normally sends one with every request, since Loki
// tenants can vary per query).
func NewClient(baseURL, user, pass, defaultOrgID string) *Client {
	return &Client{
		baseURL:      strings.TrimRight(baseURL, "/"),
		user:         user,
		pass:         pass,
		defaultOrgID: defaultOrgID,
		http:         &http.Client{Timeout: 30 * time.Second},
	}
}

// QueryParams are the caller-supplied inputs for a query_range call.
type QueryParams struct {
	Matchers  []LabelMatcher
	Start     string // RFC3339, optional
	End       string // RFC3339, optional
	Limit     int
	Direction string // "forward" | "backward"
	OrgID     string // X-Scope-OrgID; falls back to the client default if empty
}

// BuildSelector renders a plain LogQL stream selector such as
// `{namespace="backend", pod=~"api-.*"}`. It never appends pipeline
// stages, so the request body/URL can never contain "{{".
func BuildSelector(matchers []LabelMatcher) (string, error) {
	parts := make([]string, 0, len(matchers))
	for _, m := range matchers {
		key := strings.TrimSpace(m.Key)
		value := strings.TrimSpace(m.Value)
		if key == "" || value == "" {
			continue
		}
		op := m.Op
		switch op {
		case "=", "!=", "=~", "!~":
		default:
			op = "="
		}
		parts = append(parts, fmt.Sprintf("%s%s%s", key, op, strconv.Quote(value)))
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("at least one label matcher with a key and value is required")
	}
	return "{" + strings.Join(parts, ", ") + "}", nil
}

// QueryRange queries Loki and returns clean, ready-to-render log entries
// sorted chronologically (oldest first).
func (c *Client) QueryRange(ctx context.Context, p QueryParams) ([]Entry, error) {
	selector, err := BuildSelector(p.Matchers)
	if err != nil {
		return nil, err
	}

	// No artificial upper cap here: whatever the caller asks for is sent
	// as-is, and Loki's own configured max_entries_limit_per_query decides
	// what's actually allowed (surfaced to the user as a normal error if
	// exceeded) rather than us guessing a ceiling that may not match
	// their Loki's real configuration.
	limit := p.Limit
	if limit <= 0 {
		limit = defaultLimit
	}

	direction := p.Direction
	if direction != "forward" {
		direction = "backward"
	}

	q := url.Values{}
	q.Set("query", selector)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("direction", direction)
	if p.Start != "" {
		q.Set("start", p.Start)
	}
	if p.End != "" {
		q.Set("end", p.End)
	}

	var parsed queryRangeResponse
	if err := c.get(ctx, "/loki/api/v1/query_range", q, c.resolveOrgID(p.OrgID), &parsed); err != nil {
		return nil, err
	}

	entries := make([]Entry, 0)
	for _, stream := range parsed.Data.Result {
		for _, v := range stream.Values {
			if len(v) != 2 {
				continue
			}
			entries = append(entries, Entry{
				Timestamp: v[0],
				Line:      extractMessage(v[1]),
				Labels:    stream.Stream,
			})
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp < entries[j].Timestamp
	})

	return entries, nil
}

// Labels returns every label name known to Loki within the given window,
// used by the frontend to power the search-field autocomplete. When query
// is non-empty (a LogQL stream selector, e.g. `{namespace="monitoring"}`),
// Loki scopes the result to label names that actually co-occur with that
// selector, instead of every label name in the whole tenant.
func (c *Client) Labels(ctx context.Context, orgID, query, start, end string) ([]string, error) {
	q := url.Values{}
	if start != "" {
		q.Set("start", start)
	}
	if end != "" {
		q.Set("end", end)
	}
	if query != "" {
		q.Set("query", query)
	}
	var parsed labelsResponse
	if err := c.get(ctx, "/loki/api/v1/labels", q, c.resolveOrgID(orgID), &parsed); err != nil {
		return nil, err
	}
	return parsed.Data, nil
}

// LabelValues returns every known value for a given label name, optionally
// scoped to a LogQL stream selector the same way Labels is (see above).
func (c *Client) LabelValues(ctx context.Context, orgID, name, query, start, end string) ([]string, error) {
	q := url.Values{}
	if start != "" {
		q.Set("start", start)
	}
	if end != "" {
		q.Set("end", end)
	}
	if query != "" {
		q.Set("query", query)
	}
	path := "/loki/api/v1/label/" + url.PathEscape(name) + "/values"
	var parsed labelsResponse
	if err := c.get(ctx, path, q, c.resolveOrgID(orgID), &parsed); err != nil {
		return nil, err
	}
	return parsed.Data, nil
}

// resolveOrgID prefers a per-request org ID (as entered in the web UI) and
// only falls back to the LOKI_ORG_ID startup default when none was given.
func (c *Client) resolveOrgID(requestOrgID string) string {
	if requestOrgID != "" {
		return requestOrgID
	}
	return c.defaultOrgID
}

func (c *Client) get(ctx context.Context, path string, q url.Values, orgID string, out interface{}) error {
	endpoint := c.baseURL + path
	if encoded := q.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	c.applyHeaders(req, orgID)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("loki request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read loki response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("loki returned status %d: %s", resp.StatusCode, truncate(string(body), 500))
	}

	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("failed to parse loki response: %w", err)
	}
	return nil
}

func (c *Client) applyHeaders(req *http.Request, orgID string) {
	if c.user != "" || c.pass != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	if orgID != "" {
		req.Header.Set("X-Scope-OrgID", orgID)
	}
	req.Header.Set("Accept", "application/json")
}

// extractMessage cleans a single Loki log line. Many pipelines emit
// structured JSON logs (e.g. {"message":"...","level":"error"}); when that
// is the case we pull the human-readable message out so the frontend never
// has to render raw JSON. Plain-text lines are returned unchanged.
func extractMessage(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed[0] != '{' {
		return raw
	}
	var obj map[string]interface{}
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return raw
	}
	for _, key := range []string{"message", "msg", "log"} {
		if v, ok := obj[key]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return raw
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
