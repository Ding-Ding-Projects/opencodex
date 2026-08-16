/**
 * Opt-in OAuth account pool controls, for ANY multi-account OAuth provider (#294,
 * generalized).
 *
 * The engine behind this became provider-agnostic ("auto account switcher for all
 * providers, like Codex"), but this panel stayed hardcoded to Anthropic — which
 * meant the generalized feature existed with no way to turn it on for any other
 * provider except by hand-editing config.json. It is now parameterized by
 * provider, and the API it drives stores each provider's settings in its own home
 * (anthropic at the top level, everyone else under providers[<name>].accountPool).
 *
 * Anthropic keeps its own copy deliberately: its warning names a specific, known
 * enforcement risk that a generic sentence would lose. Every other provider gets
 * the generic `pool.*` strings.
 *
 * Experimental — every provider shows a warning, because subscription OAuth
 * rotation is ToS-sensitive wherever it happens.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  type AccountPoolStrategy,
} from "../../account-pool-strategy";
import AccountPoolStrategyControls from "../AccountPoolStrategyControls";

type PoolState = {
  enabled: boolean;
  threshold: number;
  strategy: AccountPoolStrategy;
  /**
   * What the pool will really do, which is not always what is configured: `quota`
   * needs per-account usage numbers, so a provider that reports none rotates
   * round-robin instead. Shown when it differs, because a settings screen that
   * repeats the stored value while something else runs is simply lying.
   */
  effectiveStrategy: AccountPoolStrategy;
  stickyLimit: number;
};

export default function OAuthAccountPoolSettings({
  apiBase,
  accountCount,
  provider,
  providerLabel,
}: {
  apiBase: string;
  accountCount: number;
  /** Provider name as the API knows it, e.g. "anthropic", "xai". */
  provider: string;
  /** Display name for the copy; falls back to the provider name. */
  providerLabel?: string;
}) {
  const t = useT();
  const isAnthropic = provider === "anthropic";
  const name = providerLabel ?? provider;
  // Unique per instance: several of these panels can be on one page now that every
  // OAuth provider gets one, and two controls sharing an id would point every label
  // at the first provider's inputs. useId rather than a provider-derived string so
  // uniqueness is guaranteed by React instead of by the provider name.
  const strategySelectId = useId();
  const stickyInputId = useId();
  /**
   * Anthropic's strings are provider-specific and stay; everything else uses the
   * generic set. Written as one indirection so a caller cannot accidentally show a
   * Claude-specific ToS warning next to a different provider's accounts.
   */
  const copy = {
    title: isAnthropic ? t("anthropicPool.title") : t("pool.title", { provider: name }),
    enabledDesc: (percent: number) => (isAnthropic
      ? t("anthropicPool.enabledDesc", { threshold: percent })
      : t("pool.enabledDesc")),
    disabledDesc: isAnthropic ? t("anthropicPool.disabledDesc") : t("pool.disabledDesc", { provider: name }),
    warning: isAnthropic ? t("anthropicPool.experimentalWarning") : t("pool.experimentalWarning"),
    needTwo: isAnthropic ? t("anthropicPool.needTwoAccounts") : t("pool.needTwoAccounts", { provider: name }),
    loadFailed: isAnthropic ? t("anthropicPool.loadFailed") : t("pool.loadFailed", { provider: name }),
    saveFailed: isAnthropic ? t("anthropicPool.saveFailed") : t("pool.saveFailed", { provider: name }),
  };
  const [state, setState] = useState<PoolState | null>(null);
  const [draft, setDraft] = useState("80");
  const [stickyDraft, setStickyDraft] = useState(String(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/api/oauth/accounts/pool?provider=${encodeURIComponent(provider)}`, {
          signal: ac.signal,
        });
        if (!res.ok) throw new Error("load");
        const json = await res.json() as {
          enabled?: boolean;
          autoSwitchThreshold?: number;
          strategy?: unknown;
          effectiveStrategy?: unknown;
          stickyLimit?: unknown;
        };
        if (cancelled) return;
        const nextEnabled = json.enabled === true;
        const nextThreshold = typeof json.autoSwitchThreshold === "number" ? json.autoSwitchThreshold : 80;
        const nextStrategy = normalizeAccountPoolStrategy(json.strategy);
        const nextEffective = normalizeAccountPoolStrategy(json.effectiveStrategy ?? json.strategy);
        const nextSticky = normalizeAccountPoolStickyLimit(json.stickyLimit);
        setState({
          enabled: nextEnabled,
          threshold: nextThreshold,
          strategy: nextStrategy,
          effectiveStrategy: nextEffective,
          stickyLimit: nextSticky,
        });
        setDraft(String(nextThreshold));
        setStickyDraft(String(nextSticky));
        setLoadError(false);
      } catch {
        if (cancelled || ac.signal.aborted) return;
        setLoadError(true);
      }
    };
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      cancelled = true;
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [apiBase, provider]);

  const save = useCallback(async (next: {
    enabled: boolean;
    threshold: number;
    strategy: AccountPoolStrategy;
    stickyLimit: number;
  }) => {
    const previousState = state;
    setState({
      enabled: next.enabled,
      threshold: next.threshold,
      strategy: next.strategy,
      // Optimistic: the server reports the real one back below.
      effectiveStrategy: previousState?.effectiveStrategy ?? next.strategy,
      stickyLimit: next.stickyLimit,
    });
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/pool`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          enabled: next.enabled,
          autoSwitchThreshold: next.threshold,
          strategy: next.strategy,
          stickyLimit: next.stickyLimit,
        }),
      });
      if (!res.ok) throw new Error("save");
      const json = await res.json().catch(() => null) as {
        strategy?: unknown;
        effectiveStrategy?: unknown;
        stickyLimit?: unknown;
      } | null;
      const savedStrategy = normalizeAccountPoolStrategy(json?.strategy ?? next.strategy);
      const savedSticky = normalizeAccountPoolStickyLimit(json?.stickyLimit ?? next.stickyLimit);
      setState({
        enabled: next.enabled,
        threshold: next.threshold,
        strategy: savedStrategy,
        effectiveStrategy: normalizeAccountPoolStrategy(json?.effectiveStrategy ?? savedStrategy),
        stickyLimit: savedSticky,
      });
      setDraft(String(next.threshold));
      setStickyDraft(String(savedSticky));
    } catch {
      setError(copy.saveFailed);
      if (previousState) {
        setState(previousState);
        setDraft(String(previousState.threshold));
        setStickyDraft(String(previousState.stickyLimit));
      }
    } finally {
      setSaving(false);
    }
  }, [apiBase, provider, state, copy.saveFailed]);

  const enabled = state?.enabled === true;
  const threshold = state?.threshold ?? 80;
  const strategy = state?.strategy ?? DEFAULT_ACCOUNT_POOL_STRATEGY;
  const stickyLimit = state?.stickyLimit ?? DEFAULT_ACCOUNT_POOL_STICKY_LIMIT;
  const loading = state === null && !loadError;
  // Always allow turning the pool off; only block enabling when fewer than 2 accounts.
  const toggleDisabled = loading || saving || loadError || (!enabled && accountCount < 2);

  return (
    <div className="card" style={{ marginTop: 12 }} aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{copy.title}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadError
              ? copy.loadFailed
              : loading
                ? t("common.loading")
                : enabled
                  ? copy.enabledDesc(threshold)
                  : copy.disabledDesc}
          </div>
        </div>
        {/* NOT `.toggle`. That class is the button+`.toggle-knob` switch
            `CodexAutoSwitchSetting` uses, and `styles.css` also carried a
            second `.toggle` block written for a checkbox+`.slider` pattern that
            has no consumer anywhere. Its `.toggle input { opacity: 0; width: 0;
            height: 0 }` rule matched THIS checkbox and hid it, with no
            `.slider` sibling to draw in its place — so the control rendered as
            a fixed 36x20 grey pill with "On"/"Off" text overflowing it and
            nothing clickable-looking inside. Its own class keeps a real
            checkbox visible. */}
        <label className="pool-toggle-label">
          <input
            type="checkbox"
            checked={enabled}
            disabled={toggleDisabled}
            onChange={(event) => {
              const next = event.target.checked;
              void save({
                enabled: next,
                threshold,
                strategy,
                stickyLimit,
              });
            }}
          />
          <span>{enabled ? t("anthropicPool.on") : t("anthropicPool.off")}</span>
        </label>
      </div>

      <div
        role="alert"
        className="card-sub"
        style={{
          marginTop: 10,
          padding: "8px 10px",
          // M3 roles, not the legacy `--border`/`--warn` pair with a baked-in amber hex:
          // the fallback chain is the one the rest of this workspace's warning surfaces
          // use, so the banner tracks the seed colour instead of staying literally amber.
          border: "1px solid var(--m3-outline-variant)",
          borderRadius: "var(--r-s)",
          background: "var(--m3-warn-container, var(--m3-tertiary-container))",
          color: "var(--m3-on-warn-container, var(--m3-on-tertiary-container))",
        }}
      >
        {copy.warning}
      </div>

      {accountCount < 2 && (
        <div className="card-sub" style={{ marginTop: 8 }}>{copy.needTwo}</div>
      )}

      {enabled && state && (
        <>
          <label className="field" style={{ display: "block", marginTop: 12 }}>
            <span className="field-label">{t("anthropicPool.threshold")}</span>
            <input
              className="m3-input mono"
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft}
              disabled={saving}
              aria-label={t("anthropicPool.thresholdAria")}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                const parsed = Number(draft);
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
                  setDraft(String(threshold));
                  setError(t("anthropicPool.thresholdInvalid"));
                  return;
                }
                if (parsed !== threshold) {
                  void save({
                    enabled: true,
                    threshold: parsed,
                    strategy,
                    stickyLimit,
                  });
                }
              }}
            />
            <div className="card-sub" style={{ marginTop: 4 }}>{t("anthropicPool.thresholdHelp")}</div>
          </label>

          <AccountPoolStrategyControls
            strategy={strategy}
            stickyDraft={stickyDraft}
            disabled={saving}
            strategySelectId={strategySelectId}
            stickyInputId={stickyInputId}
            onStrategyChange={(next) => {
              if (next === strategy) return;
              void save({
                enabled: true,
                threshold,
                strategy: next,
                stickyLimit,
              });
            }}
            onStickyDraftChange={setStickyDraft}
            onStickyCommit={() => {
              const parsed = parseAccountPoolStickyLimitDraft(stickyDraft);
              if (parsed === null) {
                setStickyDraft(String(stickyLimit));
                setError(t("accountPool.stickyLimitInvalid"));
                return;
              }
              if (parsed === stickyLimit) {
                setStickyDraft(String(parsed));
                return;
              }
              void save({
                enabled: true,
                threshold,
                strategy,
                stickyLimit: parsed,
              });
            }}
          />

          {/* The configured strategy is not always the one that runs. Saying so here
              beats letting the operator read "quota" off a screen while round-robin
              is what actually picks the account. */}
          {state.effectiveStrategy !== strategy && (
            <div className="card-sub" style={{ marginTop: 8 }}>{t("pool.noQuotaSignalHelp")}</div>
          )}
        </>
      )}

      {error && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--m3-error)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
