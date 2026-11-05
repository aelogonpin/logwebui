package loki

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestBuildSelector(t *testing.T) {
	t.Run("renders quoted matchers and skips blanks", func(t *testing.T) {
		got, err := BuildSelector([]LabelMatcher{
			{Key: "namespace", Value: "backend", Op: "="},
			{Key: "pod", Value: "api-.*", Op: "=~"},
			{Key: "", Value: "ignored"},
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := `{namespace="backend", pod=~"api-.*"}`
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
		if strings.Contains(got, "{{") {
			t.Errorf("selector must never contain '{{' (WAF blocks it): %q", got)
		}
	})

	t.Run("defaults unknown operators to =", func(t *testing.T) {
		got, err := BuildSelector([]LabelMatcher{{Key: "service", Value: "x", Op: "bogus"}})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != `{service="x"}` {
			t.Errorf("got %q", got)
		}
	})

	t.Run("errors when no usable matchers", func(t *testing.T) {
		if _, err := BuildSelector(nil); err == nil {
			t.Error("expected error for empty matchers")
		}
		if _, err := BuildSelector([]LabelMatcher{{Key: "", Value: ""}}); err == nil {
			t.Error("expected error for blank matcher")
		}
	})
}

func TestExtractMessage(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain text passthrough", "plain log line", "plain log line"},
		{"json with message field", `{"message":"boom","level":"error"}`, "boom"},
		{"json with msg field", `{"msg":"boom2"}`, "boom2"},
		{"json without recognized field returns raw", `{"foo":"bar"}`, `{"foo":"bar"}`},
		{"invalid json returns raw", `{not json`, `{not json`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractMessage(tc.in); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClientQueryRange(t *testing.T) {
	var capturedPath, capturedAuthUser, capturedOrgID string
	var capturedOK bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.RequestURI()
		capturedAuthUser, _, capturedOK = r.BasicAuth()
		capturedOrgID = r.Header.Get("X-Scope-OrgID")

		if strings.Contains(capturedPath, "{{") {
			t.Errorf("request path must never contain '{{': %s", capturedPath)
		}

		resp := map[string]interface{}{
			"status": "success",
			"data": map[string]interface{}{
				"resultType": "streams",
				"result": []map[string]interface{}{
					{
						"stream": map[string]string{"namespace": "backend"},
						"values": [][2]string{
							{"2000", `{"message":"second"}`},
							{"1000", "first plain line"},
						},
					},
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "admin", "secret", "acme-prod")

	entries, err := client.QueryRange(context.Background(), QueryParams{
		Matchers: []LabelMatcher{{Key: "namespace", Value: "backend", Op: "="}},
		Limit:    100,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !capturedOK || capturedAuthUser != "admin" {
		t.Errorf("expected basic auth user 'admin', got ok=%v user=%q", capturedOK, capturedAuthUser)
	}
	if capturedOrgID != "acme-prod" {
		t.Errorf("expected X-Scope-OrgID 'acme-prod', got %q", capturedOrgID)
	}
	if !strings.HasPrefix(capturedPath, "/loki/api/v1/query_range?") {
		t.Errorf("unexpected request path: %s", capturedPath)
	}

	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Timestamp != "1000" || entries[0].Line != "first plain line" {
		t.Errorf("expected chronological order, got %+v", entries[0])
	}
	if entries[1].Timestamp != "2000" || entries[1].Line != "second" {
		t.Errorf("expected extracted message 'second', got %+v", entries[1])
	}
	if entries[0].Labels["namespace"] != "backend" {
		t.Errorf("expected stream labels to be attached, got %+v", entries[0].Labels)
	}
}

func TestClientQueryRangePerRequestOrgIDOverridesDefault(t *testing.T) {
	var capturedOrgID string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedOrgID = r.Header.Get("X-Scope-OrgID")
		resp := map[string]interface{}{
			"status": "success",
			"data":   map[string]interface{}{"resultType": "streams", "result": []map[string]interface{}{}},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	// Client has a default org from LOKI_ORG_ID, but the web UI can send a
	// different one per request — that must win.
	client := NewClient(srv.URL, "admin", "secret", "default-org")

	_, err := client.QueryRange(context.Background(), QueryParams{
		Matchers: []LabelMatcher{{Key: "namespace", Value: "x", Op: "="}},
		OrgID:    "ui-provided-org",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedOrgID != "ui-provided-org" {
		t.Errorf("expected per-request orgID to override client default, got %q", capturedOrgID)
	}
}

// fakePagedLoki serves lines (nanosecond timestamps, ascending) honouring
// start (inclusive), end (exclusive), limit and direction, and rejects any
// limit above pageCap the way a real Loki does.
func fakePagedLoki(t *testing.T, timestamps []int64, pageCap int, calls *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		if limit > pageCap {
			http.Error(w, "max entries limit per query exceeded", http.StatusBadRequest)
			return
		}
		start, end := int64(0), int64(1)<<62
		if v := q.Get("start"); v != "" {
			start, _ = strconv.ParseInt(v, 10, 64)
		}
		if v := q.Get("end"); v != "" {
			end, _ = strconv.ParseInt(v, 10, 64)
		}

		var values [][]string
		add := func(i int) {
			values = append(values, []string{strconv.FormatInt(timestamps[i], 10), fmt.Sprintf("line-%d", i)})
		}
		inRange := func(i int) bool { return timestamps[i] >= start && timestamps[i] < end }
		if q.Get("direction") == "forward" {
			for i := 0; i < len(timestamps) && len(values) < limit; i++ {
				if inRange(i) {
					add(i)
				}
			}
		} else {
			for i := len(timestamps) - 1; i >= 0 && len(values) < limit; i-- {
				if inRange(i) {
					add(i)
				}
			}
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "success",
			"data": map[string]interface{}{
				"result": []map[string]interface{}{
					{"stream": map[string]string{"app": "x"}, "values": values},
				},
			},
		})
	}))
}

func TestClientQueryRangePaginatesPastPerQueryCap(t *testing.T) {
	// Plain increasing timestamps, plus bursts sharing one timestamp.
	const base = int64(1_700_000_000_000_000_000)
	timestamps := make([]int64, 12000)
	for i := range timestamps {
		timestamps[i] = base + int64(i)
		if i >= 4990 && i < 5010 {
			timestamps[i] = base + 4990
		}
		if i >= 6990 && i < 7010 {
			timestamps[i] = base + 6990
		}
	}

	matchers := []LabelMatcher{{Key: "app", Op: "=", Value: "x"}}
	tests := []struct {
		name        string
		direction   string
		limit       int
		first, last string
		wantCount   int
	}{
		{"forward, all", "forward", 20000, "line-0", "line-11999", 12000},
		{"backward, all", "backward", 20000, "line-0", "line-11999", 12000},
		{"forward, trimmed", "forward", 6000, "line-0", "line-5999", 6000},
		{"backward, trimmed", "backward", 6000, "line-6000", "line-11999", 6000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			srv := fakePagedLoki(t, timestamps, MaxPageSize, &calls)
			defer srv.Close()

			entries, err := NewClient(srv.URL, "", "", "").QueryRange(context.Background(), QueryParams{
				Matchers: matchers, Limit: tt.limit, Direction: tt.direction,
				Start: strconv.FormatInt(base, 10), End: strconv.FormatInt(base+int64(len(timestamps)), 10),
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(entries) != tt.wantCount {
				t.Fatalf("expected %d entries, got %d", tt.wantCount, len(entries))
			}
			lines := map[string]int{}
			for _, e := range entries {
				lines[e.Line]++
			}
			if len(lines) != tt.wantCount {
				t.Errorf("expected %d distinct lines, got %d", tt.wantCount, len(lines))
			}
			if lines[tt.first] != 1 || lines[tt.last] != 1 {
				t.Errorf("expected %s and %s to be present once", tt.first, tt.last)
			}
			if calls < 2 {
				t.Errorf("expected several Loki calls, got %d", calls)
			}
		})
	}
}

func TestClientQueryRangeSurvivesLokiSkippingLinesWhenTruncating(t *testing.T) {
	// Real Loki, when it truncates at the limit, doesn't return strictly
	// the first N lines. Mimic it by leaving some out of every full page.
	const base = int64(1_700_000_000_000_000_000)
	const total = 12000
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		start, _ := strconv.ParseInt(q.Get("start"), 10, 64)
		end, _ := strconv.ParseInt(q.Get("end"), 10, 64)

		var inRange [][]string
		for i := int64(0); i < total; i++ {
			if ts := base + i; ts >= start && ts < end {
				inRange = append(inRange, []string{strconv.FormatInt(ts, 10), fmt.Sprintf("line-%d", i)})
			}
		}
		values := inRange
		if len(inRange) > limit {
			values = nil
			for i, v := range inRange {
				if len(values) < limit && i%100 != 99 {
					values = append(values, v)
				}
			}
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "success",
			"data": map[string]interface{}{
				"result": []map[string]interface{}{
					{"stream": map[string]string{"app": "x"}, "values": values},
				},
			},
		})
	}))
	defer srv.Close()

	entries, err := NewClient(srv.URL, "", "", "").QueryRange(context.Background(), QueryParams{
		Matchers: []LabelMatcher{{Key: "app", Op: "=", Value: "x"}},
		Limit:    20000, Direction: "forward",
		Start: strconv.FormatInt(base, 10), End: strconv.FormatInt(base+total, 10),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != total {
		t.Errorf("expected %d entries, got %d", total, len(entries))
	}
}

func TestClientCountLines(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1793833200,"508606"]}]}}`))
	}))
	defer srv.Close()

	count, err := NewClient(srv.URL, "", "", "").CountLines(context.Background(), QueryParams{
		Matchers: []LabelMatcher{{Key: "app", Op: "=", Value: "x"}},
		Start:    "2026-11-02T00:00:00Z", End: "2026-11-02T01:00:00Z",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 508606 {
		t.Errorf("expected 508606, got %d", count)
	}
	if want := `sum(count_over_time({app="x"}[3600s]))`; gotQuery != want {
		t.Errorf("expected query %s, got %s", want, gotQuery)
	}
}

func TestClientCountLinesNoData(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	defer srv.Close()

	count, err := NewClient(srv.URL, "", "", "").CountLines(context.Background(), QueryParams{
		Matchers: []LabelMatcher{{Key: "app", Op: "=", Value: "x"}},
	})
	if err != nil || count != 0 {
		t.Errorf("expected 0 and no error, got %d, %v", count, err)
	}
}

func TestClientQueryRangeSmallLimitIsOneCall(t *testing.T) {
	calls := 0
	srv := fakePagedLoki(t, []int64{1000, 1001}, MaxPageSize, &calls)
	defer srv.Close()

	_, err := NewClient(srv.URL, "", "", "").QueryRange(context.Background(), QueryParams{
		Matchers: []LabelMatcher{{Key: "app", Op: "=", Value: "x"}}, Limit: MaxPageSize,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 1 {
		t.Errorf("expected exactly 1 call, got %d", calls)
	}
}
