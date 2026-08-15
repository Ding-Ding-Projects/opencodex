/**
 * The universal file converter — a categorized adapter catalogue, byte-level
 * detection, and a real run action for every bundled family, for real files
 * on this machine.
 *
 * A thin client over `/api/converter/*` (`src/server/management/converter-routes.ts`),
 * itself a thin caller of
 * `src/lib/converter/{registry,service,archive-service,structured-service}.ts`
 * — the same modules `ocx convert` (`src/cli/converter.ts`) calls, so this
 * page and the CLI can never disagree about what the catalogue says, what a
 * detection pass found, or what a conversion actually did to a file on disk.
 *
 * ## Three bundled families, each runnable from here
 *
 * The contract's rule 1 is that an adapter is enabled only when every
 * dependency it needs is bundled inside the installed app and proven to work
 * offline. Today that is true of three families:
 *  - **Documents/PDF** (`pdf-lib`) hands a detected source off to the
 *    existing `PdfTools.tsx` page rather than reimplementing its seven
 *    operations a second time here — one working implementation, reached
 *    from two places.
 *  - **Archives** (ZIP extraction, `node:zlib` alone) runs right here: pick a
 *    destination directory that does not exist yet, extract.
 *  - **Structured Data** (JSON/CSV/TSV/XML, hand-written, bounded) also runs
 *    right here: the target-format choices are computed from the catalogue's
 *    own `operations` list for the detected format — never a hard-coded
 *    pair — so a format only offers the conversions the catalogue actually
 *    advertises. A lossy target format's `lossyNote` is shown before the
 *    Convert button is enabled, gated behind an explicit acknowledgement,
 *    the same "disclose before it runs" shape `PdfTools.tsx` already uses
 *    for a signed source.
 *
 * Every other category is real in the catalogue — visible, searchable — and
 * honestly disabled, naming its exact missing dependency rather than being
 * hidden. See `src/lib/converter/registry.ts` for the reasoning behind each
 * one.
 *
 * ## The missing native browse control is not specific to this page
 *
 * Same pre-existing, cross-cutting gap `PdfTools.tsx` already documents: no
 * page in this app has a native file/folder browse dialog yet. The source and
 * destination fields here are plain absolute-path text inputs for the same
 * reason.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Badge, Banner, Button, Card, Empty, Field, Segmented, SelectField, Slider, TextInput, Toggle } from "../shell/m3-ui";
import type { BadgeTone } from "../shell/badge-tone";
import { SearchField } from "../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { useI18n, type TFn, type TKey } from "../i18n/shared";
import { navigateWithSource } from "../lib/converter-handoff";
import { useNotifications } from "../shell/notifications-context";
import { formatBytes } from "../format-bytes";
import {
  IconAudioFile, IconCode, IconDataObject, IconFolderZip, IconImage, IconPause, IconPictureAsPdf, IconPlay,
  IconPlus, IconRestartAlt, IconSweep, IconTableChart, IconTrash, IconVideoFile, IconX,
} from "../icons";

type AdapterCategoryId =
  | "documents-pdf" | "images" | "audio" | "video" | "archives"
  | "structured-data" | "code-text" | "binary-encodings";

const CATEGORY_ORDER: AdapterCategoryId[] = [
  "documents-pdf", "images", "audio", "video", "archives", "structured-data", "code-text", "binary-encodings",
];

const CATEGORY_ICON: Record<AdapterCategoryId, typeof IconImage> = {
  "documents-pdf": IconPictureAsPdf,
  images: IconImage,
  audio: IconAudioFile,
  video: IconVideoFile,
  archives: IconFolderZip,
  "structured-data": IconTableChart,
  "code-text": IconCode,
  "binary-encodings": IconDataObject,
};

const CATEGORY_LABEL_KEY: Record<AdapterCategoryId, TKey> = {
  "documents-pdf": "converter.category.documentsPdf",
  images: "converter.category.images",
  audio: "converter.category.audio",
  video: "converter.category.video",
  archives: "converter.category.archives",
  "structured-data": "converter.category.structuredData",
  "code-text": "converter.category.codeText",
  "binary-encodings": "converter.category.binaryEncodings",
};

interface CatalogFormat {
  id: string;
  label: string;
  category: AdapterCategoryId;
  extensions: string[];
  bundled: boolean;
  missingDependency?: string;
  reason?: string;
  operations?: string[];
  lossy?: boolean;
  lossyNote?: string;
}

interface CatalogCategory {
  id: AdapterCategoryId;
  label: string;
  formats: CatalogFormat[];
}

interface ConverterCatalog {
  categories: CatalogCategory[];
  totalFormats: number;
  enabledFormats: number;
}

interface DetectedSource {
  ok: boolean;
  boundary?: "empty" | "too-small" | "unreadable" | "too-large";
  reason?: string;
  formatId?: string;
  category?: AdapterCategoryId;
  evidence?: string;
  bytesInspected: number;
}

interface ExtractZipOutcome {
  ok: boolean;
  destination?: string;
  entryCount?: number;
  bytesWritten?: number;
  boundary?: string;
  error?: string;
}

interface StructuredConversionOutcome {
  ok: boolean;
  path?: string;
  bytesWritten?: number;
  lossy?: boolean;
  notes?: string[];
  boundary?: string;
  error?: string;
}

type StructuredFormatId = "json" | "csv" | "tsv" | "xml";
const ALL_STRUCTURED_FORMATS: StructuredFormatId[] = ["json", "csv", "tsv", "xml"];

/* --------------------------------------------------------------- batch queue */

type ConvertJobKindId = "structured" | "zip-extract" | "pdf-rotate";
type RotateDegreesId = 0 | 90 | 180 | 270;
type ConvertQueueItemStatus = "queued" | "converting" | "converted" | "skipped" | "cancelled" | "failed";
type ConvertQueueOutcome = "empty" | "in-progress" | "paused" | "complete-success" | "complete-partial";

interface ConvertQueueItemDto {
  id: string;
  kind: ConvertJobKindId;
  sourcePath: string;
  sourceFormat: StructuredFormatId | null;
  destPath: string;
  destFormat: StructuredFormatId | null;
  acknowledgeLossy: boolean;
  rotateDegrees?: RotateDegreesId;
  status: ConvertQueueItemStatus;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  sourceBytes: number | null;
  bytesWritten: number | null;
  lossy: boolean | null;
  notes: string[] | null;
  boundary: string | null;
  error: string | null;
}

interface ConvertQueueStateDto { paused: boolean; items: ConvertQueueItemDto[] }

interface ConvertQueueSummaryDto {
  total: number; queued: number; converting: number; converted: number;
  skipped: number; cancelled: number; failed: number; outcome: ConvertQueueOutcome;
}

interface ConvertPreflightItemDto { destPath: string; sourceBytes: number | null; estimatedOutputBytes: number | null }
interface ConvertDiskGroupDto { directory: string; freeDiskBytes: number | null; estimatedBytesNeeded: number; sufficient: boolean | null }

interface ConvertQueuePreflightDto {
  items: ConvertPreflightItemDto[];
  aggregateEstimatedBytes: number;
  aggregateSizeFullyKnown: boolean;
  groups: ConvertDiskGroupDto[];
  insufficientDiskSpace: boolean;
  disclosure: string;
}

/** A job the user has staged but not yet enqueued — client-only, never sent as-is (see `draftToApiJob`). */
interface DraftJob {
  clientId: string;
  kind: ConvertJobKindId;
  sourcePath: string;
  destPath: string;
  sourceFormat?: StructuredFormatId;
  destFormat?: StructuredFormatId;
  acknowledgeLossy: boolean;
  rotateDegrees?: RotateDegreesId;
  overwrite: boolean;
}

function draftToApiJob(draft: DraftJob): Omit<DraftJob, "clientId"> {
  return {
    kind: draft.kind,
    sourcePath: draft.sourcePath,
    destPath: draft.destPath,
    sourceFormat: draft.sourceFormat,
    destFormat: draft.destFormat,
    acknowledgeLossy: draft.acknowledgeLossy,
    rotateDegrees: draft.rotateDegrees,
    overwrite: draft.overwrite,
  };
}

const JOB_KIND_ORDER: ConvertJobKindId[] = ["structured", "zip-extract", "pdf-rotate"];
const JOB_KIND_LABEL_KEY: Record<ConvertJobKindId, TKey> = {
  structured: "converter.queue.kind.structured",
  "zip-extract": "converter.queue.kind.zipExtract",
  "pdf-rotate": "converter.queue.kind.pdfRotate",
};

const ROTATE_DEGREES_OPTIONS: RotateDegreesId[] = [0, 90, 180, 270];

const QUEUE_STATUS_LABEL_KEY: Record<ConvertQueueItemStatus, TKey> = {
  queued: "converter.queue.status.queued",
  converting: "converter.queue.status.converting",
  converted: "converter.queue.status.converted",
  skipped: "converter.queue.status.skipped",
  cancelled: "converter.queue.status.cancelled",
  failed: "converter.queue.status.failed",
};
const QUEUE_STATUS_TONE: Record<ConvertQueueItemStatus, BadgeTone> = {
  queued: "neutral", converting: "accent", converted: "ok", skipped: "neutral", cancelled: "warn", failed: "error",
};

/** Polls only while the batch is actually moving — an idle or paused queue does not need a live poll. */
const QUEUE_POLL_MS = 1_500;

const TABLE_WRAP: CSSProperties = { overflowX: "auto", marginTop: "var(--sp-2)" };

function jobKindDetail(
  item: { kind: ConvertJobKindId; sourceFormat?: StructuredFormatId | null; destFormat?: StructuredFormatId | null; rotateDegrees?: RotateDegreesId },
  t: TFn,
): string {
  if (item.kind === "structured") {
    return t("converter.queue.kindDetail.structured", { from: item.sourceFormat ?? "?", to: item.destFormat ?? "?" });
  }
  if (item.kind === "pdf-rotate") return t("converter.queue.kindDetail.pdfRotate", { degrees: String(item.rotateDegrees ?? 0) });
  return t("converter.queue.kindDetail.zipExtract");
}

function QueueJobDetail({ item, t }: { item: ConvertQueueItemDto; t: TFn }) {
  if (item.status === "converting") return <Badge tone="accent">{t("converter.queue.running")}</Badge>;
  if (item.status === "queued") return <span>—</span>;
  if (item.status === "failed") {
    return (
      <div className="m3-stack">
        {item.boundary && <Badge tone="error">{item.boundary}</Badge>}
        {item.error && <p className="m3-field-hint">{item.error}</p>}
      </div>
    );
  }
  if (item.status === "skipped") return <p className="m3-field-hint">{item.notes?.[0] ?? t("converter.queue.skippedNote")}</p>;
  if (item.status === "cancelled") return <p className="m3-field-hint">{item.error ?? t("converter.queue.cancelledNote")}</p>;
  return (
    <div className="m3-stack">
      {item.notes?.map((n, i) => <p key={i} className="m3-field-hint">{n}</p>)}
      {item.bytesWritten != null && <p className="m3-field-hint">{t("converter.queue.bytesWritten", { bytes: String(item.bytesWritten) })}</p>}
      {item.lossy && <Badge tone="warn">{t("converter.queue.lossyBadge")}</Badge>}
    </div>
  );
}

interface CategorySearchState { query: string; regex: boolean; flags: string }

function initialCategorySearch(): Record<AdapterCategoryId, CategorySearchState> {
  const entry: CategorySearchState = { query: "", regex: false, flags: DEFAULT_SEARCH_FLAGS };
  return Object.fromEntries(CATEGORY_ORDER.map(id => [id, { ...entry }])) as Record<AdapterCategoryId, CategorySearchState>;
}

async function callConverterApi<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string; boundary?: string; blocked?: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "the request failed" };
  }
  const body = await res.json().catch(() => null) as (T & { error?: string; boundary?: string }) | null;
  if (res.status === 403) {
    return { ok: false, error: (body as { error?: string } | null)?.error ?? "blocked", blocked: true };
  }
  if (!res.ok) {
    return { ok: false, error: body?.error ?? String(res.status), boundary: body?.boundary };
  }
  return { ok: true, data: body as T };
}

/** Deep-link a detected PDF into the full PDF Tools page, carrying its path the same way a mobile pairing QR carries a token. */
function openInPdfTools(path: string): void {
  navigateWithSource("pdf", path);
}

export default function Converter({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const { notify } = useNotifications();

  const [blocked, setBlocked] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ConverterCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [sourcePath, setSourcePath] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<DetectedSource | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);

  const [categorySearch, setCategorySearch] = useState(() => initialCategorySearch());

  // Run state for the two bundled families that convert right here (Archives
  // and Structured Data). PDF stays a hand-off to `PdfTools.tsx` — see the
  // module doc comment — so it needs none of this.
  const [destinationPath, setDestinationPath] = useState("");
  const [targetFormat, setTargetFormat] = useState<StructuredFormatId | "">("");
  const [acknowledgeLossy, setAcknowledgeLossy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runSuccess, setRunSuccess] = useState<string | null>(null);

  /* ---------------------------------------------------------- batch queue */

  const [queueDraftKind, setQueueDraftKind] = useState<ConvertJobKindId>("structured");
  const [queueDraftSource, setQueueDraftSource] = useState("");
  const [queueDraftDest, setQueueDraftDest] = useState("");
  const [queueDraftSourceFormat, setQueueDraftSourceFormat] = useState<StructuredFormatId>("json");
  const [queueDraftDestFormat, setQueueDraftDestFormat] = useState<StructuredFormatId>("csv");
  const [queueDraftAcknowledge, setQueueDraftAcknowledge] = useState(false);
  const [queueDraftRotate, setQueueDraftRotate] = useState<RotateDegreesId>(90);
  const [queueDraftOverwrite, setQueueDraftOverwrite] = useState(false);
  const [draftJobs, setDraftJobs] = useState<DraftJob[]>([]);

  const [queuePreflight, setQueuePreflight] = useState<ConvertQueuePreflightDto | null>(null);
  const [queuePreflighting, setQueuePreflighting] = useState(false);
  const [queueEnqueuing, setQueueEnqueuing] = useState(false);
  const [queueConcurrency, setQueueConcurrency] = useState(3);

  const [queueState, setQueueState] = useState<ConvertQueueStateDto | null>(null);
  const [queueSummary, setQueueSummary] = useState<ConvertQueueSummaryDto | null>(null);

  function addDraftJob(): void {
    const src = queueDraftSource.trim();
    const dest = queueDraftDest.trim();
    if (!src || !dest) return;
    const draft: DraftJob = {
      clientId: `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: queueDraftKind,
      sourcePath: src,
      destPath: dest,
      acknowledgeLossy: queueDraftAcknowledge,
      overwrite: queueDraftOverwrite,
    };
    if (queueDraftKind === "structured") {
      draft.sourceFormat = queueDraftSourceFormat;
      draft.destFormat = queueDraftDestFormat;
    }
    if (queueDraftKind === "pdf-rotate") draft.rotateDegrees = queueDraftRotate;
    setDraftJobs(prev => [...prev, draft]);
    setQueueDraftSource("");
    setQueueDraftDest("");
    setQueueDraftAcknowledge(false);
    setQueuePreflight(null); // stale the instant the job list changes
  }

  function removeDraftJob(clientId: string): void {
    setDraftJobs(prev => prev.filter(j => j.clientId !== clientId));
    setQueuePreflight(null);
  }

  async function handleQueuePreflight(): Promise<void> {
    if (draftJobs.length === 0) return;
    setQueuePreflighting(true);
    const result = await callConverterApi<{ preflight: ConvertQueuePreflightDto }>(apiBase, "/api/converter/queue/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs: draftJobs.map(draftToApiJob) }),
    });
    setQueuePreflighting(false);
    if (!result.ok) {
      notify({ tone: "error", title: t("converter.queue.previewFailedTitle"), body: result.error });
      return;
    }
    setQueuePreflight(result.data.preflight);
  }

  const loadQueueState = useCallback(async () => {
    const result = await callConverterApi<{ state: ConvertQueueStateDto; summary: ConvertQueueSummaryDto; concurrency: number }>(
      apiBase, "/api/converter/queue",
    );
    if (!result.ok) return;
    setQueueState(result.data.state);
    setQueueSummary(result.data.summary);
  }, [apiBase]);

  async function handleQueueEnqueue(): Promise<void> {
    if (draftJobs.length === 0) return;
    setQueueEnqueuing(true);
    const result = await callConverterApi<{ state: ConvertQueueStateDto; added: number }>(apiBase, "/api/converter/queue/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs: draftJobs.map(draftToApiJob), concurrency: queueConcurrency }),
    });
    setQueueEnqueuing(false);
    if (!result.ok) {
      const message = result.boundary ? t("converter.result.boundary", { boundary: result.boundary, error: result.error }) : result.error;
      notify({ tone: "error", title: t("converter.queue.enqueueFailedTitle"), body: message });
      return;
    }
    notify({ tone: "success", title: t("converter.queue.enqueuedTitle"), body: t("converter.queue.enqueuedBody", { count: String(result.data.added) }) });
    setDraftJobs([]);
    setQueuePreflight(null);
    void loadQueueState();
  }

  // Resuming reconciles the persisted queue after a restart and continues
  // anything still queued — loopback-gated, same as the pull queue's own
  // resume. A LAN-connected session gets a plain 403 and simply falls back to
  // the read-only GET below; it can still see the queue.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await callConverterApi(apiBase, "/api/converter/queue/resume", { method: "POST" });
      if (cancelled) return;
      await loadQueueState();
    })();
    return () => { cancelled = true; };
  }, [apiBase, loadQueueState]);

  useEffect(() => {
    if (queueSummary?.outcome !== "in-progress") return;
    const timer = setInterval(() => { void loadQueueState(); }, QUEUE_POLL_MS);
    return () => clearInterval(timer);
  }, [queueSummary?.outcome, loadQueueState]);

  async function handleQueuePause(): Promise<void> {
    const result = await callConverterApi(apiBase, "/api/converter/queue/pause", { method: "POST" });
    if (!result.ok) notify({ tone: "error", title: t("converter.queue.pauseFailedTitle"), body: result.error });
    void loadQueueState();
  }

  async function handleQueueResumeRun(): Promise<void> {
    const result = await callConverterApi(apiBase, "/api/converter/queue/resume-run", { method: "POST" });
    if (!result.ok) notify({ tone: "error", title: t("converter.queue.resumeFailedTitle"), body: result.error });
    void loadQueueState();
  }

  async function handleQueueCancelItem(id: string): Promise<void> {
    const result = await callConverterApi(apiBase, "/api/converter/queue/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    });
    if (!result.ok) notify({ tone: "error", title: t("converter.queue.cancelFailedTitle"), body: result.error });
    void loadQueueState();
  }

  async function handleQueueCancelAll(): Promise<void> {
    const result = await callConverterApi(apiBase, "/api/converter/queue/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    if (!result.ok) notify({ tone: "error", title: t("converter.queue.cancelFailedTitle"), body: result.error });
    void loadQueueState();
  }

  async function handleQueueRetryItem(id: string): Promise<void> {
    const result = await callConverterApi(apiBase, "/api/converter/queue/retry", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    });
    if (!result.ok) notify({ tone: "error", title: t("converter.queue.retryFailedTitle"), body: result.error });
    void loadQueueState();
  }

  async function handleQueueClearFinished(): Promise<void> {
    const result = await callConverterApi(apiBase, "/api/converter/queue/clear", { method: "POST" });
    if (!result.ok) notify({ tone: "error", title: t("converter.queue.clearFailedTitle"), body: result.error });
    void loadQueueState();
  }

  const queueItems = queueState?.items ?? [];
  const hasActiveQueueItems = queueItems.some(i => i.status === "queued" || i.status === "converting");
  const hasFinishedQueueItems = queueItems.some(i => i.status === "converted" || i.status === "skipped" || i.status === "cancelled" || i.status === "failed");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await callConverterApi<ConverterCatalog>(apiBase, "/api/converter/catalog");
      if (cancelled) return;
      if (!result.ok) {
        if (result.blocked) setBlocked(result.error);
        else setCatalogError(result.error);
        return;
      }
      setCatalog(result.data);
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  async function runDetect(): Promise<void> {
    const path = sourcePath.trim();
    if (!path) return;
    setDetecting(true);
    setDetectError(null);
    setDetection(null);
    // A fresh detection starts a fresh run: a stale destination, target
    // format or result from the previous source must never carry over onto
    // whatever this detection just found.
    setDestinationPath("");
    setTargetFormat("");
    setAcknowledgeLossy(false);
    setRunError(null);
    setRunSuccess(null);
    const result = await callConverterApi<DetectedSource>(apiBase, "/api/converter/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    setDetecting(false);
    if (!result.ok) {
      setDetectError(result.error);
      return;
    }
    setDetection(result.data);
  }

  const detectedFormat = useMemo(() => {
    if (!detection?.ok || !detection.formatId || !catalog) return null;
    for (const cat of catalog.categories) {
      const match = cat.formats.find(f => f.id === detection.formatId);
      if (match) return match;
    }
    return null;
  }, [detection, catalog]);

  /**
   * The target formats this source format may convert to, computed strictly
   * from the catalogue's own `operations` list (e.g. csv's `["to-json",
   * "from-json"]`) rather than a hard-coded pair — a format only offers the
   * conversions the catalogue actually advertises as bundled and enabled.
   */
  const structuredTargets = useMemo<CatalogFormat[]>(() => {
    if (!detectedFormat || detectedFormat.category !== "structured-data" || !catalog) return [];
    const structuredCategory = catalog.categories.find(c => c.id === "structured-data");
    if (!structuredCategory) return [];
    const targetIds = new Set((detectedFormat.operations ?? []).filter(op => op.startsWith("to-")).map(op => op.slice(3)));
    return structuredCategory.formats.filter(f => f.bundled && targetIds.has(f.id));
  }, [detectedFormat, catalog]);

  useEffect(() => {
    if (!structuredTargets.length) {
      if (targetFormat !== "") setTargetFormat("");
      return;
    }
    if (!structuredTargets.some(f => f.id === targetFormat)) {
      setTargetFormat(structuredTargets[0]!.id as StructuredFormatId);
      setAcknowledgeLossy(false);
    }
    // Only the available target set should re-pick a default; typing into
    // `targetFormat` itself must not be undone by this same effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetFormat is read, not reacted to
  }, [structuredTargets]);

  const targetFormatEntry = useMemo(
    () => structuredTargets.find(f => f.id === targetFormat) ?? null,
    [structuredTargets, targetFormat],
  );

  async function runExtractZip(): Promise<void> {
    const path = sourcePath.trim();
    const destination = destinationPath.trim();
    if (!path || !destination) return;
    setRunBusy(true);
    setRunError(null);
    setRunSuccess(null);
    const result = await callConverterApi<ExtractZipOutcome>(apiBase, "/api/converter/extract-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, destination }),
    });
    setRunBusy(false);
    if (!result.ok) {
      const message = result.boundary ? t("converter.result.boundary", { boundary: result.boundary, error: result.error }) : result.error;
      setRunError(message);
      notify({ tone: "error", title: t("converter.runFailedTitle"), body: message });
      return;
    }
    const summary = t("converter.extractSuccess", { count: String(result.data.entryCount ?? 0), destination });
    setRunSuccess(summary);
    notify({ tone: "success", title: t("converter.runOkTitle"), body: summary });
  }

  async function runConvertStructured(): Promise<void> {
    const path = sourcePath.trim();
    const destination = destinationPath.trim();
    const sourceFormat = detectedFormat?.id;
    if (!path || !destination || !targetFormat || !sourceFormat) return;
    if (targetFormatEntry?.lossy && !acknowledgeLossy) return;
    setRunBusy(true);
    setRunError(null);
    setRunSuccess(null);
    const result = await callConverterApi<StructuredConversionOutcome>(apiBase, "/api/converter/convert-structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The toggle above only reflects the disclosure to the user — the
      // service itself is what refuses an unacknowledged lossy conversion
      // (boundary `lossy-not-acknowledged`), so this has to actually carry
      // the acknowledgement rather than merely gate the button.
      body: JSON.stringify({ path, sourceFormat, destination, destFormat: targetFormat, acknowledgeLossy }),
    });
    setRunBusy(false);
    if (!result.ok) {
      const message = result.boundary ? t("converter.result.boundary", { boundary: result.boundary, error: result.error }) : result.error;
      setRunError(message);
      notify({ tone: "error", title: t("converter.runFailedTitle"), body: message });
      return;
    }
    const summary = t("converter.convertSuccess", { source: sourceFormat, target: targetFormat, destination });
    setRunSuccess(summary);
    notify({ tone: "success", title: t("converter.runOkTitle"), body: summary });
  }

  function updateCategorySearch(id: AdapterCategoryId, patch: Partial<CategorySearchState>): void {
    setCategorySearch(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  if (blocked) {
    return (
      <Card title={t("converter.title")} subtitle={t("converter.subtitle")}>
        <Empty title={t("converter.blockedTitle")}>{blocked}</Empty>
      </Card>
    );
  }

  return (
    <div className="m3-stack">
      <Card title={t("converter.title")} subtitle={t("converter.subtitle")}>
        <Field label={t("converter.sourceLabel")} hint={t("converter.sourceHint")} id="converter-source">
          <TextInput
            id="converter-source"
            value={sourcePath}
            onChange={e => setSourcePath(e.target.value)}
            placeholder={t("converter.sourcePlaceholder")}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <div className="m3-row">
          <Button onClick={() => void runDetect()} disabled={!sourcePath.trim() || detecting}>
            {detecting ? t("converter.detecting") : t("converter.detectAction")}
          </Button>
        </div>

        {detectError && <Banner tone="error">{detectError}</Banner>}

        {detection && (
          <div className="m3-converter-detection" role="status">
            {!detection.ok ? (
              <Banner tone="error">
                {t("converter.detectedBoundary", { boundary: detection.boundary ?? "", reason: detection.reason ?? "" })}
              </Banner>
            ) : !detection.formatId ? (
              <Banner tone="warn">{t("converter.detectedUnknown", { evidence: detection.evidence ?? "" })}</Banner>
            ) : (
              <>
                <Badge tone={detectedFormat?.bundled ? "ok" : "neutral"}>
                  {t("converter.detectedFormat", {
                    label: detectedFormat?.label ?? detection.formatId,
                    category: detection.category ? t(CATEGORY_LABEL_KEY[detection.category]) : "",
                  })}
                </Badge>
                <p className="m3-field-hint">{detection.evidence}</p>
                {detectedFormat?.bundled ? (
                  <div className="m3-row">
                    <Banner tone="success">{t("converter.enabledBanner")}</Banner>
                  </div>
                ) : (
                  <Banner tone="warn">
                    {t("converter.disabledBanner", { reason: detectedFormat?.reason ?? "" })}
                  </Banner>
                )}
                {detectedFormat?.id === "pdf" && detectedFormat.bundled && (
                  <div className="m3-row">
                    <Button onClick={() => openInPdfTools(sourcePath.trim())}>{t("converter.openInPdfTools")}</Button>
                  </div>
                )}

                {detectedFormat?.id === "zip" && detectedFormat.bundled && (
                  <div className="m3-stack">
                    <Field label={t("converter.destinationLabel")} hint={t("converter.destinationHintZip")} id="converter-destination-zip">
                      <TextInput
                        id="converter-destination-zip"
                        value={destinationPath}
                        onChange={e => setDestinationPath(e.target.value)}
                        placeholder={t("converter.destinationPlaceholderZip")}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </Field>
                    <div className="m3-row">
                      <Button onClick={() => void runExtractZip()} disabled={!destinationPath.trim() || runBusy}>
                        {runBusy ? t("converter.extracting") : t("converter.extractAction")}
                      </Button>
                    </div>
                  </div>
                )}

                {detectedFormat?.category === "structured-data" && detectedFormat.bundled && (
                  <div className="m3-stack">
                    {structuredTargets.length === 0 ? (
                      <Banner tone="warn">{t("converter.noStructuredTargets")}</Banner>
                    ) : (
                      <>
                        <Field label={t("converter.targetFormatLabel")} id="converter-target-format">
                          <SelectField
                            id="converter-target-format"
                            value={targetFormat}
                            onChange={value => { setTargetFormat(value as StructuredFormatId); setAcknowledgeLossy(false); }}
                            label={t("converter.targetFormatLabel")}
                            options={structuredTargets.map(f => ({ value: f.id, label: f.label }))}
                          />
                        </Field>
                        <Field label={t("converter.destinationLabel")} hint={t("converter.destinationHintStructured")} id="converter-destination-structured">
                          <TextInput
                            id="converter-destination-structured"
                            value={destinationPath}
                            onChange={e => setDestinationPath(e.target.value)}
                            placeholder={t("converter.destinationPlaceholderStructured")}
                            spellCheck={false}
                            autoComplete="off"
                          />
                        </Field>
                        {targetFormatEntry?.lossy && (
                          <>
                            <Banner tone="warn">{t("converter.lossyNotePrefix")}{targetFormatEntry.lossyNote}</Banner>
                            <Toggle on={acknowledgeLossy} onChange={setAcknowledgeLossy} label={t("converter.acknowledgeLossy")} />
                          </>
                        )}
                        <div className="m3-row">
                          <Button
                            onClick={() => void runConvertStructured()}
                            disabled={!destinationPath.trim() || !targetFormat || (targetFormatEntry?.lossy === true && !acknowledgeLossy) || runBusy}
                          >
                            {runBusy ? t("converter.converting") : t("converter.convertAction")}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {runError && <Banner tone="error">{runError}</Banner>}
                {runSuccess && <Banner tone="success">{runSuccess}</Banner>}
              </>
            )}
          </div>
        )}
      </Card>

      <Card title={t("converter.queue.title")} subtitle={t("converter.queue.subtitle")}>
        <div className="m3-field">
          {/* `Segmented` supplies its own `aria-label`/`role="radiogroup"` — a `Field` wrapper's `htmlFor` would target no real element, so the visible label sits beside it instead. */}
          <span className="m3-field-label">{t("converter.queue.kindLabel")}</span>
          <Segmented
            label={t("converter.queue.kindLabel")}
            value={queueDraftKind}
            onChange={setQueueDraftKind}
            options={JOB_KIND_ORDER.map(k => ({ value: k, label: t(JOB_KIND_LABEL_KEY[k]) }))}
          />
        </div>

        <Field
          label={t("converter.queue.sourceLabel")}
          hint={t("converter.sourceHint")}
          id="converter-queue-source"
        >
          <TextInput
            id="converter-queue-source"
            value={queueDraftSource}
            onChange={e => setQueueDraftSource(e.target.value)}
            placeholder={t("converter.sourcePlaceholder")}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        <Field
          label={t("converter.destinationLabel")}
          hint={queueDraftKind === "zip-extract" ? t("converter.destinationHintZip") : t("converter.queue.destinationHint")}
          id="converter-queue-dest"
        >
          <TextInput
            id="converter-queue-dest"
            value={queueDraftDest}
            onChange={e => setQueueDraftDest(e.target.value)}
            placeholder={queueDraftKind === "zip-extract" ? t("converter.destinationPlaceholderZip") : t("converter.destinationPlaceholderStructured")}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        {queueDraftKind === "structured" && (
          <div className="m3-row" style={{ flexWrap: "wrap", gap: 16 }}>
            <Field label={t("converter.queue.sourceFormatLabel")} id="converter-queue-source-format">
              <SelectField
                id="converter-queue-source-format"
                label={t("converter.queue.sourceFormatLabel")}
                value={queueDraftSourceFormat}
                onChange={v => setQueueDraftSourceFormat(v as StructuredFormatId)}
                options={ALL_STRUCTURED_FORMATS.map(f => ({ value: f, label: f.toUpperCase() }))}
              />
            </Field>
            <Field label={t("converter.targetFormatLabel")} id="converter-queue-dest-format">
              <SelectField
                id="converter-queue-dest-format"
                label={t("converter.targetFormatLabel")}
                value={queueDraftDestFormat}
                onChange={v => setQueueDraftDestFormat(v as StructuredFormatId)}
                options={ALL_STRUCTURED_FORMATS.map(f => ({ value: f, label: f.toUpperCase() }))}
              />
            </Field>
          </div>
        )}

        {queueDraftKind === "pdf-rotate" && (
          <Field label={t("converter.queue.rotateDegreesLabel")} hint={t("converter.queue.rotateDegreesHint")} id="converter-queue-rotate">
            <SelectField
              id="converter-queue-rotate"
              label={t("converter.queue.rotateDegreesLabel")}
              value={String(queueDraftRotate)}
              onChange={v => setQueueDraftRotate(Number(v) as RotateDegreesId)}
              options={ROTATE_DEGREES_OPTIONS.map(d => ({ value: String(d), label: `${d}°` }))}
            />
          </Field>
        )}

        {(queueDraftKind === "structured" || queueDraftKind === "pdf-rotate") && (
          <Toggle
            on={queueDraftAcknowledge}
            onChange={setQueueDraftAcknowledge}
            label={queueDraftKind === "structured" ? t("converter.queue.acknowledgeLossyLabel") : t("converter.queue.acknowledgeSignedLabel")}
          />
        )}

        <Toggle on={queueDraftOverwrite} onChange={setQueueDraftOverwrite} label={t("converter.queue.overwriteLabel")} />
        {queueDraftKind === "zip-extract" && queueDraftOverwrite && (
          <p className="m3-field-hint">{t("converter.queue.zipOverwriteNote")}</p>
        )}

        <div className="m3-row" style={{ marginTop: 8 }}>
          <Button variant="outlined" onClick={addDraftJob} disabled={!queueDraftSource.trim() || !queueDraftDest.trim()}>
            <IconPlus width={16} height={16} /> {t("converter.queue.addToBatch")}
          </Button>
        </div>

        {draftJobs.length > 0 && (
          <div style={TABLE_WRAP}>
            <table className="m3-table">
              <thead>
                <tr>
                  <th>{t("converter.queue.col.kind")}</th>
                  <th>{t("converter.queue.col.source")}</th>
                  <th>{t("converter.queue.col.destination")}</th>
                  <th><span className="sr-only">{t("converter.queue.col.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {draftJobs.map(j => (
                  <tr key={j.clientId}>
                    <td>
                      <Badge>{t(JOB_KIND_LABEL_KEY[j.kind])}</Badge>
                      <div className="m3-field-hint">{jobKindDetail(j, t)}</div>
                    </td>
                    <td>{j.sourcePath}</td>
                    <td>{j.destPath}</td>
                    <td>
                      <Button variant="text" onClick={() => removeDraftJob(j.clientId)} aria-label={t("converter.queue.removeDraft")}>
                        <IconTrash width={16} height={16} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {draftJobs.length > 0 && (
          <>
            <Slider
              id="converter-queue-concurrency"
              label={t("converter.queue.concurrencyLabel")}
              min={1}
              max={8}
              value={queueConcurrency}
              onChange={setQueueConcurrency}
              valueLabel={String(queueConcurrency)}
            />

            <div className="m3-row" style={{ gap: 8, marginTop: 8 }}>
              <Button variant="outlined" onClick={() => void handleQueuePreflight()} disabled={queuePreflighting}>
                {queuePreflighting ? t("converter.queue.previewing") : t("converter.queue.preview")}
              </Button>
              <Button variant="filled" onClick={() => void handleQueueEnqueue()} disabled={queueEnqueuing}>
                {queueEnqueuing ? t("converter.queue.enqueuing") : t("converter.queue.enqueueAction")}
              </Button>
            </div>

            {queuePreflight && (
              <div className="m3-stack" style={{ marginTop: 8 }}>
                <p className="m3-field-hint">{queuePreflight.disclosure}</p>
                <div className="m3-row" style={{ flexWrap: "wrap", gap: 12 }}>
                  <Badge tone={queuePreflight.aggregateSizeFullyKnown ? "neutral" : "warn"}>
                    {queuePreflight.aggregateSizeFullyKnown
                      ? t("converter.queue.aggregateKnown", { size: formatBytes(queuePreflight.aggregateEstimatedBytes, locale) })
                      : t("converter.queue.aggregatePartial", { size: formatBytes(queuePreflight.aggregateEstimatedBytes, locale) })}
                  </Badge>
                  {queuePreflight.insufficientDiskSpace && (
                    <Badge tone="error">{t("converter.queue.insufficientSpace")}</Badge>
                  )}
                </div>
                <div style={TABLE_WRAP}>
                  <table className="m3-table">
                    <thead>
                      <tr>
                        <th>{t("converter.queue.col.directory")}</th>
                        <th>{t("converter.queue.col.free")}</th>
                        <th>{t("converter.queue.col.needed")}</th>
                        <th>{t("converter.queue.col.sufficient")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {queuePreflight.groups.map(g => (
                        <tr key={g.directory}>
                          <td>{g.directory}</td>
                          <td>{g.freeDiskBytes != null ? formatBytes(g.freeDiskBytes, locale) : t("converter.queue.unknown")}</td>
                          <td>{formatBytes(g.estimatedBytesNeeded, locale)}</td>
                          <td>
                            {g.sufficient === null ? (
                              <Badge tone="warn">{t("converter.queue.unknown")}</Badge>
                            ) : g.sufficient ? (
                              <Badge tone="ok">{t("converter.queue.sufficientYes")}</Badge>
                            ) : (
                              <Badge tone="error">{t("converter.queue.sufficientNo")}</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {queueItems.length > 0 && queueSummary && (
        <Card
          title={t("converter.queue.liveTitle")}
          subtitle={t("converter.queue.liveSummary", {
            converted: String(queueSummary.converted),
            skipped: String(queueSummary.skipped),
            failed: String(queueSummary.failed),
            cancelled: String(queueSummary.cancelled),
            active: String(queueSummary.queued + queueSummary.converting),
          })}
          actions={
            <div className="m3-row" style={{ gap: 8 }}>
              {queueState?.paused ? (
                <Button variant="text" onClick={() => void handleQueueResumeRun()}>
                  <IconPlay width={16} height={16} /> {t("converter.queue.resumeAction")}
                </Button>
              ) : (
                <Button variant="text" onClick={() => void handleQueuePause()} disabled={!hasActiveQueueItems}>
                  <IconPause width={16} height={16} /> {t("converter.queue.pauseAction")}
                </Button>
              )}
              <Button variant="text" onClick={() => void handleQueueCancelAll()} disabled={!hasActiveQueueItems}>
                <IconX width={16} height={16} /> {t("converter.queue.cancelAll")}
              </Button>
              <Button variant="text" onClick={() => void handleQueueClearFinished()} disabled={!hasFinishedQueueItems}>
                <IconSweep width={16} height={16} /> {t("converter.queue.clearFinished")}
              </Button>
            </div>
          }
        >
          {queueState?.paused && <Banner tone="warn">{t("converter.queue.pausedBanner")}</Banner>}
          {queueSummary.outcome === "complete-partial" && <Banner tone="warn">{t("converter.queue.partialBanner")}</Banner>}
          <div style={TABLE_WRAP}>
            <table className="m3-table">
              <thead>
                <tr>
                  <th>{t("converter.queue.col.kind")}</th>
                  <th>{t("converter.queue.col.source")}</th>
                  <th>{t("converter.queue.col.destination")}</th>
                  <th>{t("converter.queue.col.status")}</th>
                  <th>{t("converter.queue.col.details")}</th>
                  <th><span className="sr-only">{t("converter.queue.col.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {queueItems.map(item => (
                  <tr key={item.id}>
                    <td>
                      <Badge>{t(JOB_KIND_LABEL_KEY[item.kind])}</Badge>
                      <div className="m3-field-hint">{jobKindDetail(item, t)}</div>
                    </td>
                    <td>{item.sourcePath}</td>
                    <td>{item.destPath}</td>
                    <td><Badge tone={QUEUE_STATUS_TONE[item.status]}>{t(QUEUE_STATUS_LABEL_KEY[item.status])}</Badge></td>
                    <td><QueueJobDetail item={item} t={t} /></td>
                    <td>
                      {(item.status === "queued" || item.status === "converting") && (
                        <Button variant="text" onClick={() => void handleQueueCancelItem(item.id)}>
                          <IconX width={16} height={16} /> {t("converter.queue.cancel")}
                        </Button>
                      )}
                      {(item.status === "failed" || item.status === "cancelled") && (
                        <Button variant="text" onClick={() => void handleQueueRetryItem(item.id)}>
                          <IconRestartAlt width={16} height={16} /> {t("converter.queue.retry")}
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

      {catalogError && (
        <Card title={t("converter.catalogTitle")}>
          <Banner tone="error">{catalogError}</Banner>
        </Card>
      )}

      {catalog && (
        <Card title={t("converter.catalogTitle")} subtitle={t("converter.catalogSubtitle", { enabled: String(catalog.enabledFormats), total: String(catalog.totalFormats) })}>
          <p className="m3-field-hint">{t("converter.scopeNote")}</p>
        </Card>
      )}

      {catalog && CATEGORY_ORDER.map(id => {
        const category = catalog.categories.find(c => c.id === id);
        if (!category) return null;
        const Icon = CATEGORY_ICON[id];
        const search = categorySearch[id];
        const matcher = settingsMatcher(search.query, search.regex, search.flags);
        const rowText = (f: CatalogFormat) =>
          [f.label, f.id, f.extensions.join(" "), f.bundled ? "bundled enabled" : `disabled ${f.reason ?? ""}`].join(" ");
        const filtered = category.formats.filter(f => matcher.test(rowText(f)));
        const sample = category.formats.map(rowText).slice(0, 20).join("\n");
        const categoryLabel = t(CATEGORY_LABEL_KEY[id]);

        return (
          <Card
            key={id}
            title={(
              <span className="m3-row" style={{ gap: 8, alignItems: "center" }}>
                <Icon aria-hidden="true" focusable="false" style={{ width: 20, height: 20 }} />
                {categoryLabel}
              </span>
            )}
          >
            <SearchField
              id={`converter-search-${id}`}
              value={search.query}
              onChange={q => updateCategorySearch(id, { query: q })}
              searchLabel={t("converter.categorySearchLabel", { category: categoryLabel })}
              placeholder={t("converter.categorySearchLabel", { category: categoryLabel })}
              regex={search.regex}
              onRegexChange={r => updateCategorySearch(id, { regex: r })}
              flags={search.flags}
              onApply={(pattern, flags) => updateCategorySearch(id, { query: pattern, flags })}
              sample={sample}
            />
            {matcher.error && <p className="m3-field-hint" role="alert">{matcher.error}</p>}
            {filtered.length === 0 ? (
              <Empty title={t("converter.emptyCategory")} />
            ) : (
              <ul className="m3-converter-format-list">
                {filtered.map(f => (
                  <li key={f.id} className="m3-converter-format-row">
                    <span className="m3-converter-format-label">{f.label}</span>
                    {f.extensions.length > 0 && (
                      <span className="m3-field-hint">{f.extensions.map(ext => `.${ext}`).join(", ")}</span>
                    )}
                    {f.bundled ? (
                      <Badge tone="ok">{t("converter.status.enabled")}</Badge>
                    ) : (
                      <Badge tone="neutral">{t("converter.status.disabled")}</Badge>
                    )}
                    {f.operations && (
                      <p className="m3-field-hint">{t("converter.formatRow.operations", { ops: f.operations.join(", ") })}</p>
                    )}
                    {!f.bundled && f.reason && (
                      <p className="m3-field-hint">{t("converter.status.reasonPrefix")}{f.reason}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}
