package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
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
