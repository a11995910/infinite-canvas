package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
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

func TestMaterializeSub2APIImageResponse(t *testing.T) {
	previousDir := config.Cfg.TransientImageDir
	config.Cfg.TransientImageDir = t.TempDir()
	t.Cleanup(func() { config.Cfg.TransientImageDir = previousDir })

	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	body, _ := json.Marshal(map[string]any{"created": 1, "data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(png)}}})
	transformed, changed, err := materializeSub2APIImageResponse(body)
	if err != nil || !changed {
		t.Fatalf("materializeSub2APIImageResponse() changed=%v err=%v", changed, err)
	}
	var payload struct {
		Data []map[string]string `json:"data"`
	}
	if err := json.Unmarshal(transformed, &payload); err != nil {
		t.Fatalf("decode transformed payload: %v", err)
	}
	if len(payload.Data) != 1 || payload.Data[0]["b64_json"] != "" || payload.Data[0]["url"] == "" {
		t.Fatalf("transformed data = %#v", payload.Data)
	}
	matches, _ := filepath.Glob(filepath.Join(config.Cfg.TransientImageDir, "*"))
	if len(matches) != 1 {
		t.Fatalf("saved files = %d, want 1", len(matches))
	}
	saved, err := os.ReadFile(matches[0])
	if err != nil || string(saved) != string(png) {
		t.Fatalf("saved image mismatch: err=%v", err)
	}
}
