# Architecture Decision Records

One file per decision, numbered in the order it was taken. An ADR records *why* a shape was chosen
and what was rejected; it is not a manual. When the behaviour it describes changes, add a new ADR
that supersedes it rather than rewriting history here.

Current invariants live in [`../../structure/`](../../structure); user-facing behaviour lives in
[`../../docs-site/`](../../docs-site).

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-gui-update-worker.md) | GUI self-update runs through a worker job | Accepted |
| [0002](0002-doctor-proxy-env-diagnostics.md) | Doctor separates shell proxy env from the running proxy's process env | Accepted |
| [0003](0003-deepseek-v4-thinking-history.md) | DeepSeek V4 thinking history is model-scoped metadata | Accepted |
| [0004](0004-gui-toggle-contrast-and-nav-spacing.md) | GUI toggle contrast and sidebar item spacing | Accepted |
| [0005](0005-gui-design-token-system.md) | GUI uses role-based CSS design tokens | Accepted |
| [0006](0006-provider-output-defaults-and-web-search-replay.md) | Provider output defaults and web-search replay privacy | Accepted |
| [0007](0007-headless-cli-parity.md) | Headless CLI parity through the management control plane | Accepted |

## Adding one

Take the next unused number, keep the filename `NNNN-kebab-case-title.md`, and open with
`# ADR NNNN: <decision>` followed by `## Status`, `## Context`, `## Decision`, and the consequences.
Add the row above in the same change — an index that has to be regenerated from the directory is an
index nobody trusts.
