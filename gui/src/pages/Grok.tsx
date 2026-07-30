import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button, Card, Empty, Toggle } from "../shell/m3-ui";
import { useNotifications } from "../shell/notifications-context";
import { recordRevision } from "../shell/revisions";
import { useT, type TKey } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
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

const GROUPS = [
  { id: "native", tkey: "grok.groupNative" as TKey },
  { id: "routed", tkey: "grok.groupRouted" as TKey },
] as const;

const subtitleStyle: CSSProperties = {
  margin: "0 0 16px",
  maxWidth: "74ch",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-body-l)",
  whiteSpace: "pre-line",
};

const headRowStyle: CSSProperties = { gap: 12, marginBottom: "var(--sp-4)" };
const spacerStyle: CSSProperties = { flex: "1 1 auto" };

const endpointStyle: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-m)",
  padding: "8px 12px",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-highest)",
};
const configPathStyle: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-m)",
  color: "var(--m3-on-surface-variant)",
  overflowWrap: "anywhere",
};
const countStyle: CSSProperties = { color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" };

const groupHeadingStyle: CSSProperties = { margin: "0 0 12px", fontSize: "var(--t-title-m)", fontWeight: 600 };
const groupListStyle: CSSProperties = {
  marginBottom: "var(--sp-4)",
  borderRadius: "var(--el-table-radius, var(--r-l))",
  border: "1px solid var(--m3-outline-variant)",
  background: "var(--el-table-bg, var(--m3-surface-container-lowest))",
  fontFamily: "var(--el-table-font, inherit)",
  color: "var(--el-table-color, var(--m3-on-surface))",
  overflow: "hidden",
};
const modelRowStyle = (last: boolean): CSSProperties => ({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 12,
  minHeight: "var(--h-row)",
  padding: "var(--el-table-pad, 10px 16px)",
  // Only between rows: the container already draws its own bottom edge, and a
  // trailing row border doubles it into a 2px line.
  borderBottom: last ? undefined : "1px solid var(--m3-outline-variant)",
});
const modelIdStyle: CSSProperties = {
  flex: "1 1 180px",
  minWidth: 0,
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-l)",
  overflowWrap: "anywhere",
};
const modelAliasStyle: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-m)",
  color: "var(--m3-on-surface-variant)",
  overflowWrap: "anywhere",
};
const modelContextStyle: CSSProperties = { color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" };

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
  const { notify } = useNotifications();
  const [status, setStatus] = useState<GrokStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [savedExcluded, setSavedExcluded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<"save" | "apply" | null>(null);

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

  const candidates = status?.candidates ?? [];
  const registered = candidates.reduce((count, c) => count + (excluded.has(c.id) ? 0 : 1), 0);

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
    try {
      const response = await fetch(`${apiBase}/api/grok/selection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: [...excluded] }),
      });
      await readJsonOrThrow<{ error?: string }>(response, t("grok.saveFailed"));
      // The selection is a user-visible record, so the change is undoable from
      // Version history — recorded with the exclusions that were replaced.
      recordRevision({
        scope: "settings",
        label: t("grok.title"),
        summary: t("grok.enabledCount", { on: registered, total: candidates.length }),
        before: JSON.stringify([...savedExcluded]),
      });
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
        // Error tone because only errors survive the snackbar auto-dismiss, and the
        // reason is the one thing the user needs to keep reading.
        if (payload.skippedReason) {
          notify({ tone: "error", title: t("grok.applySkipped"), body: payload.message });
        } else {
          notify({ tone: "success", title: t("grok.savedApplied"), body: status?.configPath });
        }
        await load();
      } else {
        notify({ tone: "success", title: t("grok.saved") });
      }
    } catch (err) {
      notify({ tone: "error", title: err instanceof Error ? err.message : t("grok.saveFailed") });
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
      <p style={subtitleStyle}>{t("grok.subtitle")}</p>

      {status && (status.present || candidates.length > 0) && (
        <div className="m3-row" style={headRowStyle}>
          {status.present && (
            <>
              <code style={endpointStyle}>{status.baseUrl ?? "—"}</code>
              <code style={configPathStyle}>{status.configPath}</code>
            </>
          )}
          <span style={spacerStyle} />
          {candidates.length > 0 && (
            <>
              <span className={`m3-chip${dirty ? " selected" : ""}`}>
                {dirty ? t("grok.unsaved") : t("grok.upToDate")}
              </span>
              <span style={countStyle}>{t("grok.enabledCount", { on: registered, total: candidates.length })}</span>
              <Button variant="outlined" disabled={!dirty || pending !== null} onClick={() => void save(false)}>
                {pending === "save" ? t("grok.saving") : t("common.save")}
              </Button>
              <Button variant="filled" disabled={!dirty || pending !== null} onClick={() => void save(true)}>
                {pending === "apply" ? t("grok.applying") : pending === "save" ? t("grok.saving") : t("grok.saveApply")}
              </Button>
            </>
          )}
        </div>
      )}

      {!status?.present && (
        // Absent is a normal state, not a failure: Grok simply is not wired up yet. Name the
        // action that wires it rather than leaving an empty panel.
        <Empty title={t("grok.notConfiguredTitle")}>
          {t("grok.notConfiguredHint")}
          <br />
          <code style={{ fontFamily: "var(--mono)" }}>{status?.configPath}</code>
        </Empty>
      )}

      {candidates.length > 0 && GROUPS.map(group => {
        const view = grokGroupView(candidates, aliasById, excluded, group.id);
        if (view.total === 0) return null;
        const headingId = `grok-group-${group.id}`;
        return (
          <section key={group.id}>
            <h2 id={headingId} style={groupHeadingStyle}>{t(group.tkey)}</h2>
            <div role="list" aria-labelledby={headingId} style={groupListStyle}>
              {view.rows.map((model, index) => (
                <div key={model.id} role="listitem" style={modelRowStyle(index === view.rows.length - 1)}>
                  <Toggle
                    on={model.enabled}
                    onChange={() => toggleModel(model.id, !model.enabled)}
                    disabled={pending !== null}
                    label={t("grok.toggleModel", { id: model.id })}
                  />
                  <code style={modelIdStyle}>{model.id}</code>
                  {/* The prototype's row has no column headers, so each value carries its
                      own screen-reader name instead of being read as a bare token. */}
                  <code style={modelAliasStyle}>
                    <span className="sr-only">{t("grok.colAlias")}</span>
                    {model.alias ?? "—"}
                  </code>
                  <span style={modelContextStyle}>
                    <span className="sr-only">{t("grok.colContext")}</span>
                    {formatContext(model.contextWindow, t)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
