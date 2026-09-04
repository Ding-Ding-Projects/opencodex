// Command build-go-release produces the six supported standalone ocx binaries
// and the SHA-256 manifest consumed by the native updater.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var releaseVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-preview\.[0-9]+)?$`)

type buildTarget struct {
	GOOS   string
	GOARCH string
}

type builtArtifact struct {
	Name   string
	Digest string
}

func main() {
	version := flag.String("version", "", "release version without the leading v")
	output := flag.String("output", "dist/go", "artifact output directory, relative to repository root")
	dryRun := flag.Bool("dry-run", false, "print the build matrix without running go build")
	flag.Parse()

	cleanVersion := strings.TrimPrefix(strings.TrimSpace(*version), "v")
	if !releaseVersionPattern.MatchString(cleanVersion) {
		fatal("--version must be x.y.z or x.y.z-preview.n")
	}
	root, err := findRepositoryRoot()
	if err != nil {
		fatal(err.Error())
	}
	destination := *output
	if !filepath.IsAbs(destination) {
		destination = filepath.Join(root, destination)
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		fatal(err.Error())
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	targets := []buildTarget{
		{GOOS: "darwin", GOARCH: "amd64"},
		{GOOS: "darwin", GOARCH: "arm64"},
		{GOOS: "linux", GOARCH: "amd64"},
		{GOOS: "linux", GOARCH: "arm64"},
		{GOOS: "windows", GOARCH: "amd64"},
		{GOOS: "windows", GOARCH: "arm64"},
	}
	artifacts := make([]builtArtifact, 0, len(targets))
	for _, target := range targets {
		name := artifactName(cleanVersion, target)
		path := filepath.Join(destination, name)
		fmt.Printf("%s/%s -> %s\n", target.GOOS, target.GOARCH, path)
		if *dryRun {
			continue
		}
		if err := build(ctx, root, cleanVersion, target, path); err != nil {
			fatal(err.Error())
		}
		digest, err := fileSHA256(path)
		if err != nil {
			fatal(err.Error())
		}
		artifacts = append(artifacts, builtArtifact{Name: name, Digest: digest})
	}
	if *dryRun {
		return
	}
	sort.Slice(artifacts, func(i, j int) bool { return artifacts[i].Name < artifacts[j].Name })
	manifest := filepath.Join(destination, fmt.Sprintf("ocx_%s_checksums.txt", cleanVersion))
	if err := writeManifest(manifest, artifacts); err != nil {
		fatal(err.Error())
	}
	fmt.Printf("checksums -> %s\n", manifest)
}

func findRepositoryRoot() (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if regularFile(filepath.Join(directory, "go", "go.mod")) && regularFile(filepath.Join(directory, "package.json")) {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", fmt.Errorf("repository root containing go/go.mod was not found")
		}
		directory = parent
	}
}

func build(ctx context.Context, root, version string, target buildTarget, destination string) error {
	linker := "-s -w -X github.com/lidge-jun/opencodex-go/internal/cli.Version=" + version
	command := exec.CommandContext(ctx, "go", "build", "-trimpath", "-ldflags", linker, "-o", destination, "./cmd/ocx")
	command.Dir = filepath.Join(root, "go")
	command.Env = buildEnvironment(target)
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("build %s/%s: %w", target.GOOS, target.GOARCH, err)
	}
	return nil
}

func buildEnvironment(target buildTarget) []string {
	blocked := map[string]bool{"GOOS": true, "GOARCH": true, "CGO_ENABLED": true}
	environment := make([]string, 0, len(os.Environ())+3)
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if !blocked[strings.ToUpper(name)] {
			environment = append(environment, entry)
		}
	}
	return append(environment, "GOOS="+target.GOOS, "GOARCH="+target.GOARCH, "CGO_ENABLED=0")
}

func artifactName(version string, target buildTarget) string {
	name := fmt.Sprintf("ocx_%s_%s_%s", version, target.GOOS, target.GOARCH)
	if target.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func writeManifest(path string, artifacts []builtArtifact) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".ocx-checksums-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	for _, artifact := range artifacts {
		if _, err := fmt.Fprintf(temporary, "%s  %s\n", artifact.Digest, artifact.Name); err != nil {
			temporary.Close()
			return err
		}
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, "build-go-release:", message)
	os.Exit(1)
}
