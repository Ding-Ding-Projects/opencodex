#!/usr/bin/env bash
# Rebuild the local Go runtime and point `ocx` at it.
#
# Dogfooding the Go port means running it against the real ~/.opencodex config
# and a live proxy, which is where parity defects actually surface: the first
# run of this binary rejected a working config that the TypeScript runtime
# loads fine, and wrote a config.json.invalid backup doing it.
#
# The launcher resolves a Go binary in this order (bin/native-runtime.mjs):
#
#   OPENCODEX_RUNTIME=ts    -> never use Go
#   OPENCODEX_GO_BINARY=... -> use exactly that file
#   bin/native/ocx_<ver>_<os>_<arch> -> packaged release artifact
#
# It deliberately REFUSES a symlink (isExecutableFile excludes symlinks), so
# this installs a real file rather than linking into the build tree. Rerun the
# script after changing go/ -- the binary does not track the source.
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="${OCX_DOGFOOD_DIR:-$HOME/.opencodex/dogfood}/ocx-go-dev"

# The launcher matches on the npm package version, so the Go build has to carry
# the same one. A mismatch is not cosmetic: the updater compares them.
version="$(node -p "require('$repository/package.json').version")"

mkdir -p "$(dirname "$destination")"
cd "$repository/go"

# umask 022 matches the release builder and keeps internal/platform tests from
# failing on a 077 shell default.
(umask 022; go build -trimpath \
  -ldflags "-s -w -X github.com/lidge-jun/opencodex-go/internal/cli.Version=$version" \
  -o "$destination" ./cmd/ocx)

printf 'built %s (%s)\n' "$destination" "$("$destination" --version)"
cat <<EOF

To use it:
  export OPENCODEX_GO_BINARY=$destination
  export OPENCODEX_RUNTIME=go     # or 'auto' to fall back to TypeScript
  ocx status

To go back to the TypeScript runtime for one command:
  OPENCODEX_RUNTIME=ts ocx status
EOF
