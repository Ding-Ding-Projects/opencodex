# 004 — Changed-plan A audit round 1 synthesis

Fresh reviewer verdict: `FAIL`, four High blockers.

| Blocker | Root cause | Disposition |
| --- | --- | --- |
| H1 | 011 showed complete prepare-package body outside diff fences | Accepted: encode it as an apply-ready delete/add replacement patch. |
| H2 | 031 was generated against baseline, not expected 011→021 tree | Accepted: regenerate 031 after applying 011 then 021 and prove sequential check. |
| H3 | 020 promised immutable updater proof but 021 only patched lifecycle owners | Accepted: add an immutable pre-bridge fixture that executes old process call shapes against new service/tray owners; add updater hunks only for future runs, not as proof of first transition. |
| H4 | 031 reintroduced `codex-shim install` after 021 established wrapper-only `refresh` | Accepted: delete the overlapping install repair and preserve 021 refresh unchanged. |

No conflict exists between disposable staging, same-major update, or one-tarball
release provenance. Re-audit must apply the full patch series in dependency order,
not each appendix only against baseline.
