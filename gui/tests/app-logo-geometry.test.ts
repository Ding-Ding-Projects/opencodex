/**
 * Pure crop/fit geometry for the app-logo editor — fully exercisable with
 * plain numbers, independent of whether the runtime can actually rasterize
 * anything. `app-logo.ts`'s `convertLogoImage` draws from exactly these
 * functions, so proving the arithmetic here is proving what the real canvas
 * output will be shaped like, even in a test environment with no raster
 * surface at all (see `app-logo-store.test.ts` for that half).
 */

import { describe, expect, test } from "bun:test";
import {
  clampCropBox,
  clampFocal,
  computeDestRect,
  computeSourceRect,
  defaultCropBox,
  maxSquareSize,
  type PixelCropBox,
} from "../src/theme/app-logo-geometry";

describe("maxSquareSize", () => {
  test("is the shorter axis", () => {
    expect(maxSquareSize({ width: 800, height: 600 })).toBe(600);
    expect(maxSquareSize({ width: 300, height: 900 })).toBe(300);
    expect(maxSquareSize({ width: 500, height: 500 })).toBe(500);
  });
});

describe("clampFocal", () => {
  test("passes an in-range point through unchanged", () => {
    expect(clampFocal({ x: 0.3, y: 0.7 })).toEqual({ x: 0.3, y: 0.7 });
  });
  test("clamps out-of-range values into [0, 1]", () => {
    expect(clampFocal({ x: -0.5, y: 1.5 })).toEqual({ x: 0, y: 1 });
  });
});

describe("defaultCropBox", () => {
  const landscape = { width: 800, height: 400 };

  test("is a square sized to the shorter axis", () => {
    const box = defaultCropBox(landscape, { x: 0.5, y: 0.5 });
    expect(box.size).toBe(400);
  });

  test("centres on the focal point when there is room", () => {
    const box = defaultCropBox(landscape, { x: 0.5, y: 0.5 });
    // 800-wide image, 400-square crop, centred at x=0.5 (400px) -> box.x = 200.
    expect(box.x).toBe(200);
    expect(box.y).toBe(0); // height already equals the crop size, no room to move
  });

  test("pulls the box back inside the bounds rather than letting it overhang an edge", () => {
    const leftEdge = defaultCropBox(landscape, { x: 0, y: 0.5 });
    expect(leftEdge.x).toBe(0);
    const rightEdge = defaultCropBox(landscape, { x: 1, y: 0.5 });
    expect(rightEdge.x).toBe(landscape.width - leftEdge.size);
  });

  test("a square source centres trivially regardless of focal point", () => {
    const square = { width: 500, height: 500 };
    const box = defaultCropBox(square, { x: 0.2, y: 0.8 });
    expect(box.size).toBe(500);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
  });
});

describe("clampCropBox", () => {
  const source = { width: 400, height: 300 };

  test("leaves an already-valid box untouched", () => {
    const box: PixelCropBox = { x: 10, y: 10, size: 200 };
    expect(clampCropBox(box, source)).toEqual(box);
  });

  test("caps size to the shorter source axis", () => {
    const box: PixelCropBox = { x: 0, y: 0, size: 10_000 };
    expect(clampCropBox(box, source).size).toBe(300);
  });

  test("never lets size fall to zero or below", () => {
    const box: PixelCropBox = { x: 0, y: 0, size: -50 };
    expect(clampCropBox(box, source).size).toBe(1);
  });

  test("pulls x/y back inside bounds once size is resolved", () => {
    const box: PixelCropBox = { x: 380, y: 290, size: 100 };
    const clamped = clampCropBox(box, source);
    expect(clamped.x).toBe(source.width - clamped.size);
    expect(clamped.y).toBe(source.height - clamped.size);
  });

  test("a negative position is pulled back to zero", () => {
    const box: PixelCropBox = { x: -40, y: -40, size: 100 };
    expect(clampCropBox(box, source)).toEqual({ x: 0, y: 0, size: 100 });
  });
});

describe("computeSourceRect", () => {
  const source = { width: 800, height: 400 };
  const focal = { x: 0.5, y: 0.5 };

  test("contain and fill both read the whole source", () => {
    expect(computeSourceRect(source, "contain", focal, null)).toEqual({ x: 0, y: 0, w: 800, h: 400 });
    expect(computeSourceRect(source, "fill", focal, null)).toEqual({ x: 0, y: 0, w: 800, h: 400 });
  });

  test("crop with no explicit box reads the focal point's implied square", () => {
    const rect = computeSourceRect(source, "crop", focal, null);
    expect(rect).toEqual({ x: 200, y: 0, w: 400, h: 400 });
  });

  test("crop with an explicit box reads exactly that box, clamped", () => {
    const rect = computeSourceRect(source, "crop", focal, { x: 700, y: 350, size: 200 });
    // size 200 fits unchanged; x=700 would run off the 800-wide source
    // (700+200=900), so it is pulled back to 800-200=600, and y likewise
    // from 350 to 400-200=200.
    expect(rect).toEqual({ x: 600, y: 200, w: 200, h: 200 });
  });
});

describe("computeDestRect", () => {
  test("fill and crop both cover the full target square", () => {
    const src = { x: 0, y: 0, w: 800, h: 400 };
    expect(computeDestRect("fill", src, 128)).toEqual({ x: 0, y: 0, w: 128, h: 128 });
    const cropSrc = { x: 0, y: 0, w: 200, h: 200 };
    expect(computeDestRect("crop", cropSrc, 128)).toEqual({ x: 0, y: 0, w: 128, h: 128 });
  });

  test("contain scales uniformly and centres the shorter axis", () => {
    // A 2:1 landscape source into a square target: width fills, height is padded.
    const rect = computeDestRect("contain", { x: 0, y: 0, w: 800, h: 400 }, 128);
    expect(rect.w).toBe(128);
    expect(rect.h).toBe(64);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(32); // (128 - 64) / 2, centred
  });

  test("contain on a portrait source pads the horizontal axis instead", () => {
    const rect = computeDestRect("contain", { x: 0, y: 0, w: 400, h: 800 }, 128);
    expect(rect.h).toBe(128);
    expect(rect.w).toBe(64);
    expect(rect.x).toBe(32);
    expect(rect.y).toBe(0);
  });

  test("contain on an already-square source rect exactly fills the target with no padding", () => {
    const rect = computeDestRect("contain", { x: 0, y: 0, w: 300, h: 300 }, 128);
    expect(rect).toEqual({ x: 0, y: 0, w: 128, h: 128 });
  });
});
