# 031 — WP3 corrected candidate contract

Owner: `030_go_only_launcher.md`
Base: `45744655f69f0e43f0357075db4c9e827f256bd6`

## Scope lock

### Launcher and package acceptance

- `bin/native-runtime.mjs`
- `bin/ocx.mjs`
- `scripts/ocx-native-launcher.test.mjs`
- new `scripts/verify-native-install.mjs`
- `package.json`
- `tests/ocx-launcher-source.test.ts`
- `tests/shutdown-launcher.test.ts`
- `tests/cli-help.test.ts`
- `tests/install-scripts.test.ts`
- `tests/prebridge-runtime-rebake.test.ts` is a regression gate, not an edit target
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

### Go durable runtime and updater

- `go/internal/cli/runtime_command.go`
- `go/internal/cli/runtime_command_test.go`
- `go/internal/cli/update.go`
- `go/internal/cli/update_test.go`
- `go/internal/cli/help.go`
- `go/internal/update/check.go`
- `go/internal/update/check_test.go`
- `go/internal/update/release_test.go`
- `go/internal/platform/update.go`
- `go/internal/platform/platform_test.go`

`go/internal/update/release.go` and OS-specific atomic replacement code remain
unchanged unless composition proves another concrete validation seam. Existing
trusted-host, exact asset, bounded response, checksum, temp-file, and atomic Unix
replacement owners are reused. `platform.UpdateDestination` is an opaque snapshot:
the CLI validates package layout, snapshots the destination once, and the downloader
must recheck that identity after download and immediately before rename.

### Documentation and truth tests

- `README.md`
- `CONTRIBUTING.md`
- `docs-site/src/content/docs/contributing.md`
- `docs-site/src/content/docs/getting-started/installation.md`
- `docs-site/src/content/docs/{ko,ja,ru,zh-cn}/getting-started/installation.md`
- `docs-site/src/content/docs/troubleshooting/windows-memory.md`
- `structure/01_runtime.md`
- `structure/06_docs-and-release.md`
- `tests/docs-bun-source-requirement.test.ts`

## Non-negotiable invariants

1. A supported packaged target validates exact Go before any Bun resolution,
   `install.js`, TypeScript CLI import, or shim migration.
2. Only a detected legacy WP2 shim may execute retained Bun after Go validation; its
   failure warns and still forwards to Go.
3. Supported packaged launches reject TypeScript and arbitrary-Go environment
   overrides. Unsupported/source bridge behavior remains available.
4. A self-updated binary may report a newer version than the package manifest, but
   its path must keep the exact manifest-version filename and host target.
5. Native update has no caller-controlled URL, digest, or destination.
6. Native update is same-channel, same-major, strictly newer, package-local, and
   Unix-only. Windows emits the exact npm command before network/download.
7. The downloaded asset name/URL/checksum remain resolver-owned and target exact.
8. Replacement uses the original destination mode and rejects inode, symlink, size,
   timestamp, or mode drift both after download and immediately before rename.
9. The package launcher and metadata do not change during native-only update.
10. The tarball is packed once, verified as that same archive, installed with scripts
   disabled, poisoned for every Bun execution path, and invoked through its real bin.
11. WP3 retains `bun` in dependencies, `src/**` in files, and the explicit Bun export.
12. CI and release run package verification before poison-install verification, both
    against the same one-time pack report/archive, before any publish step.

## Required executable matrices

### Native selection

| Context | Mode/override | Artifact | Result |
| --- | --- | --- | --- |
| supported package | auto/go, none | exact | Go |
| supported package | ts or arbitrary Go path | any | fail before Bun |
| supported package | auto | missing/symlink/non-exec/wrong version | fail before Bun |
| supported package + legacy shim | auto | exact | validate Go, Bun refresh once, Go command |
| supported package + legacy shim | auto | missing/invalid | fail with zero Bun/install.js |
| supported package + failing refresh | auto | exact | warn, then validated Go command |
| unsupported package | auto | unavailable | retained Bun bridge |
| source checkout | ts/go override | explicit valid choice | development behavior retained |

### Native update

| Current | Requested/release | Result |
| --- | --- | --- |
| stable 2.x | newer stable 2.x | Unix replace |
| preview 2.x | newer preview 2.x | Unix replace |
| any | equal | no-op |
| stable ↔ preview | cross-channel | reject before download |
| 2.x | 1.x or 3.x | reject before download |
| any | malformed/downgrade | reject before download |
| Windows | any newer valid release | exact npm command, no download |
| direct/source/arbitrary destination | any | reject before download |
| package 2.7.41 + binary 2.7.42 | durable service/tray resolve | Node + stable launcher |

## Focused verification

```bash
bun run typecheck
node --test scripts/ocx-native-launcher.test.mjs
bun test tests/ocx-launcher-source.test.ts tests/shutdown-launcher.test.ts \
  tests/cli-help.test.ts tests/install-scripts.test.ts \
  tests/docs-bun-source-requirement.test.ts tests/prebridge-runtime-rebake.test.ts \
  tests/codex-shim.test.ts tests/bun-runtime.test.ts
cd go
go test ./internal/cli ./internal/update ./test/parity -count=1
go test -race ./internal/cli ./internal/update
go vet ./internal/cli ./internal/update
```

Package receipt is a separate exact-archive transaction:

```bash
bun run build:gui
bun run prepack
npm pack --ignore-scripts --json > pack.json
bun run verify:native-package
bun run verify:native-install
```

The implementation candidate returns to P for any scope, count, mode, or digest
change after audit.

Final implementation lock: 31 files, `+1007/-552`, SHA-256
`d2600017fcbe145685690ce237571155643c5cf0ab3a2a5aba88a082233f17c2`.
