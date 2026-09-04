package update

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGoJobStoreRoundTripsThroughActualTypeScriptWriter(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Fatalf("pinned Bun is required for the cross-runtime update-job contract: %v", err)
	}
	home := t.TempDir()
	store := &JobStore{Path: filepath.Join(home, "update-job.json")}
	job := Job{
		ID: "424242", Status: JobRunning, StartedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		CurrentVersion: "2.7.41", LatestVersion: "2.7.42", Channel: ChannelLatest,
		Installer: InstallerNPM, Restart: true, Command: "node ocx.mjs update", Log: []string{"queued by Go"},
	}
	if err := store.Write(job); err != nil {
		t.Fatal(err)
	}
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	moduleURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(filepath.Join(repoRoot, "src", "update", "job.ts"))}).String()
	scriptPath := filepath.Join(t.TempDir(), "mutate-job.ts")
	script := fmt.Sprintf(
		"const mod = await import(%q); mod.transitionUpdateJobForTests(%q, { status: %q, restarted: true }, %q);\n",
		moduleURL, job.ID, string(JobSucceeded), "terminalized by TypeScript",
	)
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	readErrors := make(chan error, 1)
	var readers sync.WaitGroup
	for range 4 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
					if _, err := store.Read(); err != nil {
						select {
						case readErrors <- err:
						default:
						}
						return
					}
				}
			}
		}()
	}
	command := exec.Command(bun, scriptPath)
	command.Env = make([]string, 0, len(os.Environ())+1)
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "OPENCODEX_HOME=") {
			command.Env = append(command.Env, item)
		}
	}
	command.Env = append(command.Env, "OPENCODEX_HOME="+home)
	output, runErr := command.CombinedOutput()
	close(stop)
	readers.Wait()
	if runErr != nil {
		t.Fatalf("actual TS writer failed: %v\n%s", runErr, output)
	}
	select {
	case readErr := <-readErrors:
		t.Fatalf("Go reader observed partial TS replacement: %v", readErr)
	default:
	}
	terminal, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if terminal.ID != job.ID || terminal.Status != JobSucceeded || !terminal.Restarted || terminal.Error != "" {
		t.Fatalf("terminal job = %#v", terminal)
	}
	if len(terminal.Log) != 2 || terminal.Log[1] != "terminalized by TypeScript" {
		t.Fatalf("terminal log = %#v", terminal.Log)
	}
}
