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

async function apiKeysSources(): Promise<string> {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const panels = await Bun.file(new URL("../src/pages/api-keys-panels.tsx", import.meta.url)).text();
  return `${page}\n${panels}`;
}

test("ApiKeys renders the single stacked layout (no layout toggle, no workspace rail)", async () => {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const src = await apiKeysSources();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).not.toContain("viewMode");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("ocx-apikeys-view");
  expect(page).not.toContain("ApiKeysWorkspace");
  expect(page).not.toContain("apikeys-workspace");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  expect(app).toContain("<ApiKeys apiBase={API_BASE} />");
  expect(css).not.toContain("styles-apikeys-workspace.css");
  expect(css).not.toContain("styles-claudecode-workspace.css");
  expect(css).toContain(".api-auth-list");
  expect(css).toContain(".api-test-note--ok");
  expect(css).toContain(".api-test-note--error");
  expect(src).toContain('className="api-auth-list');
  expect(src).toContain("api-test-note--ok");
});

test("ApiKeys stacked layout keeps endpoint, generate, keys table, and usage panels", async () => {
  const src = await apiKeysSources();
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();

  const order = [
    't("api.endpointsTitle")',
    't("api.generateTitle")',
    't("api.activeKeys"',
    't("api.usageChatTitle")',
    't("api.usageResponsesTitle")',
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }

  // Exactly one Messages usage example, gated on Claude inbound.
  expect(src.match(/api\.usageMessagesTitle/g)?.length).toBe(1);
  const messagesUsageIdx = src.indexOf('t("api.usageMessagesTitle")');
  expect(messagesUsageIdx).toBeGreaterThan(-1);
  const gateOpenIdx = src.lastIndexOf("claudeCodeEnabled && (", messagesUsageIdx);
  expect(gateOpenIdx).toBeGreaterThan(-1);
  // No other usage title may sit between the gate and the Messages title.
  const between = src.slice(gateOpenIdx, messagesUsageIdx);
  expect(between).not.toContain('t("api.usageChatTitle")');
  expect(between).not.toContain('t("api.usageResponsesTitle")');
  expect(src).toContain("gatewayInboundProtocols(claudeCodeEnabled)");
  expect(page).toContain('fetch(`${apiBase}/api/copilot-desktop`)');
  expect(page).not.toContain('fetch(`${apiBase}/v1/models`)');
  expect(page).toContain('from "../api-access-models"');

  // Per-row delete still gates on a confirmation owned by this screen — now the
  // prototype's blocking dialog, still not a workspace detail pane. The dialog
  // names the key, states what stops working, and says it cannot be undone.
  expect(src).toContain("ApiKeysDeleteDialog");
  expect(src).toContain("keys.find(k => k.id === confirmDelete)");
  expect(src).toContain('t("api.deleteConfirmBody"');
  expect(src).toContain('t("api.deleteConfirmAction")');
  expect(src).toContain('t("codexAuth.irreversible")');
  expect(src).toContain('t("api.noKeys")');
  expect(src).toContain('t("api.colKey")');
  // Double-create guard kept from the workspace era.
  expect(page).toContain("if (creatingRef.current) return false");
});

test("the model catalog search keeps plain text default with a regex opt-in and builder", async () => {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const panels = await Bun.file(new URL("../src/pages/api-keys-panels.tsx", import.meta.url)).text();

  // The search bar is a landmark, offers `.*` as an opt-in, and hands off to the builder.
  expect(panels).toContain('role="search"');
  expect(panels).toContain('t("search.regexHint")');
  expect(panels).toContain('t("regex.invalid")');
  // The builder is anchored beside this field, not a link to the builder page:
  // `<a href="#regex">` navigated the whole window away from the query being typed.
  expect(panels).toContain("<RegexBuilderButton");
  expect(panels).not.toContain('href="#regex"');

  // Plain text is what an untouched search bar does.
  expect(page).toContain("useState(false)");
  // Locally evaluated through the shared matcher, which keeps the 400-character
  // pattern bound this line used to assert directly and strips `g`/`y` — their
  // `lastIndex` leaks between calls, and this search tests three fields per row,
  // so a sticky pattern would keep whichever rows happened to be tested at the
  // right offset.
  expect(page).toContain("settingsMatcher(modelQuery, useRegex, modelFlags)");
  // And never back to a hard-coded compile: pinning `i` is what made a pattern
  // deliberately built as case-sensitive arrive case-insensitive here.
  //
  // Asserted against the code with whole-line comments dropped, because the
  // source now *explains* what it stopped doing and the prose would otherwise
  // fail the check that the prose is describing.
  expect(codeOnly(page)).not.toContain("new RegExp(query");
  // The flags the builder composed are the flags the catalog compiles, and the
  // chip row makes them visible and correctable rather than silent.
  expect(page).toContain("const [modelFlags, setModelFlags] = useState(DEFAULT_SEARCH_FLAGS)");
  expect(panels).toContain("onModelFlagsChange(appliedFlags)");
  expect(panels).toContain("<SearchFlagsRow");
});

test("key create and delete record past-tense revisions and announce themselves", async () => {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();

  expect(page).toContain('summary: t("api.keyCreated")');
  expect(page).toContain('summary: t("api.keyDeleted")');
  expect(page).toContain('title: t("api.keyCreated")');
  expect(page).toContain('title: t("api.keyDeleted")');
  // The revision keeps a restorable `before` without ever storing the secret.
  expect(page).toContain("JSON.stringify({ name: deleted.name, prefix: deleted.prefix })");
  expect(page).not.toContain("data.key,");
});

test("retired apikeys workspace i18n keys stay removed from every locale", async () => {
  const locales = ["en", "de", "ja", "ko", "ru", "zh"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).not.toContain('"api.workspace.');
    expect(dict).not.toContain('"claude.workspace.');
  }
});
