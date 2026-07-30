import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import { Button } from "../shell/m3-ui";
import CodexAccountPool from "../components/CodexAccountPool";
import { codexAccountModeState, type CodexAccountModeState } from "../codex-multi-state";
import { ensureOpenAiProvider, openAiAccountProviderState, OpenAiEnableError } from "../provider-payload";

export type OpenAiAccountBannerState = CodexAccountModeState | "invalid" | null;

export function OpenAiAccountModeBanner({
  state,
  busy,
  onEnable,
}: {
  state: OpenAiAccountBannerState;
  busy: boolean;
  onEnable: () => void;
}) {
  const t = useT();
  return (
    <section className="m3-card" style={{ marginBottom: "var(--sp-3)" }}>
      <div className="m3-card-head" style={{ marginBottom: 0, alignItems: "center" }}>
        <div className="m3-card-headtext">
          <h2 className="m3-card-title">{t("codexAuth.accountModeTitle")}</h2>
          {state === "pool" && (
            <p className="m3-card-sub">{t("codexAuth.accountModePoolDesc")}</p>
          )}
          {state === "direct" && (
            <p className="m3-card-sub">
              {t("codexAuth.accountModeDirectDesc")} <a href="#providers">{t("codexAuth.openProviders")}</a>
            </p>
          )}
          {(state === "absent" || state === "disabled") && (
            <p className="m3-card-sub">{t("codexAuth.openaiUnavailableDesc")}</p>
          )}
          {state === "invalid" && (
            <p className="m3-card-sub">
              {t("codexAuth.openaiMissing")} <a href="#providers">{t("codexAuth.openProviders")}</a>
            </p>
          )}
        </div>
        <div className="m3-card-actions">
          {state === "pool" && (
            <span className="m3-chip selected" style={{ cursor: "default" }}>{t("codexAuth.accountModePool")}</span>
          )}
          {state === "direct" && (
            <span
              className="m3-chip"
              style={{
                cursor: "default",
                background: "var(--m3-ok-container)",
                color: "var(--m3-on-ok-container)",
                borderColor: "transparent",
              }}
            >
              {t("codexAuth.accountModeDirect")}
            </span>
          )}
          {(state === "absent" || state === "disabled") && (
            <Button variant="filled" disabled={busy} onClick={onEnable}>
              {busy ? t("codexAuth.enablingOpenai") : t("codexAuth.enableOpenai")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function openaiProviderFromConfig(config: unknown): {
  adapter?: string;
  authMode?: string;
  baseUrl?: string;
  disabled?: boolean;
} | undefined {
  if (!config || typeof config !== "object") return undefined;
  const providers = (config as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  if (!Object.hasOwn(providers, "openai")) return undefined;
  const provider = (providers as Record<string, unknown>).openai;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return undefined;
  return provider as {
    adapter?: string;
    authMode?: string;
    baseUrl?: string;
    disabled?: boolean;
  };
}

/**
 * Codex Auth page — a thin wrapper around CodexAccountPool (WP060 extraction).
 * The page owns the /api/config fetch feeding the account-mode banner and
 * passes the mode down so the pool renders mode-aware copy.
 */
export default function CodexAuth({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [bannerState, setBannerState] = useState<OpenAiAccountBannerState>(null);
  const [accountModeState, setAccountModeState] = useState<CodexAccountModeState | null>(null);
  const [enableBusy, setEnableBusy] = useState(false);
  const [enableError, setEnableError] = useState("");

  const loadMode = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      if (!res.ok) throw new Error(String(res.status));
      const config = await res.json();
      const providerState = openAiAccountProviderState(openaiProviderFromConfig(config));
      if (providerState === "absent" || providerState === "disabled" || providerState === "invalid") {
        setBannerState(providerState);
        // Non-canonical / missing rows are not a live Codex account mode.
        setAccountModeState(providerState === "disabled" ? "disabled" : "absent");
        return;
      }
      const mode = codexAccountModeState(config);
      setBannerState(mode);
      setAccountModeState(mode);
    } catch {
      setBannerState(null);
      setAccountModeState(null);
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadMode(); }, 0);
    const iv = window.setInterval(() => { void loadMode(); }, 30_000);
    return () => { window.clearTimeout(timeout); window.clearInterval(iv); };
  }, [loadMode]);

  const enableOpenAi = async () => {
    setEnableBusy(true);
    setEnableError("");
    try {
      // Recovery is gated on the same canonical checks as Providers → Accounts.
      if (bannerState !== "absent" && bannerState !== "disabled") return;
      await ensureOpenAiProvider(apiBase, bannerState);
      await loadMode();
    } catch (error) {
      if (error instanceof OpenAiEnableError) {
        setEnableError(t(error.i18nKey));
      } else {
        setEnableError(error instanceof Error ? error.message : t("prov.saveFailed"));
      }
    } finally {
      setEnableBusy(false);
    }
  };

  const banner = <>
    <OpenAiAccountModeBanner
      state={bannerState}
      busy={enableBusy}
      onEnable={() => { void enableOpenAi(); }}
    />
    {enableError && <div className="notice notice-err" role="alert">{enableError}</div>}
  </>;

  return <CodexAccountPool apiBase={apiBase} accountModeState={accountModeState} banner={banner} />;
}
