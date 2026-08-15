/**
 * Conservative, evidence-backed hardware-fit verdicts.
 *
 * This is deliberately NOT a promise that a model will run — it is a
 * best-effort estimate from real, detected numbers (`hardware.ts`) plus the
 * model's own reported size (`client.ts`). Every branch appends a plain-
 * language reason to `evidence` so the verdict can be checked, not just
 * trusted, and every missing input pushes the verdict toward `unknown`
 * rather than assuming the best (or the worst).
 *
 * The arithmetic is intentionally simple and its constants are named and
 * documented rather than tuned to match any specific benchmark — see each
 * comment below for exactly what is being approximated and why.
 */

import type { FitResult, HardwareFacts, ModelFitInput } from "./types";

/** Headroom added on top of raw model-weight bytes for KV-cache/context — an approximation, not a measurement. */
const CONTEXT_OVERHEAD_FACTOR = 1.2;
/** Fraction of a GPU's video memory considered "comfortable" before verdict caps below runs-well. */
const GPU_COMFORTABLE_FRACTION = 0.9;
/** Fraction of a GPU's video memory beyond which even partial offload is not credited. */
const GPU_PARTIAL_OFFLOAD_FRACTION = 1.3;
/** Fraction of total system RAM considered comfortable for CPU-only execution of a small model. */
const CPU_SMALL_MODEL_RAM_FRACTION = 0.5;
/** Fraction of total system RAM beyond which even a limited CPU-only run is not credited. */
const CPU_RAM_LIMIT_FRACTION = 0.85;
/** Parameter count (billions) at or below which CPU-only execution can still be called "runs well". */
const CPU_SMALL_MODEL_PARAMS_BILLIONS = 3;
/** Free-disk floor below which low headroom is called out regardless of the memory verdict. */
const LOW_DISK_FLOOR_BYTES = 2 * 1024 ** 3;

function humanBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function computeFitVerdict(hardware: HardwareFacts, model: ModelFitInput): FitResult {
  const computedAt = Date.now();
  const evidence: string[] = [];

  if (model.sizeBytes == null) {
    return { verdict: "unknown", evidence: ["this model reports no size from the runtime, so no fit estimate is possible"], computedAt };
  }

  const bestGpu = [...hardware.gpus]
    .filter(g => g.vramBytes != null)
    .sort((a, b) => (b.vramBytes ?? 0) - (a.vramBytes ?? 0))[0];

  if (hardware.totalRamBytes == null && !bestGpu) {
    return { verdict: "unknown", evidence: ["no usable memory information (system RAM or GPU video memory) was detected on this machine"], computedAt };
  }

  const required = Math.round(model.sizeBytes * CONTEXT_OVERHEAD_FACTOR);
  evidence.push(`estimated memory need: ${humanBytes(required)} (model weights ${humanBytes(model.sizeBytes)} plus ~${Math.round((CONTEXT_OVERHEAD_FACTOR - 1) * 100)}% for context)`);

  if (bestGpu) {
    evidence.push(`GPU detected: ${bestGpu.name} with ${bestGpu.vramBytes != null ? humanBytes(bestGpu.vramBytes) : "unknown"} video memory (source: ${bestGpu.source})`);
    evidence.push(...bestGpu.caveats);
  } else {
    evidence.push("no GPU with known video memory was detected; this estimate assumes CPU-only execution");
  }

  let verdict: FitResult["verdict"];

  if (bestGpu?.vramBytes != null && bestGpu.vramBytes * GPU_COMFORTABLE_FRACTION >= required) {
    verdict = "runs-well";
    evidence.push("fits comfortably within the GPU's video memory, with headroom for context");
  } else if (bestGpu?.vramBytes != null && bestGpu.vramBytes * GPU_PARTIAL_OFFLOAD_FRACTION >= required) {
    verdict = "runs-with-limits";
    evidence.push("close to the GPU's video memory limit; expect partial CPU offload and slower generation");
  } else if (
    hardware.totalRamBytes != null
    && model.parameterCountBillions != null
    && model.parameterCountBillions <= CPU_SMALL_MODEL_PARAMS_BILLIONS
    && hardware.totalRamBytes * CPU_SMALL_MODEL_RAM_FRACTION >= required
  ) {
    verdict = "runs-well";
    evidence.push(`small enough (${model.parameterCountBillions}B parameters) to run comfortably on CPU alone within system memory`);
  } else if (hardware.totalRamBytes != null && hardware.totalRamBytes * CPU_RAM_LIMIT_FRACTION >= required) {
    verdict = "runs-with-limits";
    evidence.push(bestGpu
      ? "exceeds the GPU's video memory; falls back mostly to CPU and system memory, which will be slower"
      : "fits within system memory, but CPU-only generation for a model this size is typically slow");
  } else if (hardware.totalRamBytes != null) {
    verdict = "unlikely";
    evidence.push(`estimated need exceeds available system memory (${humanBytes(hardware.totalRamBytes)} total)`);
  } else {
    verdict = "unknown";
    evidence.push("the GPU's video memory is insufficient or unknown, and system memory could not be detected");
  }

  if (hardware.freeDiskBytes != null && hardware.freeDiskBytes < LOW_DISK_FLOOR_BYTES) {
    evidence.push(`free disk space is low (${humanBytes(hardware.freeDiskBytes)}); this can force the operating system to page and slow generation further`);
    if (verdict === "runs-well") verdict = "runs-with-limits";
  }

  return { verdict, evidence, computedAt };
}

/** Parses Ollama's free-text `parameter_size` ("8.0B", "410M") into billions, or null when it does not parse. */
export function parseParameterCountBillions(parameterSize: string | null): number | null {
  if (!parameterSize) return null;
  const match = /^([\d.]+)\s*([BMK])$/i.exec(parameterSize.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toUpperCase();
  if (unit === "B") return value;
  if (unit === "M") return value / 1000;
  if (unit === "K") return value / 1_000_000;
  return null;
}
