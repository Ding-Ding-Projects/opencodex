import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  I18nContext, LOCALES, detectInitial, readFunny, writeFunny,
  type FunnyLevels, type TFn, type TKey, type Vars,
} from "./shared";
import { translate } from "./resolve";
import { useI18n } from "./shared";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(detectInitial);
  // Lazy initializer, not an effect: a synchronous storage read that produces
  // the initial value, so an effect would only add a second render.
  const [funny, setFunnyState] = useState<FunnyLevels>(readFunny);

  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
    try { localStorage.setItem("ocx-lang", locale); } catch { /* ignore */ }
  }, [locale]);

  const setFunny = useCallback((patch: Partial<FunnyLevels>) => {
    setFunnyState(prev => {
      const next = { ...prev, ...patch };
      writeFunny(next);
      return next;
    });
  }, []);

  const t: TFn = useCallback((key, vars) => translate(locale, funny, key, vars), [locale, funny]);
  const value = useMemo(() => ({ locale, setLocale, t, funny, setFunny }), [locale, t, funny, setFunny]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
