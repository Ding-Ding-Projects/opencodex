# Release line-count attribution

Every release reports a reproducible line-count table for the exact commit it
ships. The committed counter is the only supported source for that evidence:

```powershell
bun run scripts/count-lines.ts
bun run scripts/count-lines.ts --json
```

The Markdown form is suitable for release notes. The JSON form carries the same
rows and totals for automation and verification. Do not replace either command
with an ad-hoc file scan or a hand-entered total.

## Counting contract

The counter resolves the requested revision to a commit and reads the paths
returned by NUL-delimited `git ls-tree -r --name-only` for that commit. It reads
each file from the corresponding Git blob, so a sparse checkout cannot make a
tracked path disappear. Untracked files, ignored files, dependency directories, caches, and
build output are therefore outside the count. Tracked images, fonts, and other
binary assets are reported as file counts, not assigned invented line counts.
Text files larger than the documented per-file limit, files containing a NUL
byte, and files that cannot be decoded are reported as unreadable rather than
silently included or guessed.

Each counted text file is assigned to exactly one first-match bucket. A final
catch-all bucket prevents an unfamiliar tracked text path from disappearing
from the report. The counter records both physical lines and non-blank lines;
a final unterminated line counts once, while a trailing newline does not create
an extra line.

Generated content is visible but separate from hand-written source. The
generated row currently includes the generated icon source and dim-sum
catalogue data. Tests, product source, styles, documentation, tooling, and
configuration remain separate rows. This preserves the grand total while
making generated volume explicit.

## Surviving-line attribution

Authorship is attributed from `git blame` for the lines that survive at the
release commit. It is not calculated by summing additions from commit history:
deleted or replaced lines are not part of the shipped tree and therefore are
not attributed to anyone in the release report.

A surviving line is agent-authored when its blamed commit meets at least one of
these conditions:

1. The commit author is a configured automation identity.
2. The commit message contains a valid `Co-Authored-By` trailer naming a
   configured agent identity.

All other surviving lines are reported as person-authored. The release evidence
must state the identity rule used, so the classification can be independently
checked. Merge commits do not transfer authorship: attribution follows the
blamed source commit for each surviving line.

Blank lines remain surviving physical lines and are attributed to their blamed
commit. The separate non-blank column is descriptive; it is not the attribution
basis. Binary assets and excluded files receive no line attribution. Generated text
is attributed within its separate generated row so that it remains visible,
but it must not be presented as hand-written source. Uncommitted changes cannot
appear because the release counter runs against the tagged commit.

## Arithmetic invariants

The report is invalid unless all of these equalities hold:

- the sum of bucket file counts equals the reported counted-file total;
- the sum of bucket physical lines equals the reported physical-line total;
- the sum of bucket non-blank lines equals the reported non-blank-line total;
- agent-authored surviving lines plus person-authored surviving lines equals the
  corresponding attributed line total;
- the attributed line total equals the counted physical-line total.

The counter must exit unsuccessfully if any equality fails. It must never
publish a partial attribution table, silently assign an attribution gap to
“unknown,” or round away a discrepancy.

## Determinism and resource bounds

For one repository state and one counter version, repeated runs must produce
the same rows, ordering, totals, and attribution. Paths and identities are
normalized by committed rules rather than locale-dependent heuristics. Numeric
formatting in the Markdown output is fixed to `en-US`; JSON values remain
numbers.

Repository discovery uses NUL-delimited Git output so spaces and Unicode in
paths cannot split records. Child-process output and file reads have explicit
bounds. Oversized or unreadable input is surfaced as a failure or an explicit
unreadable count, never allowed to consume unbounded memory. Attribution uses
the local repository history for the pinned commit; a partial clone that lacks
required blobs must materialize that history before the release run rather than
degrading to an incomplete result.

## Release usage

Release automation runs the committed counter in the tagged checkout after the
candidate commit is fixed and before release notes are published. The release
notes include the exact command, the complete table, the shipped commit, the
classification rule, and any asset or unreadable-file counts. A manual release
uses the same command and evidence; it does not copy a number from an earlier
release or from a different working tree.

The counter output is evidence about one commit only. Any source change after a
run makes that output stale and requires a new run. A release must not claim
line-count attribution when the counter failed, the commit differs, required
history was unavailable, or an arithmetic invariant was not verified.

## Failure modes

The counter fails closed for conditions that would make the published evidence
misleading, including:

- `git ls-tree`, blob reads, or `git blame` failing;
- a missing object, shallow-history gap, or unreadable blamed commit;
- malformed or ambiguous author or co-author identity data;
- a counted file assigned to zero or multiple buckets;
- an attribution class outside the committed identity policy;
- a generated file being folded into a hand-written row;
- a negative, non-integer, or internally inconsistent count;
- any bucket, total, or attribution arithmetic mismatch;
- process output exceeding its configured bound.

An excluded binary or an explicitly reported unreadable text file is not
silently treated as zero lines. The report names the condition so a reviewer
can distinguish a deliberate exclusion from missing evidence.

## Verification inventory

The release verification record must retain all of the following:

| Evidence | Required proof |
| --- | --- |
| Commit binding | The counter ran in the checkout for the exact released commit. |
| Tracked-file basis | File discovery came from NUL-delimited `git ls-tree` at the resolved commit. |
| Bucket completeness | Every counted text file matched exactly one bucket, including the catch-all. |
| Generated separation | Generated files were reported in their explicit generated row. |
| Exclusions | Binary assets, ignored/untracked content, oversized text, and unreadable text were reported according to the contract. |
| Surviving-line basis | Attribution came from `git blame` at the released commit, not historical added-line totals. |
| Identity policy | Automation authors and valid agent co-author trailers were classified by the committed allowlist; other lines were human-authored. |
| Arithmetic | Bucket sums, attribution sums, and reported totals were equal. |
| Determinism | A repeated run at the same commit produced identical machine-readable output. |
| Bounds | Oversized file and child-process-output cases failed or reported the documented bounded outcome. |
| Release rendering | The release notes contained the exact command, full table, classification rule, and commit identifier. |
| Negative regressions | Deliberately breaking the catch-all, generated classification, identity rule, or arithmetic equality made verification fail; restoring each condition made it pass. |

The focused automated tests should validate the inventory without pinning a
line total that naturally changes on every commit. A green test is meaningful
only after the corresponding negative regression has been observed to fail.
