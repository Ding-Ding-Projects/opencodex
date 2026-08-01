/**
 * What the pairing QR on Remote access actually encodes.
 *
 * The old code carried a bare `#/mobile` URL, which got the phone to the screen
 * and left the user typing a 43-character key into it. The whole value of the
 * change is that the token rides along — so "the QR contains the token" is the
 * one assertion that cannot be replaced by something easier to check.
 *
 * It is checked against the encoder rather than against the alt text on purpose.
 * The alt text deliberately omits the token (a screen reader would read a live
 * credential out loud), so reading it back would prove the opposite of what is
 * wanted. Comparing the rendered path to `qrSvgPath(encodeQr(expected))` pins
 * the actual matrix: any other payload produces a different path.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import Network from "../src/pages/Network";
import { LanguageProvider } from "../src/i18n/provider";
import { PrefsProvider } from "../src/theme/prefs";
import { NotificationsProvider } from "../src/shell/notifications";
import { ConfirmProvider } from "../src/shell/confirm";
import { encodeQr, qrSvgPath } from "../src/lib/qr";

const TOKEN = "Ab3-_xyzAb3-_xyzAb3-_xyzAb3-_xyzAb3-_xyzAb3";
const LAN = "http://192.168.1.50:10100/";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let pairCalls: { method: string }[] = [];
let restartPending = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.includes("/api/host/pair")) {
    pairCalls.push({ method });
    if (method === "DELETE") return Promise.resolve(json({ ok: true }));
    return Promise.resolve(json({ token: TOKEN, expiresAt: Date.now() + 5 * 60_000 }));
  }
  if (url.includes("/api/host/history")) return Promise.resolve(json({ entries: [] }));
  if (url.includes("/api/host")) {
    return Promise.resolve(json({
      hostname: "0.0.0.0", port: 10100, exposed: true,
      credentialConfigured: true, urls: [LAN], restartPending,
    }));
  }
  return Promise.resolve(json({}));
}

beforeEach(() => {
  pairCalls = [];
  restartPending = false;
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#network" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    fetch: { configurable: true, value: serve },
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: serve });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/** A distinct apiBase per test: client-resource caches by key, and a shared key would serve a stale host status. */
async function mount(apiBase: string): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <LanguageProvider>
          <NotificationsProvider>
            <ConfirmProvider>
              <Network apiBase={apiBase} />
            </ConfirmProvider>
          </NotificationsProvider>
        </LanguageProvider>
      </PrefsProvider>,
    );
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  return { container, root };
}

function clickText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent?.includes(text));
  button?.click();
  return button as HTMLButtonElement | undefined;
}

test("the QR encodes the mobile route WITH the pairing token", async () => {
  const { container, root } = await mount("/qr1");

  await act(async () => { clickText(container, "Pair a phone"); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

  // Minted when the panel opened, exactly once.
  expect(pairCalls.filter(c => c.method === "POST")).toHaveLength(1);

  const svg = container.querySelector("svg[role='img']");
  expect(svg).toBeTruthy();

  const expected = `http://192.168.1.50:10100/#/mobile?pair=${TOKEN}`;
  const path = svg!.querySelector("path")?.getAttribute("d");
  expect(path).toBe(qrSvgPath(encodeQr(expected)).path);

  // And the payload genuinely fits the encoder's supported versions — a QR that
  // throws renders nothing at all, which would fail silently in the browser.
  expect(() => encodeQr(expected)).not.toThrow();

  // The label a screen reader announces carries the address and not the secret.
  const label = svg!.getAttribute("aria-label") ?? "";
  expect(label).toContain("192.168.1.50:10100");
  expect(label).not.toContain(TOKEN);

  // Nor does the visible caption, which is the part that ends up in screenshots.
  const caption = container.querySelector("figcaption")?.textContent ?? "";
  expect(caption).not.toContain(TOKEN);

  await act(async () => { root.unmount(); });
});

test("closing the panel cancels the outstanding token", async () => {
  const { container, root } = await mount("/qr2");

  await act(async () => { clickText(container, "Pair a phone"); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });

  await act(async () => { clickText(container, "Done"); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });

  // A code that was displayed and dismissed stops being claimable then, rather
  // than idling out the rest of its five minutes on a screen nobody is watching.
  expect(pairCalls.some(c => c.method === "DELETE")).toBe(true);
  expect(container.querySelector("svg[role='img']")).toBeNull();

  await act(async () => { root.unmount(); });
});

test("regenerating cancels the old code before minting the new one", async () => {
  const { container, root } = await mount("/qr3");

  await act(async () => { clickText(container, "Pair a phone"); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });

  await act(async () => { clickText(container, "New code"); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

  // Order is the whole contract: the server holds ONE outstanding token, so a
  // DELETE that overtook the new POST would cancel the code on screen and leave
  // a QR that looks perfectly valid and can never be claimed.
  const methods = pairCalls.map(c => c.method);
  expect(methods).toEqual(["POST", "DELETE", "POST"]);

  await act(async () => { root.unmount(); });
});

test("no code is offered while the proxy has not restarted onto the new bind", async () => {
  // `urls` comes from the stored config, so the moment remote access is enabled
  // this panel could render a scannable code pointing at a socket still bound to
  // loopback — the phone fails to connect and the five-minute token expires
  // proving nothing.
  restartPending = true;
  const { container, root } = await mount("/qr4");

  expect(container.textContent).toContain("Restart the proxy first");
  expect([...container.querySelectorAll("button")].some(b => b.textContent?.includes("Pair a phone"))).toBe(false);
  expect(pairCalls).toHaveLength(0);

  await act(async () => { root.unmount(); });
});
