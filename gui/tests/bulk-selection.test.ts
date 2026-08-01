/**
 * The selection model both list surfaces share.
 *
 * Small enough to look obviously correct and therefore exactly the kind of thing
 * that quietly stops being correct. The two cases worth the file are the
 * shift-range whose anchor has been filtered away — which must not compute a
 * range from `-1` and sweep in the whole list — and the promise that every
 * function returns a NEW set, since mutating in place is how a React list stops
 * re-rendering and starts looking broken.
 */

import { describe, expect, test } from "bun:test";
import { invert, selectAll, selectRange, toggle } from "../src/shell/bulk-selection";

const order = ["a", "b", "c", "d"];
const ids = (set: ReadonlySet<string>) => [...set].sort();

describe("toggle", () => {
  test("adds when absent and removes when present", () => {
    expect(ids(toggle(new Set(), "b"))).toEqual(["b"]);
    expect(ids(toggle(new Set(["b"]), "b"))).toEqual([]);
  });

  test("returns a new set rather than mutating the old one", () => {
    const before = new Set(["a"]);
    const after = toggle(before, "b");
    expect(after).not.toBe(before);
    expect(ids(before)).toEqual(["a"]);
  });
});

describe("selectRange", () => {
  test("selects the run between anchor and target, inclusive", () => {
    expect(ids(selectRange(new Set(), order, "b", "d"))).toEqual(["b", "c", "d"]);
  });

  test("works in either direction", () => {
    expect(ids(selectRange(new Set(), order, "d", "b"))).toEqual(["b", "c", "d"]);
  });

  test("adds to the selection rather than replacing it", () => {
    // Extending with a second range keeps the first, which is what every file
    // manager does and therefore what people expect without being told.
    expect(ids(selectRange(new Set(["a"]), order, "c", "d"))).toEqual(["a", "c", "d"]);
  });

  test("falls back to a plain toggle when the anchor is no longer listed", () => {
    // A row filtered away between the two clicks. `indexOf` returns -1, and a
    // range computed from that would silently select from the start of the list.
    expect(ids(selectRange(new Set(), order, "gone", "c"))).toEqual(["c"]);
    expect(ids(selectRange(new Set(), order, "b", "gone"))).toEqual(["gone"]);
  });
});

describe("selectAll and invert", () => {
  test("selectAll means exactly the order it was given", () => {
    // Which is why the bar names its scope out loud: on a filtered list, passing
    // the filtered ids and calling it "select all" is the difference between a
    // truthful count and a lie.
    expect(ids(selectAll(order))).toEqual(["a", "b", "c", "d"]);
    expect(ids(selectAll(["b", "c"]))).toEqual(["b", "c"]);
  });

  test("invert flips within the listed set", () => {
    expect(ids(invert(new Set(["a", "c"]), order))).toEqual(["b", "d"]);
  });

  test("invert leaves ids outside the list alone by dropping them", () => {
    // An id that is no longer listed cannot be acted on, so carrying it forward
    // would inflate the count with a row the user cannot see.
    expect(ids(invert(new Set(["a", "ghost"]), order))).toEqual(["b", "c", "d"]);
  });

  test("inverting a full selection empties it", () => {
    expect(ids(invert(selectAll(order), order))).toEqual([]);
  });
});
