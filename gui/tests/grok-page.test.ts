import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "ja", "ko", "ru", "zh"] as const;

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

// The page may write its own SELECTION and ask the proxy to re-run the guarded sync,
// but it must never gain a path that writes ~/.grok/config.toml directly. injectGrokConfig
// owns that file (backup, byte-for-byte preservation, non-loopback refusal).
test("the Grok page only writes selection state and triggers the guarded sync", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("/api/grok/selection");
  expect(page).toContain("/api/grok/apply");
  expect(page).not.toContain("writeFile");
  expect(page).not.toContain("atomicWriteFile");
});

// UX-STATE-01: absent is a normal state, not a failure — it must name the next action rather
// than rendering an empty panel, and the error state must offer a way out.
test("the Grok page covers loading, absent and error states", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("grok.loading");
  expect(page).toContain("grok.notConfiguredTitle");
  expect(page).toContain("grok.notConfiguredHint");
  expect(page).toContain("common.retry");
});

// The nav table moved to shell/page-meta.ts with the Material 3 shell, and pages
// render off the active tab rather than a single `page`. Same invariant, new home.
test("the Grok page is routable and present in the nav", async () => {
  const routing = await read("../src/app-routing.ts");
  const app = await read("../src/App.tsx");
  const meta = await read("../src/shell/page-meta.ts");
  expect(routing).toContain('| "grok"');
  expect(routing).toContain('"grok",');
  expect(app).toContain('case "grok": return <Grok apiBase={API_BASE} />;');
  expect(meta).toContain('grok: "nav.grok"');
  expect(meta).toContain("grok: IconBolt");
});

// Every settings surface carries its own search, plain text by default with `.*` as an
// explicit opt-in and a route to the full builder. Grok's settings are its per-model
// registration switches, so the search filters those rows.
test("the Grok page carries the settings search row wired to the regex builder", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain('role="search"');
  expect(page).toContain("settings.search");
  expect(page).toContain("search.regexHint");
  expect(page).toContain("settings.openBuilder");
  expect(page).toContain('href="#regex"');
  // No-match is an honest empty state, not a silently blank list.
  expect(page).toContain("settings.noMatch");
});

// A Version history entry must name the event, not that "something changed" — and it must
// use Grok's own copy rather than borrowing the header's count label.
test("the Grok selection records its own revision summary", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("recordRevision");
  expect(page).toContain("grok.revisionSummary");
  expect(page).not.toContain('summary: t("grok.enabledCount"');
});

test("every locale carries the Grok keys", async () => {
  const keys = ["nav.grok", "grok.title", "grok.subtitle", "grok.loading", "grok.loadFail",
    "grok.notConfiguredTitle", "grok.notConfiguredHint", "grok.endpoint",
    "grok.colModel", "grok.colAlias", "grok.colContext",
    "grok.groupNative", "grok.groupRouted", "grok.enabledCount",
    "grok.saved", "grok.savedApplied", "grok.saveFailed", "grok.applyFailed",
    "grok.applySkipped", "grok.saveApply", "grok.saving", "grok.applying",
    "grok.unsaved", "grok.upToDate", "grok.toggleModel"];
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const dict = await read(`../src/i18n/${locale}.ts`);
    for (const key of keys) {
      const match = new RegExp(`"${key.replace(".", "\\.")}":\\s*"([^"]+)"`).exec(dict);
      if (!match) missing.push(`${locale}:${key}`);
    }
  }
  expect(missing).toEqual([]);
});
