import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderWorkspaceShell from "../src/components/provider-workspace/ProviderWorkspaceShell";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * M3 parity for the Providers rail (design/OpenCodex M3.dc.html → pageProviders):
 *
 *  1. Four status groups — ready, needs setup, NEEDS ATTENTION, disabled. A provider
 *     whose config is complete but whose active account needs re-authentication is a
 *     different problem from one that was never set up; the prototype gives it its own
 *     group, and burying it inside "Needs setup" is what made a broken login invisible.
 *  2. The rail search takes a `.*` regex opt-in, plain text stays the default, and an
 *     invalid pattern reports its error rather than silently matching everything.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
/** Survives afterEach restore so a late React 19 dispatchSetState can read window.event. */
const WINDOW_EVENT_STUB: { event: undefined } = { event: undefined };
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

const providers = {
  alpha: { adapter: "openai-chat", baseUrl: "https://alpha.invalid/v1", hasApiKey: true },
  beta: { adapter: "anthropic", baseUrl: "https://beta.invalid/v1", authMode: "oauth" },
  gamma: { adapter: "openai-chat", baseUrl: "https://gamma.invalid/v1" },
  delta: { adapter: "openai-chat", baseUrl: "https://delta.invalid/v1", hasApiKey: true, disabled: true },
} as unknown as Parameters<typeof ProviderWorkspaceShell>[0]["providers"];

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  // React 19 resolveUpdatePriority reads window.event; happy-dom omits the IE legacy field.
  Object.defineProperty(win, "event", { configurable: true, writable: true, value: undefined });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: true, json: async () => ({}) }) as unknown as Response,
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  // Drain React 19 scheduler work while happy-dom is still installed: the shell defers
  // setState via window.setTimeout(0) + fetch, and a late dispatchSetState would
  // otherwise read window.event after the globals were restored.
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    }
  });
  for (const key of globals) {
    let value = previous[key];
    if (key === "window") {
      if (value == null || typeof value !== "object") {
        value = WINDOW_EVENT_STUB;
      } else if (!Object.prototype.hasOwnProperty.call(value, "event")) {
        try {
          Object.defineProperty(value, "event", { configurable: true, writable: true, value: undefined });
        } catch {
          value = WINDOW_EVENT_STUB;
        }
      }
    }
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

async function mountShell(activeAccountNeedsReauth: Record<string, boolean> = {}) {
  // Lazy import: a static react-dom/client import binds to the document that existed
  // when the module graph loaded and corrupts sibling suites in the same process.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderWorkspaceShell
          providers={providers}
          apiBase=""
          defaultProvider="alpha"
          selectedName={null}
          onSelect={() => {}}
          onAddProvider={() => {}}
          activeAccountNeedsReauth={activeAccountNeedsReauth}
          detail={() => null}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

const groupLabels = () =>
  Array.from(host.querySelectorAll(".pws-rail-group-label")).map((el) => el.textContent);

const rowNames = (groupIndex: number) => {
  const group = host.querySelectorAll(".pws-rail-group")[groupIndex]!;
  return Array.from(group.querySelectorAll(".providers-workspace-rail-name-label")).map((el) => el.textContent);
};

const searchInput = () => host.querySelector(".pws-search-input") as HTMLInputElement;

const setSearch = async (value: string) => {
  const input = searchInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
};

test("a healthy tree groups into ready / needs setup / disabled only", async () => {
  await mountShell();

  // No account is broken, so the attention group must not appear at all — an empty
  // group would read as a permanent warning about nothing.
  expect(groupLabels()).toEqual(["Ready", "Needs setup", "Disabled"]);
});

test("an active account that needs re-auth gets its own group, not the setup pile", async () => {
  await mountShell({ beta: true });

  expect(groupLabels()).toEqual(["Ready", "Needs setup", "Needs attention", "Disabled"]);
  // beta was ready by config; only the live-auth failure moved it, and it must not land
  // beside gamma, which genuinely has no credentials at all.
  expect(rowNames(1)).toEqual(["Gamma"]);
  expect(rowNames(2)).toEqual(["Beta"]);
});

test("the attention group is a real facet in the status filter, with its own count", async () => {
  await mountShell({ beta: true });

  const filterBtn = host.querySelector(".pws-filter-btn") as HTMLButtonElement;
  await act(async () => { filterBtn.click(); });

  const options = Array.from(host.querySelectorAll(".pws-filter-option"));
  const attention = options.find((o) => o.querySelector(".pws-filter-label")?.textContent === "Needs attention");
  expect(attention).toBeDefined();
  expect(attention!.querySelector(".pws-filter-count")?.textContent).toBe("1");

  // Turning the facet off hides that group and nothing else.
  await act(async () => { (attention!.querySelector("input") as HTMLInputElement).click(); });
  expect(groupLabels()).toEqual(["Ready", "Needs setup", "Disabled"]);
});

test("plain text is the default and matches name, adapter and base URL", async () => {
  await mountShell();

  // A base-URL substring the prototype's matcher covers but a name-only search misses.
  await setSearch("gamma.invalid");
  expect(rowNames(0)).toEqual(["Gamma"]);

  // Regex metacharacters are literal until the user opts in: this matches nothing.
  await setSearch("alpha|beta");
  expect(host.querySelector(".pws-rail-empty")).not.toBeNull();
});

test("the .* chip opts into regex, and an invalid pattern reports instead of matching everything", async () => {
  await mountShell();

  const chip = Array.from(host.querySelectorAll(".m3-chip")).find((c) => c.textContent === ".*") as HTMLButtonElement;
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  await act(async () => { chip.click(); });
  expect(chip.getAttribute("aria-pressed")).toBe("true");

  await setSearch("alpha|beta");
  expect(rowNames(0)).toEqual(["Alpha", "Beta"]);

  // An unfinished pattern must not silently fall back to plain text — the reported
  // error and the (empty) rail have to agree.
  await setSearch("alpha(");
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Invalid pattern");
  expect(searchInput().getAttribute("aria-invalid")).toBe("true");
  expect(host.querySelector(".pws-rail-empty")).not.toBeNull();
});

test("the search bar carries a builder shortcut bound to the regex screen", async () => {
  await mountShell();

  const row = host.querySelector(".pws-search-row")!;
  const builder = row.querySelector('a[href="#regex"]');
  expect(builder).not.toBeNull();
  expect(builder!.getAttribute("aria-label")).toBe("Open regex builder");
});

// ---------------------------------------------------------------------------
// The Settings tab's own settings search (design → provSettingsRows + the shared
// settings-search row). It is bound to that field alone and never shares state
// with the rail search above it.
// ---------------------------------------------------------------------------

async function mountSettings() {
  const { createRoot } = await import("react-dom/client");
  const ProviderSettings = (await import("../src/components/provider-workspace/ProviderSettings")).default;
  const item = {
    name: "gamma",
    adapter: "openai-chat",
    baseUrl: "https://gamma.invalid/v1",
    authMode: "key",
    note: "staging endpoint",
  } as unknown as Parameters<typeof ProviderSettings>[0]["item"];
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderSettings
          item={item}
          otherTabSettings={[{ tab: "Accounts", text: "Accounts Add account Add API key" }]}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

const fieldLabels = () =>
  Array.from(host.querySelectorAll(".pwi-settings-field .pwi-settings-label")).map((el) => el.textContent?.trim());

const settingsSearchInput = () =>
  host.querySelector('input[type="search"]') as HTMLInputElement;

const typeSettings = async (value: string) => {
  const input = settingsSearchInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
};

test("the settings surface carries its own search, regex opt-in and builder", async () => {
  await mountSettings();

  const row = host.querySelector('[role="search"]')!;
  expect(row.querySelector('input[type="search"]')?.getAttribute("aria-label")).toBe("Search settings…");
  expect(row.querySelector(".m3-chip")?.textContent).toBe(".*");
  expect(row.querySelector('a[href="#regex"]')?.getAttribute("aria-label")).toBe("Open regex builder");

  // An empty query is not a search: the whole form stays on screen.
  expect(fieldLabels().length).toBeGreaterThan(5);
});

test("typing filters to the matching control and leaves the rest out", async () => {
  await mountSettings();

  await typeSettings("base url");
  expect(fieldLabels()).toEqual(["Base URL"]);

  // Values are indexed too, not just labels — a remembered note finds its field.
  await typeSettings("staging");
  expect(fieldLabels()).toEqual(["Note"]);
});

test("a hit that lives on another tab is named rather than reported as no match", async () => {
  await mountSettings();

  await typeSettings("add api key");
  expect(fieldLabels()).toEqual([]);
  const status = Array.from(host.querySelectorAll('[role="status"]')).map((el) => el.textContent);
  expect(status.some((text) => text?.includes("Accounts"))).toBe(true);
});

test("a query that matches nothing anywhere says so", async () => {
  await mountSettings();

  await typeSettings("zzzz-not-a-setting");
  expect(fieldLabels()).toEqual([]);
  const status = Array.from(host.querySelectorAll('[role="status"]')).map((el) => el.textContent);
  expect(status).toContain("No settings match on this surface.");
});
