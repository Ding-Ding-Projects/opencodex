import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { handlePdfRoutes } from "../src/server/management/pdf-routes";
import { setServerRef } from "../src/server/lifecycle";
import { encryptedPdfBytes, makePdf } from "./helpers/pdf-fixtures";
import { removeTempDir } from "./helpers/temp-dir";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

/**
 * `/api/pdf/*` end to end: real HTTP request objects, a real
 * `ManagementContext`, real files on disk — the same shape
 * `tests/local-machine-actions-gate.test.ts` uses for the export/host routes'
 * loopback gate, so this file proves the gate and the fs-facing service
 * actually agree once wired behind the route, not only in isolation.
 */

function listeningOn(hostname: string | undefined): void {
  setServerRef(hostname === undefined ? undefined : ({ hostname, port: 10100 } as never));
}
afterEach(() => setServerRef(undefined));

function ctx(pathname: string, method: string, body?: unknown): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    }),
    url,
    config: { port: 10100, hostname: "127.0.0.1", providers: {} } as OcxConfig,
    deps: {} as ManagementContext["deps"],
    refreshCodexCatalogBestEffort: async () => {},
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-pdf-routes-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

describe("/api/pdf/* — local-machine gate", () => {
  test("every route is refused when the listener is not loopback", async () => {
    listeningOn("0.0.0.0");
    const dir = tempDir();
    const path = join(dir, "a.pdf");
    writeFileSync(path, await makePdf([[1, 1]]));
    const res = await handlePdfRoutes(ctx("/api/pdf/inspect", "POST", { path }));
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ reason: "loopback-required" });
  });

  test("refused when the listener is unknown", async () => {
    listeningOn(undefined);
    const res = await handlePdfRoutes(ctx("/api/pdf/inspect", "POST", { path: "C:\\anything.pdf" }));
    expect(res?.status).toBe(403);
  });
});

describe("/api/pdf/inspect", () => {
  test("inspects a real file end to end", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const path = join(dir, "a.pdf");
    writeFileSync(path, await makePdf([[100, 200]], { title: "Route test" }));
    const res = await handlePdfRoutes(ctx("/api/pdf/inspect", "POST", { path }));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { capabilities: { ok: boolean; pageCount: number }; metadata: { title: string } };
    expect(body.capabilities.ok).toBe(true);
    expect(body.capabilities.pageCount).toBe(1);
    expect(body.metadata.title).toBe("Route test");
  });

  test("reports the encrypted boundary with 422", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const path = join(dir, "enc.pdf");
    writeFileSync(path, encryptedPdfBytes());
    const res = await handlePdfRoutes(ctx("/api/pdf/inspect", "POST", { path }));
    expect(res?.status).toBe(200); // inspect always 200s; the boundary lives inside capabilities
    const body = await res!.json() as { capabilities: { ok: boolean; boundary: string } };
    expect(body.capabilities.ok).toBe(false);
    expect(body.capabilities.boundary).toBe("encrypted");
  });

  test("rejects a relative path with 400", async () => {
    listeningOn("127.0.0.1");
    const res = await handlePdfRoutes(ctx("/api/pdf/inspect", "POST", { path: "relative.pdf" }));
    expect(res?.status).toBe(400);
  });

  test("rejects a missing source path with a boundary-carrying 422, not a crash", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const res = await handlePdfRoutes(ctx("/api/pdf/inspect", "POST", { path: join(dir, "missing.pdf") }));
    expect(res?.status).toBe(422);
    const body = await res!.json() as { error: string };
    expect(body.error).toBeTruthy();
  });
});

describe("/api/pdf/rotate — writes a real file, reopened and validated", () => {
  test("rotates a page and the written file reflects it", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "src.pdf");
    const dest = join(dir, "rotated.pdf");
    writeFileSync(src, await makePdf([[10, 10], [20, 20]]));
    const res = await handlePdfRoutes(ctx("/api/pdf/rotate", "POST", {
      path: src, destination: dest, rotations: [{ page: 2, degrees: 90 }],
    }));
    expect(res?.status).toBe(200);
    const doc = await PDFDocument.load(readFileSync(dest));
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
  });

  test("refuses a signed source without acknowledgeSigned, and succeeds with it", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "signed.pdf");
    const dest = join(dir, "out.pdf");
    const { signedLookingPdfBytes } = await import("./helpers/pdf-fixtures");
    writeFileSync(src, await signedLookingPdfBytes());

    const refused = await handlePdfRoutes(ctx("/api/pdf/rotate", "POST", {
      path: src, destination: dest, rotations: [{ page: 1, degrees: 90 }],
    }));
    expect(refused?.status).toBe(422);

    const ok = await handlePdfRoutes(ctx("/api/pdf/rotate", "POST", {
      path: src, destination: dest, rotations: [{ page: 1, degrees: 90 }], acknowledgeSigned: true,
    }));
    expect(ok?.status).toBe(200);
  });
});

describe("/api/pdf/split — one destination per range, real files", () => {
  test("mismatched destinations/ranges is a 400 before any worker runs", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "src.pdf");
    writeFileSync(src, await makePdf([[1, 1], [2, 2]]));
    const res = await handlePdfRoutes(ctx("/api/pdf/split", "POST", {
      path: src, ranges: [{ start: 1, end: 1 }, { start: 2, end: 2 }], destinations: [join(dir, "one.pdf")],
    }));
    // Not a source-content boundary — a mismatched request shape, caught before
    // any file is read, so it is unprocessable at the request level, same as
    // this route's own upfront field validation.
    expect(res?.status).toBe(422);
    expect((await res!.json() as { error: string }).error).toMatch(/destination paths/);
  });

  test("writes every range to a real file", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "src.pdf");
    writeFileSync(src, await makePdf([[1, 1], [2, 2], [3, 3]]));
    const outA = join(dir, "a.pdf");
    const outB = join(dir, "b.pdf");
    const res = await handlePdfRoutes(ctx("/api/pdf/split", "POST", {
      path: src,
      ranges: [{ start: 1, end: 1 }, { start: 2, end: 3 }],
      destinations: [outA, outB],
    }));
    expect(res?.status).toBe(200);
    expect((await PDFDocument.load(readFileSync(outA))).getPageCount()).toBe(1);
    expect((await PDFDocument.load(readFileSync(outB))).getPageCount()).toBe(2);
  });
});

describe("/api/pdf/metadata", () => {
  test("GET reads, POST writes, both against real files", async () => {
    listeningOn("127.0.0.1");
    const dir = tempDir();
    const src = join(dir, "meta.pdf");
    writeFileSync(src, await makePdf([[1, 1]], { title: "before" }));

    const read = await handlePdfRoutes(ctx(`/api/pdf/metadata?path=${encodeURIComponent(src)}`, "GET"));
    expect(read?.status).toBe(200);
    expect((await read!.json() as { title: string }).title).toBe("before");

    const dest = join(dir, "out.pdf");
    const write = await handlePdfRoutes(ctx("/api/pdf/metadata", "POST", {
      path: src, destination: dest, fields: { title: "after" },
    }));
    expect(write?.status).toBe(200);
    expect((await PDFDocument.load(readFileSync(dest))).getTitle()).toBe("after");
  });
});
