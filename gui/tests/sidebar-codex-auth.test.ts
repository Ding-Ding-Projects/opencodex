import { expect, test } from "bun:test";

/**
 * Superseded by WP2a (devlog/_plan/260725_gui_view_consolidation/020_nav_and_dashboard_tabs.md).
 *
 * Codex Auth used to be filtered out of the sidebar in Workspace mode, on the
 * reasoning that the Providers workspace embeds the same account pool. The
 * maintainer instead promoted it to the second slot so it is always reachable.
 * That old filter was also a latent WP5 hazard: once Classic is removed there is
 * no non-workspace mode left, so a viewMode-keyed filter would have hidden the
 * page permanently.
 *
 * The Material 3 shell moved the nav table out of App.tsx into
 * `shell/page-meta.ts`, and page rendering keys on the active tab rather than a
 * single `page`. The invariant is unchanged, so the assertions follow it there.
 */

test("Codex Auth is always present in the sidebar, never filtered by view mode", async () => {
  const meta = await Bun.file(new URL("../src/shell/page-meta.ts", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const nav = await Bun.file(new URL("../src/shell/AdaptiveNav.tsx", import.meta.url)).text();

  // The old conditional filter must not come back, in any of the three files.
  for (const src of [meta, app, nav]) {
    expect(src).not.toContain('viewMode === "workspace" && id === "codex-auth"');
  }

  // The nav renders straight off PAGE_META; the only split is product vs system.
  expect(nav).toContain('PAGE_META.filter(m => m.group === "product")');

  // It stays in the nav table with its label and icon, and remains routable for deep links.
  expect(meta).toContain('"codex-auth": IconKey');
  expect(meta).toContain('"codex-auth": "nav.codexAuth"');
  expect(app).toContain('{activePage === "codex-auth" && <CodexAuth apiBase={API_BASE} />}');
});
