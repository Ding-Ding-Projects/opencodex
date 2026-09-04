# 011 — WP1 literal implementation contract: native npm staging

## Authority

Apply only the six-file candidate composed from base
`3f28468863f942adc6425e8b0912682a36b3aea4`:

| File | Add | Delete | Required effect |
| --- | ---: | ---: | --- |
| `.github/workflows/ci.yml` | 10 | 3 | Cross-OS Go setup and exact tarball/global-install proof |
| `.github/workflows/release.yml` | 17 | 7 | Pack once, verify, publish the same archive |
| `.gitignore` | 1 | 0 | Ignore `/bin/native/` |
| `package.json` | 5 | 2 | Native lifecycle plus fail-closed source publish |
| `scripts/prepare-package.ts` | 331 | 11 | Build, clean, validate, hash, and verify native package artifacts |
| `tests/install-scripts.test.ts` | 241 | 1 | Prove lifecycle, integrity, limits, modes, hashes, and JSON channel |

Canonical tracked-diff SHA-256:
`3b8c2bcb2b358606c3fadfd9b0c3e0e27a28313d1f82808e4133fbcdf834b310`.

Any deviation from those files, counts, or digest requires returning to P and
updating this contract before authoritative implementation.

## Exact lifecycle

`npm pack` runs:

```text
prepack
  -> bun scripts/prepare-package.ts --native
     -> rm -rf bin/native
     -> go run scripts/build-go-release.go --version <package version> --output bin/native
     -> chmod and exact validation
     -> remove bin/native and fail on any error
  -> bun scripts/prepare-package.ts
     -> normalize launcher/native/GUI modes
```

Direct `npm publish` from the source directory runs `prepublishOnly` and fails.
The official release workflow instead runs `build:publish`, performs the pack above,
verifies `pack.json`, and publishes exactly `./<report.filename>` with
`--ignore-scripts`.

The Go builder's stdout is captured and written to stderr. This is required because
`npm pack --json > pack.json` shares stdout with npm's machine-readable report.

## Exact native inventory

For `${version}` the generated directory must contain seven regular non-symlink
files and nothing else:

- `ocx_${version}_darwin_amd64`
- `ocx_${version}_darwin_arm64`
- `ocx_${version}_linux_amd64`
- `ocx_${version}_linux_arm64`
- `ocx_${version}_windows_amd64.exe`
- `ocx_${version}_windows_arm64.exe`
- `ocx_${version}_checksums.txt`

Each binary is `0755`, 1..40 MiB inclusive, and has one exact lowercase SHA-256 row
in lexicographic artifact order. The manifest is `0644`, ends in one newline, has
exactly six rows, and is revalidated against live bytes. Stale versions, extra files,
directories, symlinks, duplicate/malformed rows, empty files, and digest mismatches
fail closed.

## Exact pack requirements

The npm JSON report must describe one package only. Every entry must have a unique,
relative, in-root path with no symlink component, integer mode, non-negative
safe-integer size, and a live regular non-symlink file of the same size.

The report filename must be exactly `bitkyc08-opencodex-${version}.tgz`. That live
archive must be a regular non-symlink file whose byte size, SHA-1 `shasum`, and
SHA-512 `integrity` exactly match the report before any publish command runs.

The report must include:

- `bin/ocx.mjs` at `0755`;
- `bin/native-runtime.mjs` at `0644`;
- `bin/package-main.mjs` at `0644`;
- `gui/dist/index.html` at `0644`;
- exactly the seven native entries above, with binary `0755` and manifest `0644`.

Packed size must be at most 192 MiB and unpacked size at most 256 MiB.

## Evidence commands

```bash
bun test tests/install-scripts.test.ts
bun run typecheck
npm pack --json > pack.json
bun run verify:native-package
bun run build:gui
npm pack --json --ignore-scripts > pack-prepared.json
bun scripts/prepare-package.ts --verify-pack pack-prepared.json
actionlint .github/workflows/ci.yml .github/workflows/release.yml
OPENCODEX_RUNTIME=go <isolated-prefix>/bin/ocx version
```

The first pack from a clean clone must fail verification when GUI output is absent;
the prepared pack must pass with the receipt recorded in `010`.
