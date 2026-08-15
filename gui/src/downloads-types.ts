/**
 * Mirrors `src/lib/downloads/types.ts`'s `DownloadRecord`/`DownloadState`.
 *
 * Duplicated on purpose rather than imported, the same way `Ollama.tsx` and
 * `Converter.tsx` declare their own local copies of the server's response
 * shapes: the `gui/` workspace builds independently of `src/`, and every other
 * page in this codebase already draws this same boundary rather than reaching
 * across it.
 */

export type DownloadState = "queued" | "downloading" | "paused" | "completed" | "canceled" | "error";

export type DownloadSource = "extension" | "manual";

export interface DownloadRecord {
  id: string;
  url: string;
  suggestedFilename: string;
  pageUrl: string | null;
  mimeType: string | null;
  source: DownloadSource;
  state: DownloadState;
  destinationPath: string | null;
  bytesReceived: number;
  bytesTotal: number | null;
  rateBytesPerSec: number | null;
  etaSeconds: number | null;
  resumable: boolean;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
}
