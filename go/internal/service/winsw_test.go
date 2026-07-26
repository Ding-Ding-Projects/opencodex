package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testWinSWConfig(dir string) WinSWConfig {
	return WinSWConfig{Config: Config{Executable: `C:\Program Files\Bun\bun.exe`, Arguments: []string{`C:\Open Codex\cli.ts`, "start", "--port", "10100"}, Environment: map[string]string{"PATH": `C:\bin`}, LogPath: dir}, ConfigDir: dir, TokenFile: filepath.Join(dir, "service-token"), AccountDomain: "DEV", AccountUser: "jun"}
}

func TestGenerateWinSWXMLNeverEmbedsTokenAndEscapesValues(t *testing.T) {
	config := testWinSWConfig(t.TempDir())
	config.Environment["SPECIAL"] = `a&b<"c">`
	document, err := GenerateWinSWXML(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{WinSWServiceID, `<user>jun</user>`, `<allowservicelogon>true</allowservicelogon>`, `OCX_API_TOKEN_FILE`, `a&amp;b&lt;`, `<stoptimeout>20 sec</stoptimeout>`} {
		if !strings.Contains(document, expected) {
			t.Errorf("WinSW XML missing %q", expected)
		}
	}
	if strings.Contains(document, "Bearer ") || strings.Contains(document, "api-token-value") {
		t.Fatal("WinSW XML embedded a token value")
	}
	if err := validateWinSWXML(document); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureWinSWBinaryBoundsAndVerifiesHash(t *testing.T) {
	data := []byte("official-test-binary")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write(data) }))
	defer server.Close()
	config := testWinSWConfig(t.TempDir())
	config.DownloadURL, config.ExpectedSHA256 = server.URL, SHA256Hex(data)
	path, err := EnsureWinSWBinary(context.Background(), server.Client(), config)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || !reflect.DeepEqual(got, data) {
		t.Fatalf("binary=%q err=%v", got, err)
	}
	if _, err := EnsureWinSWBinary(context.Background(), server.Client(), config); err != nil {
		t.Fatal(err)
	}
	config.ExpectedSHA256 = strings.Repeat("0", 64)
	if _, err := EnsureWinSWBinary(context.Background(), server.Client(), config); err == nil {
		t.Fatal("hash mismatch accepted")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unverified binary remains: %v", err)
	}
}

func TestWinSWInstallBranchesAndRollsBackWrongAccount(t *testing.T) {
	data := []byte("winsw")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write(data) }))
	defer server.Close()
	config := testWinSWConfig(t.TempDir())
	config.DownloadURL, config.ExpectedSHA256 = server.URL, SHA256Hex(data)
	var calls []string
	runner := func(_ context.Context, _ string, args []string, interactive bool) (string, error) {
		calls = append(calls, strings.Join(args, " ")+"|interactive="+map[bool]string{true: "true", false: "false"}[interactive])
		switch args[0] {
		case "status":
			return "NonExistent", nil
		case "qc":
			return "SERVICE_START_NAME : LocalSystem", nil
		default:
			return "", nil
		}
	}
	manager, err := NewWinSWManager(config, server.Client(), runner)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Install(); err == nil || !strings.Contains(err.Error(), "rolled back") {
		t.Fatalf("wrong account install err=%v", err)
	}
	want := []string{"status|interactive=false", "install /p|interactive=true", "qc opencodex-proxy-native|interactive=false", "uninstall|interactive=false"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls=%v want=%v", calls, want)
	}
}
