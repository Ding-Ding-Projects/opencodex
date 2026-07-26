package grok

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func FuzzGrokConfigPreservesUserData(f *testing.F) {
	managed := BeginMarker + "\n[model.ocx-old]\nmodel = \"old\"\n" + EndMarker + "\n"
	for _, seed := range [][]byte{
		[]byte("theme = \"dark\"\n" + managed + "[user]\nkeep = true\n"),
		[]byte("this = [is broken TOML\n[user]\nkeep = true"),
		[]byte(BeginMarker + "\nuser = \"must survive\"\n" + BeginMarker + "\n" + EndMarker + "\n" + EndMarker),
		[]byte("prefix\n" + BeginMarker + "\nuser = \"must survive\"\n"),
		[]byte("message = \"" + BeginMarker + " user bytes " + EndMarker + "\"\n"),
		[]byte("first = true\r\nsecond = [broken\nthird = \"keep\"\r\n"),
		{0xff, 0xfe, 0x00, 'x', '\n', '[', 'u', 's', 'e', 'r', ']', '\n'},
	} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, original []byte) {
		if len(original) > 2<<20 {
			t.Skip()
		}
		baselineHome := tempGrokHome(t)
		mutatedHome := tempGrokHome(t)
		baselinePath := filepath.Join(baselineHome, "config.toml")
		mutatedPath := filepath.Join(mutatedHome, "config.toml")
		if err := os.WriteFile(baselinePath, original, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(mutatedPath, original, 0o600); err != nil {
			t.Fatal(err)
		}

		region := findManagedRegion(string(original))
		ambiguous := region != nil && region.orphaned
		if ambiguous {
			for action, result := range map[string]Result{
				"inject": InjectGrokConfig(10100, []InjectModel{{ID: "new"}}, Options{GrokHome: mutatedHome}),
				"strip":  StripGrokConfig(Options{GrokHome: baselineHome}),
			} {
				if result.OK || result.Changed || result.SkippedReason != SkipOrphanedMarker {
					t.Fatalf("%s changed ambiguous marker topology: %#v", action, result)
				}
			}
			assertFileBytes(t, baselinePath, original)
			assertFileBytes(t, mutatedPath, original)
			return
		}

		baseline := StripGrokConfig(Options{GrokHome: baselineHome})
		if !baseline.OK {
			t.Fatalf("baseline strip refused valid topology: %#v", baseline)
		}
		injected := InjectGrokConfig(10100, []InjectModel{{ID: "new"}}, Options{GrokHome: mutatedHome})
		if !injected.OK {
			t.Fatalf("inject refused valid topology: %#v", injected)
		}
		stripped := StripGrokConfig(Options{GrokHome: mutatedHome})
		if !stripped.OK {
			t.Fatalf("strip after inject failed: %#v", stripped)
		}
		want, err := os.ReadFile(baselinePath)
		if err != nil {
			t.Fatal(err)
		}
		assertFileBytes(t, mutatedPath, want)
	})
}

func TestVeryLargeConfigRoundTripsWithoutLoss(t *testing.T) {
	home := tempGrokHome(t)
	path := filepath.Join(home, "config.toml")
	original := []byte(strings.Repeat("# retained user data 0123456789abcdef\n", 120000))
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if result := InjectGrokConfig(10100, []InjectModel{{ID: "large"}}, Options{GrokHome: home}); !result.OK {
		t.Fatal(result.Message)
	}
	if result := StripGrokConfig(Options{GrokHome: home}); !result.OK {
		t.Fatal(result.Message)
	}
	assertFileBytes(t, path, original)
}

func assertFileBytes(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("file bytes changed: got len=%d prefix=%q, want len=%d prefix=%q", len(got), bytePrefix(got), len(want), bytePrefix(want))
	}
}

func bytePrefix(value []byte) []byte {
	if len(value) > 128 {
		return value[:128]
	}
	return value
}
