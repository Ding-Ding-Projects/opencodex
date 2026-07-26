//go:build windows

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/tray"
)

func TestRunTrayActivatesConcreteWindowsStatusLifecycle(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("OPENCODEX_HOME", filepath.Join(home, "ocx"))
	cfg := config.FreshInstall()
	path, err := configPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runTray(context.Background(), []string{"status", "--json"}, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	var status tray.Status
	if err := json.Unmarshal(output.Bytes(), &status); err != nil {
		t.Fatalf("decode concrete Windows tray status %q: %v", output.String(), err)
	}
	if !status.Supported || status.Installed || status.Running {
		t.Fatalf("unexpected concrete Windows tray status: %#v", status)
	}
	if _, err := os.Stat(filepath.Join(home, "ocx", "tray")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
}
