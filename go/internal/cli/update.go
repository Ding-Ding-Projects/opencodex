package cli

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/platform"
	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

type nativeUpdateDeps struct {
	resolve    func(context.Context, updatepkg.Channel) (updatepkg.ReleaseArtifact, error)
	download   func(context.Context, string, string, platform.UpdateDestination) error
	executable func() (string, error)
	goos       string
	goarch     string
	version    string
}

var resolveNativeReleaseArtifact = func(ctx context.Context, channel updatepkg.Channel) (updatepkg.ReleaseArtifact, error) {
	resolver := updatepkg.NewGitHubReleaseResolver()
	return resolver.Resolve(ctx, channel)
}

var downloadNativeUpdate = platform.DownloadAndReplace

func runUpdate(ctx context.Context, args []string, streams IO) error {
	return runUpdateWithDeps(ctx, args, streams, nativeUpdateDeps{
		resolve: resolveNativeReleaseArtifact, download: downloadNativeUpdate,
		executable: os.Executable, goos: runtime.GOOS, goarch: runtime.GOARCH, version: Version,
	})
}

func runUpdateWithDeps(ctx context.Context, args []string, streams IO, deps nativeUpdateDeps) error {
	flags := flag.NewFlagSet("update", flag.ContinueOnError)
	flags.SetOutput(streams.Err)
	tag := flags.String("tag", "", "package channel: latest or preview")
	dryRun := flags.Bool("dry-run", false, "print the update plan without executing it")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("update does not accept positional arguments")
	}
	current := strings.TrimPrefix(strings.TrimSpace(deps.version), "v")
	channel := updatepkg.DefaultChannel(current)
	if strings.TrimSpace(*tag) != "" {
		channel = updatepkg.Channel(strings.ToLower(strings.TrimSpace(*tag)))
		if err := updatepkg.ValidateChannel(channel); err != nil {
			return err
		}
		if channel != updatepkg.DefaultChannel(current) {
			return fmt.Errorf("cannot switch update channel from %s to %s", updatepkg.DefaultChannel(current), channel)
		}
	}
	// Validate the current version before any resolver or download operation.
	if _, err := updatepkg.ValidateNativeTransition(current, current, channel); err != nil {
		return err
	}
	if deps.goos == "windows" {
		return fmt.Errorf("native self-update is unavailable on Windows; run: npm install -g %s@%s", updatepkg.PackageName, channel)
	}

	executable, err := deps.executable()
	if err != nil {
		return fmt.Errorf("resolve current executable: %w", err)
	}
	if strings.TrimSpace(executable) == "" {
		return fmt.Errorf("resolve current executable: empty path")
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return err
	}
	packaged, ok := snapshotPackagedRuntime(executable, deps.goos, deps.goarch)
	if !ok {
		return fmt.Errorf("native update requires the exact package-local Go executable")
	}
	destination, err := platform.SnapshotUpdateDestination(packaged.executable.path)
	if err != nil {
		return fmt.Errorf("snapshot package-local update destination: %w", err)
	}
	if !packaged.unchanged() {
		return fmt.Errorf("package runtime changed during update validation")
	}

	artifact, err := deps.resolve(ctx, channel)
	if err != nil {
		return fmt.Errorf("resolve %s release: %w", channel, err)
	}
	newer, err := updatepkg.ValidateNativeTransition(current, artifact.Version, channel)
	if err != nil {
		return err
	}
	expectedName := updatepkg.ReleaseArtifactName(artifact.Version, deps.goos, deps.goarch)
	if artifact.Channel != channel || artifact.Name != expectedName {
		return fmt.Errorf("resolved release artifact does not match %s host target", channel)
	}
	if !newer {
		fmt.Fprintf(streams.Out, "Already on the latest %s release (v%s).\n", channel, artifact.Version)
		return nil
	}
	if *dryRun {
		fmt.Fprintf(streams.Out, "Native update plan:\n  Version: v%s\n  Artifact: %s\n  URL: %s\n  SHA-256: %s\n  Destination: %s\n", artifact.Version, artifact.Name, artifact.URL, artifact.SHA256, packaged.executable.path)
		return nil
	}
	if err := deps.download(ctx, artifact.URL, artifact.SHA256, destination); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Updated %s to v%s (%s). Package metadata remains at v%s; use npm for package-layout updates.\n", packaged.executable.path, artifact.Version, artifact.Name, packaged.version)
	return nil
}
