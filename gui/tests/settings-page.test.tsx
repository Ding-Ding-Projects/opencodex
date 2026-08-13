/**
 * Settings screen — the aggregate surface.
 *
 * Three things this guards, because each is easy to lose quietly:
 *
 * 1. The history promise is rendered, not just implemented. `settings.historyNote`
 *    is the page's contract with the user; a page that records revisions without
 *    saying so has kept the letter of the rule and none of its point.
 * 2. A write the server refuses records nothing. The endpoints here echo what they
 *    stored, so a refused change echoes the old value — logging against the value
 *    the UI *asked* for would fill Version history with changes that never happened.
 * 3. A real change records exactly one revision naming the setting and its new
 *    value, so the entry says what to restore rather than merely that something moved.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Settings from "../src/pages/Settings";
import { TestLanguageProvider } from "./helpers/providers";
import { PrefsProvider } from "../src/theme/prefs";
import { NotificationsProvider } from "../src/shell/notifications";
import { readHistory } from "../src/shell/notifications-context";
import { readRevisions } from "../src/shell/revisions";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const GiB = 1024 ** 3;

/** Server state the fake proxy reports; PUTs mutate it exactly as the real routes do. */
let state: {
  codexAutoStart: boolean;
  shadowCallEnabled: boolean;
  /** When true the shadow-call route stores nothing and echoes what it already had. */
  refuseShadowCall: boolean;
};

let puts: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  state = { codexAutoStart: false, shadowCallEnabled: false, refuseShadowCall: false };
  puts = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (init?.method === "PUT") {
      puts.push({ url, body });
      if (url.includes("/api/settings")) {
        if (typeof body?.codexAutoStart === "boolean") state.codexAutoStart = body.codexAutoStart;
        return Response.json({ ok: true, codexAutoStart: state.codexAutoStart });
      }
      if (url.includes("/api/shadow-call-settings")) {
        if (!state.refuseShadowCall && typeof body?.enabled === "boolean") state.shadowCallEnabled = body.enabled;
        return Response.json({ ok: true, enabled: state.shadowCallEnabled, model: "gpt-5.6-luna" });
      }
      return new Response(null, { status: 404 });
    }
    if (url.includes("/api/settings")) {
      return Response.json({ codexAutoStart: state.codexAutoStart, port: 8123, hostname: "127.0.0.1" });
    }
    if (url.includes("/api/injection-model")) {
      return Response.json({
        multiAgentGuidanceEnabled: true,
        syncCodexSubagentDefaults: false,
        model: "openai/gpt-5.6",
        effort: "high",
      });
    }
    if (url.includes("/api/effort-caps")) return Response.json({ effortCap: "high", subagentEffortCap: null });
    if (url.includes("/api/v2")) return Response.json({ multiAgentMode: "default" });
    if (url.includes("/api/shadow-call-settings")) {
      return Response.json({ enabled: state.shadowCallEnabled, model: "gpt-5.6-luna" });
    }
    if (url.includes("/api/sidecar-settings")) {
      return Response.json({ webSearch: { model: "gpt-5.6-luna" }, vision: { model: "gpt-5.6-luna" } });
    }
    if (url.includes("/api/storage/cleanup-policy")) {
      return Response.json({
        enabled: false,
        trigger: { archivedBytesOver: 5 * GiB },
        target: { removeOldestPercent: 25 },
        schedule: "manual",
        mode: "quarantine",
      });
    }
    if (url.includes("/api/debug")) {
      return Response.json({ enabled: false, usage: false, injection: false, claude: false });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <TestLanguageProvider>
          <NotificationsProvider>
            <Settings apiBase="" />
          </NotificationsProvider>
        </TestLanguageProvider>
      </PrefsProvider>,
    );
  });
  await settle();
  return { container, root };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });
  }
}

function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

function switchFor(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[role='switch'][aria-label='${label}']`);
  if (!found) throw new Error(label);
  return found;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as never); });
  await settle();
}

test("gathers every group under its heading and shows the history promise", async () => {
  const { container, root } = await mount();

  const headings = [...container.querySelectorAll(".m3-card-title")].map(node => node.textContent);
  expect(headings).toEqual(["Proxy", "Routing", "Agents", "Storage", "Appearance", "Privacy & history"]);

  // The promise the page makes about every change it writes, visible before the
  // user touches a control rather than buried in a tooltip.
  expect(container.textContent).toContain("writes a snapshot to the local git history");

  // A setting whose real editor is a richer screen shows its value and a way there,
  // instead of a second-rate copy of that screen's control.
  const jumps = [...container.querySelectorAll("a.m3-btn")].map(node => node.textContent);
  expect(jumps).toContain("Open Storage");
  expect(jumps).toContain("Open Appearance");

  await act(async () => { root.unmount(); });
});

test("a change the server accepts records one revision naming the setting and its new value", async () => {
  const { container, root } = await mount();

  expect(readRevisions()).toHaveLength(0);
  await click(switchFor(container, "Start opencodex with Codex"));

  expect(puts.map(p => p.body)).toEqual([{ codexAutoStart: true }]);
  const revisions = readRevisions();
  expect(revisions).toHaveLength(1);
  expect(revisions[0].scope).toBe("settings");
  expect(revisions[0].summary).toBe("Start opencodex with Codex set to Enabled");
  // The prior value rides along, so a restore has something to put back.
  expect(revisions[0].before).toBe(JSON.stringify({ codexAutoStart: false }));

  // Informational, so it is a snackbar — and it points at where the undo lives.
  const notices = readHistory();
  expect(notices[0]?.title).toBe("Setting saved");
  expect(notices[0]?.tone).toBe("success");

  await act(async () => { root.unmount(); });
});

test("a write the server refuses records nothing and does not claim it saved", async () => {
  state.refuseShadowCall = true;
  const { container, root } = await mount();

  const toggle = switchFor(container, "Shadow Call Intercept");
  await click(toggle);

  // The request went out and the server answered — it simply stored nothing.
  expect(puts.map(p => p.url.includes("/api/shadow-call-settings"))).toEqual([true]);
  // Nothing moved, so nothing is recorded: the history stays a list of real events.
  expect(readRevisions()).toHaveLength(0);
  // The control springs back to what the server actually has.
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  // And the page says so rather than showing "Setting saved" over a refused write.
  const notices = readHistory();
  expect(notices[0]?.title).toBe("Could not save that setting");
  expect(notices.some(notice => notice.title === "Setting saved")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("the search filters this surface and names the tab that owns a setting it does not carry", async () => {
  const { container, root } = await mount();

  const search = container.querySelector<HTMLInputElement>("input[aria-label='Search settings…']");
  expect(search).toBeTruthy();

  const headings = () => [...container.querySelectorAll(".m3-card-title")].map(node => node.textContent);

  await act(async () => { typeInto(search!, "cleanup"); });
  await settle();
  expect(headings()).toEqual(["Storage"]);

  // A hit that lives on a workspace this page deliberately does not duplicate is
  // reported by name, so a miss here never reads as "that setting does not exist".
  await act(async () => { typeInto(search!, "Rotation strategy"); });
  await settle();
  expect(container.querySelector("[role='status']")?.textContent).toContain("Codex Auth");

  // An invalid regex matches nothing and says so, rather than silently falling back
  // to plain text and showing rows the user did not ask for.
  const regexChip = [...container.querySelectorAll("button.m3-chip")].find(node => node.textContent === ".*");
  await click(regexChip!);
  await act(async () => { typeInto(search!, "cleanup("); });
  await settle();
  expect(container.querySelector("[role='status']")?.textContent).toContain("Invalid");
  expect(headings()).toEqual([]);

  await act(async () => { root.unmount(); });
});
