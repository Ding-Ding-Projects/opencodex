import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import { IconPause, IconPlus, IconRefresh, IconSearch } from "../icons";
import { Chip, Empty, TextInput } from "../shell/m3-ui";
import { useNotifications } from "../shell/notifications-context";
import { useConfirm, usePrompt } from "../shell/confirm-context";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS } from "../shell/settings-search";
import { makeMatcher } from "../pages/models-shared";
import { POOL_GRID, SECTION_TITLE } from "./codex-account-pool-m3";
import AddCodexAccountModal from "./AddCodexAccountModal";
import { useCodexAccountPool, type CodexAccountPoolController } from "../hooks/useCodexAccountPool";
import type { CSSProperties, ReactNode } from "react";
import type { CodexAccountModeState } from "../codex-multi-state";
import CodexAutoSwitchSetting from "./CodexAutoSwitchSetting";
import CodexPoolStrategySetting from "./CodexPoolStrategySetting";
import { useCodexAutoSwitch } from "../hooks/useCodexAutoSwitch";
import { readJsonIfOk } from "../fetch-json";
import { CodexAccountPoolCards, CodexAccountPoolReauthBanner } from "./codex-account-pool-cards";
import { CodexAccountSwitchModal } from "./codex-account-switch-modal";
import { CodexAccountResetModal } from "./codex-account-reset-modal";
import { CodexAccountPoolLoadStates, CodexAccountPoolMainCard } from "./codex-account-pool-main-card";
import { redeemResetCredit } from "./codex-account-pool-handlers";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import { accountNeedsReauth } from "../oauth-health-display";
import { useCopyFeedback } from "./use-copy-feedback";

// Single definition lives with the controller that owns this data (WP3).
export type { CodexAccountEntry } from "../hooks/useCodexAccountPool";

const DOCTOR_CMD = "ocx doctor";

/**
 * The flags row's state line, so this surface's search field can point
 * `aria-describedby` at what its pattern actually compiles to.
 *
 * A literal rather than a `useId()`, matching every other search bar that
 * carries the row: this surface has exactly one search field, so the id names a
 * fixed element and stays stable for the tests and the capture harness that
 * look it up. A second search bar added here would need its own id, never a
 * share of this one — two bars own two independent flag sets, and one id
 * pointing at both would describe each with the other's state.
 */
const SETTINGS_FLAGS_STATE_ID = "codex-pool-settings-flags-state";

/** One hit of the settings search, matching the prototype's settings-index row. */
interface SettingsHit {
  id: string;
  label: string;
  desc: string;
  /** Live value where this surface can read it; blank where the owning card keeps it. */
  value: string;
  /** Everything the query is tested against — including option labels a user is
      likelier to remember ("round-robin") than the control's own name. */
  haystack: string;
}

const SETTINGS_HIT_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  padding: "10px 12px",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-highest)",
};

/**
 * Global ChatGPT / Codex account pool (main + extras), extracted from the Codex
 * Auth page (WP060). `accountModeState` arrives as a prop (the parent owns the
 * /api/config fetch); `banner` is an optional slot rendered above the main card
 * (the Codex Auth page passes its mode banner); `lead` is the page's opening
 * paragraph, owned by the page so the embedded Providers copy stays silent;
 * `embedded` (WP090) omits page
 * title chrome while retaining the shared account actions in the Providers workspace.
 */
export default function CodexAccountPool({ apiBase, accountModeState = null, banner = null, lead = null, embedded = false, onActiveNeedsReauthChange, controller: injectedController }: {
  apiBase: string;
  accountModeState?: CodexAccountModeState | null;
  banner?: ReactNode;
  lead?: ReactNode;
  embedded?: boolean;
  onActiveNeedsReauthChange?: (needs: boolean) => void;
  /**
   * WP3: when Providers owns the controller, every surface shares one instance so a
   * mutation on Overview is immediately visible on the Accounts tab. The standalone
   * Codex Auth page passes nothing and gets its own.
   */
  controller?: CodexAccountPoolController;
}) {
  const t = useT();
  // Not named `confirm`/`prompt`: the switch modal already owns a `confirm`
  // state variable here, and shadowing the globals is the point elsewhere but
  // would collide with it in this file.
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  // Every outcome here used to be one inline toast string plus a separate error
  // flag plus a hand-rolled 5s timer — three pieces of state that could disagree,
  // which is how a successful redeem once rendered in the error colour. A
  // snackbar carries its tone in the same call as its text.
  const { notify } = useNotifications();
  const autoSwitch = useCodexAutoSwitch(apiBase, {
    updated: t("codexAuth.autoSwitchUpdated"),
    updateFailed: t("codexAuth.autoSwitchUpdateFailed"),
    invalid: t("codexAuth.autoSwitchThresholdInvalid"),
  });
  const { beginServerRead, acceptServerRead, rejectServerRead, hydrateServerValue } = autoSwitch;
  // A hook cannot be called conditionally, so the fallback instance is always created
  // but stays inert (no load, no polling) whenever a shared controller was injected.
  const ownController = useCodexAccountPool(apiBase, !injectedController);
  const controller = injectedController ?? ownController;
  const { accounts, activeId, loadState, switchingId, pauseUpdatingId, pausingExhausted, load } = controller;
  const [confirm, setConfirm] = useState<CodexAccountEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [reauthId, setReauthId] = useState<string | null>(null);
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [resetPopup, setResetPopup] = useState<CodexAccountEntry | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [creditDetails, setCreditDetails] = useState<{ granted_at: string; expires_at: string }[] | null>(null);
  const [creditDetailsLoading, setCreditDetailsLoading] = useState(false);
  // This surface's own settings search. Bound to this field alone, so it can never
  // pick up a query another screen's search bar is holding.
  const [settingsQuery, setSettingsQuery] = useState("");
  const [settingsRegex, setSettingsRegex] = useState(false);
  /**
   * The flags this field compiles with, and this field's alone — the same
   * per-bar ownership the query above has, for the same reason.
   *
   * State rather than the `"i"` this search used to inherit by omission: the
   * builder anchored beside the field composes a pattern *and* its flags, and a
   * field that took only the pattern turned the popover's flag chips into
   * decoration from the search's point of view. Turning on `m` or `s` changed
   * the panel's own preview and then changed nothing about which settings rows
   * survived, and a pattern deliberately built as case-sensitive arrived here
   * case-insensitive because `i` was pinned on the way in.
   */
  const [settingsFlags, setSettingsFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const doctorCopy = useCopyFeedback<string>();

  const copyDoctor = useCallback((accountId: string) => {
    doctorCopy.copy(DOCTOR_CMD, accountId);
  }, [doctorCopy]);

  // The controller owns loading and polling. This surface only feeds the auto-switch
  // threshold observer and leases a pause while an OAuth modal is open.
  // Depend on the stable subscribe callback, not the controller object: the hook
  // returns a fresh object every render, which would resubscribe on every render.
  const { subscribeLoadObserver, readLastThreshold } = controller;

  useEffect(() => subscribeLoadObserver({
    beginActiveRead: beginServerRead,
    acceptActiveRead: acceptServerRead,
    rejectActiveRead: rejectServerRead,
  }), [subscribeLoadObserver, beginServerRead, acceptServerRead, rejectServerRead]);

  // Seed from a value an earlier load already fetched. Tabs mount and unmount their
  // panels, so a panel appearing after that load would otherwise show "Loading" until
  // the next poll. Hydration applies only while uninitialized, so it cannot disturb a
  // draft or a pending save.
  useEffect(() => {
    const cached = readLastThreshold();
    if (cached !== undefined) hydrateServerValue(cached);
  }, [readLastThreshold, hydrateServerValue]);

  useEffect(() => {
    if (!showAdd) return;
    const token = controller.pauseRefresh();
    return () => controller.resumeRefresh(token);
  }, [controller, showAdd]);

  const activePoolAccount = activeId && activeId !== "__main__"
    ? accounts.find(a => a.id === activeId)
    : null;
  const activePoolNeedsReauth = !activePoolAccount?.paused && accountNeedsReauth(activePoolAccount);

  useEffect(() => {
    onActiveNeedsReauthChange?.(activePoolNeedsReauth);
  }, [activePoolNeedsReauth, onActiveNeedsReauthChange]);

  const openReauth = useCallback((id: string) => {
    setReauthId(id);
    setShowAdd(true);
  }, []);

  const closeAddModal = useCallback(() => {
    setShowAdd(false);
    setReauthId(null);
  }, []);

  const handleAccountAdded = useCallback(() => {
    void controller.syncAfterAccountAdded();
    notify({ tone: "success", title: t("codexAuth.accountAdded") });
    closeAddModal();
  }, [closeAddModal, controller, notify, t]);

  const setActive = async (id: string | null) => {
    const result = await controller.switchAccount(id);
    if (!result.ok) {
      if (result.reason === "busy") return;
      notify({ tone: "error", title: t("codexAuth.switchFailed") });
      return;
    }
    setConfirm(null);
    const selectedId = result.activeId;
    const label = selectedId && selectedId !== "__main__"
      ? accounts.find(account => account.id === selectedId)?.email ?? t("pws.accountOrdinal", { count: "1" })
      : t("codexAuth.mainAccount");
    notify({
      tone: "success",
      title: accountModeState === "direct"
        ? t("codexAuth.poolPreparedToast", { email: label })
        : t("codexAuth.switched", { email: label }),
    });
  };

  const editAlias = async (account: CodexAccountEntry) => {
    // `null` is cancel; `""` is a deliberate clear. Conflating them would make
    // "remove the alias I set" impossible.
    const entered = await askPrompt({
      title: t("prompt.aliasTitle"),
      label: t("prov.aliasPrompt"),
      initialValue: account.alias ?? "",
      confirmLabel: t("prompt.aliasAction"),
    });
    if (entered === null) return;
    const result = await controller.saveAlias(account.id, entered);
    notify({
      tone: result.ok ? "success" : "error",
      title: t(result.ok ? "prov.aliasSaved" : "prov.aliasSaveFailed"),
    });
  };

  const togglePaused = async (account: CodexAccountEntry) => {
    const paused = !account.paused;
    const result = await controller.setAccountPaused(account.id, paused);
    if (!result.ok && result.reason === "busy") return;
    setConfirm(current => current?.id === account.id ? null : current);
    notify({
      tone: result.ok ? "success" : "error",
      title: t(result.ok
        ? paused ? "codexAuth.pauseSucceeded" : "codexAuth.resumeSucceeded"
        : paused ? "codexAuth.pauseFailed" : "codexAuth.resumeFailed", {
        email: account.alias ?? account.email,
      }),
    });
  };

  const remove = async (id: string) => {
    const label = accounts.find(account => account.id === id)?.email ?? t("pws.accountOrdinal", { count: "1" });
    const confirmed = await askConfirm({
      title: t("confirm.removeAccountTitle"),
      body: t("codexAuth.removeConfirm", { id: label }),
      confirmLabel: t("confirm.removeAction"),
      tone: "danger",
    });
    if (!confirmed) return;
    const result = await controller.removeAccount(id);
    if (!result.ok) notify({ tone: "error", title: t("codexAuth.removeFailed") });
  };

  const refreshQuotas = async () => {
    setRefreshingQuota(true);
    try {
      const ok = await load(true);
      // The tone follows `ok`. It did not before: both outcomes went through one
      // setter that left the error flag untouched, so a failed quota refresh
      // announced itself in the success colour.
      notify({
        tone: ok ? "success" : "error",
        title: t(ok ? "codexAuth.quotaRefreshed" : "codexAuth.quotaRefreshFailed"),
      });
    } finally {
      setRefreshingQuota(false);
    }
  };

  const pauseExhausted = async () => {
    const result = await controller.pauseExhaustedAccounts();
    if (!result.ok && result.reason === "busy") return;
    notify({
      tone: result.ok ? "success" : "error",
      title: result.ok
        ? result.pausedCount > 0
          ? t("codexAuth.pauseExhaustedSucceeded", { count: String(result.pausedCount) })
          : t("codexAuth.pauseExhaustedNone")
        : t("codexAuth.pauseExhaustedFailed"),
    });
  };

  const openResetPopup = async (account: CodexAccountEntry) => {
    setResetPopup(account);
    setResetConfirm(false);
    setCreditDetails(null);
    setCreditDetailsLoading(true);
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits?accountId=${encodeURIComponent(account.id)}`);
      const data = await readJsonIfOk<{ credits?: { granted_at: string; expires_at: string }[] }>(resp);
      if (data) {
        const sorted = (data.credits ?? []).sort((a, b) =>
          new Date(a.granted_at).getTime() - new Date(b.granted_at).getTime()
        );
        setCreditDetails(sorted);
      }
    } catch { /* detail fetch is non-blocking */ }
    finally { setCreditDetailsLoading(false); }
  };

  const handleRedeem = async (accountId: string) => {
    setRedeeming(true);
    try {
      const result = await redeemResetCredit(apiBase, accountId, t, load);
      if (result.close) {
        setResetPopup(null);
        setResetConfirm(false);
      }
      if (result.toast) notify({ tone: result.ok ? "success" : "error", title: result.toast });
    } finally {
      setRedeeming(false);
    }
  };

  const main = accounts.find(a => a.isMain);
  const pool = accounts.filter(a => !a.isMain);
  const isMainActive = !main?.paused && (!activeId || activeId === "__main__");
  const switchActionLabel = t(accountModeState === "direct" ? "codexAuth.prepareForPool" : "codexAuth.setAsNext");
  const actionsBusy = refreshingQuota || pausingExhausted || pauseUpdatingId !== null;

  // The settings this surface owns, in the order they render below the pool. Each is
  // searchable by its label, its explanation and the option labels a user is likelier
  // to remember ("round-robin") than the control's own name.
  const autoSwitchReady = autoSwitch.threshold !== null;
  const autoSwitchOn = autoSwitchReady && (autoSwitch.threshold ?? 0) > 0;
  const autoSwitchDesc = !autoSwitchReady
    ? t("common.loading")
    : autoSwitchOn
      ? t("codexAuth.autoSwitchDesc", { threshold: autoSwitch.threshold ?? 0 })
      : t("codexAuth.autoSwitchOffDesc");
  const strategyDesc = t("accountPool.strategyDesc");
  const stickyDesc = t("accountPool.stickyLimitHelp");
  const settingsHere: SettingsHit[] = [
    {
      id: "autoSwitch",
      label: t("codexAuth.autoSwitch"),
      desc: autoSwitchDesc,
      // Only claimed once the server value has actually arrived — an unread threshold
      // is not "0%", it is unknown, and printing a number for it would be a lie.
      value: autoSwitchOn ? `${autoSwitch.threshold}%` : "",
      haystack: [t("codexAuth.autoSwitch"), autoSwitchDesc, t("codexAuth.autoSwitchThreshold")].join(" "),
    },
    {
      id: "poolStrategy",
      label: t("accountPool.strategy"),
      desc: strategyDesc,
      // The strategy card owns the live value; this row deliberately shows no value
      // rather than a stale guess at one.
      value: "",
      haystack: [
        t("accountPool.strategy"),
        strategyDesc,
        t("accountPool.strategyHint"),
        t("accountPool.strategyQuota"),
        t("accountPool.strategyRoundRobin"),
        t("accountPool.strategyFillFirst"),
      ].join(" "),
    },
    {
      id: "stickyLimit",
      label: t("accountPool.stickyLimit"),
      desc: stickyDesc,
      value: "",
      haystack: [t("accountPool.stickyLimit"), stickyDesc].join(" "),
    },
  ];

  /** Account-pool settings that live on another screen, so a miss here still points somewhere. */
  const settingsElsewhere = [
    { id: "anthropicPool", label: t("anthropicPool.title"), tab: t("nav.providers") },
    { id: "anthropicPoolThreshold", label: t("anthropicPool.threshold"), tab: t("nav.providers") },
  ];

  // The flags travel with the query into the matcher. `makeMatcher` drops `g` and
  // `y` before compiling — both carry `lastIndex` between calls, so this one
  // matcher reused down `settingsHere` and then again down `settingsElsewhere`
  // would answer true, false, true, false and lose half the matching rows to
  // nothing but the order they were tested in.
  const settingsMatcher = makeMatcher(settingsQuery, settingsRegex, settingsFlags);
  const settingsHits = settingsHere.filter(row => settingsMatcher.test(row.haystack));
  // Only claimed once something was actually typed — an untouched field has not
  // matched anything, here or anywhere else.
  const settingsOtherHits = settingsQuery ? settingsElsewhere.filter(row => settingsMatcher.test(row.label)) : [];
  const settingsOtherTabs = [...new Set(settingsOtherHits.map(row => row.tab))].join(", ");
  const settingsNote = settingsMatcher.error
    ? `${t("regex.invalid")}: ${settingsMatcher.error}`
    : settingsOtherHits.length
      ? t("settings.otherTab", { count: settingsOtherHits.length, tabs: settingsOtherTabs })
      : settingsQuery && settingsHits.length === 0
        ? t("settings.noMatch")
        : "";

  return (
    <div>
      {/* No in-page title: the app bar already renders the screen's <h1>, and the
          prototype's screen opens on the lead. A second <h1> here was also a
          duplicate landmark for anyone navigating by heading. */}
      {lead}

      {/* The prototype's top action row: refresh first, then adding an account. The
          add button used to sit in the pool heading, which put the one control that
          grows the pool below every card it would appear among. Pausing every
          exhausted account is this build's own bulk action and rides along here. */}
      <div
        className="m3-row"
        style={{ gap: 8, marginBottom: "var(--sp-3)", justifyContent: embedded ? "flex-end" : undefined }}
      >
        <button
          type="button"
          className="m3-btn m3-btn--filled"
          onClick={() => { void refreshQuotas(); }}
          disabled={actionsBusy}
        >
          <IconRefresh width={14} aria-hidden="true" /> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
        </button>
        <button type="button" className="m3-btn m3-btn--outlined" onClick={() => setShowAdd(true)}>
          <IconPlus width={14} aria-hidden="true" /> {t("codexAuth.addAccount")}
        </button>
        <button
          type="button"
          className="m3-btn m3-btn--outlined"
          onClick={() => { void pauseExhausted(); }}
          disabled={actionsBusy}
        >
          <IconPause width={14} aria-hidden="true" /> {pausingExhausted ? t("codexAuth.pausingExhausted") : t("codexAuth.pauseExhausted")}
        </button>
      </div>

      <CodexAccountPoolLoadStates
        t={t}
        loadState={loadState}
        accountsCount={accounts.length}
        onRetry={() => { void load(); }}
      />

      {banner}

      <CodexAccountPoolMainCard
        t={t}
        main={main}
        isMainActive={isMainActive}
        accountModeState={accountModeState}
        threshold={autoSwitch.threshold ?? 0}
        switchActionLabel={switchActionLabel}
        onSwitch={setConfirm}
        onTogglePause={togglePaused}
        pauseUpdatingId={pauseUpdatingId}
        pauseBusy={pauseUpdatingId !== null || pausingExhausted}
        onOpenReset={openResetPopup}
        onCopyDoctor={copyDoctor}
        doctorCopyOutcomeFor={doctorCopy.outcomeFor}
      />

      <h2 style={SECTION_TITLE}>{t("codexAuth.accountPool")}</h2>

      {activePoolNeedsReauth && activePoolAccount && (
        <CodexAccountPoolReauthBanner onReauth={() => openReauth(activePoolAccount.id)} />
      )}

      {pool.length === 0 && <Empty title={t("codexAuth.noPool")} />}

      <div style={POOL_GRID}>
        <CodexAccountPoolCards
          pool={pool}
          activeId={activeId}
          accountModeState={accountModeState}
          switchActionLabel={switchActionLabel}
          threshold={autoSwitch.threshold ?? 0}
          onOpenReset={openResetPopup}
          onSwitch={setConfirm}
          onTogglePause={togglePaused}
          pauseUpdatingId={pauseUpdatingId}
          pauseBusy={pauseUpdatingId !== null || pausingExhausted}
          onReauth={openReauth}
          onEditAlias={editAlias}
          onRemove={remove}
          onCopyDoctor={copyDoctor}
          doctorCopyOutcomeFor={doctorCopy.outcomeFor}
        />
      </div>

      {/* The prototype's Settings block: heading, then this surface's own settings
          search, then the cards it describes. Plain text stays the default; `.*` is
          the explicit opt-in, and the full builder is one click away, anchored to
          this field rather than parked in a menu. */}
      <h2 style={SECTION_TITLE}>{t("common.settings")}</h2>

      <div className="m3-row" role="search" style={{ gap: 8 }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          type="search"
          value={settingsQuery}
          onChange={e => setSettingsQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={settingsMatcher.error !== null}
          // Only in regex mode, because that is the only mode the flags row
          // renders in — a description pointing at an element that is not on the
          // page reads as a broken reference rather than as no description.
          aria-describedby={settingsRegex ? SETTINGS_FLAGS_STATE_ID : undefined}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0, maxWidth: 420 }}
        />
        <Chip
          selected={settingsRegex}
          onClick={() => setSettingsRegex(v => !v)}
          title={t("regex.regexMode")}
          aria-label={t("regex.regexMode")}
        >
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={settingsQuery}
          // Both halves of what the builder composed. Taking the pattern and
          // leaving the flags behind is what made the popover's flag chips
          // decorative from this field's point of view.
          onApply={(pattern, appliedFlags) => { setSettingsQuery(pattern); setSettingsFlags(appliedFlags); }}
          regex={settingsRegex}
          onRegexChange={setSettingsRegex}
          // Seeded from this bar's own flags, so the round trip is bidirectional:
          // a set corrected on the chip row below is what the panel opens holding,
          // rather than the panel silently resetting it to the default on open.
          flags={settingsFlags}
          // The settings this surface indexes, so a pattern is tried against the
          // rows it will actually be run over rather than against an empty box.
          sample={settingsHere.map(row => row.haystack).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      {/*
        Under the field rather than inside the search row: that row is a single
        flex line already carrying the input, the `.*` chip and the builder
        trigger, and six more chips in it would squeeze the field to nothing at
        the narrow widths this surface is checked at. It stays directly beneath
        the search it describes, which is what anchoring it here is for, and it
        renders only in regex mode — chips that look live while plain text runs a
        case-insensitive substring search would be exactly the decorative
        affordance the interface rules forbid.
      */}
      <SearchFlagsRow
        regex={settingsRegex}
        flags={settingsFlags}
        onFlagsChange={setSettingsFlags}
        id={SETTINGS_FLAGS_STATE_ID}
      />
      <p
        role={settingsMatcher.error ? "alert" : "status"}
        style={{
          minHeight: 20,
          margin: "4px 0 var(--sp-2)",
          color: settingsMatcher.error ? "var(--m3-error)" : "var(--m3-on-surface-variant)",
          fontSize: "var(--t-label-m)",
        }}
      >
        {settingsNote}
      </p>
      {/* Hits appear only once something has been typed — an untouched field would
          otherwise list every setting twice, above the cards that already show them. */}
      {settingsQuery && settingsHits.length > 0 && (
        <div data-settings-hits="" style={{ display: "grid", gap: 6, marginBottom: "var(--sp-3)" }}>
          {settingsHits.map(row => (
            <div key={row.id} style={SETTINGS_HIT_ROW}>
              <span style={{ fontSize: "var(--t-body-m)", fontWeight: 500 }}>{row.label}</span>
              <span style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>{row.desc}</span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: "var(--t-label-m)" }}>{row.value}</span>
            </div>
          ))}
        </div>
      )}

      <CodexAutoSwitchSetting
        threshold={autoSwitch.threshold}
        draft={autoSwitch.draft}
        saving={autoSwitch.saving}
        loadError={autoSwitch.loadError}
        feedback={autoSwitch.feedback}
        onDraftChange={autoSwitch.setDraft}
        onEditingChange={autoSwitch.setEditing}
        onCommit={autoSwitch.commit}
        onCancel={autoSwitch.cancel}
        onToggle={autoSwitch.toggle}
        onRetry={() => {
          autoSwitch.retry();
          void load();
        }}
      />

      <CodexPoolStrategySetting apiBase={apiBase} />

      {confirm && (
        <CodexAccountSwitchModal
          confirm={confirm}
          mainEmail={main?.email}
          accountModeState={accountModeState}
          switchingId={switchingId}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { void setActive(confirm.id === "__main__" ? "__main__" : confirm.id); }}
        />
      )}

      {resetPopup && (
        <CodexAccountResetModal
          resetPopup={resetPopup}
          resetConfirm={resetConfirm}
          creditDetails={creditDetails}
          creditDetailsLoading={creditDetailsLoading}
          redeeming={redeeming}
          onClose={() => { setResetPopup(null); setResetConfirm(false); setCreditDetails(null); }}
          onShowConfirm={() => setResetConfirm(true)}
          onCancelConfirm={() => setResetConfirm(false)}
          onRedeem={() => { void handleRedeem(resetPopup.id); }}
        />
      )}

      {showAdd && (
        <AddCodexAccountModal
          apiBase={apiBase}
          reauthAccountId={reauthId ?? undefined}
          onClose={closeAddModal}
          onAdded={handleAccountAdded}
        />
      )}
    </div>
  );
}
