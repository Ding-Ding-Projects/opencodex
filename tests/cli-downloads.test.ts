/**
 * `ocx downloads` — proves it hits exactly the routes
 * `src/server/management/download-routes.ts` exposes, the same headless-
 * parity discipline `tests/cli-converter.test.ts` established.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleDownloadsCommand } from "../src/cli/downloads";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  process.exitCode = 0;
});

function fakeRuntime(responder?: (req: Request, body: unknown) => { status?: number; body: unknown }) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
      requests.push({ path: `${url.pathname}${url.search}`, method: req.method, body });
      const custom = responder?.(req, body);
      return Response.json(custom?.body ?? { ok: true }, { status: custom?.status ?? 200 });
    },
  });
  servers.push(server);
  return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.log = log; console.error = error; } };
}

describe("ocx downloads", () => {
  test("capture posts to POST /api/downloads/capture", async () => {
    const runtime = fakeRuntime(() => ({ body: { id: "1", state: "queued", suggestedFilename: "x.zip", bytesReceived: 0, bytesTotal: null } }));
    const out = captureConsole();
    let code: number;
    try { code = await handleDownloadsCommand(["capture", "https://example.test/x.zip", "--name", "x.zip", "--json"], runtime.deps); }
    finally { out.restore(); }
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/downloads/capture",
      method: "POST",
      body: { url: "https://example.test/x.zip", suggestedFilename: "x.zip", pageUrl: undefined },
    }]);
  });

  test("list hits GET /api/downloads and reports state, filename, id per row", async () => {
    const runtime = fakeRuntime(() => ({
      body: { records: [{ id: "abc", state: "downloading", suggestedFilename: "report.pdf", bytesReceived: 50, bytesTotal: 100 }] },
    }));
    const out = captureConsole();
    try { await handleDownloadsCommand(["list"], runtime.deps); }
    finally { out.restore(); }
    const printed = out.lines.join("\n");
    expect(printed).toContain("abc");
    expect(printed).toContain("downloading");
    expect(printed).toContain("report.pdf");
    expect(runtime.requests).toEqual([{ path: "/api/downloads", method: "GET", body: null }]);
  });

  test("show hits GET /api/downloads/:id", async () => {
    const runtime = fakeRuntime(() => ({ body: { id: "abc", state: "queued", suggestedFilename: "x", bytesReceived: 0, bytesTotal: null } }));
    const out = captureConsole();
    let code: number;
    try { code = await handleDownloadsCommand(["show", "abc", "--json"], runtime.deps); }
    finally { out.restore(); }
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{ path: "/api/downloads/abc", method: "GET", body: null }]);
  });

  test("confirm posts destination and name to POST /api/downloads/:id/confirm", async () => {
    const runtime = fakeRuntime(() => ({ body: { id: "abc", state: "downloading", suggestedFilename: "x", destinationPath: "/tmp/x", bytesReceived: 0, bytesTotal: null } }));
    const out = captureConsole();
    try { await handleDownloadsCommand(["confirm", "abc", "--dir", "/tmp", "--name", "x"], runtime.deps); }
    finally { out.restore(); }
    expect(runtime.requests).toEqual([{
      path: "/api/downloads/abc/confirm",
      method: "POST",
      body: { destinationDir: "/tmp", filename: "x" },
    }]);
  });

  for (const action of ["cancel", "pause", "resume"] as const) {
    test(`${action} posts to POST /api/downloads/:id/${action}`, async () => {
      const runtime = fakeRuntime(() => ({ body: { id: "abc", state: action === "pause" ? "paused" : action === "resume" ? "downloading" : "canceled", suggestedFilename: "x", bytesReceived: 0, bytesTotal: null } }));
      const out = captureConsole();
      let code: number;
      try { code = await handleDownloadsCommand([action, "abc"], runtime.deps); }
      finally { out.restore(); }
      expect(code).toBe(0);
      expect(runtime.requests).toEqual([{ path: `/api/downloads/abc/${action}`, method: "POST", body: null }]);
    });
  }

  test("remove sends DELETE /api/downloads/:id", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    let code: number;
    try { code = await handleDownloadsCommand(["remove", "abc"], runtime.deps); }
    finally { out.restore(); }
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{ path: "/api/downloads/abc", method: "DELETE", body: null }]);
  });

  test("capture with no url is a usage error, not a request", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    let code: number;
    try { code = await handleDownloadsCommand(["capture"], runtime.deps); }
    finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(runtime.requests).toHaveLength(0);
  });

  test("an unknown subcommand is a usage error", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    let code: number;
    try { code = await handleDownloadsCommand(["nonsense"], runtime.deps); }
    finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(runtime.requests).toHaveLength(0);
  });
});
