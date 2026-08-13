/**
 * The 10 % dim sum surprise, and the three ways it is allowed to say no.
 *
 * The interesting assertions here are all negative: a first visit never draws, a
 * draw happens once per launch, and the art is a local file under this
 * deployment's base. Each of those is a rule that fails quietly — a surprise
 * that fires slightly too often, or on a first visit, or fetches a 404 — and
 * none of them shows up in a build.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  DISHES,
  LEGACY_ENABLED_KEY,
  dishImage,
  drawOnce,
  namespacedStorage,
  resetDrawForTests,
} from "../src/lib/dimsum";
import { DRAW_CHANCE, codenameFor } from "../../shared/m3/dimsum";

/** A `Storage` face over a plain map, so every key written is inspectable. */
function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    // Present so the legacy-opt-out migration has something real to delete. The
    // draw itself never calls it — its `Storage` view is get/set only.
    removeItem: (key: string) => { map.delete(key); },
  };
}

/** A store that has already been visited once, so the next draw is not a first run. */
function returningVisitor(extra: Record<string, string> = {}) {
  return fakeStore({
    "ocx-docs:ocx-m3:launched": "1",
    "ocx-docs:ocx-m3:last-version": "docs",
    ...extra,
  });
}

beforeEach(() => {
  resetDrawForTests();
});

describe("the retired off switch", () => {
  test("a reader who had switched it off rejoins the draw", () => {
    // This replaces "the off switch is honoured before the odds are consulted".
    // The surprise cannot be opted out of any more, so the stored "0" from a
    // reader who opted out under the old contract must no longer suppress it.
    const store = returningVisitor({ [LEGACY_ENABLED_KEY]: "0" });
    expect(drawOnce({ storage: store, random: () => 0 })).not.toBeNull();
  });

  test("and the stale key is cleared rather than merely ignored", () => {
    const store = returningVisitor({ [LEGACY_ENABLED_KEY]: "0" });
    drawOnce({ storage: store, random: () => 0 });
    expect(store.map.has(LEGACY_ENABLED_KEY)).toBe(false);
  });
});

describe("when it refuses to draw", () => {
  test("never on a first visit", () => {
    const store = fakeStore();
    expect(drawOnce({ storage: store, random: () => 0 })).toBeNull();
  });

  test("but the first visit is still recorded, so the next one is eligible", () => {
    const store = fakeStore();
    drawOnce({ storage: store, random: () => 0 });
    expect(store.getItem("ocx-docs:ocx-m3:launched")).toBe("1");

    resetDrawForTests();
    expect(drawOnce({ storage: store, random: () => 0 })).not.toBeNull();
  });

  test("once per launch, however many times it is asked", () => {
    const store = returningVisitor();
    expect(drawOnce({ storage: store, random: () => 0 })).not.toBeNull();
    // A second navigation must not get a second chance.
    expect(drawOnce({ storage: store, random: () => 0 })).toBeNull();
  });

  test("a roll outside the 10 % draws nothing", () => {
    const store = returningVisitor();
    expect(drawOnce({ storage: store, random: () => DRAW_CHANCE })).toBeNull();
  });

  test("the stated odds are one in ten", () => {
    expect(DRAW_CHANCE).toBe(0.1);
  });
});

describe("the preview", () => {
  test("always shows a dish and does not spend the launch's real draw", () => {
    const store = returningVisitor();
    expect(drawOnce({ force: true, random: () => 0.5 })).not.toBeNull();
    // The forced preview must not have set the once-per-launch flag.
    expect(drawOnce({ storage: store, random: () => 0 })).not.toBeNull();
  });
});

describe("the storage namespace", () => {
  test("prefixes every key so the dashboard's markers are untouched", () => {
    const inner = fakeStore();
    const view = namespacedStorage(inner);
    view.setItem("ocx-m3:launched", "1");
    expect(inner.getItem("ocx-docs:ocx-m3:launched")).toBe("1");
    expect(inner.getItem("ocx-m3:launched")).toBeNull();
    expect(view.getItem("ocx-m3:launched")).toBe("1");
  });
});

describe("the art", () => {
  test("is a local file under this deployment's base", () => {
    for (const dish of DISHES) {
      const src = dishImage(dish);
      expect(`${dish.id}:${src}`).toBe(`${dish.id}:/dimsum/${dish.id}.webp`);
      // Never a third-party fetch — the rule is bundled art, no network.
      expect(src.startsWith("http")).toBe(false);
    }
  });

  test("every dish names itself in both languages, for the alt text and beside it", () => {
    for (const dish of DISHES) {
      expect(`${dish.id}:${!!dish.name}`).toBe(`${dish.id}:true`);
      expect(`${dish.id}:${!!dish.zh}`).toBe(`${dish.id}:true`);
      expect(`${dish.id}:${!!dish.jyutping}`).toBe(`${dish.id}:true`);
    }
  });

  test("the build codename comes from the same table, so it cannot disagree", () => {
    // The release titles a build after a dish; the site derives the same name
    // from the same list. A second copy is how one commit gets two names.
    const named = codenameFor("0123456789abcdef");
    expect(DISHES.map(d => d.id)).toContain(named.id);
    expect(codenameFor("0123456789abcdef").id).toBe(named.id);
  });
});
