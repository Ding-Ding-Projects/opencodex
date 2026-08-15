/**
 * Notification history — everything the snackbars showed, kept and searchable.
 *
 * Laid out as the prototype's bare lead paragraph + action row + tonal list
 * rather than inside a card: the app bar already names the page, so a second
 * heading on the same surface would only repeat it.
 */

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { BADGE_TONE_STYLE, Button, Chip, Empty, TextInput } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { IconAlert, IconBell, IconCheck, IconInfo, IconSearch } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications, type NoticeTone } from "../shell/notifications-context";
import type { TKey } from "../i18n/shared";

/**
 * How many history rows the anchored builder is handed as sample text. Bounded
 * because the string is rebuilt on every render of the search row, and the
 * history grows for as long as the app is open.
 */
const SAMPLE_ROWS = 40;

const TONES: { tone: NoticeTone | "all"; tkey: TKey }[] = [
  { tone: "all", tkey: "notif.toneAll" },
  { tone: "error", tkey: "notif.toneError" },
  { tone: "warn", tkey: "notif.toneWarn" },
  { tone: "success", tkey: "notif.toneSuccess" },
  { tone: "info", tkey: "notif.toneInfo" },
];

/**
 * Leading tonal chip per tone. Status colours are functional data colours, so
 * they keep their own roles instead of collapsing onto the primary palette —
 * sourced from the shared `BADGE_TONE_STYLE` map, not declared here: this
 * used to pair "info" with `surface-container-high` (not `-highest`), a third
 * spelling of the "neutral" pair that not even matched the app's other two.
 *
 * `nameKey` is the singular tone name shown beside each row's timestamp. The
 * chip alone encoded the tone in colour and glyph only, which reads as nothing
 * at all to a screen reader and as very little to anyone who cannot separate
 * the error and warning containers — so the tone is now also plain text.
 */
const TONE_CHIP: Record<NoticeTone, { style: CSSProperties; nameKey: TKey; Icon: typeof IconInfo }> = {
  error: { style: BADGE_TONE_STYLE.error, nameKey: "notif.toneErrorOne", Icon: IconAlert },
  warn: { style: BADGE_TONE_STYLE.warn, nameKey: "notif.toneWarnOne", Icon: IconAlert },
  success: { style: BADGE_TONE_STYLE.ok, nameKey: "notif.toneSuccessOne", Icon: IconCheck },
  info: { style: BADGE_TONE_STYLE.neutral, nameKey: "notif.toneInfoOne", Icon: IconInfo },
};

export default function NotificationsPage() {
  const t = useT();
  const { history, clearHistory } = useNotifications();
  const [tone, setTone] = useState<NoticeTone | "all">("all");
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  /**
   * The flags this field compiles with. State rather than the `"i"` this search
   * used to hard-code: the builder beside the field composes a pattern *and* its
   * flags, and a field that pinned `i` showed a panel where turning on `m` or `s`
   * changed the preview and then changed nothing about what the history list
   * found. A pattern built as case-sensitive arriving case-insensitive is the
   * same defect read the other way round.
   */
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);

  const { rows, error } = useMemo(() => {
    // The shared matcher rather than a `new RegExp(query, "i")` of its own, so
    // the flags the builder applied are the flags this list is filtered by, and
    // the panel's preview and these rows cannot report different matches for one
    // pattern. It also bounds the pattern — this search had no cap at all — and
    // drops `g`/`y`, which carry `lastIndex` between calls and would otherwise
    // make one matcher reused down the history match every other row.
    const matcher = settingsMatcher(query, useRegex, flags);
    if (matcher.error) return { rows: [], error: matcher.error };
    return {
      rows: history.filter(n => (tone === "all" || n.tone === tone) && matcher.test(`${n.title} ${n.body ?? ""}`)),
      error: null as string | null,
    };
  }, [history, tone, query, useRegex, flags]);

  return (
    <>
      {/* The prototype leads this screen with body-large copy at a 74ch measure. */}
      <p className="m3-page-lead" style={{ whiteSpace: "pre-line" }}>
        {t("notif.historySub")}
      </p>

      <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-3)" }}>
        <Button variant="outlined" onClick={clearHistory} disabled={!history.length} style={{ color: "var(--m3-error)" }}>
          {t("notif.clear")}
        </Button>
      </div>

      <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-3)" }}>
        {TONES.map(item => (
          <Chip key={item.tone} selected={tone === item.tone} onClick={() => setTone(item.tone)}>
            {t(item.tkey)}
          </Chip>
        ))}
      </div>

      {/*
        `aria-describedby` is bound only while the pattern error is on screen: a
        dangling reference resolves to nothing and quietly costs the field its
        accessible description.
      */}
      <div className="m3-row" role="search" style={{ marginBottom: "var(--sp-3)" }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("notif.search")}
          aria-label={t("notif.search")}
          aria-invalid={!!error}
          aria-describedby={
            [error ? "notif-regex-error" : null, useRegex ? "notif-regex-flags-state" : null]
              .filter(Boolean).join(" ") || undefined
          }
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        {/* Every search bar reaches the full builder from an affordance beside it. */}
        <RegexBuilderButton
          value={query}
          // Both halves of what the builder composed, not just the pattern.
          // Taking the pattern and leaving the flags behind is what made the
          // popover's own flag chips decorative from this field's point of view.
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          regex={useRegex}
          onRegexChange={setUseRegex}
          flags={flags}
          // The whole history, not the tone-filtered rows: the sample exists to
          // test a pattern, and hiding half the notifications behind the active
          // chip would make it test the wrong corpus.
          sample={history.slice(0, SAMPLE_ROWS).map(n => `${n.title} ${n.body ?? ""}`.trim()).join("\n")}
        />
      </div>

      <SearchFlagsRow
        regex={useRegex}
        flags={flags}
        onFlagsChange={setFlags}
        id="notif-regex-flags-state"
      />

      {error && (
        <p id="notif-regex-error" role="alert" style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
          {t("regex.invalid")}: {error}
        </p>
      )}

      {/*
        Three distinct nothings, and they must not borrow each other's copy.
        An unreadable pattern already speaks through the alert above, so no empty
        block follows it; an empty history invites the user to expect messages
        later; a filter that matched nothing says so, because "Nothing yet" over a
        history the user can see is not just wrong, it reads as a broken screen.
      */}
      {error ? null : rows.length === 0 && history.length > 0 ? (
        <div role="status">
          <Empty title={t("notif.noMatch")} icon={IconSearch} />
        </div>
      ) : rows.length === 0 ? (
        <Empty title={t("notif.empty")} icon={IconBell}>{t("notif.emptyBody")}</Empty>
      ) : (
        <ul style={{ display: "grid", gap: 8, margin: 0, padding: 0, listStyle: "none" }}>
          {rows.map(n => {
            const chip = TONE_CHIP[n.tone];
            return (
              <li key={n.id} style={{
                display: "flex", gap: "var(--sp-2)", padding: "14px 16px",
                borderRadius: "var(--r-l)", border: "1px solid var(--m3-outline-variant)",
                background: "var(--m3-surface-container-lowest)",
              }}>
                <span style={{
                  flex: "0 0 auto", display: "grid", placeItems: "center", width: 40, height: 40,
                  borderRadius: "var(--r-pill)", ...chip.style,
                }} aria-hidden="true">
                  <chip.Icon width={22} height={22} />
                </span>
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div style={{ fontSize: "var(--t-body-m)", fontWeight: 500, whiteSpace: "pre-line" }}>{n.title}</div>
                  {n.body && (
                    <div style={{
                      marginTop: 2, whiteSpace: "pre-line",
                      color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)",
                    }}>
                      {n.body}
                    </div>
                  )}
                  <div style={{
                    marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
                    color: "var(--m3-on-surface-variant)", fontFamily: "var(--mono)", fontSize: "var(--t-label-s)",
                  }}>
                    <time dateTime={new Date(n.at).toISOString()}>{new Date(n.at).toLocaleString()}</time>
                    <span aria-hidden="true">·</span>
                    <span>{t(chip.nameKey)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
