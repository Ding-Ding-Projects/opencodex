# Plans and Design Specs

Work-in-flight documents written before an implementation, kept afterwards for archaeology: a
`specs/` design that was approved, and the `plans/` task list that was executed from it. They are
dated snapshots of intent and are **not** updated to match what finally shipped — read the code,
[`../../structure/`](../../structure), or [`../../docs-site/`](../../docs-site) for current
behaviour.

## Specs

| Date | Design | Status as written |
| --- | --- | --- |
| 2026-07-26 | [OAuth reliability and client integrity](specs/2026-07-26-oauth-reliability-integrity-design.md) | Approved (Approach 1 + affinity policy A) |
| 2026-07-28 | [PR quality gates (ancestry + description)](specs/2026-07-28-pr-quality-gates-design.md) | Approved (brainstorm) |

## Plans

| Date | Plan | Implements |
| --- | --- | --- |
| 2026-07-26 | [OAuth reliability and client integrity](plans/2026-07-26-oauth-reliability-integrity.md) | the 2026-07-26 spec above |
| 2026-07-28 | [PR quality gates](plans/2026-07-28-pr-quality-gates.md) | the 2026-07-28 spec above |

## Naming

`YYYY-MM-DD-topic.md` in `plans/`, `YYYY-MM-DD-topic-design.md` in `specs/`, and a row here in the
same change. Checkbox state inside a plan reflects the session that wrote it, not the current tree.
