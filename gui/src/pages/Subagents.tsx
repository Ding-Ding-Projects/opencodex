import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Button, Card, Empty, TextInput } from "../shell/m3-ui";
import { IconArrowUp, IconArrowDown, IconX, IconCheck, IconPlus, IconSearch, IconInfo } from "../icons";
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

/** 44px round icon button — meets the minimum hit target without a bespoke class. */
const ICON_BTN: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 44,
  height: 44,
  border: "none",
  borderRadius: "var(--r-pill)",
  background: "transparent",
  color: "var(--m3-on-surface-variant)",
  cursor: "pointer",
};

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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Sync guard: state-only `busy` can miss clicks before the disabled re-render commits. */
  const saveInFlight = useRef(false);

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/subagent-models`);
      const r = await readJsonOrThrow<{ available?: string[]; chosen?: string[] }>(res, t("sub.loadFail"));
      if (!r) throw new Error(t("sub.loadFail"));
      const avail: string[] = r.available ?? [];
      const availSet = new Set(avail);
      setAvailable(avail);
      setChosen((r.chosen ?? []).filter((m: string) => availSet.has(m)));
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
    const before = chosen;
    try {
      const r = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: chosen }),
      });
      const d = await readJsonOrThrow<{ applied?: string[] }>(r, t("sub.saveFailed"));
      if (d?.applied) setChosen(d.applied);
      const saved = t("sub.saved", { n: d?.applied?.length ?? 0, cmd: "ocx sync" });
      // The featured five are a user-visible record, so an accidental save stays recoverable.
      recordRevision({ scope: "settings", label: t("nav.subagents"), summary: saved, before: JSON.stringify(before) });
      notify({ tone: "success", title: saved });
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter(m => !q || m.toLowerCase().includes(q));
  }, [available, query]);

  if (loading) return <div className="m3-empty">{t("sub.loading")}</div>;

  return (
    <>
      <p style={{ margin: "0 0 var(--sp-4)", maxWidth: "74ch", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-l)" }}>
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
          <Empty title={t("sub.noneSelected")} />
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
                <span style={PROVIDER_LABEL}>{providerPrefix(m) ?? t("models.nativeGroupLabel")}</span>
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
        <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-3)", flexWrap: "nowrap" }}>
          <IconSearch width={16} height={16} aria-hidden="true" style={{ color: "var(--m3-on-surface-variant)", flexShrink: 0 }} />
          <TextInput
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("sub.search")}
            aria-label={t("sub.search")}
            style={{ flex: 1 }}
          />
        </div>
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
                <span style={PROVIDER_LABEL}>{providerPrefix(m) ?? t("models.nativeGroupLabel")}</span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <Empty title={t("sub.noModels")} />
          )}
        </div>
      </Card>
    </>
  );
}
