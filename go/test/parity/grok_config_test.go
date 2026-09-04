package parity_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/grok"
)

type tsGrokSyncCapture struct {
	Models []struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		ContextWindow int    `json:"contextWindow"`
	} `json:"models"`
}

func TestTypeScriptAndGoGrokSyncAndStopBytes(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun runtime is unavailable")
	}
	repositoryRoot := typeScriptOracleRoot()
	injectModule := filepath.Join(repositoryRoot, "src", "grok", "inject.ts")
	syncModule := filepath.Join(repositoryRoot, "src", "grok", "sync.ts")
	for _, path := range []string{injectModule, syncModule} {
		if _, err := os.Stat(path); err != nil {
			t.Skipf("TypeScript Grok source unavailable: %v", err)
		}
	}

	original := []byte("theme = \"dark\"\r\n[model.\"ocx-parity-alias\"]\r\nmodel = \"user/keeps-this\"\r\n")
	tsHome := filepath.Join(t.TempDir(), ".grok")
	goHome := filepath.Join(t.TempDir(), ".grok")
	for _, home := range []string{tsHome, goHome} {
		if err := os.Mkdir(home, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, "config.toml"), original, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	script := fmt.Sprintf(`
import { injectGrokConfig } from %q;
import { syncGrokConfig } from %q;
const config = {
  port: 10190,
  hostname: "127.0.0.1",
  defaultProvider: "parity",
  providers: { parity: { adapter: "openai-chat", baseUrl: "https://parity.invalid/v1", apiKey: "synthetic", models: ["alpha"] } },
};
let captured = [];
const result = await syncGrokConfig(10190, config, { grokHome: %q, hostname: "127.0.0.1" }, {
  fetchAllModels: async () => [{ provider: "parity", id: "alpha", alias: "parity-alias", contextWindow: 131072 }],
  injectGrokConfig: (port, models, options) => {
    captured = models;
    return injectGrokConfig(port, models, options);
  },
});
process.stdout.write(JSON.stringify({ result, models: captured }));
`, injectModule, syncModule, tsHome)
	output, err := exec.Command(bun, "-e", script).Output()
	if err != nil {
		t.Fatalf("TypeScript Grok sync failed: %v", err)
	}
	var captured tsGrokSyncCapture
	if err := json.Unmarshal(output, &captured); err != nil {
		t.Fatalf("decode TypeScript sync capture: %v: %s", err, output)
	}
	models := make([]grok.InjectModel, 0, len(captured.Models))
	for _, model := range captured.Models {
		models = append(models, grok.InjectModel{ID: model.ID, Name: model.Name, ContextWindow: model.ContextWindow})
	}
	result := grok.SyncGrokConfig(context.Background(), 10190, grok.Options{GrokHome: goHome, Hostname: "127.0.0.1"}, grok.SyncDeps{
		FetchModels: func(context.Context) ([]grok.InjectModel, error) { return models, nil },
	})
	if !result.OK || !result.Changed {
		t.Fatalf("Go Grok sync = %#v", result)
	}
	compareGrokConfigBytes(t, "sync", goHome, tsHome)

	stripScript := fmt.Sprintf(`
import { stripGrokConfig } from %q;
const result = stripGrokConfig({ grokHome: %q });
process.stdout.write(JSON.stringify(result));
`, injectModule, tsHome)
	if output, err := exec.Command(bun, "-e", stripScript).CombinedOutput(); err != nil {
		t.Fatalf("TypeScript Grok stop/strip failed: %v: %s", err, output)
	}
	if result := grok.StripGrokConfig(grok.Options{GrokHome: goHome}); !result.OK || !result.Changed {
		t.Fatalf("Go Grok stop/strip = %#v", result)
	}
	compareGrokConfigBytes(t, "stop", goHome, tsHome)
	for runtime, home := range map[string]string{"Go": goHome, "TypeScript": tsHome} {
		data, err := os.ReadFile(filepath.Join(home, "config.toml"))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(data, original) {
			t.Fatalf("%s stop did not restore original bytes: got=%q want=%q", runtime, data, original)
		}
	}
}

func compareGrokConfigBytes(t *testing.T, scenario, goHome, tsHome string) {
	t.Helper()
	goBytes, err := os.ReadFile(filepath.Join(goHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	tsBytes, err := os.ReadFile(filepath.Join(tsHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(goBytes, tsBytes) {
		t.Fatalf("Grok %s bytes differ at offset %d: Go(len=%d sha=%s)=%q TS(len=%d sha=%s)=%q", scenario, firstDifferentByte(goBytes, tsBytes), len(goBytes), payloadDigest(goBytes), goBytes, len(tsBytes), payloadDigest(tsBytes), tsBytes)
	}
}
