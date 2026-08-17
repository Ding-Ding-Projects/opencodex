/**
 * `/api/downloads/*` end to end: real HTTP request objects, a real
 * `ManagementContext`, a real loopback transfer where a route needs one — same
 * shape as `tests/converter-routes.test.ts`, so the loopback gate and the
 * fs/network-facing manager actually agree once wired behind the route.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDownloadRoutes } from "../src/server/management/download-routes";
import { resetDownloadManagerForTests } from "../src/lib/downloads/manager";
import { setServerRef } from "../src/server/lifecycle";
import { removeTempDir } from "./helpers/temp-dir";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

function listeningOn(hostname: string | undefined): void {
  setServerRef(hostname === undefined ? undefined : ({ hostname, port: 10101 } as never));
}

let homeDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "ocx-dlroutes-home-"));
  process.env.OPENCODEX_HOME = homeDir;
  resetDownloadManagerForTests();
  listeningOn("127.0.0.1");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTempDir(homeDir);
  resetDownloadManagerForTests();
  setServerRef(undefined);
});

const dirs: string[] = [];
function tempDestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-dlroutes-dest-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

function ctx(pathname: string, method: string, body?: unknown): ManagementContext {
  const url = new URL(`http://127.0.0.1:10101${pathname}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    }),
    url,
    config: { port: 10101, hostname: "127.0.0.1", providers: {} } as OcxConfig,
    deps: {} as ManagementContext["deps"],
    refreshCodexCatalogBestEffort: async () => {},
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

describe("/api/downloads/* — local-machine gate", () => {
  test("every kind of route is refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const capture = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", { url: "https://example.test/x" }));
    expect(capture?.status).toBe(403);
    expect(await capture!.json()).toMatchObject({ reason: "loopback-required" });

    const list = await handleDownloadRoutes(ctx("/api/downloads", "GET"));
    expect(list?.status).toBe(403);

    const single = await handleDownloadRoutes(ctx("/api/downloads/some-id", "GET"));
    expect(single?.status).toBe(403);
  });

  test("refused when the listener is unknown", async () => {
    listeningOn(undefined);
    const res = await handleDownloadRoutes(ctx("/api/downloads", "GET"));
    expect(res?.status).toBe(403);
  });
});

describe("POST /api/downloads/capture", () => {
  test("queues a valid capture and returns it with 201", async () => {
    const res = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", {
      url: "https://example.test/report.pdf",
      suggestedFilename: "report.pdf",
      pageUrl: "https://example.test/downloads",
    }));
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.state).toBe("queued");
    expect(body.suggestedFilename).toBe("report.pdf");
    expect(body.pageUrl).toBe("https://example.test/downloads");
  });

  test("refuses a non-http(s) url with 400 and a named reason, and queues nothing", async () => {
    const res = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", { url: "file:///etc/passwd" }));
    expect(res?.status).toBe(400);
    const body = await res!.json();
    expect(body.reason).toBe("unsupported-protocol");

    const list = await handleDownloadRoutes(ctx("/api/downloads", "GET"));
    expect((await list!.json()).records).toEqual([]);
  });

  test("rejects a body with no url", async () => {
    const res = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", {}));
    expect(res?.status).toBe(400);
  });
});

describe("GET /api/downloads and /api/downloads/:id", () => {
  test("lists what was captured, and a single lookup matches", async () => {
    await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", { url: "https://example.test/a" }));
    await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", { url: "https://example.test/b" }));
    const list = await handleDownloadRoutes(ctx("/api/downloads", "GET"));
    const body = await list!.json() as { records: Array<{ id: string; url: string }> };
    expect(body.records).toHaveLength(2);

    const single = await handleDownloadRoutes(ctx(`/api/downloads/${body.records[0].id}`, "GET"));
    expect(single?.status).toBe(200);
    expect((await single!.json()).id).toBe(body.records[0].id);
  });

  test("an unknown id is a real 404, not a silent empty body", async () => {
    const res = await handleDownloadRoutes(ctx("/api/downloads/does-not-exist", "GET"));
    expect(res?.status).toBe(404);
  });
});

describe("the Start-download dialog's two actions", () => {
  test("confirm begins a real transfer to the requested destination directory", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("payload-bytes") });
    try {
      const captured = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", {
        url: `http://127.0.0.1:${server.port}/x`,
        suggestedFilename: "x.bin",
      }));
      const { id } = await captured!.json();
      const dest = tempDestDir();
      const confirmed = await handleDownloadRoutes(ctx(`/api/downloads/${id}/confirm`, "POST", { destinationDir: dest }));
      expect(confirmed?.status).toBe(200);
      const body = await confirmed!.json();
      expect(body.state).toBe("downloading");
      expect(body.destinationPath).toBe(join(dest, "x.bin"));
    } finally {
      server.stop(true);
    }
  });

  test("cancel on a queued (never confirmed) capture leaves the queue with a canceled record, never a 500", async () => {
    const captured = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", { url: "https://example.test/never" }));
    const { id } = await captured!.json();
    const canceled = await handleDownloadRoutes(ctx(`/api/downloads/${id}/cancel`, "POST"));
    expect(canceled?.status).toBe(200);
    expect((await canceled!.json()).state).toBe("canceled");
  });

  test("confirming twice is refused with 400, not a duplicated transfer", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    try {
      const captured = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", { url: `http://127.0.0.1:${server.port}/` }));
      const { id } = await captured!.json();
      const dest = tempDestDir();
      await handleDownloadRoutes(ctx(`/api/downloads/${id}/confirm`, "POST", { destinationDir: dest }));
      const second = await handleDownloadRoutes(ctx(`/api/downloads/${id}/confirm`, "POST", { destinationDir: dest }));
      expect(second?.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});

describe("DELETE /api/downloads/:id", () => {
  test("refuses to remove an active download — cancel first", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    try {
      const captured = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", { url: `http://127.0.0.1:${server.port}/` }));
      const { id } = await captured!.json();
      await handleDownloadRoutes(ctx(`/api/downloads/${id}/confirm`, "POST", { destinationDir: tempDestDir() }));
      const removed = await handleDownloadRoutes(ctx(`/api/downloads/${id}`, "DELETE"));
      expect(removed?.status).toBe(400);
      await handleDownloadRoutes(ctx(`/api/downloads/${id}/cancel`, "POST"));
    } finally {
      server.stop(true);
    }
  });

  test("removes a canceled record from history", async () => {
    const captured = await handleDownloadRoutes(ctx("/api/downloads/capture", "POST", { url: "https://example.test/gone" }));
    const { id } = await captured!.json();
    await handleDownloadRoutes(ctx(`/api/downloads/${id}/cancel`, "POST"));
    const removed = await handleDownloadRoutes(ctx(`/api/downloads/${id}`, "DELETE"));
    expect(removed?.status).toBe(200);
    const after = await handleDownloadRoutes(ctx(`/api/downloads/${id}`, "GET"));
    expect(after?.status).toBe(404);
  });
});
