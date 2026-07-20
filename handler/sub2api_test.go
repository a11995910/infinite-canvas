package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchSub2APIKeysLoadsAllPages(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("Authorization = %q, want Bearer test-key", got)
		}
		if got := r.UserAgent(); got != "test-browser" {
			t.Fatalf("User-Agent = %q, want test-browser", got)
		}
		if got := r.URL.Query().Get("page_size"); got != "1000" {
			t.Fatalf("page_size = %q, want 1000", got)
		}

		switch r.URL.Query().Get("page") {
		case "1":
			_, _ = w.Write([]byte(`{"code":0,"data":{"items":[{"id":1,"key":"first","name":"第一把","status":"active"}],"pages":2}}`))
		case "2":
			_, _ = w.Write([]byte(`{"code":0,"data":{"items":[{"id":2,"key":"second","name":"第二把","status":"active"}],"pages":2}}`))
		default:
			t.Fatalf("unexpected page %q", r.URL.Query().Get("page"))
		}
	}))
	defer server.Close()

	keys, status, err := fetchSub2APIKeys(context.Background(), server.URL, "test-key", "test-browser")
	if err != nil {
		t.Fatalf("fetchSub2APIKeys() error = %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("status = %d, want %d", status, http.StatusOK)
	}
	if len(keys) != 2 || keys[0].Key != "first" || keys[1].Key != "second" {
		t.Fatalf("keys = %#v, want two pages merged", keys)
	}
}
