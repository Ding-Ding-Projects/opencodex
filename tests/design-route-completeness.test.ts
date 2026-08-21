/**
 * Exact route coverage for the real-built parity capture harness.
 *
 * The app route table and this registry intentionally have different owners:
 * one says what can be opened, the other says what will actually be captured.
 * The union comparison below is the fail-closed boundary. A missing route, a
 * duplicate route, or a special state removed from `capture-shots.ts` turns red
 * instead of disappearing from a discovery-only list.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { VALID_PAGES, type Page } from "../gui/src/app-routing";
import {
  DESIGN_CAPTURE_TUPLE,
  DESIGN_PAGE_CAPTURE_REGISTRY,
  DESIGN_PAGE_CAPTURE_ROUTES,
  DESIGN_SPECIAL_CAPTURE_ROUTES,
} from "../scripts/design-route-registry";

const CAPTURE_SCRIPT = "scripts/capture-shots.ts";
const captureSource = readFileSync(CAPTURE_SCRIPT, "utf8");

function setDifference(left: Iterable<string>, right: Iterable<string>): string[] {
  const other = new Set(right);
  return [...new Set(left)].filter(value => !other.has(value)).sort();
}

function declaredSpecialTargetIds(): string[] {
  const start = captureSource.indexOf("const surfaces: Target[] = [");
  if (start < 0) throw new Error(`${CAPTURE_SCRIPT} has no hand-written surfaces registry`);
  const end = captureSource.indexOf("\n];", start);
  if (end < 0) throw new Error(`${CAPTURE_SCRIPT} surfaces registry is not closed`);
  const body = captureSource.slice(start, end);
  return [...body.matchAll(/^\s*id: "([^"]+)",/gm)].map(match => match[1]);
}

describe("design capture route completeness", () => {
  test("ordinary page registry plus the explicit mobile special row equals every valid app page", () => {
    const pageIds = DESIGN_PAGE_CAPTURE_REGISTRY.map(([id]) => id);
    const specialPageIds = DESIGN_SPECIAL_CAPTURE_ROUTES
      .map(route => route.id)
      .filter(id => VALID_PAGES.has(id as Page));
    const capturedPageIds = [...pageIds, ...specialPageIds];
    const validPageIds = [...VALID_PAGES].sort();

    expect(new Set(capturedPageIds).size).toBe(capturedPageIds.length);
    expect(setDifference(capturedPageIds, validPageIds)).toEqual([]);
    expect(setDifference(validPageIds, capturedPageIds)).toEqual([]);
  });

  test("the capture harness consumes the hand-written page registry and declares every special state", () => {
    expect(captureSource).toContain("DESIGN_PAGE_CAPTURE_ROUTES.map");
    expect(declaredSpecialTargetIds().sort()).toEqual(
      DESIGN_SPECIAL_CAPTURE_ROUTES.map(route => route.id).sort(),
    );
  });

  test("every route row records one exact deterministic tuple", () => {
    const allRows = [...DESIGN_PAGE_CAPTURE_ROUTES, ...DESIGN_SPECIAL_CAPTURE_ROUTES];
    expect(allRows.length).toBeGreaterThan(0);
    for (const row of allRows) {
      expect(row.id.trim(), `${row.id}: id`).not.toBe("");
      expect(row.hash.trim(), `${row.id}: hash`).not.toBe("");
      expect(row.screen.trim(), `${row.id}: screen`).not.toBe("");
      expect(row.state.trim(), `${row.id}: state`).not.toBe("");
      expect(row.theme, `${row.id}: theme`).toBe(DESIGN_CAPTURE_TUPLE.theme);
      expect(row.locale, `${row.id}: locale`).toBe(DESIGN_CAPTURE_TUPLE.locale);
      expect(row.width, `${row.id}: width`).toBe(row.viewport === "phone" ? DESIGN_CAPTURE_TUPLE.phone.width : DESIGN_CAPTURE_TUPLE.desktop.width);
      expect(row.height, `${row.id}: height`).toBe(row.viewport === "phone" ? DESIGN_CAPTURE_TUPLE.phone.height : DESIGN_CAPTURE_TUPLE.desktop.height);
      expect(row.scale, `${row.id}: scale`).toBe(row.viewport === "phone" ? DESIGN_CAPTURE_TUPLE.phone.scale : DESIGN_CAPTURE_TUPLE.desktop.scale);
      expect(row.reference.status, `${row.id}: reference status`).toMatch(/^(parity-inventory|none)$/);
      if (row.reference.status === "none") expect(row.reference.reason.trim(), `${row.id}: reference reason`).not.toBe("");
      else expect(row.reference.note.trim(), `${row.id}: reference note`).not.toBe("");
    }
  });

  test("mobile is an explicit phone tuple, not a desktop route exemption", () => {
    const mobile = DESIGN_SPECIAL_CAPTURE_ROUTES.find(route => route.id === "mobile");
    expect(mobile).toMatchObject({
      hash: "mobile",
      viewport: "phone",
      width: 393,
      height: 852,
      scale: 3,
      locale: "bi",
      reference: { status: "none" },
    });
    expect(DESIGN_PAGE_CAPTURE_ROUTES.some(route => route.id === "mobile")).toBe(false);
  });

  test("real-built capture remains a window capture, not a DOM-injected image", () => {
    expect(captureSource).toContain("window-tools.ps1");
    expect(captureSource).toContain("PrintWindow");
    expect(captureSource).not.toContain("document.body.innerHTML");
    expect(captureSource).not.toContain("Page.setDocumentContent");
  });

  test("the harness pins the tuple inputs instead of inheriting machine state", () => {
    expect(captureSource).toContain('const PREFS_KEY = "ocx-m3:v1";');
    expect(captureSource).toContain('JSON.stringify({ ...prefs, theme: "light" })');
    expect(captureSource).toContain('const CAPTURE_LOCALE = "bi";');
    expect(captureSource).toContain("DESIGN_CAPTURE_TUPLE.desktop.width");
    expect(captureSource).toContain("DESIGN_CAPTURE_TUPLE.phone.width");
  });
});
