# 002 — A-gate audit synthesis, round 1

Reviewer verdict: `FAIL`, eight High blockers and two Medium findings.

## Accepted and folded

| Finding | Root cause | Disposition |
| --- | --- | --- |
| H1 | Decade docs named intent but not exact owners/hunks/branches | Accepted. 010–050 now name exact existing files, command shapes, tests, limits, and trigger/observable paths; no planned NEW production file remains. |
| H2 | Old Bun/GUI repair spawned `process.execPath src/cli` after replacement | Accepted. WP2 now modifies both TS updater owners to invoke Node + fresh package launcher, keeps Bun dormant in the bridge, and adds the lifecycle matrix. |
| H3 | We promised runtime corruption detection without a runtime hash | Rebutted by narrowing the promise. Pack-time manifest/digest verification and native-download SHA remain mandatory; runtime mutable-package self-hashing was removed because an attacker able to replace both binary and adjacent manifest defeats it and every-launch hashing taxes startup. Symlinks/missing/mode still fail closed. |
| H4 | Go child could downgrade or cross launcher compatibility | Accepted. WP3 adds strict newer-only, same-major, channel-compatible checks; package-layout changes remain package-manager updates. |
| H5 | “atomic replace” omitted Windows rollback mechanics | Accepted. WP1 specifies same-parent owned stage/backup, lstat validation, chmod recheck, live→backup→stage sequence, exact cleanup, injected rename failure, and rollback tests. |
| H6 | npm and GitHub assets could come from different mutable sources | Accepted. WP4 publishes one retained tarball, extracts release assets from that tarball, pins setup-go by SHA, requires expected SHA, and executes a fake-tool dry-run mutation test. |
| H7 | Existing install/docs contracts would become stale | Accepted. WP1/WP3 now include `tests/install-scripts.test.ts`, `tests/docs-bun-source-requirement.test.ts`, README, CONTRIBUTING, and docs-site contributing text. |
| H8 | c0 evidence omitted WP5 | Accepted. Goalplan now requires 000/001 and 010 through 050. |
| M1 | Package size was observation-only | Accepted. WP1 sets 40 MiB per binary, 192 MiB packed, 256 MiB unpacked with boundary tests. |
| M2 | zero-match grep exits 1 | Accepted. WP5 wraps grep and asserts numeric zero. |

## Cross-blocker decision

Immediate deletion of the `bun` npm dependency conflicts with H2 for pre-bridge
updaters whose `process.execPath` points inside the package being replaced. The
roadmap therefore does not claim package-dependency removal in R10. It ships a bridge:
supported targets execute Go first, Bun remains dormant for recovery/API/source
compatibility, and later removal requires adoption or a major-cutover receipt. This
preserves the user's memory objective because the Bun process is not started.

## Re-audit packet

The same reviewer must verify:

1. no nonexistent test path remains;
2. c0 includes 050;
3. every accepted blocker is present in its owning decade doc;
4. the narrowed corruption promise is consistent across goalplan/docs;
5. Bun is described consistently as dormant bridge payload, not removed dependency;
6. the release plan derives npm and GitHub bytes from one tarball.

## Round 2 synthesis

Reviewer verdict: `FAIL`, four High blockers and one Medium.

- R1 accepted: phantom Go test owner removed; WP2 now gives complete NEW helper
  content and exact existing test functions. Other decade docs carry exact command
  and hunk contracts with no NEW production file left unspecified.
- R2 accepted: changing only updater code cannot affect an immutable old process.
  The bridge now changes the newly loaded service/tray/shim owners via
  `runtime-entry.ts`, so the first old updater persists Node launcher → Go while
  dormant Bun remains available for its final spawn.
- R3 accepted: objective, acceptance, write scope, goalplan objective, and criteria
  now authorize exact TS compatibility owners and consistently say Bun is retained
  but not executed on supported Go paths.
- R4 accepted: SHA wording now names the single optional→required strengthening;
  CI uses `npm run` and workflow `env:` instead of POSIX-only assignment.
- R5 accepted: deterministic marker/stage/backup names and state-based recovery are
  specified and tested at each rename boundary.

## Round 3 synthesis and P return

Reviewer verdict: `FAIL`, three High blockers. The A-loop reached its three-failure
bound, so the FSM was reset to P and the plan structure changed; see
`003_audit_round3_replan.md`.

- R1: each implementation decade now owns a separate literal-patch appendix
  (011/021/031/041), keeping rationale readable while making the patch executable.
- R2: cached shim is no longer promised to refresh inside the immutable update
  process. Dormant Bun keeps it safe; first fresh launcher invokes a new Go
  `codex-shim refresh` that rewrites the owned wrapper without PATH discovery.
- R3: transactional staging was deleted. Generated `bin/native` is disposable:
  clean → build → validate → pack; any failure cleans partial output and blocks pack.
