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

  test("extract-zip sends path and destination to POST /api/converter/extract-zip", async () => {
    const runtime = fakeRuntime(() => ({
      body: { ok: true, destination: "C:\\out\\extracted", entryCount: 3, bytesWritten: 4096 },
    }));
    const out = captureConsole();
    let code: number;
    try {
      code = await handleConvertCommand(
        ["extract-zip", "C:\\docs\\archive.zip", "--destination", "C:\\out\\extracted", "--json"],
        runtime.deps,
      );
    } finally { out.restore(); }
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/converter/extract-zip",
      method: "POST",
      body: { path: "C:\\docs\\archive.zip", destination: "C:\\out\\extracted" },
    }]);
  });

  test("extract-zip's human-readable output names the entry count and destination", async () => {
    const runtime = fakeRuntime(() => ({ body: { ok: true, destination: "C:\\out", entryCount: 5, bytesWritten: 1 } }));
    const out = captureConsole();
    try { await handleConvertCommand(["extract-zip", "C:\\docs\\archive.zip", "--destination", "C:\\out"], runtime.deps); }
    finally { out.restore(); }
    expect(out.lines.join("\n")).toContain("Extracted 5 item(s) to C:\\out");
  });

  test("extract-zip with no --destination is a usage error, not a request", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    let code: number;
    try { code = await handleConvertCommand(["extract-zip", "C:\\docs\\archive.zip"], runtime.deps); }
    finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(runtime.requests).toHaveLength(0);
  });

  test("extract-zip surfaces a refused conversion's boundary rather than a raw 422", async () => {
    const runtime = fakeRuntime(() => ({ status: 422, body: { error: "the archive is malformed", boundary: "malformed" } }));
    const out = captureConsole();
    let code: number;
    try { code = await handleConvertCommand(["extract-zip", "C:\\docs\\bad.zip", "--destination", "C:\\out"], runtime.deps); }
    finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(out.lines.join("\n")).toContain("Refused (malformed): the archive is malformed");
  });

  test("structured sends path, --from, --to and --destination to POST /api/converter/convert-structured", async () => {
    const runtime = fakeRuntime(() => ({ body: { ok: true, path: "C:\\out\\a.csv", bytesWritten: 10, lossy: true, notes: ["numbers become plain text"] } }));
    const out = captureConsole();
    let code: number;
    try {
      code = await handleConvertCommand(
        ["structured", "C:\\docs\\a.json", "--from", "json", "--to", "csv", "--destination", "C:\\out\\a.csv", "--json"],
        runtime.deps,
      );
    } finally { out.restore(); }
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/converter/convert-structured",
      method: "POST",
      body: { path: "C:\\docs\\a.json", sourceFormat: "json", destination: "C:\\out\\a.csv", destFormat: "csv" },
    }]);
  });

  test("structured's human-readable output names the conversion and echoes lossy notes", async () => {
    const runtime = fakeRuntime(() => ({ body: { ok: true, path: "C:\\out\\a.csv", bytesWritten: 10, lossy: true, notes: ["numbers become plain text"] } }));
    const out = captureConsole();
    try {
      await handleConvertCommand(
        ["structured", "C:\\docs\\a.json", "--from", "json", "--to", "csv", "--destination", "C:\\out\\a.csv"],
        runtime.deps,
      );
    } finally { out.restore(); }
    const printed = out.lines.join("\n");
    expect(printed).toContain("Converted json -> csv, wrote C:\\out\\a.csv");
    expect(printed).toContain("Note: numbers become plain text");
  });

  test("structured rejects an unknown --from before making a request", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    let code: number;
    try {
      code = await handleConvertCommand(
        ["structured", "C:\\docs\\a.yaml", "--from", "yaml", "--to", "json", "--destination", "C:\\out\\a.json"],
        runtime.deps,
      );
    } finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(runtime.requests).toHaveLength(0);
  });

  test("structured with missing --destination is a usage error, not a request", async () => {
    const runtime = fakeRuntime();
    const out = captureConsole();
    let code: number;
    try { code = await handleConvertCommand(["structured", "C:\\docs\\a.json", "--from", "json", "--to", "csv"], runtime.deps); }
    finally { out.restore(); }
    expect(code).not.toBe(0);
    expect(runtime.requests).toHaveLength(0);
  });
});
