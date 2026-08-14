import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useSettingsDrafts } from "../settings-drafts-context";
import {
  I18nContext, LOCALES,
  type TFn, type TKey, type Vars,
} from "./shared";
import { detectInitial, readFunny, writeFunny } from "./shared";
import { translate } from "./resolve";
import { useI18n } from "./shared";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const drafts = useSettingsDrafts();
  // `locale`/`funny` stay the user's own draft — what Settings edits and Save
  // persists. `effectiveLocale`/`effectiveFunny` are what actually renders:
  // the draft, with a currently-active scheduled rule's language-mode values
  // laid on top for exactly the fields it names (see the doc comment on
  // `scheduleOverride` in `settings-drafts-context.ts`). The distinction
  // matters here specifically — reusing `locale` for both would make the
  // Language & voice screen's own picker appear to have silently changed
  // itself out from under an in-progress edit.
  const locale = drafts.locale;
  const funny = drafts.funny;
  const effectiveLocale = drafts.scheduleOverride?.values.locale ?? locale;
  const effectiveFunny = useMemo(() => ({
    en: drafts.scheduleOverride?.values.funnyEn ?? funny.en,
    yue: drafts.scheduleOverride?.values.funnyYue ?? funny.yue,
  }), [drafts.scheduleOverride, funny]);

  // The document language previews immediately. Durable localStorage ownership is
  // in SettingsDraftProvider.apply(), never in a field-level change handler.
  useEffect(() => {
    const meta = LOCALES.find(l => l.code === effectiveLocale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
  }, [effectiveLocale]);

  const t: TFn = useCallback((key, vars) => translate(effectiveLocale, effectiveFunny, key, vars), [effectiveLocale, effectiveFunny]);
  // `value.locale`/`value.funny` stay the true draft — same rule as
  // `usePrefs().prefs` for theme/density/seed/fonts: a settings screen always
  // shows and edits what is actually saved, never a temporary override, so
  // opening Language & voice while a scheduled rule has switched the app to
  // Cantonese still shows the picker on the user's own saved choice rather
  // than silently reassigning it. `t()` and the document's `lang` attribute
  // are the *rendered app*, not an editing surface, so those two alone use
  // the effective (possibly overridden) values.
  const value = useMemo(
    () => ({ locale, setLocale: drafts.setLocale, t, funny, setFunny: drafts.setFunny }),
    [locale, drafts.setLocale, t, funny, drafts.setFunny],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Kept as exports for test-only callers of the legacy persistence helpers. */
export { detectInitial, readFunny, writeFunny };

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
