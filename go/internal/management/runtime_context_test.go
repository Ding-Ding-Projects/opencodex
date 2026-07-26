package management

import (
	"net/http"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestClaudeSettingsUseCanonicalContextWindowComposition(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["p"] = config.ProviderConfig{Models: []string{"m"}}
	cfg.ClaudeCode = &config.ClaudeCodeConfig{Model: "p/m"}
	api := newParityAPI(t, &cfg, func(options *Options) { options.Registry = desktopManagementRegistry{} })
	response := serveManagement(api, http.MethodGet, "/api/claude-code", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"contextWindows"`) || !strings.Contains(response.Body.String(), `"p/m":500000`) || !strings.Contains(response.Body.String(), `"ANTHROPIC_MODEL":"p/m[1m]"`) {
		t.Fatalf("Claude settings=%d %s", response.Code, response.Body.String())
	}
}
