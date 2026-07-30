/**
 * Notification history — everything the snackbars showed, kept and searchable.
 *
 * Laid out as the prototype's bare lead paragraph + action row + tonal list
 * rather than inside a card: the app bar already names the page, so a second
 * heading on the same surface would only repeat it.
 */

import { useMemo, useState } from "react";
import { Button, Chip, Empty, TextInput } from "../shell/m3-ui";
import { IconAlert, IconCheck, IconInfo, IconRegex, IconSearch } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications, type NoticeTone } from "../shell/notifications-context";
import type { TKey } from "../i18n/shared";

const TONES: { tone: NoticeTone | "all"; tkey: TKey }[] = [
  { tone: "all", tkey: "notif.toneAll" },
  { tone: "error", tkey: "notif.toneError" },
  { tone: "warn", tkey: "notif.toneWarn" },
  { tone: "success", tkey: "notif.toneSuccess" },
  { tone: "info", tkey: "notif.toneInfo" },
];

/**
 * Leading tonal chip per tone. Status colours are functional data colours, so
 * they keep their own roles instead of collapsing onto the primary palette.
 *
 * `nameKey` is the singular tone name shown beside each row's timestamp. The
 * chip alone encoded the tone in colour and glyph only, which reads as nothing
 * at all to a screen reader and as very little to anyone who cannot separate
 * the error and warning containers — so the tone is now also plain text.
 */
const TONE_CHIP: Record<NoticeTone, { bg: string; fg: string; nameKey: TKey; Icon: typeof IconInfo }> = {
  error: {
    bg: "var(--m3-error-container)", fg: "var(--m3-on-error-container)",
    nameKey: "notif.toneErrorOne", Icon: IconAlert,
  },
  warn: {
    bg: "var(--m3-warn-container)", fg: "var(--m3-on-warn-container)",
    nameKey: "notif.toneWarnOne", Icon: IconAlert,
  },
  success: {
    bg: "var(--m3-ok-container)", fg: "var(--m3-on-ok-container)",
    nameKey: "notif.toneSuccessOne", Icon: IconCheck,
  },
  info: {
    bg: "var(--m3-surface-container-high)", fg: "var(--m3-on-surface-variant)",
    nameKey: "notif.toneInfoOne", Icon: IconInfo,
  },
};

export default function NotificationsPage() {
  const t = useT();
  const { history, clearHistory } = useNotifications();
  const [tone, setTone] = useState<NoticeTone | "all">("all");
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);

  const { rows, error } = useMemo(() => {
    let matcher: (text: string) => boolean;
    if (!query) matcher = () => true;
    else if (useRegex) {
      try {
        const re = new RegExp(query, "i");
        matcher = text => re.test(text);
      } catch (e) {
        return { rows: [], error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      const needle = query.toLowerCase();
      matcher = text => text.toLowerCase().includes(needle);
    }
    return {
      rows: history.filter(n => (tone === "all" || n.tone === tone) && matcher(`${n.title} ${n.body ?? ""}`)),
      error: null as string | null,
    };
  }, [history, tone, query, useRegex]);

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

      <div className="m3-row" role="search" style={{ marginBottom: "var(--sp-3)" }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("notif.search")}
          aria-label={t("notif.search")}
          aria-invalid={!!error}
          aria-describedby="notif-regex-error"
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        {/* Every search bar reaches the full builder from an affordance beside it. */}
        <a className="m3-icon-btn" href="#regex" title={t("search.openBuilder")} aria-label={t("search.openBuilder")}>
          <IconRegex width={20} height={20} aria-hidden="true" />
        </a>
      </div>

      {error && (
        <p id="notif-regex-error" role="alert" style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
          {t("regex.invalid")}: {error}
        </p>
      )}

      {rows.length === 0 ? (
        <Empty title={t("notif.empty")}>{t("notif.emptyBody")}</Empty>
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
                  borderRadius: "var(--r-pill)", background: chip.bg, color: chip.fg,
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
