/**
 * One authenticator entry: selection checkbox, issuer/account, live code, and
 * its row actions. Rename edits in place rather than opening a second dialog —
 * two fields do not earn one — while "move into group" opens the shared
 * picker dialog (`AuthenticatorGroupPicker`), because that one genuinely needs
 * a real surface per the contract's own rule against inlining one menu item
 * per group.
 */

import { useState } from "react";
import { Button, TextInput } from "../../shell/m3-ui";
import { IconTrash } from "../../icons";
import { useT } from "../../i18n/shared";
import { useCopyFeedback } from "../use-copy-feedback";
import { useAuthenticatorCode } from "../../pages/use-authenticator-code";
import AuthenticatorCodeDisplay from "./AuthenticatorCodeDisplay";
import type { AuthenticatorEntryMeta } from "../../pages/authenticator-api";

export interface AuthenticatorEntryRowProps {
  apiBase: string;
  entry: AuthenticatorEntryMeta;
  groupName: string | null;
  selected: boolean;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onRename: (id: string, issuer: string, account: string) => Promise<void>;
  onDelete: (entry: AuthenticatorEntryMeta) => void;
  onMoveToGroup: (entry: AuthenticatorEntryMeta) => void;
}

export default function AuthenticatorEntryRow({
  apiBase, entry, groupName, selected, onToggleSelect, onRename, onDelete, onMoveToGroup,
}: AuthenticatorEntryRowProps) {
  const t = useT();
  const codeState = useAuthenticatorCode(apiBase, entry.id);
  const { outcomeFor, copy } = useCopyFeedback<string>();
  const [editing, setEditing] = useState(false);
  const [issuerDraft, setIssuerDraft] = useState(entry.issuer);
  const [accountDraft, setAccountDraft] = useState(entry.account);
  const [saving, setSaving] = useState(false);

  const label = entry.issuer ? `${entry.issuer} · ${entry.account}` : entry.account;

  const startEdit = () => {
    setIssuerDraft(entry.issuer);
    setAccountDraft(entry.account);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onRename(entry.id, issuerDraft, accountDraft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="m3-authenticator-row" data-selected={selected || undefined}>
      <input
        type="checkbox"
        className="m3-checkbox"
        checked={selected}
        aria-label={t("auth.entry.selectAria", { label })}
        onClick={event => onToggleSelect(entry.id, (event as unknown as { shiftKey: boolean }).shiftKey)}
        onChange={() => { /* click handles it, so shiftKey is available */ }}
      />

      <div className="m3-authenticator-row-main">
        {editing ? (
          <div className="m3-authenticator-row-edit" role="group" aria-label={t("auth.entry.renameTitle")}>
            <TextInput
              value={issuerDraft}
              onChange={e => setIssuerDraft(e.target.value)}
              placeholder={t("auth.entry.issuerLabel")}
              aria-label={t("auth.entry.issuerLabel")}
            />
            <TextInput
              value={accountDraft}
              onChange={e => setAccountDraft(e.target.value)}
              placeholder={t("auth.entry.accountLabel")}
              aria-label={t("auth.entry.accountLabel")}
            />
            <div className="m3-row" style={{ gap: "var(--sp-2)" }}>
              <Button variant="filled" onClick={() => void saveEdit()} disabled={saving}>{t("auth.entry.save")}</Button>
              <Button variant="text" onClick={() => setEditing(false)} disabled={saving}>{t("auth.add.cancel")}</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="m3-authenticator-row-head">
              <span className="m3-authenticator-row-issuer">{entry.issuer || entry.account}</span>
              {entry.issuer && <span className="m3-authenticator-row-account">{entry.account}</span>}
            </div>
            <div className="m3-authenticator-row-meta">
              <span>{t("auth.entry.details", { algorithm: entry.algorithm, digits: entry.digits, period: entry.period })}</span>
              {groupName && <span className="m3-chip">{groupName}</span>}
            </div>
          </>
        )}

        <AuthenticatorCodeDisplay
          code={codeState.code}
          nextCode={codeState.nextCode}
          period={codeState.period}
          secondsRemaining={codeState.secondsRemaining}
          loading={codeState.loading}
          failed={codeState.failed}
          copyOutcome={codeState.code ? outcomeFor(codeState.code) : null}
          onCopyCode={() => { if (codeState.code) copy(codeState.code, codeState.code); }}
          t={t}
        />
      </div>

      {!editing && (
        <div className="m3-authenticator-row-actions" role="group" aria-label={t("auth.entry.menu", { label })}>
          <Button variant="text" onClick={startEdit}>{t("auth.entry.rename")}</Button>
          <Button variant="text" onClick={() => onMoveToGroup(entry)}>{t("auth.group.moveInto")}</Button>
          <Button variant="text" onClick={() => onDelete(entry)} aria-label={`${t("auth.entry.delete")} ${label}`}>
            <IconTrash width={16} height={16} aria-hidden="true" />
            {t("auth.entry.delete")}
          </Button>
        </div>
      )}
    </li>
  );
}
