import { expect, test } from "bun:test";

test("Usage renders the single stacked layout (no layout toggle, no workspace rail)", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).not.toContain("viewMode");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("ocx-usage-view");
  expect(page).not.toContain("UsageWorkspaceBody");
  expect(page).not.toContain("UsageWorkspaceSection");
  expect(page).not.toContain("usage-workspace-");
  expect(page).not.toContain("usw-");
  expect(page).not.toContain("selectedSection");

  expect(app).toContain("<Usage apiBase={API_BASE} />");
  expect(css).not.toContain("styles-usage-workspace.css");
});

test("Usage stacked layout mounts every report panel in order", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();

  const order = [
    "<UsageSummaryCards",
    "<UsageHeatmapPanel",
    "<UsageModelsTable",
    "<UsageProvidersTable",
    "<UsageCoveragePanel",
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }

  // Panels keep their section landmarks and headings. The legacy `.panel` chrome was
  // superseded by the Material 3 restyle, so this pins the M3 equivalent (`.m3-card`
  // section + `.m3-card-title` heading) rather than the retired class name.
  expect(src).toContain('className="m3-card"');
  expect(src).toContain('className="m3-card-title"');
  expect(src).toContain('aria-labelledby={titleId}');
});

test("Usage loading and empty states guard the stacked body", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  expect(src).toContain("loading && !data");
  expect(src).toContain('t("usage.loading")');
  expect(src).toContain('t("usage.empty")');
  expect(src).toContain("data?.summary.requests === 0");
});

test("retired usage workspace i18n keys stay removed from every locale", async () => {
  const locales = ["en", "de", "ja", "ko", "ru", "zh"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).not.toContain('"usage.workspace.sections":');
    expect(dict).not.toContain('"usage.workspace.report":');
    expect(dict).not.toContain('"usage.workspace.mainAria":');
  }
});
