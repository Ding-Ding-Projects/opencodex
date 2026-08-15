/**
 * The download-capture manager: real bytes over a real loopback socket for
 * every flow, including pause and resume — a second chunk held back by a
 * real server-side delay stands in for "the rest of the file has not arrived
 * yet", giving each test a genuine, bounded window to pause mid-transfer
 * without guessing at timing or mocking `fetch`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelDownload,
  captureDownload,
  confirmDownload,
  getDownload,
  listDownloads,
  pauseDownload,
  removeDownload,
  resetDownloadManagerForTests,
  resumeDownload,
  setFetchImplForTests,
} from "../src/lib/downloads/manager";
import { sanitizeFilename, uniqueDestinationPath } from "../src/lib/downloads/paths";
import { CaptureRejectedError, DownloadNotFoundError, DownloadStateError } from "../src/lib/downloads/types";
import { removeTempDir } from "./helpers/temp-dir";

let homeDir = "";
let downloadsDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "ocx-dlhome-"));
  downloadsDir = mkdtempSync(join(tmpdir(), "ocx-dldest-"));
  process.env.OPENCODEX_HOME = homeDir;
  resetDownloadManagerForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTempDir(homeDir);
  removeTempDir(downloadsDir);
  setFetchImplForTests(null);
  resetDownloadManagerForTests();
});

describe("captureDownload — refuses before anything is queued", () => {
  test("empty url", async () => {
    await expect(captureDownload({ url: "" })).rejects.toThrow(CaptureRejectedError);
  });

  test("unparseable url", async () => {
    await expect(captureDownload({ url: "not a url" })).rejects.toThrow(CaptureRejectedError);
  });

  test("file:// is refused — this is the guard that keeps a capture endpoint from becoming a local-file-read primitive", async () => {
    const err = await captureDownload({ url: "file:///etc/passwd" }).catch(e => e);
    expect(err).toBeInstanceOf(CaptureRejectedError);
    expect((err as InstanceType<typeof CaptureRejectedError>).reason).toBe("unsupported-protocol");
  });

  test("data: is refused", async () => {
    const err = await captureDownload({ url: "data:text/plain;base64,aGVsbG8=" }).catch(e => e);
    expect((err as InstanceType<typeof CaptureRejectedError>).reason).toBe("unsupported-protocol");
  });

  test("an oversized url is refused before parsing has a chance to normalize it", async () => {
    const huge = `https://example.com/${"a".repeat(5000)}`;
    const err = await captureDownload({ url: huge }).catch(e => e);
    expect((err as InstanceType<typeof CaptureRejectedError>).reason).toBe("url-too-long");
  });

  test("a valid http(s) url queues, with no bytes written yet — Confirm, not Capture, is what starts a transfer", async () => {
    const record = await captureDownload({ url: "https://example.com/report.pdf" });
    expect(record.state).toBe("queued");
    expect(record.destinationPath).toBeNull();
    expect(record.bytesReceived).toBe(0);
    expect(getDownload(record.id)?.id).toBe(record.id);
  });
});

describe("a real loopback transfer", () => {
  test("confirm streams real bytes to a real file, and the record ends completed with matching sizes", async () => {
    const payload = new Uint8Array(64 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(payload, { headers: { "Content-Type": "application/octet-stream" } }),
    });
    try {
      const record = await captureDownload({ url: `http://127.0.0.1:${server.port}/file.bin`, suggestedFilename: "file.bin" });
      const confirmed = await confirmDownload(record.id, { destinationDir: downloadsDir });
      expect(confirmed.state).toBe("downloading");
      expect(confirmed.destinationPath).toBe(join(downloadsDir, "file.bin"));

      // Poll the manager's own record rather than sleeping a guessed duration —
      // the transfer is genuinely async (`confirmDownload` does not await it).
      const deadline = Date.now() + 5000;
      let finalRecord = getDownload(record.id)!;
      while (finalRecord.state === "downloading" && Date.now() < deadline) {
        await Bun.sleep(10);
        finalRecord = getDownload(record.id)!;
      }

      expect(finalRecord.state).toBe("completed");
      expect(finalRecord.bytesReceived).toBe(payload.length);
      expect(finalRecord.bytesTotal).toBe(payload.length);
      expect(finalRecord.completedAt).not.toBeNull();
      expect(existsSync(finalRecord.destinationPath!)).toBe(true);
      expect(Buffer.compare(readFileSync(finalRecord.destinationPath!), Buffer.from(payload))).toBe(0);
      // No leftover temp file beside the finished download.
      expect(existsSync(`${finalRecord.destinationPath}.ocxdl.tmp`)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a second capture of the same filename gets '(1)' rather than overwriting the first", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("hello") });
    try {
      const first = await captureDownload({ url: `http://127.0.0.1:${server.port}/`, suggestedFilename: "dup.txt" });
      const confirmedFirst = await confirmDownload(first.id, { destinationDir: downloadsDir });
      await waitForTerminal(first.id);
      expect(confirmedFirst.destinationPath).toBe(join(downloadsDir, "dup.txt"));

      const second = await captureDownload({ url: `http://127.0.0.1:${server.port}/`, suggestedFilename: "dup.txt" });
      const confirmedSecond = await confirmDownload(second.id, { destinationDir: downloadsDir });
      expect(confirmedSecond.destinationPath).toBe(join(downloadsDir, "dup (1).txt"));
      await waitForTerminal(second.id);
    } finally {
      server.stop(true);
    }
  });

  test("a server error is reported as a plain sentence, never a stack trace, and never left as a phantom 'downloading'", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404, statusText: "Not Found" }) });
    try {
      const record = await captureDownload({ url: `http://127.0.0.1:${server.port}/missing.zip` });
      await confirmDownload(record.id, { destinationDir: downloadsDir });
      const final = await waitForTerminal(record.id);
      expect(final.state).toBe("error");
      expect(final.error).toContain("404");
      expect(final.error).not.toContain("at ");
    } finally {
      server.stop(true);
    }
  });

  test("cancel mid-transfer aborts the real socket and removes the partial temp file", async () => {
    let releaseChunk: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(1024));
        await new Promise<void>(resolve => { releaseChunk = resolve; });
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(stream, { headers: { "Content-Length": "2048" } }),
    });
    try {
      const record = await captureDownload({ url: `http://127.0.0.1:${server.port}/slow.bin`, suggestedFilename: "slow.bin" });
      await confirmDownload(record.id, { destinationDir: downloadsDir });

      const deadline = Date.now() + 5000;
      while (getDownload(record.id)!.bytesReceived === 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(getDownload(record.id)!.bytesReceived).toBeGreaterThan(0);

      const canceled = await cancelDownload(record.id);
      expect(canceled.state).toBe("canceled");
      expect(existsSync(join(downloadsDir, "slow.bin"))).toBe(false);
      expect(existsSync(join(downloadsDir, "slow.bin.ocxdl.tmp"))).toBe(false);
      releaseChunk?.();
    } finally {
      server.stop(true);
    }
  });
});

describe("pause and resume — a real server, with the second chunk held back so pause has a genuine window", () => {
  /**
   * The first request streams `first` immediately, then blocks for `holdMs`
   * before streaming `second` and closing — real network I/O, with a real
   * (short, bounded) delay standing in for "the rest of the file hasn't
   * arrived yet" rather than an indefinite gate this test would have to
   * remember to release. A resume request (one carrying a `Range` header)
   * always answers immediately with the appropriate slice.
   */
  function pausableServer(first: Uint8Array, second: Uint8Array, opts: { rangeSupport: boolean; holdMs?: number }) {
    const full = Buffer.concat([first, second]);
    return Bun.serve({
      port: 0,
      fetch(req) {
        const range = req.headers.get("range");
        if (range && opts.rangeSupport) {
          const offset = Number(range.match(/bytes=(\d+)-/)?.[1] ?? 0);
          const slice = full.subarray(offset);
          return new Response(slice, {
            status: 206,
            headers: {
              "Content-Length": String(slice.length),
              "Accept-Ranges": "bytes",
              "Content-Range": `bytes ${offset}-${full.length - 1}/${full.length}`,
            },
          });
        }
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(first);
            await Bun.sleep(opts.holdMs ?? 300);
            controller.enqueue(second);
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Length": String(full.length), "Accept-Ranges": opts.rangeSupport ? "bytes" : "none" },
        });
      },
    });
  }

  test("range-supporting server: pause keeps the partial bytes, resume appends the rest, final file is byte-correct", async () => {
    const a = new Uint8Array(500).fill(1);
    const b = new Uint8Array(500).fill(2);
    const server = pausableServer(a, b, { rangeSupport: true, holdMs: 600 });
    try {
      const record = await captureDownload({ url: `http://127.0.0.1:${server.port}/range.bin`, suggestedFilename: "range.bin" });
      await confirmDownload(record.id, { destinationDir: downloadsDir });

      const deadline = Date.now() + 3000;
      while (getDownload(record.id)!.bytesReceived < 500 && Date.now() < deadline) await Bun.sleep(5);
      expect(getDownload(record.id)!.bytesReceived).toBe(500);
      expect(getDownload(record.id)!.state).toBe("downloading"); // still waiting on the held-back second chunk

      const paused = await pauseDownload(record.id);
      expect(paused.state).toBe("paused");
      expect(paused.bytesReceived).toBe(500);
      expect(paused.resumable).toBe(true);

      const resumed = await resumeDownload(record.id);
      expect(resumed.state).toBe("downloading");
      const final = await waitForTerminal(record.id);
      expect(final.state).toBe("completed");
      expect(final.bytesReceived).toBe(1000);
      const written = readFileSync(join(downloadsDir, "range.bin"));
      expect(Buffer.compare(written, Buffer.concat([a, b]))).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("no range support: resume restarts from zero — the byte counter restarts with it rather than double-counting the aborted attempt", async () => {
    const a = new Uint8Array(300).fill(3);
    const b = new Uint8Array(300).fill(4);
    const server = pausableServer(a, b, { rangeSupport: false, holdMs: 600 });
    try {
      const record = await captureDownload({ url: `http://127.0.0.1:${server.port}/norange.bin`, suggestedFilename: "norange.bin" });
      await confirmDownload(record.id, { destinationDir: downloadsDir });

      const deadline = Date.now() + 3000;
      while (getDownload(record.id)!.bytesReceived < 300 && Date.now() < deadline) await Bun.sleep(5);
      expect(getDownload(record.id)!.bytesReceived).toBe(300);

      const paused = await pauseDownload(record.id);
      expect(paused.resumable).toBe(false); // no Accept-Ranges: bytes on the first response

      await resumeDownload(record.id);
      const final = await waitForTerminal(record.id);
      expect(final.state).toBe("completed");
      // The regression this proves: the counter must read 600 (the fresh
      // full-body length), never 300 (stale) + 600, which is what a resume
      // that forgot to reset `bytesReceived` before a non-appending write
      // would report.
      expect(final.bytesReceived).toBe(600);
      // `bytesTotal` is genuinely unknowable here rather than merely
      // untested: a `ReadableStream` body that spans more than one event-loop
      // tick makes Bun's own server switch to chunked transfer and drop the
      // `Content-Length` header it was asked to send (verified directly
      // against `Bun.serve` — a synchronous single-enqueue stream keeps the
      // header, an `await`-ing one does not), so the manager correctly reads
      // no total rather than inventing one. This is the same "unknown total"
      // case `pages/Downloads.tsx`'s indeterminate progress bar exists for.
      expect(final.bytesTotal).toBeNull();
      const written = readFileSync(join(downloadsDir, "norange.bin"));
      expect(Buffer.compare(written, Buffer.concat([a, b]))).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

describe("state machine refuses the wrong transitions", () => {
  test("cannot confirm a download twice", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    try {
      const record = await captureDownload({ url: `http://127.0.0.1:${server.port}/` });
      await confirmDownload(record.id, { destinationDir: downloadsDir });
      await expect(confirmDownload(record.id, { destinationDir: downloadsDir })).rejects.toThrow(DownloadStateError);
      await waitForTerminal(record.id);
    } finally {
      server.stop(true);
    }
  });

  test("cannot pause a queued download", async () => {
    const record = await captureDownload({ url: "https://example.test/x" });
    await expect(pauseDownload(record.id)).rejects.toThrow(DownloadStateError);
  });

  test("cannot remove an active download — must cancel first", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    try {
      const record = await captureDownload({ url: `http://127.0.0.1:${server.port}/` });
      await confirmDownload(record.id, { destinationDir: downloadsDir });
      await expect(removeDownload(record.id)).rejects.toThrow(DownloadStateError);
      await waitForTerminal(record.id);
      await removeDownload(record.id); // now terminal — this must succeed
      expect(getDownload(record.id)).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("operating on an unknown id reports which id, not a generic 500", async () => {
    await expect(pauseDownload("does-not-exist")).rejects.toThrow(DownloadNotFoundError);
  });

  test("canceling a queued (never-confirmed) capture needs no transfer to abort", async () => {
    const record = await captureDownload({ url: "https://example.test/never-confirmed" });
    const canceled = await cancelDownload(record.id);
    expect(canceled.state).toBe("canceled");
  });
});

describe("listDownloads", () => {
  test("newest first", async () => {
    const first = await captureDownload({ url: "https://example.test/a" });
    await Bun.sleep(2);
    const second = await captureDownload({ url: "https://example.test/b" });
    const list = listDownloads();
    expect(list[0].id).toBe(second.id);
    expect(list[1].id).toBe(first.id);
  });
});

describe("sanitizeFilename / uniqueDestinationPath — the path-safety half", () => {
  test("strips a smuggled directory traversal down to one safe segment", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\Windows\\system.ini")).toBe("system.ini");
  });

  test("neutralizes reserved Windows device names", () => {
    expect(sanitizeFilename("CON")).toBe("_CON");
    expect(sanitizeFilename("nul.txt")).toBe("_nul.txt");
  });

  test("never produces an empty name", () => {
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("...")).toBe("download");
    expect(sanitizeFilename("/")).toBe("download");
  });

  test("uniqueDestinationPath appends (1), (2), … rather than colliding", () => {
    // Built with the function's own `join` (via a first, unchecked call)
    // rather than hand-typed POSIX-style literals, so the assertion holds on
    // Windows too — `path.join` there produces backslash-separated paths, and
    // a Set keyed on forward slashes would never match them.
    const dir = join("d", "sub");
    const first = uniqueDestinationPath(dir, "a.txt", () => false);
    const second = uniqueDestinationPath(dir, "a.txt", () => false).replace(/a\.txt$/, "a (1).txt");
    const taken = new Set([first, second]);
    expect(uniqueDestinationPath(dir, "a.txt", p => taken.has(p))).toBe(join(dir, "a (2).txt"));
  });
});

async function waitForTerminal(id: string): Promise<import("../src/lib/downloads/types").DownloadRecord> {
  const deadline = Date.now() + 5000;
  let record = getDownload(id)!;
  while (record.state === "downloading" && Date.now() < deadline) {
    await Bun.sleep(5);
    record = getDownload(id)!;
  }
  return record;
}
