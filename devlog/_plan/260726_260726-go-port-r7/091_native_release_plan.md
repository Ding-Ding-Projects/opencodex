# 091 — Go native release transition plan

Date: 2026-07-26

Branch: `dev2-go`

Status: tooling and local rehearsal complete; release publishing not performed

Rebase audit base: `origin/dev` at `ac3af3ec` (66 incoming TS commits reviewed)

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
  --version 2.7.35 \
  --output /tmp/ocx-r13-release.P3vSWE
```

The script builds with `CGO_ENABLED=0`, `-trimpath`, and stripped linker flags,
then writes one SHA-256 manifest. All six binaries were produced successfully:

| Target | Bytes | File inspection | SHA-256 |
|---|---:|---|---|
| darwin/amd64 | 17,817,984 | Mach-O 64-bit x86_64 | `e5ff8db8da2459b46586cb76293bb47c774f78cd231ce2fa648bb13ca2c5abdf` |
| darwin/arm64 | 16,850,018 | Mach-O 64-bit arm64 | `bea3fa3ed3ba41353d2951151939dd8809ebe265510aee0cf51af08d3aed5abc` |
| linux/amd64 | 17,514,658 | static stripped ELF x86-64 | `3ee1cabc686b66d761dec64b9e0e22d2d9d3c887878ce56f078ebeed91d2b52f` |
| linux/arm64 | 16,449,698 | static stripped ELF AArch64 | `c341588d2f4bc446576fdfe202e1d774b25bdc27fb464daeeebdac0c580626f9` |
| windows/amd64 | 19,066,880 | PE32+ x86-64 | `6b43be442ac5cac20f56f8c401ef9c46a5e319f52664772df71b9a90dd24f333` |
| windows/arm64 | 17,703,936 | PE32+ AArch64 | `62cff545efd66621504c1cd7b2cd5427be53b668d42aee29d1398b3a62c856c5` |

`shasum -a 256 -c ocx_2.7.35_checksums.txt` verified all
six entries. The host-native darwin/arm64 binary reported
`opencodex 2.7.35`.

The locally built macOS binaries are ad-hoc/linker signed and have no Team ID.
They are valid build outputs, not release-ready signed artifacts.

## Post-rebase TS delta audit

`git log --oneline ac3af3ec~66..ac3af3ec -- src/ package.json` was reviewed
commit by commit. The CLI/config-relevant dispositions are:

| TS change | Go disposition |
|---|---|
| Per-model `modelAdapters` wire override (`a758bfcf`) | Ported into the production adapter resolver with immutable-pin and canonical-forward guards; factory tests cover both override directions and policy precedence. |
| Reset-credit authoritative `remaining` (`23593db9`, `3fcdd96c`) | Complete: CLI implements `CodexResetCreditConsumer`, refreshes WHAM after successful/already-redeemed consumption, and returns `remaining` only when the fresh payload contains `available_count`. Failed or field-omitting refreshes leave it absent. |
| Main account runtime reset (`03e3f1b4`) | CLI account metadata and shared quota are invalidated when the physical main-account identity changes; a subsequent list fetch restores the new account state. |
| Safe update port reclaim (`4feb9ace`, `772fc666`, `82fbe079`, `c49908d3`) | NOOP: the Go server already uses allowlisted listener inspection/reclaim, and CLI update/service restart paths already invoke it with regression coverage. |
| Omitted Windows Task Scheduler defaults (`f0afdfce`) | NOOP: the Go task XML parser already treats omitted enabled/start-when-available/execution-limit fields as Windows defaults, with focused tests. |
| Subagent fallback series | NOOP for CLI/config: the config field and Codex routing implementation are already present; deeper request routing is outside this packet's write scope. |
| README GIF/package metadata (`faaaf98f`) | NOOP: no native runtime or launcher behavior changed. |

The remaining commits affect GUI, provider transports, request/server handling,
or documentation and therefore do not require a CLI/config port in this scope.

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

The same command against the live GitHub preview channel currently stops safely.
GitHub release metadata checked on 2026-07-26 reports stable `v2.7.40` and
preview `v2.7.40-preview.20260725`, both without attached assets:

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

### Maintainer-ready workflow patch

The release workflow authority is `.github/workflows/release.yml`; no change to
`scripts/release.ts` is required because it already dispatches that workflow
with the version, channel, and immutable expected SHA. Apply the following patch
to the `publish` job after `Setup Node` and before `Install dependencies`, then
replace the final `gh release create` command as shown. This is intentionally a
reviewable proposal only; this worktree does not modify the workflow.

```diff
diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@
       - name: Setup Node
         uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
         with:
           node-version: 24
           registry-url: "https://registry.npmjs.org"

+      - name: Setup Go
+        uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0
+        with:
+          go-version-file: go/go.mod
+          cache-dependency-path: go/go.sum
+
       - name: Install dependencies
         run: bun install --frozen-lockfile
@@
       - name: Verify version matches package.json
         env:
           RELEASE_VERSION: ${{ inputs.version }}
         run: |
           PKG=$(node -p "require('./package.json').version")
           echo "package.json=$PKG  input=${RELEASE_VERSION}"
           test "$PKG" = "$RELEASE_VERSION" || {
             echo "::error::package.json ($PKG) != requested (${RELEASE_VERSION}) — bump package.json on main first";
             exit 1;
           }

+      - name: Build native Go release artifacts
+        env:
+          RELEASE_VERSION: ${{ inputs.version }}
+        run: |
+          set -euo pipefail
+          rm -rf dist/go bin/native
+          go run ./scripts/build-go-release.go \
+            --version "$RELEASE_VERSION" \
+            --output dist/go
+          (
+            cd dist/go
+            sha256sum --check "ocx_${RELEASE_VERSION}_checksums.txt"
+          )
+          mkdir -p bin/native
+          cp dist/go/ocx_${RELEASE_VERSION}_darwin_amd64 bin/native/
+          cp dist/go/ocx_${RELEASE_VERSION}_darwin_arm64 bin/native/
+          cp dist/go/ocx_${RELEASE_VERSION}_linux_amd64 bin/native/
+          cp dist/go/ocx_${RELEASE_VERSION}_linux_arm64 bin/native/
+          cp dist/go/ocx_${RELEASE_VERSION}_windows_amd64.exe bin/native/
+          cp dist/go/ocx_${RELEASE_VERSION}_windows_arm64.exe bin/native/
+          chmod 0755 bin/native/ocx_${RELEASE_VERSION}_{darwin,linux}_{amd64,arm64}
+
+      - name: Verify native launcher package inputs
+        env:
+          RELEASE_VERSION: ${{ inputs.version }}
+        run: |
+          set -euo pipefail
+          node --test scripts/ocx-native-launcher.test.mjs
+          package_listing="$(npm pack --dry-run --json)"
+          for asset in \
+            "ocx_${RELEASE_VERSION}_darwin_amd64" \
+            "ocx_${RELEASE_VERSION}_darwin_arm64" \
+            "ocx_${RELEASE_VERSION}_linux_amd64" \
+            "ocx_${RELEASE_VERSION}_linux_arm64" \
+            "ocx_${RELEASE_VERSION}_windows_amd64.exe" \
+            "ocx_${RELEASE_VERSION}_windows_arm64.exe"; do
+            node -e '
+              const listing = JSON.parse(process.argv[1]);
+              const wanted = `bin/native/${process.argv[2]}`;
+              if (!listing[0]?.files?.some(file => file.path === wanted)) {
+                console.error(`missing npm native asset: ${wanted}`);
+                process.exit(1);
+              }
+            ' "$package_listing" "$asset"
+          done
@@
-          gh release create "$release_tag" --target "$GITHUB_SHA" --title "$release_tag" \
-            --notes-file "$notes_file" ${prerelease_flag:+$prerelease_flag}
+          gh release create "$release_tag" \
+            dist/go/ocx_${RELEASE_VERSION}_* \
+            --target "$GITHUB_SHA" --title "$release_tag" \
+            --notes-file "$notes_file" ${prerelease_flag:+$prerelease_flag}
```

Why these exact insertion points:

- Native artifacts are built only after the workflow proves the requested
  version equals `package.json`, so filenames and linker version cannot drift.
- `bin/native/` is populated before `npm publish`; `package.json` already ships
  the whole `bin` directory and `prepare-package.ts` restores executable modes.
- The same files are retained in `dist/go/` until `gh release create`, so npm
  and GitHub receive byte-identical binaries and the updater's versioned
  checksum manifest covers the uploaded assets.
- The release command's glob includes exactly six binaries plus the checksum
  manifest. A missing target or checksum fails before npm publication.

The patch above produces unsigned cross-compiled artifacts. It is sufficient
for a private/preview rehearsal only. Before stable release, replace the single
Ubuntu build step with signed platform jobs (macOS signing/notarization and the
project's Windows signing policy), download those immutable signed artifacts in
`publish`, and generate the checksum manifest only after signing. Do not sign or
rewrite files after the manifest is generated.

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

## Native transition checklist for operators

Use preview first. Do not promote the release merely because all six files were
cross-compiled; at least one native execution smoke is required on every target
OS family.

### Before publishing

- [ ] Apply and review the `.github/workflows/release.yml` patch above on the
  exact audited release commit; keep `scripts/release.ts` unchanged.
- [ ] Run the full Go gate and existing Bun/typecheck/privacy gates on that SHA.
- [ ] Produce six final binaries and `ocx_<version>_checksums.txt`. If signing is
  enabled, generate the manifest after signing/notarization, never before.
- [ ] Run `sha256sum --check ocx_<version>_checksums.txt` against the exact files
  that will be attached and packed.
- [ ] Inspect `npm pack --dry-run --json`: all six files must appear under
  `bin/native/` with the exact versioned names expected by `native-runtime.mjs`.
- [ ] Run `node --test scripts/ocx-native-launcher.test.mjs` against the packed
  package fixture, covering auto Go, forced Go, forced TS, and fallback TS.
- [ ] Confirm the preview GitHub Release is marked prerelease and includes six
  binaries plus one checksum manifest. Stable and preview tags must not share
  or overwrite assets.

### Before switching an existing installation

```bash
mkdir -p ~/.opencodex/native-transition-backup
cp -p ~/.opencodex/config.json ~/.opencodex/native-transition-backup/config.json 2>/dev/null || true
cp -p ~/.opencodex/auth.json ~/.opencodex/native-transition-backup/auth.json 2>/dev/null || true
chmod 700 ~/.opencodex/native-transition-backup
chmod 600 ~/.opencodex/native-transition-backup/*.json 2>/dev/null || true

ocx config validate
ocx update --tag preview --dry-run
```

- [ ] Record the current `ocx --version`, installation method, service backend,
  configured port, and previous release asset checksum.
- [ ] Confirm the dry-run names the expected preview version, current platform
  artifact, GitHub release URL, SHA-256, and executable destination.
- [ ] Keep credential backups local and protected; never attach `auth.json` to
  an issue, release, test artifact, or CI log.
- [ ] Stop active long-running Codex/Claude sessions before replacing the
  binary. Preserve `config.json`, `auth.json`, Codex config, and shim backups.

### Preview cutover and acceptance

For an npm installation whose preview package contains `bin/native/`:

```bash
npm install -g @bitkyc08/opencodex@preview
OPENCODEX_RUNTIME=go ocx --version
OPENCODEX_RUNTIME=go ocx config validate
OPENCODEX_RUNTIME=go ocx doctor
```

Then start `ocx serve` in an isolated smoke environment and verify:

- [ ] `status`, `provider list`, `models list`, and `config show --json` exit 0.
- [ ] An offline request reaches a controlled local upstream and returns through
  the proxy; no external provider credential is needed for this smoke.
- [ ] OAuth/account metadata survives stop and restart without exposing access
  tokens, refresh tokens, API keys, or physical account identifiers.
- [ ] `ocx update --tag preview --dry-run` reports the installed preview as
  current, or identifies only the intended next preview.
- [ ] A service-managed installation is reinstalled with the same backend and
  survives one stop/start cycle; Codex shim restore/back also succeeds.
- [ ] On one host per OS family, run with Bun and Node absent from `PATH` and
  confirm the standalone Go binary still serves the offline request.

### Rollback runbook

Choose the narrowest rollback that restores service:

1. **Launcher-only rollback:** set `OPENCODEX_RUNTIME=ts` and rerun `ocx`. This
   immediately selects the packaged TS/Bun fallback without changing config or
   credentials.
2. **Standalone binary rollback:** stop the proxy, select the preceding signed
   release asset and its digest from that release's immutable checksum manifest,
   then run:

   ```bash
   ocx update \
     --url https://github.com/lidge-jun/opencodex/releases/download/v<previous>/ocx_<previous>_<os>_<arch> \
     --sha256 <digest-from-previous-manifest> \
     --destination "$(command -v ocx)"
   ```

   On Windows use the `.exe` asset and an explicit executable destination.
3. **npm package rollback:** reinstall an exact previously accepted version,
   not a moving dist-tag: `npm install -g @bitkyc08/opencodex@<previous>`.
   Force `OPENCODEX_RUNTIME=ts` until its packaged native asset is verified.
4. **Routing rollback:** run `ocx stop` and `ocx restore` so plain Codex no
   longer points at the failed proxy. After recovery, `ocx restore back`
   re-enables proxy routing.
5. **Config rollback:** only while the proxy is stopped, restore the protected
   `config.json` backup. For the OpenAI tier migration, retain and inspect
   `config.json.pre-openai-tiers-v2.bak`; never overwrite a differing backup
   automatically. Restore `auth.json` only if credential-store state itself was
   damaged, preserving mode `0600` and directory mode `0700`.

After any rollback, verify `ocx --version`, `ocx config validate`, `ocx doctor`,
one offline proxy request, service state, and native Codex restoration. Publish
a new corrective version; never replace assets or retarget a release tag that
users may already have consumed.

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
go run ./scripts/build-go-release.go --version 2.7.35 --output /tmp/ocx-r13-release.P3vSWE
cd /tmp/ocx-r13-release.P3vSWE
shasum -a 256 -c ocx_2.7.35_checksums.txt

cd /path/to/opencodex
node --test scripts/ocx-native-launcher.test.mjs
cd go
go test ./internal/cli ./internal/update -count=1
go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s
```
