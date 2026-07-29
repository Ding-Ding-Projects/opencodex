/**
 * Preferences provider: owns the persisted appearance state and pushes it onto
 * <html> as Material 3 tokens. Types, defaults and `usePrefs` live in
 * `prefs-context.ts` so this module exports only the component.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
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
      fontStack: fontStackFor(prefs.fontId),
      fontScale: prefs.fontScale,
      fontWeight: prefs.fontWeight,
      elementStyles: prefs.elementStyles,
    });
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
    setPrefsState(prev => ({ ...DEFAULT_PREFS, narrator: prev.narrator, narratorLang: prev.narratorLang }));
  }, []);

  const value = useMemo<PrefsContextValue>(() => ({
    prefs, setPrefs, setElementStyle, resetElementStyle, resetAppearance,
    dark, windowClass: windowClass(width), width,
  }), [prefs, setPrefs, setElementStyle, resetElementStyle, resetAppearance, dark, width]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}
