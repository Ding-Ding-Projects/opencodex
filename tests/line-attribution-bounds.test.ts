import { describe, expect, test } from "bun:test";
import {
  GitCommandError,
  batchPathsByUtf8Bytes,
  mapWithConcurrency,
  sortAttributionRows,
} from "../scripts/line-attribution";

type AttributionRow = Parameters<typeof sortAttributionRows>[0][number];

function row(
  category: string,
  language: string,
  total: number,
  nonBlank: number,
  agent: number,
  people: number,
): AttributionRow {
  return { category, language, total, nonBlank, agent, people };
}

describe("line attribution deterministic output", () => {
  test("uses stable semantic keys rather than discovery or completion order", () => {
    const discovered = [
      row("Tests", "TypeScript", 20, 18, 9, 9),
      row("Source", "TypeScript", 20, 18, 10, 8),
      row("Source", "Go", 40, 35, 20, 15),
      row("Generated", "TypeScript", 100, 90, 90, 0),
    ];

    const expected = [
      row("Generated", "TypeScript", 100, 90, 90, 0),
      row("Source", "Go", 40, 35, 20, 15),
      row("Source", "TypeScript", 20, 18, 10, 8),
      row("Tests", "TypeScript", 20, 18, 9, 9),
    ];

    expect(sortAttributionRows(discovered)).toEqual(expected);
    expect(sortAttributionRows([...discovered].reverse())).toEqual(expected);
    expect(discovered.map(({ category, language }) => `${category}/${language}`)).toEqual([
      "Tests/TypeScript",
      "Source/TypeScript",
      "Source/Go",
      "Generated/TypeScript",
    ]);
  });
});

describe("line attribution bounded work", () => {
  test("batches by encoded command payload, not only by path count", () => {
    const paths = [
      "src/a.ts",
      "src/a folder/with spaces.ts",
      "src/資料/歸屬.ts",
      String.raw`src\windows\nested\file.ts`,
      "tests/final.test.ts",
    ];
    const maxBytes = 42;
    const batches = batchPathsByUtf8Bytes(paths, maxBytes);

    expect(batches.flat()).toEqual(paths);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const payload = new TextEncoder().encode(`${batch.join("\0")}\0`);
      expect(payload.byteLength).toBeLessThanOrEqual(maxBytes);
    }
  });

  test("rejects one path that cannot fit instead of emitting an oversized command", () => {
    const path = `src/${"長".repeat(30)}.ts`;
    expect(() => batchPathsByUtf8Bytes([path], 32)).toThrow(/32.*bytes|bytes.*32/i);
  });

  test("bounds asynchronous git work without making completion order observable", async () => {
    const items = Array.from({ length: 37 }, (_, index) => index);
    let active = 0;
    let peak = 0;

    const result = await mapWithConcurrency(items, 4, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, (item % 3) + 1));
      active -= 1;
      return `row-${item}`;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(result).toEqual(items.map(item => `row-${item}`));
  });

  test("rejects invalid concurrency before scheduling any work", async () => {
    let calls = 0;
    await expect(mapWithConcurrency([1, 2, 3], 0, async value => {
      calls += 1;
      return value;
    })).rejects.toThrow(/concurrency.*positive|positive.*concurrency/i);
    expect(calls).toBe(0);
  });
});

describe("line attribution path and git diagnostics", () => {
  test("preserves spaces, backslashes, and Unicode in Windows paths", () => {
    const paths = [
      String.raw`gui\src\folder with spaces\panel.tsx`,
      String.raw`docs-site\src\content\docs\廣東話\開始.md`,
      String.raw`go\測試 data\line attribution_test.go`,
    ];

    expect(batchPathsByUtf8Bytes(paths, 4_096).flat()).toEqual(paths);
  });

  test("git failures identify the operation, exit code, and useful stderr", () => {
    const error = new GitCommandError(
      "git",
      ["blame", "--line-porcelain", "--", String.raw`src\folder with spaces\資料.ts`],
      128,
      "fatal: bad revision 'release-candidate'",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("git blame");
    expect(error.message).toContain("exit 128");
    expect(error.message).toContain("bad revision");
    expect(error.message).toContain(String.raw`src\folder with spaces\資料.ts`);
  });

  test("git diagnostics redact credential-bearing URL arguments", () => {
    const error = new GitCommandError(
      "git",
      ["fetch", "https://user:secret@example.invalid/private.git"],
      128,
      "fatal: authentication failed for https://second:password@example.invalid/private.git",
    );

    expect(error.message).toContain("git fetch");
    expect(error.message).toContain("authentication failed");
    expect(error.message).not.toContain("user:secret");
    expect(error.message).not.toContain("second:password");
  });
});
