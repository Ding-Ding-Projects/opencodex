package claude

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDesktop3pFingerprintStableAndApplyIdempotent(t *testing.T) {
	dir := t.TempDir()
	routed := []Desktop3pRoutedModel{{Provider: "openrouter", ID: "model", ContextWindow: OneMillion}}
	first, err := ApplyDesktop3pConfig(dir, 10100, nil, routed, "ocx", Desktop3pStatic, nil)
	if err != nil {
		t.Fatal(err)
	}
	originalConfig := mustReadFile(t, first.Path)
	originalMetadata := mustReadFile(t, filepath.Join(dir, "_meta.json"))
	second, err := ApplyDesktop3pConfig(dir, 10100, nil, routed, "ocx", Desktop3pStatic, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Fingerprint == "" || first.Fingerprint != second.Fingerprint || first.Path != second.Path {
		t.Fatalf("apply results changed: %#v %#v", first, second)
	}
	if !first.Written || second.Written {
		t.Fatalf("idempotence flags = first:%v second:%v", first.Written, second.Written)
	}
	assertFileBytes(t, first.Path, originalConfig)
	assertFileBytes(t, filepath.Join(dir, "_meta.json"), originalMetadata)
	data, err := os.ReadFile(filepath.Join(dir, "_meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), `"name": "opencodex"`) != 1 {
		t.Fatalf("metadata entry duplicated: %s", data)
	}
	status := ReadDesktop3pStatus(dir, first.Fingerprint, "2026-07-26T00:00:00Z")
	if !status.Applied || status.Stale || status.OnDiskFingerprint == nil || *status.OnDiskFingerprint != first.Fingerprint || status.ConfigPath == nil || *status.ConfigPath != first.Path {
		t.Fatalf("status = %#v", status)
	}
}

func TestDesktop3pTransactionalApplyFailureRestoresOriginal(t *testing.T) {
	dir := t.TempDir()
	id := "11111111-1111-4111-8111-111111111111"
	configPath := filepath.Join(dir, id+".json")
	metadataPath := filepath.Join(dir, "_meta.json")
	originalConfig := []byte("original config\n")
	originalMetadata := []byte(`{"appliedId":"` + id + `","entries":[{"id":"` + id + `","name":"opencodex"}]}` + "\n")
	if err := os.WriteFile(configPath, originalConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metadataPath, originalMetadata, 0o600); err != nil {
		t.Fatal(err)
	}
	writer := func(path string, data []byte, mode os.FileMode) error {
		if path == metadataPath {
			return errors.New("injected metadata failure")
		}
		return atomicWriteFile(path, data, mode)
	}
	_, err := applyDesktop3pConfig(dir, 10100, nil, nil, "ocx", Desktop3pStatic, nil, writer)
	if err == nil || !strings.Contains(err.Error(), "injected metadata failure") {
		t.Fatalf("apply error = %v", err)
	}
	if got, _ := os.ReadFile(configPath); string(got) != string(originalConfig) {
		t.Fatalf("config changed after rollback: %q", got)
	}
	if got, _ := os.ReadFile(metadataPath); string(got) != string(originalMetadata) {
		t.Fatalf("metadata changed after failure: %q", got)
	}
}

func TestDesktop3pTransactionalApplyFailureRemovesNewConfig(t *testing.T) {
	dir := t.TempDir()
	metadataPath := filepath.Join(dir, "_meta.json")
	writer := func(path string, data []byte, mode os.FileMode) error {
		if path == metadataPath {
			return errors.New("injected metadata failure")
		}
		return atomicWriteFile(path, data, mode)
	}
	result, err := applyDesktop3pConfig(dir, 10100, nil, nil, "ocx", Desktop3pStatic, nil, writer)
	if err == nil {
		t.Fatal("metadata failure was accepted")
	}
	if _, statErr := os.Stat(result.Path); !os.IsNotExist(statErr) {
		t.Fatalf("new config remains after rollback: %v", statErr)
	}
	if _, statErr := os.Stat(metadataPath); !os.IsNotExist(statErr) {
		t.Fatalf("metadata appeared after failed write: %v", statErr)
	}
}

func TestDesktopUnavailableRouteProtection(t *testing.T) {
	current, err := ParseDesktopProfile(map[string]any{
		"version":     1,
		"assignments": map[string]any{"missing/old": map[string]any{"family": "opus", "alias": "claude-opus-4-8-20260101"}},
		"defaults":    map[string]any{"opus": "missing/old", "fable": nil, "sonnet": nil, "haiku": nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	next := current.Clone()
	next.Assignments["missing/old"] = DesktopAssignment{Family: DesktopFamilyHaiku, Alias: "claude-opus-4-8-20260101"}
	next.Defaults[DesktopFamilyOpus] = nil
	next.Defaults[DesktopFamilyHaiku] = stringPointer("missing/old")
	if err := ValidateDesktopProfileAvailability(current, next, []string{"missing/old"}); err == nil {
		t.Fatal("unavailable route move was accepted")
	}
}

func TestDesktopSurfaceDiscriminationAndPrefer1M(t *testing.T) {
	models := GenerateDesktop3pModels(nil, []Desktop3pRoutedModel{{Provider: "p", ID: "m", ContextWindow: OneMillion}})
	if len(models) != 1 || !models[0].Supports1M || !models[0].Prefer1M {
		t.Fatalf("desktop models = %#v", models)
	}
	if got := DetectInboundSurface(models[0].Name); got != InboundSurfaceClaudeDesktop {
		t.Fatalf("desktop surface = %q", got)
	}
	if got := DetectInboundSurface("claude-ocx-p--m"); got != InboundSurfaceClaude {
		t.Fatalf("code surface = %q", got)
	}
}

func TestDesktopStatusDetectsOnDiskDrift(t *testing.T) {
	dir := t.TempDir()
	result, err := ApplyDesktop3pConfig(dir, 10100, nil, nil, "ocx", Desktop3pStatic, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(result.Path, []byte("changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	status := ReadDesktop3pStatus(dir, result.Fingerprint, "2026-07-26T00:00:00Z")
	if !status.Stale || status.OnDiskFingerprint == nil || *status.OnDiskFingerprint == result.Fingerprint {
		t.Fatalf("stale status = %#v", status)
	}
}

func TestDesktopModelInfoUsesActiveProfileAlias(t *testing.T) {
	profile, err := ReconcileDesktopProfile(nil, []DesktopProfileModel{{Route: "p/m", Label: "M"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := GenerateDesktop3pModelsWithProfile(nil, []Desktop3pRoutedModel{{Provider: "p", ID: "m"}}, &profile); err != nil {
		t.Fatal(err)
	}
	infos := BuildModelInfosWithAlias(nil, []DiscoveryModel{{Provider: "p", ID: "m"}}, AutoContextOff, AnthropicIDDesktop3P, ActiveDesktop3pAlias)
	if len(infos) != 1 || infos[0].ID != profile.Assignments["p/m"].Alias {
		t.Fatalf("model infos = %#v", infos)
	}
}
