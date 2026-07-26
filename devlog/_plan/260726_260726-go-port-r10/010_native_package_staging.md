# 010 — WP1: deterministic native npm package staging

Literal contract: `011_wp1_literal_patch.md`.

## Outcome

Make the existing npm package publish the Go runtime directly. `npm pack` first
rebuilds a disposable `bin/native/` containing exactly six version-matched Go
binaries and one SHA-256 manifest, then keeps the Node launcher and current GUI in
the same tarball. Existing `npm install -g` and `bun add -g` consumers therefore
receive the native launcher without changing the package name.

Base: `3f28468863f942adc6425e8b0912682a36b3aea4` (`dev2-go`).

## Reuse

`scripts/build-go-release.go` remains unchanged. It is the canonical six-target
builder (`darwin/linux/windows × amd64/arm64`, `CGO_ENABLED=0`, `-trimpath`, version
ldflag, deterministic names, SHA-256 manifest).

## Change set

- `.gitignore`: ignore generated `/bin/native/` only.
- `package.json`: add native prepare/verify and explicit publish-build scripts;
  make `prepack` run native staging first and make direct source `npm publish`
  fail with the release-workflow recovery path.
- `scripts/prepare-package.ts`:
  - validate package versions before interpolating names or invoking Go;
  - delete only disposable `bin/native`, build all six targets, normalize modes,
    validate exact inventory and checksums, and remove partial output on failure;
  - pipe Go builder stdout and relay it to stderr so `npm pack --json` remains valid
    JSON on stdout;
  - reject symlinks in any path component, non-files, empty/stale/extra artifacts, malformed or reordered
    manifest rows, checksum mismatches, path escapes, duplicate pack entries, size
    mismatches, and incorrect modes;
  - verify the named tarball's exact byte size, SHA-1 `shasum`, and SHA-512
    `integrity`, then require `bin/ocx.mjs`, both JS wrappers, `gui/dist/index.html`, all six binaries,
    and the checksum manifest in the actual pack report;
  - enforce inclusive ceilings: binary 1..40 MiB, packed 192 MiB, unpacked 256 MiB.
- `.github/workflows/ci.yml`: provision pinned Go in the three-OS npm-global job,
  verify the exact tarball, and force the installed launcher to exercise Go.
- `.github/workflows/release.yml`: build once, pack once, verify the exact archive,
  and publish only that archive with lifecycle scripts disabled.
- `tests/install-scripts.test.ts`: focused lifecycle, cleanup, checksum, inventory,
  exact-limit, required-file, stdout-channel, and mode regression tests.

## P-phase composition evidence

The patch was composed and tested in a clean clone at
`/Users/jun/.codex/tmp/opencodex-package-compose.8ZWnkm/repo` before touching the
authoritative worktree.

- initial audit: `FAIL`; report-only verification did not bind the checked inventory
  to the `.tgz`, and source `npm publish` could bypass the optional verifier;
- replanned tracked diff: 6 files, `+605/-24`;
- canonical diff SHA-256:
  `3b8c2bcb2b358606c3fadfd9b0c3e0e27a28313d1f82808e4133fbcdf834b310`;
- focused tests: 13 pass, 0 fail, 75 assertions; TypeScript check pass;
- `actionlint` passes both changed workflows;
- first real `npm pack --json`: correctly exposed builder stdout contamination;
  fixed by routing captured builder progress to stderr;
- unprepared pack: correctly rejected because `gui/dist/index.html` was absent;
- prepared pack after `bun run build:gui`: accepted.
- final gpt-5.6-sol medium/priority security re-audit: `PASS`, no blockers;
  exact six-file digest and pack-once publish path confirmed.

## Actual prepared package receipt

Package version `2.7.41`:

- filename: `bitkyc08-opencodex-2.7.41.tgz`;
- SHA-1: `718af870a4f00c6bb9a699863fd06fa7c7a23e3c`;
- SHA-512 integrity:
  `sha512-1Ft874Avrq2fimQQmtC3yFGxJpH/0S3+xUlecrH8TjfV7PtlIrW7hKSM9AyHnvxd9+XydFmO6Retx4jnIQO+9w==`;
- 373 files;
- packed: 54,199,159 bytes;
- unpacked: 126,097,467 bytes;
- checksum manifest: 548 bytes, mode `0644`;
- binaries: 17,891,490..20,683,776 bytes, mode `0755`;
- `bin/ocx.mjs`: mode `0755`;
- `bin/native-runtime.mjs`, `bin/package-main.mjs`, and
  `gui/dist/index.html`: mode `0644`.

## Gates

1. Explicit gpt-5.6-sol medium/priority security review of the exact candidate.
2. Apply the exact six-file packet only after P → A → B.
3. Focused tests, typecheck, actual six-target pack and verification.
4. Full Go/Bun/privacy/cross-build gates before commit and push.
