/**
 * The canonical Material 3 status-pill tone map.
 *
 * Promoted from the prototype's single `badgeStyle(tone)` helper
 * (`design/OpenCodex M3.dc.html`), which is the one place the five tone
 * colours were ever decided. Before this existed, ClaudeDesktop, Startup,
 * Changelog, Notifications and Logs each carried their own hand-rolled copy
 * of the tone map, and three of the five disagreed about what "neutral"
 * looks like — the same status pill sat on `secondary-container` on one
 * screen, `surface-container-low` on another, and the right
 * `surface-container-highest` only by accident on a third.
 * `BADGE_TONE_STYLE` is now the single place that decision is made; every
 * screen that renders a status pill resolves its colour through it —
 * directly, or through `shell/m3-ui.tsx`'s `Badge` component — instead of
 * re-declaring one.
 *
 * Kept in its own component-free module, the same way
 * `gui/src/components/codex-account-pool-m3.ts` keeps its own colour
 * constants separate from the components that use them: `m3-ui.tsx` also
 * exports components, and `react-refresh/only-export-components` requires a
 * file that does to export nothing else. `codex-account-pool-m3.ts` keeps
 * its own copy of these same values on purpose — it predates this file and
 * moving it would touch the Codex account cards' Fast Refresh boundary for
 * no visual change — but its values are covered by
 * `tests/badge-tone-single-source.test.ts`, so the two cannot drift apart
 * without the test noticing.
 */

import type { CSSProperties } from "react";

export type BadgeTone = "ok" | "warn" | "error" | "neutral" | "accent";

export const BADGE_TONE_STYLE: Record<BadgeTone, CSSProperties> = {
  ok: { background: "var(--m3-ok-container)", color: "var(--m3-on-ok-container)" },
  warn: { background: "var(--m3-warn-container)", color: "var(--m3-on-warn-container)" },
  error: { background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" },
  neutral: { background: "var(--m3-surface-container-highest)", color: "var(--m3-on-surface-variant)" },
  accent: { background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" },
};
