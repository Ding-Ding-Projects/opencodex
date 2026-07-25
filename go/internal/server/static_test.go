package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStaticHandlerSPAFallbackAndAssetBoundaries(t *testing.T) {
	handler := StaticHandler()

	root := httptest.NewRecorder()
	handler.ServeHTTP(root, httptest.NewRequest(http.MethodGet, "/dashboard/providers", nil))
	if root.Code != http.StatusOK || root.Header().Get("Cache-Control") != "no-cache" || !strings.Contains(root.Body.String(), "<!doctype html>") {
		t.Fatalf("SPA fallback = %d headers=%v body=%s", root.Code, root.Header(), root.Body.String())
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/missing.js", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing asset = %d %s", missing.Code, missing.Body.String())
	}

	post := httptest.NewRecorder()
	handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/", nil))
	if post.Code != http.StatusMethodNotAllowed || post.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("post = %d headers=%v", post.Code, post.Header())
	}
}
