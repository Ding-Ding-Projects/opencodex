# 030 — WP3: Go-first bridge launcher and bounded self-update

Literal implementation hunks: `031_wp3_literal_patch.md`.

## Outcome

For the six supported targets, the npm CLI always launches its matching Go binary and
fails closed when that artifact is unusable. Bun remains installed but dormant for
pre-bridge recovery compatibility. The small Node launcher remains the npm bootstrap.

## MODIFY `bin/ocx.mjs`

- Reduce the supported-target path to package-version read, native resolution,
  argv/signal forwarding, and clear fatal errors.
- Keep legacy fallback code physically present for the bridge, but supported packaged
  targets must select Go before any Bun resolution/import-dependent action.
- Keep Node shebang, `ocx`/`opencodex` aliases, and exact current package filename.
- Keep `src/**` and `bun` dependency for explicit API and pre-bridge updater
  recovery. Add a removal gate to the decision record; do not claim deletion.

## MODIFY `bin/native-runtime.mjs`

- Use `lstatSync` rather than `statSync` so symlinked artifacts are rejected.
- Add direct tests for unsupported OS/arch, invalid mode, Windows `.exe`, stale
  other-version artifact, invalid override, and non-executable Unix artifact.
- Auto mode remains the compatibility path for unsupported installed hosts and
  source fixtures. The packaged launcher treats a null native result as fatal
  only on the six supported release targets; FreeBSD, Linux/riscv64, and future
  unsupported targets may still enter the retained Bun bridge.

## KEEP `package.json` runtime dependency during bridge

- No dependency/lock removal in R10. The package must still contain Bun for updater
  versions that spawn their old `process.execPath` after replacement.
- Acceptance is process-level: supported target launch must not call
  `require.resolve("bun/package.json")`, Bun installer, or TS CLI.
- Later removal gate: bridge updater adoption or next-major policy, plus a tested
  reinstall path for clients that skipped bridge. Record this in the native decision
  document and release notes.

## MODIFY installers and launcher tests

- Keep current installer recovery text during bridge.
- Update `scripts/ocx-native-launcher.test.mjs` with a poison Bun module/installer
  whose execution fails the test; supported packaged fixtures must still run Go.
- Install the real tarball under a temporary npm prefix. Poison or remove Bun from
  PATH/module lookup but retain Node for the JS launcher; `ocx help` must enter Go.
- `tests/cli-help.test.ts` keeps version assertions on the source CLI instead of
  assuming a source checkout has packaged native assets.
- Replace the obsolete Bun-proxy launcher shutdown fixture with a fake executable
  Go child. SIGINT, SIGTERM, and SIGHUP sent to the Node launcher must each reach
  that child and the launcher must wait for its exit.
- Add an explicit unsupported-installed-target selection test: an unsupported
  `(platform, arch)` returns no native artifact in auto mode and remains eligible
  for the Bun bridge rather than being mislabeled as a supported Go package.

## REUSE native self-update

- `go/internal/cli/update.go` and `go/internal/update/release.go` remain canonical.
- Add built-dispatch activation in `go/internal/cli/update_test.go`.
- Prove trusted host/path, exact target, SHA-256 match, current-version no-op, and
  package-local executable replacement.
- Add strict newer-only and same-major compatibility checks. Preview resolver stays
  preview-only; stable stays stable-only. Downgrade, equal, cross-major, and malformed
  releases fail before download.
- Native update advances the Go child while package metadata/launcher stay at the
  bridge version. Package-layout changes require npm/Bun package update; runtime-only
  updates are bounded to the same major launcher contract.

## MODIFY docs and stale contract tests

- `README.md`, `CONTRIBUTING.md`, and
  `docs-site/src/content/docs/contributing.md`: replace “installed ocx uses bundled
  Bun” with “supported installed ocx runs packaged Go; Bun remains a dormant bridge
  and explicit API/source dependency.”
- `tests/docs-bun-source-requirement.test.ts`: assert that exact distinction.
- `tests/install-scripts.test.ts`: retain Node/npm and bridge recovery expectations,
  add Go-first package assertion, and update prepack script expectation.

## Check

```bash
node --test scripts/ocx-native-launcher.test.mjs
bun test --isolate tests/cli-help.test.ts tests/shutdown-launcher.test.ts
cd go
go test ./internal/cli ./internal/update ./test/parity -count=1
cd ..
npm pack --json > pack.json
bun scripts/prepare-package.ts --verify-pack pack.json
```
