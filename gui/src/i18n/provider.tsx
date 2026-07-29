import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DICTS, I18nContext, LOCALES, detectInitial, interpolate, type TFn, type TKey, type Vars } from "./shared";
import { en } from "./en";
import { M3_EN, M3_OVERRIDES, type M3Key } from "./m3";
import { useI18n } from "./shared";

/**
 * Resolution order: the locale's product dictionary, then the locale's M3
 * overrides, then English in the same order. A key that exists nowhere renders
 * as itself, which makes a typo obvious in the UI instead of silently blank.
 */
function lookup(locale: keyof typeof DICTS, key: TKey): string {
  const product = DICTS[locale] as Partial<Record<TKey, string>>;
  return product[key]
    ?? M3_OVERRIDES[locale]?.[key as M3Key]
    ?? (en as Partial<Record<TKey, string>>)[key]
    ?? M3_EN[key as M3Key]
    ?? key;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(detectInitial);

  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
    try { localStorage.setItem("ocx-lang", locale); } catch { /* ignore */ }
  }, [locale]);

  const t: TFn = useCallback((key, vars) => interpolate(lookup(locale, key), vars), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
