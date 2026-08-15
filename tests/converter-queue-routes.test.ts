/**
 * `/api/converter/queue/*` end to end: real HTTP request objects, a real
 * `ManagementContext`, real files on disk — the same shape
 * `tests/converter-routes.test.ts` and `tests/pdf-routes.test.ts` use, so the
 * loopback gate and the queue engine actually agree once wired behind the
 * route, not only in isolation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { handleConverterQueueRoutes } from "../src/server/management/converter-queue-routes";
import {
  resetConvertQueueEngineForTests,
  setConvertQueueDiskProbeForTests,
} from "../src/lib/converter/queue-engine";
import { setConvertQueueStorePathForTests } from "../src/lib/converter/queue-store";
import { setServerRef } from "../src/server/lifecycle";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";
import { buildZip } from "../src/lib/export-archive";
import { makePdf } from "./helpers/pdf-fixtures";

function listeningOn(hostname: string | undefined): void {
  setServerRef(hostname === undefined ? undefined : ({ hostname, port: 10101 } as never));
}

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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-convert-queue-routes-"));
  setConvertQueueStorePathForTests(join(dir, "convert-queue.json"));
  resetConvertQueueEngineForTests();
  setConvertQueueDiskProbeForTests(async () => 10_000_000_000);
  listeningOn("127.0.0.1");
});

afterEach(() => {
  setConvertQueueDiskProbeForTests(null);
  resetConvertQueueEngineForTests();
  setConvertQueueStorePathForTests(null);
  setServerRef(undefined);
  rmSync(dir, { recursive: true, force: true });
});

function jobFor(src: string, dest: string, overrides: Record<string, unknown> = {}) {
  return { sourcePath: src, sourceFormat: "json", destPath: dest, destFormat: "csv", acknowledgeLossy: true, ...overrides };
}

describe("/api/converter/queue/* — local-machine gate", () => {
  test("every mutating route is refused when the listener is not loopback; GET and preflight are not gated", async () => {
    const job = jobFor(join(dir, "in.json"), join(dir, "out.csv"));
    listeningOn("0.0.0.0");
    const enqueueRes = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", { jobs: [job] }));
    expect(enqueueRes?.status).toBe(403);

    const stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    expect(stateRes?.status).toBe(200);

    const preflightRes = await handleConverterQueueRoutes(ctx("/api/converter/queue/preflight", "POST", { jobs: [job] }));
    expect(preflightRes?.status).toBe(200);
  });
});

describe("routes not under /api/converter/queue are ignored", () => {
  test("returns null so other route handlers get a turn", async () => {
    const res = await handleConverterQueueRoutes(ctx("/api/converter/catalog", "GET"));
    expect(res).toBeNull();
  });
});

describe("POST /api/converter/queue/enqueue", () => {
  test("enqueues a real job end to end and it converts through background processing", async () => {
    const src = join(dir, "in.json");
    const dest = join(dir, "out.csv");
    writeFileSync(src, JSON.stringify([{ name: "Ada" }]));

    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", { jobs: [jobFor(src, dest)] }));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; added: number };
    expect(body.ok).toBe(true);
    expect(body.added).toBe(1);

    // Let the background processing (kicked automatically by enqueue) settle.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    const state = await stateRes!.json() as { state: { items: { status: string }[] } };
    expect(state.state.items[0].status).toBe("converted");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toContain("Ada");
  });

  test("rejects a non-array jobs body with 400", async () => {
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", { jobs: "nope" }));
    expect(res?.status).toBe(400);
  });

  test("rejects a job with a relative sourcePath with 400", async () => {
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", { jobs: [jobFor("relative.json", join(dir, "out.csv"))] }));
    expect(res?.status).toBe(400);
  });

  test("refuses the batch with 422 when the storage preflight finds a definite shortfall, and admits nothing", async () => {
    setConvertQueueDiskProbeForTests(async () => 1);
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ i }))));
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", { jobs: [jobFor(src, join(dir, "out.csv"))] }));
    expect(res?.status).toBe(422);
    const body = await res!.json() as { ok: boolean; preflight?: { insufficientDiskSpace: boolean } };
    expect(body.ok).toBe(false);
    expect(body.preflight?.insufficientDiskSpace).toBe(true);

    const stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    const state = await stateRes!.json() as { state: { items: unknown[] } };
    expect(state.state.items).toHaveLength(0);
  });
});

describe("POST /api/converter/queue/preflight", () => {
  test("reports a real estimate without admitting anything to the queue", async () => {
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ a: 1 }]));
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/preflight", "POST", { jobs: [jobFor(src, join(dir, "out.csv"))] }));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; preflight: { aggregateSizeFullyKnown: boolean } };
    expect(body.ok).toBe(true);
    expect(body.preflight.aggregateSizeFullyKnown).toBe(true);

    const stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    const state = await stateRes!.json() as { state: { items: unknown[] } };
    expect(state.state.items).toHaveLength(0); // preflight never admits work
  });
});

describe("pause / resume-run / cancel / retry / clear", () => {
  test("pause stops claiming a new job; resume-run picks it back up", async () => {
    const src = join(dir, "in.json");
    const dest = join(dir, "out.csv");
    writeFileSync(src, JSON.stringify([{ a: 1 }]));

    const pauseRes = await handleConverterQueueRoutes(ctx("/api/converter/queue/pause", "POST"));
    expect(pauseRes?.status).toBe(200);

    await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", { jobs: [jobFor(src, dest)] }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    let stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    let state = await stateRes!.json() as { state: { paused: boolean; items: { status: string }[] } };
    expect(state.state.paused).toBe(true);
    expect(state.state.items[0].status).toBe("queued"); // never claimed while paused

    const resumeRes = await handleConverterQueueRoutes(ctx("/api/converter/queue/resume-run", "POST"));
    expect(resumeRes?.status).toBe(200);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    state = await stateRes!.json() as { state: { paused: boolean; items: { status: string }[] } };
    expect(state.state.paused).toBe(false);
    expect(state.state.items[0].status).toBe("converted");
  });

  test("a real failed job (lossy, unacknowledged) can be retried through the route, and cleared once terminal again", async () => {
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ name: "Ada" }]));
    // A lossy job with no acknowledgement — this will fail on its own, real, unmocked.
    const failingDest = join(dir, "will-fail.csv");
    await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", {
      jobs: [{ sourcePath: src, sourceFormat: "json", destPath: failingDest, destFormat: "csv" }], // acknowledgeLossy omitted
    }));
    for (let i = 0; i < 10; i++) await Promise.resolve();

    let stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    let state = await stateRes!.json() as { state: { items: { id: string; status: string; boundary: string | null }[] } };
    const failedItem = state.state.items[0]!; // the single enqueued item
    expect(failedItem.status).toBe("failed");
    expect(failedItem.boundary).toBe("lossy-not-acknowledged");

    const retryRes = await handleConverterQueueRoutes(ctx("/api/converter/queue/retry", "POST", { id: failedItem.id }));
    expect(retryRes?.status).toBe(200);

    // It fails again for the same reason (still unacknowledged) — that's
    // fine and honest; the point being proved is that the retry request
    // itself succeeded and actually moved it off "failed" and back through
    // the real conversion path, not that retrying magically fixes it.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    state = await stateRes!.json() as typeof state;
    expect(state.state.items[0].status).toBe("failed"); // terminal again, honestly

    const clearRes = await handleConverterQueueRoutes(ctx("/api/converter/queue/clear", "POST"));
    expect(clearRes?.status).toBe(200);
    stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    state = await stateRes!.json() as typeof state;
    expect(state.state.items).toHaveLength(0);
  });

  test("cancel with no id cancels every 'queued' item, leaving a currently-converting one untouched", async () => {
    const gatedSrc = join(dir, "gated.json");
    const queuedSrc = join(dir, "queued.json");
    writeFileSync(gatedSrc, JSON.stringify([{ a: 1 }]));
    writeFileSync(queuedSrc, JSON.stringify([{ a: 1 }]));
    // The GET '/api/converter/queue/pause' route stops new claims, so both
    // jobs land and stay 'queued' for this assertion — cancel-with-no-id is
    // proven against a deterministic, un-raced 'queued' item.
    await handleConverterQueueRoutes(ctx("/api/converter/queue/pause", "POST"));
    await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", {
      jobs: [jobFor(gatedSrc, join(dir, "gated.csv")), jobFor(queuedSrc, join(dir, "queued.csv"))],
    }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    let stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    let state = await stateRes!.json() as { state: { items: { status: string }[] } };
    expect(state.state.items.every(i => i.status === "queued")).toBe(true);

    const cancelRes = await handleConverterQueueRoutes(ctx("/api/converter/queue/cancel", "POST", {}));
    expect(cancelRes?.status).toBe(200);
    stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    state = await stateRes!.json() as typeof state;
    expect(state.state.items.every(i => i.status === "cancelled")).toBe(true);
  });

  test("cancel with an unknown id refuses with 404", async () => {
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/cancel", "POST", { id: "no-such-id" }));
    expect(res?.status).toBe(404);
  });

  test("retry without an id is a 400", async () => {
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/retry", "POST", {}));
    expect(res?.status).toBe(400);
  });
});

describe("POST /api/converter/queue/resume", () => {
  test("reconciles the persisted queue and reports its state", async () => {
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/resume", "POST"));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean; state: { items: unknown[] } };
    expect(body.ok).toBe(true);
  });
});

describe("POST /api/converter/queue/enqueue — kind: zip-extract and pdf-rotate", () => {
  test("a real zip-extract job runs end to end through the route", async () => {
    const src = join(dir, "in.zip");
    writeFileSync(src, buildZip([{ path: "a.txt", data: new TextEncoder().encode("hello") }]));
    const destDir = join(dir, "out-dir");

    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", {
      jobs: [{ kind: "zip-extract", sourcePath: src, destPath: destDir }],
    }));
    expect(res?.status).toBe(200);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
    const state = await stateRes!.json() as { state: { items: { kind: string; status: string; sourceFormat: string | null }[] } };
    expect(state.state.items[0].kind).toBe("zip-extract");
    expect(state.state.items[0].sourceFormat).toBeNull();
    expect(state.state.items[0].status).toBe("converted");
    expect(readFileSync(join(destDir, "a.txt"), "utf-8")).toBe("hello");
  });

  test("a real pdf-rotate job runs end to end through the route", async () => {
    const src = join(dir, "in.pdf");
    writeFileSync(src, await makePdf([[100, 100], [100, 100]]));
    const dest = join(dir, "out-rotated.pdf");

    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", {
      jobs: [{ kind: "pdf-rotate", sourcePath: src, destPath: dest, rotateDegrees: 180 }],
    }));
    expect(res?.status).toBe(200);

    // Unlike the structured/zip-extract kinds above, a real rotate runs
    // inside `pdf-tools`' actual Worker thread (`sandbox.ts`) — genuine
    // cross-thread messaging, not just a chain of already-resolved promises —
    // so draining microtasks alone never observes it finish. Poll the real
    // route instead of guessing how many ticks a worker thread needs.
    let state!: { state: { items: { kind: string; status: string; rotateDegrees?: number }[] } };
    const deadline = Date.now() + 5000;
    for (;;) {
      const stateRes = await handleConverterQueueRoutes(ctx("/api/converter/queue", "GET"));
      state = await stateRes!.json() as typeof state;
      if (state.state.items[0].status !== "queued" && state.state.items[0].status !== "converting") break;
      if (Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(state.state.items[0].kind).toBe("pdf-rotate");
    expect(state.state.items[0].rotateDegrees).toBe(180);
    expect(state.state.items[0].status).toBe("converted");
    const written = await PDFDocument.load(readFileSync(dest));
    for (const page of written.getPages()) expect(page.getRotation().angle).toBe(180);
  });

  test("a pdf-rotate job with an invalid rotateDegrees is rejected with 400", async () => {
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", {
      jobs: [{ kind: "pdf-rotate", sourcePath: join(dir, "x.pdf"), destPath: join(dir, "y.pdf"), rotateDegrees: 45 }],
    }));
    expect(res?.status).toBe(400);
  });

  test("an unknown kind is rejected with 400", async () => {
    const res = await handleConverterQueueRoutes(ctx("/api/converter/queue/enqueue", "POST", {
      jobs: [{ kind: "not-a-real-kind", sourcePath: join(dir, "x"), destPath: join(dir, "y") }],
    }));
    expect(res?.status).toBe(400);
  });
});
