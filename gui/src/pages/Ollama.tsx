/**
 * Local model-runtime (Ollama) suite manager.
 *
 * A thin client over `/api/model-runtime/*`
 * (`src/server/management/model-runtime-routes.ts`), which is itself a thin
 * caller of `src/lib/model-runtime/*` — the module that talks to Ollama's
 * documented local HTTP API (health, version, tags, ps, show, delete, pull)
 * and runs the hardware-fit estimate. The renderer never reaches the Ollama
 * daemon directly; every request here goes through this app's own privileged
 * process, exactly like PDF tools' filesystem operations.
 *
 * ## The batch-pull cart lives here now
 *
 * "Cart" means batch pull only, never money — there is no price, checkout,
 * account, or entitlement concept anywhere below. Reviewing a batch
 * (`POST /pull-queue/preflight`) shows every tag's already-installed state,
 * real reused size where one exists, conservative disk headroom, and the
 * plain network disclosure, before anything downloads. Starting a batch
 * (`POST /pull-queue/start`) processes it with bounded, user-chosen
 * concurrency; every item's real byte progress is shown where the runtime
 * reports it, and an honest "downloading…" badge — never a guessed
 * percentage — where it does not yet. A failed item never turns the whole
 * batch's summary green, and it never removes anything already installed;
 * see `src/lib/model-runtime/pull-queue-engine.ts`'s header for the full
 * guarantee. The queue survives a restart of this app on its own — see
 * `resume` below.
 *
 * The streaming chat surface and allowlisted harness launch remain separate,
 * still-`absent` contracts (`docs/FEATURE-INVENTORY.md`, slice 8).
 *
 * ## Server-authored diagnostic text stays in English
 *
 * `health.detail`, every string in `fit.evidence`, every string in
 * `hardware.warnings`, and every `PullQueueItem.lastStatusMessage`/`error`
 * are generated in `src/lib/model-runtime/*` — plain English sentences
 * describing what was actually measured or reported, in the same way
 * `PdfTools.tsx` displays a server's `error` string verbatim rather than
 * re-localizing it. Only this page's own chrome (labels, buttons, headers)
 * goes through `t()`.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Badge, Banner, Button, Card, Empty, Field, Segmented, SelectField, Slider, TextArea, Toggle } from "../shell/m3-ui";
import type { BadgeTone } from "../shell/badge-tone";
import { SearchField } from "../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import {
  IconArrowDown, IconArrowUp, IconCheckCircle, IconDownload, IconError, IconGauge, IconHardDrive,
  IconList, IconNetworkCheck, IconPower, IconRefresh, IconRestartAlt, IconSweep, IconTrash, IconX,
} from "../icons";
import { useI18n } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { useConfirm } from "../shell/confirm-context";
import { formatBytes } from "../format-bytes";

type OllamaHealthState = "healthy" | "missing" | "stopped" | "unhealthy" | "offline";

interface OllamaHealthResult {
  state: OllamaHealthState;
  baseUrl: string;
  version: string | null;
  detail: string;
  hostWarning: string | null;
  checkedAt: number;
}

type FitVerdict = "runs-well" | "runs-with-limits" | "unlikely" | "unknown";

interface FitResult {
  verdict: FitVerdict;
  evidence: string[];
  computedAt: number;
}

interface GpuFact {
  name: string;
  vramBytes: number | null;
  source: "nvidia-smi" | "windows-wmi" | "unknown";
  caveats: string[];
}

interface HardwareFacts {
  detectedAt: number;
  platform: string;
  totalRamBytes: number | null;
  freeRamBytes: number | null;
  gpus: GpuFact[];
  freeDiskBytes: number | null;
  diskPath: string | null;
  warnings: string[];
}

interface CatalogEntry {
  name: string;
  model: string;
  modifiedAt: string | null;
  sizeBytes: number | null;
  digest: string | null;
  format: string | null;
  family: string | null;
  families: string[] | null;
  parameterSize: string | null;
  parameterCountBillions: number | null;
  quantizationLevel: string | null;
  contextLength: number | null;
  capabilities: string[] | null;
  running: boolean;
  runningVramBytes: number | null;
  showOk: boolean;
  showError: string | null;
  fit: FitResult;
}

type CompletenessVerdict = "complete" | "partial" | "unavailable";

interface CatalogResult {
  entries: CatalogEntry[];
  refreshedAt: number;
  sourceRevision: string | null;
  pageCount: number;
  completeness: { verdict: CompletenessVerdict; detail: string };
  hardware: HardwareFacts;
}

interface CatalogResponse {
  health: OllamaHealthResult;
  catalog: CatalogResult | null;
}

/* ------------------------------------------------------------ pull queue */

type PullItemStatus = "queued" | "pulling" | "pulled" | "skipped" | "cancelled" | "failed";

interface PullQueueItem {
  id: string;
  tag: string;
  status: PullItemStatus;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  receivedBytes: number;
  totalBytes: number;
  totalKnown: boolean;
  lastStatusMessage: string | null;
  estimatedSizeBytes: number | null;
  error: string | null;
}

interface PullQueueState {
  version: 1;
  items: PullQueueItem[];
}

type PullQueueOutcome = "empty" | "in-progress" | "complete-success" | "complete-partial";

interface PullQueueSummary {
  total: number;
  queued: number;
  pulling: number;
  pulled: number;
  skipped: number;
  cancelled: number;
  failed: number;
  outcome: PullQueueOutcome;
}

interface PullPreflightItem {
  tag: string;
  alreadyInstalled: boolean;
  estimatedSizeBytes: number | null;
  estimatedAdditionalDiskBytes: number | null;
  fitVerdict: FitVerdict | null;
  disclosure: string;
}

interface PullPreflight {
  items: PullPreflightItem[];
  aggregateEstimatedBytes: number;
  aggregateSizeFullyKnown: boolean;
  freeDiskBytes: number | null;
  diskPath: string | null;
  networkDisclosure: string;
}

const PULL_STATUS_LABEL_KEY: Record<PullItemStatus, TKey> = {
  queued: "ollama.pull.status.queued",
  pulling: "ollama.pull.status.pulling",
  pulled: "ollama.pull.status.pulled",
  skipped: "ollama.pull.status.skipped",
  cancelled: "ollama.pull.status.cancelled",
  failed: "ollama.pull.status.failed",
};

const PULL_STATUS_TONE: Record<PullItemStatus, BadgeTone> = {
  queued: "neutral",
  pulling: "accent",
  pulled: "ok",
  skipped: "neutral",
  cancelled: "warn",
  failed: "error",
};

const MIN_PULL_CONCURRENCY = 1;
const MAX_PULL_CONCURRENCY = 5;
const DEFAULT_PULL_CONCURRENCY = 2;

/** One tag per line, or comma-separated — matches how someone would paste a short list from anywhere. */
function parsePullTags(raw: string): string[] {
  const pieces = raw.split(/[\n,]/).map(s => s.trim()).filter(s => s.length > 0);
  return Array.from(new Set(pieces));
}

function sameTagList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** Polls while the batch is actually in flight; a completed/empty queue does not need a live poll. */
const PULL_QUEUE_POLL_MS = 1_500;

function PullProgressCell({ item, locale, t }: { item: PullQueueItem; locale: Parameters<typeof formatBytes>[1]; t: TFn }) {
  if (item.status === "pulling") {
    if (item.totalKnown && item.totalBytes > 0) {
      const pct = Math.min(100, Math.max(0, Math.round((item.receivedBytes / item.totalBytes) * 100)));
      return (
        <div className="m3-ollama-pull-progress">
          <span
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={item.tag}
            style={BAR_TRACK}
          >
            <span aria-hidden="true" style={{ ...BAR_FILL, width: `${Math.max(2, pct)}%` }} />
          </span>
          <span className="m3-field-hint">{t("ollama.pull.progress.determinate", { received: formatBytes(item.receivedBytes, locale), total: formatBytes(item.totalBytes, locale), pct })}</span>
        </div>
      );
    }
    // Never a synthesised percentage: honestly indeterminate until the runtime reports a real size.
    return (
      <div className="m3-ollama-pull-progress">
        <Badge tone="accent">{t("ollama.pull.progress.indeterminate")}</Badge>
        {item.receivedBytes > 0 && <span className="m3-field-hint">{t("ollama.pull.progress.bytesSoFar", { received: formatBytes(item.receivedBytes, locale) })}</span>}
      </div>
    );
  }
  if (item.lastStatusMessage) return <span className="m3-field-hint">{item.lastStatusMessage}</span>;
  return <span>—</span>;
}

type SortKey = "name" | "size" | "fit";

const FIT_ORDER: Record<FitVerdict, number> = { "runs-well": 0, "runs-with-limits": 1, unlikely: 2, unknown: 3 };

const HEALTH_ICON: Record<OllamaHealthState, typeof IconError> = {
  healthy: IconCheckCircle,
  missing: IconError,
  stopped: IconPower,
  unhealthy: IconError,
  offline: IconNetworkCheck,
};

const HEALTH_BANNER_TONE: Record<OllamaHealthState, "info" | "success" | "warn" | "error"> = {
  healthy: "success",
  missing: "error",
  stopped: "warn",
  unhealthy: "warn",
  offline: "error",
};

const HEALTH_TITLE_KEY: Record<OllamaHealthState, TKey> = {
  healthy: "ollama.health.healthy",
  missing: "ollama.health.missing",
  stopped: "ollama.health.stopped",
  unhealthy: "ollama.health.unhealthy",
  offline: "ollama.health.offline",
};

const HEALTH_GUIDANCE_KEY: Record<OllamaHealthState, TKey | null> = {
  healthy: null,
  missing: "ollama.health.missingGuidance",
  stopped: "ollama.health.stoppedGuidance",
  unhealthy: "ollama.health.unhealthyGuidance",
  offline: "ollama.health.offlineGuidance",
};

const FIT_LABEL_KEY: Record<FitVerdict, TKey> = {
  "runs-well": "ollama.fit.runsWell",
  "runs-with-limits": "ollama.fit.runsWithLimits",
  unlikely: "ollama.fit.unlikely",
  unknown: "ollama.fit.unknown",
};

const FIT_BADGE_TONE: Record<FitVerdict, BadgeTone> = {
  "runs-well": "ok",
  "runs-with-limits": "warn",
  unlikely: "error",
  unknown: "neutral",
};

const COMPLETENESS_KEY: Record<CompletenessVerdict, TKey> = {
  complete: "ollama.catalog.completeness.complete",
  partial: "ollama.catalog.completeness.partial",
  unavailable: "ollama.catalog.completeness.unavailable",
};

/** Auto-recheck cadence while the runtime is not healthy — the "return path to the interrupted action" the health contract asks for, without the user having to click anything. */
const AUTO_RETRY_MS = 12_000;

const TABLE_WRAP: CSSProperties = { overflowX: "auto", marginTop: "var(--sp-2)" };
const BAR_TRACK: CSSProperties = {
  display: "block",
  width: "100%",
  minWidth: 96,
  height: 8,
  borderRadius: "var(--r-pill)",
  background: "var(--m3-surface-container-highest)",
  overflow: "hidden",
};
const BAR_FILL: CSSProperties = { display: "block", height: "100%", background: "var(--m3-primary)" };

async function fetchJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "the request failed", status: 0 };
  }
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: body?.error ?? String(res.status), status: res.status };
  return { ok: true, data: body as T };
}

function FitCell({ fit, t }: { fit: FitResult; t: TFn }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="m3-ollama-fit">
      <Badge tone={FIT_BADGE_TONE[fit.verdict]}>{t(FIT_LABEL_KEY[fit.verdict])}</Badge>
      {fit.evidence.length > 0 && (
        <button type="button" className="m3-ollama-fit__toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          {open ? t("ollama.fit.hideEvidence") : t("ollama.fit.showEvidence")}
        </button>
      )}
      {open && (
        <ul className="m3-ollama-fit__evidence" role="note">
          {fit.evidence.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
    </div>
  );
}

function GpuFactRow({ gpu, t, locale }: { gpu: GpuFact; t: TFn; locale: Parameters<typeof formatBytes>[1] }) {
  return (
    <div className="m3-ollama-hardware__fact">
      <IconGauge width={18} height={18} />
      <span>
        {t("ollama.hardware.gpu", {
          name: gpu.name,
          vram: gpu.vramBytes != null ? formatBytes(gpu.vramBytes, locale) : t("ollama.hardware.gpuVramUnknown"),
          source: gpu.source,
        })}
        {gpu.caveats.map((caveat, i) => <div key={i} className="m3-field-hint">{caveat}</div>)}
      </span>
    </div>
  );
}

export default function Ollama({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const { notify } = useNotifications();
  const confirm = useConfirm();

  const [health, setHealth] = useState<OllamaHealthResult | null>(null);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [familyFilter, setFamilyFilter] = useState("");
  const [fitFilter, setFitFilter] = useState<"" | FitVerdict>("");
  const [runningOnly, setRunningOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDesc, setSortDesc] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const result = await fetchJson<CatalogResponse>(apiBase, "/api/model-runtime/catalog", { signal });
    if (signal?.aborted) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setHealth(result.data.health);
    setCatalog(result.data.catalog);
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    // Deferred initial load (matches Models/Usage/ClaudeCode): avoids synchronous
    // setState inside the effect body, per the react-hooks/set-state-in-effect lint gate.
    const timeout = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [load]);

  // Auto-recheck while unhealthy, so recovery (starting the daemon, installing
  // it) is picked up without the user having to come back and click Retry —
  // the "return path to the interrupted action" the health contract asks for.
  useEffect(() => {
    if (!health || health.state === "healthy") return;
    const timer = setInterval(() => { void load(); }, AUTO_RETRY_MS);
    return () => clearInterval(timer);
  }, [health, load]);

  /* ---------------------------------------------------------- pull queue */

  const [pullTagsInput, setPullTagsInput] = useState("");
  const [forceRepull, setForceRepull] = useState(false);
  const [concurrency, setConcurrency] = useState(DEFAULT_PULL_CONCURRENCY);
  const [preflight, setPreflight] = useState<PullPreflight | null>(null);
  const [preflightedTags, setPreflightedTags] = useState<string[]>([]);
  const [preflighting, setPreflighting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [queueState, setQueueState] = useState<PullQueueState | null>(null);
  const [queueSummary, setQueueSummary] = useState<PullQueueSummary | null>(null);

  const requestedTags = useMemo(() => parsePullTags(pullTagsInput), [pullTagsInput]);
  const preflightIsCurrent = preflight !== null && sameTagList(preflightedTags, requestedTags);

  const loadQueue = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchJson<{ ok: true; state: PullQueueState; summary: PullQueueSummary; concurrency: number }>(apiBase, "/api/model-runtime/pull-queue", { signal });
    if (signal?.aborted || !result.ok) return;
    setQueueState(result.data.state);
    setQueueSummary(result.data.summary);
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    // Resuming is the loopback-gated call that reconciles the persisted queue
    // against the runtime's real current state and continues anything still
    // queued (see the module header). A LAN-connected dashboard session gets
    // a plain 403 here and simply falls back to the read-only GET below —
    // it can see the queue, it just cannot kick a resume from a bare page load.
    const timeout = window.setTimeout(() => {
      void (async () => {
        await fetchJson(apiBase, "/api/model-runtime/pull-queue/resume", { method: "POST", signal: controller.signal });
        if (controller.signal.aborted) return;
        await loadQueue(controller.signal);
      })();
    }, 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [apiBase, loadQueue]);

  useEffect(() => {
    if (queueSummary?.outcome !== "in-progress") return;
    const timer = setInterval(() => { void loadQueue(); }, PULL_QUEUE_POLL_MS);
    return () => clearInterval(timer);
  }, [queueSummary?.outcome, loadQueue]);

  async function handlePreflight(): Promise<void> {
    if (requestedTags.length === 0) return;
    setPreflighting(true);
    const result = await fetchJson<{ ok: true; preflight: PullPreflight }>(apiBase, "/api/model-runtime/pull-queue/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: requestedTags }),
    });
    setPreflighting(false);
    if (!result.ok) {
      notify({ tone: "error", title: t("ollama.pull.reviewFailedTitle"), body: result.error });
      return;
    }
    setPreflight(result.data.preflight);
    setPreflightedTags(requestedTags);
  }

  async function handleStartPull(): Promise<void> {
    if (!preflightIsCurrent) return;
    setStarting(true);
    const result = await fetchJson<{ ok: true; state: PullQueueState }>(apiBase, "/api/model-runtime/pull-queue/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: requestedTags, concurrency, force: forceRepull }),
    });
    setStarting(false);
    if (!result.ok) {
      notify({ tone: "error", title: t("ollama.pull.startFailedTitle"), body: result.error });
      return;
    }
    setQueueState(result.data.state);
    setPreflight(null);
    setPreflightedTags([]);
    setPullTagsInput("");
    notify({ tone: "success", title: t("ollama.pull.startedTitle"), body: t("ollama.pull.startedBody", { count: requestedTags.length }) });
    void loadQueue();
  }

  async function handleCancelPullItem(item: PullQueueItem): Promise<void> {
    const result = await fetchJson(apiBase, "/api/model-runtime/pull-queue/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }),
    });
    if (!result.ok) notify({ tone: "error", title: t("ollama.pull.cancelFailedTitle"), body: result.error });
    void loadQueue();
  }

  async function handleCancelAllPulls(): Promise<void> {
    const result = await fetchJson(apiBase, "/api/model-runtime/pull-queue/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    if (!result.ok) notify({ tone: "error", title: t("ollama.pull.cancelFailedTitle"), body: result.error });
    void loadQueue();
  }

  async function handleRetryPullItem(item: PullQueueItem): Promise<void> {
    const result = await fetchJson(apiBase, "/api/model-runtime/pull-queue/retry", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }),
    });
    if (!result.ok) notify({ tone: "error", title: t("ollama.pull.retryFailedTitle"), body: result.error });
    void loadQueue();
  }

  async function handleClearFinishedPulls(): Promise<void> {
    const result = await fetchJson(apiBase, "/api/model-runtime/pull-queue/clear", { method: "POST" });
    if (!result.ok) notify({ tone: "error", title: t("ollama.pull.clearFailedTitle"), body: result.error });
    void loadQueue();
  }

  const queueItems = queueState?.items ?? [];
  const hasActivePulls = queueItems.some(i => i.status === "queued" || i.status === "pulling");
  const hasFinishedPulls = queueItems.some(i => i.status === "pulled" || i.status === "skipped" || i.status === "cancelled" || i.status === "failed");

  async function handleDelete(entry: CatalogEntry): Promise<void> {
    const confirmed = await confirm({
      title: t("ollama.delete.confirmTitle", { name: entry.name }),
      body: t("ollama.delete.confirmBody"),
      confirmLabel: t("ollama.delete.confirmLabel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setDeleting(entry.name);
    const result = await fetchJson<{ ok: true }>(apiBase, "/api/model-runtime/models", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: entry.name }),
    });
    setDeleting(null);
    if (!result.ok) {
      notify({ tone: "error", title: t("ollama.delete.failedTitle"), body: result.error });
      return;
    }
    notify({ tone: "success", title: t("ollama.delete.okTitle"), body: entry.name });
    void load();
  }

  // `?? []` alone would mint a fresh array reference on every render whenever
  // catalog is null, which the eslint set-state-in-effect sibling rule
  // (exhaustive-deps) correctly flags as churning every useMemo below on every
  // render rather than only when the catalog itself actually changes.
  const entries = useMemo(() => catalog?.entries ?? [], [catalog]);

  const families = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.family) set.add(e.family);
    return Array.from(set).sort();
  }, [entries]);

  const matcher = useMemo(() => settingsMatcher(query, useRegex, flags), [query, useRegex, flags]);
  const sampleText = useMemo(() => entries.slice(0, 40).map(e => e.name).join("\n"), [entries]);

  const filtered = useMemo(() => {
    let list = entries.filter(e => matcher.test(`${e.name} ${e.family ?? ""} ${e.parameterSize ?? ""} ${e.quantizationLevel ?? ""}`));
    if (familyFilter) list = list.filter(e => e.family === familyFilter);
    if (fitFilter) list = list.filter(e => e.fit.verdict === fitFilter);
    if (runningOnly) list = list.filter(e => e.running);
    const sorted = [...list].sort((a, b) => {
      const cmp = sortKey === "name" ? a.name.localeCompare(b.name)
        : sortKey === "size" ? (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)
        : FIT_ORDER[a.fit.verdict] - FIT_ORDER[b.fit.verdict];
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [entries, matcher, familyFilter, fitFilter, runningOnly, sortKey, sortDesc]);

  const hardware = catalog?.hardware;

  return (
    <div className="m3-stack">
      <Card title={t("ollama.title")} subtitle={t("ollama.subtitle")}>
        {error && <Banner tone="error">{error}</Banner>}

        {health && (() => {
          const HealthIcon = HEALTH_ICON[health.state];
          const guidanceKey = HEALTH_GUIDANCE_KEY[health.state];
          return (
            <Banner
              tone={HEALTH_BANNER_TONE[health.state]}
              title={<span className="m3-row" style={{ gap: 8 }}><HealthIcon width={18} height={18} /> {t(HEALTH_TITLE_KEY[health.state])}</span>}
              action={<Button variant="text" onClick={() => void load()}><IconRefresh width={16} height={16} /> {t("ollama.health.retry")}</Button>}
            >
              <p>{health.detail}</p>
              {guidanceKey && <p>{t(guidanceKey)}</p>}
              {health.hostWarning && <p>{t("ollama.health.hostWarning", { warning: health.hostWarning })}</p>}
            </Banner>
          );
        })()}

        {loading && !health && <p>{t("ollama.health.checking")}</p>}
      </Card>

      {hardware && (
        <Card title={t("ollama.hardware.title")}>
          <div className="m3-ollama-hardware">
            <div className="m3-ollama-hardware__fact">
              <IconGauge width={18} height={18} />
              <span>
                {hardware.totalRamBytes != null
                  ? t("ollama.hardware.ram", { total: formatBytes(hardware.totalRamBytes, locale), free: hardware.freeRamBytes != null ? formatBytes(hardware.freeRamBytes, locale) : "?" })
                  : t("ollama.hardware.ramUnknown")}
              </span>
            </div>
            <div className="m3-ollama-hardware__fact">
              <IconHardDrive width={18} height={18} />
              <span>
                {hardware.freeDiskBytes != null
                  ? t("ollama.hardware.disk", { free: formatBytes(hardware.freeDiskBytes, locale) })
                  : t("ollama.hardware.diskUnknown")}
              </span>
            </div>
            {hardware.gpus.length === 0 && (
              <div className="m3-ollama-hardware__fact"><IconGauge width={18} height={18} /><span>{t("ollama.hardware.gpuNone")}</span></div>
            )}
            {hardware.gpus.map((gpu, i) => <GpuFactRow key={i} gpu={gpu} t={t} locale={locale} />)}
            {hardware.warnings.map((w, i) => <p key={i} className="m3-field-hint">{w}</p>)}
          </div>
        </Card>
      )}

      <Card title={t("ollama.pull.title")} subtitle={t("ollama.pull.subtitle")}>
        <Field label={t("ollama.pull.tagsLabel")} hint={t("ollama.pull.tagsHint")} id="ollama-pull-tags">
          <TextArea
            id="ollama-pull-tags"
            rows={3}
            value={pullTagsInput}
            onChange={e => { setPullTagsInput(e.target.value); setPreflight(null); }}
            placeholder={t("ollama.pull.tagsPlaceholder")}
          />
        </Field>

        <div className="m3-row" style={{ flexWrap: "wrap", gap: 16, alignItems: "center", marginTop: 8 }}>
          <Toggle on={forceRepull} onChange={setForceRepull} label={t("ollama.pull.forceLabel")} />
          <Slider
            id="ollama-pull-concurrency"
            label={t("ollama.pull.concurrencyLabel")}
            min={MIN_PULL_CONCURRENCY}
            max={MAX_PULL_CONCURRENCY}
            value={concurrency}
            onChange={setConcurrency}
            valueLabel={String(concurrency)}
          />
        </div>

        <div className="m3-row" style={{ gap: 8, marginTop: 12 }}>
          <Button variant="outlined" onClick={() => void handlePreflight()} disabled={requestedTags.length === 0 || preflighting}>
            <IconList width={16} height={16} /> {preflighting ? t("ollama.pull.reviewing") : t("ollama.pull.review")}
          </Button>
          <Button variant="filled" onClick={() => void handleStartPull()} disabled={!preflightIsCurrent || starting}>
            <IconDownload width={16} height={16} /> {starting ? t("ollama.pull.starting") : t("ollama.pull.start")}
          </Button>
        </div>
        {!preflightIsCurrent && requestedTags.length > 0 && <p className="m3-field-hint">{t("ollama.pull.reviewFirstHint")}</p>}

        {preflight && (
          <div className="m3-ollama-pull-preflight">
            <p className="m3-field-hint">{preflight.networkDisclosure}</p>
            <div className="m3-row" style={{ flexWrap: "wrap", gap: 12 }}>
              {preflight.freeDiskBytes != null && (
                <Badge>{t("ollama.pull.freeDisk", { free: formatBytes(preflight.freeDiskBytes, locale) })}</Badge>
              )}
              <Badge tone={preflight.aggregateSizeFullyKnown ? "neutral" : "warn"}>
                {preflight.aggregateSizeFullyKnown
                  ? t("ollama.pull.aggregateKnown", { size: formatBytes(preflight.aggregateEstimatedBytes, locale) })
                  : t("ollama.pull.aggregatePartial", { size: formatBytes(preflight.aggregateEstimatedBytes, locale) })}
              </Badge>
            </div>
            <div style={TABLE_WRAP}>
              <table className="m3-table">
                <thead>
                  <tr>
                    <th>{t("ollama.pull.col.tag")}</th>
                    <th>{t("ollama.pull.col.status")}</th>
                    <th>{t("ollama.pull.col.size")}</th>
                    <th>{t("ollama.pull.col.disk")}</th>
                    <th>{t("ollama.pull.col.fit")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preflight.items.map(item => (
                    <tr key={item.tag}>
                      <td>{item.tag}</td>
                      <td>
                        <Badge tone={item.alreadyInstalled ? "neutral" : "accent"}>
                          {item.alreadyInstalled ? t("ollama.pull.alreadyInstalled") : t("ollama.pull.newPull")}
                        </Badge>
                        <div className="m3-field-hint">{item.disclosure}</div>
                      </td>
                      <td>{item.estimatedSizeBytes != null ? formatBytes(item.estimatedSizeBytes, locale) : t("ollama.pull.sizeUnknown")}</td>
                      <td>{item.estimatedAdditionalDiskBytes != null ? formatBytes(item.estimatedAdditionalDiskBytes, locale) : "—"}</td>
                      <td>{item.fitVerdict ? <Badge tone={FIT_BADGE_TONE[item.fitVerdict]}>{t(FIT_LABEL_KEY[item.fitVerdict])}</Badge> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {queueItems.length > 0 && queueSummary && (
        <Card
          title={t("ollama.pull.queueTitle")}
          subtitle={t("ollama.pull.queueSummary", {
            pulled: queueSummary.pulled,
            skipped: queueSummary.skipped,
            failed: queueSummary.failed,
            cancelled: queueSummary.cancelled,
            active: queueSummary.queued + queueSummary.pulling,
          })}
          actions={
            <div className="m3-row" style={{ gap: 8 }}>
              <Button variant="text" onClick={() => void handleCancelAllPulls()} disabled={!hasActivePulls}>
                <IconX width={16} height={16} /> {t("ollama.pull.cancelAll")}
              </Button>
              <Button variant="text" onClick={() => void handleClearFinishedPulls()} disabled={!hasFinishedPulls}>
                <IconSweep width={16} height={16} /> {t("ollama.pull.clearFinished")}
              </Button>
            </div>
          }
        >
          {queueSummary.outcome === "complete-partial" && (
            <Banner tone="warn">{t("ollama.pull.partialBanner")}</Banner>
          )}
          <div style={TABLE_WRAP}>
            <table className="m3-table">
              <thead>
                <tr>
                  <th>{t("ollama.pull.col.tag")}</th>
                  <th>{t("ollama.pull.col.status")}</th>
                  <th>{t("ollama.pull.col.progress")}</th>
                  <th><span className="sr-only">{t("ollama.catalog.col.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {queueItems.map(item => (
                  <tr key={item.id}>
                    <td>{item.tag}</td>
                    <td>
                      <Badge tone={PULL_STATUS_TONE[item.status]}>{t(PULL_STATUS_LABEL_KEY[item.status])}</Badge>
                      {item.error && <div className="m3-field-hint">{item.error}</div>}
                    </td>
                    <td><PullProgressCell item={item} locale={locale} t={t} /></td>
                    <td>
                      {(item.status === "queued" || item.status === "pulling") && (
                        <Button variant="text" onClick={() => void handleCancelPullItem(item)}>
                          <IconX width={16} height={16} /> {t("ollama.pull.cancel")}
                        </Button>
                      )}
                      {(item.status === "failed" || item.status === "cancelled") && (
                        <Button variant="text" onClick={() => void handleRetryPullItem(item)}>
                          <IconRestartAlt width={16} height={16} /> {t("ollama.pull.retry")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {catalog && (
        <Card
          title={t("ollama.catalog.title")}
          subtitle={t("ollama.catalog.refreshedAt", { when: new Date(catalog.refreshedAt).toLocaleString(locale) })}
          actions={<Button variant="text" onClick={() => void load()} disabled={loading}><IconRefresh width={16} height={16} /> {loading ? t("ollama.catalog.refreshing") : t("ollama.catalog.refresh")}</Button>}
        >
          <div className="m3-row" style={{ flexWrap: "wrap", gap: 12 }}>
            <Badge>{t("ollama.catalog.sourceRevision", { version: catalog.sourceRevision ?? "?" })}</Badge>
            <Badge>{t("ollama.catalog.pageCount", { count: catalog.pageCount })}</Badge>
            <Badge tone={catalog.completeness.verdict === "complete" ? "ok" : catalog.completeness.verdict === "partial" ? "warn" : "error"}>
              {t(COMPLETENESS_KEY[catalog.completeness.verdict])}
            </Badge>
          </div>
          <p className="m3-field-hint">{catalog.completeness.detail}</p>

          <SearchField
            id="ollama-search"
            value={query}
            onChange={setQuery}
            searchLabel={t("ollama.catalog.searchLabel")}
            placeholder={t("ollama.catalog.searchLabel")}
            regex={useRegex}
            onRegexChange={setUseRegex}
            flags={flags}
            onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
            sample={sampleText}
          />
          {matcher.error && <p className="m3-field-hint" role="alert">{matcher.error}</p>}

          <div className="m3-row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
            <SelectField
              id="ollama-family-filter"
              label={t("ollama.catalog.familyFilterLabel")}
              value={familyFilter}
              onChange={setFamilyFilter}
              options={[{ value: "", label: t("ollama.catalog.familyFilterAll") }, ...families.map(f => ({ value: f, label: f }))]}
            />
            <SelectField
              id="ollama-fit-filter"
              label={t("ollama.catalog.fitFilterLabel")}
              value={fitFilter}
              onChange={v => setFitFilter(v as "" | FitVerdict)}
              options={[
                { value: "", label: t("ollama.catalog.fitFilterAll") },
                { value: "runs-well", label: t("ollama.fit.runsWell") },
                { value: "runs-with-limits", label: t("ollama.fit.runsWithLimits") },
                { value: "unlikely", label: t("ollama.fit.unlikely") },
                { value: "unknown", label: t("ollama.fit.unknown") },
              ]}
            />
            <Toggle on={runningOnly} onChange={setRunningOnly} label={t("ollama.catalog.runningOnlyLabel")} />
            <Segmented
              label={t("ollama.catalog.sortLabel")}
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: "name", label: t("ollama.catalog.sort.name") },
                { value: "size", label: t("ollama.catalog.sort.size") },
                { value: "fit", label: t("ollama.catalog.sort.fit") },
              ]}
            />
            <Button variant="text" onClick={() => setSortDesc(d => !d)} aria-label={t("ollama.catalog.sortDirection")}>
              {sortDesc ? <IconArrowDown width={16} height={16} /> : <IconArrowUp width={16} height={16} />}
            </Button>
          </div>

          {filtered.length === 0 ? (
            <Empty title={t("ollama.catalog.empty")} />
          ) : (
            <div style={TABLE_WRAP}>
              <table className="m3-table">
                <thead>
                  <tr>
                    <th>{t("ollama.catalog.col.name")}</th>
                    <th>{t("ollama.catalog.col.family")}</th>
                    <th>{t("ollama.catalog.col.params")}</th>
                    <th>{t("ollama.catalog.col.quant")}</th>
                    <th>{t("ollama.catalog.col.context")}</th>
                    <th>{t("ollama.catalog.col.size")}</th>
                    <th>{t("ollama.catalog.col.fit")}</th>
                    <th><span className="sr-only">{t("ollama.catalog.col.actions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(entry => (
                    <tr key={entry.name}>
                      <td>
                        {entry.name}
                        {entry.running && <Badge tone="accent">{t("ollama.catalog.runningBadge")}</Badge>}
                        {!entry.showOk && entry.showError && <div className="m3-field-hint">{entry.showError}</div>}
                      </td>
                      <td>{entry.family ?? "—"}</td>
                      <td>{entry.parameterSize ?? "—"}</td>
                      <td>{entry.quantizationLevel ?? "—"}</td>
                      <td>{entry.contextLength != null ? entry.contextLength.toLocaleString(locale) : "—"}</td>
                      <td>{entry.sizeBytes != null ? formatBytes(entry.sizeBytes, locale) : "—"}</td>
                      <td><FitCell fit={entry.fit} t={t} /></td>
                      <td>
                        <Button variant="text" onClick={() => void handleDelete(entry)} disabled={deleting === entry.name}>
                          <IconTrash width={16} height={16} /> {t("ollama.delete.action")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
