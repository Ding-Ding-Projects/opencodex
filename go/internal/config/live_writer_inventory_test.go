package config

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestLongLivedConfigWritersUseSharedPersistence(t *testing.T) {
	root := filepath.Clean("..")
	writers := []string{
		"management/api.go",
		"management/claude_desktop.go",
		"cli/codex_auth_management.go",
		"cli/serve.go",
		"server/server.go",
	}
	bareSave := regexp.MustCompile(`\bconfig\.Save\s*\(`)
	for _, relative := range writers {
		data, err := os.ReadFile(filepath.Join(root, relative))
		if err != nil {
			t.Fatal(err)
		}
		if bareSave.Match(data) {
			t.Errorf("long-lived writer %s still calls config.Save directly", relative)
		}
	}
	serve, err := os.ReadFile(filepath.Join(root, "cli", "serve.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []*regexp.Regexp{
		regexp.MustCompile(`NewLivePersistence\s*\(`),
		regexp.MustCompile(`newCodexAuthManagement\([^\n]+configPersistence\)`),
		regexp.MustCompile(`ConfigPersistence:\s*configPersistence`),
		regexp.MustCompile(`configPersistence\.Update\s*\(`),
	} {
		if !required.Match(serve) {
			t.Errorf("serve composition missing %s", required)
		}
	}
}
