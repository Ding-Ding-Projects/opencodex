# 091 — Go native release transition plan

Date: 2026-07-26

Branch: `dev2-go`

Status: tooling and local rehearsal complete; release publishing not performed

## Decision summary

The Go `ocx` binary can run the proxy and primary CLI commands without Bun or
Node. Native distribution is not complete until the release process publishes
the six platform artifacts under the exact names consumed by the updater and
the npm package includes the matching binary in `bin/native/`.

The launcher is intentionally transitional:

1. `OPENCODEX_RUNTIME=ts` always selects the bundled Bun/TypeScript runtime.
2. `OPENCODEX_GO_BINARY=/absolute/path` selects that Go binary unless TS is
   explicitly forced.
3. In automatic mode an exact package-local platform artifact is preferred.
4. If no native artifact exists, the current bundled Bun/TypeScript path remains
   the compatibility fallback.

This preserves the current npm package while allowing preview releases to add
native artifacts incrementally. Removing Bun from the npm dependency graph is a
separate, later policy decision after native preview soak.

## Local six-platform rehearsal

Command:

```bash
go run ./scripts/build-go-release.go \
  --version 2.9.0-preview.20260726 \
  --output /tmp/ocx-r11-release.18HGnu
```

The script builds with `CGO_ENABLED=0`, `-trimpath`, and stripped linker flags,
then writes one SHA-256 manifest. All six binaries were produced successfully:

| Target | Bytes | File inspection | SHA-256 |
|---|---:|---|---|
| darwin/amd64 | 17,671,936 | Mach-O 64-bit x86_64 | `8651c4350baf2fac42a82ac7a00a169ce5c854d0363df928849191903f9675ac` |
| darwin/arm64 | 16,715,234 | Mach-O 64-bit arm64 | `e7aaae0b84b8ee7ac813e04914583b3c50197164a1c203be9c0433da30f6be74` |
| linux/amd64 | 17,371,298 | static stripped ELF x86-64 | `59ead388a345bfc7a681d631ff2955f21d0323fffcb579f129ca4df86ac88c2b` |
| linux/arm64 | 16,318,626 | static stripped ELF AArch64 | `b31019de0ec032ef3b23b2941dad45916284c3060b23bec20861bb0f31227266` |
| windows/amd64 | 18,918,400 | PE32+ x86-64 | `37ac873dd364f1983992e105cac11847abb237032fbfc190cdd853d73e2cf157` |
| windows/arm64 | 17,573,888 | PE32+ AArch64 | `e022ba2a987e2039e615a43b0f86be03e3d20713af48c56d16498d3e721ba082` |

`shasum -a 256 -c ocx_2.9.0-preview.20260726_checksums.txt` verified all
six entries. The host-native darwin/arm64 binary reported
`opencodex 2.9.0-preview.20260726`.

The locally built macOS binaries are ad-hoc/linker signed and have no Team ID.
They are valid build outputs, not release-ready signed artifacts.

## Native updater rehearsal

The updater resolves a channel through GitHub release metadata, selects the
exact `GOOS/GOARCH` asset, downloads the versioned checksum manifest, extracts
the named artifact digest, and only then plans replacement.

A hermetic TLS integration test exercises the complete preview dry-run path:

```bash
cd go
go test ./internal/cli \
  -run TestUpdatePreviewDryRunResolvesManifestWithoutReplacingBinary \
  -count=1
```

It verifies metadata selection, trusted asset URLs, exact manifest lookup,
SHA-256 propagation, destination selection, and that dry-run never invokes the
replacer or changes the destination bytes.

The same command against the live GitHub preview channel currently stops safely:

```text
Error: resolve preview release: release is missing
"ocx_2.7.40-preview.20260725_darwin_arm64" or
"ocx_2.7.40-preview.20260725_checksums.txt"
```

That is expected: the existing preview release predates native assets. No
download or replacement occurred.

## Launcher compatibility matrix

`node --test scripts/ocx-native-launcher.test.mjs` executes a temporary package
fixture with the real launcher and verifies all four selection quadrants:

| Package-local Go | Runtime environment | Expected path | Result |
|---|---|---|---|
| present | unset | Go | pass |
| absent | unset | bundled Bun/TS fallback | pass |
| absent | `OPENCODEX_GO_BINARY` set | explicit Go binary | pass |
| present | `OPENCODEX_RUNTIME=ts` | bundled Bun/TS | pass |

Arguments and child exit codes are preserved in every case. Forced Go mode also
fails closed when its binary is unavailable; it does not silently execute TS.

## Required release-pipeline changes

Do not change `scripts/release.ts` or `.github/workflows/**` casually; they are
the release security boundary. A maintainer-controlled workflow update should:

1. Build and test the GUI and Go module from the exact release commit.
2. Run `scripts/build-go-release.go` using the package version without a leading
   `v`.
3. Sign and notarize both macOS binaries and apply the project Windows signing
   policy. Signing changes bytes, so generate the final SHA-256 manifest only
   after every signing/notarization mutation is complete.
4. Generate and retain an SBOM plus provenance/attestation for the release
   commit, toolchain, and six artifacts.
5. Attach all six binaries and the versioned checksum manifest to the matching
   GitHub release. Asset names must remain exact; the updater rejects missing,
   duplicate, untrusted-host, or mismatched assets.
6. Before `npm pack`, place the six artifacts intended for that package version
   under `bin/native/`. Confirm package contents and execute the launcher matrix
   from the packed tarball, not only the source checkout.
7. Smoke-test a native binary with Bun/Node absent from `PATH`: `--version`,
   `status`, `doctor`, `provider list`, `models list`, `config show`, and an
   offline `serve` request through a local upstream.
8. Publish to the npm `preview` dist-tag and a GitHub prerelease first. Promote
   to stable only after platform installation/update telemetry and rollback
   rehearsal are acceptable.

The workflow should use immutable action revisions, least-privilege permissions,
environment-protected release credentials, and artifact retention sufficient
for rollback and incident review.

## Rollback and recovery

- Keep the TS fallback in preview npm packages until native launch/update soak is
  complete.
- Native replacement remains checksum-gated and atomic. A failed resolve,
  download, digest, or replace leaves the current executable untouched.
- Retain the preceding signed binary assets and npm package. Roll back by
  publishing a new corrective release or restoring the prior binary through the
  explicit `--url --sha256` path; do not mutate an already-consumed release tag.
- If a platform artifact is withdrawn, force-native users should fail closed;
  automatic npm users can still use the bundled TS fallback while the corrective
  release is prepared.

## Release blockers and known limits

- Current public preview releases do not contain the native artifact set.
- Local rehearsal artifacts are not production-signed or notarized.
- The build helper produces binaries and checksums only; SBOM, provenance,
  signing, notarization, upload, and npm packing remain release-pipeline work.
- Cross-compilation proves buildability, not native execution. Windows service,
  tray, ACL, installer, and launcher behavior still need execution on real
  Windows amd64 and arm64 runners.
- No release was created, uploaded, replaced, or published during this rehearsal.

## Verification commands

```bash
go run ./scripts/build-go-release.go --version 2.9.0-preview.20260726 --output /tmp/ocx-r11-release.18HGnu
cd /tmp/ocx-r11-release.18HGnu
shasum -a 256 -c ocx_2.9.0-preview.20260726_checksums.txt

cd /path/to/opencodex
node --test scripts/ocx-native-launcher.test.mjs
cd go
go test ./internal/cli ./internal/update -count=1
go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s
```
