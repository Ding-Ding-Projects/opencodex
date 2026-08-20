#!/usr/bin/env bash
set -euo pipefail

silent=0
run_after=0
if [[ "${SILENT:-}" == 1 ]]; then silent=1; fi
for arg in "$@"; do
  case "$arg" in
    -s|--silent) silent=1 ;;
    --run) run_after=1 ;;
    *) printf '[build] unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
"$root/download-dependencies.sh" --silent
(cd -- "$root" && bun run typecheck && bun run build:gui)
test -f "$root/gui/dist/index.html"
printf '[build] Build complete from commit %s.\n' "$(git -C "$root" rev-parse HEAD)"
if [[ "$run_after" == 1 && "$silent" == 0 ]]; then
  (cd -- "$root" && exec bun run start)
fi
