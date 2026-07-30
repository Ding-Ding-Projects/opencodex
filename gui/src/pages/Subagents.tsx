import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";
import { Button, Card, Empty, TextInput } from "../shell/m3-ui";
import { IconArrowUp, IconArrowDown, IconX, IconCheck, IconSearch, IconBot, IconInfo } from "../icons";
import { useT } from "../i18n/shared";
import { Trans } from "../i18n/provider";
import { modelLabel } from "../model-display";

/** Bordered list surface shared by the featured slots and the candidate list (M3 table anatomy). */
const LIST_SURFACE: React.CSSProperties = {
  borderRadius: "var(--r-l)",
  border: "1px solid var(--m3-outline-variant)",
  background: "var(--m3-surface-container-lowest)",
  overflow: "hidden",
};

const ROW: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
  minHeight: "var(--h-row, 56px)",
  padding: "8px 16px",
  borderTop: "1px solid var(--m3-outline-variant)",
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

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [available, setAvailable] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
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
      setOk(false);
      setStatus(t("sub.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const toggle = (m: string) => {
    if (busy) return;
    setStatus("");
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
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: chosen }),
      });
      const d = await readJsonOrThrow<{ applied?: string[] }>(r, t("sub.saveFailed"));
      if (d?.applied) setChosen(d.applied);
      setOk(true);
      setStatus(t("sub.saved", { n: d?.applied?.length ?? 0, cmd: "ocx sync" }));
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("sub.networkError"));
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

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

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
          <div style={LIST_SURFACE}>
            {chosen.map((m, i) => (
              <div key={m} style={{ ...ROW, borderTop: i === 0 ? "none" : ROW.borderTop }}>
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
                <code style={{ flex: "1 1 200px", minWidth: 0, fontFamily: "var(--mono)", fontSize: "var(--t-label-l)", color: "var(--m3-on-surface)", overflowWrap: "anywhere" }}>
                  {modelLabel(m)}
                </code>
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
        <div style={{ ...LIST_SURFACE, maxHeight: 360, overflowY: "auto" }}>
          {filtered.map((m, i) => {
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
                  ...ROW,
                  borderTop: i === 0 ? "none" : ROW.borderTop,
                  borderRight: "none",
                  borderBottom: "none",
                  borderLeft: "none",
                  width: "100%",
                  textAlign: "left",
                  font: "inherit",
                  background: sel ? "var(--m3-secondary-container)" : "transparent",
                  color: sel ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface)",
                  opacity: blocked ? 0.45 : 1,
                  cursor: blocked ? "not-allowed" : "pointer",
                }}
              >
                <span aria-hidden="true" style={{ width: 20, height: 20, flexShrink: 0, color: "var(--m3-primary)", display: "inline-flex" }}>
                  {sel && <IconCheck style={{ width: 20, height: 20 }} />}
                </span>
                <IconBot aria-hidden="true" style={{ width: 16, height: 16, color: "var(--m3-on-surface-variant)", flexShrink: 0 }} />
                <code style={{ flex: "1 1 auto", minWidth: 0, fontFamily: "var(--mono)", fontSize: "var(--t-label-l)", overflowWrap: "anywhere" }}>
                  {modelLabel(m)}
                </code>
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
