/**
 * The joke recovery desk. See `support-tickets.ts` for what it actually does
 * under the comedy — the short version: nothing leaves this machine, and the
 * only real "fix" is a button that opens the app's own data folder so the
 * user can delete it themselves.
 *
 * `support.disclosure` is rendered plainly — no icon, no banner tone, no
 * funny-level styling (that key is deliberately absent from `voice.ts`'s
 * overlay, so it always resolves through the neutral dictionary regardless of
 * the slider). Everything else on this surface may read as playful; this one
 * line never does, because it is the line a user has to actually trust.
 */

import { useEffect, useId, useState } from "react";
import { Button, Chip, Empty, Field, SelectField, TextArea, TextInput } from "./m3-ui";
import { RegexBuilderButton } from "./RegexBuilderButton";
import { SearchFlagsRow } from "./SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "./settings-search";
import { IconSearch, IconTicket } from "../icons";
import { useT } from "../i18n/shared";
import type { TKey } from "../i18n/shared";
import {
  advanceTicket, createTicket, readTickets, subscribeTickets,
  type SupportTicket, type TicketCategory, type TicketStatus,
} from "./support-tickets";
import { hasDesktopAppDataBridge, openAppDataFolder, resolveAppDataPath } from "./app-data-path";
import { copyTextToClipboard } from "../oauth-health-display";
import { useNotifications } from "./notifications-context";

export interface SupportTicketsProps {
  /** Pre-selects "Locked out" and names the lock, when opened from a specific lock's unlock prompt. */
  lockContext?: { label: string };
}

const STATUS_KEY: Record<TicketStatus, TKey> = {
  open: "support.status.open",
  underReview: "support.status.underReview",
  resolved: "support.status.resolved",
};

const SEVERITY_KEY: Record<SupportTicket["severity"], TKey> = {
  low: "support.severity.low",
  medium: "support.severity.medium",
  high: "support.severity.high",
  critical: "support.severity.critical",
};

export default function SupportTickets({ lockContext }: SupportTicketsProps) {
  const t = useT();
  const { notify } = useNotifications();
  const [category, setCategory] = useState<TicketCategory>(lockContext ? "lockedOut" : "somethingElse");
  const [description, setDescription] = useState(lockContext ? t("support.lockedOutContext", { name: lockContext.label }) : "");
  const [tickets, setTickets] = useState<SupportTicket[]>(readTickets);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const searchId = useId();

  useEffect(() => subscribeTickets(() => setTickets(readTickets())), []);

  const submit = () => {
    const ticket = createTicket({ category, description, lockLabel: lockContext?.label });
    setDescription("");
    notify({ tone: "success", title: t("support.created", { number: String(ticket.number) }) });
  };

  const matcher = settingsMatcher(query, useRegex, flags);
  const visible = tickets.filter(ticket => matcher.test(
    `${t(STATUS_KEY[ticket.status])} ${t(SEVERITY_KEY[ticket.severity])} ${ticket.description} ${ticket.number}`,
  ));

  return (
    <section aria-labelledby="support-tickets-title" data-support-tickets style={{ marginTop: "var(--sp-5)" }}>
      <div className="m3-row" style={{ gap: 8, alignItems: "center", marginBottom: 4 }}>
        <IconTicket width={20} height={20} aria-hidden="true" />
        <h2 id="support-tickets-title" className="m3-card-title">{t("support.title")}</h2>
      </div>
      <p className="m3-page-lead" style={{ marginBottom: 8 }}>{t("support.intro")}</p>
      {/* Plain, unstyled, funny-level-invariant — see the module doc. */}
      <p role="note" style={{ margin: "0 0 var(--sp-4)", fontSize: "var(--t-body-s)", fontWeight: 500 }}>
        {t("support.disclosure")}
      </p>

      <div className="m3-card" style={{ marginBottom: "var(--sp-4)" }}>
        <Field label={t("support.form.category")}>
          <SelectField
            value={category}
            onChange={v => setCategory(v as TicketCategory)}
            label={t("support.form.category")}
            options={[
              { value: "lockedOut", label: t("support.category.lockedOut") },
              { value: "somethingElse", label: t("support.category.somethingElse") },
            ]}
          />
        </Field>
        <Field label={t("support.form.description")}>
          <TextArea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={t("support.form.descriptionPlaceholder")}
            rows={3}
            style={{ width: "100%" }}
          />
        </Field>
        <div className="m3-row" style={{ justifyContent: "end" }}>
          <Button variant="filled" disabled={!description.trim()} onClick={submit}>{t("support.submit")}</Button>
        </div>
      </div>

      <h3 className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>{t("support.list.title")}</h3>

      <div className="m3-row" role="search" style={{ margin: "8px 0" }}>
        <IconSearch width={18} height={18} aria-hidden="true" />
        <TextInput
          id={searchId}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("support.list.search")}
          aria-label={t("support.list.search")}
          style={{ flex: "1 1 200px", width: "auto", minWidth: 0 }}
        />
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("regex.regexMode")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          flags={flags}
          regex={useRegex}
          onRegexChange={setUseRegex}
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          sample={tickets.map(ticket => ticket.description).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      <SearchFlagsRow regex={useRegex} flags={flags} onFlagsChange={setFlags} id={`${searchId}-flags`} />

      {tickets.length === 0 ? (
        <Empty title={t("support.list.empty")} />
      ) : visible.length === 0 ? (
        <Empty title={t("locks.noMatch")} />
      ) : (
        <ul style={{ display: "grid", gap: 8, margin: "8px 0 0", padding: 0, listStyle: "none" }}>
          {visible.map(ticket => <TicketRow key={ticket.id} ticket={ticket} />)}
        </ul>
      )}
    </section>
  );
}

function TicketRow({ ticket }: { ticket: SupportTicket }) {
  const t = useT();
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const desktop = hasDesktopAppDataBridge();

  useEffect(() => {
    if (!desktop) return;
    void resolveAppDataPath().then(setFolderPath);
  }, [desktop]);

  const check = () => advanceTicket(ticket.id);

  const openFolder = async () => {
    const ok = await openAppDataFolder();
    setOpenFailed(!ok);
  };

  return (
    <li
      data-ticket={ticket.id}
      style={{
        padding: "14px 16px", borderRadius: "var(--r-l)",
        border: "1px solid var(--m3-outline-variant)", background: "var(--m3-surface-container-lowest)",
      }}
    >
      <div className="m3-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <strong>{t("support.ticketNumber", { number: String(ticket.number) })}</strong>
        <span style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-s)" }}>
          {t("support.severity", { level: t(SEVERITY_KEY[ticket.severity]) })}
        </span>
      </div>
      <p style={{ margin: "6px 0", whiteSpace: "pre-line" }}>{ticket.description}</p>
      <div className="m3-row" style={{ gap: 8, alignItems: "center" }}>
        <Chip>{t(STATUS_KEY[ticket.status])}</Chip>
        {ticket.status !== "resolved" && (
          <Button variant="text" onClick={check}>{t("support.checkStatus")}</Button>
        )}
      </div>

      {ticket.status === "underReview" && (
        <p style={{ margin: "8px 0 0", fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
          {t("support.cannedResponse")}
        </p>
      )}

      {ticket.status === "resolved" && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--m3-outline-variant)" }}>
          <h4 style={{ margin: "0 0 4px", fontSize: "var(--t-title-s)" }}>{t("support.resolution.title")}</h4>
          <p style={{ margin: "0 0 8px" }}>{t("support.resolution.body")}</p>
          {desktop ? (
            <>
              {folderPath && (
                <p style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}>
                  {t("support.resolution.pathLabel")} {folderPath}
                </p>
              )}
              <div className="m3-row" style={{ gap: 8 }}>
                <Button variant="filled" onClick={() => void openFolder()}>{t("support.resolution.openFolder")}</Button>
                {folderPath && (
                  <Button variant="outlined" onClick={() => void copyTextToClipboard(folderPath)}>{t("support.resolution.copyPath")}</Button>
                )}
              </div>
              {openFailed && (
                <p role="alert" style={{ marginTop: 6, color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
                  {t("support.resolution.openFolderFailed")}
                </p>
              )}
            </>
          ) : (
            <p style={{ margin: 0, fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
              {t("support.resolution.noBridge")}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
