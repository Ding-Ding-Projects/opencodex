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
		channel := updatepkg.Channel(strings.ToLower(strings.TrimSpace(*tag)))
		if err := updatepkg.ValidateChannel(channel); err != nil {
			return err
		}
		installer := updatepkg.Installer(strings.ToLower(strings.TrimSpace(os.Getenv("OCX_INSTALLER"))))
		if installer != updatepkg.InstallerBun && installer != updatepkg.InstallerNPM {
			executable, _ := os.Executable()
			installer = updatepkg.DetectInstaller(executable)
		}
		if installer == updatepkg.InstallerSource {
			fmt.Fprintln(streams.Out, updatepkg.ManualSourceCommand())
			return nil
		}
		command := updatepkg.InstallCommand(installer, channel, "")
		if *dryRun {
			fmt.Fprintln(streams.Out, command.String())
			return nil
		}
		output, err := (updatepkg.ExecRunner{}).Run(ctx, command)
		if len(output) > 0 {
			fmt.Fprint(streams.Out, string(output))
		}
		return err
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
	if err := platform.DownloadAndReplace(ctx, *url, *sha, *destination); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Updated %s.\n", *destination)
	return nil
}
