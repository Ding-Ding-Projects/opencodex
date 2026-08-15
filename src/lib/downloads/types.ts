/**
 * Shared shapes for the browser-extension download-capture feature.
 *
 * A capture starts life as `queued` — the extension handed opencodex a URL and
 * nothing has been written to disk yet. `confirmDownload` is the only path from
 * `queued` into `downloading`, which is what makes the Start-download dialog a
 * real decision surface rather than a preview: nothing downloads until the user
 * (or an explicit `--yes` on the CLI) says so.
 */

export type DownloadState =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "canceled"
  | "error";

/** States a still-in-flight transfer can be aborted from. */
export const ACTIVE_STATES: readonly DownloadState[] = ["queued", "downloading", "paused"];

/** States that will never change again — the ones the history list groups as "finished". */
export const TERMINAL_STATES: readonly DownloadState[] = ["completed", "canceled", "error"];

export type DownloadSource = "extension" | "manual";

export interface DownloadRecord {
  id: string;
  url: string;
  /** The name the extension (or a manual capture) suggested — sanitized, not yet unique-checked. */
  suggestedFilename: string;
  /** The page the download link was clicked from, when the extension could report one. */
  pageUrl: string | null;
  mimeType: string | null;
  source: DownloadSource;
  state: DownloadState;
  /** Absolute path once a destination has been chosen (set at confirm time). */
  destinationPath: string | null;
  bytesReceived: number;
  /** `null` until a `Content-Length` (or equivalent) is known. */
  bytesTotal: number | null;
  /** `null` until the transfer has produced at least two samples to derive a rate from. */
  rateBytesPerSec: number | null;
  /** `null` whenever the rate or the total is unknown. */
  etaSeconds: number | null;
  /** True once a HEAD/range probe has confirmed the server honours `Range` — resume continues instead of restarting. */
  resumable: boolean;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  /** Present only in state `error`; a plain sentence, never a stack trace. */
  error: string | null;
}

export interface CaptureRequest {
  url: string;
  suggestedFilename?: string;
  pageUrl?: string;
  mimeType?: string;
  source?: DownloadSource;
}

export interface ConfirmOptions {
  /** Overrides the extension's suggested name; still sanitized and de-duplicated. */
  filename?: string;
  /** Overrides the default Downloads directory; must already exist or be creatable. */
  destinationDir?: string;
}

/** The reasons `captureDownload` refuses a request outright — before anything is queued. */
export type CaptureRejectionReason =
  | "invalid-url"
  | "unsupported-protocol"
  | "url-too-long"
  | "queue-full";

export class CaptureRejectedError extends Error {
  constructor(readonly reason: CaptureRejectionReason, message: string) {
    super(message);
    this.name = "CaptureRejectedError";
  }
}

export class DownloadNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`No download record with id "${id}"`);
    this.name = "DownloadNotFoundError";
  }
}

export class DownloadStateError extends Error {
  constructor(readonly id: string, readonly state: DownloadState, message: string) {
    super(message);
    this.name = "DownloadStateError";
  }
}
