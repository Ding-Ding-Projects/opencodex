package cli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type runtimeCommand struct {
	Executable string
	Launcher   string
}

type runtimeCommandDeps struct {
	executable    func() (string, error)
	lookPath      func(string) (string, error)
	goos          string
	goarch        string
	version       string
	beforeRecheck func()
}

type runtimeFileSnapshot struct {
	path string
	info os.FileInfo
}

type packagedRuntime struct {
	executable runtimeFileSnapshot
	manifest   runtimeFileSnapshot
	launcher   runtimeFileSnapshot
	version    string
}

var processRuntimeCommand = func() runtimeCommand {
	return resolveRuntimeCommand(runtimeCommandDeps{
		executable: os.Executable,
		lookPath:   exec.LookPath,
		goos:       runtime.GOOS,
		goarch:     runtime.GOARCH,
		version:    Version,
	})
}

func resolveRuntimeCommand(deps runtimeCommandDeps) runtimeCommand {
	executable, err := deps.executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		executable = os.Args[0]
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return runtimeCommand{Executable: executable}
	}
	direct := runtimeCommand{Executable: filepath.Clean(executable)}

	if filepath.Base(filepath.Dir(direct.Executable)) != "native" || filepath.Base(filepath.Dir(filepath.Dir(direct.Executable))) != "bin" {
		return direct
	}
	invalidPackage := runtimeCommand{}
	packaged, ok := snapshotPackagedRuntime(direct.Executable, deps.goos, deps.goarch)
	if !ok {
		return invalidPackage
	}

	nodePath, err := deps.lookPath("node")
	if err != nil || strings.TrimSpace(nodePath) == "" {
		return invalidPackage
	}
	nodePath, err = filepath.Abs(nodePath)
	if err != nil || !filepath.IsAbs(nodePath) {
		return invalidPackage
	}
	nodePath, err = filepath.EvalSymlinks(nodePath)
	if err != nil || !filepath.IsAbs(nodePath) {
		return invalidPackage
	}
	nodeSnapshot, ok := snapshotRuntimeFile(nodePath, true, deps.goos)
	if !ok {
		return invalidPackage
	}
	if deps.beforeRecheck != nil {
		deps.beforeRecheck()
	}
	if !packaged.unchanged() || !runtimeFileUnchanged(nodeSnapshot) {
		return invalidPackage
	}
	return runtimeCommand{Executable: filepath.Clean(nodePath), Launcher: packaged.launcher.path}
}

func snapshotPackagedRuntime(executable, goos, goarch string) (packagedRuntime, bool) {
	nativeDir := filepath.Dir(executable)
	binDir := filepath.Dir(nativeDir)
	packageRoot := filepath.Dir(binDir)
	if filepath.Base(nativeDir) != "native" || filepath.Base(binDir) != "bin" {
		return packagedRuntime{}, false
	}
	nativeSnapshot, ok := snapshotRuntimeFile(executable, true, goos)
	if !ok {
		return packagedRuntime{}, false
	}
	manifestPath := filepath.Join(packageRoot, "package.json")
	manifestSnapshot, ok := snapshotRuntimeFile(manifestPath, false, goos)
	if !ok {
		return packagedRuntime{}, false
	}
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return packagedRuntime{}, false
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(manifestData, &manifest) != nil || strings.TrimSpace(manifest.Version) != manifest.Version || manifest.Version == "" {
		return packagedRuntime{}, false
	}
	expectedName := "ocx_" + manifest.Version + "_" + goos + "_" + goarch
	if goos == "windows" {
		expectedName += ".exe"
	}
	if filepath.Base(executable) != expectedName {
		return packagedRuntime{}, false
	}
	launcherSnapshot, ok := snapshotRuntimeFile(filepath.Join(binDir, "ocx.mjs"), false, goos)
	if !ok {
		return packagedRuntime{}, false
	}
	packaged := packagedRuntime{executable: nativeSnapshot, manifest: manifestSnapshot, launcher: launcherSnapshot, version: manifest.Version}
	return packaged, packaged.unchanged()
}

func (packaged packagedRuntime) unchanged() bool {
	return runtimeFileUnchanged(packaged.executable) && runtimeFileUnchanged(packaged.manifest) && runtimeFileUnchanged(packaged.launcher)
}

func snapshotRuntimeFile(path string, executable bool, goos string) (runtimeFileSnapshot, bool) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return runtimeFileSnapshot{}, false
	}
	if executable && goos != "windows" && info.Mode().Perm()&0o111 == 0 {
		return runtimeFileSnapshot{}, false
	}
	return runtimeFileSnapshot{path: path, info: info}, true
}

func runtimeFileUnchanged(snapshot runtimeFileSnapshot) bool {
	current, err := os.Lstat(snapshot.path)
	return err == nil && current.Mode()&os.ModeSymlink == 0 && current.Mode().IsRegular() &&
		os.SameFile(snapshot.info, current) && snapshot.info.Size() == current.Size() &&
		snapshot.info.ModTime() == current.ModTime() && snapshot.info.Mode() == current.Mode()
}
