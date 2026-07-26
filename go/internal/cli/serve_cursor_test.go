package cli

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestAdapterResolverUsesNativeCursorAdapter(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["cursor"] = config.ProviderConfig{
		Adapter: "cursor", BaseURL: "https://api2.cursor.sh", AuthMode: "oauth",
	}
	resolve := adapterResolver(registry.New(), cfg)
	adapter, err := resolve(
		&types.ResolvedModel{Provider: "cursor"},
		&types.Transport{BaseURL: "https://api2.cursor.sh"},
		&types.AuthContext{AccessToken: "cursor-token"},
		http.Header{"X-Test": {"value"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := adapter.(*cursoradapter.Adapter); !ok {
		t.Fatalf("cursor resolver returned %T", adapter)
	}
}

func TestCursorNativeExecutorMapsFailClosedAndExplicitPolicies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "input.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	off, err := newCursorNativeExecutor(config.ProviderConfig{NativeLocalExec: "off"})
	if err != nil {
		t.Fatal(err)
	}
	denied := off.Execute(context.Background(), cursoradapter.ExecRequest{Kind: cursoradapter.ExecRead, Read: &cursoradapter.ReadRequest{Path: path}})
	if len(denied) != 1 || !strings.Contains(denied[0].Error, "nativeLocalExec must be explicitly set to on") {
		t.Fatalf("off policy response = %#v", denied)
	}
	on, err := newCursorNativeExecutor(config.ProviderConfig{NativeLocalExec: "on"})
	if err != nil {
		t.Fatal(err)
	}
	allowed := on.Execute(context.Background(), cursoradapter.ExecRequest{Kind: cursoradapter.ExecRead, Read: &cursoradapter.ReadRequest{Path: path}})
	if len(allowed) != 1 || allowed[0].Error != "" {
		t.Fatalf("on policy response = %#v", allowed)
	}
}

func TestCursorNativeExecutorConfiguresMCPAndDesktopDispatchers(t *testing.T) {
	executor, err := newCursorNativeExecutor(config.ProviderConfig{
		NativeLocalExec: "off",
		MCPServers:      map[string]config.CursorMCPServerConfig{"local": {Command: "mcp-server"}},
		DesktopExecutor: &config.CursorDesktopExecutorConfig{ComputerUseCommand: "desktop-tool", TimeoutMS: 1234},
	})
	if err != nil {
		t.Fatal(err)
	}
	if executor.Tools == nil || executor.Tools.MCP == nil || executor.Tools.Desktop == nil {
		t.Fatalf("dispatcher not fully configured: %#v", executor.Tools)
	}
	if executor.Tools.Desktop.Config.ComputerUseCommand != "desktop-tool" || executor.Tools.Desktop.Config.Timeout.Milliseconds() != 1234 {
		t.Fatalf("desktop config = %#v", executor.Tools.Desktop.Config)
	}
}

func TestAdapterResolverRejectsCursorWithoutCredential(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["cursor"] = config.ProviderConfig{Adapter: "cursor", BaseURL: "https://api2.cursor.sh"}
	resolve := adapterResolver(registry.New(), cfg)
	if _, err := resolve(
		&types.ResolvedModel{Provider: "cursor"},
		&types.Transport{BaseURL: "https://api2.cursor.sh"},
		nil,
		nil,
	); err == nil {
		t.Fatal("cursor adapter accepted an empty credential")
	}
}
