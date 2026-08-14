/**
 * `qr-decode.ts` leans entirely on the browser's native `BarcodeDetector`, so
 * these tests are really about two things: the capability flags tell the
 * truth (feature-detect correctly in both directions), and the three entry
 * points hand the detector the right kind of input and come back with the
 * right string — or `null`, never a thrown error, when the platform cannot
 * help.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  cameraSupported,
  clipboardImageReadSupported,
  decodeQrFromClipboard,
  decodeQrFromFile,
  decodeQrFromVideoFrame,
  qrDetectionSupported,
} from "../src/lib/qr-decode";

const globals = ["document", "window", "navigator", "createImageBitmap"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://127.0.0.1:10100/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
  });
});

afterEach(async () => {
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

function installFakeDetector(rawValue: string | null, formats?: string[]) {
  class FakeBarcodeDetector {
    formats: string[];
    constructor(options: { formats: string[] }) { this.formats = options.formats; }
    detect() {
      formats?.push(...this.formats);
      return Promise.resolve(rawValue ? [{ rawValue }] : []);
    }
  }
  Object.defineProperty(win, "BarcodeDetector", { configurable: true, value: FakeBarcodeDetector });
}

function installFakeImageBitmap() {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: () => Promise.resolve({ close: () => {} }),
  });
}

describe("capability flags", () => {
  test("qrDetectionSupported is false with no BarcodeDetector, true once one exists", () => {
    expect(qrDetectionSupported()).toBe(false);
    installFakeDetector("otpauth://totp/a?secret=X");
    expect(qrDetectionSupported()).toBe(true);
  });

  test("clipboardImageReadSupported is false with no navigator.clipboard.read", () => {
    // happy-dom ships its own Clipboard stub with a `read` method, unlike a
    // real browser without permission or a non-secure context — so the
    // "unsupported" case is asserted by explicitly removing it, exactly as
    // `clipboard-fallback.test.ts` does for the sibling clipboard-write path.
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: undefined });
    expect(clipboardImageReadSupported()).toBe(false);
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { read: async () => [] } });
    expect(clipboardImageReadSupported()).toBe(true);
  });

  test("cameraSupported is false with no navigator.mediaDevices.getUserMedia", () => {
    expect(cameraSupported()).toBe(false);
    Object.defineProperty(win.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
    expect(cameraSupported()).toBe(true);
  });
});

describe("decodeQrFromFile", () => {
  test("returns null without throwing when detection is unsupported", async () => {
    const file = { name: "qr.png" } as unknown as File;
    await expect(decodeQrFromFile(file)).resolves.toBeNull();
  });

  test("decodes the raw value once BarcodeDetector and createImageBitmap are present", async () => {
    installFakeDetector("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP");
    installFakeImageBitmap();
    const file = { name: "qr.png" } as unknown as File;
    await expect(decodeQrFromFile(file)).resolves.toBe("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP");
  });

  test("returns null when the detector finds nothing", async () => {
    installFakeDetector(null);
    installFakeImageBitmap();
    const file = { name: "qr.png" } as unknown as File;
    await expect(decodeQrFromFile(file)).resolves.toBeNull();
  });

  test("requests only the qr_code format", async () => {
    const seen: string[] = [];
    installFakeDetector("value", seen);
    installFakeImageBitmap();
    await decodeQrFromFile({ name: "qr.png" } as unknown as File);
    expect(seen).toEqual(["qr_code"]);
  });
});

describe("decodeQrFromClipboard", () => {
  test("returns null when unsupported (no BarcodeDetector, no clipboard.read)", async () => {
    await expect(decodeQrFromClipboard()).resolves.toBeNull();
  });

  test("returns null when the clipboard has no image item", async () => {
    installFakeDetector("otpauth://totp/a?secret=X");
    Object.defineProperty(win.navigator, "clipboard", {
      configurable: true,
      value: { read: async () => [{ types: ["text/plain"], getType: async () => new Blob() }] },
    });
    await expect(decodeQrFromClipboard()).resolves.toBeNull();
  });

  test("decodes the first image item that yields a value", async () => {
    installFakeDetector("otpauth://totp/Clip:bob?secret=JBSWY3DPEHPK3PXP");
    installFakeImageBitmap();
    Object.defineProperty(win.navigator, "clipboard", {
      configurable: true,
      value: {
        read: async () => [{
          types: ["image/png"],
          getType: async () => new Blob(),
        }],
      },
    });
    await expect(decodeQrFromClipboard()).resolves.toBe("otpauth://totp/Clip:bob?secret=JBSWY3DPEHPK3PXP");
  });
});

describe("decodeQrFromVideoFrame", () => {
  test("returns null when unsupported", async () => {
    const video = {} as HTMLVideoElement;
    await expect(decodeQrFromVideoFrame(video)).resolves.toBeNull();
  });

  test("decodes a frame from a live video element", async () => {
    installFakeDetector("otpauth://totp/Cam:carol?secret=JBSWY3DPEHPK3PXP");
    const video = {} as HTMLVideoElement;
    await expect(decodeQrFromVideoFrame(video)).resolves.toBe("otpauth://totp/Cam:carol?secret=JBSWY3DPEHPK3PXP");
  });
});
