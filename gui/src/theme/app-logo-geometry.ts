/**
 * Pure crop/fit geometry for the app-logo editor.
 *
 * Every output size this pipeline produces is a square (the shipped mark, the
 * nav-rail brand image, and the favicon are all square), so the geometry
 * problem is always "map a rectangular source onto a square target" rather
 * than the general case. Keeping that assumption explicit here — rather than
 * threading a variable target aspect ratio through the whole editor — is what
 * keeps the crop box a single draggable square instead of a resizable
 * rectangle with its own aspect-lock control.
 *
 * Nothing here touches a canvas, an `Image`, or the DOM. It is arithmetic over
 * plain numbers, which is what makes the fit/crop/focal-point behaviour fully
 * exercisable from a unit test independent of whether the test environment
 * has a raster surface at all — the drawing step that consumes these rects
 * lives in `app-logo.ts` and is guarded separately.
 */

export type LogoFit = "contain" | "fill" | "crop";

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface FocalPoint {
  /** Normalized [0, 1] across the source's width. */
  readonly x: number;
  /** Normalized [0, 1] across the source's height. */
  readonly y: number;
}

/** A square crop region, in the *source image's own pixel space* — not
 *  normalized — so a stored crop box remains meaningful without also having
 *  to store the display size it was chosen at. */
export interface PixelCropBox {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);

export const DEFAULT_FOCAL: FocalPoint = { x: 0.5, y: 0.5 };

/** The largest square that fits inside the source without exceeding either
 *  axis — the natural crop size when the user has not chosen one yet. */
export function maxSquareSize(source: Size): number {
  return Math.min(source.width, source.height);
}

/** Clamp an arbitrary focal point into the unit square. Guards against a
 *  stored value that predates a bounds change, or a pointer drag that
 *  briefly leaves the preview element. */
export function clampFocal(focal: FocalPoint): FocalPoint {
  return { x: clamp(focal.x, 0, 1), y: clamp(focal.y, 0, 1) };
}

/**
 * The crop box a focal point implies when the user has not dragged one of
 * their own: the largest possible square, centred on the focal point and
 * pulled back inside the source's bounds if that centring would run off an
 * edge.
 */
export function defaultCropBox(source: Size, focal: FocalPoint): PixelCropBox {
  const size = maxSquareSize(source);
  const f = clampFocal(focal);
  const centerX = f.x * source.width;
  const centerY = f.y * source.height;
  const x = clamp(centerX - size / 2, 0, Math.max(0, source.width - size));
  const y = clamp(centerY - size / 2, 0, Math.max(0, source.height - size));
  return { x, y, size };
}

/**
 * Clamp a crop box to stay square, at least 1px, no larger than the source
 * allows, and fully inside the source's bounds — the guard every stored crop
 * box passes through before it is trusted, whether it just came from a drag
 * gesture, a numeric field, or `localStorage`.
 */
export function clampCropBox(box: PixelCropBox, source: Size): PixelCropBox {
  const ceiling = Math.max(1, maxSquareSize(source));
  const size = clamp(box.size, 1, ceiling);
  const x = clamp(box.x, 0, Math.max(0, source.width - size));
  const y = clamp(box.y, 0, Math.max(0, source.height - size));
  return { x, y, size };
}

/**
 * The rectangle to read from the source image, in the source's own pixel
 * space. `contain` and `fill` both read the whole source — they differ only
 * in how the destination rect below places it — while `crop` reads exactly
 * the (clamped) crop box, defaulting to the focal point's implied box when
 * none has been chosen yet.
 */
export function computeSourceRect(source: Size, fit: LogoFit, focal: FocalPoint, cropBox: PixelCropBox | null): Rect {
  if (fit === "crop") {
    const box = cropBox ? clampCropBox(cropBox, source) : defaultCropBox(source, focal);
    return { x: box.x, y: box.y, w: box.size, h: box.size };
  }
  return { x: 0, y: 0, w: source.width, h: source.height };
}

/**
 * Where the source rect above lands on the square target canvas.
 *
 * `fill` and `crop` both cover the entire target — `fill` by stretching the
 * whole source non-uniformly, `crop` because its source rect is already
 * square and needs no further scaling decision. `contain` scales uniformly so
 * the whole source rect fits without cropping, centring the result and
 * leaving the shorter axis to be filled by whatever background the editor
 * chose (or left transparent).
 */
export function computeDestRect(fit: LogoFit, sourceRect: Rect, targetSize: number): Rect {
  if (fit === "fill" || fit === "crop") return { x: 0, y: 0, w: targetSize, h: targetSize };
  const scale = sourceRect.w > 0 && sourceRect.h > 0 ? Math.min(targetSize / sourceRect.w, targetSize / sourceRect.h) : 1;
  const w = sourceRect.w * scale;
  const h = sourceRect.h * scale;
  return { x: (targetSize - w) / 2, y: (targetSize - h) / 2, w, h };
}
