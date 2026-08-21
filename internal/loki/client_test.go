package loki

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildSelector(t *testing.T) {
	t.Run("renders quoted matchers and skips blanks", func(t *testing.T) {
		got, err := BuildSelector([]LabelMatcher{
			{Key: "namespace", Value: "clarel-pro", Op: "="},
			{Key: "pod", Value: "api-.*", Op: "=~"},
			{Key: "", Value: "ignored"},
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := `{namespace="clarel-pro", pod=~"api-.*"}`
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
						"stream": map[string]string{"namespace": "clarel-pro"},
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

	client := NewClient(srv.URL, "admin", "secret", "Clarel-pro")

	entries, err := client.QueryRange(context.Background(), QueryParams{
		Matchers: []LabelMatcher{{Key: "namespace", Value: "clarel-pro", Op: "="}},
		Limit:    100,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !capturedOK || capturedAuthUser != "admin" {
		t.Errorf("expected basic auth user 'admin', got ok=%v user=%q", capturedOK, capturedAuthUser)
	}
	if capturedOrgID != "Clarel-pro" {
		t.Errorf("expected X-Scope-OrgID 'Clarel-pro', got %q", capturedOrgID)
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
	if entries[0].Labels["namespace"] != "clarel-pro" {
		t.Errorf("expected stream labels to be attached, got %+v", entries[0].Labels)
	}
}
