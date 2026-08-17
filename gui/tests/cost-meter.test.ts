import { expect, test } from "bun:test";
import { formatUsd } from "../src/shell/cost-format";

/**
 * The app-bar cost meter shows whichever accounting lane actually priced the
 * traffic. What this file pins is the presentation contract: readable at every
 * magnitude, and the meter renders nothing (rather than a misleading $0) when no
 * lane produced a figure — that branch is asserted structurally below since it
 * lives in JSX.
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

test("no priced lane hides the meter instead of rendering a zero", async () => {
  const source = await Bun.file(new URL("../src/shell/CostMeter.tsx", import.meta.url)).text();
  // Stronger than the old `poll.data == null` guard it replaced: a summary can
  // arrive perfectly well-formed and still have priced nothing, and rendering the
  // resulting 0 was exactly how every subscription user saw "$0.000".
  expect(source).toContain("if (!cost?.primary) return null;");
  expect(source).toContain("resolveSummaryCost(");
});

test("an API-equivalent headline is tagged in words, not only by tone", async () => {
  const source = await Bun.file(new URL("../src/shell/CostMeter.tsx", import.meta.url)).text();
  // The tonal container is the glance; the word is the meaning. A dollar figure a
  // subscription user does not owe must never rely on colour to say so.
  expect(source).toContain("m3-cost-chip--equivalent");
  expect(source).toContain('t("cost.lane.equivalentTag")');
  expect(source).toContain('"cost.lane.equivalentAria"');

  const css = await Bun.file(new URL("../src/styles/m3-shell.css", import.meta.url)).text();
  // The compact breakpoint drops the range word; it must not drop this tag with it.
  expect(css).toContain(".m3-app--compact .m3-cost-chip--equivalent .m3-cost-range");
});

test("the configurable range is exactly what /api/usage accepts, defaulting to lifetime", async () => {
  const prefs = await Bun.file(new URL("../src/theme/prefs-context.ts", import.meta.url)).text();
  expect(prefs).toContain('export type CostRange = "7d" | "30d" | "all";');
  expect(prefs).toContain('costRange: "all",');
});
