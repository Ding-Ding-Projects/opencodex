/**
 * Runtime appearance for the docs site.
 *
 * The token engine is imported through `shared/m3/tokens.ts` rather than
 * copied. A copy would drift the moment either side is touched, and "the site
 * looks almost like the app" is the failure this rewrite exists to end. One
 * engine, one set of roles, two surfaces.
 *
 * Preferences live under their own key: a visitor to the published site is not
 * the same person as the operator of a local dashboard, and reading the app's
 * key here would let a docs visit silently inherit — or worse, appear to
 * change — settings that belong to an install they may not even have.
 */

import {
  DEFAULT_SEED,
  SEED_SWATCHES as SHARED_SEED_SWATCHES,
  applyTokens,
  type DensityLevel,
  type ThemeMode,
} from "../../../shared/m3/tokens";

export const STORAGE_KEY = "ocx-docs:appearance";

export interface DocsAppearance {
  theme: ThemeMode;
  seed: string;
  density: DensityLevel;
  fontId: FontId;
  fontScale: number;
  fontWeight: number;
}

/**
 * Families offered by name.
 *
 * Only faces this site actually ships, or generic families every platform has.
 * An earlier list offered "Roboto Flex" and "Roboto" — neither is bundled here
 * (the site ships Geist and Pretendard), so choosing them silently fell back to
 * whatever the OS happened to have. A picker whose options do not do what they
 * say is worse than a shorter picker.
 *
 * Each stack carries a CJK-safe tail so the Cantonese copy renders.
 */
export const FONT_STACKS: { id: FontId; label: string; stack: string }[] = [
  { id: "geist", label: "Geist", stack: '"Geist Variable", "Pretendard Variable", system-ui, sans-serif' },
  { id: "system", label: "System UI", stack: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "serif", label: "Serif", stack: 'Georgia, "Times New Roman", serif' },
  { id: "mono", label: "Monospace", stack: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace' },
];

export type FontId = "geist" | "system" | "serif" | "mono";

/**
 * The stack for an id, falling back to the first offered family.
 *
 * Preferences store the *id*, never the CSS value. A stored stack is a string
 * that goes straight into `style.setProperty`, so persisting one means trusting
 * whatever is in storage to be a valid font list; storing an id and resolving
 * it here means a corrupted or hand-edited entry can only ever select one of
 * four known-good stacks.
 */
export function fontStackFor(id: FontId): string {
  return (FONT_STACKS.find(f => f.id === id) ?? FONT_STACKS[0]).stack;
}

export const DEFAULT_APPEARANCE: DocsAppearance = {
  theme: "system",
  seed: DEFAULT_SEED,
  density: 4,
  fontId: "geist",
  fontScale: 1,
  fontWeight: 400,
};

/**
 * Seeds offered as swatches. Any hex is accepted; these are just shortcuts.
 *
 * Taken from the shared module rather than restated. The site used to carry its
 * own eight, six of which were different colours from the dashboard's eight —
 * so "the green one" meant two different greens depending on which surface you
 * were looking at, for no reason anyone had decided.
 */
export const SEED_SWATCHES: readonly string[] = SHARED_SEED_SWATCHES;

function clampDensity(value: unknown): DensityLevel {
  const n = Math.round(Number(value));
  return (n >= 1 && n <= 5 ? n : 4) as DensityLevel;
}

/** A hex colour, or null. Rejects anything that would land in a CSS value. */
export function normalizeSeed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : null;
}

export function readAppearance(storage?: Pick<Storage, "getItem">): DocsAppearance {
  try {
    const store = storage ?? localStorage;
    const raw: unknown = JSON.parse(store.getItem(STORAGE_KEY) || "null");
    if (!raw || typeof raw !== "object") return DEFAULT_APPEARANCE;
    const row = raw as Partial<DocsAppearance>;
    const scale = Number(row.fontScale);
    const weight = Number(row.fontWeight);
    return {
      theme: row.theme === "light" || row.theme === "dark" ? row.theme : "system",
      seed: normalizeSeed(row.seed) ?? DEFAULT_APPEARANCE.seed,
      density: clampDensity(row.density),
      fontId: FONT_STACKS.some(f => f.id === row.fontId) ? row.fontId as FontId : DEFAULT_APPEARANCE.fontId,
      // Clamped at read rather than trusted: these land in CSS, and a
      // hand-edited or corrupted entry should not be able to render the site
      // unreadable with no way back to the settings that would fix it.
      fontScale: Number.isFinite(scale) && scale >= 0.8 && scale <= 1.6 ? scale : 1,
      fontWeight: Number.isFinite(weight) && weight >= 300 && weight <= 700 ? weight : 400,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function writeAppearance(next: DocsAppearance, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? localStorage).setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private browsing or a full quota. The theme still applies to this page;
    // it simply will not survive a reload, which is better than failing to
    // render the change the visitor just asked for.
  }
}

/** True when the resolved theme should be dark. */
export function isDark(theme: ThemeMode): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Starlight's own theme store, written by the header's Auto→Light→Dark button. */
const STARLIGHT_THEME_KEY = "starlight-theme";

/**
 * Non-zero while we are writing `data-theme` ourselves, so the observer below
 * does not mistake our own write for the reader's.
 *
 * A counter released on a microtask, not a boolean released on the next line.
 * `MutationObserver` delivers at the microtask checkpoint — *after* the
 * synchronous block that caused the mutation — so a flag set and cleared around
 * `setAttribute` is always back to `false` by the time the observer looks at it.
 * The observer then adopts our own write as if the reader had made it and calls
 * `applyAppearance` again, which mutates the attribute again, which re-enters
 * the observer. `setAttribute` queues a mutation record even when the value is
 * identical, so nothing about that cycle converges.
 *
 * The result was a microtask loop, and a microtask loop never yields to the
 * event loop: the page painted, then froze before `load` with the main thread
 * unreachable — a docs site permanently "loading". A counter rather than a
 * boolean because two applies in one turn would otherwise have the first one's
 * release clear the second one's guard.
 */
let applying = 0;

/** Hold the guard across the microtask checkpoint where the observer runs. */
function guardOurOwnWrite(): void {
  applying++;
  queueMicrotask(() => { applying--; });
}

/**
 * Paint an appearance onto the document.
 *
 * `data-theme` is set as well as the tokens because Starlight keys its own
 * component styles off that attribute — writing only the custom properties
 * would leave Starlight's chrome in the other theme.
 *
 * Starlight's store is written too, and that is not redundant. The header ships
 * its own theme button, and `applyTokens` writes every role as an *inline*
 * style, which outranks the `:root[data-theme=…]` blocks in the stylesheet. So
 * without this the two controls silently fight: pressing the header's button
 * flipped the attribute while the inline tokens kept the old colours, leaving a
 * button labelled "Light" over an entirely dark page. Keeping both stores in
 * step is what makes them one setting with two front doors.
 */
export function applyAppearance(appearance: DocsAppearance, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  const dark = isDark(appearance.theme);
  guardOurOwnWrite();
  el.setAttribute("data-theme", dark ? "dark" : "light");
  try {
    localStorage.setItem(STARLIGHT_THEME_KEY, appearance.theme === "system" ? "auto" : appearance.theme);
  } catch { /* private mode */ }
  applyTokens(el, {
    seed: appearance.seed,
    dark,
    density: appearance.density,
    fontStack: fontStackFor(appearance.fontId),
    fontScale: appearance.fontScale,
    fontWeight: appearance.fontWeight,
  });
}

/**
 * Re-derive the tokens whenever something else changes `data-theme`.
 *
 * The other something is Starlight's header button, which flips the attribute
 * and persists its own key but knows nothing about M3 roles. Watching the
 * attribute rather than patching Starlight keeps this working if that component
 * is restyled or replaced.
 *
 * Returns a disposer.
 */
export function watchExternalThemeChanges(read: () => DocsAppearance): () => void {
  const el = document.documentElement;
  const observer = new MutationObserver(() => {
    if (applying) return;
    const attr = el.getAttribute("data-theme");
    if (attr !== "dark" && attr !== "light") return;
    const current = read();
    // Nothing to adopt if the attribute already says what our own state
    // resolves to. This is the structural half of the loop guard: the timing
    // guard above depends on the observer running at the microtask checkpoint
    // we expect, whereas this one holds no matter who wrote the attribute or
    // when. A "system" reader in a dark OS resolves to exactly the "dark" that
    // is already there, so the mutation carried no new information and
    // re-applying it would only mutate the attribute again.
    if (attr === (isDark(current.theme) ? "dark" : "light")) return;
    // Only the theme is adopted; seed, density and type stay the visitor's.
    applyAppearance({ ...current, theme: attr });
    writeAppearance({ ...current, theme: attr });
  });
  observer.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/* ------------------------------------------------- view-transition survival -- */

/** Registered once per document; the listeners below outlive every page swap. */
let runtimeInstalled = false;

/**
 * Keep the appearance alive across client-side navigations.
 *
 * This is not defensive programming, it is a required repair. Astro's view
 * transition swap calls `swapRootAttributes`, which **removes every attribute
 * from `<html>`** and replaces them with the incoming document's. Two things
 * die there: `data-theme`, and the inline `style` attribute carrying all
 * thirty-nine `--m3-*` role tokens that `applyTokens` wrote. Worse, Starlight's
 * server render pins `data-theme="dark"` on every page, so a reader in light
 * mode gets flipped to dark by the swap itself — and the `data-theme` observer
 * above would then see that flip, believe the reader asked for it, and persist
 * it. One navigation and their theme is gone.
 *
 * So: suppress the observer for the duration of the swap, then re-apply the
 * stored appearance in `astro:after-swap`, which runs before the new page is
 * painted. The swap's own attribute write has to stay suppressed from
 * `before-swap` until after the observer has run, which is why the guard is
 * taken in one listener and released in the other rather than around a single
 * call — `guardOurOwnWrite` releases on the next microtask, far too early to
 * cover a swap.
 *
 * Idempotent, because it is called from an `astro:page-load` handler that fires
 * on every navigation as well as the first load.
 */
export function installAppearanceRuntime(read: () => DocsAppearance): void {
  if (runtimeInstalled) return;
  runtimeInstalled = true;

  document.addEventListener("astro:before-swap", () => { applying++; });
  document.addEventListener("astro:after-swap", () => {
    applyAppearance(read());
    // Release the `before-swap` hold only after the observer's checkpoint, so
    // the swap's own write to `data-theme` is never mistaken for the reader's.
    queueMicrotask(() => { applying--; });
  });

  // A visitor on "System" should follow the OS while the page is open.
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const current = read();
      if (current.theme === "system") applyAppearance(current);
    });
  }

  watchExternalThemeChanges(read);
}
