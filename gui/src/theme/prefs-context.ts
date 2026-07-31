/**
 * Appearance + shell preference types, defaults and the React context.
 *
 * Split from `prefs.tsx` so that file exports only the provider component —
 * Fast Refresh discards a module's state when it exports non-components
 * alongside them, which would reset every preference on each edit.
 */

import { createContext, useContext } from "react";
import type { DensityLevel, ElementStyle, ThemeMode, WindowClass } from "./m3";

/** Range for the app-bar cost meter; mirrors the ranges /api/usage accepts. */
export type CostRange = "7d" | "30d" | "all";
import { DEFAULT_SEED } from "./m3";

export const PREFS_KEY = "ocx-m3:v1";

/** Editable chrome surfaces on the Appearance screen's per-element editor. */
export const ELEMENT_TARGETS = [
  { id: "navRail", tkey: "appearance.elNavRail" },
  { id: "tabStrip", tkey: "appearance.elTabStrip" },
  { id: "appBar", tkey: "appearance.elAppBar" },
  { id: "card", tkey: "appearance.elCard" },
  { id: "table", tkey: "appearance.elTable" },
  { id: "button", tkey: "appearance.elButton" },
] as const;

export interface Prefs {
  theme: ThemeMode;
  seed: string;
  density: DensityLevel;
  fontId: string;
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
      elementStyles: raw.elementStyles && typeof raw.elementStyles === "object" ? raw.elementStyles : {},
    };
  } catch {
    return DEFAULT_PREFS;
  }
}
