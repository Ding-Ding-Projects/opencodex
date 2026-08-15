/**
 * The Downloading surface: a distinct page, not a background table row.
 *
 * A thin client over `/api/downloads/*`
 * (`src/server/management/download-routes.ts`), which is itself a thin caller
 * of `src/lib/downloads/manager.ts` — the module that owns the real transfer
 * (an actual `fetch()`, streamed to an actual file, with a real
 * `AbortController` behind pause/cancel). This page never simulates progress:
 * every bar and byte count here is `bytesReceived`/`bytesTotal` read straight
 * off the manager's record.
 *
 * The Start-download decision dialog and the always-on-top completion surface
 * are NOT here — see `shell/DownloadsBridge.tsx`, which is mounted once at the
 * app shell so those two surfaces appear regardless of which page is open,
 * exactly like the destructive-confirm dialog and the notification toasts.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Empty } from "../shell/m3-ui";
import type { BadgeTone } from "../shell/badge-tone";
import { SearchField } from "../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { IconCheckCircle, IconError, IconPause, IconPlay, IconRefresh, IconTrash, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import type { TKey } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { formatBytes } from "../format-bytes";
import { formatEtaSeconds, formatRate } from "../downloads-format";
import type { DownloadRecord, DownloadState } from "../downloads-types";

const STATE_TKEY: Record<DownloadState, TKey> = {
  queued: "downloads.state.queued",
  downloading: "downloads.state.downloading",
  paused: "downloads.state.paused",
  completed: "downloads.state.completed",
  canceled: "downloads.state.canceled",
  error: "downloads.state.error",
};

const STATE_TONE: Record<DownloadState, BadgeTone> = {
  queued: "neutral",
  downloading: "accent",
  paused: "warn",
  completed: "ok",
  canceled: "neutral",
  error: "error",
};

const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 6000;

async function fetchJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "the request failed" };
  }
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: body?.error ?? String(res.status) };
  return { ok: true, data: body as T };
}

function ProgressBar({ pct }: { pct: number | null }) {
  return (
    <div className="m3-dl-progress" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className="m3-dl-progress__fill" style={{ width: `${pct ?? 0}%`, ...(pct === null ? { animationPlayState: "running" } : {}) }} />
    </div>
  );
}

function RecordRow({ record, apiBase, onChanged }: { record: DownloadRecord; apiBase: string; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { notify } = useNotifications();
  const [busy, setBusy] = useState(false);

  const pct = record.bytesTotal ? Math.min(100, Math.round((record.bytesReceived / record.bytesTotal) * 100)) : null;

  async function act(action: "cancel" | "pause" | "resume"): Promise<void> {
    setBusy(true);
    const result = await fetchJson(apiBase, `/api/downloads/${encodeURIComponent(record.id)}/${action}`, { method: "POST" });
    setBusy(false);
    if (!result.ok) { notify({ tone: "error", title: t("downloads.actionFailed"), body: result.error }); return; }
    onChanged();
  }

  async function remove(): Promise<void> {
    setBusy(true);
    const result = await fetchJson(apiBase, `/api/downloads/${encodeURIComponent(record.id)}`, { method: "DELETE" });
    setBusy(false);
    if (!result.ok) { notify({ tone: "error", title: t("downloads.actionFailed"), body: result.error }); return; }
    onChanged();
  }

  return (
    <div className="m3-dl-row">
      <div className="m3-dl-row__main">
        <div className="m3-dl-row__name">{record.suggestedFilename}</div>
        <div className="m3-dl-row__url" title={record.url}>{record.url}</div>
        {record.state === "downloading" || record.state === "paused" ? (
          <>
            <ProgressBar pct={pct} />
            <div className="m3-dl-row__stats">
              <span>{formatBytes(record.bytesReceived, locale)}{record.bytesTotal ? ` / ${formatBytes(record.bytesTotal, locale)}` : ""}</span>
              {record.state === "downloading" && record.rateBytesPerSec != null && <span>{formatRate(record.rateBytesPerSec, locale)}</span>}
              {record.state === "downloading" && record.etaSeconds != null && <span>{t("downloads.eta", { time: formatEtaSeconds(record.etaSeconds) })}</span>}
            </div>
          </>
        ) : record.state === "error" && record.error ? (
          <p className="m3-field-hint" role="alert">{record.error}</p>
        ) : record.destinationPath ? (
          <p className="m3-field-hint">{record.destinationPath}</p>
        ) : null}
      </div>
      <div className="m3-dl-row__side">
        <Badge tone={STATE_TONE[record.state]}>{t(STATE_TKEY[record.state])}</Badge>
        <div className="m3-row" style={{ gap: 4 }}>
          {record.state === "downloading" && (
            <Button variant="text" onClick={() => void act("pause")} disabled={busy} aria-label={t("downloads.pause")}>
              <IconPause width={16} height={16} />
            </Button>
          )}
          {record.state === "paused" && (
            <Button variant="text" onClick={() => void act("resume")} disabled={busy} aria-label={t("downloads.resume")}>
              <IconPlay width={16} height={16} />
            </Button>
          )}
          {(record.state === "downloading" || record.state === "paused" || record.state === "queued") && (
            <Button variant="text" onClick={() => void act("cancel")} disabled={busy} aria-label={t("downloads.cancel")}>
              <IconX width={16} height={16} />
            </Button>
          )}
          {(record.state === "completed" || record.state === "canceled" || record.state === "error") && (
            <Button variant="text" onClick={() => void remove()} disabled={busy} aria-label={t("downloads.remove")}>
              <IconTrash width={16} height={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Downloads({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchJson<{ records: DownloadRecord[] }>(apiBase, "/api/downloads", { signal });
    if (signal?.aborted) return;
    setLoading(false);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    setRecords(result.data.records);
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [load]);

  const hasActive = records.some(r => r.state === "queued" || r.state === "downloading" || r.state === "paused");
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  const matcher = useMemo(() => settingsMatcher(query, useRegex, flags), [query, useRegex, flags]);
  const sampleText = useMemo(() => records.slice(0, 40).map(r => r.suggestedFilename).join("\n"), [records]);
  const filtered = useMemo(() => records.filter(r => matcher.test(`${r.suggestedFilename} ${r.url} ${r.state}`)), [records, matcher]);

  const active = filtered.filter(r => r.state !== "completed" && r.state !== "canceled" && r.state !== "error");
  const finished = filtered.filter(r => r.state === "completed" || r.state === "canceled" || r.state === "error");

  return (
    <div className="m3-stack">
      <Card
        title={t("downloads.title")}
        subtitle={t("downloads.subtitle")}
        actions={<Button variant="text" onClick={() => void load()} disabled={loading}><IconRefresh width={16} height={16} /> {t("downloads.refresh")}</Button>}
      >
        <SearchField
          id="downloads-search"
          value={query}
          onChange={setQuery}
          searchLabel={t("downloads.searchLabel")}
          placeholder={t("downloads.searchLabel")}
          regex={useRegex}
          onRegexChange={setUseRegex}
          flags={flags}
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          sample={sampleText}
        />
        {matcher.error && <p className="m3-field-hint" role="alert">{matcher.error}</p>}
        {error && <p className="m3-field-hint" role="alert">{error}</p>}

        {records.length === 0 ? (
          <Empty
            icon={IconCheckCircle}
            title={loading ? t("downloads.loading") : t("downloads.empty")}
          >
            {!loading && <p className="m3-field-hint">{t("downloads.emptyHint")}</p>}
          </Empty>
        ) : (
          <>
            {active.length > 0 && (
              <div className="m3-dl-section">
                <h3 className="m3-dl-section__title">{t("downloads.activeSection")}</h3>
                {active.map(r => <RecordRow key={r.id} record={r} apiBase={apiBase} onChanged={() => void load()} />)}
              </div>
            )}
            {finished.length > 0 && (
              <div className="m3-dl-section">
                <h3 className="m3-dl-section__title">{t("downloads.historySection")}</h3>
                {finished.map(r => <RecordRow key={r.id} record={r} apiBase={apiBase} onChanged={() => void load()} />)}
              </div>
            )}
            {active.length === 0 && finished.length === 0 && <Empty icon={IconError} title={t("downloads.noMatches")} />}
          </>
        )}
      </Card>
    </div>
  );
}
