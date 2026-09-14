import { expect, test } from "bun:test";

/**
 * PERF-04: `App.tsx` used to statically import every page under `src/pages`,
 * so opening the app, on any tab, parsed one single ~2,965 kB chunk holding
 * the whole settings surface. `App.tsx` now imports every page except
 * `Dashboard` through `React.lazy()`, so opening a tab is what downloads that
 * tab's own chunk (see `scripts/check-chunk-budget.ts` for the build-time
 * evidence). This pins the split at the source level so a page cannot quietly
 * slide back to a static import, or a newly added page arrive as one, with
 * nothing catching it; a `grep` nobody runs is not a guard.
 */

const EAGER_PAGE_ALLOWLIST = ["Dashboard"] as const;

/**
 * Every other page `renderPage`'s switch in `App.tsx` dispatches to, keyed by
 * its local binding name. Hand-written rather than derived from the source
 * under test, so a page that regresses to a static import, or simply
 * disappears from the lazy block, has something outside itself to disagree
 * with.
 */
const EXPECTED_LAZY_PAGES = [
  { name: "Terminal", target: "Terminal" },
  { name: "MobileRemote", target: "Mobile" },
  { name: "Providers", target: "Providers" },
  { name: "Models", target: "Models" },
  { name: "Combos", target: "Combos" },
  { name: "Subagents", target: "Subagents" },
  { name: "Logs", target: "Logs" },
  { name: "Usage", target: "Usage" },
  { name: "Storage", target: "Storage" },
  { name: "CodexAuth", target: "CodexAuth" },
  { name: "ApiKeys", target: "ApiKeys" },
  { name: "Claude", target: "Claude" },
  { name: "Grok", target: "Grok" },
  { name: "Startup", target: "Startup" },
  { name: "Appearance", target: "Appearance" },
  { name: "LanguageVoice", target: "LanguageVoice" },
  { name: "ScheduledSettings", target: "ScheduledSettings" },
  { name: "RegexBuilder", target: "RegexBuilder" },
  { name: "Changelog", target: "Changelog" },
  { name: "Docs", target: "Docs" },
  { name: "VersionHistory", target: "VersionHistory" },
  { name: "NotificationsPage", target: "Notifications" },
  { name: "Network", target: "Network" },
  { name: "Authenticator", target: "Authenticator" },
  { name: "SettingsPage", target: "Settings" },
  { name: "LocksPage", target: "Locks" },
  { name: "PdfTools", target: "PdfTools" },
  { name: "Converter", target: "Converter" },
  { name: "Ollama", target: "Ollama" },
  { name: "OllamaChat", target: "OllamaChat" },
  { name: "Downloads", target: "Downloads" },
] as const;

async function appSource(): Promise<string> {
  return Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
}

/** The `./pages/X` target of every `import ... from "./pages/X"` line, any import form. */
function staticPageImportTargets(source: string): string[] {
  return [...source.matchAll(/^import\s+.+\sfrom\s+"\.\/pages\/([^"]+)";\s*$/gm)].map(m => m[1]);
}

/** Every `const Name = lazy(() => import("./pages/Target"));` declaration in App.tsx. */
function lazyPageImports(source: string): { name: string; target: string }[] {
  return [...source.matchAll(/^const\s+(\w+)\s*=\s*lazy\(\(\)\s*=>\s*import\("\.\/pages\/([^"]+)"\)\);\s*$/gm)]
    .map(m => ({ name: m[1], target: m[2] }));
}

test("App.tsx imports no page statically beyond the eager allow-list", async () => {
  const src = await appSource();
  const staticTargets = staticPageImportTargets(src).sort();
  expect(staticTargets).toEqual([...EAGER_PAGE_ALLOWLIST].sort());
});

test("every other page App.tsx dispatches to loads through React.lazy", async () => {
  const src = await appSource();
  const actual = lazyPageImports(src)
    .map(entry => `${entry.name}:${entry.target}`)
    .sort();
  const expected = EXPECTED_LAZY_PAGES
    .map(entry => `${entry.name}:${entry.target}`)
    .sort();
  expect(actual).toEqual(expected);

  // Each lazy binding is actually rendered somewhere below its declaration:
  // this cannot pass with a dangling `lazy()` call `renderPage` quietly
  // stopped dispatching to.
  for (const { name } of EXPECTED_LAZY_PAGES) {
    expect(src).toContain(`<${name}`);
  }
});

test("the lazy pages fall back to one Suspense boundary using the shared shell kit", async () => {
  const src = await appSource();
  expect(src).toContain('import { ProgressIndicator } from "./shell/m3-ui";');
  expect(src).toContain("<Suspense fallback={<ProgressIndicator label={t(\"common.loading\")} />}>");
  // Declared once in source: the tabs strip mounts one instance per open tab
  // at runtime, but a second distinct boundary written into the file would
  // mean a second place this decision could drift from the first.
  expect(src.match(/<Suspense\b/g)?.length).toBe(1);
});
