#!/usr/bin/env bash
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    -s|--silent) ;;
    *) printf '[build-installer] unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    printf '%s\n' '[build-installer] Use build-installer.bat on Windows so Squirrel.Windows is invoked by the supported path.' >&2
    exit 1
    ;;
  *)
    printf '%s\n' '[build-installer] The packaged desktop target is Windows-only; no non-Windows installer is supported.' >&2
    exit 1
    ;;
esac
