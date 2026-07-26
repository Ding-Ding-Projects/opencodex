# 030 — WP3: Go-first installed launcher and bounded native update

Candidate contract: `031_wp3_literal_patch.md`.

## Outcome

On the six packaged targets, an installed `ocx` validates and launches the exact
package-local Go artifact before any Bun lookup or installer path. Missing, replaced,
or overridden native identity fails closed. Bun remains installed only for the
one-time WP2 legacy-shim migration, the explicit Bun package export, unsupported
targets, and old-updater recovery.

The Go `update` command may replace only its own validated package-local artifact,
only on Unix, and only with a strictly newer release from the same channel and major.
Windows names an exact npm recovery command until launcher-assisted replacement is
implemented.

Base: `45744655f69f0e43f0357075db4c9e827f256bd6` over `origin/dev`
`58f0fab3109383b398328c98dcea63089773c693`.

## Rejected literal plan

The previous `031` patch is not applicable and must not be partially applied.
gpt-5.6-sol medium/priority found four release blockers:

- native self-update creates binary/package version skew which invalidated WP2's
  durable service/tray command resolver;
- public `--destination`, `--url`, and `--sha256` bypassed package, channel, target,
  and version policy, while Windows attempted to replace its running executable;
- legacy Bun shim refresh ran before supported-package Go validation and environment
  overrides could force TypeScript or an arbitrary Go binary;
- fixture tests never installed and executed the exact verified npm tarball.

It also found the old appendix stale in launcher, package, and test files, and missing
the canonical runtime structure docs. The corrected candidate is composed against
the base above.

## Corrected design

### Supported installed launcher

- Export the supported target predicate from `bin/native-runtime.mjs`.
- A packaged darwin/linux/windows × amd64/arm64 launch accepts only `auto` or `go`,
  rejects `OPENCODEX_RUNTIME=ts` and `OPENCODEX_GO_BINARY`, and requires the exact
  regular version-named package artifact with Unix execute bits.
- Source checkouts and unsupported installed targets retain the explicit bridge
  selection behavior.
- `bin/ocx.mjs` resolves the Go artifact before shim migration. Therefore a missing
  supported artifact cannot execute Bun or `bun/install.js` before failing.
- After successful native validation, the one-time WP2 legacy shim migration may run
  retained Bun; this is the sole supported-package Bun exception. Normal commands
  never resolve, install, or execute Bun.
- Signal forwarding continues to cover SIGINT/SIGTERM and POSIX SIGHUP using an exact
  package-local fake artifact, not `OPENCODEX_GO_BINARY`.

### Version-skew-safe durable command

- `go/internal/cli/runtime_command.go` derives the expected executable filename from
  the snapshotted package manifest version, not the running binary's build version.
- The executable must still reside under `bin/native`, match host target and package
  version, and survive the existing file identity/mode/race recheck.
- A package named `2.7.41` whose self-updated binary reports `2.7.42` therefore keeps
  persisting Node + stable `bin/ocx.mjs` without accepting a wrong filename.

### Policy-bound native update

- Public surface is `ocx update [--tag latest|preview] [--dry-run]`. No raw URL,
  checksum, or destination flags remain.
- Omitted tag uses the current binary's channel. Explicit cross-channel requests,
  malformed versions, equal/downgrade releases, and cross-major releases fail before
  download. Equal current/latest is the only no-op.
- The resolver remains authoritative for trusted GitHub path, exact host target,
  bounded metadata, and manifest SHA-256.
- Destination is always `os.Executable()` after validating its package root,
  manifest, launcher, target filename, regular-file identity, and replacement race.
  Direct/source or arbitrary paths are rejected.
- The platform downloader owns an opaque pre-download destination snapshot. It uses
  that snapshot's mode and rechecks regular/non-symlink identity, size, timestamp,
  and mode after download and again immediately before rename; replacement,
  symlink, or chmod races leave the destination untouched.
- Unix downloads and atomically replaces that validated destination. Windows never
  downloads and returns `npm install -g @bitkyc08/opencodex@<channel>` guidance.
- Output states that package metadata and launcher remain at the installed package
  version; npm is required for package-layout changes.

### Exact tarball receipt

- Build native artifacts, run `npm pack` exactly once, verify that same report/archive,
  then install that exact `.tgz` into an isolated global prefix with lifecycle scripts
  disabled.
- Resolve the installed package's Bun dependency, replace both its binary and
  `install.js` with poison sentinels, set an isolated `OPENCODEX_HOME`, and execute the
  installed `ocx help` through its real npm bin entry.
- Acceptance requires Go help output, zero poison sentinel, exact archive identity,
  and no source-checkout imports.
- Launcher fixtures separately prove the sole Bun exception: exact packaged Go is
  validated first, then legacy shim refresh runs Bun exactly once before Go; a
  missing/invalid Go artifact runs neither Bun nor `install.js`; refresh failure
  warns and still forwards to the already validated Go artifact.

### Documentation truth

- README, contributing docs, installation locale mirrors, runtime structure docs,
  and Windows memory guidance distinguish the supported packaged Go runtime from the
  dormant Bun bridge/API dependency.
- The six targets are listed consistently, including Windows arm64.
- Bun dependency removal is explicitly deferred to the convergence gate; WP3 does not
  claim that npm dependency or `src/**` has disappeared.

## Required gates

1. Audit this corrected plan with gpt-5.6-sol medium/priority.
2. Compose implementation in a clean candidate; audit its exact diff before apply.
3. Focused launcher, shim, self-update, signal, docs, and runtime-command tests.
4. Pack once; verify and execute that exact isolated install with poison Bun.
5. Full Go test/race/vet/cross-build and full Bun/typecheck/lint/privacy gates.
6. Push exact remote parity before D.
