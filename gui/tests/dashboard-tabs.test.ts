import { expect, test } from "bun:test";
import { hashBelongsToPage, readPageFromHash, resolveAppHashChange, DASHBOARD_TAB_HASHES } from "../src/app-routing";

/**
 * WP2 (devlog/_plan/260725_gui_view_consolidation/020_nav_and_dashboard_tabs.md):
 * Dashboard section tabs live in the hash like Logs, so refresh / bookmark /
 * back-forward keep the choice. Overview is the bare "#dashboard".
 */

test("Dashboard sub-hashes are registered routes, not invalid suffixes", () => {
  for (const raw of DASHBOARD_TAB_HASHES) {
    expect(readPageFromHash(raw)).toBe("dashboard");
    expect(hashBelongsToPage(raw, "dashboard")).toBe(true);

    // A registered hash must survive: no passive replace back to "#dashboard".
    const action = resolveAppHashChange(raw);
    expect(action.page).toBe("dashboard");
    expect(action.replaceTo).toBeNull();
  }
});

test("bare #dashboard stays the Overview route", () => {
  expect(readPageFromHash("dashboard")).toBe("dashboard");
  expect(hashBelongsToPage("dashboard", "dashboard")).toBe(true);
  expect(resolveAppHashChange("dashboard").replaceTo).toBeNull();
  // Overview must not be spelled with a suffix.
  expect(DASHBOARD_TAB_HASHES).not.toContain("dashboard/overview");
});

test("unknown Dashboard suffixes are still normalized away", () => {
  const action = resolveAppHashChange("dashboard/nope");
  expect(action.page).toBe("dashboard");
  expect(action.replaceTo).toBe("dashboard");
});

test("registering Dashboard tabs does not disturb the Logs or Providers contracts", () => {
  expect(hashBelongsToPage("logs/debug", "logs")).toBe(true);
  // WP5: the dual-layout hash is no longer a route — it only exists to be redirected.
  expect(hashBelongsToPage("providers/workspace", "providers")).toBe(false);
  // Cross-page suffixes stay invalid.
  expect(hashBelongsToPage("dashboard/providers", "providers")).toBe(false);
  expect(hashBelongsToPage("logs/debug", "dashboard")).toBe(false);
});

test("Codex Auth sits directly after Dashboard in the sidebar", async () => {
  // Nav order lives in shell/page-meta.ts since the Material 3 shell landed.
  const meta = await Bun.file(new URL("../src/shell/page-meta.ts", import.meta.url)).text();
  const list = meta.slice(meta.indexOf("const ORDER"), meta.indexOf("];", meta.indexOf("const ORDER")));
  const order = [...list.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  expect(order[0]).toBe("dashboard");
  expect(order[1]).toBe("codex-auth");
});

/**
 * Q3 originally asked for order alone and no divider. The Material 3 shell
 * supersedes that: it adds the six system pages (Appearance, Language & voice,
 * Regex builder, Changelog, Version history, Notifications) below the product
 * pages, and M3 separates those groups with a divider. The rule that replaced
 * "no divider" is "exactly one divider, between the two groups" — a second one
 * would mean the nav had grown an undocumented section.
 */
test("the nav separates product from system pages with exactly one divider", async () => {
  const nav = await Bun.file(new URL("../src/shell/AdaptiveNav.tsx", import.meta.url)).text();
  const dividers = [...nav.matchAll(/m3-nav-divider/g)];
  expect(dividers.length).toBe(1);

  // And it sits between the two groups, not anywhere else.
  const productIdx = nav.indexOf('PAGE_META.filter(m => m.group === "product")');
  const systemIdx = nav.indexOf('PAGE_META.filter(m => m.group === "system")');
  const dividerIdx = nav.indexOf('className="m3-nav-divider"');
  expect(productIdx).toBeGreaterThanOrEqual(0);
  expect(systemIdx).toBeGreaterThan(productIdx);
  expect(dividerIdx).toBeGreaterThan(productIdx);
});

/**
 * Supersession: the Material 3 restyle replaced the shared `.page-tabs`
 * underline strip on this screen with the prototype's pill tablist
 * (`.dash-tabs`, owned by styles-dashboard-workspace.css). The invariants the
 * original assertion protected are unchanged and re-pinned here against the M3
 * markup: a real tablist/tab/tabpanel triple, no left rail, and a strip that
 * scrolls rather than wrapping onto a second row (Q7).
 */
test("Dashboard uses a pill tablist strip that scrolls instead of wrapping", async () => {
  const page = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(page).toContain('className="dash-tabs" role="tablist"');
  expect(page).toContain('role="tab"');
  expect(page).toContain('role="tabpanel"');
  // The left rail is gone.
  expect(page).not.toContain("dashboard-workspace-rail");

  // Tabs never wrap; the strip scrolls instead (Q7).
  const css = await Bun.file(new URL("../src/styles-dashboard-workspace.css", import.meta.url)).text();
  const strip = css.slice(css.indexOf(".dash-tabs {"), css.indexOf("}", css.indexOf(".dash-tabs {")));
  expect(strip).toContain("flex-wrap: nowrap");
  expect(strip).toContain("overflow-x: auto");
  // And it is the M3 pill container, not a bottom-border strip. Asserted as the
  // shape token rather than `999px`: the literal says "these corners are round",
  // the token says "these corners are the design system's full round" — and only
  // the second is a thing the appearance editor can restyle, which is the
  // property actually worth pinning.
  expect(strip).toContain("border-radius: var(--r-pill)");
  expect(strip).toContain("var(--m3-surface-container)");
});
