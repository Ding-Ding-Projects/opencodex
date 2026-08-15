import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Six-lane design audit finding: there was no shared Badge, so the same
 * status tone rendered a different colour depending which screen it was on.
 * ClaudeDesktop's model badges sat their "neutral" tone on
 * `secondary-container` / `on-secondary-container`; Startup's hero sat its
 * "neutral" on `surface-container-low` / `on-surface`; Notifications' "info"
 * chip sat on `surface-container-high` (not `-highest`) / `on-surface-variant`
 * — three different colour pairs for what the prototype's single
 * `badgeStyle(tone)` helper (`design/OpenCodex M3.dc.html`) says is one tone.
 * Changelog and Logs each carried a fourth and fifth independent copy of the
 * same map, one of which (Changelog) happened to already be correct — which
 * is exactly the kind of drift that is invisible until two screens are
 * compared side by side.
 *
 * `BADGE_TONE_STYLE` in `shell/badge-tone.ts` (re-exported from
 * `shell/m3-ui.tsx`, whose `Badge` component renders it) is now the one
 * place this decision is made. This guard enforces two things, because
 * either alone is defeatable:
 *
 *  1. the canonical map still holds exactly the prototype's five tones and
 *     their exact role-token pairs (a positive check on the source of truth);
 *  2. none of the screens this audit found hand-rolling their own copy have
 *     reintroduced one (a negative check against a hand-written list of
 *     those exact screens — not a repo-wide sweep, which would also trip on
 *     pre-existing, unrelated tone pairs elsewhere in the app that this task
 *     did not touch and were never reported as drifted).
 *
 * `codex-account-pool-m3.ts` is the one deliberate exception: it already
 * matched the canonical values before this fix, and moving it would touch
 * the Codex account cards' Fast Refresh boundary (it is a "component-free
 * module" on purpose, per its own header comment) for no visual change. It
 * gets its own parity check instead of a free pass — if it and the canonical
 * map are ever edited out of sync, that check fails.
 *
 * A follow-up pass swept every other screen for `background: "var(--m3-*-container…)"`
 * (LanguageVoice, Usage, history-payload, VersionHistory, AppLogoPicker,
 * SecretHistoryDialog, api-keys-panels, Storage, claude-code-sections,
 * Subagents) looking for the same drift shape, then ran this file's own
 * `handRolledPairSpan` proximity detector against all ten by hand. It found
 * four spans that technically pair a canonical tone's two role tokens —
 * a ternary'd "neutral" pair in LanguageVoice's funny-level ladder, a hand-rolled
 * "error" pair in VersionHistory's server-failure alert, and hand-rolled
 * "error"/"accent" pairs in api-keys-panels' delete-dialog medallion and
 * reveal-once-key card — and rejected every one, because none of them is a
 * small pill-shaped status label: they are a selected/unselected list row, a
 * full-width `role="alert"` banner, a 56px icon medallion, and a whole
 * `<Card>` background. None belongs behind `Badge`, so `CALL_SITES` above
 * gains no new entries from this pass. The rest of those ten files' container
 * backgrounds are stat tiles, progress-bar tracks, code/JSON panels, crop
 * previews, preset-selection tiles and list panels — none of them tone-keyed
 * at all. One further finding, `claude-code-sections.tsx`'s alias pill, *is*
 * a pill but is styled on `--m3-secondary-container`, which is not one of
 * `BADGE_TONE_STYLE`'s five tones — it is the prototype's "tonal chip" look,
 * a different, deliberate design decision rather than drift from this map.
 *
 * The VersionHistory.tsx banner is worth a second look under a different
 * task: it hand-rolls exactly the same role-token pair `Banner tone="error"`
 * already renders via CSS classes in `m3-ui.tsx`, so it is real duplication —
 * just not of `BADGE_TONE_STYLE`, and not in badge shape, so it sits outside
 * this guard's scope.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const BADGE_TONE = join(SRC, "shell", "badge-tone.ts");
const M3_UI = join(SRC, "shell", "m3-ui.tsx");
const ACCOUNT_POOL = join(SRC, "components", "codex-account-pool-m3.ts");

/** The prototype's five tones, verbatim. */
const CANONICAL: Record<string, { background: string; color: string }> = {
  ok: { background: "var(--m3-ok-container)", color: "var(--m3-on-ok-container)" },
  warn: { background: "var(--m3-warn-container)", color: "var(--m3-on-warn-container)" },
  error: { background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" },
  neutral: { background: "var(--m3-surface-container-highest)", color: "var(--m3-on-surface-variant)" },
  accent: { background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" },
};

/** Every screen this audit found hand-rolling its own copy of the map. */
const CALL_SITES = [
  join(SRC, "pages", "ClaudeDesktop.tsx"),
  join(SRC, "pages", "startup-sections.tsx"),
  join(SRC, "pages", "Changelog.tsx"),
  join(SRC, "pages", "Notifications.tsx"),
  join(SRC, "pages", "Logs.tsx"),
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detects the two role tokens of one tone appearing paired, in either order,
 * within a short window — the exact shape of a hand-rolled tone entry such as
 * `{ background: "var(--m3-ok-container)", color: "var(--m3-on-ok-container)" }`.
 * A short window (not a whole-file scan) matters: `--m3-surface-container-highest`
 * and `--m3-on-surface-variant` each appear all over the app for unrelated
 * reasons, and only their *proximity* marks a hand-rolled badge pair.
 */
function handRolledPairSpan(source: string, background: string, color: string): string | null {
  const bg = escapeRe(background);
  const fg = escapeRe(color);
  const forward = new RegExp(`${bg}[\\s\\S]{0,120}?${fg}`);
  const backward = new RegExp(`${fg}[\\s\\S]{0,120}?${bg}`);
  const match = source.match(forward) ?? source.match(backward);
  return match ? match[0] : null;
}

test("badge-tone.ts exports the canonical five-tone badge map, unchanged from the prototype", () => {
  const source = readFileSync(BADGE_TONE, "utf8");
  expect(source).toMatch(/export const BADGE_TONE_STYLE/);
  for (const [tone, { background, color }] of Object.entries(CANONICAL)) {
    expect(handRolledPairSpan(source, background, color), `missing "${tone}" pair in badge-tone.ts`).not.toBeNull();
  }
});

test("m3-ui.tsx's Badge re-exports the canonical map rather than declaring its own", () => {
  const source = readFileSync(M3_UI, "utf8");
  expect(source).toMatch(/export function Badge\(/);
  expect(source).toMatch(/from ["']\.\/badge-tone["']/);
  // The map itself must not be re-declared here — only imported/re-exported —
  // or m3-ui.tsx grows a *second* place this decision can be made.
  expect(source).not.toMatch(/export const BADGE_TONE_STYLE\s*:/);
  for (const [tone, { background, color }] of Object.entries(CANONICAL)) {
    expect(handRolledPairSpan(source, background, color), `"${tone}" pair hand-rolled in m3-ui.tsx`).toBeNull();
  }
});

test("codex-account-pool-m3.ts's independent copy still matches the canonical values", () => {
  const source = readFileSync(ACCOUNT_POOL, "utf8");
  for (const [tone, { background, color }] of Object.entries(CANONICAL)) {
    expect(handRolledPairSpan(source, background, color), `"${tone}" pair drifted in codex-account-pool-m3.ts`).not.toBeNull();
  }
});

test("none of the previously-drifted screens hand-roll a badge tone pair anymore", () => {
  const offenders: string[] = [];
  for (const file of CALL_SITES) {
    const source = readFileSync(file, "utf8");
    for (const [tone, { background, color }] of Object.entries(CANONICAL)) {
      const hit = handRolledPairSpan(source, background, color);
      if (hit) offenders.push(`${file.slice(SRC.length + 1)} hand-rolls the "${tone}" tone pair: ${hit}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("every previously-drifted screen now sources its badge tones from the shared map", () => {
  for (const file of CALL_SITES) {
    const source = readFileSync(file, "utf8");
    const rel = file.slice(SRC.length + 1);
    expect(source, `${rel} does not import from shell/m3-ui`).toMatch(/from ["']\.\.\/shell\/m3-ui["']/);
    expect(source, `${rel} imports neither BADGE_TONE_STYLE nor Badge`).toMatch(/\b(?:BADGE_TONE_STYLE|Badge)\b/);
  }
});
