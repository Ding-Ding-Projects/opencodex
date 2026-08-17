/**
 * Shared types for the local model-runtime (Ollama) suite manager.
 *
 * Every shape here is derived only from Ollama's documented local HTTP API
 * (https://github.com/ollama/ollama/blob/main/docs/api.md: `/`, `/api/version`,
 * `/api/tags`, `/api/ps`, `/api/show`, `/api/delete`) plus best-effort local
 * hardware detection. Nothing here represents data from an unofficial proxy or
 * an embedded cloud service — see `catalog.ts`'s header for the explicit
 * scoping decision about what "catalogue" means in this module.
 */

/**
 * `healthy`   — the daemon answered `/` and `/api/version` correctly.
 * `missing`   — the daemon refused the connection AND no `ollama` executable
 *               was found on this machine (a real check, never a guess).
 * `stopped`   — the daemon refused the connection but an executable was found
 *               (or its presence could not be determined either way).
 * `unhealthy` — the daemon accepted the connection but did not answer
 *               correctly in time, or answered with something unparsable.
 * `offline`   — a network-level failure occurred that was neither a clean
 *               refusal nor a timeout (DNS failure, socket reset, etc.).
 */
export type OllamaHealthState = "healthy" | "missing" | "stopped" | "unhealthy" | "offline";

export interface OllamaHealthResult {
  state: OllamaHealthState;
  baseUrl: string;
  version: string | null;
  detail: string;
  /** Set when a configured OLLAMA_HOST was rejected as non-local and the default was used instead. */
  hostWarning: string | null;
  checkedAt: number;
}

export interface OllamaModelDetails {
  format: string | null;
  family: string | null;
  families: string[] | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
}

export interface OllamaTagEntry {
  name: string;
  model: string;
  modifiedAt: string | null;
  sizeBytes: number | null;
  digest: string | null;
  details: OllamaModelDetails;
}

export interface OllamaRunningEntry {
  name: string;
  model: string;
  sizeBytes: number | null;
  sizeVramBytes: number | null;
  expiresAt: string | null;
}

export interface OllamaShowInfo {
  ok: boolean;
  error: string | null;
  capabilities: string[] | null;
  parameterCount: number | null;
  contextLength: number | null;
  quantizationLevel: string | null;
  family: string | null;
  families: string[] | null;
  license: string | null;
}

export type FitVerdict = "runs-well" | "runs-with-limits" | "unlikely" | "unknown";

export interface FitResult {
  verdict: FitVerdict;
  evidence: string[];
  computedAt: number;
}

export interface ModelFitInput {
  sizeBytes: number | null;
  parameterCountBillions: number | null;
  quantizationLevel: string | null;
  contextLength: number | null;
}

export interface GpuFact {
  name: string;
  vramBytes: number | null;
  source: "nvidia-smi" | "windows-wmi" | "unknown";
  caveats: string[];
}

export interface HardwareFacts {
  detectedAt: number;
  platform: string;
  totalRamBytes: number | null;
  freeRamBytes: number | null;
  gpus: GpuFact[];
  freeDiskBytes: number | null;
  diskPath: string | null;
  warnings: string[];
}

/** One entry in the exhaustive local catalogue: an installed tag, fully detailed. */
export interface CatalogEntry {
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

export type CompletenessVerdict = "complete" | "partial" | "unavailable";

export interface CatalogResult {
  entries: CatalogEntry[];
  refreshedAt: number;
  /** The Ollama server's own reported version — the closest thing this local-only catalogue has to a source revision. */
  sourceRevision: string | null;
  /** Always 1 against today's `/api/tags` (it does not paginate), modelled explicitly so a future paginated response is not silently truncated. */
  pageCount: number;
  completeness: { verdict: CompletenessVerdict; detail: string };
  hardware: HardwareFacts;
}
