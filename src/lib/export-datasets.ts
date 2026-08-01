/**
 * What can be exported, defined once for every surface that offers it.
 *
 * The GUI, the management API and the CLI all export the same lists, and the
 * repo's headless-parity test exists to make sure none of them drifts ahead of
 * the others. Two copies of this registry would be two answers to "what can I
 * export", and the redaction below is exactly the kind of thing that gets
 * remembered in one copy and forgotten in the other.
 *
 * ## The redaction is the load-bearing part
 *
 * Two of these lists hold live credentials and neither exports one. An export is
 * a file whose entire purpose is to be moved somewhere else — into a
 * spreadsheet, an issue, a chat window — and the formats include HTML and
 * Markdown, which are precisely what people paste. `ocx export` (no subcommand)
 * remains the deliberate way to move real secrets, and it says so in as many
 * words before it writes anything.
 */

import { loadConfig } from "../config";
import { getRequestLogEntries } from "../server/request-log";
import { requestLogDto } from "../server/management/shared";
import type { OcxConfig } from "../types";

export type Row = Record<string, unknown>;

export interface DatasetDef {
  id: string;
  label: string;
  rows: (config: OcxConfig) => Row[];
}

export const DATASETS: DatasetDef[] = [
  {
    id: "requests",
    label: "Request log",
    rows: () => getRequestLogEntries().map(entry => requestLogDto(entry) as Row),
  },
  {
    id: "providers",
    label: "Providers",
    rows: config => Object.entries(config.providers ?? {}).map(([name, provider]) => ({
      name,
      adapter: provider.adapter,
      baseUrl: provider.baseUrl,
      authMode: provider.authMode,
      // Whether a key is set is the useful fact; the value is not.
      apiKeyConfigured: !!provider.apiKey,
    })),
  },
  {
    id: "combos",
    label: "Combos",
    rows: config => Object.entries(config.combos ?? {}).map(([name, combo]) => ({
      name,
      ...(combo as unknown as Row),
    })),
  },
  {
    id: "api-keys",
    label: "API keys",
    // The prefix identifies a row against the dashboard, which is what an export
    // of this list is for. The key itself is never written.
    rows: config => (config.apiKeys ?? []).map(entry => ({
      id: entry.id,
      name: entry.name,
      prefix: entry.key.slice(0, 12),
      createdAt: entry.createdAt,
    })),
  },
  {
    id: "models",
    label: "Custom models",
    rows: config => (config.customModels ?? []).map(model => ({ ...(model as unknown as Row) })),
  },
];

/** Every dataset's id and label, for a picker or a `--list`. */
export function listDatasets(): Array<{ id: string; label: string }> {
  return DATASETS.map(({ id, label }) => ({ id, label }));
}

/**
 * The rows for one dataset, or null when the id is unknown.
 *
 * `config` is optional so the CLI can call this without threading one through;
 * a route that already holds the live config passes it, because re-reading from
 * disk mid-request would answer about a different moment than the rest of the
 * response.
 */
export function datasetRows(id: string, config?: OcxConfig): Row[] | null {
  const dataset = DATASETS.find(entry => entry.id === id);
  if (!dataset) return null;
  return dataset.rows(config ?? loadConfig());
}
