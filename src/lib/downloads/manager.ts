/**
 * The download-capture manager: the one place that owns the in-memory
 * `DownloadRecord` list, starts and stops real transfers, and persists state
 * transitions to `downloads.json` (`store.ts`).
 *
 * `captureDownload` is the extension's entry point — it only ever creates a
 * `queued` record, never writes a byte. `confirmDownload` is the Start-download
 * dialog's Confirm button: the one and only path into `downloading`, which is
 * what makes that dialog a real decision surface rather than a preview.
 *
 * The transfer itself (`runTransfer`) is real network I/O to a real file on
 * disk: `fetch()` against the captured URL, streamed chunk-by-chunk through a
 * Node write stream, with an `AbortController` per in-flight download so pause
 * and cancel actually stop the socket rather than merely relabelling a row.
 *
 * Test seam: `setFetchImplForTests`/`setNowForTests` let tests substitute a
 * deterministic clock and, where a real loopback HTTP server is overkill,
 * a scripted `fetch`. Most tests in `tests/downloads-manager.test.ts` prefer a
 * real `Bun.serve` server over a mock — the whole point of this module is that
 * bytes actually move, and a mock cannot lie about that the way a mismatched
 * assumption about `fetch()` semantics could.
 */
import { createWriteStream, existsSync, unlinkSync } from "node:fs";
import { renameAtomicFile } from "../../config";
import {
  ALLOWED_DOWNLOAD_PROTOCOLS,
  MAX_MIME_TYPE_LENGTH,
  MAX_PAGE_URL_LENGTH,
  MAX_URL_LENGTH,
  PROGRESS_SAMPLE_INTERVAL_MS,
} from "./bounds";
import { defaultDownloadsDir, sanitizeFilename, uniqueDestinationPath } from "./paths";
import { loadDownloadStore, saveDownloadStore } from "./store";
import {
  CaptureRejectedError,
  DownloadNotFoundError,
  DownloadStateError,
  type CaptureRequest,
  type ConfirmOptions,
  type DownloadRecord,
  type DownloadState,
} from "./types";

type FetchImpl = typeof fetch;
let _fetchImpl: FetchImpl = fetch;
/** Test-only: substitute `fetch` (a scripted response, a forced network error). Pass `null` to restore the real one. */
export function setFetchImplForTests(impl: FetchImpl | null): void {
  _fetchImpl = impl ?? fetch;
}

let _now: () => number = () => Date.now();
/** Test-only: a controllable clock so rate/ETA math is asserted against exact numbers rather than "roughly". */
export function setNowForTests(fn: (() => number) | null): void {
  _now = fn ?? (() => Date.now());
}

let _records: Map<string, DownloadRecord> | null = null;
const _controllers = new Map<string, AbortController>();

function ensureLoaded(): Map<string, DownloadRecord> {
  if (_records) return _records;
  _records = new Map(loadDownloadStore().map(r => [r.id, r]));
  return _records;
}

/** Test-only: drop everything in memory and re-read `downloads.json` on the next call. */
export function resetDownloadManagerForTests(): void {
  _records = null;
  _controllers.clear();
}

function persist(): Promise<void> {
  return saveDownloadStore(Array.from(ensureLoaded().values()));
}

function touch(record: DownloadRecord): DownloadRecord {
  record.updatedAt = _now();
  return record;
}

function requireRecord(id: string): DownloadRecord {
  const record = ensureLoaded().get(id);
  if (!record) throw new DownloadNotFoundError(id);
  return record;
}

export function listDownloads(): DownloadRecord[] {
  return Array.from(ensureLoaded().values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getDownload(id: string): DownloadRecord | undefined {
  return ensureLoaded().get(id);
}

/**
 * Create a `queued` record from a captured URL. Refuses outright — no record,
 * nothing on disk — rather than queuing something that can never legitimately
 * become a download: a non-http(s) URL is the one way a "download capture"
 * endpoint could otherwise be turned into a local-file or internal-service
 * fetch primitive.
 */
export async function captureDownload(request: CaptureRequest): Promise<DownloadRecord> {
  const trimmedUrl = (request.url ?? "").trim();
  if (!trimmedUrl) throw new CaptureRejectedError("invalid-url", "url is required");
  if (trimmedUrl.length > MAX_URL_LENGTH) throw new CaptureRejectedError("url-too-long", `url exceeds ${MAX_URL_LENGTH} characters`);
  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    throw new CaptureRejectedError("invalid-url", "url could not be parsed");
  }
  if (!ALLOWED_DOWNLOAD_PROTOCOLS.has(parsed.protocol)) {
    throw new CaptureRejectedError("unsupported-protocol", `"${parsed.protocol}" downloads are refused; only http/https are captured`);
  }

  const guessedName = request.suggestedFilename?.trim() || decodeURIComponent(parsed.pathname.split("/").pop() || "") || "download";
  const now = _now();
  const record: DownloadRecord = {
    id: crypto.randomUUID(),
    url: parsed.toString(),
    suggestedFilename: sanitizeFilename(guessedName),
    pageUrl: request.pageUrl?.trim().slice(0, MAX_PAGE_URL_LENGTH) || null,
    mimeType: request.mimeType?.trim().slice(0, MAX_MIME_TYPE_LENGTH) || null,
    source: request.source ?? "extension",
    state: "queued",
    destinationPath: null,
    bytesReceived: 0,
    bytesTotal: null,
    rateBytesPerSec: null,
    etaSeconds: null,
    resumable: false,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    error: null,
  };
  ensureLoaded().set(record.id, record);
  await persist();
  return record;
}

function assertState(record: DownloadRecord, allowed: DownloadState[]): void {
  if (!allowed.includes(record.state)) {
    throw new DownloadStateError(record.id, record.state, `Cannot do this from state "${record.state}" (expected one of ${allowed.join(", ")})`);
  }
}

/** The Start-download dialog's Confirm action: the only path from `queued` (or a paused resume) into real bytes moving. */
export async function confirmDownload(id: string, options: ConfirmOptions = {}): Promise<DownloadRecord> {
  const record = requireRecord(id);
  assertState(record, ["queued"]);
  const dir = options.destinationDir?.trim() || defaultDownloadsDir();
  const filename = sanitizeFilename(options.filename?.trim() || record.suggestedFilename);
  record.destinationPath = uniqueDestinationPath(dir, filename);
  record.state = "downloading";
  record.startedAt = _now();
  touch(record);
  await persist();
  void runTransfer(record, { resume: false });
  return record;
}

export async function cancelDownload(id: string): Promise<DownloadRecord> {
  const record = requireRecord(id);
  if (record.state === "queued") {
    record.state = "canceled";
    touch(record);
    await persist();
    return record;
  }
  assertState(record, ["downloading", "paused"]);
  // Set state and abort BEFORE persisting: `runTransfer`'s own catch block
  // sees `AbortError` and returns without touching the record further, so
  // this call — not the in-flight transfer — is what makes the cancellation
  // durable for a caller that polls `GET /api/downloads/:id` immediately
  // after this returns.
  record.state = "canceled";
  touch(record);
  _controllers.get(id)?.abort();
  _controllers.delete(id);
  if (record.destinationPath && existsSync(tempPathFor(record.destinationPath))) {
    try { unlinkSync(tempPathFor(record.destinationPath)); } catch { /* best-effort cleanup */ }
  }
  await persist();
  return record;
}

export async function pauseDownload(id: string): Promise<DownloadRecord> {
  const record = requireRecord(id);
  assertState(record, ["downloading"]);
  record.state = "paused";
  touch(record);
  _controllers.get(id)?.abort();
  _controllers.delete(id);
  await persist();
  return record;
}

/**
 * Resume a paused transfer. If a prior probe recorded `resumable`, this sends
 * `Range: bytes=<received>-` and appends; otherwise it restarts from zero and
 * says so rather than silently duplicating a partial file — this is named
 * honestly in the record rather than assumed, per the contract's own "either
 * genuinely resumes or restarts and states which".
 */
export async function resumeDownload(id: string): Promise<DownloadRecord> {
  const record = requireRecord(id);
  assertState(record, ["paused"]);
  record.state = "downloading";
  touch(record);
  await persist();
  void runTransfer(record, { resume: record.resumable });
  return record;
}

export async function removeDownload(id: string): Promise<void> {
  const record = requireRecord(id);
  if (record.state === "downloading" || record.state === "paused") {
    throw new DownloadStateError(id, record.state, "Cancel an active download before removing it from history");
  }
  ensureLoaded().delete(id);
  await persist();
}

function tempPathFor(destinationPath: string): string {
  return `${destinationPath}.ocxdl.tmp`;
}

interface TransferOptions {
  resume: boolean;
}

async function runTransfer(record: DownloadRecord, { resume }: TransferOptions): Promise<void> {
  const controller = new AbortController();
  _controllers.set(record.id, controller);
  const destination = record.destinationPath!;
  const temp = tempPathFor(destination);

  let lastSampleAt = _now();
  let lastSampleBytes = record.bytesReceived;

  try {
    const headers: Record<string, string> = {};
    if (resume && record.bytesReceived > 0) headers.Range = `bytes=${record.bytesReceived}-`;
    const response = await _fetchImpl(record.url, { signal: controller.signal, headers });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Server responded ${response.status} ${response.statusText}`.trim());
    }

    // Whether THIS attempt is appending onto bytes already on disk, decided by
    // the response actually received rather than by what was asked for: a
    // resume request can still come back 200 (server ignored the Range
    // header), which must restart the file and its counters from zero rather
    // than write the new body on top of the old byte count.
    const append = resume && response.status === 206;
    if (!append) {
      record.bytesReceived = 0;
      lastSampleBytes = 0;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && !Number.isNaN(Number(contentLength))) {
      const remaining = Number(contentLength);
      record.bytesTotal = append ? record.bytesReceived + remaining : remaining;
    }
    record.resumable = response.headers.get("accept-ranges") === "bytes" || response.status === 206;

    if (!response.body) throw new Error("Server response had no body to stream");

    const out = createWriteStream(temp, { flags: append ? "a" : "w" });
    const writeChunk = (chunk: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
      out.write(chunk, err => { if (err) reject(err); else resolve(); });
    });

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        await writeChunk(value);
        record.bytesReceived += value.byteLength;
        const now = _now();
        if (now - lastSampleAt >= PROGRESS_SAMPLE_INTERVAL_MS) {
          const elapsedSec = (now - lastSampleAt) / 1000;
          record.rateBytesPerSec = elapsedSec > 0 ? (record.bytesReceived - lastSampleBytes) / elapsedSec : null;
          record.etaSeconds = record.rateBytesPerSec && record.bytesTotal
            ? Math.max(0, (record.bytesTotal - record.bytesReceived) / record.rateBytesPerSec)
            : null;
          lastSampleAt = now;
          lastSampleBytes = record.bytesReceived;
          touch(record);
        }
      }
    } finally {
      await new Promise<void>(resolve => out.end(resolve));
    }

    renameAtomicFile(temp, destination);
    record.state = "completed";
    record.completedAt = _now();
    record.rateBytesPerSec = null;
    record.etaSeconds = null;
    touch(record);
    await persist();
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    if (aborted) {
      // Pause and cancel both abort deliberately and have already set the
      // record's state themselves — cancel additionally cleans up the temp
      // file. Nothing further to report here.
      return;
    }
    record.state = "error";
    record.error = err instanceof Error ? err.message : String(err);
    touch(record);
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best-effort */ }
    await persist();
  } finally {
    _controllers.delete(record.id);
  }
}
