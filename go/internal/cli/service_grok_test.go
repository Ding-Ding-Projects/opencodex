package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/grok"
	"github.com/lidge-jun/opencodex-go/internal/service"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type restartTestManager struct {
	stopErr error
	started bool
}

func (m *restartTestManager) Install() error                  { return nil }
func (m *restartTestManager) Start() error                    { m.started = true; return nil }
func (m *restartTestManager) Stop() error                     { return m.stopErr }
func (m *restartTestManager) Uninstall() error                { return nil }
func (m *restartTestManager) Status() (service.Status, error) { return service.Status{}, nil }
func (m *restartTestManager) ArtifactPath() string            { return "test" }

func TestTeardownGrokFenceRemovesManagedServiceConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("GROK_HOME", home)
	path := filepath.Join(home, "config.toml")
	original := "[model.user]\nmodel = \"mine\"\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if result := grok.InjectGrokConfig(10100, []grok.InjectModel{{ID: "gpt-5.6-sol"}}, grok.Options{GrokHome: home}); !result.OK || !result.Changed {
		t.Fatalf("inject=%#v", result)
	}
	var output, errors bytes.Buffer
	teardownGrokFence(IO{Out: &output, Err: &errors})
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != original || errors.Len() != 0 || !strings.Contains(output.String(), "Removed") {
		t.Fatalf("content=%q out=%q err=%q", content, output.String(), errors.String())
	}
}

func TestVisibleGrokModelsExcludesDisabledCatalogEntries(t *testing.T) {
	models := visibleGrokModels([]types.ModelEntry{
		{ID: "provider/visible", DisplayName: "Visible", ContextWindow: 1000},
	})
	if len(models) != 1 || models[0].ID != "provider/visible" || models[0].Name != "" || models[0].ContextWindow != 1000 {
		t.Fatalf("visible models=%#v", models)
	}
}

func TestRestartManagedServiceProceedsPastStopFailure(t *testing.T) {
	manager := &restartTestManager{stopErr: errors.New("synthetic stop failure")}
	var output, errorOutput bytes.Buffer
	if err := restartManagedService(manager, "127.0.0.1", 0, IO{Out: &output, Err: &errorOutput}); err != nil {
		t.Fatal(err)
	}
	if !manager.started || !strings.Contains(errorOutput.String(), "continuing restart") {
		t.Fatalf("started=%t stderr=%q", manager.started, errorOutput.String())
	}
}

func TestServiceNativeBackendBuildsWinSWOptionsAndPersistsChoice(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", filepath.Join(home, "ocx"))
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	t.Setenv("USERNAME", "jun")
	t.Setenv("USERDOMAIN", "DEV")
	options := serviceManagerOptions(service.BackendNative)
	if options.Backend != service.BackendNative || options.WinSW == nil || options.WinSW.AccountUser != "jun" || options.WinSW.AccountDomain != "DEV" || !strings.HasSuffix(options.WinSW.TokenFile, "service-api-token") {
		t.Fatalf("native manager options=%#v", options)
	}
	if scheduler := serviceManagerOptions(service.BackendScheduler); scheduler.WinSW != nil {
		t.Fatalf("scheduler unexpectedly received WinSW options: %#v", scheduler)
	}
	if err := writeServiceInstallState(service.BackendNative); err != nil {
		t.Fatal(err)
	}
	state := readServiceInstallState()
	if state == nil || state.Backend != service.BackendNative || state.WinSWVersion != service.WinSWVersion || state.WinSWSHA256 != service.WinSWSHA256 {
		t.Fatalf("native install state=%#v", state)
	}
}

func TestForeignServiceOwnershipPreservesGrokFence(t *testing.T) {
	home := t.TempDir()
	ocxHome := t.TempDir()
	codexHome := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", ocxHome)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("GROK_HOME", home)
	state := service.InstallState{Version: 2, CodexHome: filepath.Join(home, "foreign-codex"), OpenCodexHome: filepath.Join(home, "foreign-ocx"), Backend: service.BackendScheduler}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ocxHome, "service-state.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "config.toml")
	if result := grok.InjectGrokConfig(10100, []grok.InjectModel{{ID: "gpt-5.6-sol"}}, grok.Options{GrokHome: home}); !result.OK {
		t.Fatalf("inject=%#v", result)
	}
	var output, errorOutput bytes.Buffer
	teardownOwnedGrokFence(IO{Out: &output, Err: &errorOutput})
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), grok.BeginMarker) || !strings.Contains(errorOutput.String(), "different CODEX_HOME") {
		t.Fatalf("content=%q stderr=%q", content, errorOutput.String())
	}
}
