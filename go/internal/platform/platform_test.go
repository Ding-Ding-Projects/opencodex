package platform

import (
	"bytes"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadServiceTokenPrefersEnvironmentAndTrimsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(" file-token \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	token, err := LoadServiceToken("env-token", path)
	if err != nil || token != "env-token" {
		t.Fatalf("environment token: token=%q err=%v", token, err)
	}
	token, err = LoadServiceToken("", path)
	if err != nil || token != "file-token" {
		t.Fatalf("file token: token=%q err=%v", token, err)
	}
}

func TestLoadServiceTokenRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, make([]byte, MaxServiceTokenBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadServiceToken("", path); err == nil {
		t.Fatal("expected oversized token file rejection")
	}
}

func TestReplaceFromReaderVerifiesDigestBeforeReplacement(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "ocx")
	if err := os.WriteFile(destination, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	payload := []byte("new-binary")
	digest := sha256.Sum256(payload)
	snapshot, err := SnapshotUpdateDestination(destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := replaceFromReader(bytes.NewReader(payload), digest[:], snapshot); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(updated, payload) {
		t.Fatalf("replacement=%q", updated)
	}
	wrong := sha256.Sum256([]byte("different"))
	snapshot, err = SnapshotUpdateDestination(destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := replaceFromReader(bytes.NewReader([]byte("bad")), wrong[:], snapshot); err == nil {
		t.Fatal("expected digest mismatch")
	}
	unchanged, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(unchanged, payload) {
		t.Fatalf("digest failure changed destination: %q", unchanged)
	}
}

func TestReplaceFromReaderPreservesMode(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Unix permission contract")
	}
	destination := filepath.Join(t.TempDir(), "ocx")
	if err := os.WriteFile(destination, []byte("old"), 0o751); err != nil {
		t.Fatal(err)
	}
	snapshot, err := SnapshotUpdateDestination(destination)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("new")
	digest := sha256.Sum256(payload)
	if err := replaceFromReader(bytes.NewReader(payload), digest[:], snapshot); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(destination)
	if err != nil || info.Mode().Perm() != 0o751 {
		t.Fatalf("mode=%v err=%v", info.Mode().Perm(), err)
	}
}

func TestReplaceFromReaderRejectsDestinationRaces(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Unix replacement race contract")
	}
	mutations := map[string]func(*testing.T, string){
		"replacement": func(t *testing.T, path string) {
			t.Helper()
			replacement := path + ".new"
			if err := os.WriteFile(replacement, []byte("old"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacement, path); err != nil {
				t.Fatal(err)
			}
		},
		"mode": func(t *testing.T, path string) {
			t.Helper()
			if err := os.Chmod(path, 0o700); err != nil {
				t.Fatal(err)
			}
		},
		"size": func(t *testing.T, path string) {
			t.Helper()
			if err := os.WriteFile(path, []byte("old-expanded"), 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"mtime": func(t *testing.T, path string) {
			t.Helper()
			changed := time.Now().Add(2 * time.Hour)
			if err := os.Chtimes(path, changed, changed); err != nil {
				t.Fatal(err)
			}
		},
		"symlink": func(t *testing.T, path string) {
			t.Helper()
			target := path + ".target"
			if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Skipf("symlink unavailable: %v", err)
			}
		},
	}
	for name, mutate := range mutations {
		t.Run(name+" during download", func(t *testing.T) {
			destination := newUpdateDestination(t)
			snapshot, _ := SnapshotUpdateDestination(destination)
			payload := []byte("new-binary")
			digest := sha256.Sum256(payload)
			reader := &callbackReader{reader: strings.NewReader(string(payload)), callback: func() { mutate(t, destination) }}
			if err := replaceFromReader(reader, digest[:], snapshot); err == nil {
				t.Fatal("destination race accepted")
			}
			assertNotUpdated(t, destination, payload)
		})
		t.Run(name+" before rename", func(t *testing.T) {
			destination := newUpdateDestination(t)
			snapshot, _ := SnapshotUpdateDestination(destination)
			payload := []byte("new-binary")
			digest := sha256.Sum256(payload)
			beforeUpdateReplace = func() { mutate(t, destination) }
			t.Cleanup(func() { beforeUpdateReplace = nil })
			if err := replaceFromReader(bytes.NewReader(payload), digest[:], snapshot); err == nil {
				t.Fatal("destination race accepted")
			}
			beforeUpdateReplace = nil
			assertNotUpdated(t, destination, payload)
		})
	}
}

type callbackReader struct {
	reader   io.Reader
	callback func()
	done     bool
}

func (reader *callbackReader) Read(buffer []byte) (int, error) {
	n, err := reader.reader.Read(buffer)
	if !reader.done {
		reader.done = true
		reader.callback()
	}
	return n, err
}

func newUpdateDestination(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ocx")
	if err := os.WriteFile(path, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertNotUpdated(t *testing.T, path string, payload []byte) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err == nil && bytes.Equal(data, payload) {
		t.Fatal("race replaced destination")
	}
}

func TestOpenURLRejectsNonHTTPURL(t *testing.T) {
	if err := OpenURL("file:///tmp/secret"); err == nil {
		t.Fatal("expected URL scheme rejection")
	}
}
