package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/server"
)

func testString(value string) *string { return &value }

func testOrcaDiagnostic() codex.OrcaCodexHomeDiagnostic {
	return codex.OrcaCodexHomeDiagnostic{
		Applicable: true, Mismatch: true,
		EffectiveCodexHome: `C:\Users\[USER]\AppData\Local\Orca\codex-runtime-home\home`,
		AppCodexHome:       `C:\Users\[USER]\.codex`, Warning: testString("home mismatch"), Action: testString("run recovery"),
	}
}

func TestReportCodexHomeTarget(t *testing.T) {
	var out, errOut bytes.Buffer
	reportCodexHomeTarget(IO{Out: &out, Err: &errOut}, testOrcaDiagnostic)
	if !strings.Contains(out.String(), "Target Codex home: C:\\Users\\[USER]") || !strings.Contains(errOut.String(), "WARNING: home mismatch") || !strings.Contains(errOut.String(), "Action: run recovery") {
		t.Fatalf("out=%q err=%q", out.String(), errOut.String())
	}
}

func prepareSyncProductionFixture(t *testing.T, configTOML string) (string, *atomic.Int32, func()) {
	t.Helper()
	ocxHome, codexHome := filepath.Join(t.TempDir(), "ocx"), filepath.Join(t.TempDir(), "codex")
	t.Setenv("OPENCODEX_HOME", ocxHome)
	t.Setenv("CODEX_HOME", codexHome)
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(configTOML), 0o600); err != nil {
		t.Fatal(err)
	}
	var modelHits atomic.Int32
	mux := http.NewServeMux()
	mux.Handle("/healthz", server.NewLiveness("test"))
	mux.HandleFunc("/api/models", func(w http.ResponseWriter, _ *http.Request) {
		modelHits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"models": []map[string]any{{"id": "gpt-5.5", "provider": "openai", "displayName": "GPT-5.5"}}})
	})
	upstream := httptest.NewServer(mux)
	port := upstream.Listener.Addr().(*net.TCPAddr).Port
	cfg := config.Default()
	cfg.Host, cfg.Port = "127.0.0.1", port
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		upstream.Close()
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ocxHome, "runtime-port"), []byte(strconv.Itoa(port)), 0o600); err != nil {
		upstream.Close()
		t.Fatal(err)
	}
	return codexHome, &modelHits, upstream.Close
}

func TestRunSyncProductionPathsReportHomeAndPreserveExternalProviderEarly(t *testing.T) {
	t.Run("normal injection", func(t *testing.T) {
		codexHome, modelHits, closeServer := prepareSyncProductionFixture(t, "model_provider = \"openai\"\n")
		defer closeServer()
		var out, errOut bytes.Buffer
		if err := runSync(context.Background(), nil, IO{Out: &out, Err: &errOut}); err != nil {
			t.Fatal(err)
		}
		if modelHits.Load() != 1 || !strings.Contains(out.String(), "Target Codex home:") || !strings.Contains(out.String(), "Synced 1 model(s)") {
			t.Fatalf("hits=%d out=%q err=%q", modelHits.Load(), out.String(), errOut.String())
		}
		data, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
		if err != nil || !bytes.Contains(data, []byte("opencodex")) {
			t.Fatalf("normal injection config=%q err=%v", data, err)
		}
	})

	t.Run("external provider early preservation", func(t *testing.T) {
		original := "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://example.test/v1\"\n"
		codexHome, modelHits, closeServer := prepareSyncProductionFixture(t, original)
		defer closeServer()
		var out, errOut bytes.Buffer
		if err := runSync(context.Background(), nil, IO{Out: &out, Err: &errOut}); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
		if err != nil || string(data) != original || modelHits.Load() != 0 {
			t.Fatalf("hits=%d config=%q err=%v", modelHits.Load(), data, err)
		}
		if _, err := os.Stat(filepath.Join(codexHome, "opencodex-catalog.json")); !os.IsNotExist(err) {
			t.Fatalf("external path created catalog: %v", err)
		}
		if !strings.Contains(out.String(), "Target Codex home:") || !strings.Contains(out.String(), "Preserved external Codex provider \"custom\"") {
			t.Fatalf("out=%q err=%q", out.String(), errOut.String())
		}
	})
}

func TestStatusJSONKeepsNullableCodexHomeFields(t *testing.T) {
	ocxHome := t.TempDir()
	t.Setenv("OPENCODEX_HOME", ocxHome)
	t.Setenv("CODEX_HOME", filepath.Join(t.TempDir(), "codex"))
	cfg := config.Default()
	cfg.Port = 9
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runStatus(context.Background(), []string{"--json"}, IO{Out: &out, Err: &out}); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatalf("status JSON: %v: %s", err, out.String())
	}
	home, ok := payload["codexHome"].(map[string]any)
	if !ok {
		t.Fatalf("codexHome = %#v", payload["codexHome"])
	}
	for _, key := range []string{"orcaCodexHome", "warning", "action"} {
		value, exists := home[key]
		if !exists || value != nil {
			t.Fatalf("codexHome[%q] = %#v, exists=%t", key, value, exists)
		}
	}
}
