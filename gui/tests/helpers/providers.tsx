/**
 * The provider stack a component test has to mount, kept in exactly one place.
 *
 * THIS FILE MUST TRACK `src/main.tsx`. That is its whole reason for existing, so
 * when a provider is added to, removed from, or reordered in `main.tsx`, change
 * it here in the same commit and nowhere else.
 *
 * The cost of not having this file is measured rather than assumed. The settings
 * draft coordinator landed as one new outermost provider in `main.tsx`, and
 * because `LanguageProvider` now reads its context, every test that mounted
 * `LanguageProvider` bare started throwing `useSettingsDrafts must be used within
 * SettingsDraftProvider` — 433 failures across seventy-odd files from a single
 * line of application code that was entirely correct. The same shape had already
 * happened once before, recorded in `docs/design-system/m3-port-handoff.md`, when
 * `App` grew `PrefsProvider` and `NotificationsProvider`. Twice is a pattern, and
 * seventy-four hand-maintained copies of a provider stack is what makes the third
 * time inevitable. With the stack named here, the next provider is a one-line
 * change in this file instead of a seventy-four-file sweep.
 *
 * Two exports rather than one, because tests genuinely want two different depths
 * and collapsing them would be worse than the small extra surface:
 *
 *   - `TestLanguageProvider` is the drop-in wherever a test previously reached
 *     for the application's own `LanguageProvider`. It adds the one provider the
 *     language layer now depends on and stops there, leaving whatever inner
 *     providers that test deliberately chose exactly as they were. Most tests
 *     mount a deliberately narrow tree and assert on the exact DOM inside it;
 *     silently mounting the whole shell around them would be a behaviour change
 *     smuggled in under a mechanical fix.
 *
 *   - `TestProviders` is the complete `main.tsx` stack, for a test that wants the
 *     real shell rather than a slice of it. Do not nest it around a tree that
 *     already mounts `PrefsProvider`, `NotificationsProvider` or `ConfirmProvider`
 *     itself — the inner instance would win for its own consumers while the outer
 *     one sat there owning a second, invisible copy of the same state.
 *
 * Note the ordering, which is `main.tsx`'s and is not arbitrary:
 * `SettingsDraftProvider` is outermost because `LanguageProvider` and `usePrefs`
 * both read its context; `ConfirmProvider` sits inside `NotificationsProvider` so
 * a confirmation renders above a live snackbar rather than under it.
 *
 * A test that renders `<App />` needs neither export: `App` mounts this entire
 * stack itself, and wrapping it again produces a second draft store that nothing
 * inside `App` will ever read.
 */

import type { ReactNode } from "react";
import { SettingsDraftProvider } from "../../src/settings-drafts";
import { LanguageProvider } from "../../src/i18n/provider";
import { PrefsProvider } from "../../src/theme/prefs";
import { NotificationsProvider } from "../../src/shell/notifications";
import { ConfirmProvider } from "../../src/shell/confirm";

interface TestProviderProps {
  children: ReactNode;
  /**
   * Forwarded to `SettingsDraftProvider`, which owns the only Settings endpoint
   * PUT. Left undefined the provider falls back to its own default, so a test
   * that does not care about the endpoint can ignore this entirely.
   */
  apiBase?: string;
}

/**
 * `SettingsDraftProvider` + `LanguageProvider`: the smallest tree in which the
 * application's language layer works at all.
 */
export function TestLanguageProvider({ children, apiBase }: TestProviderProps) {
  return (
    <SettingsDraftProvider apiBase={apiBase}>
      <LanguageProvider>{children}</LanguageProvider>
    </SettingsDraftProvider>
  );
}

/** The complete `main.tsx` stack, in `main.tsx` order. */
export function TestProviders({ children, apiBase }: TestProviderProps) {
  return (
    <TestLanguageProvider apiBase={apiBase}>
      <PrefsProvider>
        <NotificationsProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </NotificationsProvider>
      </PrefsProvider>
    </TestLanguageProvider>
  );
}
