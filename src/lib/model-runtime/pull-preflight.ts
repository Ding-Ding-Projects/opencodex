/**
 * Pre-batch disclosure: what will happen if this batch is started, computed
 * from real, already-known facts — never a guess dressed up as an estimate.
 *
 * Ollama's documented local API has no "how big is this before I pull it"
 * route for a tag that is not already installed (see `pull-client.ts`'s
 * header for the same limitation on the pull stream itself), so a genuinely
 * new tag's size is honestly `null` here — "unknown until the pull begins" —
 * rather than a synthesised number. A tag that is already installed reuses
 * its real, measured size from the local catalog.
 */

import type { CatalogEntry, HardwareFacts } from "./types";

/** Headroom over a reused size estimate: a re-pull can briefly hold an old and a new layer of the same model side by side, plus manifest/verification overhead. Not a measurement — a documented, conservative margin. */
const DISK_HEADROOM_FACTOR = 1.15;

export interface PullPreflightItem {
  tag: string;
  alreadyInstalled: boolean;
  estimatedSizeBytes: number | null;
  estimatedAdditionalDiskBytes: number | null;
  fitVerdict: CatalogEntry["fit"]["verdict"] | null;
  disclosure: string;
}

export interface PullPreflight {
  items: PullPreflightItem[];
  aggregateEstimatedBytes: number;
  /** True only when every item's size is known — a partial sum must never be presented as the whole batch's size. */
  aggregateSizeFullyKnown: boolean;
  freeDiskBytes: number | null;
  diskPath: string | null;
  networkDisclosure: string;
}

function itemDisclosure(alreadyInstalled: boolean, sizeKnown: boolean): string {
  if (alreadyInstalled) {
    return "this tag is already installed; starting the batch without forcing a re-pull will skip it rather than download it again";
  }
  return sizeKnown
    ? "this is a new pull; the size below is reused from the currently installed copy of this tag and may differ from what is actually downloaded"
    : "this is a new pull; Ollama's local API does not report a size before a pull begins, so the size will only be known once downloading starts";
}

export function buildPullPreflight(tags: string[], catalog: CatalogEntry[] | null, hardware: HardwareFacts | null): PullPreflight {
  const byTag = new Map((catalog ?? []).map(e => [e.name, e]));
  const items: PullPreflightItem[] = tags.map(tag => {
    const existing = byTag.get(tag);
    const alreadyInstalled = existing != null;
    const estimatedSizeBytes = existing?.sizeBytes ?? null;
    const estimatedAdditionalDiskBytes = estimatedSizeBytes != null ? Math.round(estimatedSizeBytes * DISK_HEADROOM_FACTOR) : null;
    return {
      tag,
      alreadyInstalled,
      estimatedSizeBytes,
      estimatedAdditionalDiskBytes,
      fitVerdict: existing?.fit.verdict ?? null,
      disclosure: itemDisclosure(alreadyInstalled, estimatedSizeBytes != null),
    };
  });

  const knownSizes = items.filter(i => i.estimatedSizeBytes != null);
  const aggregateEstimatedBytes = knownSizes.reduce((sum, i) => sum + (i.estimatedSizeBytes ?? 0), 0);
  const aggregateSizeFullyKnown = items.length > 0 && knownSizes.length === items.length;

  return {
    items,
    aggregateEstimatedBytes,
    aggregateSizeFullyKnown,
    freeDiskBytes: hardware?.freeDiskBytes ?? null,
    diskPath: hardware?.diskPath ?? null,
    networkDisclosure: "every pull downloads over this machine's own network connection from Ollama's registry; nothing in this batch is purchased, charged, or billed — this is a download queue only",
  };
}
