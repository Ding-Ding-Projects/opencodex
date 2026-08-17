import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { type Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";

/**
 * WP1 behavioural contract (010_subagents_single.md).
 * Source-substring checks live in subagents-classic.test.ts; this file proves the
 * rendered behaviour: one render path regardless of viewMode, the five-slot cap,
 * and the exact save request.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: { url: string; init?: RequestInit }[] = [];
let available: string[] = [];
let chosen: string[] = [];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  available = ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6"];
  chosen = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const body = JSON.stringify({ available, chosen });
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => ({ available, chosen }),
      } as unknown as Response;
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(viewMode?: "classic" | "workspace") {
  // Imported here, not at module scope: react-dom only wires its delegated `input`
  // listener when the DOM globals already exist, and beforeEach installs them.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      // Save/load outcomes are snackbars now, so the page needs the notification
      // provider the shell mounts — rendering it bare throws from useNotifications.
      <TestLanguageProvider>
        <NotificationsProvider>
          <Subagents apiBase="" viewMode={viewMode} />
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  // Subagents defers its initial load through setTimeout(0), so a macrotask flush is required.
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

/** Model-list rows are toggle buttons keyed by aria-pressed, labelled by their model id. */
function modelRow(id: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll("button"))
    .find((b) => b.hasAttribute("aria-pressed") && (b.textContent ?? "").includes(id));
  if (!row) throw new Error(`model row not found: ${id}`);
  return row as unknown as HTMLButtonElement;
}

/** React tracks the DOM value, so a bare `input.value = …` reads as "no change". */
function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
  input.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
}

/** Featured slots expose a remove control labelled from sub.removeAria ("Remove {m}"). */
function removeButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((b) =>
    /^Remove /.test(b.getAttribute("aria-label") ?? "")) as unknown as HTMLButtonElement[];
}

test("renders the same single surface for classic and workspace preferences", async () => {
  await mount("classic");
  const classicHtml = container.innerHTML;

  const current = root!;
  await act(async () => { current.unmount(); });
  root = null;
  container.innerHTML = "";

  await mount("workspace");
  const workspaceHtml = container.innerHTML;

  // One implementation: the global preference must not change what Subagents renders.
  expect(workspaceHtml).toBe(classicHtml);
  expect(classicHtml).not.toContain("subagents-workspace");
});

test("caps featured selections at five", async () => {
  await mount();

  // Six models available, six clicks — only five may land.
  for (const id of available) {
    await act(async () => { modelRow(id).click(); });
  }

  expect(removeButtons().length).toBe(5);
  expect(container.textContent).toContain("5/5");
  // The sixth row is disabled rather than silently appended.
  expect(modelRow(available[5]!).disabled).toBe(true);

  // The cap lives in TWO places: the disabled attribute above (presentation) and the
  // state guard in toggle(). Force a click past the disabled attribute so a weakened
  // state guard cannot hide behind the UI check.
  await act(async () => { modelRow(available[5]!).dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true })); });
  expect(removeButtons().length).toBe(5);

  // And save must never ship more than five.
  const save = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Save") as HTMLButtonElement | undefined;
  await act(async () => { save!.click(); });
  const put = requests.find((r) => r.init?.method === "PUT");
  expect(JSON.parse(String(put!.init!.body)).models.length).toBe(5);
});

test("search offers plain text by default, a `.*` opt-in, and a builder shortcut", async () => {
  available = ["gpt-5", "anthropic/claude-x", "zai/glm-4"];
  await mount();

  const field = container.querySelector('input[aria-label="Search models (native gpt + routed)…"]') as HTMLInputElement;
  expect(field).toBeTruthy();

  // The builder affordance sits beside the field and opens there. It used to be a
  // link to the builder screen, which meant reaching for it threw away the field.
  const builder = container.querySelector('button[aria-haspopup="dialog"]');
  expect(builder).toBeTruthy();
  expect(builder!.getAttribute("aria-label")).toBe("Open regex builder");
  expect(Array.from(container.querySelectorAll("a")).some((a) => a.getAttribute("href") === "#regex")).toBe(false);

  // Plain text is the default: a regex metacharacter matches nothing literally.
  await act(async () => { setInputValue(field, "^gpt"); });
  expect(container.textContent).toContain("No models match your search.");

  // Opting in to `.*` makes the same query a pattern.
  const toggle = Array.from(container.querySelectorAll("button"))
    .find((b) => b.getAttribute("title") === "Match with a regular expression instead of plain text");
  expect(toggle).toBeTruthy();
  await act(async () => { toggle!.click(); });
  expect(container.textContent).not.toContain("No models match your search.");
  expect(container.textContent).toContain("gpt-5");
  expect(container.textContent).not.toContain("claude-x");

  // An invalid pattern is reported, not swallowed, and marks the field.
  await act(async () => { setInputValue(field, "["); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid pattern");
  expect(field.getAttribute("aria-invalid")).toBe("true");
});

test("labels a bare slug as the native provider and keeps a routed prefix", async () => {
  available = ["gpt-5", "anthropic/claude-x"];
  await mount();

  await act(async () => { modelRow("gpt-5").click(); });
  await act(async () => { modelRow("anthropic/claude-x").click(); });

  // A bare slug is an OpenAI passthrough model; the routed one keeps its provider prefix.
  expect(container.textContent).toContain("OpenAI native");
  expect(container.textContent).toContain("anthropic");
});

test("a save notifies with a split title/body and records a named revision", async () => {
  await mount();
  await act(async () => { modelRow("a-1").click(); });

  const save = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Save") as HTMLButtonElement | undefined;
  await act(async () => { save!.click(); });

  // Title states what happened; body states what to do next — a snackbar, not one long line.
  const notices = JSON.parse(testWindow.localStorage.getItem("ocx-m3:notifications") ?? "[]");
  expect(notices[0].title).toBe("Saved 1 models.");
  expect(notices[0].body).toContain("Start a new Codex session");
  expect(notices[0].title).not.toContain("Start a new Codex session");

  // Version history needs a named event, not "Updated" — and the pre-save state to restore.
  const revisions = JSON.parse(testWindow.localStorage.getItem("ocx-m3:revisions") ?? "[]");
  expect(revisions[0].summary).toBe("Featured subagent models set to a-1");
  expect(revisions[0].before).toBe(JSON.stringify([]));
});

test("saves the featured order with PUT and the models payload", async () => {
  await mount();

  await act(async () => { modelRow("a-1").click(); });
  await act(async () => { modelRow("a-2").click(); });

  const save = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Save") as HTMLButtonElement | undefined;
  expect(save).toBeDefined();
  await act(async () => { save!.click(); });

  const put = requests.find((r) => r.init?.method === "PUT");
  expect(put).toBeDefined();
  expect(put!.url).toContain("/api/subagent-models");
  expect(put!.init?.body).toBe(JSON.stringify({ models: ["a-1", "a-2"] }));
});
