package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/management"
)

func TestManagementAPIComposition(t *testing.T) {
	api, err := NewManagementAPI(management.Options{Version: "9.9.9"})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	api.Register(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/system/runtime", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "9.9.9") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	found := false
	for _, route := range ManagementRoutes() {
		found = found || route == "POST /api/stop"
	}
	if !found {
		t.Fatal("management route manifest omitted /api/stop")
	}
}
