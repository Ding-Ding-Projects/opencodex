/**
 * Changelog viewer — every released version, filterable by date and text.
 *
 * The date filter accepts typed ISO text *and* the native picker, and reports an
 * invalid date inline without discarding what was typed. Text search composes
 * with the date filter rather than replacing it, and can opt into regex.
 */

import { useMemo, useState } from "react";
import { Button, Card, Chip, Empty, Field, TextInput } from "../shell/m3-ui";
import { useKeyedClientResource } from "../client-resource";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { readJsonIfOk } from "../fetch-json";

interface Release {
  version: string;
  date: string | null;
  entries: string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Presets are expressed as a "days back from today" offset. */
const PRESETS = [
  { days: 7, tkey: "changelog.last7" },
  { days: 30, tkey: "changelog.last30" },
  { days: 90, tkey: "changelog.last90" },
] as const;

export default function Changelog({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);

  const poll = useKeyedClientResource(
    `ocx-changelog:${apiBase}`,
    [],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/changelog`, { signal });
      const d = await readJsonIfOk<{ available?: boolean; releases?: Release[] }>(res);
      return { available: d?.available ?? false, releases: Array.isArray(d?.releases) ? d.releases : [] };
    },
  );

  const pollData = poll.data;
  const available = pollData?.available ?? true;

  const fromValid = from === "" || isValidDate(from);
  const toValid = to === "" || isValidDate(to);

  const { rows, regexError } = useMemo(() => {
    let matcher: (text: string) => boolean;
    if (!query) matcher = () => true;
    else if (useRegex) {
      try {
        const re = new RegExp(query, "i");
        matcher = text => re.test(text);
      } catch (e) {
        return { rows: [] as Release[], regexError: e instanceof Error ? e.message : String(e) };
      }
    } else {
      const needle = query.toLowerCase();
      matcher = text => text.toLowerCase().includes(needle);
    }

    // An invalid date is reported, not applied — the typed text stays in the field.
    const lo = fromValid ? from : "";
    const hi = toValid ? to : "";

    const filtered = (pollData?.releases ?? [])
      .filter(r => (!lo || (r.date ?? "") >= lo) && (!hi || (r.date ?? "") <= hi))
      .map(r => ({ ...r, entries: query ? r.entries.filter(matcher) : r.entries }))
      .filter(r => !query || r.entries.length > 0 || matcher(r.version));

    return { rows: filtered, regexError: null as string | null };
  }, [pollData, from, to, fromValid, toValid, query, useRegex]);

  const applyPreset = (days: number) => {
    const now = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    setFrom(start.toISOString().slice(0, 10));
    setTo(now.toISOString().slice(0, 10));
  };

  const exportMarkdown = async () => {
    const range = from || to
      ? t("changelog.exportRange", { from: from || "…", to: to || "…" })
      : t("changelog.exportAll");
    const md = [`# ${t("nav.changelog")}`, "", `_${range}_`, ""]
      .concat(rows.flatMap(r => [`## ${r.version}${r.date ? ` — ${r.date}` : ""}`, "", ...r.entries.map(e => `- ${e}`), ""]))
      .join("\n");
    try {
      await navigator.clipboard.writeText(md);
      notify({ tone: "success", title: t("changelog.exported"), body: range });
    } catch {
      notify({ tone: "error", title: t("regex.copyFailed") });
    }
  };

  return (
    <>
      <Card
        title={t("changelog.filterTitle")}
        subtitle={t("changelog.filterSub")}
        actions={<Button variant="outlined" onClick={() => void exportMarkdown()} disabled={!rows.length}>{t("changelog.export")}</Button>}
      >
        <div className="m3-grid">
          <Field id="cl-from" label={t("changelog.from")} hint={fromValid ? undefined : <span style={{ color: "var(--m3-error)" }}>{t("changelog.badDate")}</span>}>
            <TextInput id="cl-from" type="date" value={from} aria-invalid={!fromValid} onChange={e => setFrom(e.target.value)} />
          </Field>
          <Field id="cl-to" label={t("changelog.to")} hint={toValid ? undefined : <span style={{ color: "var(--m3-error)" }}>{t("changelog.badDate")}</span>}>
            <TextInput id="cl-to" type="date" value={to} aria-invalid={!toValid} onChange={e => setTo(e.target.value)} />
          </Field>
        </div>

        <div className="m3-row" style={{ gap: 8 }}>
          {PRESETS.map(p => (
            <Chip key={p.days} onClick={() => applyPreset(p.days)}>{t(p.tkey)}</Chip>
          ))}
          <Chip onClick={() => { setFrom(""); setTo(""); }}>{t("changelog.clearDates")}</Chip>
        </div>

        <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
          <TextInput
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("changelog.search")}
            aria-label={t("changelog.search")}
            aria-invalid={!!regexError}
            style={{ flex: "1 1 240px", width: "auto" }}
          />
          <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
            <code style={{ fontFamily: "var(--mono)" }}>.*</code>
          </Chip>
        </div>
        {regexError && <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t("regex.invalid")}: {regexError}</p>}
      </Card>

      {!available ? (
        <Empty title={t("changelog.unavailable")}>{t("changelog.unavailableBody")}</Empty>
      ) : rows.length === 0 ? (
        <Empty title={t("changelog.noResults")}>{t("changelog.noResultsBody")}</Empty>
      ) : (
        rows.map(release => (
          <Card key={release.version} title={release.version} subtitle={release.date ?? undefined}>
            <ul style={{ margin: 0, paddingLeft: "1.2em", display: "flex", flexDirection: "column", gap: 4 }}>
              {release.entries.map((entry, i) => <li key={i} style={{ fontSize: "var(--t-body-m)" }}>{entry}</li>)}
            </ul>
          </Card>
        ))
      )}
    </>
  );
}
