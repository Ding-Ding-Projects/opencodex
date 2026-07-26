package cli

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/platform"
	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

var resolveNativeReleaseArtifact = func(ctx context.Context, channel updatepkg.Channel) (updatepkg.ReleaseArtifact, error) {
	resolver := updatepkg.NewGitHubReleaseResolver()
	return resolver.Resolve(ctx, channel)
}

var downloadNativeUpdate = platform.DownloadAndReplace

func runUpdate(ctx context.Context, args []string, streams IO) error {
	flags := flag.NewFlagSet("update", flag.ContinueOnError)
	flags.SetOutput(streams.Err)
	url := flags.String("url", "", "HTTPS binary URL")
	sha := flags.String("sha256", "", "expected SHA-256")
	destination := flags.String("destination", "", "binary destination")
	tag := flags.String("tag", "", "package channel: latest or preview")
	dryRun := flags.Bool("dry-run", false, "print the update command without executing it")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *tag != "" {
		if *url != "" || *sha != "" {
			return fmt.Errorf("--tag cannot be combined with --url or --sha256")
		}
		channel := updatepkg.Channel(strings.ToLower(strings.TrimSpace(*tag)))
		if err := updatepkg.ValidateChannel(channel); err != nil {
			return err
		}
		artifact, err := resolveNativeReleaseArtifact(ctx, channel)
		if err != nil {
			return fmt.Errorf("resolve %s release: %w", channel, err)
		}
		if *destination == "" {
			*destination, err = os.Executable()
			if err != nil {
				return err
			}
		}
		if strings.TrimPrefix(Version, "v") == artifact.Version {
			fmt.Fprintf(streams.Out, "Already on the latest %s release (v%s).\n", channel, artifact.Version)
			return nil
		}
		if *dryRun {
			fmt.Fprintf(streams.Out, "Native update plan:\n  Version: v%s\n  Artifact: %s\n  URL: %s\n  SHA-256: %s\n  Destination: %s\n", artifact.Version, artifact.Name, artifact.URL, artifact.SHA256, *destination)
			return nil
		}
		if err := downloadNativeUpdate(ctx, artifact.URL, artifact.SHA256, *destination); err != nil {
			return err
		}
		fmt.Fprintf(streams.Out, "Updated %s to v%s (%s).\n", *destination, artifact.Version, artifact.Name)
		return nil
	}
	if *url == "" || *sha == "" {
		return fmt.Errorf("--url and --sha256 are required")
	}
	if *destination == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		*destination = executable
	}
	if err := downloadNativeUpdate(ctx, *url, *sha, *destination); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Updated %s.\n", *destination)
	return nil
}
