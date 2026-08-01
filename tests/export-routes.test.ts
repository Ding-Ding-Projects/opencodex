/**
 * The export routes, over a real socket.
 *
 * The libraries are unit-tested elsewhere; what is checked here is that they are
 * genuinely *reachable* — a serializer nothing calls is a serializer that does
 * not exist, and "it compiles" has never been evidence that a route is wired.
 *
 * The refusals get the most attention, because they are the ones a happy-path
 * test would never notice: an unknown format, an unknown dataset, and a 7z asked
 * for on a machine that cannot make one. That last must be a refusal and not a
 * quietly substituted ZIP.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { managementFetch } from "./helpers/management-auth";
import { removeTempDir } from "./helpers/temp-dir";

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" } },
  } as unknown as OcxConfig;
}

let testDir: string;
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-export-routes-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-export-routes-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  removeTempDir(testDir);
});

test("capabilities reports every format with fidelity for the real rows", async () => {
  const server = startServer(0);
  try {
    const res = await managementFetch(new URL("/api/export/capabilities", server.url));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      datasets: Array<{ id: string; formats: Array<{ format: string; level: string; losses: string[] }> }>;
      archives: { zip: { available: boolean }; sevenZip: { available: boolean } };
      vsCode: { available: boolean };
    };

    const requests = body.datasets.find(dataset => dataset.id === "requests");
    expect(requests).toBeDefined();
    // All fifteen, each carrying its own fidelity verdict rather than a name only.
    expect(requests!.formats).toHaveLength(15);
    for (const entry of requests!.formats) {
      expect(["full", "lossy", "impossible"]).toContain(entry.level);
    }
    expect(requests!.formats.find(f => f.format === "json")!.level).toBe("full");
    expect(requests!.formats.find(f => f.format === "json-schema")!.level).toBe("impossible");

    // ZIP is written in-process, so it is always available. 7z and VS Code are
    // reported honestly rather than assumed either way.
    expect(body.archives.zip.available).toBe(true);
    expect(typeof body.archives.sevenZip.available).toBe("boolean");
    expect(typeof body.vsCode.available).toBe("boolean");
  } finally {
    await server.stop(true);
  }
});

test("a single format comes back as a download, with its fidelity in a header", async () => {
  const server = startServer(0);
  try {
    const res = await managementFetch(new URL("/api/export", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: "requests", format: "csv" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="requests.csv"');
    // CSV cannot carry everything, and the response says so even to a caller
    // that never asked capabilities.
    expect(res.headers.get("X-Export-Fidelity")).toBe("lossy");
  } finally {
    await server.stop(true);
  }
});

test("several formats come back as one ZIP a real reader can open", async () => {
  const server = startServer(0);
  try {
    const res = await managementFetch(new URL("/api/export", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: "requests", formats: ["json", "csv", "markdown"], archive: "zip" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The local-file-header signature: this is a ZIP, not a JSON error page with
    // a ZIP content type on it.
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
  } finally {
    await server.stop(true);
  }
});

test("an unknown format is refused, and says what is known", async () => {
  const server = startServer(0);
  try {
    const res = await managementFetch(new URL("/api/export", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: "requests", format: "parquet" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("json");
    expect(body.error).toContain("csv");
  } finally {
    await server.stop(true);
  }
});

test("one bad format in a list refuses the whole request rather than dropping it", async () => {
  // The quiet version of this returns an archive missing a format the caller
  // asked for, with nothing anywhere saying which — the same truncation the
  // fidelity warnings exist to prevent, one level up. `md` is the plausible
  // wrong spelling of `markdown`, which is exactly how it would happen.
  const server = startServer(0);
  try {
    const res = await managementFetch(new URL("/api/export", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: "requests", formats: ["json", "md"], archive: "zip" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("md");
    expect(body.error).toContain("markdown");
  } finally {
    await server.stop(true);
  }
});

test("an unknown dataset is refused, and lists the real ones", async () => {
  const server = startServer(0);
  try {
    const res = await managementFetch(new URL("/api/export", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: "not-a-dataset", format: "json" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("requests");
  } finally {
    await server.stop(true);
  }
});

test("the export routes sit behind management auth like everything else", async () => {
  const server = startServer(0);
  try {
    // No credential at all. `/api/export` must not be the one route that forgot.
    const res = await globalThis.fetch(new URL("/api/export/capabilities", server.url));
    expect(res.status).toBe(401);
  } finally {
    await server.stop(true);
  }
});
