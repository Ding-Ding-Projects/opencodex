import { describe, expect, test } from "bun:test";
import { DISHES, DRAW_CHANCE, drawDimSum, photoSrc } from "../src/shell/dimsum";

/**
 * The dim sum contract: one 1% draw per launch, never on first run, never on an
 * update launch, off switch honoured before the roll, and no network anywhere.
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
  test("never fires on first run, even on a winning roll", () => {
    const storage = memoryStorage();
    const dish = drawDimSum({ enabled: true, version: "1.0.0", random: () => 0, storage });
    expect(dish).toBeNull();
    // ...but the launch is still recorded, so the next one is not "first run".
    expect(storage.dump()["ocx-m3:launched"]).toBe("1");
  });

  test("never fires on the launch right after an update", () => {
    const storage = warmedStorage("1.0.0");
    const dish = drawDimSum({ enabled: true, version: "2.0.0", random: () => 0, storage });
    expect(dish).toBeNull();
    // The new version is recorded, so the launch after this one is eligible again.
    expect(storage.dump()["ocx-m3:last-version"]).toBe("2.0.0");
  });

  test("the off switch is honoured before the roll, and still records launch state", () => {
    const storage = memoryStorage();
    expect(drawDimSum({ enabled: false, version: "1.0.0", random: () => 0, storage })).toBeNull();
    // A disabled first run must not freeze the first-run marker forever:
    expect(storage.dump()["ocx-m3:launched"]).toBe("1");
    // ...so re-enabling later, on an ordinary launch, can win.
    expect(drawDimSum({ enabled: true, version: "1.0.0", random: () => 0, storage })).not.toBeNull();
  });

  test("a losing roll returns null on an ordinary launch", () => {
    const dish = drawDimSum({ enabled: true, version: "1.0.0", random: () => DRAW_CHANCE, storage: warmedStorage() });
    expect(dish).toBeNull();
  });

  test("a winning roll returns a dish with alt text naming it", () => {
    const dish = drawDimSum({ enabled: true, version: "1.0.0", random: () => 0.0001, storage: warmedStorage() });
    expect(dish).not.toBeNull();
    expect(DISHES).toContain(dish!);
    expect(dish!.name.length).toBeGreaterThan(0);
  });

  test("unreadable storage skips the draw — cannot prove it is not a first run", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(drawDimSum({ enabled: true, version: "1.0.0", random: () => 0, storage })).toBeNull();
  });

  test("every dish ships bundled art and a name — nothing to fetch", () => {
    for (const dish of DISHES) {
      expect(dish.emoji.length).toBeGreaterThan(0);
      expect(dish.name.length).toBeGreaterThan(0);
      expect(dish.zh.length).toBeGreaterThan(0);
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
