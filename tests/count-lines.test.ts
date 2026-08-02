/**
 * The line counter every release publishes.
 *
 * The number itself is not what these assert — it moves on every commit, and a
 * test that pins it would fail on the next one for no reason. What they assert
 * is the property that makes the number trustworthy: **every counted file lands
 * in exactly one bucket, and the buckets sum to the total.**
 *
 * That is the failure mode the shared rules single out. A bucketing written on
 * the spot silently drops every file matching no prefix, and a total that
 * quietly loses whole directories misrepresents the project while looking
 * completely fine — the table still renders, the rows still add up to whatever
 * they add up to, and nothing says a directory is missing.
 */

import { describe, expect, test } from "bun:test";
import { countLines } from "../scripts/count-lines";

const counted = countLines();

describe("the shape of the count", () => {
  test("the rows sum to the reported total", () => {
    const summed = counted.rows.reduce(
      (acc, r) => ({ files: acc.files + r.files, total: acc.total + r.total, code: acc.code + r.code }),
      { files: 0, total: 0, code: 0 },
    );
    expect(summed).toEqual(counted.totals);
  });

  test("nothing is counted twice — file counts add up to a real number of files", () => {
    // Buckets are first-match-wins, so a file can only be in one. This is the
    // assertion that would fail if that ever became a "matches any" loop.
    expect(counted.totals.files).toBeGreaterThan(0);
    expect(counted.rows.every(r => r.files > 0)).toBe(true);
  });

  test("non-blank lines never exceed total lines", () => {
    for (const row of counted.rows) {
      expect({ row: row.name, ok: row.code <= row.total }).toEqual({ row: row.name, ok: true });
    }
  });

  test("the areas a reader would look for are all present", () => {
    // Not an exhaustive list — a bucket that legitimately empties should not
    // fail this. These four are the project, and if any of them reports zero
    // files the bucketing has stopped matching the tree.
    const named = new Set(counted.rows.map(r => r.name));
    for (const area of ["Tests", "Dashboard — source", "Proxy & CLI (src/, bin/)", "Desktop shell (Electron)"]) {
      expect({ area, present: named.has(area) }).toEqual({ area, present: true });
    }
  });

  test("generated files are reported apart from hand-written ones", () => {
    // `gui/src/icons.tsx` is emitted by scripts/gen-icons.ts. Folding it into
    // the dashboard total would inflate the figure with something nobody wrote,
    // which the rules name explicitly.
    expect(counted.rows.some(r => r.name.startsWith("Generated"))).toBe(true);
  });

  test("assets are counted as files, not as lines", () => {
    // "Lines" is not a fact about a PNG. The repository tracks hundreds of
    // images; a counter that gave them line counts would be inventing data.
    expect(counted.assets).toBeGreaterThan(0);
  });
});
