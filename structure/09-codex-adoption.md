# Pre-substrate Codex home adoption (contract slice)

`src/codex/adoption.ts` implements and tests the publication seam required before a routed home
can enter the write coordinator. A retained apply or restore intent is the only positive authority.
The module writes a complete version-1 `adoption-pending` row to a unique temporary database,
attempts a mode-0600 and full-fsync preparation, and publishes with atomic no-replace hard-link
creation. A second contender observes the winner and cannot replace it.

The executable tests cover routed residue, indeterminate residue, legacy records, clean homes,
pre-existing unversioned/rowless files, retained apply/restore operations, and a second opener.
Malformed existing database bytes are classified as rowless instead of being overwritten.

This is the safe first stage, not a claim that all native callers have been rewired. The current
`injectCodexConfig` and `restoreNativeCodex` paths still need to enter this positive-authority
handoff before their first native write, and the child-process crash checkpoints plus a real
two-process publication race remain follow-up rows for #1049.
