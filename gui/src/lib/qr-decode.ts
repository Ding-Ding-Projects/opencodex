/**
 * Reading a QR code back — from an image file, the clipboard, or a live
 * camera — through the browser's native `BarcodeDetector` rather than a
 * hand-rolled decoder.
 *
 * `gui/src/lib/qr.ts` writes a QR encoder from scratch because encoding is a
 * ~250-line, fully specified algorithm and a dependency would be an odd trade
 * for that. *Decoding* is a different shape of problem — finder-pattern
 * search, perspective correction, Reed–Solomon error correction over a noisy
 * photograph — and every desktop build of this app already ships Chromium,
 * which has shipped `BarcodeDetector` for exactly this since M83. Writing a
 * second implementation of the same ISO/IEC 18004 algorithm, this time in the
 * decode direction, would be hundreds more lines to buy nothing the platform
 * does not already do correctly. Everything here still runs in-process, still
 * touches no network, and still never uploads an image anywhere — the
 * no-network rule this file exists under is about the data leaving the
 * machine, not about which code drew the box around the QR.
 *
 * `BarcodeDetector` is a real but still-experimental Web API: TypeScript's
 * bundled DOM lib does not type it, so the minimal shape used here is
 * declared locally rather than widened to `any` everywhere it is touched.
 * Every entry point feature-detects before use and returns `null` rather than
 * throwing, so a build without it degrades to "this route is unavailable"
 * (surfaced with a stated reason by the caller) instead of a crash.
 */

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource | HTMLVideoElement): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructorLike {
  new(options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

function detectorCtor(): BarcodeDetectorConstructorLike | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructorLike }).BarcodeDetector;
  return ctor ?? null;
}

/** Whether this build can decode a QR at all — the fact every disabled control here explains itself with. */
export function qrDetectionSupported(): boolean {
  return detectorCtor() !== null;
}

/** Whether this build can read an image from the system clipboard. Independent of QR-detection support. */
export function clipboardImageReadSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function";
}

/** Whether this build can request a camera. Independent of QR-detection support. */
export function cameraSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

async function detectOne(source: ImageBitmapSource | HTMLVideoElement): Promise<string | null> {
  const Ctor = detectorCtor();
  if (!Ctor) return null;
  const detector = new Ctor({ formats: ["qr_code"] });
  try {
    const results = await detector.detect(source);
    return results[0]?.rawValue ?? null;
  } catch {
    // A frame the detector cannot process (corrupt image, camera hiccup)
    // reads as "nothing found yet", never as a thrown error mid-scan.
    return null;
  }
}

/** Decode a QR from a local image file (from a file-picker or a drop target). */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  if (!qrDetectionSupported()) return null;
  const bitmap = await createImageBitmap(file);
  try {
    return await detectOne(bitmap);
  } finally {
    bitmap.close();
  }
}

/**
 * Decode a QR from an image currently on the system clipboard.
 * Returns `null` when there is no image on the clipboard, or none of the
 * images present decode as a QR — both distinct from "unsupported", which
 * `clipboardImageReadSupported`/`qrDetectionSupported` answer up front.
 */
export async function decodeQrFromClipboard(): Promise<string | null> {
  if (!qrDetectionSupported() || !clipboardImageReadSupported()) return null;
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find(type => type.startsWith("image/"));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const bitmap = await createImageBitmap(blob);
    try {
      const value = await detectOne(bitmap);
      if (value) return value;
    } finally {
      bitmap.close();
    }
  }
  return null;
}

/** Decode a QR directly from a live `<video>` element (one frame). Used by the camera-scan loop. */
export function decodeQrFromVideoFrame(video: HTMLVideoElement): Promise<string | null> {
  if (!qrDetectionSupported()) return Promise.resolve(null);
  return detectOne(video);
}
