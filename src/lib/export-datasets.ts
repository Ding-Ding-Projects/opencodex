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
 * Three of these lists hold live credentials — providers, API keys and MCP
 * servers, whose `env` block routinely carries a token — and none exports one.
 * An export is
 * a file whose entire purpose is to be moved somewhere else — into a
 * spreadsheet, an issue, a chat window — and the formats include HTML and
 * Markdown, which are precisely what people paste. `ocx export` (no subcommand)
 * remains the deliberate way to move real secrets, and it says so in as many
 * words before it writes anything.
 */

import { loadConfig } from "../config";
import { getRequestLogEntries } from "../server/request-log";
import { loadChangelogReleases } from "../server/management/changelog-routes";
import { listStateHistoryEntries } from "./state-history";
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
    // Identity and metadata are enough to match the dashboard row. Do not emit
    // a prefix, suffix, fingerprint, or any other secret-derived substring: a
    // valid custom key may be only twelve characters long, so a twelve-character
    // "prefix" is the entire credential.
    rows: config => (config.apiKeys ?? []).map(entry => ({
      id: entry.id,
      name: entry.name,
      createdAt: entry.createdAt,
    })),
  },
  {
    id: "models",
    label: "Custom models",
    rows: config => (config.customModels ?? []).map(model => ({ ...(model as unknown as Row) })),
  },
  {
    id: "usage",
    label: "Token usage by model",
    // Aggregated rather than per-request: the request log is already exportable
    // row-by-row as `requests`, and re-exporting it under a second name would
    // just be the same file twice. What this list is for is the question the log
    // cannot answer at a glance — where the tokens actually went.
    rows: () => {
      const totals = new Map<string, Row & { requests: number }>();
      for (const entry of getRequestLogEntries()) {
        const key = `${entry.provider}\0${entry.model}`;
        const row = totals.get(key) ?? {
          provider: entry.provider, model: entry.model,
          requests: 0, errors: 0,
          inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
          cachedInputTokens: 0, totalTokens: 0, totalDurationMs: 0,
          // Any estimate anywhere in the bucket taints the bucket: a total that
          // mixes measured and estimated numbers is estimated, and reporting it
          // as measured is the one thing that would make this list untrustworthy.
          estimated: false,
        };
        row.requests += 1;
        if (entry.status >= 400) row.errors = (row.errors as number) + 1;
        row.totalDurationMs = (row.totalDurationMs as number) + (entry.durationMs || 0);
        const usage = entry.usage;
        if (usage) {
          row.inputTokens = (row.inputTokens as number) + (usage.inputTokens || 0);
          row.outputTokens = (row.outputTokens as number) + (usage.outputTokens || 0);
          row.reasoningOutputTokens = (row.reasoningOutputTokens as number) + (usage.reasoningOutputTokens || 0);
          row.cachedInputTokens = (row.cachedInputTokens as number) + (usage.cachedInputTokens || 0);
          row.totalTokens = (row.totalTokens as number)
            + (usage.totalTokens ?? (usage.inputTokens || 0) + (usage.outputTokens || 0));
          if (usage.estimated) row.estimated = true;
        }
        totals.set(key, row);
      }
      return [...totals.values()].map(row => ({
        ...row,
        // Derived here rather than left to the reader, because a spreadsheet of
        // totals with no average is the one column everybody adds by hand.
        avgDurationMs: row.requests ? Math.round((row.totalDurationMs as number) / row.requests) : 0,
      }));
    },
  },
  {
    id: "changelog",
    label: "Changelog",
    // One row per change line, not per release. A release row would carry an
    // array of strings, which CSV and TSV cannot hold — so the format that
    // people most want this in would be the one that lost the content. Flat
    // rows also make the whole history greppable, which is the actual use.
    rows: () => loadChangelogReleases().flatMap(release =>
      release.entries.map(change => ({
        version: release.version,
        date: release.date,
        change,
      }))),
  },
  {
    id: "history",
    label: "Version history",
    // The local snapshot history behind the restore list. The hash travels with
    // it because it is what a restore is addressed by; an export that dropped it
    // would document what happened without letting anyone act on it.
    rows: () => listStateHistoryEntries(200).map(entry => ({ ...entry } as Row)),
  },
  {
    id: "mcp-servers",
    label: "MCP servers",
    // Configured per provider, not globally, so the provider name is part of the
    // row's identity — two providers may well name a server the same thing.
    //
    // Everything after that identity is structural metadata. MCP credentials are
    // not confined to env/header values: command arguments commonly carry
    // `--api-key <secret>`, while HTTP URLs can carry userinfo, query tokens, or
    // secret path segments. Export counts/booleans instead of any caller-supplied
    // command, argument, path, URL, environment name, or header name/value.
    rows: config => Object.entries(config.providers ?? {}).flatMap(([provider, entry]) =>
      Object.entries(entry.mcpServers ?? {}).map(([name, server]) => ({
        provider,
        name,
        transport: server.url ? "streamable-http" : "stdio",
        enabled: server.enabled !== false,
        commandConfigured: typeof server.command === "string" && server.command.length > 0,
        argumentCount: Array.isArray(server.args) ? server.args.length : 0,
        workingDirectoryConfigured: typeof server.cwd === "string" && server.cwd.length > 0,
        urlConfigured: typeof server.url === "string" && server.url.length > 0,
        environmentVariableCount: Object.keys(server.env ?? {}).length,
        headerCount: Object.keys(server.headers ?? {}).length,
      }))),
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
