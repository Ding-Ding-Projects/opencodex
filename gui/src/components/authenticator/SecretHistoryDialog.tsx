/**
 * The Secret & display-name history manager — the password/TOTP-protected
 * surface over `secret-history.ts`'s encrypted+redacted git history.
 *
 * ## The gate, and how it reuses the existing toy-lock system
 *
 * "Opening it" is a real `element`-kind lock, created and verified through
 * the exact same `LockWizard`/`UnlockPrompt`/`locks.ts` machinery the
 * appearance-lock feature already ships and this codebase already tests —
 * the credential lives in `credential-vault.ts`'s vault exactly as any other
 * lock's does. Reusing it here is deliberate: two password-verification
 * systems in one app would be two systems to keep in sync, and this one
 * already does everything the contract asks of the "own locally verified
 * password/PIN/TOTP factor" gate.
 *
 * `HISTORY_LOCK_ID` (below) is only ever the `targetId` half of the
 * `(kind, targetId)` pair `findLock` searches by — it is NEVER itself the
 * credential-vault key. `createLock` generates its own random `LockRecord.id`
 * and stores the credential under THAT, so every credential-vault call below
 * (`attemptUnlock`, `credentialMethod`, `relock`) is addressed by
 * `lock.id`/`lockRecordId`, never by the constant directly — see
 * `gui/tests/secret-history-lock.test.ts`, which exists specifically because
 * an earlier version of this file got that distinction wrong and silently
 * rejected every correct password.
 *
 * Restoring, exporting, and changing retention each demand a FRESH check on
 * top of that — "no implicit master unlock" — so those three never consult
 * `isUnlocked()`. `Reverify` below always renders its own password/code
 * field and always calls `attemptUnlock` again, regardless of whether the
 * panel itself is currently unlocked.
 *
 * ## What this panel does not attempt
 *
 * "Diff" is the plain redacted JSON of the selected commit, exactly like
 * `history-payload.tsx` already renders for the account-history panel — a
 * full structural diff between two arbitrary commits is out of scope here.
 * "Label" (renaming a past revision) is not offered: unlike the browser-local
 * revision log, a commit in this git history is the record, and giving it an
 * editable label would mean either rewriting a "never rewritten" commit or
 * inventing a second, unversioned store just to hold labels — both worse
 * than not having the feature.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Banner, Button, Chip, Dialog, Empty, Field, TextInput,
} from "../../shell/m3-ui";
import { RegexBuilderButton } from "../../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../../shell/settings-search";
import { isValidIsoDate } from "../../pages/history-model";
import { IconClock, IconDownload, IconHistory, IconLock, IconSearch, IconUndo } from "../../icons";
import { useT } from "../../i18n/shared";
import type { TKey } from "../../i18n/shared";
import { useNotifications } from "../../shell/notifications-context";
import {
  attemptUnlock, findLock, relock, subscribeLocks, type LockRecord,
} from "../../shell/locks";
import { credentialMethod } from "../../shell/credential-vault";
import { LockWizard } from "../../shell/LockWizard";
import { UnlockPrompt } from "../../shell/UnlockPrompt";
import {
  exportSecretHistory, fetchSecretHistory, restoreSecretHistory, setSecretHistoryRetention,
  type SecretHistoryEntry,
} from "../../pages/secret-history-api";
import { resetAppName, setAppName } from "../../theme/app-name";
import { recordDisplayNameHistory } from "../../pages/secret-history-api";

/** Fixed, stable id — never derived from the app's (renamable) display name, so a rename cannot orphan this credential. */
export const HISTORY_LOCK_ID = "secret-history-manager";

const HISTORY_REGEX_SAMPLE_ROWS = 40;

function actionKey(action: string): TKey | null {
  const map: Record<string, TKey> = {
    created: "secretHistory.action.created",
    updated: "secretHistory.action.updated",
    removed: "secretHistory.action.removed",
    "bulk-removed": "secretHistory.action.bulkRemoved",
    renamed: "secretHistory.action.renamed",
    reset: "secretHistory.action.reset",
    restored: "secretHistory.action.restored",
    "retention-changed": "secretHistory.action.retentionChanged",
  };
  return map[action] ?? null;
}

function summaryFor(entry: SecretHistoryEntry, t: ReturnType<typeof useT>): string {
  if (entry.kind === "display-name") {
    const r = entry.redacted as { previous?: string; next?: string };
    return t("secretHistory.summaryDisplayName", { previous: r.previous ?? "", next: r.next ?? "" });
  }
  if (entry.kind === "retention") {
    const r = entry.redacted as { days?: number | null };
    return r.days ? t("secretHistory.summaryRetentionDays", { days: String(r.days) }) : t("secretHistory.summaryRetentionForever");
  }
  const r = entry.redacted as { changedIssuer?: string; changedAccount?: string; entries?: unknown[] };
  if (r.changedIssuer || r.changedAccount) {
    return [r.changedIssuer, r.changedAccount].filter(Boolean).join(" · ");
  }
  return t("secretHistory.summaryEntryCount", { count: String(r.entries?.length ?? 0) });
}

/**
 * Always renders its own password/code field and always re-verifies against
 * the same credential — never short-circuited by an existing "opened"
 * session. This is what makes restore/export/retention each require their
 * own fresh check rather than riding on the panel already being unlocked.
 */
function Reverify({ lockRecordId, actionLabel, onVerified, onCancel }: {
  /**
   * The REAL credential-vault key — `LockRecord.id`, a random id `createLock`
   * generates, never `HISTORY_LOCK_ID` itself. `HISTORY_LOCK_ID` is only the
   * `(kind, targetId)` pair `findLock` searches by; the credential
   * `attemptUnlock`/`credentialMethod` need is keyed by the record's OWN id.
   * Passing the constant here instead is exactly the bug a dedicated test
   * (`secret-history-lock.test.ts`) exists to catch — every check silently
   * misses the stored credential and reports every password as wrong.
   */
  lockRecordId: string;
  actionLabel: string; onVerified: () => void; onCancel: () => void;
}) {
  const t = useT();
  const fieldId = useId();
  const method = credentialMethod(lockRecordId);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "wrong">("idle");

  const submit = async () => {
    setStatus("checking");
    const outcome = await attemptUnlock(lockRecordId, method === "password" ? { password } : { code }, "here");
    if (outcome === "ok") { onVerified(); return; }
    setStatus("wrong");
  };

  return (
    <div style={{ display: "grid", gap: 8, padding: "var(--sp-2) 0" }}>
      <p style={{ margin: 0, fontSize: "var(--t-body-s)" }}>{t("secretHistory.reverifyPrompt", { action: actionLabel })}</p>
      {method === "password" ? (
        <Field label={t("lock.wizard.password")} id={fieldId}>
          <TextInput
            id={fieldId} type="password" value={password} autoComplete="current-password"
            onChange={e => { setPassword(e.target.value); setStatus("idle"); }}
            onKeyDown={e => { if (e.key === "Enter") void submit(); }}
          />
        </Field>
      ) : (
        <Field label={t("lock.wizard.totpConfirmCode")} id={fieldId}>
          <TextInput
            id={fieldId} inputMode="numeric" pattern="[0-9]*" maxLength={6} value={code}
            onChange={e => { setCode(e.target.value.replace(/\D/g, "")); setStatus("idle"); }}
            onKeyDown={e => { if (e.key === "Enter") void submit(); }}
            style={{ width: 120, fontFamily: "var(--mono)" }}
          />
        </Field>
      )}
      {status === "wrong" && <p role="alert" style={{ margin: 0, color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t(method === "password" ? "lock.wrongPassword" : "lock.wrongCode")}</p>}
      <div className="m3-row" style={{ gap: 8 }}>
        <Button
          variant="filled" disabled={status === "checking" || (method === "password" ? password.length === 0 : code.length !== 6)}
          onClick={() => void submit()}
        >
          {status === "checking" ? t("lock.unlocking") : t("secretHistory.reverifyConfirm")}
        </Button>
        <Button variant="text" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}

export interface SecretHistoryDialogProps {
  apiBase: string;
  onClose: () => void;
  /** Called after a totp-entry restore actually writes new entries back, so the caller can refresh its own list. */
  onTotpRestored: () => void;
}

type PendingAction = { kind: "restore"; entry: SecretHistoryEntry } | { kind: "export" } | { kind: "retention" } | null;

export default function SecretHistoryDialog({ apiBase, onClose, onTotpRestored }: SecretHistoryDialogProps) {
  const t = useT();
  const { notify } = useNotifications();
  const [lock, setLock] = useState<LockRecord | undefined>(() => findLock("element", HISTORY_LOCK_ID));
  // Whether a LockRecord exists for this (kind, targetId) pair — NOT
  // `lockHasCredential(HISTORY_LOCK_ID)`, which would check the credential
  // vault under the wrong key (see the note on `Reverify` above). `createLock`
  // always writes its credential before the record, so "a record exists"
  // already implies "a credential exists".
  const [wizardOpen, setWizardOpen] = useState(() => !findLock("element", HISTORY_LOCK_ID));
  const [unlockedOnce, setUnlockedOnce] = useState(false);

  useEffect(() => subscribeLocks(() => setLock(findLock("element", HISTORY_LOCK_ID))), []);

  const [entries, setEntries] = useState<SecretHistoryEntry[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [retentionDraft, setRetentionDraft] = useState("");

  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [actionFilter, setActionFilter] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const data = await fetchSecretHistory(apiBase);
      setEntries(data.entries);
      setRetentionDays(data.retentionDays);
      setRetentionDraft(data.retentionDays === null ? "" : String(data.retentionDays));
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (unlockedOnce) void load(); }, [unlockedOnce]);

  const distinctActions = useMemo(() => [...new Set(entries.map(e => e.action))], [entries]);

  const fromValid = from === "" || isValidIsoDate(from);
  const toValid = to === "" || isValidIsoDate(to);

  const sample = useMemo(
    () => entries.slice(0, HISTORY_REGEX_SAMPLE_ROWS).map(e => `${e.kind} ${e.action} ${JSON.stringify(e.redacted)}`).join("\n"),
    [entries],
  );

  const { rows, patternError } = useMemo(() => {
    const matcher = query.trim() ? settingsMatcher(query, useRegex, flags) : null;
    if (matcher?.error) return { rows: [] as SecretHistoryEntry[], patternError: matcher.error };
    const fromMs = fromValid && from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toMs = toValid && to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    const filtered = entries.filter(e => {
      if (actionFilter.size > 0 && !actionFilter.has(e.action)) return false;
      const at = new Date(e.at).getTime();
      if (fromMs !== null && at < fromMs) return false;
      if (toMs !== null && at > toMs) return false;
      if (matcher && !matcher.test(`${e.kind} ${e.action} ${JSON.stringify(e.redacted)}`)) return false;
      return true;
    });
    return { rows: filtered, patternError: null as string | null };
  }, [entries, query, useRegex, flags, from, to, fromValid, toValid, actionFilter]);

  const selected = rows.find(e => e.hash === selectedHash) ?? rows[0] ?? null;

  const toggleAction = (action: string) => {
    setActionFilter(current => {
      const next = new Set(current);
      if (next.has(action)) next.delete(action); else next.add(action);
      return next;
    });
  };

  const performRestore = async (entry: SecretHistoryEntry) => {
    try {
      const result = await restoreSecretHistory(apiBase, entry.hash);
      if (result.kind === "totp-entry") {
        notify({
          tone: result.historyRecorded ? "success" : "warn",
          title: t("secretHistory.restored"),
          body: result.historyRecorded ? undefined : t("secretHistory.recoveryNotice", { reason: result.historyReason ?? "" }),
        });
        onTotpRestored();
      } else {
        const value = result.value;
        const commit = value === null ? resetAppName() : setAppName(value);
        if (commit.applied) {
          const history = await recordDisplayNameHistory(apiBase, {
            action: "restored", previous: commit.previousDisplay, next: commit.display,
          });
          notify({
            tone: history.historyRecorded ? "success" : "warn",
            title: t("secretHistory.restored"),
            body: history.historyRecorded ? undefined : t("secretHistory.recoveryNotice", { reason: history.historyReason ?? "" }),
          });
        } else {
          notify({ tone: "info", title: t("secretHistory.restored") });
        }
      }
      await load();
    } catch {
      notify({ tone: "error", title: t("secretHistory.errors.restoreFailed") });
    } finally {
      setPending(null);
    }
  };

  const performExport = async () => {
    try {
      const data = await exportSecretHistory(apiBase);
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `${stamp}-opencodex-secret-history-redacted.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify({ tone: "success", title: t("secretHistory.exported") });
    } catch {
      notify({ tone: "error", title: t("secretHistory.errors.exportFailed") });
    } finally {
      setPending(null);
    }
  };

  const performRetention = async () => {
    const trimmed = retentionDraft.trim();
    const days = trimmed === "" ? null : Number(trimmed);
    if (days !== null && (!Number.isInteger(days) || days <= 0)) {
      notify({ tone: "error", title: t("secretHistory.errors.retentionInvalid") });
      setPending(null);
      return;
    }
    try {
      const result = await setSecretHistoryRetention(apiBase, days);
      if (!result.ok) {
        notify({ tone: "error", title: t("secretHistory.errors.retentionFailed"), body: result.reason });
      } else {
        notify({ tone: "success", title: t("secretHistory.retentionApplied", { pruned: String(result.prunedCount) }) });
      }
      await load();
    } catch {
      notify({ tone: "error", title: t("secretHistory.errors.retentionFailed") });
    } finally {
      setPending(null);
    }
  };

  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      dismissOnScrim={pending === null}
      title={
        <span className="m3-row" style={{ gap: 8 }}>
          <IconHistory width={20} height={20} aria-hidden="true" /> {t("secretHistory.title")}
        </span>
      }
    >
      <p style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
        {t("secretHistory.sub")}
      </p>

      {wizardOpen && (
        <LockWizard
          anchor={anchorRef.current}
          kind="element"
          targetId={HISTORY_LOCK_ID}
          targetLabel={t("secretHistory.title")}
          onClose={() => { const created = findLock("element", HISTORY_LOCK_ID); setWizardOpen(false); if (!created) onClose(); }}
          onSaved={record => { setLock(record); setWizardOpen(false); }}
        />
      )}

      {!wizardOpen && lock && !unlockedOnce && (
        <UnlockPrompt lock={lock} onUnlocked={() => setUnlockedOnce(true)} onForgotten={undefined} />
      )}

      {!wizardOpen && lock && unlockedOnce && (
        <div style={{ display: "grid", gap: "var(--sp-3)" }}>
          <div className="m3-row" style={{ gap: 8, alignItems: "center" }}>
            <IconLock width={16} height={16} aria-hidden="true" style={{ opacity: 0.6 }} />
            <span style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>{t("secretHistory.opened")}</span>
            <Button variant="text" onClick={() => { relock(lock.id); setUnlockedOnce(false); }} style={{ marginLeft: "auto" }}>
              {t("lock.lockAgain")}
            </Button>
          </div>

          {loadFailed && <Banner tone="error" title={t("secretHistory.errors.loadFailed")} />}

          <div className="m3-row" role="search" style={{ gap: 8 }}>
            <IconSearch width={18} height={18} aria-hidden="true" />
            <TextInput
              value={query} onChange={e => setQuery(e.target.value)}
              placeholder={t("secretHistory.search")} aria-label={t("secretHistory.search")}
              aria-invalid={!!patternError} style={{ flex: "1 1 auto", width: "auto" }}
            />
            <RegexBuilderButton
              value={query}
              onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
              regex={useRegex} onRegexChange={setUseRegex} flags={flags} sample={sample}
              label={t("secretHistory.search")}
            />
          </div>
          {patternError && <p role="alert" style={{ margin: 0, color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>{t("regex.invalid")}: {patternError}</p>}
          <SearchFlagsRow regex={useRegex} flags={flags} onFlagsChange={setFlags} id="secret-history-regex-flags" />

          <div className="m3-row" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
            <Field id="secret-history-from" label={t("changelog.from")}>
              <TextInput id="secret-history-from" type="date" value={from} aria-invalid={!fromValid} onChange={e => setFrom(e.target.value)} />
            </Field>
            <Field id="secret-history-to" label={t("changelog.to")}>
              <TextInput id="secret-history-to" type="date" value={to} aria-invalid={!toValid} onChange={e => setTo(e.target.value)} />
            </Field>
            <div role="group" aria-label={t("history.colScope")} className="m3-row" style={{ gap: 6, flexWrap: "wrap" }}>
              {distinctActions.map(action => (
                <Chip key={action} selected={actionFilter.has(action)} onClick={() => toggleAction(action)}>
                  {actionKey(action) ? t(actionKey(action)!) : action}
                </Chip>
              ))}
            </div>
          </div>

          {loading ? (
            <p style={{ color: "var(--m3-on-surface-variant)" }}>{t("common.loading")}</p>
          ) : rows.length === 0 ? (
            <Empty title={t("secretHistory.empty")}>{t("secretHistory.emptyBody")}</Empty>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)" }}>
              <ul
                aria-label={t("secretHistory.title")}
                style={{
                  flex: "1 1 260px", minWidth: 0, listStyle: "none", margin: 0, padding: 8,
                  borderRadius: "var(--r-l)", background: "var(--m3-surface-container-low)",
                  border: "1px solid var(--m3-outline-variant)", maxHeight: 320, overflowY: "auto",
                }}
              >
                {rows.map(entry => {
                  const on = entry.hash === selected?.hash;
                  return (
                    <li key={entry.hash}>
                      <button
                        type="button" aria-current={on ? "true" : undefined} onClick={() => setSelectedHash(entry.hash)}
                        style={{
                          display: "block", width: "100%", textAlign: "left", font: "inherit",
                          padding: "8px 10px", border: "none", borderRadius: "var(--r-m)", cursor: "pointer",
                          background: on ? "var(--m3-secondary-container)" : "transparent",
                          color: on ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface)",
                        }}
                      >
                        <span style={{ display: "block", fontSize: "var(--t-body-s)", fontWeight: 500 }}>
                          {actionKey(entry.action) ? t(actionKey(entry.action)!) : entry.action}
                        </span>
                        <span style={{ display: "block", fontSize: "var(--t-label-s)", color: on ? "inherit" : "var(--m3-on-surface-variant)" }}>
                          {summaryFor(entry, t)}
                        </span>
                        <span style={{ display: "block", fontSize: "var(--t-label-s)", fontFamily: "var(--mono)", color: on ? "inherit" : "var(--m3-on-surface-variant)" }}>
                          {entry.short} · {new Date(entry.at).toLocaleString()}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {selected && (
                <div style={{ flex: "2 1 300px", minWidth: 0 }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: "var(--t-title-s)" }}>{t("secretHistory.diff")}</h3>
                  <pre style={{
                    margin: 0, padding: 10, borderRadius: "var(--r-m)", background: "var(--m3-surface-container-low)",
                    fontSize: "var(--t-label-s)", fontFamily: "var(--mono)", overflow: "auto", maxHeight: 220,
                  }}>
                    {JSON.stringify(selected.redacted, null, 2)}
                  </pre>
                  {!selected.hasSensitiveSnapshot && selected.kind === "totp-entry" && (
                    <Banner tone="info">{t("secretHistory.noSnapshot")}</Banner>
                  )}

                  {pending?.kind === "restore" && pending.entry.hash === selected.hash ? (
                    <Reverify
                      lockRecordId={lock.id}
                      actionLabel={t("secretHistory.restore")}
                      onVerified={() => void performRestore(selected)}
                      onCancel={() => setPending(null)}
                    />
                  ) : (
                    <Button variant="filled" style={{ marginTop: 8 }} onClick={() => setPending({ kind: "restore", entry: selected })}>
                      <IconUndo aria-hidden="true" /> {t("secretHistory.restore")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          <hr style={{ border: "none", borderTop: "1px solid var(--m3-outline-variant)", margin: 0 }} />

          <div>
            <h3 style={{ margin: "0 0 4px", fontSize: "var(--t-title-s)" }}>{t("secretHistory.export")}</h3>
            {pending?.kind === "export" ? (
              <Reverify lockRecordId={lock.id} actionLabel={t("secretHistory.export")} onVerified={() => void performExport()} onCancel={() => setPending(null)} />
            ) : (
              <Button variant="outlined" onClick={() => setPending({ kind: "export" })}>
                <IconDownload aria-hidden="true" /> {t("secretHistory.exportButton")}
              </Button>
            )}
          </div>

          <div>
            <h3 className="m3-row" style={{ margin: "0 0 4px", gap: 6, fontSize: "var(--t-title-s)" }}>
              <IconClock width={16} height={16} aria-hidden="true" /> {t("secretHistory.retention")}
            </h3>
            <p style={{ margin: "0 0 8px", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
              {retentionDays === null ? t("secretHistory.retentionForever") : t("secretHistory.retentionCurrent", { days: String(retentionDays) })}
            </p>
            {pending?.kind === "retention" ? (
              <Reverify lockRecordId={lock.id} actionLabel={t("secretHistory.retention")} onVerified={() => void performRetention()} onCancel={() => setPending(null)} />
            ) : (
              <div className="m3-row" style={{ gap: 8 }}>
                <TextInput
                  value={retentionDraft} onChange={e => setRetentionDraft(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder={t("secretHistory.retentionForever")} aria-label={t("secretHistory.retention")}
                  style={{ width: 120 }}
                />
                <Button variant="outlined" onClick={() => setPending({ kind: "retention" })}>{t("secretHistory.retentionApply")}</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
