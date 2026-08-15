import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Button, Card, Chip, Empty, TextInput } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { IconArrowUp, IconArrowDown, IconBot, IconBoxes, IconX, IconCheck, IconPlus, IconSearch, IconInfo } from "../icons";
import { useT } from "../i18n/shared";
import { Trans } from "../i18n/provider";
import { modelLabel } from "../model-display";
import { useNotifications } from "../shell/notifications-context";
import { recordRevision } from "../shell/revisions";

/**
 * The featured slots are table anatomy, so they honour the per-element
 * appearance editor's `table` target the same way `.m3-table` does — without
 * these vars the editor silently does nothing on this screen.
 */
const TABLE_SURFACE: React.CSSProperties = {
  borderRadius: "var(--el-table-radius, var(--r-l))",
  border: "1px solid var(--m3-outline-variant)",
  background: "var(--el-table-bg, var(--m3-surface-container-lowest))",
  fontFamily: "var(--el-table-font, inherit)",
  color: "var(--el-table-color, var(--m3-on-surface))",
  overflow: "hidden",
};

const TABLE_ROW: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
  minHeight: "var(--h-row, 56px)",
  padding: "var(--el-table-pad, 10px 16px)",
  borderTop: "1px solid var(--m3-outline-variant)",
};

/** Candidates are tappable list items, not table rows: pill-ish radius, no dividers. */
const CANDIDATE_ROW: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
  width: "100%",
  minHeight: "var(--h-row, 56px)",
  padding: "0 14px",
  border: "none",
  borderRadius: "var(--r-m)",
  font: "inherit",
  fontSize: "var(--t-body-m)",
  textAlign: "left",
};

/**
 * 48px round icon button — Material's minimum hit target, without a bespoke class.
 *
 * Said 44 and claimed to meet the minimum. 44 is Apple's HIG figure; Material's
 * is 48, and these measured 44x44 on a 320px touch viewport. Inline, so no
 * stylesheet floor could reach them.
 */
const ICON_BTN: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 48,
  height: 48,
  border: "none",
  borderRadius: "var(--r-pill)",
  background: "transparent",
  color: "var(--m3-on-surface-variant)",
  cursor: "pointer",
};

/**
 * How many model ids the anchored builder is handed as sample text. Bounded
 * because the string is rebuilt on every render of the search row, and the
 * catalogue this screen lists runs to hundreds of entries.
 */
const SAMPLE_ROWS = 40;

const PROVIDER_LABEL: React.CSSProperties = {
  flex: "0 0 auto",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-m)",
};

const SLUG: React.CSSProperties = {
  flex: "1 1 200px",
  minWidth: 0,
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-l)",
  overflowWrap: "anywhere",
};

/** Routed catalog slugs are `provider/id`; a bare slug is an OpenAI passthrough model. */
function providerPrefix(slug: string): string | null {
  const slash = slug.indexOf("/");
  return slash > 0 ? slug.slice(0, slash) : null;
}

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  const [available, setAvailable] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  /** Plain text is the default on every search bar; `.*` is the explicit opt-in. */
  const [useRegex, setUseRegex] = useState(false);
  /**
   * The flags this field compiles with. State rather than the `"i"` this search
   * used to hard-code: the builder beside the field composes a pattern *and* its
   * flags, and a field that pinned `i` let the panel's preview move under `m` or
   * `s` while the model list behind it stayed put.
   */
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Sync guard: state-only `busy` can miss clicks before the disabled re-render commits. */
  const saveInFlight = useRef(false);
  /**
   * Last state the server actually holds. A revision's `before` must be this, not the
   * edits being saved — snapshotting the new picks makes "restore" replay the save it
   * was meant to undo, which is the one failure that makes a history panel unsafe.
   */
  const persisted = useRef<string[]>([]);

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/subagent-models`);
      const r = await readJsonOrThrow<{ available?: string[]; chosen?: string[] }>(res, t("sub.loadFail"));
      if (!r) throw new Error(t("sub.loadFail"));
      const avail: string[] = r.available ?? [];
      const availSet = new Set(avail);
      setAvailable(avail);
      const stored = (r.chosen ?? []).filter((m: string) => availSet.has(m));
      persisted.current = stored;
      setChosen(stored);
    } catch {
      notify({ tone: "error", title: t("sub.loadFail") });
    } finally {
      setLoading(false);
    }
  }, [apiBase, notify, t]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const toggle = (m: string) => {
    if (busy) return;
    setChosen(prev => prev.includes(m) ? prev.filter(x => x !== m) : (prev.length >= 5 ? prev : [...prev, m]));
  };
  const move = (i: number, dir: -1 | 1) => {
    if (busy) return;
    setChosen(prev => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = async () => {
    if (busy || saveInFlight.current) return;
    saveInFlight.current = true;
    setBusy(true);
    const before = persisted.current;
    try {
      const r = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: chosen }),
      });
      const d = await readJsonOrThrow<{ applied?: string[] }>(r, t("sub.saveFailed"));
      const applied = d?.applied ?? chosen;
      persisted.current = applied;
      if (d?.applied) setChosen(d.applied);
      // The revision panel needs a named event ("set to gpt-5, …"), not "Updated" — and a
      // save that clears every slot is still an event, so it keeps the counted wording.
      const summary = applied.length
        ? t("sub.revisionSaved", { models: applied.join(", ") })
        : t("sub.savedTitle", { n: 0 });
      // The featured five are a user-visible record, so an accidental save stays recoverable.
      recordRevision({ scope: "settings", label: t("nav.subagents"), summary, before: JSON.stringify(before) });
      notify({
        tone: "success",
        title: t("sub.savedTitle", { n: applied.length }),
        body: t("sub.savedBody", { cmd: "ocx sync" }),
      });
    } catch (error) {
      notify({
        tone: "error",
        title: t("sub.saveFailed"),
        body: error instanceof Error && error.message ? error.message : t("sub.networkError"),
      });
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
  };

  const { matchesQuery, regexError } = useMemo(() => {
    // The shared matcher rather than a `new RegExp(query, "i")` of its own: it
    // compiles the flags the builder beside this field actually applied, so the
    // panel's preview and this list cannot report different matches for one
    // pattern. It keeps the same 400-character bound — the regex-builder safety
    // cap applies wherever a pattern is evaluated — and drops `g`/`y`, whose
    // `lastIndex` would otherwise make one matcher reused down the model list
    // keep every other row.
    const matcher = settingsMatcher(query, useRegex, flags);
    return { matchesQuery: matcher.test, regexError: matcher.error };
  }, [query, useRegex, flags]);

  const filtered = useMemo(
    () => available.filter(m => matchesQuery(`${m} ${modelLabel(m)} ${providerPrefix(m) ?? ""}`)),
    [available, matchesQuery],
  );

  if (loading) return <div className="m3-empty">{t("sub.loading")}</div>;

  return (
    <>
      <p className="m3-page-lead">
        <Trans k="sub.subtitle" cmd="spawn_agent" />
      </p>

      <Card
        title={t("sub.featured")}
        subtitle={<span>{chosen.length}/5</span>}
        actions={<Button variant="filled" onClick={() => void save()} disabled={busy}>{t("common.save")}</Button>}
      >
        <div
          className="m3-row"
          style={{ alignItems: "flex-start", gap: 8, marginBottom: "var(--sp-3)", maxWidth: "74ch", flexWrap: "nowrap", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}
        >
          <IconInfo width={16} height={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <span><Trans k="sub.orderHint" cmd="spawn_agent" /></span>
        </div>

        {chosen.length === 0 ? (
          <Empty title={t("sub.noneSelected")} icon={IconBot} />
        ) : (
          <div style={TABLE_SURFACE}>
            {chosen.map((m, i) => (
              <div key={m} style={{ ...TABLE_ROW, borderTop: i === 0 ? "none" : TABLE_ROW.borderTop }}>
                <span
                  aria-hidden="true"
                  style={{
                    flex: "0 0 auto",
                    display: "grid",
                    placeItems: "center",
                    width: 32,
                    height: 32,
                    borderRadius: "var(--r-pill)",
                    background: "var(--m3-primary)",
                    color: "var(--m3-on-primary)",
                    fontSize: "var(--t-label-m)",
                    fontWeight: 700,
                  }}
                >
                  {i + 1}
                </span>
                <code style={SLUG}>{modelLabel(m)}</code>
                <span style={PROVIDER_LABEL}>{providerPrefix(m) ?? t("sub.nativeProvider")}</span>
                <div style={{ display: "flex", gap: 2 }}>
                  <button type="button" style={ICON_BTN} onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label={t("sub.moveUp", { m })}>
                    <IconArrowUp aria-hidden="true" />
                  </button>
                  <button type="button" style={ICON_BTN} onClick={() => move(i, 1)} disabled={busy || i === chosen.length - 1} aria-label={t("sub.moveDown", { m })}>
                    <IconArrowDown aria-hidden="true" />
                  </button>
                  <button type="button" style={{ ...ICON_BTN, color: "var(--m3-error)" }} onClick={() => toggle(m)} disabled={busy} aria-label={t("sub.removeAria", { m })}>
                    <IconX aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={t("sub.models")} subtitle={<span>{filtered.length}</span>}>
        <div className="m3-row" role="search" style={{ gap: 8, marginBottom: "var(--sp-2)" }}>
          <IconSearch width={16} height={16} aria-hidden="true" style={{ color: "var(--m3-on-surface-variant)", flexShrink: 0 }} />
          <TextInput
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("sub.search")}
            aria-label={t("sub.search")}
            aria-invalid={!!regexError}
            aria-describedby={useRegex ? "sub-regex-flags-state" : undefined}
            style={{ flex: "1 1 200px", width: "auto", minWidth: 0 }}
          />
          {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
          <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
            <code style={{ fontFamily: "var(--mono)" }}>.*</code>
          </Chip>
          <RegexBuilderButton
            value={query}
            // Both halves of what the builder composed. Taking the pattern and
            // leaving the flags behind is what made the popover's flag chips
            // decorative from this field's point of view.
            onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
            regex={useRegex}
            onRegexChange={setUseRegex}
            flags={flags}
            // Every available model, not the ones the current query kept: the
            // sample exists to try a new pattern against, and pre-filtering it
            // would hide exactly the rows that pattern is being written to reach.
            sample={available
              .slice(0, SAMPLE_ROWS)
              .map(m => `${m} ${modelLabel(m)} ${providerPrefix(m) ?? ""}`.trim())
              .join("\n")}
          />
        </div>
        <SearchFlagsRow
          regex={useRegex}
          flags={flags}
          onFlagsChange={setFlags}
          id="sub-regex-flags-state"
        />
        {regexError && (
          <p role="alert" style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
            {t("regex.invalid")}: {regexError}
          </p>
        )}
        <div
          style={{
            borderRadius: "var(--r-l)",
            border: "1px solid var(--m3-outline-variant)",
            background: "var(--m3-surface-container-low)",
            padding: 10,
            // The real catalog runs to hundreds of models, so the list scrolls
            // inside the card rather than pushing the page.
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {filtered.map(m => {
            const sel = chosenSet.has(m);
            const full = !sel && chosen.length >= 5;
            const blocked = full || busy;
            return (
              <button
                key={m}
                type="button"
                onClick={() => toggle(m)}
                disabled={busy || full}
                aria-pressed={sel}
                style={{
                  ...CANDIDATE_ROW,
                  background: sel ? "var(--m3-secondary-container)" : "transparent",
                  color: sel ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface)",
                  opacity: blocked ? 0.5 : 1,
                  cursor: blocked ? "not-allowed" : "pointer",
                }}
              >
                <span aria-hidden="true" style={{ flex: "0 0 auto", display: "inline-flex", color: sel ? "currentColor" : "var(--m3-primary)" }}>
                  {sel ? <IconCheck style={{ width: 20, height: 20 }} /> : <IconPlus style={{ width: 20, height: 20 }} />}
                </span>
                <code style={SLUG}>{modelLabel(m)}</code>
                <span style={PROVIDER_LABEL}>{providerPrefix(m) ?? t("sub.nativeProvider")}</span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            /* An empty catalog and a query that matched nothing are different facts — saying
               "log into a provider" while 300 models sit behind the filter is simply wrong. */
            <Empty
              title={available.length === 0 ? t("sub.noModels") : t("models.noMatch")}
              icon={available.length === 0 ? IconBoxes : IconSearch}
            />
          )}
        </div>
      </Card>
    </>
  );
}
