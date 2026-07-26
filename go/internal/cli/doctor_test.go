package cli

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

type doctorRoundTrip func(*http.Request) (*http.Response, error)

func (fn doctorRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestCollectDoctorReportClassifiesChecks(t *testing.T) {
	home := t.TempDir()
	ocxHome := filepath.Join(home, "ocx")
	if err := os.MkdirAll(ocxHome, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.DefaultProvider = "test"
	cfg.Providers["test"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.test/v1"}
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_700_000_000, 0)
	client := &http.Client{Transport: doctorRoundTrip(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusUnauthorized, Body: io.NopCloser(strings.NewReader(`{}`)), Header: http.Header{}}, nil
	})}
	report, err := collectDoctorReport(context.Background(), doctorDeps{
		GOOS: "linux", GOARCH: "amd64", Home: home,
		Environment: []string{"OPENCODEX_HOME=" + ocxHome, "HTTPS_PROXY=https://secret@example.test"},
		Mounts:      "/dev/root / ext4 rw 0 0\n", WorkingDirectory: home,
		Now: func() time.Time { return now }, HTTPClient: client,
		LookPath:    func(string) (string, error) { return "/bin/echo", nil },
		ReadRuntime: func() (int, int) { return 0, 0 },
		CollectWarnings: func(string, int) ([]codex.ProjectConfigWarning, error) {
			return []codex.ProjectConfigWarning{{Path: filepath.Join(home, ".codex", "config.toml"), Code: codex.IssueRootProvider, Message: "bypasses OpenCodex"}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertDoctorCheck(t, report, "configuration", doctorPass)
	assertDoctorCheck(t, report, "Codex App login", doctorWarn)
	assertDoctorCheck(t, report, "Codex runtime", doctorPass)
	assertDoctorCheck(t, report, "WHAM reachability", doctorWarn)
	assertDoctorCheck(t, report, "project Codex configs", doctorWarn)
	if report.CurrentProxyEnv[1].Key != "HTTPS_PROXY" || !report.CurrentProxyEnv[1].Present {
		t.Fatalf("proxy environment = %#v", report.CurrentProxyEnv)
	}
	encoded := new(bytes.Buffer)
	if err := renderDoctorReport(encoded, report); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(encoded.String(), "secret@example.test") {
		t.Fatal("doctor output leaked a proxy URL")
	}
}

func TestCollectDoctorReportMarksMalformedConfigFailed(t *testing.T) {
	home := t.TempDir()
	ocxHome := filepath.Join(home, "ocx")
	if err := os.MkdirAll(ocxHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ocxHome, "config.json"), []byte(`{"providers":`), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := collectDoctorReport(context.Background(), doctorDeps{
		GOOS: "darwin", GOARCH: "arm64", Home: home,
		Environment: []string{"OPENCODEX_HOME=" + ocxHome}, WorkingDirectory: home,
		Now: func() time.Time { return time.Unix(1, 0) },
		HTTPClient: &http.Client{Transport: doctorRoundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 500, Body: io.NopCloser(strings.NewReader(`{}`)), Header: http.Header{}}, nil
		})},
		LookPath:        func(string) (string, error) { return "/bin/echo", nil },
		ReadRuntime:     func() (int, int) { return 0, 0 },
		CollectWarnings: func(string, int) ([]codex.ProjectConfigWarning, error) { return nil, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	assertDoctorCheck(t, report, "configuration", doctorFail)
	if report.Failures != 1 {
		t.Fatalf("failures = %d, want 1", report.Failures)
	}
}

func TestCollectConfiguredProxyNeverReturnsValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	secret := "http://user:password@proxy.test:8080"
	if err := os.WriteFile(path, []byte(`{"proxy":"`+secret+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	result := collectConfiguredProxy(path, map[string]string{}, os.ReadFile)
	if !result.Present || !result.Configured || result.Detail != "value hidden" {
		t.Fatalf("configured proxy = %#v", result)
	}
	if strings.Contains(result.Detail, "password") || strings.Contains(result.Detail, "proxy.test") {
		t.Fatal("configured proxy detail leaked the value")
	}
}

func assertDoctorCheck(t *testing.T, report doctorReport, name string, status doctorStatus) {
	t.Helper()
	for _, check := range report.Checks {
		if check.Name == name {
			if check.Status != status {
				t.Fatalf("check %q status = %q, want %q (%s)", name, check.Status, status, check.Detail)
			}
			return
		}
	}
	t.Fatalf("check %q not found in %#v", name, report.Checks)
}
