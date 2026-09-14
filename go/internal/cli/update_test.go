package cli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/platform"
	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

type nativeUpdateFixture struct {
	executable string
	current    string
	deps       nativeUpdateDeps
	resolved   int
	downloaded int
	artifact   updatepkg.ReleaseArtifact
}

func newNativeUpdateFixture(t *testing.T, current, latest string, channel updatepkg.Channel) *nativeUpdateFixture {
	t.Helper()
	root := t.TempDir()
	goos, goarch := "linux", "amd64"
	nativeDir := filepath.Join(root, "bin", "native")
	if err := os.MkdirAll(nativeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		// These tests simulate a non-Windows update target on purpose: runUpdate
		// refuses outright on an actually-Windows target (deps.goos == "windows"),
		// so there would be nothing left of the channel/version/policy logic below
		// to exercise otherwise. os.Chmod cannot set a POSIX execute bit on a real
		// Windows disk no matter what mode os.WriteFile is asked for, so the
		// 0o755 below can never make isExecutableModeForTarget's real check pass
		// for that simulated target -- there is no real file on this filesystem
		// that could. Honor what the fixture asked for instead of leaving every
		// test built on it permanently unable to run on a Windows host.
		previous := isExecutableModeForTarget
		isExecutableModeForTarget = func(os.FileMode, string) bool { return true }
		t.Cleanup(func() { isExecutableModeForTarget = previous })
	}
	executable := filepath.Join(nativeDir, updatepkg.ReleaseArtifactName(current, goos, goarch))
	for path, file := range map[string]struct {
		body string
		mode os.FileMode
	}{
		executable:                            {"old-native", 0o755},
		filepath.Join(root, "bin", "ocx.mjs"): {"launcher", 0o644},
		filepath.Join(root, "package.json"):   {`{"version":"` + current + `"}`, 0o644},
	} {
		if err := os.WriteFile(path, []byte(file.body), file.mode); err != nil {
			t.Fatal(err)
		}
	}
	fixture := &nativeUpdateFixture{executable: executable, current: current}
	fixture.artifact = updatepkg.ReleaseArtifact{
		Channel: channel, Version: latest,
		Name:   updatepkg.ReleaseArtifactName(latest, goos, goarch),
		URL:    "https://github.com/lidge-jun/opencodex/releases/download/v" + latest + "/" + updatepkg.ReleaseArtifactName(latest, goos, goarch),
		SHA256: strings.Repeat("a", 64),
	}
	fixture.deps = nativeUpdateDeps{
		executable: func() (string, error) { return executable, nil },
		goos:       goos, goarch: goarch, version: current,
		resolve: func(context.Context, updatepkg.Channel) (updatepkg.ReleaseArtifact, error) {
			fixture.resolved++
			return fixture.artifact, nil
		},
		download: func(context.Context, string, string, platform.UpdateDestination) error {
			fixture.downloaded++
			return nil
		},
	}
	return fixture
}

func TestUpdateDefaultsToCurrentPreviewChannelAndPlansPackageDestination(t *testing.T) {
	fixture := newNativeUpdateFixture(t, "2.7.41-preview.1", "2.7.41-preview.2", updatepkg.ChannelPreview)
	var output bytes.Buffer
	if err := runUpdateWithDeps(context.Background(), []string{"--dry-run"}, IO{Out: &output, Err: &output}, fixture.deps); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"v2.7.41-preview.2", fixture.artifact.Name, fixture.executable, fixture.artifact.SHA256} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("output missing %q: %s", want, output.String())
		}
	}
	if fixture.resolved != 1 || fixture.downloaded != 0 {
		t.Fatalf("resolve=%d download=%d", fixture.resolved, fixture.downloaded)
	}
}

func TestUpdateDownloadsNewerSameChannelArtifact(t *testing.T) {
	fixture := newNativeUpdateFixture(t, "2.7.41", "2.8.0", updatepkg.ChannelLatest)
	var output bytes.Buffer
	if err := runUpdateWithDeps(context.Background(), []string{"--tag", "latest"}, IO{Out: &output, Err: &output}, fixture.deps); err != nil {
		t.Fatal(err)
	}
	if fixture.downloaded != 1 || !strings.Contains(output.String(), "Package metadata remains at v2.7.41") {
		t.Fatalf("download=%d output=%q", fixture.downloaded, output.String())
	}
}

func TestUpdateAcceptsOldPackageNameAfterPriorNativeSelfUpdate(t *testing.T) {
	fixture := newNativeUpdateFixture(t, "2.7.41", "2.7.43", updatepkg.ChannelLatest)
	fixture.deps.version = "2.7.42"
	if err := runUpdateWithDeps(context.Background(), nil, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, fixture.deps); err != nil {
		t.Fatal(err)
	}
	if fixture.resolved != 1 || fixture.downloaded != 1 {
		t.Fatalf("resolve=%d download=%d", fixture.resolved, fixture.downloaded)
	}
}

func TestUpdateEqualVersionIsNoOp(t *testing.T) {
	fixture := newNativeUpdateFixture(t, "2.7.41", "2.7.41", updatepkg.ChannelLatest)
	var output bytes.Buffer
	if err := runUpdateWithDeps(context.Background(), nil, IO{Out: &output, Err: &output}, fixture.deps); err != nil {
		t.Fatal(err)
	}
	if fixture.downloaded != 0 || !strings.Contains(output.String(), "Already on the latest latest release") {
		t.Fatalf("download=%d output=%q", fixture.downloaded, output.String())
	}
}

func TestUpdateRejectsPolicyViolationsBeforeDownload(t *testing.T) {
	tests := []struct {
		name, current, latest string
		channel               updatepkg.Channel
		args                  []string
		mutate                func(*nativeUpdateFixture)
		wantResolve           bool
	}{
		{"cross channel request", "2.7.41", "2.8.0-preview.1", updatepkg.ChannelPreview, []string{"--tag", "preview"}, nil, false},
		{"malformed release", "2.7.41", "wat", updatepkg.ChannelLatest, nil, nil, true},
		{"wrong artifact target", "2.7.41", "2.8.0", updatepkg.ChannelLatest, nil, func(f *nativeUpdateFixture) { f.artifact.Name = "ocx_2.8.0_darwin_arm64" }, true},
		{"wrong artifact channel", "2.7.41", "2.8.0", updatepkg.ChannelLatest, nil, func(f *nativeUpdateFixture) { f.artifact.Channel = updatepkg.ChannelPreview }, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newNativeUpdateFixture(t, test.current, test.latest, test.channel)
			if test.mutate != nil {
				test.mutate(fixture)
			}
			err := runUpdateWithDeps(context.Background(), test.args, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, fixture.deps)
			if err == nil || fixture.downloaded != 0 {
				t.Fatalf("err=%v download=%d", err, fixture.downloaded)
			}
			if (fixture.resolved != 0) != test.wantResolve {
				t.Fatalf("resolve=%d", fixture.resolved)
			}
		})
	}
}

// A downgrade or a cross-major jump is NOT a policy violation for native
// update: it used to live in TestUpdateRejectsPolicyViolationsBeforeDownload
// as one, and that assertion was simply wrong, catchable only once the
// Windows execute-bit fixture problem above stopped masking it (every case
// in that table failed the same way before that fix, so nobody could see
// these two disagreed with the others). ValidateNativeTransition's own
// dedicated tests (internal/update/check_test.go, "downgrade follows
// registry result" and "cross major follows registry result") and its
// doc comment already establish the real contract: it mirrors the oracle
// (src/update/index.ts runUpdate), which gates only on `latest === current`
// and installs whatever the registry resolved otherwise, trusting the
// registry rather than re-deriving "newer" itself. Native update is the
// same decision, just executed as a local binary swap instead of npm.
func TestUpdateFollowsRegistryOnDowngradeAndCrossMajor(t *testing.T) {
	for _, test := range []struct {
		name, current, latest string
	}{
		{"downgrade", "2.8.0", "2.7.41"},
		{"cross major", "2.7.41", "3.0.0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newNativeUpdateFixture(t, test.current, test.latest, updatepkg.ChannelLatest)
			if err := runUpdateWithDeps(context.Background(), nil, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, fixture.deps); err != nil {
				t.Fatal(err)
			}
			if fixture.resolved != 1 || fixture.downloaded != 1 {
				t.Fatalf("resolve=%d download=%d", fixture.resolved, fixture.downloaded)
			}
		})
	}
}

func TestUpdateRejectsUnpackagedExecutableBeforeResolver(t *testing.T) {
	fixture := newNativeUpdateFixture(t, "2.7.41", "2.8.0", updatepkg.ChannelLatest)
	fixture.deps.executable = func() (string, error) { return filepath.Join(t.TempDir(), "ocx"), nil }
	if err := runUpdateWithDeps(context.Background(), nil, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, fixture.deps); err == nil {
		t.Fatal("unpackaged executable accepted")
	}
	if fixture.resolved != 0 || fixture.downloaded != 0 {
		t.Fatalf("resolve=%d download=%d", fixture.resolved, fixture.downloaded)
	}
}

func TestUpdateRejectsMalformedCurrentVersionBeforeResolver(t *testing.T) {
	fixture := newNativeUpdateFixture(t, "2.7.41", "2.8.0", updatepkg.ChannelLatest)
	fixture.deps.version = "development"
	if err := runUpdateWithDeps(context.Background(), nil, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, fixture.deps); err == nil {
		t.Fatal("malformed current version accepted")
	}
	if fixture.resolved != 0 || fixture.downloaded != 0 {
		t.Fatalf("resolve=%d download=%d", fixture.resolved, fixture.downloaded)
	}
}

func TestUpdateWindowsReturnsExactNPMGuidanceBeforeNetwork(t *testing.T) {
	fixture := newNativeUpdateFixture(t, "2.7.41-preview.1", "2.7.41-preview.2", updatepkg.ChannelPreview)
	fixture.deps.goos = "windows"
	fixture.deps.executable = func() (string, error) { return "", errors.New("must not inspect") }
	err := runUpdateWithDeps(context.Background(), nil, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, fixture.deps)
	if err == nil || err.Error() != "native self-update is unavailable on Windows; run: npm install -g @bitkyc08/opencodex@preview" {
		t.Fatalf("err=%v", err)
	}
	if fixture.resolved != 0 || fixture.downloaded != 0 {
		t.Fatalf("resolve=%d download=%d", fixture.resolved, fixture.downloaded)
	}
}

func TestUpdatePublicSurfaceRejectsRawUpdaterFlags(t *testing.T) {
	for _, args := range [][]string{{"update", "--url", "https://example.com/ocx"}, {"update", "--sha256", strings.Repeat("a", 64)}, {"update", "--destination", "/tmp/ocx"}} {
		var output bytes.Buffer
		if code := Run(context.Background(), args, IO{Out: &output, Err: &output}); code == 0 || !strings.Contains(output.String(), "flag provided but not defined") {
			t.Fatalf("args=%v code=%d output=%q", args, code, output.String())
		}
	}
}

func TestUpdateHelpShowsBoundedSurface(t *testing.T) {
	var output bytes.Buffer
	if err := PrintHelp(&output, "update"); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if !strings.Contains(text, "ocx update [--tag latest|preview] [--dry-run]") || strings.Contains(text, "--url") || strings.Contains(text, "--destination") {
		t.Fatalf("help=%q", text)
	}
}
