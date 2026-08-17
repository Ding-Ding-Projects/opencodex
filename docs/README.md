# Historical Notes

This folder contains investigations and diagnostic notes. It is not the primary user manual and it
is not the maintainer source of truth for current invariants.

- Public user workflows live in [`../docs-site/`](../docs-site).
- Current maintainer invariants live in [`../structure/`](../structure).
- Keep files here when the detail is useful for archaeology, debugging, or source research.

A feature that is still true today does not belong here alone. Write it where it can be found — a
`docs-site/` page for anything a user does, a `structure/NN_topic.md` entry for an invariant a
maintainer must not break — and leave a note here only for the investigation behind it.

## One exception, deliberately

| File | What it is |
| --- | --- |
| [`FEATURE-INVENTORY.md`](FEATURE-INVENTORY.md) | The hand-written, per-surface completeness inventory. **This one is a source of truth** and is current, not archaeology. |

It sits here rather than in `structure/` because it is not an invariant — it is a status, and its
whole value is that it changes. It sits here rather than in `docs-site/` because it is addressed at
maintainers and reads as an indictment, which is not what a user wants from a documentation site.
`ROADMAP.md` points at it as the authority on feature completeness.

## Categories

| Category | What it holds |
| --- | --- |
| [`adr/`](adr/README.md) | Architecture Decision Records: why a shape was chosen, and what was rejected. |
| [`design-system/`](design-system/README.md) | The GUI design system's usage contract, plus the Material 3 port handoff. |
| [`superpowers/`](superpowers/README.md) | Dated design specs and the implementation plans executed from them. |

## Loose investigations

| Note | Subject |
| --- | --- |
| [`codex-app-model-catalog.md`](codex-app-model-catalog.md) | How Codex App reads the shared model catalog (2026-06-20). |
| [`codex-path-investigation.md`](codex-path-investigation.md) | Where Codex resolves its home and binaries from (2026-06-19). |
| [`github-copilot-app.md`](github-copilot-app.md) | Using opencodex as an OpenAI-compatible provider for the Copilot desktop app. |
| [`shadow-call-intercept.md`](shadow-call-intercept.md) | What shadow calls are and how they are intercepted. |
