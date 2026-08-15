/**
 * Builds the exhaustive local model catalogue.
 *
 * ## What "catalogue" means here, and why
 *
 * The task this module serves asks for an internet-wide, paginated catalogue
 * of every model Ollama's library publishes — the same shape
 * `docs-site`'s dim-sum catalogue or the Codex model catalog already use for
 * a remote, versioned source. Ollama's *documented local HTTP API*
 * (https://github.com/ollama/ollama/blob/main/docs/api.md) has no endpoint
 * for that: `/api/tags` lists only what is already pulled onto this machine,
 * and there is no documented, paginated "list every model ollama.com
 * publishes" route on the local runtime. Fetching ollama.com's own website
 * or an undocumented API would be exactly the "unofficial proxy" the
 * contract this module implements explicitly forbids.
 *
 * So this module is exhaustive about the thing the documented local API can
 * actually answer: **every tag installed on this machine, in full, with real
 * capability metadata for each — never a curated subset.** That is a real,
 * honest, useful catalogue; it is just not the internet-wide one. The
 * feature-inventory row this ships against records the internet-wide
 * library-reconciliation half as still missing, rather than silently
 * pretending this covers it.
 *
 * `pageCount` and `completeness` are still modelled explicitly (not hidden
 * behind a bare array) so a future paginated `/api/tags` — or the
 * internet-wide half, if it is ever added on top of a documented source —
 * slots in without a breaking response-shape change.
 */

import { fetchOllamaRunning, fetchOllamaShow, fetchOllamaTags } from "./client";
import { computeFitVerdict, parseParameterCountBillions } from "./fit";
import { detectHardwareFacts } from "./hardware";
import type { CatalogEntry, CatalogResult, HardwareFacts } from "./types";

/** Bounded concurrency for the per-tag `/api/show` fan-out — polite to the local daemon, not a network concern. */
const SHOW_CONCURRENCY = 4;

async function mapBounded<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function buildOllamaCatalog(
  baseUrl: string,
  version: string | null,
  hardwareOverride?: HardwareFacts,
): Promise<CatalogResult> {
  const refreshedAt = Date.now();
  const hardware = hardwareOverride ?? await detectHardwareFacts();

  const tagsResult = await fetchOllamaTags(baseUrl);
  if (!tagsResult.ok) {
    return {
      entries: [],
      refreshedAt,
      sourceRevision: version,
      pageCount: 0,
      completeness: { verdict: "unavailable", detail: "the runtime's /api/tags did not answer — no installed models could be listed" },
      hardware,
    };
  }

  const runningResult = await fetchOllamaRunning(baseUrl);
  const running = new Map(runningResult.ok ? runningResult.data.map(r => [r.name, r]) : []);

  let showFailures = 0;
  const entries = await mapBounded(tagsResult.data, SHOW_CONCURRENCY, async tag => {
    const show = await fetchOllamaShow(baseUrl, tag.name);
    if (!show.ok) showFailures += 1;
    const runningEntry = running.get(tag.name);
    const parameterCountBillions = show.parameterCount != null
      ? show.parameterCount / 1_000_000_000
      : parseParameterCountBillions(tag.details.parameterSize);
    const entry: CatalogEntry = {
      name: tag.name,
      model: tag.model,
      modifiedAt: tag.modifiedAt,
      sizeBytes: tag.sizeBytes,
      digest: tag.digest,
      format: tag.details.format,
      family: show.ok ? (show.family ?? tag.details.family) : tag.details.family,
      families: show.ok ? (show.families ?? tag.details.families) : tag.details.families,
      parameterSize: tag.details.parameterSize,
      parameterCountBillions,
      quantizationLevel: show.ok ? (show.quantizationLevel ?? tag.details.quantizationLevel) : tag.details.quantizationLevel,
      contextLength: show.ok ? show.contextLength : null,
      capabilities: show.ok ? show.capabilities : null,
      running: running.has(tag.name),
      runningVramBytes: runningEntry?.sizeVramBytes ?? null,
      showOk: show.ok,
      showError: show.ok ? null : show.error,
      fit: { verdict: "unknown", evidence: [], computedAt: refreshedAt }, // replaced below
    };
    entry.fit = computeFitVerdict(hardware, {
      sizeBytes: entry.sizeBytes,
      parameterCountBillions: entry.parameterCountBillions,
      quantizationLevel: entry.quantizationLevel,
      contextLength: entry.contextLength,
    });
    return entry;
  });

  const completeness: CatalogResult["completeness"] = showFailures === 0
    ? { verdict: "complete", detail: `all ${entries.length} installed model(s) were fully detailed` }
    : { verdict: "partial", detail: `${showFailures} of ${entries.length} installed model(s) could not be fully detailed (their capability metadata is unavailable)` };

  return {
    entries,
    refreshedAt,
    sourceRevision: version,
    pageCount: 1,
    completeness,
    hardware,
  };
}
