package codex

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestShimInstallIsIdempotentAndRestoresBackup(t *testing.T) {
	dir := t.TempDir()
	wrapper := filepath.Join(dir, "codex")
	statePath := filepath.Join(dir, "shim-state.json")
	original := []byte("#!/bin/sh\necho native\n")
	if err := os.WriteFile(wrapper, original, 0o755); err != nil {
		t.Fatal(err)
	}
	options := ShimInstallOptions{ExecutablePath: wrapper, OpenCodexPath: "/opt/ocx", TokenFile: filepath.Join(dir, "service.token"), StatePath: statePath, GOOS: "linux"}
	first, err := InstallCodexShim(options)
	if err != nil {
		t.Fatal(err)
	}
	firstBytes, err := os.ReadFile(wrapper)
	if err != nil {
		t.Fatal(err)
	}
	second, err := InstallCodexShim(options)
	if err != nil {
		t.Fatal(err)
	}
	secondBytes, err := os.ReadFile(wrapper)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || !reflect.DeepEqual(firstBytes, secondBytes) {
		t.Fatalf("second apply changed shim: first=%+v second=%+v", first, second)
	}
	if !strings.Contains(string(firstBytes), "ocx_skip_next") || !strings.Contains(string(firstBytes), options.TokenFile) {
		t.Fatalf("shim lacks argument parser/token path: %s", firstBytes)
	}
	removed, err := UninstallCodexShim(statePath)
	if err != nil || !removed {
		t.Fatalf("uninstall = %v, %v", removed, err)
	}
	restored, err := os.ReadFile(wrapper)
	if err != nil || !reflect.DeepEqual(restored, original) {
		t.Fatalf("restore = %q, %v", restored, err)
	}
}

func TestInjectBranchSelectionAndIdempotency(t *testing.T) {
	original := "model = \"vendor/routed\"\nmodel_context_window = 1000000\nservice_tier = \"priority\"\n"
	loopback := InjectOptions{Port: 10100, Hostname: "127.0.0.1"}
	once, result, err := InjectConfig(original, loopback)
	if err != nil {
		t.Fatal(err)
	}
	if result.KeptUserBaseURL || !strings.Contains(once, `openai_base_url = "http://127.0.0.1:10100/v1"`) || strings.Contains(once, "model_context_window") || strings.Contains(once, "vendor/routed") {
		t.Fatalf("loopback branch mismatch:\n%s", once)
	}
	twice, _, err := InjectConfig(once, loopback)
	if err != nil || twice != once {
		t.Fatalf("inject not idempotent: err=%v\nonce=%q\ntwice=%q", err, once, twice)
	}
	remote := InjectOptions{Port: 10100, Hostname: "10.0.0.8", IncludeAPIAuthHeader: true}
	remoteOutput, _, err := InjectConfig("", remote)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(remoteOutput, `model_provider = "opencodex"`) || !strings.Contains(remoteOutput, "x-opencodex-api-key") {
		t.Fatalf("remote auth branch mismatch:\n%s", remoteOutput)
	}
	external := "model_provider = \"custom\"\n[model_providers.custom]\nbase_url=\"https://example.com/v1\"\n"
	kept, externalResult, err := InjectConfig(external, remote)
	if err != nil || kept != external || externalResult.PreservedExternalProvider != "custom" {
		t.Fatalf("external branch = %q %+v %v", kept, externalResult, err)
	}
	if !ShouldInjectAPIAuthHeader("10.0.0.8") || ShouldInjectAPIAuthHeader("localhost") {
		t.Fatal("auth-header hostname gate mismatch")
	}
	if ClassifyCodexRouting(remoteOutput) != RoutingCustomRemote || ClassifyCodexRouting(external) != RoutingCustomRemote {
		t.Fatalf("routing classification remote=%s external=%s", ClassifyCodexRouting(remoteOutput), ClassifyCodexRouting(external))
	}
}

func TestFallbackLadderOrderingAndHealth(t *testing.T) {
	state := NewSubagentFallbackState()
	now := time.Unix(100, 0)
	quotaStore := NewQuotaStore()
	quotaStore.nowUnix = func() int64 { return now.UnixMilli() }
	quotaStore.SetParsed("acct", &StoredAccountQuota{WeeklyPercent: quotaFloatPointer(95)})
	config := SubagentFallbackConfig{
		FallbackModels: []string{"gpt-primary", "anthropic/claude", "openai/gpt-last"},
		KnownProviders: []string{"openai", "anthropic"}, ActiveAccountID: "acct", AutoSwitchPercent: 80,
		Route: func(model string) (FallbackRoute, error) {
			if strings.HasPrefix(model, "anthropic/") {
				return FallbackRoute{Provider: FallbackProvider{ID: "anthropic"}}, nil
			}
			return FallbackRoute{Provider: FallbackProvider{ID: "openai", CodexAccountMode: "pool", CanonicalOpenAI: true}}, nil
		},
		AccountUsable: func(string) bool { return true },
		Quota:         quotaStore.Get,
	}
	chain := BuildSubagentModelChain("gpt-primary", config.FallbackModels, []string{"anthropic/claude", "custom/first"})
	wantChain := []string{"gpt-primary", "anthropic/claude", "custom/first", "openai/gpt-last"}
	if !reflect.DeepEqual(chain, wantChain) {
		t.Fatalf("chain=%v want=%v", chain, wantChain)
	}
	selection := state.Select("gpt-primary", config, []string{"anthropic/claude"}, nil, now, false)
	if selection.Model != "anthropic/claude" || !selection.Rewritten || !reflect.DeepEqual(selection.Skipped, []string{"gpt-primary"}) {
		t.Fatalf("selection=%+v", selection)
	}
	state.NoteFailure("anthropic/claude", "429 quota exhausted", config, nil, now, time.Minute)
	selection = state.Select("gpt-primary", config, []string{"anthropic/claude"}, nil, now, false)
	if selection.Model != "gpt-primary" || selection.Rewritten || len(selection.Skipped) != 3 {
		t.Fatalf("all-blocked selection=%+v", selection)
	}
}

func TestWarningEmissionGroupsEffectiveBypass(t *testing.T) {
	content := []byte("profile = \"work\"\n[profiles.work]\nmodel_provider = \"opencode_go\"\n[model_providers.opencode_go]\nbase_url = \"http://localhost:4096/v1\"\n")
	warnings, err := AnalyzeProjectConfig(content, "/repo/.codex/config.toml")
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 || warnings[0].Code != IssueProviderTable {
		t.Fatalf("warnings=%+v", warnings)
	}
	lines := FormatProjectConfigWarningsForConsole(warnings)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "[model_providers.opencode_go]") || !strings.Contains(joined, "Codex uses OpenCode Go") || !strings.Contains(joined, "fix:") {
		t.Fatalf("warning output:\n%s", joined)
	}
}

func TestQuotaHeaderApplyAndMonthlyOnlyClearsWeekly(t *testing.T) {
	store := NewQuotaStore()
	store.SetParsed("acct", &StoredAccountQuota{WeeklyPercent: quotaFloatPointer(20), MonthlyPercent: quotaFloatPointer(30)})
	headers := http.Header{}
	headers.Set("x-codex-primary-used-percent", "45")
	headers.Set("x-codex-primary-window-minutes", "43200")
	headers.Set("x-codex-secondary-used-percent", "12")
	if !store.ApplyUpstreamHeaders("acct", headers) {
		t.Fatal("headers were not applied")
	}
	quota, ok := store.Get("acct")
	if !ok || quota.MonthlyPercent == nil || *quota.MonthlyPercent != 45 || quota.WeeklyPercent == nil || *quota.WeeklyPercent != 12 {
		t.Fatalf("quota=%+v", quota)
	}
	store.SetParsed("acct", &StoredAccountQuota{MonthlyPercent: quotaFloatPointer(50)})
	quota, _ = store.Get("acct")
	if quota.WeeklyPercent != nil || quota.MonthlyPercent == nil || *quota.MonthlyPercent != 50 {
		t.Fatalf("monthly-only merge=%+v", quota)
	}
}

func TestHistoryProviderMigratesDatabaseAndAppendsRolloutMetadata(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "state_5.sqlite")
	backupPath := filepath.Join(dir, "backup.json")
	rolloutPath := filepath.Join(dir, "rollout.jsonl")
	meta := map[string]any{"type": "session_meta", "timestamp": "2026-01-01T00:00:00Z", "payload": map[string]any{"id": "thread-1", "model_provider": "openai", "source": "cli"}}
	line, _ := json.Marshal(meta)
	if err := os.WriteFile(rolloutPath, append(line, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, source TEXT, has_user_event INTEGER, first_user_message TEXT); INSERT INTO threads VALUES ('thread-1', ?, 'openai', 'cli', 0, 'hello')`, rolloutPath)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	result, err := SyncCodexHistoryProvider(HistoryProviderOpenCodex, dbPath, backupPath, HistorySyncOptions{Attempts: 1})
	if err != nil || result.Rows != 1 || result.Files != 1 {
		t.Fatalf("sync=%+v err=%v", result, err)
	}
	db, _ = sql.Open("sqlite", dbPath)
	var provider string
	if err = db.QueryRow(`SELECT model_provider FROM threads WHERE id='thread-1'`).Scan(&provider); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if provider != "opencodex" {
		t.Fatalf("provider=%s", provider)
	}
	rollout, _ := os.ReadFile(rolloutPath)
	if strings.Count(string(rollout), "session_meta") != 2 || !strings.Contains(string(rollout), `"model_provider":"opencodex"`) {
		t.Fatalf("rollout=%s", rollout)
	}
	restored, err := SyncCodexHistoryProvider(HistoryProviderOpenAI, dbPath, backupPath, HistorySyncOptions{Attempts: 1})
	if err != nil || restored.Rows != 1 {
		t.Fatalf("restore=%+v err=%v", restored, err)
	}
}

func TestFeatureLogicalLimitAndAmbiguousTransitionGate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	content := "[features.multi_agent_v2]\nenabled = true\n\n[agents]\nmax_threads = 7\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	value, ok, err := GetLogicalMaxThreads(path)
	if err != nil || !ok || value != 7 {
		t.Fatalf("logical limit=%d ok=%v err=%v", value, ok, err)
	}
	ambiguous := "[features]\nmulti_agent_v2.enabled = true\n[agents]\nmax_threads = 7\n"
	if err = os.WriteFile(path, []byte(ambiguous), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = SetMultiAgentV2(path, true, 7); err == nil || !strings.Contains(err.Error(), "dotted") {
		t.Fatalf("expected dotted-key rejection, got %v", err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != ambiguous {
		t.Fatalf("ambiguous config was modified: %q", after)
	}
}
