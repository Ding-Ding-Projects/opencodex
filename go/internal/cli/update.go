package cli

import (
	"context"
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/tray"
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
		var trayManager tray.Manager
		if runtime.GOOS == "windows" {
			cfg, _, err := loadConfig()
			if err != nil {
				return err
			}
			trayManager, err = tray.New(trayConfig(*cfg))
			if err != nil {
				return fmt.Errorf("prepare Windows tray update: %w", err)
			}
		}
		output, err := executePackageUpdate(ctx, updatepkg.ExecRunner{}, command, trayManager)
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

func executePackageUpdate(ctx context.Context, runner updatepkg.CommandRunner, command updatepkg.Command, trayManager tray.Manager) ([]byte, error) {
	var handoff tray.Handoff
	var err error
	if trayManager != nil {
		handoff, err = trayManager.PrepareUpdate(ctx)
		if err != nil {
			return nil, fmt.Errorf("stop Windows tray before update: %w", err)
		}
	}
	output, runErr := runner.Run(ctx, command)
	if trayManager != nil {
		if _, completeErr := trayManager.CompleteUpdate(ctx, handoff); completeErr != nil {
			if runErr != nil {
				return output, fmt.Errorf("%v; restore Windows tray after failed update: %w", runErr, completeErr)
			}
			return output, fmt.Errorf("refresh Windows tray after update: %w", completeErr)
		}
	}
	return output, runErr
}
