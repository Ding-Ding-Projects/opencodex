/**
 * Runtime appearance for the docs site.
 *
 * The dashboard's token engine is imported directly rather than copied. A copy
 * would drift the moment either side is touched, and "the site looks almost
 * like the app" is the failure this rewrite exists to end. One engine, one set
 * of roles, two surfaces.
 *
 * Preferences live under their own key: a visitor to the published site is not
 * the same person as the operator of a local dashboard, and reading the app's
 * key here would let a docs visit silently inherit — or worse, appear to
 * change — settings that belong to an install they may not even have.
 */

import {
  DEFAULT_SEED,
  applyTokens,
  type DensityLevel,
  type ThemeMode,
} from "../../../gui/src/theme/m3";

export const STORAGE_KEY = "ocx-docs:appearance";

export interface DocsAppearance {
  theme: ThemeMode;
  seed: string;
  density: DensityLevel;
  fontStack: string;
  fontScale: number;
  fontWeight: number;
}

/** Families offered by name, each with a CJK-safe tail so bilingual copy renders. */
export const FONT_STACKS: { id: string; label: string; stack: string }[] = [
  { id: "roboto-flex", label: "Roboto Flex", stack: '"Roboto Flex", "Roboto", "Noto Sans HK", system-ui, sans-serif' },
  { id: "system", label: "System UI", stack: 'system-ui, -apple-system, "Segoe UI", "Noto Sans HK", sans-serif' },
  { id: "serif", label: "Serif", stack: 'Georgia, "Times New Roman", "Noto Serif HK", serif' },
  { id: "mono", label: "Monospace", stack: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, "Noto Sans HK", monospace' },
];

export const DEFAULT_APPEARANCE: DocsAppearance = {
  theme: "system",
  seed: DEFAULT_SEED,
  density: 4,
  fontStack: FONT_STACKS[0].stack,
  fontScale: 1,
  fontWeight: 400,
};

/** Seeds offered as swatches. Any hex is accepted; these are just shortcuts. */
export const SEED_SWATCHES = [
  "#2F6B4F", "#1F6FEB", "#7C4DFF", "#B3261E",
  "#E8A33D", "#00897B", "#C2185B", "#455A64",
];

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
      fontStack: typeof row.fontStack === "string" && row.fontStack ? row.fontStack : DEFAULT_APPEARANCE.fontStack,
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

/**
 * Paint an appearance onto the document.
 *
 * `data-theme` is set as well as the tokens because Starlight keys its own
 * component styles off that attribute — writing only the custom properties
 * would leave Starlight's chrome in the other theme.
 */
export function applyAppearance(appearance: DocsAppearance, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  const dark = isDark(appearance.theme);
  el.setAttribute("data-theme", dark ? "dark" : "light");
  applyTokens(el, {
    seed: appearance.seed,
    dark,
    density: appearance.density,
    fontStack: appearance.fontStack,
    fontScale: appearance.fontScale,
    fontWeight: appearance.fontWeight,
  });
}
