/**
 * The export registry, with the rules that are easy to lose in a later edit.
 *
 * Two of these matter more than the row counts. The first is redaction: three of
 * these lists sit next to live credentials, and the whole point of the registry
 * being one file is that the rule is written once — a test is how it stays that
 * way when somebody adds a field to `providers` in a hurry. The second is the
 * usage aggregate's estimated flag, which is the difference between a number a
 * user can bill against and a number they cannot, and which nothing in the type
 * system would notice going wrong.
 */

import { describe, expect, test } from "bun:test";
import { DATASETS, listDatasets } from "../src/lib/export-datasets";
import { parseChangelog } from "../src/server/management/changelog-routes";
import { addRequestLog, type RequestLogEntry } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

/** A config carrying a secret in every place one can live. */
function configWithSecrets(): OcxConfig {
  return {
    providers: {
      openai: {
        adapter: "openai", baseUrl: "https://api.example", apiKey: "sk-live-SECRET-VALUE",
        // MCP servers hang off a provider, not off the config root.
        mcpServers: {
          files: { command: "npx", args: ["-y", "server"], env: { TOKEN: "mcp-SECRET-VALUE" } },
          remote: { url: "https://mcp.example", headers: { Authorization: "Bearer SECRET-VALUE" } },
        },
      },
    },
    apiKeys: [{ id: "k1", name: "laptop", key: "ocx_SECRETKEYVALUE_tail", createdAt: "2026-01-01T00:00:00Z" }],
  } as unknown as OcxConfig;
}

/** Everything a dataset produced, flattened to one searchable string. */
function textOf(rows: unknown[]): string {
  return JSON.stringify(rows);
}

describe("the export registry", () => {
  test("every dataset has a unique id and a label", () => {
    const ids = DATASETS.map(dataset => dataset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const dataset of DATASETS) expect(dataset.label.length).toBeGreaterThan(0);
    expect(listDatasets().map(entry => entry.id)).toEqual(ids);
  });

  test("the newly registered lists are present", () => {
    const ids = DATASETS.map(dataset => dataset.id);
    for (const id of ["usage", "changelog", "history", "mcp-servers"]) {
      expect(ids).toContain(id);
    }
  });

  test("no dataset writes a secret it was handed", () => {
    const config = configWithSecrets();
    for (const dataset of DATASETS) {
      const text = textOf(dataset.rows(config));
      // The literal values, not a redaction marker — a row that wrote
      // "sk-live-…" truncated would still fail, which is the intent.
      expect(text).not.toContain("SECRET-VALUE");
      expect(text).not.toContain("SECRETKEYVALUE");
    }
  });

  test("MCP servers export the env NAMES, so the export is still useful", () => {
    const rows = DATASETS.find(d => d.id === "mcp-servers")!.rows(configWithSecrets());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: "openai", name: "files", transport: "stdio",
      command: "npx", args: "-y server", envKeys: "TOKEN",
    });
    // A remote server's bearer header is a credential in exactly the same way.
    expect(rows[1]).toMatchObject({
      provider: "openai", name: "remote", transport: "streamable-http",
      url: "https://mcp.example", headerKeys: "Authorization",
    });
  });

  test("every dataset survives an empty config rather than throwing", () => {
    // The capabilities route calls `rows()` for every dataset on one request, so
    // one list that throws on a fresh install takes the whole screen with it.
    for (const dataset of DATASETS) {
      expect(() => dataset.rows({} as OcxConfig)).not.toThrow();
    }
  });

  test("the config-backed lists stay flat, so CSV is not a silent loss", () => {
    const config = configWithSecrets();
    const nested: string[] = [];
    // `requests` is deliberately excluded: its rows are the full log DTO and are
    // nested by design, which is exactly what the fidelity warnings are for.
    for (const dataset of DATASETS.filter(d => d.id !== "requests")) {
      for (const row of dataset.rows(config)) {
        for (const [key, value] of Object.entries(row)) {
          if (value !== null && typeof value === "object") nested.push(`${dataset.id}.${key}`);
        }
      }
    }
    expect(nested).toEqual([]);
  });
});

describe("the usage aggregate", () => {
  const usageRows = () => DATASETS.find(d => d.id === "usage")!.rows({} as OcxConfig);

  function log(over: Partial<RequestLogEntry>): void {
    addRequestLog({
      requestId: `r${Math.floor(performance.now() * 1000)}-${over.model}`,
      timestamp: Date.now(),
      model: "m", provider: "p", status: 200, durationMs: 100,
      usageStatus: "measured",
      ...over,
    } as RequestLogEntry);
  }

  test("buckets by provider and model, sums tokens, and averages duration", () => {
    const before = usageRows().length;
    log({ provider: "acme", model: "big", durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } });
    log({ provider: "acme", model: "big", durationMs: 300, usage: { inputTokens: 20, outputTokens: 5 } });
    log({ provider: "acme", model: "small", durationMs: 50, usage: { inputTokens: 1, outputTokens: 1 } });

    const rows = usageRows();
    expect(rows.length).toBe(before + 2);
    const big = rows.find(row => row.model === "big")!;
    expect(big).toMatchObject({
      provider: "acme", requests: 2, errors: 0,
      inputTokens: 30, outputTokens: 10, totalTokens: 40, avgDurationMs: 200,
    });
  });

  test("counts failures separately instead of hiding them in the request count", () => {
    log({ provider: "acme", model: "flaky", status: 200, usage: { inputTokens: 1, outputTokens: 1 } });
    log({ provider: "acme", model: "flaky", status: 429 });
    const row = usageRows().find(entry => entry.model === "flaky")!;
    expect(row).toMatchObject({ requests: 2, errors: 1 });
  });

  test("one estimated request taints the whole bucket", () => {
    // A total that mixes measured and estimated numbers IS estimated. Reporting
    // it as measured because most of the rows were is the failure this guards:
    // the user would bill against it.
    log({ provider: "acme", model: "mixed", usage: { inputTokens: 100, outputTokens: 10 } });
    expect(usageRows().find(row => row.model === "mixed")).toMatchObject({ estimated: false });
    log({ provider: "acme", model: "mixed", usage: { inputTokens: 1, outputTokens: 1, estimated: true } });
    expect(usageRows().find(row => row.model === "mixed")).toMatchObject({ estimated: true, requests: 2 });
  });
});

describe("the changelog dataset", () => {
  test("emits one row per change line, carrying its version and date", () => {
    const releases = parseChangelog([
      "## 2.0.0 — 2026-02-02",
      "- fix(a): one",
      "- fix(b): two",
      "## 1.0.0 — 2026-01-01",
      "- feat(c): three",
    ].join("\n"));
    // Mirrors the registry's own flattening, which is the shape under test.
    const rows = releases.flatMap(release =>
      release.entries.map(change => ({ version: release.version, date: release.date, change })));
    expect(rows).toEqual([
      { version: "2.0.0", date: "2026-02-02", change: "fix(a): one" },
      { version: "2.0.0", date: "2026-02-02", change: "fix(b): two" },
      { version: "1.0.0", date: "2026-01-01", change: "feat(c): three" },
    ]);
  });
});
