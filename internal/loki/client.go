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

const (
	defaultLimit = 1000
	maxLimit     = 5000
)

// Client talks to a single Loki instance.
type Client struct {
	baseURL string
	user    string
	pass    string
	orgID   string
	http    *http.Client
}

// NewClient builds a Loki client. user/pass may be empty to skip Basic Auth.
func NewClient(baseURL, user, pass, orgID string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		user:    user,
		pass:    pass,
		orgID:   orgID,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// QueryParams are the caller-supplied inputs for a query_range call.
type QueryParams struct {
	Matchers  []LabelMatcher
	Start     string // RFC3339, optional
	End       string // RFC3339, optional
	Limit     int
	Direction string // "forward" | "backward"
}

// BuildSelector renders a plain LogQL stream selector such as
// `{namespace="clarel-pro", pod=~"api-.*"}`. It never appends pipeline
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

	limit := p.Limit
	if limit <= 0 || limit > maxLimit {
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
	if err := c.get(ctx, "/loki/api/v1/query_range", q, &parsed); err != nil {
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
// used by the frontend to power the search-field autocomplete.
func (c *Client) Labels(ctx context.Context, start, end string) ([]string, error) {
	q := url.Values{}
	if start != "" {
		q.Set("start", start)
	}
	if end != "" {
		q.Set("end", end)
	}
	var parsed labelsResponse
	if err := c.get(ctx, "/loki/api/v1/labels", q, &parsed); err != nil {
		return nil, err
	}
	return parsed.Data, nil
}

// LabelValues returns every known value for a given label name.
func (c *Client) LabelValues(ctx context.Context, name, start, end string) ([]string, error) {
	q := url.Values{}
	if start != "" {
		q.Set("start", start)
	}
	if end != "" {
		q.Set("end", end)
	}
	path := "/loki/api/v1/label/" + url.PathEscape(name) + "/values"
	var parsed labelsResponse
	if err := c.get(ctx, path, q, &parsed); err != nil {
		return nil, err
	}
	return parsed.Data, nil
}

func (c *Client) get(ctx context.Context, path string, q url.Values, out interface{}) error {
	endpoint := c.baseURL + path
	if encoded := q.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	c.applyHeaders(req)

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

func (c *Client) applyHeaders(req *http.Request) {
	if c.user != "" || c.pass != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	if c.orgID != "" {
		req.Header.Set("X-Scope-OrgID", c.orgID)
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
