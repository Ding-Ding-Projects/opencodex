/**
 * `ocx convert` — proves it hits exactly the routes
 * `src/server/management/converter-routes.ts` exposes, the same headless-
 * parity discipline `tests/cli-pdf.test.ts` already established.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleConvertCommand } from "../src/cli/converter";

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

describe("ocx convert", () => {
  test("catalog hits GET /api/converter/catalog and reports enabled/disabled honestly", async () => {
    const runtime = fakeRuntime(() => ({
      body: {
        categories: [
          { id: "documents-pdf", label: "Documents / PDF", formats: [
            { id: "pdf", label: "PDF", bundled: true, operations: ["inspect", "split"] },
            { id: "docx", label: "DOCX", bundled: false, reason: "no bundled document engine" },
          ] },
        ],
        totalFormats: 2, enabledFormats: 1,
      },
    }));
    const out = captureConsole();
    let code: number;
    try { code = await handleConvertCommand(["catalog", "--json"], runtime.deps); }
    finally { out.restore(); }
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{ path: "/api/converter/catalog", method: "GET", body: null }]);
  });

  test("catalog's human-readable output names PDF as bundled and DOCX's exact reason", async () => {
    const runtime = fakeRuntime(() => ({
      body: {
        categories: [
          { id: "documents-pdf", label: "Documents / PDF", formats: [
            { id: "pdf", label: "PDF", bundled: true, operations: ["inspect"] },
            { id: "docx", label: "DOCX", bundled: false, reason: "no bundled document engine ships in this install" },
          ] },
        ],
        totalFormats: 2, enabledFormats: 1,
      },
    }));
    const out = captureConsole();
    try { await handleConvertCommand(["catalog"], runtime.deps); }
    finally { out.restore(); }
    const printed = out.lines.join("\n");
    expect(printed).toContain("PDF — bundled, enabled");
    expect(printed).toContain("DOCX — disabled: no bundled document engine ships in this install");
  });

  test("detect sends the path to POST /api/converter/detect", async () => {
    const runtime = fakeRuntime(() => ({ body: { ok: true, formatId: "pdf", category: "documents-pdf", evidence: "found the %PDF- header", bytesInspected: 4100 } }));
    const out = captureConsole();
    let code: number;
    try { code = await handleConvertCommand(["detect", "C:\\docs\\a.pdf", "--json"], runtime.deps); }
    finally { out.restore(); }
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{ path: "/api/converter/detect", method: "POST", body: { path: "C:\\docs\\a.pdf" } }]);
  });

  test("detect with no path is a usage error, not a request", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    let code: number;
    try { code = await handleConvertCommand(["detect"], runtime.deps); }
    finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(runtime.requests).toHaveLength(0);
  });

  test("an unknown subcommand is a usage error", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    let code: number;
    try { code = await handleConvertCommand(["nonsense"], runtime.deps); }
    finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(runtime.requests).toHaveLength(0);
  });
});
