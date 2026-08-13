/**
 * Shared draft coordinator contracts.
 *
 * This module has no React component so Fast Refresh keeps the provider state in
 * `settings-drafts.tsx`, while every leaf setting can depend on the stable hook
 * here without introducing a second persistence path.
 */

import { createContext, useContext } from "react";
import type { Locale, FunnyLevels } from "./i18n/shared";
import type { SettingsSaveOutcome, SettingsSnapshot } from "./pages/settings-shared";
import type { ElementStyle, WindowClass } from "./theme/m3";
import type { Prefs } from "./theme/prefs-context";
import type { TypographyStyle } from "../../shared/m3/typography";

export interface SettingsDraftContextValue {
  /** The durable browser preferences before any un-applied preview. */
  appliedPrefs: Prefs;
  /** The visible, temporary-preview preferences. */
  prefs: Prefs;
  /** The durable locale before any un-applied preview. */
  appliedLocale: Locale;
  /** The visible, temporary-preview locale. */
  locale: Locale;
  /** The durable funny levels before any un-applied preview. */
  appliedFunny: FunnyLevels;
  /** The visible, temporary-preview funny levels. */
  funny: FunnyLevels;
  /** Server values as last accepted by endpoint echoes. */
  appliedSettings: SettingsSnapshot | null;
  /** The Settings page's temporary server-backed snapshot. */
  settings: SettingsSnapshot | null;
  dirtyCount: number;
  dirty: boolean;
  applying: boolean;
  /** Live theme state remains available to existing shell consumers. */
  dark: boolean;
  windowClass: WindowClass;
  width: number;
  /** A draft-only preference update; it repaints but cannot persist. */
  setPrefs: (patch: Partial<Prefs>) => void;
  setElementStyle: (id: string, patch: ElementStyle) => void;
  setElementTypography: (id: string, patch: Partial<TypographyStyle>) => void;
  resetElementStyle: (id: string) => void;
  resetAppearance: () => void;
  setLocale: (locale: Locale) => void;
  setFunny: (patch: Partial<FunnyLevels>) => void;
  /** Receive an initial/server refresh without clobbering edits already staged. */
  setSettingsBaseline: (snapshot: SettingsSnapshot) => void;
  setSettings: (update: (previous: SettingsSnapshot) => SettingsSnapshot) => void;
  /**
   * Persist the draft and report what the settings endpoints made of it, or
   * `null` when nothing server-backed was written.
   *
   * Prefer `useSettingsSave`, which raises the notice. This provider is mounted
   * outside `LanguageProvider` and `NotificationsProvider`, so it can reach
   * neither `t()` nor `notify()` — calling `apply` directly saves silently, and
   * a refusal then leaves a control staged with nothing to explain it.
   */
  apply: () => Promise<SettingsSaveOutcome | null>;
  discard: () => void;
}

export const SettingsDraftContext = createContext<SettingsDraftContextValue | null>(null);

export function useSettingsDrafts(): SettingsDraftContextValue {
  const context = useContext(SettingsDraftContext);
  if (!context) throw new Error("useSettingsDrafts must be used within SettingsDraftProvider");
  return context;
}
