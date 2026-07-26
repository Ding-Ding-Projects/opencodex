# 001 — R10 current-state evidence

## Runtime/package inventory

- `go list ./internal/...` returns 30 packages. The former duplicate root router,
  Cursor generated mirror, and generated metadata snapshot were deleted in
  `bf0ef3f5`, `1a780968`, and `53b0591d`.
- Go source is 78,706 non-test lines and 37,209 test lines.
- There are 101 production/built/dispatch/native/install activation-style test
  declarations under `go/internal` and `go/test`.
- `go/test/parity/differential_matrix_test.go:110` has an empty
  `knownRuntimeDiffs` map and no `{body: true}` exemptions.
- `devlog/_plan/260726_260726-go-port-r8/095_reachability_dashboard.md` still
  reports 30/33 S3 because it predates deletion of the three S1 packages.
  At `faf51d83` the package denominator was 30 and the reachability score was
  30/30 S3. After rebasing `5078ffc3`, response-state interrupted-write recovery
  and usage-log scalability fell below S1. The later `9d1bb146` rebase also adds
  Claude auth-auto and guarded config-save behavior classified in
  `009_second_dev_stale_check.md`; `ea2766a7` adds immediate manual Codex account
  selection and threshold-correct routing behavior classified in
  `009_1_third_dev_stale_check.md`; `1eb7269f` adds the per-resolution Claude
  settings-hijack contract classified in `009_3_audit_fail_replan.md`. This does not turn external
  OAuth/provider/OS execution into evidence.

## What already runs without Bun

- `go/internal/cli/update.go:14-53` resolves `latest|preview` through the
  GitHub release resolver and replaces `os.Executable()` with a SHA-256 checked
  artifact.
- `go/internal/update/release.go:55-185` validates versioned artifact names,
  checksum presence, HTTPS, trusted host, and repository release path.
- A Go binary launched directly works with Bun and Node absent. The runtime memory
  evidence remains roughly 21 MiB cold RSS versus 165 MiB for Bun/TS, with the
  long-stream measurements also strongly favoring Go.

## What still selects Bun

- `package.json:14-20` maps both CLI names to `bin/ocx.mjs` and includes the
  whole `bin` directory, but no `bin/native` artifacts exist.
- `bin/ocx.mjs:354-372` selects Go only when the versioned binary exists; otherwise
  it resolves the npm `bun` dependency and starts `src/cli/index.ts`.
- `package.json:32-33,57-61` trusts and installs `bun@1.3.14` as a production
  dependency.
- `scripts/prepare-package.ts:23-36` already knows native binaries need executable
  modes, but it only chmods an existing directory and never builds it.
- `scripts/build-go-release.go:35-91` already builds all six targets and the
  checksum manifest, currently to `dist/go`.

## Update transition matrix

| Starting install | First transition mechanism | Runtime after new package | Ongoing CLI update |
| --- | --- | --- | --- |
| old npm global | old launcher runs `npm install -g ...@preview` | Node shim → packaged Go | Go GitHub release + SHA-256 |
| old Bun global | TS updater runs `bun add -g ...@preview` | Node/Bun-created shim → packaged Go | Go GitHub release + SHA-256 |
| new npm global | npm lays down package files | Node shim → packaged Go | Go GitHub release + SHA-256 |
| new Bun global | Bun lays down package files | shim → packaged Go | Go GitHub release + SHA-256 |
| Go GUI/management update | production executor calls native `runUpdate --tag`; npm is optional integrity metadata | Go stays active | GitHub release + SHA-256 |

The legacy TS GUI still follows its detected npm/Bun manager. The Go management
executor is already native, although it currently labels checks as `InstallerNPM`
and may query npm for non-fatal integrity metadata. That stale reporting/preflight is
separate from the actual binary replacement.

## Release blockers in the current tree

- `.github/workflows/release.yml:62-73` sets up Bun and Node, not Go.
- `.github/workflows/release.yml:250-260` packs/publishes before any native build.
- `.github/workflows/release.yml:374-380` creates the GitHub release without
  attaching binaries, so the native resolver cannot find its required assets.
- `.github/workflows/ci.yml:109-134` explicitly tests the bundled-Bun package and
  has no Go setup in the npm-global job.
- `.gitignore:1-12` ignores `dist/` but not generated `bin/native/`.
- Existing TS services, tray entries, and shims bake the package-local Bun executable
  and `src/cli/index.ts`; transition tests must prove the old updater rebakes them
  through the new Go launcher before package-local Bun disappears.
- Native `ocx update` replaces the embedded Go child, not npm package metadata or
  the JS launcher. Runtime version may therefore advance ahead of package version;
  this is an explicit native-channel contract, not silently treated as package parity.

## Honest completion statement after current-dev rebase

The surviving Go package inventory had reached 30/30 S3 before the rebases and the
declared strict byte matrix remains green, but the new oracle capability
families are not yet ported. The default npm package is also still a Bun/TS package
because release staging is absent. R10 may restore a 30/30 S3 statement only after
every current-dev drift phase and the bridge phases pass production-root tests. Whole-product
evidence remains bounded by live credentials, real service managers/desktops, and
external networking; those are not converted into a 100% claim.
