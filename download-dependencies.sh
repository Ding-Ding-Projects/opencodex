#!/usr/bin/env bash
set -euo pipefail

silent=0
if [[ "${SILENT:-}" == 1 ]]; then silent=1; fi
for arg in "$@"; do
  case "$arg" in
    -s|--silent) silent=1 ;;
    *) printf '[download-dependencies] unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  [[ "$silent" == 1 ]] || printf '%s\n' '[download-dependencies] Installing Bun from https://bun.sh/install...'
  curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.14
  export PATH="$HOME/.bun/bin:$PATH"
fi
[[ "$(bun --version)" == 1.3.14 ]] || { printf '%s\n' '[download-dependencies] Bun 1.3.14 is required.' >&2; exit 1; }

for workspace in "$root" "$root/gui"; do
  [[ "$silent" == 1 ]] || printf '[download-dependencies] Installing %s dependencies...\n' "$workspace"
  (cd -- "$workspace" && bun install --frozen-lockfile)
done
printf '%s\n' '[download-dependencies] Dependencies are ready.'
