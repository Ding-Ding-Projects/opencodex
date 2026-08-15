/**
 * `ocx pdf` — proves the CLI hits exactly the routes
 * `src/server/management/pdf-routes.ts` exposes, with exactly the body shape
 * those routes expect. This is the genuine half of "headless parity": not
 * merely that both an entry and a route exist, but that the CLI's request is
 * byte-for-byte what a hand-written client of the route would send.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handlePdfCommand } from "../src/cli/pdf";

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
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
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

describe("ocx pdf", () => {
  test("inspect sends the path to POST /api/pdf/inspect", async () => {
    const runtime = fakeRuntime((_, __) => ({ body: { capabilities: { ok: true, signed: false, pageCount: 1 }, pages: [], metadata: {} } }));
    const out = captureConsole();
    let code: number;
    try { code = await handlePdfCommand(["inspect", "C:\\docs\\a.pdf", "--json"], runtime.deps); }
    finally { out.restore(); }
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{ path: "/api/pdf/inspect", method: "POST", body: { path: "C:\\docs\\a.pdf" } }]);
  });

  test("metadata read uses GET with the path in the query string", async () => {
    const runtime = fakeRuntime((_, __) => ({ body: { title: "T" } }));
    const out = captureConsole();
    try { await handlePdfCommand(["metadata", "read", "C:\\docs\\a.pdf", "--json"], runtime.deps); }
    finally { out.restore(); }
    expect(runtime.requests).toEqual([{ path: "/api/pdf/metadata?path=C%3A%5Cdocs%5Ca.pdf", method: "GET", body: null }]);
  });

  test("metadata write sends only the fields provided plus destination and path", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand(
        ["metadata", "write", "C:\\a.pdf", "--destination", "C:\\out.pdf", "--title", "New", "--json"],
        runtime.deps,
      );
    } finally { out.restore(); }
    expect(runtime.requests).toEqual([{
      path: "/api/pdf/metadata",
      method: "POST",
      body: { path: "C:\\a.pdf", destination: "C:\\out.pdf", fields: { title: "New" }, acknowledgeSigned: false },
    }]);
  });

  test("split parses ranges and destinations in order", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand([
        "split", "C:\\a.pdf", "--ranges", "1-2,3-5", "--destinations", "C:\\one.pdf,C:\\two.pdf", "--json",
      ], runtime.deps);
    } finally { out.restore(); }
    expect(runtime.requests).toEqual([{
      path: "/api/pdf/split",
      method: "POST",
      body: {
        path: "C:\\a.pdf",
        ranges: [{ start: 1, end: 2 }, { start: 3, end: 5 }],
        destinations: ["C:\\one.pdf", "C:\\two.pdf"],
        acknowledgeSigned: false,
      },
    }]);
  });

  test("split accepts a single page number as a one-page range", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand([
        "split", "C:\\a.pdf", "--ranges", "7", "--destinations", "C:\\out.pdf", "--json",
      ], runtime.deps);
    } finally { out.restore(); }
    expect(runtime.requests[0]?.body).toEqual({
      path: "C:\\a.pdf", ranges: [{ start: 7, end: 7 }], destinations: ["C:\\out.pdf"], acknowledgeSigned: false,
    });
  });

  test("merge sends every source and the destination", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand(["merge", "--sources", "C:\\a.pdf,C:\\b.pdf", "--destination", "C:\\out.pdf", "--json"], runtime.deps);
    } finally { out.restore(); }
    expect(runtime.requests).toEqual([{
      path: "/api/pdf/merge",
      method: "POST",
      body: { paths: ["C:\\a.pdf", "C:\\b.pdf"], destination: "C:\\out.pdf", acknowledgeSigned: false },
    }]);
  });

  test("extract preserves the requested page order, including repeats", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand(["extract", "C:\\a.pdf", "--pages", "3,1,3", "--destination", "C:\\out.pdf", "--json"], runtime.deps);
    } finally { out.restore(); }
    expect(runtime.requests[0]?.body).toEqual({
      path: "C:\\a.pdf", pages: [3, 1, 3], destination: "C:\\out.pdf", acknowledgeSigned: false,
    });
  });

  test("reorder sends the full requested order", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand(["reorder", "C:\\a.pdf", "--order", "3,1,2", "--destination", "C:\\out.pdf", "--json"], runtime.deps);
    } finally { out.restore(); }
    expect(runtime.requests[0]?.body).toEqual({
      path: "C:\\a.pdf", order: [3, 1, 2], destination: "C:\\out.pdf", acknowledgeSigned: false,
    });
  });

  test("rotate parses page:degrees pairs and marks every entry absolute by default", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand(["rotate", "C:\\a.pdf", "--rotations", "1:90,2:180", "--destination", "C:\\out.pdf", "--json"], runtime.deps);
    } finally { out.restore(); }
    expect(runtime.requests[0]?.body).toEqual({
      path: "C:\\a.pdf",
      rotations: [{ page: 1, degrees: 90, relative: false }, { page: 2, degrees: 180, relative: false }],
      destination: "C:\\out.pdf",
      acknowledgeSigned: false,
    });
  });

  test("rotate --relative marks every rotation entry relative", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand(["rotate", "C:\\a.pdf", "--rotations", "1:90", "--destination", "C:\\out.pdf", "--relative", "--json"], runtime.deps);
    } finally { out.restore(); }
    expect(runtime.requests[0]?.body).toEqual({
      path: "C:\\a.pdf", rotations: [{ page: 1, degrees: 90, relative: true }], destination: "C:\\out.pdf", acknowledgeSigned: false,
    });
  });

  test("--acknowledge-signed is threaded through to the request body", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      await handlePdfCommand([
        "rotate", "C:\\a.pdf", "--rotations", "1:90", "--destination", "C:\\out.pdf", "--acknowledge-signed", "--json",
      ], runtime.deps);
    } finally { out.restore(); }
    expect((runtime.requests[0]?.body as { acknowledgeSigned: boolean }).acknowledgeSigned).toBe(true);
  });

  test("a refused (encrypted/malformed/etc.) route response exits non-zero and reports the boundary", async () => {
    const runtime = fakeRuntime(() => ({
      status: 422,
      body: { error: "the source is password-protected and opencodex has no password-input channel yet; provide a decrypted copy", boundary: "encrypted" },
    }));
    const out = captureConsole();
    let code: number;
    try { code = await handlePdfCommand(["inspect", "C:\\a.pdf"], runtime.deps); }
    finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(out.lines.join("\n")).toMatch(/encrypted/);
  });

  test("every subcommand requires the arguments its usage line promises", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    try {
      expect(await handlePdfCommand(["split", "C:\\a.pdf"], runtime.deps)).not.toBe(0);
      expect(await handlePdfCommand(["merge", "--destination", "C:\\out.pdf"], runtime.deps)).not.toBe(0);
      expect(await handlePdfCommand(["rotate", "C:\\a.pdf", "--rotations", "1:90"], runtime.deps)).not.toBe(0);
      expect(await handlePdfCommand(["nonsense"], runtime.deps)).not.toBe(0);
    } finally { out.restore(); }
    expect(runtime.requests).toEqual([]);
  });
});
