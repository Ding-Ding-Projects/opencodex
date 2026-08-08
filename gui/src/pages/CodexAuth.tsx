import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import { Button } from "../shell/m3-ui";
import CodexAccountPool from "../components/CodexAccountPool";
import { chipStyle } from "../components/codex-account-pool-m3";
import { codexAccountModeState, type CodexAccountModeState } from "../codex-multi-state";
import { formatProviderDisplayName } from "../provider-icons";
import { ensureOpenAiProvider, openAiAccountProviderState, OpenAiEnableError } from "../provider-payload";
import { recordRevision } from "../shell/revisions";

/** Config key of the built-in Codex-login provider this banner recovers. */
const OPENAI_PROVIDER_ID = "openai";

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
  // Until the first /api/config read resolves — and after one that failed — there is
  // no mode to report. Rendering the card anyway left a titled surface with no body,
  // no status and no action on every mount: a heading that says nothing.
  if (state === null) return null;
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
          {/* Same status-pill vocabulary as the account cards below, so mode and
              account state cannot read as two different kinds of badge. */}
          {state === "pool" && (
            <span className="m3-chip" style={chipStyle("primary")}>{t("codexAuth.accountModePool")}</span>
          )}
          {state === "direct" && (
            <span className="m3-chip" style={chipStyle("ok")}>{t("codexAuth.accountModeDirect")}</span>
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
      // Enabling writes the provider row that Providers also lists, so the change
      // has to reach Version history — otherwise a provider can appear from this
      // screen with no record of who turned it on.
      recordRevision({
        scope: "provider",
        label: formatProviderDisplayName(OPENAI_PROVIDER_ID),
        summary: t("prov.enabled", { name: formatProviderDisplayName(OPENAI_PROVIDER_ID) }),
      });
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
    {/* `.dash-notice` is the M3-vocabulary replacement for the pre-M3 `notice
        notice-err` layer, which painted `--m3-error` text on an error-container
        fill instead of the paired `--m3-on-error-container`. It carries the same
        pairing this row used to hand-roll inline, and unlike the inline styles it
        is reachable from the per-element appearance editor. */}
    {enableError && (
      <div className="dash-notice" role="alert" style={{ marginBottom: "var(--sp-3)" }}>
        {enableError}
      </div>
    )}
  </>;

  // The page lead the prototype opens this screen with. It belongs to the page, not
  // to the pool component, so the Providers workspace embedding the same pool does
  // not inherit copy that describes a whole screen it is only one tab of.
  const lead = <p className="m3-page-lead">{t("codexAuth.subtitle")}</p>;

  return <CodexAccountPool apiBase={apiBase} accountModeState={accountModeState} banner={banner} lead={lead} />;
}
