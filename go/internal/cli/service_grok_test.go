package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/grok"
	"github.com/lidge-jun/opencodex-go/internal/service"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type serviceActivationManager struct {
	name       string
	installed  bool
	installErr error
	calls      *[]string
}

func (m *serviceActivationManager) record(action string) {
	*m.calls = append(*m.calls, m.name+":"+action)
}
func (m *serviceActivationManager) Install() error {
	m.record("install")
	if m.installErr == nil {
		m.installed = true
	}
	return m.installErr
}
func (m *serviceActivationManager) Start() error { m.record("start"); return nil }
func (m *serviceActivationManager) Stop() error  { m.record("stop"); return nil }
func (m *serviceActivationManager) Uninstall() error {
	m.record("uninstall")
	m.installed = false
	return nil
}
func (m *serviceActivationManager) Status() (service.Status, error) {
	m.record("status")
	return service.Status{Installed: m.installed, Running: m.installed}, nil
}
func (m *serviceActivationManager) ArtifactPath() string { return m.name }

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

func TestVisibleGrokCatalogPreservesLiveModelOrder(t *testing.T) {
	cfg := config.Default()
	cfg.Providers = map[string]config.ProviderConfig{"routed": {Models: []string{"model"}}}
	models := []types.ModelEntry{
		{ID: "routed/model", Provider: "routed"},
		{ID: "gpt-5.6-luna", Provider: "openai"},
		{ID: "gpt-5.6-terra", Provider: "openai"},
	}
	visible := visibleGrokCatalogModels(models, cfg)
	if len(visible) < 3 || visible[0].ID != "routed/model" || visible[1].ID != "gpt-5.6-luna" || visible[2].ID != "gpt-5.6-terra" {
		t.Fatalf("live catalog order was replaced: %#v", visible)
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

func TestApplyGrokFenceThreadsConfiguredExclusions(t *testing.T) {
	home := tempGrokHomeForCLI(t)
	t.Setenv("GROK_HOME", home)
	catalog := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/models" {
			t.Fatalf("catalog path = %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"models":[{"id":"gpt-5.5","provider":"openai","contextWindow":272000},{"id":"gpt-5.4","provider":"openai","contextWindow":1000000}]}`)
	}))
	defer catalog.Close()
	parsed, err := url.Parse(catalog.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.GrokExcludedModels = []string{"gpt-5.5"}
	var output bytes.Buffer
	if err := applyGrokFence(context.Background(), &cfg, port, "127.0.0.1", false, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), `model = "gpt-5.5"`) {
		t.Fatalf("excluded model was emitted:\n%s", content)
	}
}

func tempGrokHomeForCLI(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("theme = \"dark\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
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

func TestRunServiceActivatesBackendSwitchStatusAndUninstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", filepath.Join(home, "ocx"))
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	cfg := config.FreshInstall()
	path, err := configPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	if err := writeServiceInstallState(service.BackendScheduler); err != nil {
		t.Fatal(err)
	}
	originalGOOS, originalFactory := serviceRuntimeGOOS, newServiceManagerWithOptions
	t.Cleanup(func() { serviceRuntimeGOOS, newServiceManagerWithOptions = originalGOOS, originalFactory })
	serviceRuntimeGOOS = "windows"
	var calls []string
	scheduler := &serviceActivationManager{name: "scheduler", installed: true, calls: &calls}
	native := &serviceActivationManager{name: "native", calls: &calls}
	newServiceManagerWithOptions = func(_ service.Config, options service.ManagerOptions) (service.Manager, error) {
		if options.Backend == service.BackendNative {
			return native, nil
		}
		return scheduler, nil
	}

	var output bytes.Buffer
	if err := runService([]string{"install", "--native"}, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	wantPrefix := []string{"scheduler:status", "scheduler:uninstall", "scheduler:status", "native:install"}
	if len(calls) < len(wantPrefix) || strings.Join(calls[:len(wantPrefix)], ",") != strings.Join(wantPrefix, ",") {
		t.Fatalf("switch calls=%v", calls)
	}
	if state := readServiceInstallState(); state == nil || state.Backend != service.BackendNative {
		t.Fatalf("installed state=%#v", state)
	}
	calls = nil
	if err := runService([]string{"status"}, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	if err := runService([]string{"uninstall"}, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(calls, ","), "native:status") || !strings.Contains(strings.Join(calls, ","), "native:uninstall") {
		t.Fatalf("status/uninstall calls=%v", calls)
	}
}

func TestRunServiceBackendSwitchReportsNoServiceAfterTargetFailure(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", filepath.Join(home, "ocx"))
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	cfg := config.FreshInstall()
	path, _ := configPath()
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	if err := writeServiceInstallState(service.BackendScheduler); err != nil {
		t.Fatal(err)
	}
	originalGOOS, originalFactory := serviceRuntimeGOOS, newServiceManagerWithOptions
	t.Cleanup(func() { serviceRuntimeGOOS, newServiceManagerWithOptions = originalGOOS, originalFactory })
	serviceRuntimeGOOS = "windows"
	var calls []string
	scheduler := &serviceActivationManager{name: "scheduler", installed: true, calls: &calls}
	native := &serviceActivationManager{name: "native", installErr: errors.New("synthetic WinSW failure"), calls: &calls}
	newServiceManagerWithOptions = func(_ service.Config, options service.ManagerOptions) (service.Manager, error) {
		if options.Backend == service.BackendNative {
			return native, nil
		}
		return scheduler, nil
	}
	err := runService([]string{"install", "--native"}, IO{Out: io.Discard})
	if err == nil || !strings.Contains(err.Error(), "no service is installed") || scheduler.installed || native.installed {
		t.Fatalf("switch failure err=%v scheduler=%t native=%t calls=%v", err, scheduler.installed, native.installed, calls)
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
