/**
 * Preferences provider: owns the persisted appearance state and pushes it onto
 * <html> as Material 3 tokens. Types, defaults and `usePrefs` live in
 * `prefs-context.ts` so this module exports only the component.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applyElementTypography,
  applyLayout,
  applyTokens,
  clearElementStyle,
  fontStackFor,
  resolveDark,
  windowClass,
} from "./m3";
import {
  DEFAULT_PREFS,
  ELEMENT_TARGETS,
  PREFS_KEY,
  PrefsContext,
  readPrefs,
  type Prefs,
  type PrefsContextValue,
} from "./prefs-context";
import type { ElementStyle } from "./m3";
import type { TypographyStyle } from "../../../shared/m3/typography";

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  const [systemDark, setSystemDark] = useState(() => resolveDark("system"));

  // Track the OS scheme so `theme: "system"` repaints without a reload.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Breakpoints are measured, not media-queried, so an emulated preview width works.
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const dark = prefs.theme === "system" ? systemDark : prefs.theme === "dark";

  useEffect(() => {
    applyTokens(document.documentElement, {
      seed: prefs.seed,
      dark,
      density: prefs.density,
      // `fontStack` wins when the user picked a family the five bundled presets
      // do not cover — the font picker can reach anything installed, and
      // `fontId` can only name one of five.
      fontStack: prefs.fontStack || fontStackFor(prefs.fontId),
      fontScale: prefs.fontScale,
      fontWeight: prefs.fontWeight,
      elementStyles: prefs.elementStyles,
    });
    // Rich per-element typography cannot ride the `--el-*` variable channel; it
    // is compiled into one generated stylesheet instead.
    applyElementTypography(document, prefs.elementStyles);
    // Legacy pages still branch on `data-theme`; keep it authoritative in both directions.
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [prefs, dark]);

  useEffect(() => {
    applyLayout(document.documentElement, width);
  }, [width]);

  // Persist on every change; a full quota failure must not take the UI down.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* quota */ }
  }, [prefs]);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState(prev => ({ ...prev, ...patch }));
  }, []);

  const setElementStyle = useCallback((id: string, patch: ElementStyle) => {
    setPrefsState(prev => ({
      ...prev,
      elementStyles: { ...prev.elementStyles, [id]: { ...prev.elementStyles[id], ...patch } },
    }));
  }, []);

  /**
   * Merge one typography property into a target.
   *
   * Not `setElementStyle(id, { typography: patch })`: that spread replaces the
   * whole `typography` object, so setting a size would wipe the family, the
   * colour and every other property already on it. This merges key by key.
   *
   * A key explicitly set to `undefined` is *deleted* rather than stored as
   * undefined, because `typographyCss` and `isEmptyTypography` both ask whether
   * a key is present — a stored `undefined` reads as "set" to `Object.keys` and
   * would keep a cleared property alive as an empty override.
   */
  const setElementTypography = useCallback((id: string, patch: Partial<TypographyStyle>) => {
    setPrefsState(prev => {
      const current = prev.elementStyles[id] ?? {};
      const next: TypographyStyle = { ...current.typography };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key as keyof TypographyStyle];
        else Object.assign(next, { [key]: value });
      }
      const style: ElementStyle = { ...current };
      // An empty object is not the same as no override: it would make
      // "does this target have typography" answer yes for a target the user has
      // just cleared, and leave an empty rule in the generated stylesheet.
      if (Object.keys(next).length) style.typography = next;
      else delete style.typography;
      return { ...prev, elementStyles: { ...prev.elementStyles, [id]: style } };
    });
  }, []);

  const resetElementStyle = useCallback((id: string) => {
    clearElementStyle(document.documentElement, id);
    setPrefsState(prev => {
      const next = { ...prev.elementStyles };
      delete next[id];
      return { ...prev, elementStyles: next };
    });
  }, []);

  const resetAppearance = useCallback(() => {
    for (const target of ELEMENT_TARGETS) clearElementStyle(document.documentElement, target.id);
    // Narration survives an appearance reset, voices included. "Reset
    // appearance" is a request about how the app looks; silently discarding the
    // voice, rate and pitch somebody tuned by ear would be a different, unasked
    // -for reset that leaves no trace of what the settings used to be.
    setPrefsState(prev => ({
      ...DEFAULT_PREFS,
      narrator: prev.narrator,
      narratorLang: prev.narratorLang,
      narratorVoices: prev.narratorVoices,
      narratorEdge: prev.narratorEdge,
    }));
  }, []);

  const value = useMemo<PrefsContextValue>(() => ({
    prefs, setPrefs, setElementStyle, setElementTypography, resetElementStyle, resetAppearance,
    dark, windowClass: windowClass(width), width,
  }), [prefs, setPrefs, setElementStyle, setElementTypography, resetElementStyle, resetAppearance, dark, width]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}
