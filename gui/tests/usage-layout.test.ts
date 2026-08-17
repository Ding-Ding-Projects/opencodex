import { expect, test } from "bun:test";

/**
 * The source with whole-line comments dropped.
 *
 * Only whole-line ones — a line whose trimmed form starts `//`, `*` or `/*` — so
 * this can never delete real code and turn a negative assertion into a false
 * pass. It exists because a file that documents the construct it stopped using
 * would otherwise fail a `not.toContain` on that construct's own name, which
 * would punish the code for explaining itself.
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter(line => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

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

// The prototype leads every usage tile with a mark and a sub-value hint, and folds "Measured"
// into the requests hint instead of spending a whole tile on it. Pin the six tiles so a future
// edit cannot quietly drop a mark or a hint back to a bare number.
test("Usage stat tiles carry the prototype's marks and hints", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();

  for (const mark of ["IconSwapVert", "IconDataUsage", "IconBolt", "IconGauge", "IconClock", "IconCoin"]) {
    expect(src).toContain(`<${mark} {...STAT_ICON} />`);
  }
  for (const hint of ["usage.card.requestsHint", "usage.card.totalTokensHint", "usage.card.coverageHint", "usage.card.costHint"]) {
    expect(src).toContain(`t("${hint}"`);
  }
  // Short label on the tile; the long one stays as its tooltip.
  //
  // Matched on the quoted key rather than on `t("…")`, because the tile became
  // lane-aware: the label is now chosen inside a ternary, so the call and the key
  // are no longer adjacent in the source. The closing quote is what keeps this
  // exact — it is the one character that stops `"usage.card.estCost"` from also
  // being satisfied by `"usage.card.estCostEquivalent"`.
  //
  // Two lanes wrote this assertion differently. The other pinned the whole
  // ternary expression, which is stricter but breaks the moment anyone
  // reformats the line; this one survives reformatting and, paired with the
  // equivalent key pinned below, still fails if either lane's headline goes
  // missing. That pair is the property worth protecting, not the syntax.
  expect(src).toContain('"usage.card.estCost"');
  expect(src).toContain('t("usage.cost.total")');
  // Both lanes are pinned, so neither headline can quietly go missing: a
  // subscription shows the API-equivalent figure where a direct API key shows
  // real spend, and the two must never be labelled the same way.
  expect(src).toContain('"usage.card.estCostEquivalent"');
  // "Measured" is the requests hint now, not a tile of its own.
  expect(src).not.toContain('t("usage.card.measured")');
});

// Every search bar keeps plain text as the default with an explicit `.*` opt-in and a builder
// affordance anchored beside the field.
test("Usage model search offers regex opt-in and the anchored builder", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();

  expect(src).toContain("useRegex");
  expect(src).toContain('t("search.regexHint")');
  // Anchored beside the field rather than linked to the builder page: the old
  // `<a href="#regex">` navigated away from the table the pattern was written for.
  expect(src).toContain("<RegexBuilderButton");
  expect(src).not.toContain('href="#regex"');
  // Compiled through the shared matcher, which keeps the 400-character bound
  // this line used to assert directly and additionally strips `g`/`y` — their
  // `lastIndex` survives between calls, so one matcher reused down the model
  // table would keep every other row.
  expect(src).toContain("settingsMatcher(query, useRegex, flags)");
  // And never back to a hard-coded compile: pinning the flags is what made the
  // builder's own flag chips decorative from this field's point of view.
  //
  // Asserted against the code with whole-line comments dropped, because the
  // source now *explains* what it stopped doing and the prose would otherwise
  // fail the check that the prose is describing.
  expect(codeOnly(src)).not.toContain("new RegExp(query");
  // The flags the builder composed are the flags the table compiles, and they
  // are visible and correctable rather than silent.
  expect(src).toContain("const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)");
  expect(src).toContain("onFlags(appliedFlags)");
  expect(src).toContain("<SearchFlagsRow");
  // An invalid in-progress pattern reports itself instead of silently blanking the table.
  expect(src).toContain('role="alert"');
  expect(src).toContain('t("regex.invalid")');
});

// The heatmap's month strip and the day tooltips are calendar labels. They used to be an English
// month array and a raw `YYYY-MM-DD` slice, which read as English in every locale.
test("Usage calendar labels come from Intl in the active locale, not a baked-in English array", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();

  expect(src).not.toContain('"Jan", "Feb"');
  expect(src).not.toContain("day.date.slice(5)");
  expect(src).toContain("new Intl.DateTimeFormat(locale, options)");
  expect(src).toContain("buildHeatmap(data?.days ?? [], locale)");
  expect(src).toContain("formatDayShort(day.date, locale)");
  expect(src).toContain("formatDayFull(cell.date, locale)");
  // A bucket key must be read as a local calendar day; `new Date(iso)` would shift it a day west
  // of Greenwich and mislabel the cell.
  expect(src).toContain("function parseIsoDay");
  expect(src).toContain("new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))");
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
