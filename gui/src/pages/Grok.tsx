import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice } from "../ui";
import { Button, Card, Empty, Toggle } from "../shell/m3-ui";
import { IconChevron } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { makeCollapseStore, toggleInSet } from "./collapse-store";
import { grokGroupView, type GrokCandidate } from "./grok-groups";

type TFn = (key: TKey, vars?: Record<string, string | number>) => string;

interface GrokStatusModel {
  alias: string;
  id: string;
  contextWindow?: number;
}

interface GrokStatus {
  configPath: string;
  present: boolean;
  baseUrl: string | null;
  models: GrokStatusModel[];
  candidates: GrokCandidate[];
  excluded: string[];
}

/** Same collapse store the Desktop page uses; Grok has only two groups, both open. */
const GROUP_COLLAPSE = makeCollapseStore("ocx.grok.collapsedGroups.v1");

const GROUPS = [
  { id: "native", tkey: "grok.groupNative" as TKey },
  { id: "routed", tkey: "grok.groupRouted" as TKey },
] as const;

/** Same context formatting the Desktop page uses, so the two surfaces read alike. */
function formatContext(value: number | undefined, t: TFn): string {
  if (!value) return "—";
  // 1 MiB and above is a whole "1M": providers report 2^20 (1048576), and
  // 1048576 / 1e6 = 1.048576 reads as a bug.
  if (value >= 1_048_576) return t("claudeDesktop.contextM", { n: Math.round(value / 1_048_576) });
  return value >= 1_000_000
    ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
    : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
}

/**
 * Grok Build surface: per-model switches over the candidate catalog, plus save/apply.
 *
 * The page writes ONLY the selection (config.json, via /api/grok/selection) and asks the
 * proxy to re-run the guarded sync (/api/grok/apply). The fence itself is written only
 * by injectGrokConfig — the same path `ocx start`/`ensure`/`restart` use. Aliases shown
 * here come from readGrokStatus (what the writer actually wrote), never computed.
 */
export default function Grok({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [status, setStatus] = useState<GrokStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [savedExcluded, setSavedExcluded] = useState<Set<string>>(new Set());
  // null = no stored preference; both groups start open because Grok has only two.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => GROUP_COLLAPSE.read() ?? new Set());
  const [pending, setPending] = useState<"save" | "apply" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/grok`);
      const payload = await readJsonOrThrow<GrokStatus & { error?: string }>(response, t("grok.loadFail"));
      if (!payload) throw new Error(t("grok.loadFail"));
      // Tolerate an older proxy that predates the selection routes: the page degrades
      // to the read-only fence view instead of crashing on a missing field.
      setStatus({ ...payload, candidates: payload.candidates ?? [], excluded: payload.excluded ?? [] });
      const saved = new Set(payload.excluded ?? []);
      setExcluded(saved);
      setSavedExcluded(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("grok.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  // Deferred like the Desktop page: kicking the fetch off synchronously inside the effect
  // triggers cascading renders (and the react-doctor lint that guards against them).
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const dirty = useMemo(
    () => excluded.size !== savedExcluded.size || [...excluded].some(id => !savedExcluded.has(id)),
    [excluded, savedExcluded],
  );

  const aliasById = useMemo(
    () => new Map((status?.models ?? []).map(m => [m.id, m.alias])),
    [status],
  );

  const toggleGroup = (id: string) => {
    const next = toggleInSet(collapsed, id);
    GROUP_COLLAPSE.write(next);
    setCollapsed(next);
  };

  const toggleModel = (id: string, currentlyExcluded: boolean) => {
    setExcluded(current => {
      const next = new Set(current);
      if (currentlyExcluded) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async (applyAfter: boolean) => {
    if (pending) return;
    setPending("save");
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/grok/selection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: [...excluded] }),
      });
      await readJsonOrThrow<{ error?: string }>(response, t("grok.saveFailed"));
      setSavedExcluded(new Set(excluded));

      if (applyAfter) {
        setPending("apply");
        const applied = await fetch(`${apiBase}/api/grok/apply`, { method: "POST" });
        // Apply errors use `{ message, skippedReason }` (not always `error`); preserve that
        // actionable copy for orphan-marker repair and policy skips.
        if (!applied.ok) {
          const failed = await applied.json().catch(() => ({})) as { message?: string; error?: string };
          throw new Error(failed.message ?? failed.error ?? t("grok.applyFailed"));
        }
        const payload = await applied.json().catch(() => ({})) as {
          message?: string;
          skippedReason?: string;
        };
        // A policy skip is not success theatre: the Grok config did NOT change
        // (non-loopback bind, or no ~/.grok), so say that instead of "applied".
        if (payload.skippedReason) {
          setMessage({ tone: "err", text: payload.message ?? t("grok.applySkipped") });
          setAnnouncement(payload.message ?? t("grok.applySkipped"));
        } else {
          setMessage({ tone: "ok", text: t("grok.savedApplied") });
          setAnnouncement(t("grok.savedApplied"));
        }
        await load();
      } else {
        setMessage({ tone: "ok", text: t("grok.saved") });
        setAnnouncement(t("grok.saved"));
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : t("grok.saveFailed");
      setMessage({ tone: "err", text });
      setAnnouncement(text);
    } finally {
      setPending(null);
    }
  };

  if (loading) return <p className="m3-card-sub">{t("grok.loading")}</p>;

  if (error) {
    return (
      <Card title={t("grok.title")}>
        <p role="alert" style={{ margin: 0, color: "var(--m3-error)", fontSize: "var(--t-body-m)" }}>{error}</p>
        <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
          <Button variant="tonal" onClick={() => void load()}>{t("common.retry")}</Button>
        </div>
      </Card>
    );
  }

  return (
    <>
      <p className="m3-card-sub" style={{ maxWidth: "74ch", marginBottom: "var(--sp-3)" }}>{t("grok.subtitle")}</p>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      {status && status.candidates.length > 0 && (
        <div className="m3-row m3-row--split" style={{ marginBottom: "var(--sp-3)" }}>
          <span className={`m3-chip${dirty ? " selected" : ""}`}>
            {dirty ? t("grok.unsaved") : t("grok.upToDate")}
          </span>
          <div className="m3-row">
            <Button variant="outlined" disabled={!dirty || pending !== null} onClick={() => void save(false)}>
              {pending === "save" ? t("grok.saving") : t("common.save")}
            </Button>
            <Button variant="filled" disabled={!dirty || pending !== null} onClick={() => void save(true)}>
              {pending === "apply" ? t("grok.applying") : pending === "save" ? t("grok.saving") : t("grok.saveApply")}
            </Button>
          </div>
        </div>
      )}

      {!status?.present ? (
        // Absent is a normal state, not a failure: Grok simply is not wired up yet. Name the
        // action that wires it rather than leaving an empty panel.
        <Empty title={t("grok.notConfiguredTitle")}>
          {t("grok.notConfiguredHint")}
          <br />
          <code style={{ fontFamily: "var(--mono)" }}>{status?.configPath}</code>
        </Empty>
      ) : (
        <div className="m3-row" style={{ marginBottom: "var(--sp-3)" }}>
          <span style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>{t("grok.endpoint")}</span>
          <code style={{
            fontFamily: "var(--mono)",
            fontSize: "var(--t-label-m)",
            padding: "8px 12px",
            borderRadius: "var(--r-s)",
            background: "var(--m3-surface-container-highest)",
          }}>{status.baseUrl ?? "—"}</code>
          <code style={{ fontFamily: "var(--mono)", fontSize: "var(--t-label-m)", color: "var(--m3-on-surface-variant)" }}>
            {status.configPath}
          </code>
        </div>
      )}

      {status && status.candidates.length > 0 && GROUPS.map(group => {
        const view = grokGroupView(status.candidates, aliasById, excluded, group.id);
        if (view.total === 0) return null;
        const isCollapsed = collapsed.has(group.id);
        return (
          <Card
            key={group.id}
            title={
              <button
                type="button"
                className="m3-btn m3-btn--text"
                style={{ padding: 0, gap: 8, font: "inherit", color: "inherit" }}
                aria-expanded={!isCollapsed}
                aria-controls={`grok-group-body-${group.id}`}
                onClick={() => toggleGroup(group.id)}
              >
                <IconChevron
                  width={14}
                  height={14}
                  aria-hidden="true"
                  style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }}
                />
                {t(group.tkey)}
              </button>
            }
            actions={<span className="m3-chip">{t("grok.enabledCount", { on: view.enabled, total: view.total })}</span>}
          >
            {!isCollapsed && (
              <div id={`grok-group-body-${group.id}`} style={{ overflowX: "auto" }}>
                <table className="m3-table">
                  <thead>
                    <tr>
                      <th scope="col"><span className="sr-only">{t("grok.colEnabled")}</span></th>
                      <th scope="col">{t("grok.colModel")}</th>
                      <th scope="col">{t("grok.colAlias")}</th>
                      <th scope="col">{t("grok.colContext")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map(model => (
                      <tr key={model.id}>
                        <td style={{ width: 1 }}>
                          <Toggle
                            on={model.enabled}
                            onChange={() => toggleModel(model.id, !model.enabled)}
                            disabled={pending !== null}
                            label={t("grok.toggleModel", { id: model.id })}
                          />
                        </td>
                        <td style={{ fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>{model.id}</td>
                        <td style={{ fontFamily: "var(--mono)", color: "var(--m3-on-surface-variant)", overflowWrap: "anywhere" }}>
                          {model.alias ?? "—"}
                        </td>
                        <td style={{ color: "var(--m3-on-surface-variant)", whiteSpace: "nowrap" }}>
                          {formatContext(model.contextWindow, t)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}
