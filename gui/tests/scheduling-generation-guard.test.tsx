/**
 * `useScheduleRuntime`'s generation guard: a slower, now-superseded tick must
 * never overwrite what a newer tick already decided, even when the stale
 * response arrives *after* the newer one has already settled and rendered.
 *
 * Same shape as `tests/use-copy-feedback-race.test.tsx`'s clipboard race —
 * deferred `fetch` responses, settled out of order, asserted against the DOM
 * — because it is the same class of bug: two async operations started in a
 * definite order can resolve in the opposite one, and the code has to decide
 * "newer wins" using something sturdier than resolution order.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useScheduleRuntime } from "../src/scheduling/runtime";
import type { ScheduleRuntime } from "../src/scheduling/runtime";
import type { ScheduleRule } from "../src/scheduling/types";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof fetch;

/** Each fetch call parks here until the test explicitly settles it. */
let pending: Array<{ url: string; resolve: (body: unknown) => void }> = [];

function installDeferredFetch() {
  pending = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return new Promise<Response>(resolve => {
      pending.push({
        url,
        resolve: body => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })),
      });
    });
  }) as typeof fetch;
}

let latestRuntime: ScheduleRuntime | null = null;

function Harness({ apiBase }: { apiBase: string }) {
  const runtime = useScheduleRuntime(apiBase);
  latestRuntime = runtime;
  return (
    <div>
      <span data-testid="theme">{runtime.override?.values.theme ?? "none"}</span>
      <span data-testid="rule">{runtime.override?.ruleId ?? "none"}</span>
    </div>
  );
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    // `useScheduleRuntime` reads/writes the real global `localStorage` (it is
    // the production hook, not a test seam), so this test needs a working one
    // — Bun's own test environment has none by default. happy-dom's `Window`
    // implements the real Web Storage API, so wiring it in here is what makes
    // "seed localStorage, then mount" an actual test of the production path
    // rather than of a stub.
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installDeferredFetch();
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  latestRuntime = null;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
  globalThis.fetch = originalFetch;
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.resolve();
}

function text(id: string): string {
  return host.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
}

const apiRule: ScheduleRule = {
  id: "rule-api-1",
  createdAt: 1,
  label: "Evening theme",
  enabled: true,
  priority: 0,
  days: "everyday",
  source: { kind: "api", url: "https://example.com/schedule.json", refreshMinutes: 1 },
};

async function mount() {
  localStorage.setItem("ocx-m3:schedule", JSON.stringify({ version: 1, rules: [apiRule] }));
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness apiBase="http://proxy.local" />);
    await flush();
  });
}

test("a stale API response never overwrites a newer tick's result", async () => {
  await mount();
  // The mount effect fires one tick immediately, which is the pending[0] fetch.
  expect(pending).toHaveLength(1);

  // A second tick starts (the "Retry now" action, or a rule-list edit would do
  // the same) before the first has resolved — exactly the situation the
  // generation guard exists for.
  await act(async () => {
    latestRuntime!.retry();
    await flush();
  });
  expect(pending).toHaveLength(2);

  // The newer tick settles first.
  await act(async () => {
    pending[1]!.resolve({ ok: true, values: { theme: "dark" } });
    await flush();
  });
  expect(text("theme")).toBe("dark");

  // The older, now-superseded tick settles late, with a *different* answer.
  // Without the generation guard this would flip the displayed theme back.
  await act(async () => {
    pending[0]!.resolve({ ok: true, values: { theme: "light" } });
    await flush();
  });
  expect(text("theme")).toBe("dark");
});

test("a stale failure does not clobber a newer success", async () => {
  await mount();
  expect(pending).toHaveLength(1);

  await act(async () => {
    latestRuntime!.retry();
    await flush();
  });
  expect(pending).toHaveLength(2);

  await act(async () => {
    pending[1]!.resolve({ ok: true, values: { theme: "dark" } });
    await flush();
  });
  expect(text("theme")).toBe("dark");

  await act(async () => {
    pending[0]!.resolve({ ok: false, reason: "network", error: "stale failure" });
    await flush();
  });
  expect(text("theme")).toBe("dark");
});
