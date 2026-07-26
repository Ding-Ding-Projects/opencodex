package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

func TestUpdateTagDryRunPlansNativeReleaseArtifact(t *testing.T) {
	restore := stubNativeReleaseUpdate(t)
	defer restore()
	var output bytes.Buffer
	destination := filepath.Join(t.TempDir(), "ocx")
	if err := runUpdate(context.Background(), []string{"--tag", "preview", "--destination", destination, "--dry-run"}, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"v2.9.0-preview.1", "ocx_2.9.0-preview.1_linux_amd64", strings.Repeat("a", 64), destination} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("dry-run missing %q: %s", want, output.String())
		}
	}
}

func TestUpdatePreviewDryRunResolvesManifestWithoutReplacingBinary(t *testing.T) {
	const version = "2.9.1-preview.20260726"
	digest := strings.Repeat("c", 64)
	artifactName := updatepkg.ReleaseArtifactName(version, runtime.GOOS, runtime.GOARCH)
	checksumName := updatepkg.ReleaseChecksumName(version)
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/repos/lidge-jun/opencodex/releases":
			base := server.URL + "/lidge-jun/opencodex/releases/download/v" + version + "/"
			_ = json.NewEncoder(writer).Encode([]map[string]any{{
				"tag_name": "v" + version, "prerelease": true, "draft": false,
				"assets": []map[string]string{
					{"name": artifactName, "browser_download_url": base + artifactName},
					{"name": checksumName, "browser_download_url": base + checksumName},
				},
			}})
		case "/lidge-jun/opencodex/releases/download/v" + version + "/" + checksumName:
			_, _ = fmt.Fprintf(writer, "%s  %s\n", digest, artifactName)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	previousResolve, previousDownload := resolveNativeReleaseArtifact, downloadNativeUpdate
	defer func() { resolveNativeReleaseArtifact, downloadNativeUpdate = previousResolve, previousDownload }()
	resolveNativeReleaseArtifact = func(ctx context.Context, channel updatepkg.Channel) (updatepkg.ReleaseArtifact, error) {
		resolver := updatepkg.GitHubReleaseResolver{
			Client: server.Client(), APIBase: server.URL, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
			AllowedAssetHosts: []string{strings.TrimPrefix(server.URL, "https://")},
		}
		return resolver.Resolve(ctx, channel)
	}
	replaced := false
	downloadNativeUpdate = func(context.Context, string, string, string) error {
		replaced = true
		return nil
	}
	destination := filepath.Join(t.TempDir(), "ocx")
	if err := os.WriteFile(destination, []byte("unchanged"), 0o755); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runUpdate(context.Background(), []string{"--tag", "preview", "--destination", destination, "--dry-run"}, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"v" + version, artifactName, digest, destination} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("dry-run missing %q: %s", want, output.String())
		}
	}
	if replaced || string(mustReadFile(t, destination)) != "unchanged" {
		t.Fatalf("dry-run changed destination: replaced=%t body=%q", replaced, mustReadFile(t, destination))
	}
}

func TestUpdateRejectsUnknownTagWithoutExecution(t *testing.T) {
	if err := runUpdate(context.Background(), []string{"--tag", "nightly", "--dry-run"}, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}); err == nil {
		t.Fatal("unknown update channel accepted")
	}
}

func TestUpdateTagDownloadsVerifiedNativeArtifact(t *testing.T) {
	restore := stubNativeReleaseUpdate(t)
	defer restore()
	destination := filepath.Join(t.TempDir(), "ocx")
	if err := os.WriteFile(destination, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := runUpdate(context.Background(), []string{"--tag", "latest", "--destination", destination}, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}
	if got := string(mustReadFile(t, destination)); got != "downloaded:https://github.com/lidge-jun/opencodex/releases/download/v2.9.0-preview.1/ocx_2.9.0-preview.1_linux_amd64:"+strings.Repeat("a", 64) {
		t.Fatalf("replacement=%q", got)
	}
}

func TestUpdateTagDoesNotReplaceMatchingVersion(t *testing.T) {
	restore := stubNativeReleaseUpdate(t)
	defer restore()
	previousVersion := Version
	Version = "2.9.0-preview.1"
	defer func() { Version = previousVersion }()
	destination := filepath.Join(t.TempDir(), "ocx")
	if err := os.WriteFile(destination, []byte("unchanged"), 0o755); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runUpdate(context.Background(), []string{"--tag", "preview", "--destination", destination}, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	if got := string(mustReadFile(t, destination)); got != "unchanged" || !strings.Contains(output.String(), "Already on the latest preview release") {
		t.Fatalf("destination=%q output=%q", got, output.String())
	}
}

func stubNativeReleaseUpdate(t *testing.T) func() {
	t.Helper()
	previousResolve, previousDownload := resolveNativeReleaseArtifact, downloadNativeUpdate
	resolveNativeReleaseArtifact = func(context.Context, updatepkg.Channel) (updatepkg.ReleaseArtifact, error) {
		return updatepkg.ReleaseArtifact{Version: "2.9.0-preview.1", Name: "ocx_2.9.0-preview.1_linux_amd64", URL: "https://github.com/lidge-jun/opencodex/releases/download/v2.9.0-preview.1/ocx_2.9.0-preview.1_linux_amd64", SHA256: strings.Repeat("a", 64)}, nil
	}
	downloadNativeUpdate = func(_ context.Context, sourceURL, digest, destination string) error {
		return os.WriteFile(destination, []byte("downloaded:"+sourceURL+":"+digest), 0o755)
	}
	return func() { resolveNativeReleaseArtifact, downloadNativeUpdate = previousResolve, previousDownload }
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
