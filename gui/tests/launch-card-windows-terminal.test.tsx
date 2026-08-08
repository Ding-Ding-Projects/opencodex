import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import LaunchCard from "../src/components/LaunchCard";
import { LanguageProvider } from "../src/i18n/provider";
import { NotificationsProvider } from "../src/shell/notifications";
import SnackbarHost from "../src/shell/SnackbarHost";

/**
 * "Open Grok CLI" used to fail with a red notice that named the fix — install
 * Windows Terminal — and then left the user to go and do it by hand, in an app
 * whose standing rule is that "Get it" installs the thing. The notice is the
 * defect these cases exist to prevent coming back: a launch failure with a
 * remedy must carry the remedy, and a remedy that did not work must say so
 * instead of offering itself again forever.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

let launchAttempts = 0;
let installPosts = 0;
/** How the proxy answers the second launch, after the install. */
let terminalAppearsAfterInstall = true;
let installVerified = true;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  launchAttempts = 0;
  installPosts = 0;
  terminalAppearsAfterInstall = true;
  installVerified = true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/launch") && init?.method === "POST") {
        launchAttempts += 1;
        if (launchAttempts > 1 && terminalAppearsAfterInstall) {
          return jsonResponse({ ok: true, id: "grok-cli", label: "Grok CLI" });
        }
        // The shape the proxy actually returns: a sentence for the user, and a
        // code the dashboard can branch on.
        return jsonResponse({
          ok: false,
          id: "grok-cli",
          label: "Grok CLI",
          reason: "needs-windows-terminal",
          error: "Windows Terminal (wt.exe) is not installed, and opencodex will not open a legacy console window.",
        }, false, 409);
      }
      if (u.endsWith("/api/launch/install") && init?.method === "POST") {
        installPosts += 1;
        expect(JSON.parse(String(init.body))).toEqual({ id: "windows-terminal" });
        return jsonResponse({
          ok: true,
          job: {
            id: "install-1",
            label: "Windows Terminal",
            state: "done",
            log: ["$ winget Microsoft.WindowsTerminal"],
            verified: installVerified,
          },
        });
      }
      return jsonResponse({
        targets: [{
          id: "grok-cli",
          label: "Grok CLI",
          kind: "cli",
          available: true,
          installUrl: "https://github.com/superagent-ai/grok-cli",
        }],
      });
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

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <NotificationsProvider>
          <LaunchCard apiBase="" />
          <SnackbarHost />
        </NotificationsProvider>
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
}

function buttonLabelled(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button"))
    .find(b => (b.textContent ?? "").trim() === text) as unknown as HTMLButtonElement | undefined;
}

function errorSnack(): Element | undefined {
  return Array.from(container.querySelectorAll(".m3-snack.error")).at(-1);
}

async function clickOpen() {
  const open = buttonLabelled("Open");
  if (!open) throw new Error("the Open button is missing");
  await act(async () => { open.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

test("a missing Windows Terminal is offered as an install, not printed as a dead end", async () => {
  await mount();
  await clickOpen();

  const snack = errorSnack();
  expect(snack).toBeDefined();
  // Persistent, per the notification rule: an error stays until dismissed. It is
  // a snackbar with an action, never a modal that halts the app.
  expect(snack!.getAttribute("role")).toBe("alert");
  expect(snack!.textContent).toContain("Could not open Grok CLI");
  const action = snack!.querySelector(".m3-snack-action") as unknown as HTMLButtonElement | null;
  expect(action).not.toBeNull();
  expect(action!.textContent).toBe("Install Windows Terminal");

  await act(async () => { action!.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 40)); });

  // The install ran, and the launch was retried rather than left to the user.
  expect(installPosts).toBe(1);
  expect(launchAttempts).toBe(2);
  expect(container.textContent).toContain("Grok CLI opened");
});

test("an install the proxy still cannot see says restart, and stops offering itself", async () => {
  // Windows Terminal ships with Windows 11 but not with every Windows 10 or
  // trimmed image, and an installer extends the machine PATH while a running
  // process keeps the environment it started with. Claiming success there — or
  // looping on the same install — would be worse than the original dead end.
  terminalAppearsAfterInstall = false;
  installVerified = false;

  await mount();
  await clickOpen();

  const action = errorSnack()?.querySelector(".m3-snack-action") as unknown as HTMLButtonElement | null;
  expect(action).not.toBeNull();
  await act(async () => { action!.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 40)); });

  expect(installPosts).toBe(1);
  expect(launchAttempts).toBe(2);
  const final = errorSnack();
  expect(final!.textContent).toContain("Restart opencodex");
  // No second offer: the answer to "installed but invisible" is a restart.
  expect(final!.querySelector(".m3-snack-action")).toBeNull();
});
