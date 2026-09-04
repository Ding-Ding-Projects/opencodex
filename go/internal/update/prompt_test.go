package update

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeCacheFixture(t *testing.T, latest, dismissed string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "version.json")
	cache := VersionCache{
		LatestVersion:    latest,
		LastCheckedAt:    time.Now().Add(-time.Hour),
		DismissedVersion: dismissed,
		Channel:          ChannelLatest,
	}
	data, err := json.Marshal(cache)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func promptDeps(t *testing.T, cachePath string, out *bytes.Buffer) PromptDeps {
	t.Helper()
	return PromptDeps{
		In:          strings.NewReader("2\n"),
		Out:         out,
		CachePath:   cachePath,
		Current:     "2.7.0",
		Interactive: true,
		Installer:   InstallerBun,
		Now:         time.Now,
	}
}

// The firing case. Without this the whole unit could pass while the prompt
// never renders, which is exactly the state the Go runtime shipped in.
func TestPromptFiresForANewerCachedVersion(t *testing.T) {
	var out bytes.Buffer
	MaybeShowUpdatePrompt(promptDeps(t, writeCacheFixture(t, "2.8.0", ""), &out))

	if !strings.Contains(out.String(), "Update available!") {
		t.Fatalf("prompt did not render: %q", out.String())
	}
	if !strings.Contains(out.String(), "2.7.0 -> 2.8.0") {
		t.Fatalf("prompt missing the version transition: %q", out.String())
	}
}

// Each control case is a reason the prompt must stay silent. A service run that
// prompts would block startup forever on a read nobody answers.
func TestPromptStaysSilent(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*PromptDeps)
		latest string
		dismis string
	}{
		{name: "service run", mutate: func(d *PromptDeps) { d.Service = true }, latest: "2.8.0"},
		{name: "not a terminal", mutate: func(d *PromptDeps) { d.Interactive = false }, latest: "2.8.0"},
		{name: "development build", mutate: func(d *PromptDeps) { d.Current = "0.1.0-dev" }, latest: "2.8.0"},
		{name: "unknown version", mutate: func(d *PromptDeps) { d.Current = "?" }, latest: "2.8.0"},
		{name: "already dismissed", mutate: func(*PromptDeps) {}, latest: "2.8.0", dismis: "2.8.0"},
		{name: "cache is not newer", mutate: func(*PromptDeps) {}, latest: "2.6.0"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			deps := promptDeps(t, writeCacheFixture(t, test.latest, test.dismis), &out)
			test.mutate(&deps)
			MaybeShowUpdatePrompt(deps)
			if out.Len() != 0 {
				t.Fatalf("prompt fired when it should not have: %q", out.String())
			}
		})
	}
}

// A missing cache is also the first-run yield: Go has no star prompt to defer
// to, so an absent cache carries that role.
func TestPromptStaysSilentWithoutACache(t *testing.T) {
	var out bytes.Buffer
	deps := promptDeps(t, filepath.Join(t.TempDir(), "version.json"), &out)
	MaybeShowUpdatePrompt(deps)
	if out.Len() != 0 {
		t.Fatalf("prompt fired with no cache: %q", out.String())
	}
}

// Choosing 3 has to persist, or the same version prompts again next start.
func TestDismissalPersistsAndSuppressesTheNextRun(t *testing.T) {
	path := writeCacheFixture(t, "2.8.0", "")
	var first bytes.Buffer
	deps := promptDeps(t, path, &first)
	deps.In = strings.NewReader("3\n")
	MaybeShowUpdatePrompt(deps)
	if !strings.Contains(first.String(), "Update available!") {
		t.Fatalf("first run did not prompt: %q", first.String())
	}

	cache, err := ReadVersionCache(path, ChannelLatest)
	if err != nil {
		t.Fatal(err)
	}
	if cache.DismissedVersion != "2.8.0" {
		t.Fatalf("dismissal not persisted: %+v", cache)
	}

	var second bytes.Buffer
	again := promptDeps(t, path, &second)
	MaybeShowUpdatePrompt(again)
	if second.Len() != 0 {
		t.Fatalf("dismissed version prompted again: %q", second.String())
	}
}

// A failing update must not take the start down with it.
func TestFailedUpdateDoesNotStopTheStart(t *testing.T) {
	var out bytes.Buffer
	deps := promptDeps(t, writeCacheFixture(t, "2.8.0", ""), &out)
	deps.In = strings.NewReader("1\n")
	deps.RunUpdate = func(Command) error { return os.ErrPermission }
	exited := false
	deps.Exit = func(int) { exited = true }

	MaybeShowUpdatePrompt(deps)

	if exited {
		t.Fatal("exited despite a failed update")
	}
	if !strings.Contains(out.String(), "update failed") {
		t.Fatalf("failure not surfaced: %q", out.String())
	}
}
