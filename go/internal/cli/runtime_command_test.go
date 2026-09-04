package cli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

type recordingRestartRunner struct {
	commands []updatepkg.Command
	failures int
}

func (r *recordingRestartRunner) Run(_ context.Context, command updatepkg.Command) ([]byte, error) {
	r.commands = append(r.commands, command)
	if r.failures > 0 {
		r.failures--
		return nil, errors.New("command failed")
	}
	return nil, nil
}

type packagedRuntimeFixture struct {
	root       string
	executable string
	launcher   string
	manifest   string
	node       string
	deps       runtimeCommandDeps
}

func newPackagedRuntimeFixture(t *testing.T) packagedRuntimeFixture {
	t.Helper()
	root := t.TempDir()
	nativeDir := filepath.Join(root, "bin", "native")
	if err := os.MkdirAll(nativeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	version := "2.7.41-preview.1"
	extension := ""
	if runtime.GOOS == "windows" {
		extension = ".exe"
	}
	executable := filepath.Join(nativeDir, "ocx_"+version+"_"+runtime.GOOS+"_"+runtime.GOARCH+extension)
	launcher := filepath.Join(root, "bin", "ocx.mjs")
	manifest := filepath.Join(root, "package.json")
	node := filepath.Join(root, "node")
	for path, body := range map[string]string{
		executable: "native",
		launcher:   "launcher",
		manifest:   `{"version":"` + version + `"}`,
		node:       "node",
	} {
		mode := os.FileMode(0o644)
		if path == executable || path == node {
			mode = 0o755
		}
		if err := os.WriteFile(path, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
	}
	fixture := packagedRuntimeFixture{root: root, executable: executable, launcher: launcher, manifest: manifest, node: node}
	fixture.deps = runtimeCommandDeps{
		executable: func() (string, error) { return executable, nil },
		lookPath:   func(string) (string, error) { return node, nil },
		goos:       runtime.GOOS,
		goarch:     runtime.GOARCH,
		version:    version,
	}
	return fixture
}

func TestResolveRuntimeCommandUsesStablePackageLauncher(t *testing.T) {
	fixture := newPackagedRuntimeFixture(t)
	command := resolveRuntimeCommand(fixture.deps)
	if command.Executable != evaluatedPath(t, fixture.node) || command.Launcher != fixture.launcher {
		t.Fatalf("command=%#v", command)
	}
}

func TestResolveRuntimeCommandUsesManifestNameAfterNativeSelfUpdate(t *testing.T) {
	fixture := newPackagedRuntimeFixture(t)
	fixture.deps.version = "2.7.42-preview.1"
	command := resolveRuntimeCommand(fixture.deps)
	if command.Executable != evaluatedPath(t, fixture.node) || command.Launcher != fixture.launcher {
		t.Fatalf("self-updated command=%#v", command)
	}
}

func TestResolveRuntimeCommandRejectsInvalidPackageFiles(t *testing.T) {
	tests := map[string]func(*testing.T, packagedRuntimeFixture){
		"malformed manifest": func(t *testing.T, fixture packagedRuntimeFixture) {
			if err := os.WriteFile(fixture.manifest, []byte("{"), 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"missing manifest": func(t *testing.T, fixture packagedRuntimeFixture) {
			if err := os.Remove(fixture.manifest); err != nil {
				t.Fatal(err)
			}
		},
		"missing launcher": func(t *testing.T, fixture packagedRuntimeFixture) {
			if err := os.Remove(fixture.launcher); err != nil {
				t.Fatal(err)
			}
		},
		"symlink manifest": func(t *testing.T, fixture packagedRuntimeFixture) {
			replaceWithSymlink(t, fixture.manifest)
		},
		"symlink launcher": func(t *testing.T, fixture packagedRuntimeFixture) {
			replaceWithSymlink(t, fixture.launcher)
		},
		"symlink native": func(t *testing.T, fixture packagedRuntimeFixture) {
			replaceWithSymlink(t, fixture.executable)
		},
		"wrong manifest version": func(t *testing.T, fixture packagedRuntimeFixture) {
			if err := os.WriteFile(fixture.manifest, []byte(`{"version":"9.9.9"}`), 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"padded manifest version": func(t *testing.T, fixture packagedRuntimeFixture) {
			if err := os.WriteFile(fixture.manifest, []byte(`{"version":" 2.7.41-preview.1 "}`), 0o644); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newPackagedRuntimeFixture(t)
			mutate(t, fixture)
			assertPackageRuntimeRejected(t, resolveRuntimeCommand(fixture.deps))
		})
	}
}

func TestResolveRuntimeCommandRejectsWrongTargetAndUnusableNode(t *testing.T) {
	t.Run("wrong artifact version", func(t *testing.T) {
		fixture := newPackagedRuntimeFixture(t)
		wrong := strings.Replace(fixture.executable, fixture.deps.version, "9.9.9", 1)
		if err := os.Rename(fixture.executable, wrong); err != nil {
			t.Fatal(err)
		}
		fixture.deps.executable = func() (string, error) { return wrong, nil }
		assertPackageRuntimeRejected(t, resolveRuntimeCommand(fixture.deps))
	})
	t.Run("wrong target", func(t *testing.T) {
		fixture := newPackagedRuntimeFixture(t)
		fixture.deps.goarch = "wrong-architecture"
		assertPackageRuntimeRejected(t, resolveRuntimeCommand(fixture.deps))
	})
	t.Run("empty node lookup", func(t *testing.T) {
		fixture := newPackagedRuntimeFixture(t)
		fixture.deps.lookPath = func(string) (string, error) { return "", nil }
		assertPackageRuntimeRejected(t, resolveRuntimeCommand(fixture.deps))
	})
	t.Run("failed node lookup", func(t *testing.T) {
		fixture := newPackagedRuntimeFixture(t)
		fixture.deps.lookPath = func(string) (string, error) { return "", errors.New("missing") }
		assertPackageRuntimeRejected(t, resolveRuntimeCommand(fixture.deps))
	})
	if runtime.GOOS != "windows" {
		t.Run("non executable node", func(t *testing.T) {
			fixture := newPackagedRuntimeFixture(t)
			if err := os.Chmod(fixture.node, 0o644); err != nil {
				t.Fatal(err)
			}
			assertPackageRuntimeRejected(t, resolveRuntimeCommand(fixture.deps))
		})
	}
}

func TestResolveRuntimeCommandRejectsRacedPackageFiles(t *testing.T) {
	for _, field := range []string{"native", "manifest", "launcher"} {
		t.Run(field, func(t *testing.T) {
			fixture := newPackagedRuntimeFixture(t)
			path := map[string]string{"native": fixture.executable, "manifest": fixture.manifest, "launcher": fixture.launcher}[field]
			fixture.deps.beforeRecheck = func() { replaceRuntimeFile(t, path) }
			assertPackageRuntimeRejected(t, resolveRuntimeCommand(fixture.deps))
		})
	}
}

func TestResolveRuntimeCommandDirectGoFallback(t *testing.T) {
	direct := filepath.Join(t.TempDir(), "ocx-direct")
	if err := os.WriteFile(direct, []byte("go"), 0o755); err != nil {
		t.Fatal(err)
	}
	command := resolveRuntimeCommand(runtimeCommandDeps{
		executable: func() (string, error) { return direct, nil },
		lookPath:   func(string) (string, error) { return "", errors.New("must not be used") },
		goos:       runtime.GOOS,
		goarch:     runtime.GOARCH,
		version:    "2.7.41",
	})
	assertDirectRuntimeFallback(t, command, direct)
}

func TestPackagedRuntimeCommandFlowsIntoLifecycleServiceAndTray(t *testing.T) {
	fixture := newPackagedRuntimeFixture(t)
	command := resolveRuntimeCommand(fixture.deps)
	original := processRuntimeCommand
	processRuntimeCommand = func() runtimeCommand { return command }
	t.Cleanup(func() { processRuntimeCommand = original })
	t.Setenv("OPENCODEX_HOME", t.TempDir())

	cfg := config.FreshInstall()
	cfg.Port = 12001
	lifecycle := productionUpdateLifecycle(&cfg, runtimeTarget{Host: "127.0.0.1", Port: cfg.Port}, &cliRuntimeControl{})
	if lifecycle.RuntimeExecutable != evaluatedPath(t, fixture.node) || lifecycle.Launcher != fixture.launcher {
		t.Fatalf("lifecycle executable=%q launcher=%q", lifecycle.RuntimeExecutable, lifecycle.Launcher)
	}
	service := serviceConfig(cfg)
	if service.Executable != evaluatedPath(t, fixture.node) || len(service.Arguments) < 2 || service.Arguments[0] != fixture.launcher || service.Arguments[1] != "serve" {
		t.Fatalf("service executable=%q args=%v", service.Executable, service.Arguments)
	}
	tray := trayConfig(cfg)
	if tray.Executable != evaluatedPath(t, fixture.node) || strings.Join(tray.RunArguments[:3], " ") != fixture.launcher+" tray run" {
		t.Fatalf("tray executable=%q args=%v", tray.Executable, tray.RunArguments)
	}
	if tray.RestartCommand.Executable != evaluatedPath(t, fixture.node) || strings.Join(tray.RestartCommand.Arguments, " ") != fixture.launcher+" service restart" {
		t.Fatalf("tray restart=%#v", tray.RestartCommand)
	}
}

func TestDirectRuntimeCommandFlowsIntoServiceAndTray(t *testing.T) {
	direct := runtimeCommand{Executable: filepath.Join(t.TempDir(), "ocx")}
	original := processRuntimeCommand
	processRuntimeCommand = func() runtimeCommand { return direct }
	t.Cleanup(func() { processRuntimeCommand = original })
	t.Setenv("OPENCODEX_HOME", t.TempDir())

	cfg := config.FreshInstall()
	service := serviceConfig(cfg)
	if service.Executable != direct.Executable || len(service.Arguments) == 0 || service.Arguments[0] != "serve" {
		t.Fatalf("service executable=%q args=%v", service.Executable, service.Arguments)
	}
	tray := trayConfig(cfg)
	if tray.Executable != direct.Executable || strings.Join(tray.RunArguments, " ") != "tray run" {
		t.Fatalf("tray executable=%q args=%v", tray.Executable, tray.RunArguments)
	}
	if tray.RestartCommand.Executable != direct.Executable || strings.Join(tray.RestartCommand.Arguments, " ") != "service restart" {
		t.Fatalf("tray restart=%#v", tray.RestartCommand)
	}
}

func TestExecuteUpdateRestartPlanUsesDurableCommandAndServiceFallback(t *testing.T) {
	entry := runtimeCommand{Executable: "/stable/node", Launcher: "/pkg/bin/ocx.mjs"}
	service := updatepkg.BuildRestartPlan(updatepkg.InstallerNPM, entry.Executable, entry.Launcher, true, 12000, []string{"service", "install", "--native"})
	runner := &recordingRestartRunner{}
	if err := executeUpdateRestartPlan(context.Background(), service, entry, 12000, runner); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 1 || runner.commands[0].String() != "/stable/node /pkg/bin/ocx.mjs service install --native" {
		t.Fatalf("service commands = %#v", runner.commands)
	}

	runner = &recordingRestartRunner{failures: 1}
	if err := executeUpdateRestartPlan(context.Background(), service, entry, 12000, runner); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 2 || runner.commands[1].String() != "/stable/node /pkg/bin/ocx.mjs start --port 12000" {
		t.Fatalf("fallback commands = %#v", runner.commands)
	}

	runner = &recordingRestartRunner{failures: 2}
	if err := executeUpdateRestartPlan(context.Background(), service, entry, 12000, runner); err == nil || !strings.Contains(err.Error(), "service reinstall failed") || !strings.Contains(err.Error(), "direct restart failed") {
		t.Fatalf("double failure = %v", err)
	}
}

func TestExternalGUIUpdateWorkerArgumentsUseExactLauncher(t *testing.T) {
	entry := runtimeCommand{Executable: "/stable/node", Launcher: "/pkg/bin/ocx.mjs"}
	job := updatepkg.Job{ID: "424242"}
	args, err := externalGUIUpdateWorkerArguments(entry, job, "preview", true)
	if err != nil || strings.Join(args, " ") != "/pkg/bin/ocx.mjs __gui-update-worker 424242 preview restart" {
		t.Fatalf("args=%v err=%v", args, err)
	}
	args, err = externalGUIUpdateWorkerArguments(entry, job, "latest", false)
	if err != nil || strings.Join(args, " ") != "/pkg/bin/ocx.mjs __gui-update-worker 424242 latest no-restart" {
		t.Fatalf("args=%v err=%v", args, err)
	}
	if _, err := externalGUIUpdateWorkerArguments(runtimeCommand{}, job, "latest", true); err == nil {
		t.Fatal("missing stable launcher was accepted")
	}
}

func assertDirectRuntimeFallback(t *testing.T, command runtimeCommand, executable string) {
	t.Helper()
	if command.Executable != executable || command.Launcher != "" {
		t.Fatalf("command=%#v, want direct %q", command, executable)
	}
}

func assertPackageRuntimeRejected(t *testing.T, command runtimeCommand) {
	t.Helper()
	if command.Executable != "" || command.Launcher != "" {
		t.Fatalf("invalid package command=%#v", command)
	}
}

func replaceWithSymlink(t *testing.T, path string) {
	t.Helper()
	target := path + ".target"
	if err := os.WriteFile(target, []byte("replacement"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
}

func replaceRuntimeFile(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	temporary := path + ".replacement"
	if err := os.WriteFile(temporary, []byte(strings.Repeat("x", int(info.Size()))), info.Mode().Perm()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, path); err != nil {
		t.Fatal(err)
	}
}

func evaluatedPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}
