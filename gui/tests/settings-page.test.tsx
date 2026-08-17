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
 *
 * Both of those last two now happen at *apply*, not at click. `SettingsDraftProvider`
 * superseded the page's own writes: a row edits the staged snapshot and nothing
 * else, and `apply()` owns the only endpoint PUT and the only revision. So the
 * tests below stage on the page and then apply through the same public context
 * the app bar's Save uses — the accept/refuse semantics they were written to
 * protect are unchanged, only the moment they occur moved.
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
import { useSettingsDrafts } from "../src/settings-drafts-context";
import { useSettingsSave } from "../src/shell/use-settings-save";

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
  /**
   * When set, the shadow-call route fails outright with this status and error
   * body — the write never lands, as distinct from landing and being refused.
   */
  rejectShadowCall: { status: number; error: string } | null;
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

  state = { codexAutoStart: false, shadowCallEnabled: false, refuseShadowCall: false, rejectShadowCall: null };
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
        if (state.rejectShadowCall) {
          return Response.json(
            { error: state.rejectShadowCall.error },
            { status: state.rejectShadowCall.status },
          );
        }
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

/**
 * The app bar's Save button, reduced to the one thing these tests drive.
 *
 * `SettingsDraftProvider.apply()` is the only place a Settings endpoint is ever
 * written, and the real trigger lives in `AppBar`. Mounting the whole app bar
 * here would drag the cost meter and quick-restore polls in for one button, so
 * this reaches the save through the same public hook the app bar itself uses.
 *
 * `useSettingsSave` rather than `apply` directly, and that is load-bearing
 * rather than incidental: the notice is raised by the hook, so a stand-in that
 * called `apply` bare would make every assertion about what the user is told
 * pass for the wrong reason — including the negative one, which would then hold
 * on a build that raises no notices at all.
 */
function DraftSaveButton() {
  const { dirtyCount } = useSettingsDrafts();
  const { save, applying } = useSettingsSave();
  return (
    <button type="button" aria-label="Save changes" disabled={applying} onClick={() => { void save(); }}>
      {dirtyCount}
    </button>
  );
}

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
            <DraftSaveButton />
          </NotificationsProvider>
        </TestLanguageProvider>
      </PrefsProvider>,
    );
  });
  await settle();
  return { container, root };
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>("button[aria-label='Save changes']");
  if (!found) throw new Error("Save changes");
  return found;
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

  // Staging is not saving. The row repaints at once, but the endpoint and the
  // history are both untouched until Save — that is what the draft coordinator
  // bought, and a click that quietly wrote through would give it straight back.
  expect(puts).toEqual([]);
  expect(readRevisions()).toHaveLength(0);
  expect(switchFor(container, "Start opencodex with Codex").getAttribute("aria-checked")).toBe("true");

  await click(saveButton(container));

  expect(puts.map(p => p.body)).toEqual([{ codexAutoStart: true }]);
  const revisions = readRevisions();
  expect(revisions).toHaveLength(1);
  expect(revisions[0].scope).toBe("settings");
  // The summary is the changed setting and the value the server echoed back, in
  // the words the row itself uses. It supersedes `codexAutoStart:true`, which is
  // what this asserted while `SettingsDraftProvider` — mounted above
  // `LanguageProvider` by design — was assumed unable to reach any copy at all.
  // It reaches `translate()` directly instead, with the locale and funny levels
  // it already owns, so Version history reads as prose rather than as wire names.
  expect(revisions[0].label).toBe("Settings");
  expect(revisions[0].summary).toBe("Start opencodex with Codex set to Enabled");
  // The prior value rides along, so a restore has something to put back.
  expect(revisions[0].before).toBe(JSON.stringify(false));

  // And the save says so, once, rather than leaving the disappearing draft bar
  // as the only evidence that anything reached the server.
  const saved = readHistory().filter(notice => notice.title === "Setting saved");
  expect(saved).toHaveLength(1);
  expect(saved[0].tone).toBe("success");
  // Auto-dismissing is the point of a success tone here: it is confirmation, not
  // something the user has to clear. Only errors persist.
  expect(saved[0].body).toContain("Version history");

  await act(async () => { root.unmount(); });
});

test("a write the server refuses records nothing and does not claim it saved", async () => {
  state.refuseShadowCall = true;
  const { container, root } = await mount();

  await click(switchFor(container, "Shadow Call Intercept"));
  await click(saveButton(container));

  // The request went out and the server answered — it simply stored nothing.
  expect(puts.map(p => p.url.includes("/api/shadow-call-settings"))).toEqual([true]);
  // Nothing moved, so nothing is recorded: the history stays a list of real events.
  // Only an echo that both matches what was asked for and differs from the prior
  // value earns a revision, which is what keeps a refusal out of the log.
  expect(readRevisions()).toHaveLength(0);
  // The refused field stays staged rather than springing back, which is the draft
  // coordinator's deliberate change: an unaccepted value is kept for another
  // attempt instead of being silently discarded out from under the user.
  expect(switchFor(container, "Shadow Call Intercept").getAttribute("aria-checked")).toBe("true");
  // So the one thing that must not happen is a claim that it saved. The draft bar
  // still reads dirty, because applying it changed nothing on the server.
  expect(readHistory().some(notice => notice.title === "Setting saved")).toBe(false);
  expect(saveButton(container).textContent).toBe("1");

  // The other thing that must not happen is silence. A staged control that will
  // not clear, with nothing on screen to explain it, reads as a broken Save
  // rather than as a server that declined — so the refusal is stated, it names
  // the setting, and it says the value is still staged for another attempt.
  const refusal = readHistory().filter(notice => notice.title === "Could not save that setting");
  expect(refusal).toHaveLength(1);
  expect(refusal[0].body).toContain("Shadow Call Intercept");
  expect(refusal[0].body).toContain("still staged");
  // Error tone, which is what keeps it on screen: `NotificationsProvider` sets an
  // auto-dismiss timer for every tone except this one.
  expect(refusal[0].tone).toBe("error");

  await act(async () => { root.unmount(); });
});

test("a write that never lands names the setting and quotes the server's own message", async () => {
  // Distinct from a refusal: the endpoint did not answer with a usable echo at
  // all, so there is no stored value to report — only the reason it failed, which
  // is the server's own copy rather than a generic apology invented here.
  state.rejectShadowCall = { status: 503, error: "shadow call worker is restarting" };
  const { container, root } = await mount();

  await click(switchFor(container, "Shadow Call Intercept"));
  await click(saveButton(container));

  expect(readRevisions()).toHaveLength(0);
  expect(readHistory().some(notice => notice.title === "Setting saved")).toBe(false);

  const failure = readHistory().filter(notice => notice.title === "Could not save that setting");
  expect(failure).toHaveLength(1);
  expect(failure[0].tone).toBe("error");
  expect(failure[0].body).toContain("Shadow Call Intercept");
  expect(failure[0].body).toContain("shadow call worker is restarting");

  // Unchanged by any of this: the value stays staged so it can be retried, which
  // is exactly the state the notice exists to explain.
  expect(switchFor(container, "Shadow Call Intercept").getAttribute("aria-checked")).toBe("true");
  expect(saveButton(container).textContent).toBe("1");

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
