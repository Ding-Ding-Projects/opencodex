/**
 * Appearance + shell preference types, defaults and the React context.
 *
 * Split from `prefs.tsx` so that file exports only the provider component —
 * Fast Refresh discards a module's state when it exports non-components
 * alongside them, which would reset every preference on each edit.
 */

import { createContext, useContext } from "react";
import { SettingsDraftContext } from "../settings-drafts-context";
import { readTypography } from "../../../shared/m3/typography";
import type { TypographyStyle } from "../../../shared/m3/typography";
import { elementSelectorFor } from "./m3";
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
  /**
   * There is no `dimsum` key here on purpose. The surprise is one 10% draw per
   * launch and cannot be opted out of, so there is nothing to store — see
   * `readPrefs` for how an older profile's stored switch is dropped.
   */
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
  const drafts = useContext(SettingsDraftContext);
  const legacy = useContext(PrefsContext);
  if (drafts) {
    return {
      prefs: drafts.prefs,
      setPrefs: drafts.setPrefs,
      setElementStyle: drafts.setElementStyle,
      setElementTypography: drafts.setElementTypography,
      resetElementStyle: drafts.resetElementStyle,
      resetAppearance: drafts.resetAppearance,
      dark: drafts.dark,
      windowClass: drafts.windowClass,
      width: drafts.width,
    };
  }
  if (!legacy) throw new Error("usePrefs must be used within SettingsDraftProvider or PrefsProvider");
  return legacy;
}

export function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (!raw || typeof raw !== "object") return DEFAULT_PREFS;
    const density = Number(raw.density);
    // Forward-migrate the retired dim sum off switch. A profile saved while the
    // switch existed still holds `dimsum: false`, and the spread below would
    // carry it into the object that `JSON.stringify(prefs)` writes back — so the
    // key would outlive the code that read it and quietly re-save itself
    // forever. Dropping it here is what makes an old profile simply rejoin the
    // draw, which is the point: the surprise is no longer opt-out.
    const stored: Record<string, unknown> = { ...raw };
    delete stored.dimsum;
    return {
      ...DEFAULT_PREFS,
      ...stored,
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
      density: (density >= 1 && density <= 5 ? Math.round(density) : DEFAULT_PREFS.density) as DensityLevel,
      fontScale: Number.isFinite(Number(raw.fontScale)) ? Math.min(1.6, Math.max(0.8, Number(raw.fontScale))) : 1,
      fontWeight: Number.isFinite(Number(raw.fontWeight)) ? Math.min(700, Math.max(300, Number(raw.fontWeight))) : 400,
      costRange: raw.costRange === "7d" || raw.costRange === "30d" || raw.costRange === "all" ? raw.costRange : "all",
      fontStack: typeof raw.fontStack === "string" && raw.fontStack.trim() ? raw.fontStack.trim().slice(0, 400) : undefined,
      elementStyles: readElementStyles(raw.elementStyles),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Numeric bounds, matching `readElementStyle` in `shared/m3/elements.ts`. */
const EL_LIMITS = { radius: [0, 999], pad: [0, 200], size: [1, 400] } as const;
/** Longest a stored CSS value may be. A font stack is the biggest legitimate one. */
const EL_VALUE_MAX = 400;

function clampStored(value: unknown, [lo, hi]: readonly [number, number]): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
}

function storedCssValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, EL_VALUE_MAX) : undefined;
}

/**
 * Everything in the stored per-element overrides that is still renderable.
 *
 * The six flat fields used to be trusted wholesale, which was survivable while
 * they only fed `var()` — the CSSOM parses each value on its own and simply
 * rejects junk. They no longer only feed `var()`. A derived (`auto:…`) target
 * has no hand-written variable anywhere, so its six are compiled into a real
 * generated stylesheet, and an unclamped number now reaches a real declaration:
 * a stored `radius: 1e9` becomes `border-radius: 1000000000px` on everything the
 * selector matches, which is a screen nobody can navigate back from.
 *
 * So they are clamped here to the same bounds `shared/m3/elements.ts` uses, and
 * strings are capped — an oversized value would otherwise be rewritten into the
 * stylesheet on every render. `cssText` separately refuses any value carrying
 * `;{}<>\\`, a comment, or `url(`, so the two together mean nothing from storage
 * can either escape a declaration or produce an unusable one.
 *
 * An entry that validates down to nothing is dropped rather than kept as `{}`,
 * so "has an override" stays a truthful question to ask of this map.
 */
function readElementStyles(raw: unknown): Record<string, ElementStyle> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ElementStyle> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    // An id whose selector cannot be reconstructed is dropped, and that gate
    // matters more than it used to. Derived (`auto:…`) ids are compiled into a
    // real generated stylesheet rather than into `--el-*` variables, so a key
    // from disk becomes text inside a CSS rule. `elementSelectorFor` accepts
    // only ids that rebuild into a selector made of a tag and class names — no
    // id it passes can carry a character that closes the rule and opens
    // another. It also drops entries that are simply unreachable, which would
    // otherwise sit in storage styling nothing and reappear in the reset list.
    if (!elementSelectorFor(id)) continue;
    const entry = value as ElementStyle & { typography?: unknown };
    const typography = readTypography(entry.typography);
    const next: ElementStyle = {
      font: storedCssValue(entry.font),
      color: storedCssValue(entry.color),
      bg: storedCssValue(entry.bg),
      radius: clampStored(entry.radius, EL_LIMITS.radius),
      pad: clampStored(entry.pad, EL_LIMITS.pad),
      size: clampStored(entry.size, EL_LIMITS.size),
      typography,
    };
    // Drop the keys that validated away, so `{}` and "no override" stay the
    // same thing and the reset list does not grow entries that style nothing.
    for (const key of Object.keys(next) as (keyof ElementStyle)[]) {
      if (next[key] === undefined) delete next[key];
    }
    if (Object.keys(next).length === 0) continue;
    out[id] = next;
  }
  return out;
}
