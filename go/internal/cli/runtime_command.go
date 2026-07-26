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

	nativeDir := filepath.Dir(direct.Executable)
	binDir := filepath.Dir(nativeDir)
	packageRoot := filepath.Dir(binDir)
	if filepath.Base(nativeDir) != "native" || filepath.Base(binDir) != "bin" {
		return direct
	}
	invalidPackage := runtimeCommand{}
	extension := ""
	if deps.goos == "windows" {
		extension = ".exe"
	}
	expectedName := "ocx_" + deps.version + "_" + deps.goos + "_" + deps.goarch + extension
	if filepath.Base(direct.Executable) != expectedName {
		return invalidPackage
	}

	nativeSnapshot, ok := snapshotRuntimeFile(direct.Executable, true, deps.goos)
	if !ok {
		return invalidPackage
	}
	manifestPath := filepath.Join(packageRoot, "package.json")
	manifestSnapshot, ok := snapshotRuntimeFile(manifestPath, false, deps.goos)
	if !ok {
		return invalidPackage
	}
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return invalidPackage
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(manifestData, &manifest) != nil || manifest.Version != deps.version {
		return invalidPackage
	}
	launcherPath := filepath.Join(binDir, "ocx.mjs")
	launcherSnapshot, ok := snapshotRuntimeFile(launcherPath, false, deps.goos)
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
	if !runtimeFileUnchanged(nativeSnapshot) || !runtimeFileUnchanged(manifestSnapshot) ||
		!runtimeFileUnchanged(launcherSnapshot) || !runtimeFileUnchanged(nodeSnapshot) {
		return invalidPackage
	}
	return runtimeCommand{Executable: filepath.Clean(nodePath), Launcher: launcherPath}
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
