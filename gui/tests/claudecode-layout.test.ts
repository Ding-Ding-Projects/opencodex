import { expect, test } from "bun:test";

test("ClaudeCode renders the single stacked layout (no workspace rail)", async () => {
  const page = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  // The Claude nav entry now mounts a Code/Desktop tab wrapper; ClaudeCode itself is
  // mounted by that wrapper, still as one stacked page.
  const claude = await Bun.file(new URL("../src/pages/Claude.tsx", import.meta.url)).text();

  expect(page).not.toContain("claudecode-workspace");
  expect(page).not.toContain("ccw-body");
  expect(page).not.toContain("selectedSection");
  expect(page).not.toContain("claude.workspace.settings");

  expect(app).toContain("<Claude apiBase={API_BASE} />");
  expect(claude).toContain("<ClaudeCode apiBase={apiBase} />");
});

// Save commits every setting on this tab, and the settings search can filter any card
// away — so the save bar is mounted unconditionally, never behind a `search.matches(...)`
// guard that a query could switch off along with the card it used to live in.
test("the save bar is never gated on the settings search", async () => {
  const src = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();
  const at = src.indexOf("<ClaudeCodeSaveBar");
  expect(at).toBeGreaterThan(-1);
  const lineStart = src.lastIndexOf("\n", at);
  expect(src.slice(lineStart, at)).not.toContain("search.matches");
  // and it is not the model-map card's header action any more
  expect(src).not.toContain("<ClaudeCodeModelMapSection rows={rows} onRowsChange={setRows} onSave=");
});

test("ClaudeCode stacked layout mounts every section in order", async () => {
  const src = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();

  const order = [
    "<ClaudeCodeSettingsCard",
    "<ClaudeCodeQuickstartSection",
    "<SmallFastModelSetting",
    "<ClaudeCodeModelMapSection",
    "<ClaudeCodeAliasesSection",
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
});
