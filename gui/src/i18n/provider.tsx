import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useSettingsDrafts } from "../settings-drafts-context";
import {
  I18nContext, LOCALES,
  type TFn, type TKey, type Vars,
} from "./shared";
import { detectInitial, readFunny, writeFunny } from "./shared";
import { translate } from "./resolve";
import { useI18n } from "./shared";
import { useSchoolModeActive } from "../school-mode/hooks";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const drafts = useSettingsDrafts();
  const locale = drafts.locale;
  const funny = drafts.funny;
  // `translate()` reads School Mode internally and needs no argument for it,
  // but `t`'s own memoization does: `locale`/`funny` do not change when the
  // mode flips on or off, so without this dependency every consumer of
  // `useT()` would keep rendering whatever it last rendered until some
  // unrelated state change happened to re-render the tree. Subscribing here
  // gives `t` — and therefore the context `value` below — a new identity the
  // instant School Mode changes, which is what makes every surface update
  // live rather than only on the next unrelated render.
  const schoolModeActive = useSchoolModeActive();

  // The document language previews immediately. Durable localStorage ownership is
  // in SettingsDraftProvider.apply(), never in a field-level change handler.
  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = schoolModeActive ? "en" : meta.htmlLang;
  }, [locale, schoolModeActive]);

  const t: TFn = useCallback((key, vars) => translate(locale, funny, key, vars), [locale, funny, schoolModeActive]);
  const value = useMemo(() => ({ locale, setLocale: drafts.setLocale, t, funny, setFunny: drafts.setFunny }), [locale, drafts.setLocale, t, funny, drafts.setFunny]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Kept as exports for test-only callers of the legacy persistence helpers. */
export { detectInitial, readFunny, writeFunny };

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
