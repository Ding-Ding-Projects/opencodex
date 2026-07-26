package cli

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestClaudeSystemEnvRefreshesGatewayCacheFromLiveProxy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.URL.Query().Get("ids") != "cli" || r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Fatalf("gateway request=%s headers=%v", r.URL.String(), r.Header)
		}
		_, _ = io.WriteString(w, `{"data":[{"id":"claude-ocx-p--m","display_name":"m (p)"}]}`)
	}))
	defer upstream.Close()
	_, rawPort, _ := net.SplitHostPort(upstream.Listener.Addr().String())
	port, _ := strconv.Atoi(rawPort)
	enabled := true
	cfg := config.Default()
	cfg.Port = port
	cfg.ClaudeCode = &config.ClaudeCodeConfig{Enabled: &enabled, SystemEnv: true}
	configHome, claudeHome := t.TempDir(), t.TempDir()
	runtime := &cliClaudeRuntime{config: &cfg, configHome: configHome, claudeHome: claudeHome, client: upstream.Client()}
	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(claudeHome, "cache", "gateway-models.json"))
	if err != nil || !bytes.Contains(data, []byte("claude-ocx-p--m")) {
		t.Fatalf("gateway cache=%s err=%v", data, err)
	}
}
