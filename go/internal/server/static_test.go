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
	if root.Code != http.StatusOK || root.Header().Get("Cache-Control") != "" || root.Header().Get("Content-Type") != "text/html" || !strings.Contains(root.Body.String(), "proxy dashboard") || strings.Contains(root.Body.String(), "GUI assets are not bundled") {
		t.Fatalf("SPA fallback = %d headers=%v body=%s", root.Code, root.Header(), root.Body.String())
	}

	index := httptest.NewRecorder()
	handler.ServeHTTP(index, httptest.NewRequest(http.MethodGet, "/", nil))
	if index.Code != http.StatusOK || !strings.Contains(index.Body.String(), "/assets/index-") {
		t.Fatalf("embedded production index = %d %s", index.Code, index.Body.String())
	}

	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/provider-icons/openai.svg", nil))
	if asset.Code != http.StatusOK || asset.Header().Get("Content-Type") != "image/svg+xml" || asset.Body.Len() == 0 {
		t.Fatalf("embedded asset = %d headers=%v bytes=%d", asset.Code, asset.Header(), asset.Body.Len())
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

	traversal := httptest.NewRecorder()
	handler.ServeHTTP(traversal, httptest.NewRequest(http.MethodGet, "/%2e%2e/secret", nil))
	if traversal.Code != http.StatusNotFound {
		t.Fatalf("traversal = %d %s", traversal.Code, traversal.Body.String())
	}
}
