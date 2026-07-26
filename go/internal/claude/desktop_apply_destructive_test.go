package claude

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
)

func TestDesktopApplyCorruptMetadataPreservesEveryOriginalByte(t *testing.T) {
	dir := t.TempDir()
	metadataPath := filepath.Join(dir, "_meta.json")
	configPath := filepath.Join(dir, "existing.json")
	corruptMetadata := []byte(`{"entries":[`)
	originalConfig := []byte("existing config must survive\n")
	if err := os.WriteFile(metadataPath, corruptMetadata, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, originalConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ApplyDesktop3pConfig(dir, 10100, nil, nil, "ocx", Desktop3pStatic, nil); err == nil {
		t.Fatal("corrupt metadata was accepted")
	}
	assertFileBytes(t, metadataPath, corruptMetadata)
	assertFileBytes(t, configPath, originalConfig)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("failed apply created files: %#v", entries)
	}
}

func TestDesktopApplyWriteFailuresPreserveAppliedConfigAndMetadata(t *testing.T) {
	for _, scenario := range []struct {
		name string
		err  error
	}{
		{name: "permission-denied", err: fs.ErrPermission},
		{name: "disk-full", err: syscall.ENOSPC},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			dir := t.TempDir()
			applied, err := ApplyDesktop3pConfig(dir, 10100, nil, nil, "ocx", Desktop3pStatic, nil)
			if err != nil {
				t.Fatal(err)
			}
			metadataPath := filepath.Join(dir, "_meta.json")
			originalConfig := mustReadFile(t, applied.Path)
			originalMetadata := mustReadFile(t, metadataPath)
			writer := func(string, []byte, os.FileMode) error { return scenario.err }
			_, err = applyDesktop3pConfig(dir, 10101, nil, nil, "ocx", Desktop3pStatic, nil, writer)
			if !errors.Is(err, scenario.err) {
				t.Fatalf("apply error = %v, want %v", err, scenario.err)
			}
			assertFileBytes(t, applied.Path, originalConfig)
			assertFileBytes(t, metadataPath, originalMetadata)
		})
	}
}

func TestDesktopApplyConcurrentCallsConvergeWithoutDataLoss(t *testing.T) {
	dir := t.TempDir()
	const callers = 24
	results := make([]Desktop3pApplyResult, callers)
	errorsByCall := make([]error, callers)
	var wait sync.WaitGroup
	wait.Add(callers)
	for index := range callers {
		go func() {
			defer wait.Done()
			results[index], errorsByCall[index] = ApplyDesktop3pConfig(
				dir,
				10100,
				[]string{"gpt-5.6"},
				[]Desktop3pRoutedModel{{Provider: "openrouter", ID: "model", ContextWindow: OneMillion}},
				"ocx",
				Desktop3pStatic,
				nil,
			)
		}()
	}
	wait.Wait()
	written := 0
	path := results[0].Path
	fingerprint := results[0].Fingerprint
	for index := range callers {
		if errorsByCall[index] != nil {
			t.Fatalf("call %d: %v", index, errorsByCall[index])
		}
		if results[index].Written {
			written++
		}
		if results[index].Path != path || results[index].Fingerprint != fingerprint {
			t.Fatalf("call %d diverged: %#v", index, results[index])
		}
	}
	if written != 1 {
		t.Fatalf("written calls = %d, want 1", written)
	}
	configData := mustReadFile(t, path)
	if Desktop3pFingerprint(configData) != fingerprint {
		t.Fatalf("config fingerprint changed: %q", configData)
	}
	metadataData := mustReadFile(t, filepath.Join(dir, "_meta.json"))
	if bytes.Count(metadataData, []byte(`"name": "opencodex"`)) != 1 {
		t.Fatalf("metadata did not converge: %s", metadataData)
	}
	if _, err := DecodeDesktop3pConfig(configData); err != nil {
		t.Fatalf("final config is invalid: %v", err)
	}
}

func assertFileBytes(t *testing.T, path string, want []byte) {
	t.Helper()
	if got := mustReadFile(t, path); !bytes.Equal(got, want) {
		t.Fatalf("%s changed\ngot:  %q\nwant: %q", path, got, want)
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
