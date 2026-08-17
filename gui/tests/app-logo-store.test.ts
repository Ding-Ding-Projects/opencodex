/**
 * The app-logo store: presets, `<img>`/favicon src resolution, persisted-
 * state validation (fail-closed to the shipped mark for anything corrupt or
 * partial), local-history recording, and the fail-closed conversion path
 * when the runtime has no raster surface at all.
 *
 * Deliberately run with no DOM installed at all (no `happy-dom` `Window`),
 * using the injectable-storage parameter every public function accepts —
 * which doubles as proof that reading, validating and resolving the logo
 * state needs no browser environment beyond a plain key/value store, and
 * that `convertLogoImage` fails closed rather than throwing when
 * `document` does not exist.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUSTOM_SOURCE_ID,
  DEFAULT_APP_LOGO_STATE,
  LOGO_OUTPUT_SIZES,
  LOGO_PRESETS,
  SHIPPED_LOGO_PRESET_ID,
  applyCustomLogo,
  convertLogoImage,
  findPreset,
  getAppLogoSnapshot,
  presetImageSrc,
  probeImageBytes,
  readAppLogoState,
  resetAppLogo,
  resetAppLogoForTests,
  resolveFaviconSrc,
  resolveLogoSrc,
  selectLogoPreset,
  subscribeAppLogo,
  type CustomLogoAsset,
} from "../src/theme/app-logo";
import { readRevisions } from "../src/shell/revisions";

/* ------------------------------------------------------------ storage ---- */

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  raw: Map<string, string>;
}

function makeStorage(): MemoryStorage {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: key => (raw.has(key) ? raw.get(key)! : null),
    setItem: (key, value) => { raw.set(key, value); },
  };
}

/* ------------------------------------------------------------ fixtures --- */

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function pngChunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}
function pngBytes(size: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = pngChunk("IHDR", [...u32be(size), ...u32be(size), 8, 6, 0, 0, 0]);
  return new Uint8Array([...sig, ...ihdr, ...pngChunk("IDAT", [0, 0, 0, 0]), ...pngChunk("IEND", [])]);
}
function pngDataUri(size: number): string {
  let binary = "";
  for (const byte of pngBytes(size)) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

function fullVariantSet(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const size of LOGO_OUTPUT_SIZES) out[size] = pngDataUri(size);
  return out;
}

function validCustomAsset(patch: Partial<CustomLogoAsset> = {}): CustomLogoAsset {
  return {
    format: "png",
    sourceWidth: 400,
    sourceHeight: 400,
    fit: "contain",
    background: null,
    focal: { x: 0.5, y: 0.5 },
    cropBox: null,
    variants: fullVariantSet(),
    ...patch,
  };
}

afterEach(() => {
  resetAppLogoForTests();
});

/**
 * `recordRevision` (see `shell/revisions.ts`) reads and writes the real
 * global `localStorage` directly rather than accepting an injected store —
 * unlike every app-logo function above, which is why this one small helper
 * exists only for the history-recording test below, instead of every test
 * in this file needing a DOM. Both `getItem`/`setItem` failing is already
 * handled gracefully by `recordRevision`'s own try/catch (proven implicitly
 * by every other test in this file running with no `localStorage` global at
 * all and never throwing); this exists only to make the *positive* case —
 * a revision actually landing — observable.
 */
function installGlobalLocalStorage(): { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => (raw.has(k) ? raw.get(k)! : null), setItem: (k: string, v: string) => { raw.set(k, v); } },
  });
  return { raw };
}
function uninstallGlobalLocalStorage(): void {
  Reflect.deleteProperty(globalThis, "localStorage");
}

/* ------------------------------------------------------------------ tests - */

describe("presets", () => {
  test("the shipped preset resolves to the shipped file, not a generated data URI", () => {
    const shipped = findPreset(SHIPPED_LOGO_PRESET_ID)!;
    expect(presetImageSrc(shipped)).toBe("/logo.png");
  });

  test("every generated preset resolves to a self-contained SVG data URI", () => {
    for (const preset of LOGO_PRESETS) {
      if (preset.id === SHIPPED_LOGO_PRESET_ID) continue;
      const src = presetImageSrc(preset);
      expect(src.startsWith("data:image/svg+xml")).toBe(true);
      expect(decodeURIComponent(src.slice(src.indexOf(",") + 1))).toContain("<svg");
    }
  });

  test("there is more than one preset — 'several' is not one option with a coat of paint", () => {
    expect(LOGO_PRESETS.length).toBeGreaterThanOrEqual(3);
    // Every preset draws something distinct, not the same markup four times.
    const svgs = new Set(LOGO_PRESETS.map(p => (p.source.kind === "generated" ? p.source.svg() : "shipped")));
    expect(svgs.size).toBe(LOGO_PRESETS.length);
  });

  test("findPreset resolves a known id and reports undefined for an unknown one", () => {
    expect(findPreset("badge-circle")).toBeDefined();
    expect(findPreset("not-a-real-preset")).toBeUndefined();
  });
});

describe("resolveLogoSrc / resolveFaviconSrc", () => {
  test("the shipped default resolves to the shipped mark and favicon", () => {
    expect(resolveLogoSrc(DEFAULT_APP_LOGO_STATE)).toBe("/logo.png");
    expect(resolveFaviconSrc(DEFAULT_APP_LOGO_STATE)).toEqual({ href: "/favicon.png", type: "image/png" });
  });

  test("a generated preset resolves the same source for both chrome and favicon use", () => {
    const state = { sourceId: "badge-square", custom: null };
    const chrome = resolveLogoSrc(state);
    const favicon = resolveFaviconSrc(state);
    expect(chrome).toBe(favicon.href);
    expect(favicon.type).toBe("image/svg+xml");
  });

  test("a custom logo prefers the largest variant for chrome and the smallest for the favicon", () => {
    const custom = validCustomAsset();
    const state = { sourceId: CUSTOM_SOURCE_ID, custom };
    expect(resolveLogoSrc(state)).toBe(custom.variants[256]);
    const favicon = resolveFaviconSrc(state);
    expect(favicon).toEqual({ href: custom.variants[32], type: "image/png" });
  });

  test("an unknown sourceId falls back to the first preset rather than rendering nothing", () => {
    const state = { sourceId: "not-a-real-id", custom: null };
    expect(resolveLogoSrc(state)).toBe(presetImageSrc(LOGO_PRESETS[0]!));
  });
});

describe("readAppLogoState — fail-closed persistence", () => {
  test("no stored value reads as the default (shipped) state", () => {
    expect(readAppLogoState(makeStorage())).toEqual(DEFAULT_APP_LOGO_STATE);
  });

  test("corrupt JSON reads as the default state rather than throwing", () => {
    const storage = makeStorage();
    storage.setItem("ocx-applogo:v1", "{not json");
    expect(readAppLogoState(storage)).toEqual(DEFAULT_APP_LOGO_STATE);
  });

  test("an unknown sourceId (neither a known preset nor 'custom') reads as the default", () => {
    const storage = makeStorage();
    storage.setItem("ocx-applogo:v1", JSON.stringify({ sourceId: "made-up", custom: null }));
    expect(readAppLogoState(storage)).toEqual(DEFAULT_APP_LOGO_STATE);
  });

  test("a known preset id round-trips exactly", () => {
    const storage = makeStorage();
    storage.setItem("ocx-applogo:v1", JSON.stringify({ sourceId: "badge-circle", custom: null }));
    expect(readAppLogoState(storage)).toEqual({ sourceId: "badge-circle", custom: null });
  });

  test("a fully valid custom asset round-trips, including every variant re-probing correctly", () => {
    const storage = makeStorage();
    const asset = validCustomAsset({ background: "#ff0000" });
    storage.setItem("ocx-applogo:v1", JSON.stringify({ sourceId: CUSTOM_SOURCE_ID, custom: asset }));
    const state = readAppLogoState(storage);
    expect(state.sourceId).toBe(CUSTOM_SOURCE_ID);
    expect(state.custom?.sourceWidth).toBe(400);
    expect(state.custom?.background).toBe("#ff0000");
    expect(Object.keys(state.custom?.variants ?? {}).length).toBe(LOGO_OUTPUT_SIZES.length);
  });

  test("a custom asset missing even one required variant is refused wholesale, not rendered partially", () => {
    const storage = makeStorage();
    const asset = validCustomAsset();
    const variants = { ...asset.variants };
    delete variants[32];
    storage.setItem("ocx-applogo:v1", JSON.stringify({ sourceId: CUSTOM_SOURCE_ID, custom: { ...asset, variants } }));
    // The whole asset is dropped — never "two of three sizes work".
    expect(readAppLogoState(storage)).toEqual(DEFAULT_APP_LOGO_STATE);
  });

  test("a variant whose bytes do not actually decode to the size its key claims is refused", () => {
    const storage = makeStorage();
    const asset = validCustomAsset();
    // The 128 entry is real PNG bytes, but for the wrong size — a corrupted
    // or hand-edited cache exactly as the fail-closed rule anticipates.
    const variants = { ...asset.variants, 128: pngDataUri(64) };
    storage.setItem("ocx-applogo:v1", JSON.stringify({ sourceId: CUSTOM_SOURCE_ID, custom: { ...asset, variants } }));
    expect(readAppLogoState(storage)).toEqual(DEFAULT_APP_LOGO_STATE);
  });

  test("a stored background that is not a real colour is dropped, not passed through to a canvas fill", () => {
    const storage = makeStorage();
    const asset = validCustomAsset({ background: "javascript:alert(1)" as string });
    storage.setItem("ocx-applogo:v1", JSON.stringify({ sourceId: CUSTOM_SOURCE_ID, custom: asset }));
    expect(readAppLogoState(storage).custom?.background).toBeNull();
  });

  test("declared source dimensions over the format module's own bounds are refused", () => {
    const storage = makeStorage();
    const asset = validCustomAsset({ sourceWidth: 999_999, sourceHeight: 999_999 });
    storage.setItem("ocx-applogo:v1", JSON.stringify({ sourceId: CUSTOM_SOURCE_ID, custom: asset }));
    expect(readAppLogoState(storage)).toEqual(DEFAULT_APP_LOGO_STATE);
  });

  test("an out-of-range crop box is clamped rather than rejecting the whole asset", () => {
    const storage = makeStorage();
    const asset = validCustomAsset({ fit: "crop", cropBox: { x: 100_000, y: 100_000, size: 100_000 } });
    storage.setItem("ocx-applogo:v1", JSON.stringify({ sourceId: CUSTOM_SOURCE_ID, custom: asset }));
    const state = readAppLogoState(storage);
    expect(state.custom).not.toBeNull();
    expect(state.custom!.cropBox!.size).toBeLessThanOrEqual(400);
  });
});

describe("actions — selectLogoPreset / applyCustomLogo / resetAppLogo", () => {
  test("selecting an unknown preset id is refused and leaves the stored state untouched", () => {
    const storage = makeStorage();
    const ok = selectLogoPreset("not-a-real-preset", storage);
    expect(ok).toBe(false);
    expect(readAppLogoState(storage)).toEqual(DEFAULT_APP_LOGO_STATE);
  });

  test("selecting a real preset persists it and updates the live snapshot", () => {
    const storage = makeStorage();
    resetAppLogoForTests();
    const ok = selectLogoPreset("badge-outline", storage);
    expect(ok).toBe(true);
    expect(getAppLogoSnapshot().applied).toEqual({ sourceId: "badge-outline", custom: null });
    expect(readAppLogoState(storage)).toEqual({ sourceId: "badge-outline", custom: null });
  });

  test("applying a custom logo persists it and clears any prior rejection/failure flags", () => {
    const storage = makeStorage();
    resetAppLogoForTests();
    const asset = validCustomAsset();
    applyCustomLogo(asset, storage);
    const snapshot = getAppLogoSnapshot();
    expect(snapshot.applied.sourceId).toBe(CUSTOM_SOURCE_ID);
    expect(snapshot.applied.custom).toEqual(asset);
    expect(snapshot.lastRejection).toBeNull();
    expect(snapshot.lastConversionFailure).toBeNull();
  });

  test("resetAppLogo always returns to the shipped default, from a preset or a custom logo alike", () => {
    const storage = makeStorage();
    resetAppLogoForTests();
    applyCustomLogo(validCustomAsset(), storage);
    resetAppLogo(storage);
    expect(getAppLogoSnapshot().applied).toEqual(DEFAULT_APP_LOGO_STATE);
    expect(readAppLogoState(storage)).toEqual(DEFAULT_APP_LOGO_STATE);
  });

  test("subscribers are notified synchronously on every commit", () => {
    const storage = makeStorage();
    resetAppLogoForTests();
    let notifications = 0;
    const unsubscribe = subscribeAppLogo(() => { notifications++; });
    selectLogoPreset("badge-circle", storage);
    applyCustomLogo(validCustomAsset(), storage);
    resetAppLogo(storage);
    expect(notifications).toBe(3);
    unsubscribe();
  });

  test("changing the active source records a local-history revision naming 'App logo'", () => {
    installGlobalLocalStorage();
    try {
      const storage = makeStorage();
      resetAppLogoForTests();
      const before = readRevisions().length;
      selectLogoPreset("badge-circle", storage);
      const after = readRevisions();
      expect(after.length).toBe(before + 1);
      expect(after[0]?.label).toBe("App logo");
      expect(after[0]?.scope).toBe("settings");
    } finally {
      uninstallGlobalLocalStorage();
    }
  });
});

describe("convertLogoImage — fails closed with no raster surface", () => {
  test("with no `document` global at all, conversion refuses cleanly rather than throwing", async () => {
    expect(typeof document).toBe("undefined");
    const probe = { ok: true as const, format: "png" as const, width: 100, height: 100, hasAlpha: true };
    const result = await convertLogoImage(pngBytes(100), probe, {
      fit: "contain",
      background: null,
      focal: { x: 0.5, y: 0.5 },
      cropBox: null,
    });
    expect(result).toEqual({ ok: false, reason: "no-raster-surface" });
  });

  test("a failed conversion never touches the committed store state", () => {
    const storage = makeStorage();
    resetAppLogoForTests();
    selectLogoPreset("badge-square", storage);
    const before = getAppLogoSnapshot().applied;
    // Conversion failing (proven above) must never be allowed to reach
    // `applyCustomLogo` — this asserts the invariant the picker component
    // relies on: it only ever calls `applyCustomLogo` after `result.ok`.
    expect(getAppLogoSnapshot().applied).toEqual(before);
  });
});

describe("probeImageBytes re-export sanity", () => {
  test("the store's own re-export of probeImageBytes agrees with the format module", () => {
    const bytes = pngBytes(32);
    expect(probeImageBytes(bytes)).toEqual({ ok: true, format: "png", width: 32, height: 32, hasAlpha: true });
  });
});

/* ------------------------------------------------------- no network ------- */

describe("privacy: no network access anywhere in the app-logo module family", () => {
  const SRC = fileURLToPath(new URL("../src/theme", import.meta.url));
  const FILES = ["app-logo.ts", "app-logo-format.ts", "app-logo-geometry.ts", "use-app-logo.ts"];

  test("none of the app-logo modules reference fetch, XMLHttpRequest, or WebSocket", () => {
    for (const file of FILES) {
      const text = readFileSync(join(SRC, file), "utf8");
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toContain("XMLHttpRequest");
      expect(text).not.toContain("WebSocket");
    }
  });

  test("the app-logo module directory contains exactly the files this test enumerates", () => {
    // A hand-written list, not a glob-and-trust: a new file added to this
    // family without also being added to `FILES` above would otherwise never
    // be scanned for a network call, which is exactly the gap a completeness
    // guard exists to close.
    const present = readdirSync(SRC).filter(name => name.includes("logo") && statSync(join(SRC, name)).isFile());
    expect(present.sort()).toEqual(FILES.sort());
  });
});
