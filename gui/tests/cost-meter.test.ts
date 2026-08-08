import { expect, test } from "bun:test";
import { formatUsd } from "../src/shell/cost-format";

/**
 * The app-bar cost meter shows the server's own estimatedCostUsd. What this
 * file pins is the presentation contract: readable at every magnitude, and the
 * meter renders nothing (rather than a misleading $0) when no figure exists —
 * that branch is asserted structurally below since it lives in JSX.
 */

test("formatUsd stays readable across magnitudes", () => {
  expect(formatUsd(0)).toBe("$0.000");
  expect(formatUsd(0.0042)).toBe("$0.004");
  expect(formatUsd(0.25)).toBe("$0.250");
  expect(formatUsd(3.5)).toBe("$3.50");
  expect(formatUsd(42.129)).toBe("$42.13");
  expect(formatUsd(1234.4)).toBe("$1,234");
  expect(formatUsd(Number.NaN)).toBe("—");
});

test("no data hides the meter instead of rendering a zero", async () => {
  const source = await Bun.file(new URL("../src/shell/CostMeter.tsx", import.meta.url)).text();
  expect(source).toContain("if (poll.data === null || poll.data === undefined) return null;");
});

test("the configurable range is exactly what /api/usage accepts, defaulting to lifetime", async () => {
  const prefs = await Bun.file(new URL("../src/theme/prefs-context.ts", import.meta.url)).text();
  expect(prefs).toContain('export type CostRange = "7d" | "30d" | "all";');
  expect(prefs).toContain('costRange: "all",');
});
