/**
 * Changelog viewer — every released version, filterable by date and text.
 *
 * The date filter accepts typed ISO text *and* the native picker, and reports an
 * invalid date inline without discarding what was typed. Text search composes
 * with the date filter rather than replacing it, and can opt into regex.
 */

import { useMemo, useState } from "react";
import { Button, Card, Chip, Empty, Field, TextInput } from "../shell/m3-ui";
import { IconRegex, IconSearch } from "../icons";
import { useKeyedClientResource } from "../client-resource";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { readJsonIfOk } from "../fetch-json";
import type { CSSProperties } from "react";

interface Release {
  version: string;
  date: string | null;
  entries: string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Stands in for an open end of the range, so a half-open filter still reads as one. */
const OPEN_END = "…";

const MONO = { fontFamily: "var(--mono)" } as const;

function isValidDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Presets are expressed as a "days back from today" offset. "This year" and
 * "all time" are not offsets — they are calendar-bounded and unbounded — so they
 * are rendered beside these rather than folded into the same shape.
 */
const PRESETS = [
  { days: 7, tkey: "changelog.last7" },
  { days: 30, tkey: "changelog.last30" },
  { days: 90, tkey: "changelog.last90" },
] as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);

type Tone = "ok" | "warn" | "error" | "neutral";

/** Status palette — a functional data colour, not chrome, so it stays a role pair. */
const TONE_COLOURS: Record<Tone, { background: string; color: string }> = {
  ok: { background: "var(--m3-ok-container)", color: "var(--m3-on-ok-container)" },
  warn: { background: "var(--m3-warn-container)", color: "var(--m3-on-warn-container)" },
  error: { background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" },
  neutral: { background: "var(--m3-surface-container-highest)", color: "var(--m3-on-surface-variant)" },
};

const BADGE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 24,
  padding: "0 10px",
  borderRadius: "var(--r-pill)",
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-s)",
  fontWeight: 600,
  letterSpacing: "0.2px",
  whiteSpace: "nowrap",
};

/** `fix(gui)!: subject` — the shape `scripts/generate-changelog.ts` writes into CHANGELOG.md. */
const CONVENTIONAL = /^(?<type>[a-z]+)(?<scope>\([^)]*\))?(?<breaking>!)?:\s*(?<rest>.+)$/;

/**
 * The packaged changelog carries commit subjects, not the prototype's hand-written
 * `Added` / `Fixed` / `Security` categories, so the category badge is read off the
 * conventional-commit type instead of being invented. An entry that carries no
 * type prefix keeps its full text and simply gets no badge.
 */
function categorize(entry: string): { badge: string | null; text: string; tone: Tone } {
  const m = CONVENTIONAL.exec(entry);
  if (!m?.groups) return { badge: null, text: entry, tone: "neutral" };
  const { type, scope, breaking, rest } = m.groups;
  const tone: Tone = breaking || type === "security" ? "error"
    : type === "fix" || type === "revert" ? "warn"
    : type === "feat" ? "ok"
    : "neutral";
  return { badge: `${type}${scope ?? ""}${breaking ?? ""}`, text: rest ?? entry, tone };
}

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
  const releases = useMemo(() => pollData?.releases ?? [], [pollData]);

  const fromValid = from === "" || isValidDate(from);
  const toValid = to === "" || isValidDate(to);

  // An invalid date is reported, not applied — the typed text stays in the field.
  const lo = fromValid ? from : "";
  const hi = toValid ? to : "";

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

    const filtered = releases
      .filter(r => (!lo || (r.date ?? "") >= lo) && (!hi || (r.date ?? "") <= hi))
      // A hit on the version or date keeps the whole release; otherwise the entries
      // themselves are narrowed, because a real release carries a hundred of them.
      .map(r => (!query || matcher(`${r.version} ${r.date ?? ""}`)
        ? r
        : { ...r, entries: r.entries.filter(matcher) }))
      .filter(r => !query || r.entries.length > 0);

    return { rows: filtered, regexError: null as string | null };
  }, [releases, lo, hi, query, useRegex]);

  /** What an export would cover: an open end falls back to the data's own bounds. */
  const rangeLabel = useMemo(() => {
    if (!lo && !hi) return t("changelog.exportAll");
    const dates = releases.map(r => r.date).filter((d): d is string => !!d).sort();
    return t("changelog.exportRange", {
      from: lo || dates[0] || OPEN_END,
      to: hi || dates[dates.length - 1] || OPEN_END,
    });
  }, [lo, hi, releases, t]);

  const applyPreset = (days: number) => {
    const now = new Date();
    setFrom(iso(new Date(now.getTime() - days * 86_400_000)));
    setTo(iso(now));
  };

  /** The calendar year, not a 365-day window — "this year" means January onwards. */
  const applyThisYear = () => {
    const year = new Date().getUTCFullYear();
    setFrom(`${year}-01-01`);
    setTo(`${year}-12-31`);
  };

  /**
   * Both the clipboard copy and the file export render this, so what the user
   * pastes and what they download cannot drift. The range is stated in the
   * document itself, which is the point of the export contract: a file that says
   * only "changelog" leaves the reader guessing which slice of it they have.
   */
  const buildMarkdown = () =>
    [`# ${t("nav.changelog")}`, "", `_${rangeLabel}_`, ""]
      .concat(rows.flatMap(r => [`## ${r.version}${r.date ? ` — ${r.date}` : ""}`, "", ...r.entries.map(e => `- ${e}`), ""]))
      .join("\n");

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      notify({ tone: "success", title: t("changelog.exported"), body: rangeLabel });
    } catch {
      notify({ tone: "error", title: t("regex.copyFailed") });
    }
  };

  const exportMarkdown = () => {
    const url = URL.createObjectURL(new Blob([buildMarkdown()], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "changelog.md";
    link.click();
    URL.revokeObjectURL(url);
    notify({ tone: "success", title: t("changelog.export"), body: rangeLabel });
  };

  return (
    <>
      <p className="m3-page-lead">{t("changelog.subtitle")}</p>

      <Card title={t("changelog.filterTitle")} subtitle={t("changelog.filterSub")}>
        <div className="m3-row" style={{ gap: "var(--sp-2)", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 180px", minWidth: 0 }}>
            {/* Reserved hint height: the error appearing must not shove the presets down. */}
            <Field
              id="cl-from"
              label={t("changelog.from")}
              hint={<span style={{ display: "block", minHeight: 18, color: "var(--m3-error)" }}>
                {fromValid ? "" : t("changelog.badDate")}
              </span>}
            >
              <TextInput id="cl-from" type="date" value={from} aria-invalid={!fromValid} style={MONO} onChange={e => setFrom(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: "1 1 180px", minWidth: 0 }}>
            <Field
              id="cl-to"
              label={t("changelog.to")}
              hint={<span style={{ display: "block", minHeight: 18, color: "var(--m3-error)" }}>
                {toValid ? "" : t("changelog.badDate")}
              </span>}
            >
              <TextInput id="cl-to" type="date" value={to} aria-invalid={!toValid} style={MONO} onChange={e => setTo(e.target.value)} />
            </Field>
          </div>
          {/* The preset group carries its own label, so the chips are not three
              unexplained pills sitting beside two labelled date fields. */}
          <div style={{ flex: "2 1 260px", minWidth: 0 }}>
            <span className="m3-field-label" id="cl-presets-label">{t("changelog.presets")}</span>
            <div className="m3-row" role="group" aria-labelledby="cl-presets-label" style={{ gap: 6 }}>
              {PRESETS.map(p => (
                <Chip key={p.days} onClick={() => applyPreset(p.days)}>{t(p.tkey)}</Chip>
              ))}
              <Chip onClick={applyThisYear}>{t("changelog.thisYear")}</Chip>
              <Chip onClick={() => { setFrom(""); setTo(""); }}>{t("changelog.clearDates")}</Chip>
            </div>
          </div>
        </div>

        <div className="m3-row" role="search">
          <IconSearch width={20} height={20} aria-hidden="true" />
          <TextInput
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("changelog.search")}
            aria-label={t("changelog.search")}
            aria-invalid={!!regexError}
            aria-describedby="cl-regex-error"
            style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
          />
          {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
          <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")} aria-label={t("regex.regexMode")}>
            <code style={MONO}>.*</code>
          </Chip>
          <a className="m3-icon-btn" href="#regex" title={t("search.openBuilder")} aria-label={t("search.openBuilder")}>
            <IconRegex width={20} height={20} aria-hidden="true" />
          </a>
        </div>
        {/* Reserved height for the same reason as the date hints above. */}
        <p id="cl-regex-error" role="alert" style={{ minHeight: 20, margin: "4px 0 0", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>
          {regexError ? `${t("regex.invalid")}: ${regexError}` : ""}
        </p>

        <div className="m3-row" style={{ gap: 8, marginTop: "var(--sp-2)" }}>
          <span style={{ ...MONO, flex: "1 1 auto", minWidth: 0, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
            {rangeLabel}
          </span>
          {/* Copy puts the filtered view on the clipboard; export writes the same
              Markdown to a file. Both state the range they cover. */}
          <Button variant="outlined" onClick={() => void copyMarkdown()} disabled={!rows.length}>{t("changelog.copy")}</Button>
          <Button variant="filled" onClick={exportMarkdown} disabled={!rows.length}>{t("changelog.export")}</Button>
        </div>
      </Card>

      {!available ? (
        <Empty title={t("changelog.unavailable")}>{t("changelog.unavailableBody")}</Empty>
      ) : rows.length === 0 ? (
        <Empty title={t("changelog.noResults")}>{t("changelog.noResultsBody")}</Empty>
      ) : (
        rows.map(release => (
          <Card
            key={release.version}
            title={
              <span className="m3-row" style={{ gap: 10, alignItems: "baseline" }}>
                <span style={MONO}>{release.version}</span>
                {release.date && (
                  <span style={{ ...MONO, fontSize: "var(--t-label-m)", fontWeight: 400, color: "var(--m3-on-surface-variant)" }}>
                    {release.date}
                  </span>
                )}
              </span>
            }
          >
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {release.entries.map((entry, i) => {
                const { badge, text, tone } = categorize(entry);
                return (
                  <li key={i} className="m3-row" style={{ gap: 10, alignItems: "baseline", padding: "6px 0" }}>
                    {badge && <span style={{ ...BADGE, ...TONE_COLOURS[tone] }}>{badge}</span>}
                    <span style={{ flex: "1 1 260px", minWidth: 0, fontSize: "var(--t-body-s)" }}>{text}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}
    </>
  );
}
