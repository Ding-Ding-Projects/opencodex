/**
 * The converter's "Open in PDF Tools" hand-off — the one-shot hash-param
 * pattern `lib/mobile-pairing.ts` already established, applied to carrying a
 * detected source path instead of a pairing token.
 *
 * Two properties matter, mirroring `mobile-pairing.test.tsx`'s own framing:
 * 1. The path leaves the URL the instant it is read — a local filesystem path
 *    is not something a screenshot or "share this page" should carry.
 * 2. It is read exactly once per page load, so navigating away and back does
 *    not silently repopulate a field the user has since cleared.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  navigateWithSource,
  pdfToolsHandoffHash,
  resetHandoffSourceGuardForTests,
  takeHandoffSourceFromUrl,
} from "../src/lib/converter-handoff";

const globals = ["document", "window", "navigator", "history", "location"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

function boot(hash: string): void {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: `http://localhost/${hash}` });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  resetHandoffSourceGuardForTests();
}

beforeEach(() => {});

afterEach(() => {
  testWindow?.close();
  for (const key of globals) {
    if (previousGlobals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("pdfToolsHandoffHash percent-encodes the path", () => {
  expect(pdfToolsHandoffHash("C:\\Users\\me\\a b.pdf")).toBe("pdf?source=C%3A%5CUsers%5Cme%5Ca%20b.pdf");
});

test("takeHandoffSourceFromUrl reads the source param and strips it from the URL", () => {
  boot("#/pdf?source=C%3A%5CUsers%5Cme%5Ca.pdf");

  const path = takeHandoffSourceFromUrl();
  expect(path).toBe("C:\\Users\\me\\a.pdf");
  // The param is gone from the address bar the instant it is read — before
  // any claim, request, or state update happens elsewhere in the app.
  expect(window.location.hash).toBe("#pdf");
});

test("takeHandoffSourceFromUrl reads only once per page load", () => {
  boot("#/pdf?source=C%3A%5Ca.pdf");
  expect(takeHandoffSourceFromUrl()).toBe("C:\\a.pdf");
  // A second call — e.g. a second mount of the page during the same load —
  // must not resurrect a value the first read already consumed and stripped.
  expect(takeHandoffSourceFromUrl()).toBeNull();
});

test("takeHandoffSourceFromUrl returns null when there is no source param", () => {
  boot("#/pdf");
  expect(takeHandoffSourceFromUrl()).toBeNull();
  expect(window.location.hash).toBe("#/pdf");
});

test("navigateWithSource assigns a hash the handoff can read back", () => {
  boot("#/converter");
  navigateWithSource("pdf", "C:\\Users\\me\\report.pdf");
  expect(window.location.hash).toBe("#pdf?source=C%3A%5CUsers%5Cme%5Creport.pdf");
});
