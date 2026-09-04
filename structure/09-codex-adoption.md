# Pre-substrate Codex home adoption (contract slice)

`src/codex/adoption.ts` implements and tests the publication seam required before a routed home
can enter the write coordinator. A retained apply or restore intent is the only positive authority.
The module writes a complete version-1 `adoption-pending` row using the exact transition schema,
including `history_pending_rows` and `history_backup_entries`, to a unique temporary database,
attempts a mode-0600 and full-fsync preparation, and publishes with atomic no-replace hard-link
creation. A second contender observes the winner and cannot replace it.

The executable tests cover routed residue, indeterminate residue, legacy records, clean homes,
pre-existing unversioned/rowless files, retained apply/restore operations, and a second opener.
Malformed existing database bytes are classified as rowless instead of being overwritten.

The retained `injectCodexConfig` and `restoreNativeCodex` writers now enter this positive-authority
handoff before their first native write and advance the same opaque coordinator transaction. The
child-process crash checkpoints and two-process publication race are covered by
`tests/codex-adoption.test.ts`. Full history-worker convergence and every remaining native writer
still require separate review; this document does not claim the entire #1049 roadmap is closed.
