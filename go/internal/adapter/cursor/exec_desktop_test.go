package cursor

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDesktopExecutorMapsSuccessErrorAndRecordFlags(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture uses a POSIX shell script")
	}
	success := desktopScript(t, `#!/bin/sh
cat >/dev/null
printf '{"screenshot":"shot","durationMs":12,"log":"%s"}' "$DESKTOP_TEST"
`)
	executor := DesktopExecutor{Config: DesktopExecutorConfig{
		ComputerUseCommand: success, Env: map[string]string{"DESKTOP_TEST": "override"},
	}}
	result, err := executor.ComputerUse(context.Background(), ComputerUseRequest{Actions: []map[string]any{{"type": "click"}, {"type": "type"}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Screenshot != "shot" || result.DurationMS != 12 || result.ActionCount != 2 || result.Log != "override" {
		t.Fatalf("computer-use result = %#v", result)
	}

	failure := desktopScript(t, "#!/bin/sh\ncat >/dev/null\nprintf '{\"error\":\"denied\"}'\n")
	executor.Config.ComputerUseCommand = failure
	if _, err := executor.ComputerUse(context.Background(), ComputerUseRequest{}); err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("computer-use error = %v", err)
	}

	record := desktopScript(t, "#!/bin/sh\ncat >/dev/null\nprintf '{\"startSuccess\":{\"wasPriorRecordingCancelled\":true,\"wasSaveAsFilenameIgnored\":true}}'\n")
	executor.Config.RecordScreenCommand = record
	recorded, err := executor.RecordScreen(context.Background(), RecordScreenRequest{Mode: "start"})
	if err != nil {
		t.Fatal(err)
	}
	if recorded.Kind != "start" || !recorded.PriorRecordingCancelled || !recorded.SaveAsFilenameIgnored {
		t.Fatalf("record-screen result = %#v", recorded)
	}
}

func desktopScript(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "desktop-executor.sh")
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}
