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
  const locale = drafts.locale;
  const funny = drafts.funny;

  // The document language previews immediately. Durable localStorage ownership is
  // in SettingsDraftProvider.apply(), never in a field-level change handler.
  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
  }, [locale]);

  const t: TFn = useCallback((key, vars) => translate(locale, funny, key, vars), [locale, funny]);
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
