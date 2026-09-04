package grok

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStripRestoresOriginalBytes(t *testing.T) {
	originals := map[string]string{
		"no trailing newline":     `theme = "dark"`,
		"one trailing newline":    "theme = \"dark\"\n",
		"two trailing newlines":   "theme = \"dark\"\n\n",
		"three trailing newlines": "theme = \"dark\"\n\n\n",
		"uniform CRLF":            "theme = \"dark\"\r\n[a]\r\nx = 1\r\n",
	}
	for name, original := range originals {
		t.Run(name, func(t *testing.T) {
			home := tempGrokHome(t)
			path := filepath.Join(home, "config.toml")
			mustWrite(t, path, original)

			injected := InjectGrokConfig(10100, []InjectModel{{ID: "gpt-5.6-sol"}}, Options{GrokHome: home})
			if !injected.OK || !injected.Changed {
				t.Fatalf("InjectGrokConfig() = %#v", injected)
			}
			stripped := StripGrokConfig(Options{GrokHome: home})
			if !stripped.OK || !stripped.Changed {
				t.Fatalf("StripGrokConfig() = %#v", stripped)
			}
			if got := mustRead(t, path); got != original {
				t.Fatalf("restored bytes = %q, want %q", got, original)
			}
		})
	}
}

func TestUserAliasesAreReservedAcrossEquivalentHeaders(t *testing.T) {
	spellings := map[string]string{
		"quoted":            `[model."ocx-mine"]`,
		"whitespace padded": `[ model . ocx-mine ]`,
		"literal strings":   `['model'.'ocx-mine']`,
		"escaped segments":  `["\u006Dodel"."\U0000006Fcx-mine"]`,
	}
	for name, header := range spellings {
		t.Run(name, func(t *testing.T) {
			home := tempGrokHome(t)
			path := filepath.Join(home, "config.toml")
			mustWrite(t, path, header+"\nmodel = \"user/keeps-this\"\n")

			result := InjectGrokConfig(10100, []InjectModel{{ID: "mine"}}, Options{GrokHome: home})
			if !result.OK {
				t.Fatalf("InjectGrokConfig() = %#v", result)
			}
			managed := mustRead(t, path)
			managed = managed[strings.Index(managed, BeginMarker):]
			if !strings.Contains(managed, "[model.ocx-mine-2]") || strings.Contains(managed, "[model.ocx-mine]\n") {
				t.Fatalf("managed block did not reserve user alias:\n%s", managed)
			}
		})
	}
}

func TestArrayAndSubtableHeadersReserveTheUserNamespace(t *testing.T) {
	for name, header := range map[string]string{
		"array of tables":  "[[model.ocx-mine]]",
		"subtable":         "[model.ocx-mine.extra]",
		"trailing comment": `[model.'ocx-mine'] # user owned`,
	} {
		t.Run(name, func(t *testing.T) {
			home := tempGrokHome(t)
			path := filepath.Join(home, "config.toml")
			mustWrite(t, path, header+"\nvalue = true\n")
			result := InjectGrokConfig(10100, []InjectModel{{ID: "mine"}}, Options{GrokHome: home})
			if !result.OK || !strings.Contains(mustRead(t, path), "[model.ocx-mine-2]") {
				t.Fatalf("InjectGrokConfig() = %#v, header %q was not reserved", result, header)
			}
		})
	}
}

func TestUnclosedHeaderInsideMultilineStringDoesNotHideRealAlias(t *testing.T) {
	home := tempGrokHome(t)
	path := filepath.Join(home, "config.toml")
	mustWrite(t, path, "prompt = \"\"\"\n[model.a.b\n\"\"\"\n\n[model.ocx-mine]\nmodel = \"user/keeps-this\"\n")

	result := InjectGrokConfig(10100, []InjectModel{{ID: "mine"}}, Options{GrokHome: home})
	if !result.OK {
		t.Fatal(result.Message)
	}
	content := mustRead(t, path)
	managed := content[strings.Index(content, BeginMarker):]
	if !strings.Contains(managed, "[model.ocx-mine-2]") {
		t.Fatalf("real user alias was hidden by multiline content:\n%s", content)
	}
}

func TestNonLoopbackRegistrationIsRefused(t *testing.T) {
	for _, hostname := range []string{"0.0.0.0", "::", "[::]", "192.168.1.10", "proxy.lan"} {
		t.Run(hostname, func(t *testing.T) {
			home := tempGrokHome(t)
			result := InjectGrokConfig(10100, []InjectModel{{ID: "gpt-5.6-sol"}}, Options{GrokHome: home, Hostname: hostname})
			if !result.OK || result.Changed || result.SkippedReason != SkipNonLoopback {
				t.Fatalf("InjectGrokConfig() = %#v", result)
			}
			if _, err := os.Stat(filepath.Join(home, "config.toml")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("config.toml exists after refusal: %v", err)
			}
		})
	}
}

func TestAtomicWriteFailureLeavesOriginalConfig(t *testing.T) {
	home := tempGrokHome(t)
	path := filepath.Join(home, "config.toml")
	original := "theme = \"dark\"\n"
	mustWrite(t, path, original)

	previous := replaceFile
	replaceFile = func(_, _ string) error { return errors.New("injected replace failure") }
	t.Cleanup(func() { replaceFile = previous })

	result := InjectGrokConfig(10100, []InjectModel{{ID: "gpt-5.6-sol"}}, Options{GrokHome: home})
	if result.OK || result.Changed || !strings.Contains(result.Message, "injected replace failure") {
		t.Fatalf("InjectGrokConfig() = %#v", result)
	}
	if got := mustRead(t, path); got != original {
		t.Fatalf("config after failed replacement = %q, want %q", got, original)
	}
	matches, err := filepath.Glob(filepath.Join(home, ".ocx-*"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("temporary files after failure = %v, %v", matches, err)
	}
}

func TestOrphanedBeginMarkerRefusesMutation(t *testing.T) {
	home := tempGrokHome(t)
	path := filepath.Join(home, "config.toml")
	damaged := "theme = \"dark\"\n" + BeginMarker + "\n[model.user]\nmodel = \"keep/me\"\n"
	mustWrite(t, path, damaged)

	for name, result := range map[string]Result{
		"inject": InjectGrokConfig(10100, []InjectModel{{ID: "x"}}, Options{GrokHome: home}),
		"strip":  StripGrokConfig(Options{GrokHome: home}),
	} {
		if result.OK || result.Changed || result.SkippedReason != SkipOrphanedMarker {
			t.Fatalf("%s result = %#v", name, result)
		}
		if got := mustRead(t, path); got != damaged {
			t.Fatalf("%s changed damaged config to %q", name, got)
		}
	}
}

func TestManagedBlockUsesDirectChatCompletionsFields(t *testing.T) {
	block := BuildGrokManagedBlock(10190, []InjectModel{{ID: "cursor/grok-4.5", ContextWindow: 500000}}, "::1", nil, nil)
	for _, expected := range []string{
		`[model.ocx-cursor-grok-4-5]`,
		`base_url = "http://[::1]:10190/v1"`,
		`api_backend = "chat_completions"`,
		`api_key = "opencodex-loopback"`,
		`context_window = 500000`,
	} {
		if !strings.Contains(block, expected) {
			t.Errorf("managed block missing %q:\n%s", expected, block)
		}
	}
	if strings.Contains(block, "model_providers") || strings.Contains(block, "env_key") {
		t.Fatalf("managed block contains unsafe provider inheritance:\n%s", block)
	}
	wantOrder := "name = \"OCX cursor/grok-4.5\"\n" +
		`extra_headers = { "x-opencodex-grok" = "1" }` + "\n" +
		"context_window = 500000"
	if !strings.Contains(block, wantOrder) {
		t.Fatalf("managed block attribution header ordering differs:\n%s", block)
	}
}

func TestManagedBlockExclusionKeepsCollidingAliasesStable(t *testing.T) {
	models := []InjectModel{
		{ID: "vendor/model"},
		{ID: "vendor.model"},
		{ID: "vendor-model"},
	}
	full := BuildGrokManagedBlock(10100, models, "", nil, nil)
	excluded := BuildGrokManagedBlock(10100, models, "", nil, map[string]struct{}{"vendor.model": {}})

	for _, alias := range []string{"ocx-vendor-model", "ocx-vendor-model-2", "ocx-vendor-model-3"} {
		if !strings.Contains(full, "[model."+alias+"]") {
			t.Fatalf("full block missing alias %q:\n%s", alias, full)
		}
	}
	if strings.Contains(excluded, `model = "vendor.model"`) || strings.Contains(excluded, "[model.ocx-vendor-model-2]") {
		t.Fatalf("excluded model was emitted:\n%s", excluded)
	}
	if !strings.Contains(excluded, "[model.ocx-vendor-model-3]\nmodel = \"vendor-model\"") {
		t.Fatalf("model after exclusion changed alias:\n%s", excluded)
	}
}

func TestEmptyExclusionProducesIdenticalManagedBlock(t *testing.T) {
	models := []InjectModel{{ID: "first"}, {ID: "second", ContextWindow: 200000}}
	absent := BuildGrokManagedBlock(10100, models, "localhost", nil, nil)
	empty := BuildGrokManagedBlock(10100, models, "localhost", nil, map[string]struct{}{})
	if empty != absent {
		t.Fatalf("empty exclusion changed managed bytes:\nabsent=%q\nempty=%q", absent, empty)
	}
}

func TestBackupIsExclusiveAndConfigUsesPrivatePermissions(t *testing.T) {
	home := tempGrokHome(t)
	path := filepath.Join(home, "config.toml")
	backup := filepath.Join(home, "config.toml.bak-opencodex")
	mustWrite(t, path, "theme = \"dark\"\n")
	if result := InjectGrokConfig(10100, []InjectModel{{ID: "first"}}, Options{GrokHome: home}); !result.OK {
		t.Fatal(result.Message)
	}
	mustWrite(t, backup, "backup-must-survive\n")
	if result := InjectGrokConfig(10100, []InjectModel{{ID: "second"}}, Options{GrokHome: home}); !result.OK {
		t.Fatal(result.Message)
	}
	if got := mustRead(t, backup); got != "backup-must-survive\n" {
		t.Fatalf("backup was overwritten: %q", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %v; want 0600", info.Mode().Perm())
	}
}

func TestRepeatedCyclesAndUserTailDoNotDrift(t *testing.T) {
	home := tempGrokHome(t)
	path := filepath.Join(home, "config.toml")
	original := "[a]\nx = 1\n\n[b]\ny = 2"
	mustWrite(t, path, original)
	for range 5 {
		if result := InjectGrokConfig(10100, []InjectModel{{ID: "gpt-5.6-sol"}}, Options{GrokHome: home}); !result.OK {
			t.Fatal(result.Message)
		}
		if result := StripGrokConfig(Options{GrokHome: home}); !result.OK {
			t.Fatal(result.Message)
		}
		if got := mustRead(t, path); got != original {
			t.Fatalf("config drifted to %q, want %q", got, original)
		}
	}

	mustWrite(t, path, "theme = \"dark\"\n")
	InjectGrokConfig(10100, []InjectModel{{ID: "gpt-5.6-sol"}}, Options{GrokHome: home})
	mustWrite(t, path, mustRead(t, path)+"\n[mine]\nkeep = true\n")
	if result := StripGrokConfig(Options{GrokHome: home}); !result.OK {
		t.Fatal(result.Message)
	}
	if got, want := mustRead(t, path), "theme = \"dark\"\n\n[mine]\nkeep = true\n"; got != want {
		t.Fatalf("user tail = %q, want %q", got, want)
	}
}

func tempGrokHome(t *testing.T) string {
	t.Helper()
	home := filepath.Join(t.TempDir(), ".grok")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	return home
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
