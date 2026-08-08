/**
 * The app log on disk: where it goes, how it is bounded, and what it refuses to
 * take down with it.
 *
 * Each test names the defect it prevents. The bound is the important one — an
 * unbounded log on a proxy that runs for months is a disk-full incident with a
 * long fuse, and the failure lands on the user rather than on whoever wrote the
 * appender.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  APP_LOG_DIR_NAME,
  APP_LOG_FILE_NAME,
  MAX_LOG_BYTES,
  MAX_ROTATED_FILES,
  MAX_TOTAL_BYTES,
  appLogPath,
  appendAppLogLine,
  clearAppLogFiles,
  ensureAppLogFile,
  listAppLogFiles,
  measureAppLogFiles,
  readAppLogTail,
} from "../src/lib/app-log-file";
import { removeTempDir } from "./helpers/temp-dir";

let dir = "";

/**
 * Push the live file to the cap without writing megabytes one line at a time.
 * Appends rather than overwrites, so lines already logged in a test survive into
 * the generation this rotation is about to create.
 */
function fillToCap(): void {
  mkdirSync(join(dir, APP_LOG_DIR_NAME), { recursive: true });
  const path = appLogPath(dir);
  const already = existsSync(path) ? statSync(path).size : 0;
  appendFileSync(path, `${"x".repeat(Math.max(0, MAX_LOG_BYTES - already - 1))}\n`, "utf-8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-applog-"));
});

afterEach(() => {
  if (dir) removeTempDir(dir);
});

describe("where the log lives", () => {
  /**
   * The defect: log files written next to whatever the user was working on. A
   * proxy that scatters files through the directories it is asked about is one
   * nobody can trust with a repository, and the files are near-impossible to
   * find again afterwards.
   */
  test("the log sits inside the app's own data directory", () => {
    appendAppLogLine("boot", dir);

    const path = appLogPath(dir);
    expect(path).toBe(join(dir, APP_LOG_DIR_NAME, APP_LOG_FILE_NAME));
    expect(existsSync(path)).toBe(true);
  });

  /**
   * The defect: "where is the log file?" answered with "it appears once
   * something goes wrong". A path that does not exist yet cannot be opened, and
   * the user is left unsure whether the feature works at all.
   */
  test("the file exists before anything has been logged", () => {
    const path = ensureAppLogFile(dir);

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("");
  });

  /** Plain text with a leading timestamp — readable in any editor, no tooling. */
  test("each line is timestamped and readable as plain text", () => {
    appendAppLogLine("[ocx:cursor:retry] {\"attempt\":2}", dir);

    const text = readFileSync(appLogPath(dir), "utf-8");
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[ocx:cursor:retry\] \{"attempt":2\}\n$/);
  });
});

describe("the size bound", () => {
  /**
   * The defect this exists for: a long-running proxy filling the disk. The cap
   * is arithmetic — generations times size — rather than a background prune that
   * might not run, so it holds even if nothing else about the process is healthy.
   */
  test("the stated ceiling is what the constants actually multiply out to", () => {
    expect(MAX_TOTAL_BYTES).toBe(MAX_LOG_BYTES * (MAX_ROTATED_FILES + 1));
  });

  test("passing the cap rotates rather than growing the live file", () => {
    fillToCap();

    appendAppLogLine("after the cap", dir);

    expect(existsSync(join(dir, APP_LOG_DIR_NAME, `${APP_LOG_FILE_NAME}.1`))).toBe(true);
    // The new line went to a fresh live file, not onto the end of the full one.
    expect(readFileSync(appLogPath(dir), "utf-8")).toContain("after the cap");
    expect(statSync(appLogPath(dir)).size).toBeLessThan(MAX_LOG_BYTES);
  });

  /**
   * The defect: rotation that renames generations newest-first, so each rename
   * lands on the file behind it and every generation but one is destroyed. The
   * bound would still hold; the history it was protecting would not.
   */
  test("rotation shifts generations without overwriting one another", () => {
    // Each round tags the live file with a unique marker and then pushes it past
    // the cap, so the markers end up one per generation, newest in the live file.
    for (let round = 1; round <= MAX_ROTATED_FILES; round++) {
      appendAppLogLine(`generation ${round}`, dir);
      fillToCap();
    }
    appendAppLogLine(`generation ${MAX_ROTATED_FILES + 1}`, dir);

    const names = listAppLogFiles(dir).map(path => basename(path));
    expect(names).toContain(APP_LOG_FILE_NAME);
    expect(names).toContain(`${APP_LOG_FILE_NAME}.1`);

    // Every marker still lives in exactly one file, in descending age order.
    // Compared as booleans on purpose: these files are megabytes, and a failing
    // `toContain` would print one.
    const holds = (generation: number, name: string) => readFileSync(
      join(dir, APP_LOG_DIR_NAME, name), "utf-8",
    ).includes(`generation ${generation}`);
    expect(holds(MAX_ROTATED_FILES + 1, APP_LOG_FILE_NAME)).toBe(true);
    for (let generation = 1; generation <= MAX_ROTATED_FILES; generation++) {
      // Generation 1 is the oldest, so it sits in the highest-numbered file.
      const name = `${APP_LOG_FILE_NAME}.${MAX_ROTATED_FILES + 1 - generation}`;
      expect(holds(generation, name)).toBe(true);
    }
  });

  test("no more than the stated number of generations survives", () => {
    for (let round = 0; round <= MAX_ROTATED_FILES + 3; round++) {
      fillToCap();
      appendAppLogLine(`round ${round}`, dir);
    }

    expect(listAppLogFiles(dir).length).toBeLessThanOrEqual(MAX_ROTATED_FILES + 1);
  });
});

describe("reading the log back", () => {
  /**
   * The defect: a Debug tab that is blank after a restart even though the file
   * on disk is full. Hydration reads across generations, oldest first, so the
   * replayed lines are in the order they happened.
   */
  test("the tail spans generations in chronological order", () => {
    appendAppLogLine("oldest", dir);
    fillToCap();
    appendAppLogLine("newest", dir);

    const tail = readAppLogTail(500, dir).map(entry => entry.line);
    expect(tail.indexOf("oldest")).toBeGreaterThanOrEqual(0);
    expect(tail.indexOf("newest")).toBeGreaterThan(tail.indexOf("oldest"));
  });

  /**
   * The defect: one hand-edited or half-written line poisoning the whole read.
   * A line with no parseable timestamp is still worth showing — it just carries
   * no trustworthy time, and 0 keeps it out of a comparator as NaN would not.
   */
  test("a line without a usable timestamp is kept rather than dropped", () => {
    mkdirSync(join(dir, APP_LOG_DIR_NAME), { recursive: true });
    writeFileSync(appLogPath(dir), "this line has no timestamp at all\n", "utf-8");

    const tail = readAppLogTail(10, dir);
    expect(tail).toHaveLength(1);
    expect(tail[0].line).toBe("this line has no timestamp at all");
    expect(tail[0].at).toBe(0);
  });

  test("the tail is bounded by the requested limit", () => {
    for (let i = 0; i < 20; i++) appendAppLogLine(`line ${i}`, dir);

    const tail = readAppLogTail(5, dir);
    expect(tail).toHaveLength(5);
    expect(tail.at(-1)!.line).toBe("line 19");
  });
});

describe("measuring and clearing", () => {
  test("the footprint counts every generation", () => {
    appendAppLogLine("one", dir);
    fillToCap();
    appendAppLogLine("two", dir);

    const footprint = measureAppLogFiles(dir);
    expect(footprint.files).toBe(2);
    expect(footprint.bytes).toBeGreaterThanOrEqual(MAX_LOG_BYTES);
  });

  test("clearing removes every generation and reports what it removed", () => {
    appendAppLogLine("one", dir);
    fillToCap();
    appendAppLogLine("two", dir);

    const removed = clearAppLogFiles(dir);

    expect(removed.files).toBe(2);
    expect(listAppLogFiles(dir)).toEqual([]);
  });
});

describe("never fatal", () => {
  /**
   * The defect: a request failing because its diagnostics could not be written.
   * A full disk, a read-only directory or a locked file must cost the log line
   * and nothing else — logging is the least important thing happening.
   */
  test("an unwritable directory does not throw", () => {
    // A file where the log directory should be: mkdir will fail, every time.
    writeFileSync(join(dir, APP_LOG_DIR_NAME), "not a directory", "utf-8");

    expect(() => appendAppLogLine("still fine", dir)).not.toThrow();
    expect(() => measureAppLogFiles(dir)).not.toThrow();
    expect(() => clearAppLogFiles(dir)).not.toThrow();
    expect(readAppLogTail(10, dir)).toEqual([]);
  });
});
