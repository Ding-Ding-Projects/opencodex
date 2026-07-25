package cli

import (
	"errors"
	"strings"
	"testing"
)

func TestDetectFilesystemUsesLongestMountAndDecodesSpaces(t *testing.T) {
	mounts := "/dev/sda / ext4 rw 0 0\nC: /mnt/c drvfs rw 0 0\nD: /mnt/c/My\\040Data 9p rw 0 0\n"
	got := detectFilesystem("/mnt/c/My Data/project", mounts)
	if got.Type != "9p" || got.Mount != "/mnt/c/My Data" || !got.WindowsFS || !got.MountDrive {
		t.Fatalf("filesystem = %#v", got)
	}
}

func TestProxyEnvironmentReportsPresenceWithoutValues(t *testing.T) {
	rows := collectProxyEnvironment(map[string]string{"http_proxy": "http://user:secret@proxy.test", "NO_PROXY": "localhost"})
	if !rows[0].Present || rows[1].Present || rows[2].Present || !rows[3].Present {
		t.Fatalf("rows = %#v", rows)
	}
	for _, row := range rows {
		if strings.Contains(row.Key, "secret") {
			t.Fatalf("row leaked proxy value: %#v", row)
		}
	}
}

func TestParseAndCollectRunningProxyEnvironment(t *testing.T) {
	content := []byte("HTTP_PROXY=http://secret\x00NO_PROXY=localhost\x00BROKEN\x00")
	got := collectRunningProxyEnvironment(42, "linux", func(pid int) ([]byte, error) {
		if pid != 42 {
			t.Fatalf("pid=%d", pid)
		}
		return content, nil
	})
	if got.Status != "ok" || !got.Rows[0].Present || !got.Rows[3].Present {
		t.Fatalf("running env = %#v", got)
	}
	unavailable := collectRunningProxyEnvironment(42, "linux", func(int) ([]byte, error) { return nil, errors.New("denied") })
	if unavailable.Status != "unavailable" || !strings.Contains(unavailable.Reason, "could not read") {
		t.Fatalf("unavailable = %#v", unavailable)
	}
	nonLinux := collectRunningProxyEnvironment(42, "darwin", nil)
	if nonLinux.Status != "unavailable" || !strings.Contains(nonLinux.Reason, "Linux") {
		t.Fatalf("non-linux = %#v", nonLinux)
	}
}
