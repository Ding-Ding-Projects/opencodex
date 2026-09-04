import { expect, test } from "bun:test";
import { formatEstimatedUsdValue } from "../src/intl-formatters";
import { formatCostUsd } from "../src/provider-workspace/usage";

/**
 * The app-bar cost meter shows whichever accounting lane actually priced the
 * traffic. What this file pins is the presentation contract: readable at every
 * magnitude, formatted by the ONE shared estimated-USD formatter (so the chip,
 * the Usage page, the Logs page and the Providers workspace cannot disagree at
 * the same total), and rendered as nothing (rather than a misleading $0) when
 * no lane produced a figure — that branch is asserted structurally below since
 * it lives in JSX.
 */

test("the shared estimated-USD formatter stays readable across magnitudes", () => {
  // Every figure is an estimate, so every figure carries the tilde — the chip
  // included. Four decimals below a dollar keeps sub-cent lifetime totals
  // distinguishable; above it, cents are the meaningful unit. Locale pinned so
  // the expected grouping never depends on the host's default.
  const fmt = (value: number) => formatEstimatedUsdValue(value, "en-US");
  expect(fmt(0)).toBe("~$0.0000");
  expect(fmt(0.0042)).toBe("~$0.0042");
  expect(fmt(0.25)).toBe("~$0.2500");
  expect(fmt(3.5)).toBe("~$3.5000");
  expect(fmt(42.129)).toBe("~$42.1290");
  expect(fmt(1234.4)).toBe("~$1,234.4000");
  expect(fmt(Number.NaN)).toBe("—");
  expect(fmt(-1)).toBe("—");
});

test("one formatter serves the chip, the pages, and the providers workspace", async () => {
  const chip = await Bun.file(new URL("../src/shell/CostMeter.tsx", import.meta.url)).text();
  const usage = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const logs = await Bun.file(new URL("../src/pages/Logs.tsx", import.meta.url)).text();

  // All four surfaces resolve to the same implementation. The chip imports it
  // directly; the Usage page aliases it; Logs and the providers workspace had
  // private copies that drifted (a `$0.123` chip beside a `~$0.1234` page for
  // the identical total) until they were deleted in favour of this import.
  expect(chip).toContain('import { formatEstimatedUsdValue } from "../intl-formatters";');
  expect(chip).not.toContain("cost-format");
  expect(usage).toContain("formatEstimatedUsdValue as formatUsdEstimate");
  expect(logs).toContain('import { formatEstimatedUsdValue } from "../intl-formatters";');

  // Whole-line comments dropped before the negative assertion: the source
  // documents the deleted duplicate and would otherwise fail on its own prose.
  const codeOnly = logs
    .split("\n")
    .filter(line => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
  expect(codeOnly).not.toContain("function formatEstimatedUsdValue");

  // And behaviourally: the providers workspace entry point is a thin delegate,
  // so it answers byte-identically to the shared formatter at every shape of
  // input it can be handed.
  for (const value of [0, 0.0042, 0.25, 3.5, 42.129, 1234.4, Number.NaN, -1] as const) {
    expect(formatCostUsd(value, "en-US")).toBe(formatEstimatedUsdValue(value, "en-US"));
  }
  expect(formatCostUsd(null)).toBe("—");
  expect(formatCostUsd(undefined)).toBe("—");
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

// A priced subtotal can exclude requests its lane could not price. Without the
// count, a direct figure presents itself as complete; the data existed
// (`unpricedRequests`) but the old resolution dropped it before the meter saw it.
test("the meter states what its subtotal excludes, visibly and accessibly", async () => {
  const source = await Bun.file(new URL("../src/shell/CostMeter.tsx", import.meta.url)).text();
  // Visible, once per lane, reusing the localized exclusion sentence.
  expect(source).toContain('t("usage.cost.unpricedNote", { count: cost.primary.unpricedRequests })');
  expect(source).toContain('{t("cost.lane.direct")} · {t("usage.cost.unpricedNote", { count: cost.direct.unpricedRequests })}');
  expect(source).toContain('{t("cost.lane.equivalent")} · {t("usage.cost.unpricedNote", { count: cost.apiEquivalent.unpricedRequests })}');
  // And in the accessible name, appended rather than left layout-only.
  expect(source).toContain("t(equivalent ? \"cost.lane.equivalentAria\" : \"cost.aria\"");
  expect(source).toContain("unpricedNote,\n        ].filter(Boolean).join(\" \")");
});

test("the configurable range is exactly what /api/usage accepts, defaulting to lifetime", async () => {
  const prefs = await Bun.file(new URL("../src/theme/prefs-context.ts", import.meta.url)).text();
  expect(prefs).toContain('export type CostRange = "7d" | "30d" | "all";');
  expect(prefs).toContain('costRange: "all",');
});
