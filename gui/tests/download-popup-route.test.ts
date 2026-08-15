/**
 * Pure parsing for the always-on-top popup windows' route. No DOM needed —
 * this is the one piece of `main.tsx`'s popup-mode branch that is cheap to
 * prove in isolation, so it is proven that way rather than only through a
 * full Electron capture.
 */
import { describe, expect, test } from "bun:test";
import { parseDownloadPopupHash } from "../src/download-popup-route";

describe("parseDownloadPopupHash", () => {
  test("a well-formed start route", () => {
    expect(parseDownloadPopupHash("#/downloads?popup=start&id=abc-123")).toEqual({ kind: "start", id: "abc-123" });
  });

  test("a well-formed complete route", () => {
    expect(parseDownloadPopupHash("#/downloads?popup=complete&id=xyz")).toEqual({ kind: "complete", id: "xyz" });
  });

  test("an ordinary app hash is never mistaken for a popup route", () => {
    expect(parseDownloadPopupHash("#/downloads")).toBeNull();
    expect(parseDownloadPopupHash("#/dashboard")).toBeNull();
    expect(parseDownloadPopupHash("")).toBeNull();
  });

  test("an unrecognised popup kind is refused rather than rendering an unknown surface", () => {
    expect(parseDownloadPopupHash("#/downloads?popup=delete&id=abc")).toBeNull();
  });

  test("a popup kind with no id is refused — there is nothing to fetch a record for", () => {
    expect(parseDownloadPopupHash("#/downloads?popup=start")).toBeNull();
  });

  test("query params on a different page never match, even if they happen to carry the same keys", () => {
    expect(parseDownloadPopupHash("#/mobile?popup=start&id=abc")).toBeNull();
  });
});
