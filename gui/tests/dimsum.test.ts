import { describe, expect, test } from "bun:test";
import { DISHES, DRAW_CHANCE, drawDimSum, photoSrc } from "../src/shell/dimsum";

/**
 * The dim sum contract: one 10% draw per launch, never on first run, never on
 * an update launch, no off switch at all, and no network anywhere.
 */

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    dump: () => Object.fromEntries(map),
  };
}

/** A storage that has already seen this version — the "ordinary launch" baseline. */
function warmedStorage(version = "1.0.0") {
  return memoryStorage({ "ocx-m3:launched": "1", "ocx-m3:last-version": version });
}

describe("dim sum draw", () => {
  test("the draw is one launch in ten, not one in a hundred", () => {
    // Pinned because the constant and the spec disagreed by a factor of ten for
    // several releases and nothing went red: a probability is invisible until
    // somebody counts a thousand launches.
    expect(DRAW_CHANCE).toBe(0.1);
  });

  test("never fires on first run, even on a winning roll", () => {
    const storage = memoryStorage();
    const dish = drawDimSum({ version: "1.0.0", random: () => 0, storage });
    expect(dish).toBeNull();
    // ...but the launch is still recorded, so the next one is not "first run".
    expect(storage.dump()["ocx-m3:launched"]).toBe("1");
  });

  test("never fires on the launch right after an update", () => {
    const storage = warmedStorage("1.0.0");
    const dish = drawDimSum({ version: "2.0.0", random: () => 0, storage });
    expect(dish).toBeNull();
    // The new version is recorded, so the launch after this one is eligible again.
    expect(storage.dump()["ocx-m3:last-version"]).toBe("2.0.0");
  });

  test("there is no off switch — an ordinary launch that wins always shows a dish", () => {
    // This replaces the old "the off switch is honoured before the roll" test.
    // The surprise cannot be opted out of, so the strongest thing left to assert
    // is that no extra context can suppress a winning roll: `DrawContext` has no
    // `enabled` field, and passing one would not type-check.
    const storage = memoryStorage();
    // First run is still suppressed, and still records the marker...
    expect(drawDimSum({ version: "1.0.0", random: () => 0, storage })).toBeNull();
    expect(storage.dump()["ocx-m3:launched"]).toBe("1");
    // ...so the very next ordinary launch is eligible, with nothing able to veto it.
    expect(drawDimSum({ version: "1.0.0", random: () => 0, storage })).not.toBeNull();
  });

  test("a losing roll returns null on an ordinary launch", () => {
    const dish = drawDimSum({ version: "1.0.0", random: () => DRAW_CHANCE, storage: warmedStorage() });
    expect(dish).toBeNull();
  });

  test("a roll that would have lost at 1% now wins at 10%", () => {
    // 0.05 sits between the old chance and the new one, so this test fails if
    // the constant is ever walked back to 0.01.
    const dish = drawDimSum({ version: "1.0.0", random: () => 0.05, storage: warmedStorage() });
    expect(dish).not.toBeNull();
  });

  test("a winning roll returns a dish with alt text naming it", () => {
    const dish = drawDimSum({ version: "1.0.0", random: () => 0.0001, storage: warmedStorage() });
    expect(dish).not.toBeNull();
    expect(DISHES).toContain(dish!);
    expect(dish!.name.length).toBeGreaterThan(0);
  });

  test("unreadable storage skips the draw — cannot prove it is not a first run", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(drawDimSum({ version: "1.0.0", random: () => 0, storage })).toBeNull();
  });

  test("every dish ships bundled art and a name — nothing to fetch", () => {
    for (const dish of DISHES) {
      expect(dish.emoji.length).toBeGreaterThan(0);
      expect(dish.name.length).toBeGreaterThan(0);
      expect(dish.zh.length).toBeGreaterThan(0);
      expect(dish.jyutping.length).toBeGreaterThan(0);
    }
  });

  test("every dish has a real bundled photo on disk", () => {
    // The card falls back to an emoji when a file is missing, which is the
    // right behaviour and also the reason a missing file would never be
    // noticed. Assert the files exist rather than trusting the fallback.
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    for (const dish of DISHES) {
      // fileURLToPath, not `.pathname`: on Windows the latter yields
      // "/C:/Users/…", which existsSync never resolves.
      const path = fileURLToPath(new URL(`../public/${photoSrc(dish)}`, import.meta.url));
      expect(`${dish.id}: ${existsSync(path)}`).toBe(`${dish.id}: true`);
    }
  });
  test("every dish resolves to a bundled, same-origin photo path", () => {
    // The card renders this first and falls back to the emoji when the file is
    // absent, so the art drops in with no code change. What must hold now is
    // that the path is local: a dish photo must never become a network fetch.
    for (const dish of DISHES) {
      const src = photoSrc(dish);
      expect(src).toBe(`dimsum/${dish.id}.webp`);
      expect(src).not.toContain("//");
      expect(src.startsWith("http")).toBe(false);
    }
  });

  test("dish ids are filename-safe, so a photo can be named after one", () => {
    for (const dish of DISHES) expect(dish.id).toMatch(/^[a-z0-9-]+$/);
  });
});
