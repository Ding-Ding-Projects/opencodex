/** Notification history — everything the snackbars showed, kept and searchable. */

import { useMemo, useState } from "react";
import { Button, Card, Chip, Empty, TextInput } from "../shell/m3-ui";
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
    <Card
      title={t("notif.historyTitle")}
      subtitle={t("notif.historySub")}
      actions={<Button variant="text" onClick={clearHistory} disabled={!history.length}>{t("notif.clear")}</Button>}
    >
      <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-3)" }}>
        {TONES.map(item => (
          <Chip key={item.tone} selected={tone === item.tone} onClick={() => setTone(item.tone)}>
            {t(item.tkey)}
          </Chip>
        ))}
      </div>

      <div className="m3-row" style={{ marginBottom: "var(--sp-3)" }}>
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("notif.search")}
          aria-label={t("notif.search")}
          aria-invalid={!!error}
          style={{ flex: "1 1 240px", width: "auto" }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
      </div>

      {error && <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t("regex.invalid")}: {error}</p>}

      {rows.length === 0 ? (
        <Empty title={t("notif.empty")}>{t("notif.emptyBody")}</Empty>
      ) : (
        <div className="m3-stack">
          {rows.map(n => (
            <div key={n.id} style={{
              display: "flex", gap: "var(--sp-3)", padding: "var(--sp-2) 0",
              borderBottom: "1px solid var(--m3-outline-variant)",
            }}>
              <span style={{
                flex: "0 0 auto", alignSelf: "flex-start", marginTop: 4, width: 8, height: 8, borderRadius: "var(--r-pill)",
                background: n.tone === "error" ? "var(--m3-error)"
                  : n.tone === "warn" ? "var(--m3-warn)"
                  : n.tone === "success" ? "var(--m3-ok)" : "var(--m3-outline)",
              }} aria-hidden="true" />
              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                <div style={{ fontWeight: 500 }}>{n.title}</div>
                {n.body && <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>{n.body}</div>}
              </div>
              <time
                dateTime={new Date(n.at).toISOString()}
                style={{ flex: "0 0 auto", fontFamily: "var(--mono)", fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)" }}
              >
                {new Date(n.at).toLocaleString()}
              </time>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
