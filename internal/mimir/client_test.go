package mimir

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientTenants(t *testing.T) {
	var capturedPath, capturedAuthUser, capturedOrgID string
	var capturedOK bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.RequestURI()
		capturedAuthUser, _, capturedOK = r.BasicAuth()
		capturedOrgID = r.Header.Get("X-Scope-OrgID")

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status": "success",
			"data": {
				"resultType": "vector",
				"result": [
					{"metric": {"tenant": "tenant-b"}, "value": [1700000000, "42"]},
					{"metric": {"tenant": "tenant-a"}, "value": [1700000000, "17"]}
				]
			}
		}`))
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "mimir-user", "mimir-pass", "0")

	tenants, err := client.Tenants(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !capturedOK || capturedAuthUser != "mimir-user" {
		t.Errorf("expected basic auth user 'mimir-user', got ok=%v user=%q", capturedOK, capturedAuthUser)
	}
	if capturedOrgID != "0" {
		t.Errorf("expected X-Scope-OrgID '0', got %q", capturedOrgID)
	}
	if capturedPath != "/prometheus/api/v1/query?query=count+by+%28tenant%29+%28loki_distributor_bytes_received_total%29" {
		t.Errorf("unexpected request path: %s", capturedPath)
	}

	want := []string{"tenant-a", "tenant-b"}
	if len(tenants) != len(want) {
		t.Fatalf("expected %v, got %v", want, tenants)
	}
	for i := range want {
		if tenants[i] != want[i] {
			t.Errorf("expected sorted tenants %v, got %v", want, tenants)
		}
	}
}

func TestClientTenantsFailsOnErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("unauthorized"))
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "u", "p", "")
	if _, err := client.Tenants(context.Background()); err == nil {
		t.Error("expected error for non-200 response")
	}
}
