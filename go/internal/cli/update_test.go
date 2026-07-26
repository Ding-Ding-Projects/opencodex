package cli

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/tray"
	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

type failingUpdateRunner struct{}

func (failingUpdateRunner) Run(context.Context, updatepkg.Command) ([]byte, error) {
	return []byte("partial output"), errors.New("replacement failed")
}

func TestUpdateTagDryRunPlansPackageManagerCommand(t *testing.T) {
	for _, test := range []struct{ installer, tag, want string }{
		{"npm", "latest", "npm install -g @bitkyc08/opencodex@latest"},
		{"bun", "preview", "bun add -g @bitkyc08/opencodex@preview"},
	} {
		t.Run(test.installer+"-"+test.tag, func(t *testing.T) {
			t.Setenv("OCX_INSTALLER", test.installer)
			var output bytes.Buffer
			if err := runUpdate(context.Background(), []string{"--tag", test.tag, "--dry-run"}, IO{Out: &output, Err: &output}); err != nil {
				t.Fatal(err)
			}
			if strings.TrimSpace(output.String()) != test.want {
				t.Fatalf("plan = %q", output.String())
			}
		})
	}
}

func TestUpdateRejectsUnknownTagWithoutExecution(t *testing.T) {
	if err := runUpdate(context.Background(), []string{"--tag", "nightly", "--dry-run"}, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}); err == nil {
		t.Fatal("unknown update channel accepted")
	}
}

func TestPackageUpdateRestoresTrayAfterReplacementFailure(t *testing.T) {
	manager := &fakeTrayManager{status: tray.Status{Supported: true, Installed: true, Running: true}}
	output, err := executePackageUpdate(context.Background(), failingUpdateRunner{}, updatepkg.InstallCommand(updatepkg.InstallerNPM, updatepkg.ChannelPreview, ""), manager)
	if err == nil || !strings.Contains(err.Error(), "replacement failed") || string(output) != "partial output" {
		t.Fatalf("output=%q err=%v", output, err)
	}
	if got := strings.Join(manager.calls, ","); got != "prepare-update,complete-update" {
		t.Fatalf("tray handoff calls = %s", got)
	}
}
