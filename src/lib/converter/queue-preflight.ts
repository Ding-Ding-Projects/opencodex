/**
 * Storage-capacity preflight for the converter batch queue.
 *
 * Same idea as `src/lib/model-runtime/pull-preflight.ts` — a disclosure
 * computed from real, already-known facts before a batch is admitted — but
 * this one can do better than the model-pull preflight: a conversion job's
 * *source* file is already sitting on disk, so its exact byte size is a real
 * measurement, not a guess. What is still unknown is the *output* size (a
 * format change can grow or shrink the byte count — pretty-printed JSON is
 * bigger than compact CSV, for instance), so that half stays an explicit,
 * documented, conservative estimate rather than a claimed fact.
 *
 * `queue-engine.ts`'s `enqueueConvertJobs` calls this before admitting a page
 * of jobs into the durable queue and refuses the page when a *definite*
 * reading shows insufficient space — never on an unknown reading, matching
 * `hardware.ts`'s own rule that a missing fact must never be treated as zero
 * or as a refusal.
 */

import { dirname } from "node:path";
import { detectFreeDiskBytes } from "../model-runtime/hardware";

/**
 * Headroom over a source file's real size: not a measurement of the actual
 * output (which is only known once the conversion runs), but a documented,
 * conservative margin wide enough to cover the worst common case this
 * converter family produces — pretty-printed JSON growing well past a
 * compact CSV/TSV/XML source.
 */
export const ESTIMATED_OUTPUT_HEADROOM_FACTOR = 2;

export interface ConvertPreflightItem {
  destPath: string;
  sourceBytes: number | null;
  /** `sourceBytes * ESTIMATED_OUTPUT_HEADROOM_FACTOR`, or `null` when the source's size is not known. */
  estimatedOutputBytes: number | null;
}

export interface ConvertDiskGroup {
  /** The directory actually probed for free space — one entry per unique destination directory in the batch, so a batch writing many files into one folder probes that folder once. */
  directory: string;
  freeDiskBytes: number | null;
  estimatedBytesNeeded: number;
  /** `null` when `freeDiskBytes` could not be determined on this platform — an unknown fact is never treated as a refusal. */
  sufficient: boolean | null;
}

export interface ConvertQueuePreflight {
  items: ConvertPreflightItem[];
  aggregateEstimatedBytes: number;
  /** `true` only when every item's source size was known — a partial sum must never be presented as the whole batch's size. */
  aggregateSizeFullyKnown: boolean;
  groups: ConvertDiskGroup[];
  /** True only when at least one group has a *definite* insufficient reading. Never true from an unknown or partially-known fact. */
  insufficientDiskSpace: boolean;
  disclosure: string;
}

export type DiskFreeProbe = (path: string) => Promise<number | null>;

export async function buildConvertQueuePreflight(
  jobs: readonly { destPath: string; sourceBytes: number | null }[],
  probe: DiskFreeProbe = detectFreeDiskBytes,
): Promise<ConvertQueuePreflight> {
  const items: ConvertPreflightItem[] = jobs.map(job => ({
    destPath: job.destPath,
    sourceBytes: job.sourceBytes,
    estimatedOutputBytes: job.sourceBytes === null ? null : Math.ceil(job.sourceBytes * ESTIMATED_OUTPUT_HEADROOM_FACTOR),
  }));

  const knownItems = items.filter(i => i.estimatedOutputBytes !== null);
  const aggregateEstimatedBytes = knownItems.reduce((sum, i) => sum + (i.estimatedOutputBytes ?? 0), 0);
  const aggregateSizeFullyKnown = items.length > 0 && knownItems.length === items.length;

  const neededByDirectory = new Map<string, number>();
  for (const item of items) {
    const dir = dirname(item.destPath);
    neededByDirectory.set(dir, (neededByDirectory.get(dir) ?? 0) + (item.estimatedOutputBytes ?? 0));
  }

  const groups: ConvertDiskGroup[] = [];
  for (const [directory, estimatedBytesNeeded] of neededByDirectory) {
    let freeDiskBytes: number | null;
    try {
      freeDiskBytes = await probe(directory);
    } catch {
      freeDiskBytes = null;
    }
    groups.push({
      directory,
      freeDiskBytes,
      estimatedBytesNeeded,
      sufficient: freeDiskBytes === null ? null : freeDiskBytes >= estimatedBytesNeeded,
    });
  }

  const insufficientDiskSpace = groups.some(g => g.sufficient === false);

  return {
    items,
    aggregateEstimatedBytes,
    aggregateSizeFullyKnown,
    groups,
    insufficientDiskSpace,
    disclosure: `each item's estimate is its source file's size × ${ESTIMATED_OUTPUT_HEADROOM_FACTOR} as a conservative margin for reformatting (e.g. pretty-printed JSON) — never a measurement of the real output, which is only known once a conversion actually runs`,
  };
}
