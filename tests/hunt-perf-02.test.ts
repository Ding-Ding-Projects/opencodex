import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  readUsageSnapshotForManagement,
  resetUsageReadCacheForTests,
  usageReadCacheStatsForTests,
  type PersistedUsageEntry,
} from "../src/usage/log";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * PERF-02: usage.jsonl is append-only and never rotated or pruned (unlike
 * logs/opencodex.log, which has a hard MAX_LOG_BYTES/MAX_ROTATED_FILES cap --
 * see src/lib/app-log-file.ts). readUsageSnapshotForManagement() -- the
 * source both /api/usage (management/logs-usage-routes.ts) and request-log
 * hydration read from -- has no cross-call cache of its own: every call does
 * a full read()+JSON.parse() of the ENTIRE file from byte 0, regardless of
 * how small the caller's requested range is. The one-level-up cache in
 * logs-usage-routes.ts (usageSummaryCache) is keyed on the file's revision
 * (size/mtime/ctime), and that revision changes on every single completed
 * request (addRequestLog -> appendUsageEntry), so in an active session the
 * cache is invalidated essentially continuously. The GUI dashboard polls
 * /api/usage?range=30d every 5s (gui/src/pages/use-dashboard-data.ts) while
 * the app is open, so a user who is actively chatting gets a full re-parse of
 * their entire historical usage.jsonl on close to every poll -- cost that
 * grows without bound as lifetime request count grows, for an endpoint whose
 * caller only ever wants a 7d/30d/"all" window.
 *
 * This guard measures parsed-line COUNT (via the module's own
 * usageReadCacheStatsForTests instrumentation), not wall-clock time, so it
 * stays stable across hosts: it is red as long as one new row forces a full
 * re-parse of every prior row, and turns green once a fix reads only the
 * incremental tail (the same technique readRecentUsageEntries already uses)
 * or bounds the read by the requested range.
 */
describe("hunt-perf-02: usage.jsonl re-parses its entire history after every new row", () => {
  let dir = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    dir = mkdtempSync(join(tmpdir(), "ocx-usage-reparse-"));
    process.env.OPENCODEX_HOME = dir;
    resetUsageReadCacheForTests();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    resetUsageReadCacheForTests();
    if (dir) { try { removeTempDir(dir); } catch { /* best-effort */ } dir = ""; }
  });

  test("one newly appended row costs a full re-parse of the whole historical file", async () => {
    const historicalRowCount = 500;
    const baseEntry = (requestId: string): PersistedUsageEntry => ({
      requestId,
      timestamp: Date.now(),
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    });

    for (let i = 0; i < historicalRowCount; i++) appendUsageEntry(baseEntry(`historical-${i}`));

    // Warm read: establishes the "already looked at this revision" baseline,
    // same as the dashboard's first /api/usage call after startup.
    const first = await readUsageSnapshotForManagement();
    expect(first.entries).toHaveLength(historicalRowCount);
    const parsedAfterFirstRead = usageReadCacheStatsForTests().parsedLines;
    expect(parsedAfterFirstRead).toBe(historicalRowCount);

    // Exactly ONE new request completes -- the ordinary steady-state case
    // while a user is actively chatting through the proxy.
    appendUsageEntry(baseEntry("newest"));

    const second = await readUsageSnapshotForManagement();
    expect(second.entries).toHaveLength(historicalRowCount + 1);
    const parsedAfterSecondRead = usageReadCacheStatsForTests().parsedLines;
    const incrementalCost = parsedAfterSecondRead - parsedAfterFirstRead;

    // Currently red: appending ONE row re-parses all (historicalRowCount + 1)
    // lines again, so incrementalCost == historicalRowCount + 1, not 1. A fix
    // that tails only the bytes appended since the last observed revision (as
    // readRecentUsageEntries already does for hydration) would keep this
    // bounded regardless of how large the historical file has grown.
    expect(incrementalCost).toBeLessThanOrEqual(2);
  });
});
