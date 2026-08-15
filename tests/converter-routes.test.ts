/**
 * `/api/converter/*` end to end: real HTTP request objects, a real
 * `ManagementContext`, real files on disk — the same shape
 * `tests/pdf-routes.test.ts` uses, so the loopback gate and the fs-facing
 * service actually agree once wired behind the route, not only in isolation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "../src/lib/export-archive";
import { handleConverterRoutes } from "../src/server/management/converter-routes";
import { setServerRef } from "../src/server/lifecycle";
import { removeTempDir } from "./helpers/temp-dir";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

function listeningOn(hostname: string | undefined): void {
  setServerRef(hostname === undefined ? undefined : ({ hostname, port: 10101 } as never));
}
afterEach(() => setServerRef(undefined));

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

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-converter-routes-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

describe("/api/converter/* — local-machine gate", () => {
  test("every route is refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const catalogRes = await handleConverterRoutes(ctx("/api/converter/catalog", "GET"));
    expect(catalogRes?.status).toBe(403);
    expect(await catalogRes!.json()).toMatchObject({ reason: "loopback-required" });

    const dir = tempDir();
    const path = join(dir, "a.pdf");
    writeFileSync(path, "%PDF-1.7\n%%EOF");
    const detectRes = await handleConverterRoutes(ctx("/api/converter/detect", "POST", { path }));
    expect(detectRes?.status).toBe(403);
  });

  test("refused when the listener is unknown", async () => {
    listeningOn(undefined);
    const res = await handleConverterRoutes(ctx("/api/converter/catalog", "GET"));
    expect(res?.status).toBe(403);
  });
});

describe("/api/converter/catalog", () => {
  test("returns every one of the eight categories, PDF enabled among them", async () => {
    listeningOn("127.0.0.1");
    const res = await handleConverterRoutes(ctx("/api/converter/catalog", "GET"));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { categories: { id: string; formats: { id: string; bundled: boolean }[] }[]; enabledFormats: number };
    expect(body.categories.map(c => c.id)).toEqual([
      "documents-pdf", "images", "audio", "video", "archives", "structured-data", "code-text", "binary-encodings",
    ]);
    const pdf = body.categories.find(c => c.id === "documents-pdf")!.formats.find(f => f.id === "pdf")!;
    expect(pdf.bundled).toBe(true);
    expect(body.enabledFormats).toBeGreaterThan(0);
  });
});

describe("/api/converter/detect", () => {
  test("detects a real PDF end to end through the route", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const path = join(dir, "a.pdf");
    writeFileSync(path, "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
    const res = await handleConverterRoutes(ctx("/api/converter/detect", "POST", { path }));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; formatId: string; category: string };
    expect(body.ok).toBe(true);
    expect(body.formatId).toBe("pdf");
    expect(body.category).toBe("documents-pdf");
  });

  test("rejects a relative path with 400", async () => {
    listeningOn("127.0.0.1");
    const res = await handleConverterRoutes(ctx("/api/converter/detect", "POST", { path: "relative.bin" }));
    expect(res?.status).toBe(400);
  });

  test("reports a missing source as an honest 200-with-boundary, not a crash", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const res = await handleConverterRoutes(ctx("/api/converter/detect", "POST", { path: join(dir, "missing.bin") }));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; boundary: string };
    expect(body.ok).toBe(false);
    expect(body.boundary).toBe("unreadable");
  });

  test("invalid JSON body is a 400, not a 500", async () => {
    listeningOn("127.0.0.1");
    const url = new URL("http://127.0.0.1:10101/api/converter/detect");
    const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    const res = await handleConverterRoutes({
      req, url, config: { port: 10101, hostname: "127.0.0.1", providers: {} } as OcxConfig,
      deps: {} as ManagementContext["deps"],
      refreshCodexCatalogBestEffort: async () => {}, syncClaudeAgentDefsBestEffort: async () => {},
    });
    expect(res?.status).toBe(400);
  });
});

describe("/api/converter/extract-zip", () => {
  test("extracts a real ZIP end to end through the route", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const zipPath = join(dir, "archive.zip");
    writeFileSync(zipPath, buildZip([
      { path: "readme.txt", data: new TextEncoder().encode("hello from the route") },
      { path: "sub/nested.txt", data: new TextEncoder().encode("nested") },
    ]));
    const destDir = join(dir, "extracted");
    const res = await handleConverterRoutes(ctx("/api/converter/extract-zip", "POST", { path: zipPath, destination: destDir }));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; destination: string; entryCount: number; bytesWritten: number };
    expect(body.ok).toBe(true);
    expect(body.entryCount).toBe(2);
    expect(existsSync(join(destDir, "readme.txt"))).toBe(true);
    expect(readFileSync(join(destDir, "readme.txt"), "utf-8")).toBe("hello from the route");
    expect(readFileSync(join(destDir, "sub/nested.txt"), "utf-8")).toBe("nested");
  });

  test("refuses a relative path with 400", async () => {
    listeningOn("127.0.0.1");
    const res = await handleConverterRoutes(ctx("/api/converter/extract-zip", "POST", { path: "a.zip", destination: "b" }));
    expect(res?.status).toBe(400);
  });

  test("refuses a relative destination with 400", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const zipPath = join(dir, "archive.zip");
    writeFileSync(zipPath, buildZip([{ path: "a.txt", data: new TextEncoder().encode("a") }]));
    const res = await handleConverterRoutes(ctx("/api/converter/extract-zip", "POST", { path: zipPath, destination: "relative" }));
    expect(res?.status).toBe(400);
  });

  test("a malformed archive is reported as an honest 422 with its boundary, not a crash", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const badPath = join(dir, "notreally.zip");
    writeFileSync(badPath, "this is not a zip file");
    const destDir = join(dir, "out");
    const res = await handleConverterRoutes(ctx("/api/converter/extract-zip", "POST", { path: badPath, destination: destDir }));
    expect(res?.status).toBe(422);
    const body = await res!.json() as { error: string; boundary: string };
    expect(body.boundary).toBe("malformed");
    expect(existsSync(destDir)).toBe(false);
  });

  test("refuses to overwrite an already-existing destination, and never touches its content", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const zipPath = join(dir, "archive.zip");
    writeFileSync(zipPath, buildZip([{ path: "a.txt", data: new TextEncoder().encode("a") }]));
    const destDir = join(dir, "already-here");
    mkdirSync(destDir);
    writeFileSync(join(destDir, "keep.txt"), "do not touch me");
    const res = await handleConverterRoutes(ctx("/api/converter/extract-zip", "POST", { path: zipPath, destination: destDir }));
    expect(res?.status).toBe(422);
    expect(readFileSync(join(destDir, "keep.txt"), "utf-8")).toBe("do not touch me");
  });
});

describe("/api/converter/convert-structured", () => {
  test("converts a real JSON file to CSV end to end through the route, disclosing the lossy note", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ name: "Ada", role: "engineer" }]));
    const dest = join(dir, "out.csv");
    const res = await handleConverterRoutes(ctx("/api/converter/convert-structured", "POST", {
      path: src, sourceFormat: "json", destination: dest, destFormat: "csv", acknowledgeLossy: true,
    }));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; path: string; lossy: boolean; notes?: string[] };
    expect(body.ok).toBe(true);
    expect(body.lossy).toBe(true);
    expect(body.notes?.length).toBeGreaterThan(0);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toContain("Ada,engineer");
  });

  test("refuses a lossy conversion through the route with 422 lossy-not-acknowledged when acknowledgeLossy is omitted — the route/service enforces this itself, not only the GUI's own toggle", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ name: "Ada", role: "engineer" }]));
    const dest = join(dir, "out.csv");
    const res = await handleConverterRoutes(ctx("/api/converter/convert-structured", "POST", {
      path: src, sourceFormat: "json", destination: dest, destFormat: "csv",
    }));
    expect(res?.status).toBe(422);
    const body = await res!.json() as { error: string; boundary: string; lossy?: boolean };
    expect(body.boundary).toBe("lossy-not-acknowledged");
    expect(body.error).toContain("acknowledgeLossy: true");
    expect(existsSync(dest)).toBe(false);
  });

  test("rejects a non-boolean acknowledgeLossy with 400, before any file is touched", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ name: "Ada" }]));
    const dest = join(dir, "out.csv");
    const res = await handleConverterRoutes(ctx("/api/converter/convert-structured", "POST", {
      path: src, sourceFormat: "json", destination: dest, destFormat: "csv", acknowledgeLossy: "yes",
    }));
    expect(res?.status).toBe(400);
    expect(existsSync(dest)).toBe(false);
  });

  test("converts a real CSV file to JSON end to end through the route", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "in.csv");
    writeFileSync(src, "a,b\r\n1,2\r\n");
    const dest = join(dir, "out.json");
    const res = await handleConverterRoutes(ctx("/api/converter/convert-structured", "POST", {
      path: src, sourceFormat: "csv", destination: dest, destFormat: "json",
    }));
    expect(res?.status).toBe(200);
    expect(JSON.parse(readFileSync(dest, "utf-8"))).toEqual([{ a: "1", b: "2" }]);
  });

  test("rejects an unknown sourceFormat with 400", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const res = await handleConverterRoutes(ctx("/api/converter/convert-structured", "POST", {
      path: join(dir, "in.json"), sourceFormat: "yaml", destination: join(dir, "out.json"), destFormat: "json",
    }));
    expect(res?.status).toBe(400);
  });

  test("rejects an unknown destFormat with 400", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const res = await handleConverterRoutes(ctx("/api/converter/convert-structured", "POST", {
      path: join(dir, "in.json"), sourceFormat: "json", destination: join(dir, "out.toml"), destFormat: "toml",
    }));
    expect(res?.status).toBe(400);
  });

  test("malformed JSON input is reported as an honest 422 with its boundary, not a crash", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, "{not valid json");
    const dest = join(dir, "out.csv");
    const res = await handleConverterRoutes(ctx("/api/converter/convert-structured", "POST", {
      path: src, sourceFormat: "json", destination: dest, destFormat: "csv",
    }));
    expect(res?.status).toBe(422);
    const body = await res!.json() as { error: string; boundary: string };
    expect(body.boundary).toBe("malformed");
    expect(existsSync(dest)).toBe(false);
  });
});

describe("routes not under /api/converter/ are ignored", () => {
  test("returns null so other route handlers get a turn", async () => {
    listeningOn("127.0.0.1");
    const res = await handleConverterRoutes(ctx("/api/pdf/inspect", "POST", {}));
    expect(res).toBeNull();
  });
});
