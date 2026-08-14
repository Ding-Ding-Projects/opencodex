/**
 * "Move… into group…" as a picker dialog, never a menu with one item per
 * group. A right-click or row menu that inlined one entry per group would
 * grow without bound as groups accumulate; this opens instead, lists the
 * existing groups with a member count, offers "no group" and "create a new
 * group" as real options, and carries its own filter field wired to the
 * shared regex builder like every other search surface in this app.
 */

import { useMemo, useState } from "react";
import { Dialog, TextInput, Button, Chip } from "../../shell/m3-ui";
import { RegexBuilderButton } from "../../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../../shell/settings-search";
import { IconSearch, IconPlus } from "../../icons";
import { useT } from "../../i18n/shared";
import type { AuthenticatorGroup } from "../../pages/authenticator-api";

export interface AuthenticatorGroupPickerProps {
  open: boolean;
  onClose: () => void;
  groups: AuthenticatorGroup[];
  memberCount: (groupId: string) => number;
  /** `null` moves the selection out of every group ("no group"). */
  onPick: (groupId: string | null) => void;
  onCreateGroup: (name: string) => Promise<AuthenticatorGroup>;
}

export default function AuthenticatorGroupPicker({
  open, onClose, groups, memberCount, onPick, onCreateGroup,
}: AuthenticatorGroupPickerProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [newGroupName, setNewGroupName] = useState("");
  const [creating, setCreating] = useState(false);

  const { filtered, error } = useMemo(() => {
    if (!query.trim()) return { filtered: groups, error: null as string | null };
    const matcher = settingsMatcher(query, useRegex, flags);
    if (matcher.error) return { filtered: [] as AuthenticatorGroup[], error: matcher.error };
    return { filtered: groups.filter(g => matcher.test(g.name)), error: null as string | null };
  }, [groups, query, useRegex, flags]);

  const sample = groups.map(g => g.name).join("\n");

  const handleCreate = async () => {
    const name = newGroupName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const group = await onCreateGroup(name);
      onPick(group.id);
      setNewGroupName("");
    } finally {
      setCreating(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} title={t("auth.group.movePickerTitle")} width={420}>
      <div className="m3-row" role="search" style={{ marginBottom: "var(--sp-3)" }}>
        <IconSearch width={18} height={18} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("auth.group.movePickerSearch")}
          aria-label={t("auth.group.movePickerSearch")}
          style={{ flex: "1 1 auto", width: "auto" }}
          autoFocus
        />
        <RegexBuilderButton
          value={query}
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          regex={useRegex}
          onRegexChange={setUseRegex}
          flags={flags}
          sample={sample}
          label={t("auth.group.movePickerSearch")}
        />
      </div>

      {error && <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>{error}</p>}

      <ul role="listbox" aria-label={t("auth.group.movePickerTitle")} className="m3-authenticator-group-list">
        <li>
          <button type="button" className="m3-authenticator-group-option" onClick={() => onPick(null)}>
            {t("auth.group.ungrouped")}
          </button>
        </li>
        {filtered.length === 0 && !error && (
          <li className="m3-authenticator-group-empty">{t("auth.group.movePickerEmpty")}</li>
        )}
        {filtered.map(group => (
          <li key={group.id}>
            <button type="button" className="m3-authenticator-group-option" onClick={() => onPick(group.id)}>
              <span>{group.name}</span>
              <Chip>{memberCount(group.id)}</Chip>
            </button>
          </li>
        ))}
      </ul>

      <div className="m3-row" style={{ marginTop: "var(--sp-3)", gap: "var(--sp-2)" }}>
        <TextInput
          value={newGroupName}
          onChange={e => setNewGroupName(e.target.value)}
          placeholder={t("auth.group.movePickerCreateNew")}
          aria-label={t("auth.group.movePickerCreateNew")}
          style={{ flex: "1 1 auto", width: "auto" }}
          onKeyDown={e => { if (e.key === "Enter") void handleCreate(); }}
        />
        <Button variant="outlined" onClick={() => void handleCreate()} disabled={!newGroupName.trim() || creating}>
          <IconPlus width={16} height={16} aria-hidden="true" />
          {t("auth.group.movePickerCreateNew")}
        </Button>
      </div>
    </Dialog>
  );
}
