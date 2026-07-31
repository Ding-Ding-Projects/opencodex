/**
 * The three routes behind "save the logs to a file, and let me undo deleting them",
 * exercised through the real management API rather than their modules.
 *
 * The unit tests in `log-store.test.ts` prove the snapshot/delete ordering. These
 * prove the wiring: that the routes exist at the paths the dashboard calls, that
 * `DELETE` re-seeds the in-memory ring the Logs screen actually reads, and that a
 * restore puts the rows back into that ring without a restart. Each of those is a
 * failure the module tests cannot see, because each lives in the seam between the
 * module and the server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { clearRequestLogsForTests, getRequestLogEntries } from "../src/server/request-log";
import { resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { appLogPath, listAppLogFiles } from "../src/lib/app-log-file";
import { usageLogPath } from "../src/usage/log";
import { removeTempDir } from "./helpers/temp-dir";
import type { OcxConfig } from "../src/types";

const config = { providers: [] } as unknown as OcxConfig;

let dir = "";
let previousHome: string | undefined;

async function call(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  // `Host` is what the management origin guard derives the allowed origin from.
  // A browser always sends it; a hand-built `Request` with its own headers does
  // not, and the guard's 403 would otherwise look like the route rejecting the
  // body rather than the harness being unlike a real client.
  const headers = new Headers(init?.headers);
  headers.set("Host", "localhost");
  const response = await handleManagementAPI(new Request(url, { ...init, headers }), url, config);
  if (!response) throw new Error(`no management route answered ${init?.method ?? "GET"} ${path}`);
  return response;
}

function usageRow(requestId: string): string {
  return `${JSON.stringify({
    requestId,
    timestamp: Date.now(),
    provider: "anthropic",
    model: "claude-3-haiku-20240307",
    status: 200,
    durationMs: 2000,
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 4 },
  })}\n`;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  dir = mkdtempSync(join(tmpdir(), "ocx-logs-api-"));
  process.env.OPENCODEX_HOME = dir;
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(usageLogPath(dir), usageRow("req-one") + usageRow("req-two"), "utf-8");
  writeFileSync(appLogPath(dir), "2026-07-31T00:00:00.000Z boot: listening\n", "utf-8");
  clearRequestLogsForTests();
  resetDebugLogBufferForTests();
});

afterEach(() => {
  clearRequestLogsForTests();
  resetDebugLogBufferForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (dir) removeTempDir(dir);
});

describe("GET /api/logs/footprint", () => {
  /**
   * The defect: a confirmation that cannot name what it is about to delete, and a
   * user who is told the logs are "on disk somewhere". Both paths and the real
   * retention constants come from the server, so the dashboard cannot quote a
   * bound that has since drifted from the one the code enforces.
   */
  test("reports both paths, the counts, and the retention the code enforces", async () => {
    const body = await (await call("/api/logs/footprint")).json() as {
      requestRows: number; appLines: number; bytes: number;
      appLogPath: string; usageLogPath: string;
      retention: { maxLogBytes: number; maxRotatedFiles: number; maxTotalBytes: number };
    };

    expect(body.requestRows).toBe(2);
    expect(body.appLines).toBe(1);
    expect(body.appLogPath).toBe(appLogPath(dir));
    expect(body.usageLogPath).toBe(usageLogPath(dir));
    expect(body.retention.maxTotalBytes)
      .toBe(body.retention.maxLogBytes * (body.retention.maxRotatedFiles + 1));
  });
});

describe("DELETE /api/logs", () => {
  /**
   * The defect: a clear that empties the files but leaves the deleted rows on
   * screen, because the in-memory ring `/api/logs` serves was never re-seeded.
   * The user presses the button, nothing visibly changes, and concludes it is
   * broken — then presses it again.
   */
  test("deletes both files and empties the ring the Logs screen reads", async () => {
    // Seed the ring the way a restart does, so there is something to clear.
    await call("/api/logs");
    const response = await call("/api/logs", { method: "DELETE" });
    const body = await response.json() as { ok: boolean; snapshot: boolean; commit: string | null; label: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.label).toContain("2 request log rows");
    expect(existsSync(usageLogPath(dir))).toBe(false);
    expect(listAppLogFiles(dir)).toEqual([]);
    expect(getRequestLogEntries()).toEqual([]);
    expect(await (await call("/api/logs")).json()).toEqual([]);
  });

  /**
   * The defect: bookkeeping outranking the user. A missing git must cost the undo
   * and nothing else — and the response has to say which of the two happened, or
   * an unrecoverable delete is indistinguishable from a recoverable one.
   */
  test("a clear whose snapshot cannot be written still clears, and says so", async () => {
    // No `.git`, and no way to make one: point PATH at an empty directory so the
    // git probe fails exactly as it would on a machine without git installed.
    const previousPath = process.env.PATH;
    const empty = join(dir, "no-tools");
    mkdirSync(empty, { recursive: true });
    // The install path is also disarmed, so this cannot start a winget download.
    writeFileSync(join(dir, "git-install-attempted"), "test\n", "utf-8");
    process.env.PATH = empty;
    try {
      const body = await (await call("/api/logs", { method: "DELETE" })).json() as
        { ok: boolean; snapshot: boolean; commit: string | null };

      expect(body.ok).toBe(true);
      expect(body.snapshot).toBe(false);
      expect(body.commit).toBeNull();
      // The clear the user asked for still happened.
      expect(existsSync(usageLogPath(dir))).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

describe("POST /api/logs/restore", () => {
  /**
   * The defect: a restore that writes the file back but leaves `/api/logs`
   * empty until the next process start, which reads as "the undo did nothing".
   * No restart is involved — logs are not credentials — so the re-seed is the
   * only thing that can make the restore visible.
   */
  test("puts the rows back and re-seeds the ring without a restart", async () => {
    const cleared = await (await call("/api/logs", { method: "DELETE" })).json() as { commit: string | null };
    expect(cleared.commit).not.toBeNull();
    expect(await (await call("/api/logs")).json()).toEqual([]);

    const response = await call("/api/logs/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commit: cleared.commit }),
    });
    const body = await response.json() as { success: boolean; restored: string[] };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.restored).toContain("usage.jsonl");
    const rows = await (await call("/api/logs")).json() as { requestId: string }[];
    expect(rows.map(row => row.requestId)).toEqual(["req-one", "req-two"]);
  });

  test("a missing commit is a 400, not a silent no-op", async () => {
    const response = await call("/api/logs/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  /**
   * A hash that is not in the history is refused before anything is written back.
   * Asserted against DISK, not against the ring: the ring is deliberately
   * re-seeded even on a failed restore, because a failed checkout can still have
   * written some of the paths and a ring that disagrees with disk is worse than
   * either state on its own.
   */
  test("a commit that is not in the history answers 400 and leaves the files alone", async () => {
    const before = readFileSync(usageLogPath(dir), "utf-8");

    const response = await call("/api/logs/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commit: "0".repeat(40) }),
    });

    expect(response.status).toBe(400);
    expect((await response.json() as { success: boolean }).success).toBe(false);
    expect(readFileSync(usageLogPath(dir), "utf-8")).toBe(before);
  });
});
