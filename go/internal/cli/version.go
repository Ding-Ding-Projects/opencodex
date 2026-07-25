package cli

import (
	"runtime/debug"
	"strings"
)

func init() {
	if Version != "0.1.0-dev" {
		return // preserve a release build's -ldflags -X value
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		Version = resolveBuildVersion(Version, info)
	}
}

func resolveBuildVersion(fallback string, info *debug.BuildInfo) string {
	if info == nil {
		return fallback
	}
	version := strings.TrimSpace(info.Main.Version)
	if version == "" || version == "(devel)" {
		return fallback
	}
	return strings.TrimPrefix(version, "v")
}
