# 010 — WP1: deterministic native npm package staging

Literal implementation hunks: `011_wp1_literal_patch.md`.

## Outcome

Generate a clean `bin/native/` containing exactly the six version-matched Go
binaries and one checksum manifest before npm packing. Generated artifacts remain
ignored and reproducible.

## REUSE `scripts/build-go-release.go`

No production change is planned unless B discovers a concrete blocker. Its six-target
matrix, versioned names, `CGO_ENABLED=0`, `-trimpath`, Version ldflag, and checksum
manifest are already the canonical release format.

## MODIFY `scripts/prepare-package.ts` — exact contract

- Add exported `nativeArtifactNames(version)`, `validateNativeDirectory(path,
  version)`, `replaceNativeDirectory(stage, live, ops)`, and
  `verifyPackReport(reportPath, version)`.
- `--native` reads `package.json.version`, removes only the generated
  `bin/native` directory, and invokes:

```ts
const build = Bun.spawnSync([
  "go", "run", "scripts/build-go-release.go",
  "--version", version,
  "--output", relative(root, stage),
], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) throw new Error(`native build failed (${build.exitCode})`);
```

- `validateNativeDirectory` uses `lstatSync` and rejects symlinks, directories,
  empty files, extra names, missing names, wrong-version names, duplicate/malformed
  manifest rows, digest mismatches, and non-executable Unix binaries. It requires
  exactly six binaries plus `ocx_<version>_checksums.txt`.
- `bin/native` is disposable prepack output, never a live runtime set in the source
  checkout. Build writes directly there only after the old generated directory is
  removed. Any build/chmod/validation failure removes the partial directory and exits
  nonzero; `npm pack` never begins. The next run starts clean. No transaction,
  backup, marker, stale recovery, or cross-platform directory rename is required.
- `--verify-pack <pack.json>` validates npm's exact file inventory/modes/sizes,
  revalidates live checksums, and enforces:
  - each binary: 1 MiB ≤ size ≤ 40 MiB;
  - unpacked package: ≤ 256 MiB;
  - packed tarball: ≤ 192 MiB.
  The 40 MiB limit gives 66% headroom over the measured ~24 MiB binary; aggregate
  limits cover six binaries plus current GUI/source assets without allowing a
  duplicated runtime set.
- Never fetch the network or follow symlinks.

## MODIFY `package.json` — exact hunk

```diff
 "prepare:package": "bun scripts/prepare-package.ts",
-"prepack": "bun run prepare:package",
+"prepare:native-package": "bun scripts/prepare-package.ts --native",
+"verify:native-package": "bun scripts/prepare-package.ts --verify-pack pack.json",
+"test:native-launcher": "node --test scripts/ocx-native-launcher.test.mjs",
+"prepack": "bun run prepare:native-package && bun run prepare:package",
```
- Keep `bin` as the files boundary; it already includes `bin/native/**`.

## MODIFY `.gitignore` — exact hunk

```diff
 dist/
+/bin/native/
```

## MODIFY `tests/install-scripts.test.ts`

- Update the prepack expectation to the exact new command.
- Import the four exported preparation functions and add named tests:
  `native directory rejects stale and malformed artifacts`,
  `failed native build removes disposable partial output`,
  `native staging removes a stale prior version before build`, and
  `pack report enforces exact files modes and size limits`.
- Exact-limit fixtures pass; per-binary/packed/unpacked limit+1 fixtures fail.
- The checksum fixture flips one byte and asserts validation failure plus directory
  removal before packing.

## Check

```bash
npm pack --json > pack.json
bun run verify:native-package
```

The pack inventory must contain `bin/ocx.mjs`, `bin/native-runtime.mjs`, six
`bin/native/ocx_2.7.35_*` files, and one checksum manifest, with no other native
version. Record packed and unpacked sizes and the three enforced ceilings.
