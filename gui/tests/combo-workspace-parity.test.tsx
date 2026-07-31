import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComboItem } from "../src/combo-workspace-data";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { LanguageProvider } from "../src/i18n/provider";
import { NotificationsProvider } from "../src/shell/notifications";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

/** `alpha` has a single target, so it is a "needs attention" combo; `beta` is healthy. */
const combos: ComboItem[] = [
  {
    id: "alpha",
    model: "combo/alpha",
    alias: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "openai", model: "gpt-5", clientKey: "ct-a" }],
  },
  {
    id: "beta",
    model: "combo/beta",
    alias: null,
    strategy: "round-robin",
    stickyLimit: 4,
    defaultEffort: null,
    targets: [
      { provider: "openai", model: "gpt-5", clientKey: "ct-b1" },
      { provider: "anthropic", model: "claude-4", clientKey: "ct-b2" },
    ],
  },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function workspace(extra: Partial<Parameters<typeof ComboWorkspace>[0]> = {}) {
  return (
    // The detail panel reports a successful save through the notification system,
    // so the provider it reads has to exist even in the tests that never save.
    <LanguageProvider>
      <NotificationsProvider>
        <ComboWorkspace
          combos={combos}
          providers={[{ name: "openai" }, { name: "anthropic" }]}
          models={[{ provider: "openai", id: "gpt-5" }, { provider: "anthropic", id: "claude-4" }]}
          loading={false}
          onRefresh={() => {}}
          onSave={async () => ({ ok: true })}
          onRemove={async () => ({ ok: true })}
          onAdd={() => {}}
          adding={false}
          onCloseAdd={() => {}}
          onCreated={() => {}}
          {...extra}
        />
      </NotificationsProvider>
    </LanguageProvider>
  );
}

test("the page-level blurb and count strip are not duplicated inside the workspace", () => {
  // Both moved up to Combos.tsx, where the prototype puts them — above the rail/detail
  // split, so they stay visible while a combo is selected. Rendering them here too
  // would show them twice on the overview and never on a detail.
  const html = renderToStaticMarkup(workspace());
  expect(html).not.toContain("cwi-overview-blurb");
  expect(html).not.toContain("cwi-count-strip");
  // The overview's own cards are still its job.
  expect(html).toContain("How it works");
});

test("the rail search offers a regex opt-in and the anchored builder", () => {
  const html = renderToStaticMarkup(workspace());
  expect(html).toContain('aria-label="Open regex builder"');
  // "Anchored" is the point of the test: the affordance opens a panel beside the
  // rail search, where the old link navigated the window to the builder page and
  // left the rail — and whatever had been typed into it — behind.
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).not.toContain('href="#regex"');
});

test("an invalid regex reports the engine error and matches nothing", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(workspace());
  });

  const regexChip = [...container.querySelectorAll<HTMLButtonElement>(".cwi-search-row button")][0]!;
  await act(async () => { regexChip.click(); });

  const search = container.querySelector<HTMLInputElement>(".cwi-search-input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(search, "alpha(");
    search.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid pattern");
  expect(container.querySelectorAll(".combos-workspace-rail-row").length).toBe(0);

  // A valid pattern selects only what it matches.
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(search, "combo/alph[ab]");
    search.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const names = [...container.querySelectorAll(".combos-workspace-rail-name")].map((n) => n.textContent);
  expect(names).toEqual(["combo/alpha"]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a combo needing attention is marked in the rail and bannered in its detail", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(workspace());
  });
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });

  const rows = [...container.querySelectorAll<HTMLButtonElement>(".combos-workspace-rail-row")];
  const alpha = rows.find((row) => row.querySelector(".combos-workspace-rail-name")?.textContent === "combo/alpha")!;
  const beta = rows.find((row) => row.querySelector(".combos-workspace-rail-name")?.textContent === "combo/beta")!;
  expect(alpha.querySelector('[aria-label="Needs attention"]')).toBeTruthy();
  expect(beta.querySelector('[aria-label="Needs attention"]')).toBeNull();

  await act(async () => { alpha.click(); });
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });

  const banner = container.querySelector(".combos-workspace-detail .dash-notice--warn");
  expect(banner?.textContent).toContain("Only one target");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("the config tab's settings search filters its cards and points at the other tab", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(workspace());
  });
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });

  const alpha = [...container.querySelectorAll<HTMLButtonElement>(".combos-workspace-rail-row")]
    .find((row) => row.querySelector(".combos-workspace-rail-name")?.textContent === "combo/alpha")!;
  await act(async () => { alpha.click(); });
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });

  const settings = container.querySelector<HTMLInputElement>('input[aria-label="Search settings…"]')!;
  expect(settings).toBeTruthy();

  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(settings, "weight");
    settings.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  // Only the Targets card mentions weights, so the identity card is filtered out.
  expect(container.querySelector("#cwi-edit-id")).toBeNull();
  expect(container.textContent).toContain("Order matters");

  // A term that only the About tab carries reports the tab by name rather than
  // pretending the setting does not exist.
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(settings, "Retry-After");
    settings.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("About");

  await act(async () => { root.unmount(); });
  container.remove();
});
