/**
 * Appearance + shell preference types, defaults and the React context.
 *
 * Split from `prefs.tsx` so that file exports only the provider component —
 * Fast Refresh discards a module's state when it exports non-components
 * alongside them, which would reset every preference on each edit.
 */

import { createContext, useContext } from "react";
import { readTypography } from "../../../shared/m3/typography";
import type { TypographyStyle } from "../../../shared/m3/typography";
import type { DensityLevel, ElementStyle, ThemeMode, WindowClass } from "./m3";

/** Range for the app-bar cost meter; mirrors the ranges /api/usage accepts. */
export type CostRange = "7d" | "30d" | "all";
import { DEFAULT_SEED } from "./m3";

export const PREFS_KEY = "ocx-m3:v1";

/**
 * Editable surfaces on the Appearance screen's per-element editor, and the
 * targets the delegated right-click in `ElementAppearanceHost` can resolve.
 *
 * The list is what "every rendered element" is currently spelled out as. The
 * three chrome entries came first because three components spread
 * `useAppearanceTarget` by hand; the rest were reachable only from the
 * Appearance screen, which meant right-clicking a card, a button, a field or a
 * chip — the surfaces the app is almost entirely made of — did nothing at all.
 * Adding an entry here is now half the work: `ELEMENT_SELECTORS` in `m3.ts`
 * says where it lives, and the `--el-<id>-*` variables in the stylesheet are
 * what make the editor's controls actually change anything.
 */
export const ELEMENT_TARGETS = [
  { id: "navRail", tkey: "appearance.elNavRail" },
  { id: "tabStrip", tkey: "appearance.elTabStrip" },
  { id: "appBar", tkey: "appearance.elAppBar" },
  { id: "card", tkey: "appearance.elCard" },
  { id: "table", tkey: "appearance.elTable" },
  { id: "button", tkey: "appearance.elButton" },
  { id: "iconButton", tkey: "appearance.elIconButton" },
  { id: "input", tkey: "appearance.elInput" },
  { id: "chip", tkey: "appearance.elChip" },
  { id: "menu", tkey: "appearance.elMenu" },
  { id: "select", tkey: "appearance.elSelect" },
  { id: "dialog", tkey: "appearance.elDialog" },
  { id: "banner", tkey: "appearance.elBanner" },
  { id: "bottomNav", tkey: "appearance.elBottomNav" },
  { id: "statCard", tkey: "appearance.elStatCard" },
  // The remote control's own panels. That screen is built from `m3-mob__*`
  // classes rather than the shell's, so before this it resolved to nothing at
  // all — right-clicking anywhere on it did nothing, on every one of its three
  // tabs.
  { id: "remotePanel", tkey: "appearance.elRemotePanel" },
] as const;

export interface Prefs {
  theme: ThemeMode;
  seed: string;
  density: DensityLevel;
  fontId: string;
  /**
   * A full stack chosen from the font picker, which can reach any installed
   * family. Overrides `fontId` when set.
   *
   * Both are kept rather than one replacing the other: `fontId` is what every
   * already-saved profile holds, and rewriting it on load would silently
   * reinterpret a stored preference. Absent here means "whatever `fontId` says",
   * which is exactly what an older profile means.
   */
  fontStack?: string;
  fontScale: number;
  fontWeight: number;
  /** Narrator (speech synthesis) is off by default and never auto-enables. */
  narrator: boolean;
  narratorLang: string;
  /** Dim sum surprise: one 1% draw per launch. On by default; the switch is honoured before the draw. */
  dimsum: boolean;
  /** App-bar cost meter range. "all" = lifetime, the default. */
  costRange: CostRange;
  elementStyles: Record<string, ElementStyle>;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  seed: DEFAULT_SEED,
  // 3, matching the prototype's `density: p.density ?? 3`. This shipped as 4,
  // which put every fresh install one step tighter than the design it was ported
  // from — and because the density ramp was severed from `styles.css` until now,
  // the difference was invisible on any unmigrated screen rather than obviously
  // wrong. An existing profile keeps whatever it has stored.
  density: 3,
  fontId: "roboto-flex",
  fontScale: 1,
  fontWeight: 400,
  narrator: false,
  narratorLang: "en",
  dimsum: true,
  costRange: "all",
  elementStyles: {},
};

export interface PrefsContextValue {
  prefs: Prefs;
  /** Shallow-merge a patch; persists and re-applies tokens. */
  setPrefs: (patch: Partial<Prefs>) => void;
  setElementStyle: (id: string, patch: ElementStyle) => void;
  /**
   * Merge a typography patch for one target. A key set to `undefined` clears
   * that one property — which a plain object spread cannot express, because the
   * spread keeps the key with an undefined value and `typographyCss` would then
   * still see it.
   */
  setElementTypography: (id: string, patch: Partial<TypographyStyle>) => void;
  resetElementStyle: (id: string) => void;
  resetAppearance: () => void;
  /** Resolved dark-mode flag, tracking the OS when `theme === "system"`. */
  dark: boolean;
  /** Measured viewport width class driving the adaptive nav. */
  windowClass: WindowClass;
  width: number;
}

export const PrefsContext = createContext<PrefsContextValue | null>(null);

export function usePrefs(): PrefsContextValue {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs must be used within PrefsProvider");
  return ctx;
}

export function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (!raw || typeof raw !== "object") return DEFAULT_PREFS;
    const density = Number(raw.density);
    return {
      ...DEFAULT_PREFS,
      ...raw,
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
      density: (density >= 1 && density <= 5 ? Math.round(density) : DEFAULT_PREFS.density) as DensityLevel,
      fontScale: Number.isFinite(Number(raw.fontScale)) ? Math.min(1.6, Math.max(0.8, Number(raw.fontScale))) : 1,
      fontWeight: Number.isFinite(Number(raw.fontWeight)) ? Math.min(700, Math.max(300, Number(raw.fontWeight))) : 400,
      dimsum: typeof raw.dimsum === "boolean" ? raw.dimsum : true,
      costRange: raw.costRange === "7d" || raw.costRange === "30d" || raw.costRange === "all" ? raw.costRange : "all",
      fontStack: typeof raw.fontStack === "string" && raw.fontStack.trim() ? raw.fontStack.trim().slice(0, 400) : undefined,
      elementStyles: readElementStyles(raw.elementStyles),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * Everything in the stored per-element overrides that is still renderable.
 *
 * The six flat fields were previously trusted wholesale, which was survivable
 * while they were six strings and numbers feeding `var()`. Typography is not:
 * `typographyCss` writes its values straight into a real CSS rule, so a
 * hand-edited or corrupted entry could set `font-size: 1e9px` on every card and
 * leave the user with a screen they cannot navigate back from. `readTypography`
 * clamps every number and checks every enum, and drops keys it does not know.
 *
 * An entry that validates down to nothing is dropped rather than kept as `{}`,
 * so "has an override" stays a truthful question to ask of this map.
 */
function readElementStyles(raw: unknown): Record<string, ElementStyle> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ElementStyle> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as ElementStyle & { typography?: unknown };
    const typography = readTypography(entry.typography);
    const next: ElementStyle = { ...entry, typography };
    if (!typography) delete next.typography;
    out[id] = next;
  }
  return out;
}
