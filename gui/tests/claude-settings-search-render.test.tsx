import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TestLanguageProvider } from "./helpers/providers";
import { useT } from "../src/i18n/shared";
import { ClaudeCodeSettingsCard } from "../src/pages/claude-code-sections";
import { ClaudeSettingsSearchRow } from "../src/pages/claude-code-settings";
import { claudeSettingsSearch, type ClaudeSettingId } from "../src/pages/claude-settings-search";
import type { ClaudeCodeState } from "../src/pages/claude-code-types";

// `detectInitial()` reads navigator.language; bun's DOM shim leaves it undefined.
let originalLanguageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  originalLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(() => {
  if (originalLanguageDescriptor) {
    Object.defineProperty(globalThis.navigator, "language", originalLanguageDescriptor);
  } else {
    delete (globalThis.navigator as { language?: string }).language;
  }
});

const STATE: ClaudeCodeState = {
  enabled: true,
  authMode: "auto",
  authModeOrigin: "auto-absent",
  autoConnectSupported: true,
  systemEnv: false,
  fastMode: null,
  maxContextTokens: null,
  autoContext: true,
  autoCompactWindow: null,
  injectAgents: true,
  smallFastModel: "",
  effectiveModelEnv: {},
  available: [],
  aliases: [],
  port: 4141,
};

function renderCard(match: (id: ClaudeSettingId) => boolean): string {
  return renderToStaticMarkup(
    <TestLanguageProvider>
      <ClaudeCodeSettingsCard
        state={STATE}
        autoCompactOptions={[]}
        onStateChange={() => {}}
        match={match}
      />
    </TestLanguageProvider>,
  );
}

function renderRow(query: string, regexOn: boolean): string {
  // The row renders the note from the same search result the cards are filtered by, so
  // the message and the visible controls can never disagree.
  const Probe = () => {
    const t = useT();
    const search = claudeSettingsSearch(query, regexOn, t);
    return <ClaudeSettingsSearchRow query={query} onQuery={() => {}} regexOn={regexOn} onRegex={() => {}} search={search} />;
  };
  return renderToStaticMarkup(<TestLanguageProvider><Probe /></TestLanguageProvider>);
}

test("with no query every settings row is rendered", () => {
  const html = renderCard(() => true);
  expect(html).toContain("Claude connection");
  expect(html).toContain("Auth Mode");
  expect(html).toContain("Fast Mode (OpenAI)");
  expect(html).toContain("Auto-register subagents");
  expect(html).toContain("Vision sidecar override");
});

// A search must remove the rows it did not match, not merely highlight them — otherwise
// the user still scans the same wall of controls they typed to avoid.
test("a search narrows the cards to the matching rows only", () => {
  const html = renderCard(id => id === "authMode");
  expect(html).toContain("Auth Mode");
  expect(html).not.toContain("Fast Mode (OpenAI)");
  expect(html).not.toContain("Auto-register subagents");
});

// An emptied card must disappear rather than render as a bare rounded rectangle.
test("a card with no surviving rows is not rendered at all", () => {
  const html = renderCard(id => id === "injectAgents");
  expect(html).toContain("Auto-register subagents");
  expect(html).not.toContain("Claude connection");
  // Exactly one card survives: the connection card is gone, the behaviour card remains.
  expect(html.split("m3-card").length - 1).toBe(1);
});

test("the search row offers the regex opt-in and the builder, anchored to the field", () => {
  const html = renderRow("", false);
  expect(html).toContain('role="search"');
  expect(html).toContain('aria-label="Search settings…"');
  expect(html).toContain(".*");
  // Anchored, not navigating: the affordance is a button that opens the builder
  // beside this field, where `<a href="#regex">` used to replace the whole screen.
  expect(html).not.toContain('href="#regex"');
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('aria-label="Open regex builder"');
  expect(html).toContain('aria-pressed="false"');
});

test("an invalid pattern is reported as an alert on the field, not as a silent empty list", () => {
  const html = renderRow("model(", true);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Invalid pattern");
  expect(html).toContain('aria-invalid="true"');
});
