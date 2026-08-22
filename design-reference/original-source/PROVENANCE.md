# Original design-source provenance

This directory preserves the exact files that existed under `design/` at its
first committed introduction. It is the historical design-system source used
to keep later design-reference and parity work anchored to the original
material rather than to files added in later commits.

## Source commit

- Commit: `2879f5644046ee134cad8f2f73f6739846c4cbfe`
- Historical path: `design/`
- Copy root: `design-reference/original-source/`
- Purpose: preserve the first committed introduction of the design tree for
  deterministic source comparison and provenance review.

Only the 19 files present under `design/` in that commit are copied. The copy
strips only the leading `design/` component; file bytes are unchanged. The
later-added `design/shell/main.mjs` is intentionally excluded because it was not
present in the source commit.

## Deterministic verification

`MANIFEST.json` follows Git's deterministic tree order and records the source
commit, historical path, Git blob id, byte count, and SHA-256 for every file.
Recreate the historical list and compare every file with these commands from
the repository root:

```powershell
$manifest = Get-Content -Raw design-reference/original-source/MANIFEST.json | ConvertFrom-Json
$tree = @(git ls-tree -r -l --full-tree $manifest.sourceCommit -- design)
$expectedPaths = @(git ls-tree -r --name-only $manifest.sourceCommit -- design | ForEach-Object { $_.Substring(7) })
$actualPaths = @($manifest.files | ForEach-Object path)
if ($manifest.fileCount -ne $manifest.files.Count -or $manifest.fileCount -ne 19) { throw 'manifest file count mismatch' }
if (($expectedPaths -join "`n") -cne ($actualPaths -join "`n")) { throw 'historical path set mismatch' }
foreach ($entry in $manifest.files) {
  $copy = Join-Path design-reference/original-source $entry.path
  $blob = (git hash-object -- $copy).Trim()
  $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $copy).Hash.ToLowerInvariant()
  if ($blob -ne $entry.blob -or $sha256 -ne $entry.sha256) { throw "hash mismatch: $($entry.path)" }
}
if ($tree.Count -ne $manifest.fileCount) { throw 'historical tree count mismatch' }
Write-Output "verified $($manifest.fileCount) historical design files"
```

The command re-reads every copied file, compares its Git blob identity and
SHA-256 with the manifest, and checks that the historical tree has exactly 19
entries. The manifest's blob identities were generated directly from the same
historical tree, so a changed byte cannot pass either comparison.

No existing parity guard was editable within this lane: the repository's
focused parity-related tests live outside the allowed paths. The exact
historical-tree and per-file hash checks above are therefore the focused
verification record for this preservation change.

## Privacy-scan boundary

The privacy scanner may omit a copied historical file only when its path appears
in this manifest and its current bytes match both recorded hashes and the
historical `design/` tree. `MANIFEST.json` and this provenance file are never
part of that omission. The scanner also rejects unlisted, missing, malformed,
oversized, traversing, duplicate, symlinked, or modified entries, so adding a
new file or changing an old one cannot silently enlarge the exception.
