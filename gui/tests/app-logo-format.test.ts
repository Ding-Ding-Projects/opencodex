/**
 * Byte-level probing for the app-logo customization upload: format detection
 * by magic bytes, header-declared dimension bounds, and the decompression-
 * bomb defence — a huge declared dimension refused from a tiny file, before
 * any decode is ever attempted.
 *
 * Every fixture here is hand-built bytes, not a real image file, which is
 * deliberate: `probeImageBytes` never gets far enough to check a chunk's CRC
 * (it only reads declared lengths/types to walk the structure), so a test
 * fixture needs no real compressed pixel data — a file that *declares* the
 * shape this module cares about is enough to prove what it does with that
 * shape.
 */

import { describe, expect, test } from "bun:test";
import {
  LOGO_MAX_DECLARED_PIXELS,
  LOGO_MAX_DIMENSION,
  LOGO_MAX_FILE_BYTES,
  bytesFromDataUri,
  probeImageBytes,
  probeLogoFile,
} from "../src/theme/app-logo-format";

/* ------------------------------------------------------------ fixtures --- */

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map(c => c.charCodeAt(0));
  // The CRC is never validated by this parser, so four zero bytes stand in
  // for it — real bytes would only be needed by a decoder that checksums.
  return [...u32be(data.length), ...typeBytes, ...data, 0, 0, 0, 0];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function buildPng(opts: { width: number; height: number; colorType?: number; extraChunks?: number[][]; withIdat?: boolean }): Uint8Array {
  const { width, height, colorType = 6, extraChunks = [], withIdat = true } = opts;
  const ihdr = chunk("IHDR", [...u32be(width), ...u32be(height), 8, colorType, 0, 0, 0]);
  const bytes = [...PNG_SIGNATURE, ...ihdr, ...extraChunks.flat()];
  if (withIdat) bytes.push(...chunk("IDAT", [0, 0, 0, 0]), ...chunk("IEND", []));
  return new Uint8Array(bytes);
}

function buildApngExtraChunk(): number[] {
  // acTL: num_frames(4) + num_plays(4). Values are irrelevant — only the
  // chunk *type* is ever inspected.
  return chunk("acTL", [...u32be(2), ...u32be(0)]);
}

function buildJpeg(opts: { width: number; height: number; sofMarker?: number }): Uint8Array {
  const { width, height, sofMarker = 0xc0 } = opts;
  const bytes: number[] = [0xff, 0xd8]; // SOI
  // A minimal APP0/JFIF segment, ahead of the SOF marker the way a real
  // encoder writes one — the scan must walk past it correctly.
  bytes.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  const sofLength = 2 + 1 + 2 + 2 + 1 + 3; // length + precision + height + width + numComponents + one component
  bytes.push(
    0xff, sofMarker,
    (sofLength >> 8) & 0xff, sofLength & 0xff,
    8, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    1, 1, 0x11, 0, // one component
  );
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

/* ------------------------------------------------------------------ tests - */

describe("format detection", () => {
  test("recognises a well-formed PNG", () => {
    const result = probeImageBytes(buildPng({ width: 64, height: 64 }));
    expect(result).toEqual({ ok: true, format: "png", width: 64, height: 64, hasAlpha: true });
  });

  test("recognises a well-formed JPEG", () => {
    const result = probeImageBytes(buildJpeg({ width: 200, height: 150 }));
    expect(result).toEqual({ ok: true, format: "jpeg", width: 200, height: 150, hasAlpha: false });
  });

  test("PNG colour type 2 (truecolor, no alpha) reports hasAlpha: false", () => {
    const result = probeImageBytes(buildPng({ width: 10, height: 10, colorType: 2 }));
    expect(result).toEqual({ ok: true, format: "png", width: 10, height: 10, hasAlpha: false });
  });

  test("an empty buffer is refused as empty, not as an unsupported format", () => {
    expect(probeImageBytes(new Uint8Array(0))).toEqual({ ok: false, reason: "empty-file" });
  });

  test("random non-image bytes are refused as an unsupported format", () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(probeImageBytes(junk)).toEqual({ ok: false, reason: "unsupported-format" });
  });

  test("GIF and WebP signatures are refused as unsupported, not silently accepted", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    expect(probeImageBytes(gif)).toEqual({ ok: false, reason: "unsupported-format" });
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(probeImageBytes(webp)).toEqual({ ok: false, reason: "unsupported-format" });
  });
});

describe("PNG malformed headers", () => {
  // A signature so short it does not even match the full 8-byte PNG magic
  // is caught by format *detection*, not by `probePng` — see "an empty
  // buffer"/"random non-image bytes" above. This section is specifically
  // about bytes that pass detection (the complete, correct 8-byte
  // signature) and are malformed after that point.
  test("the bare signature with no IHDR chunk following it is refused as malformed", () => {
    expect(probeImageBytes(new Uint8Array(PNG_SIGNATURE))).toEqual({ ok: false, reason: "malformed-header" });
  });

  test("a signature too short to even match is refused as an unsupported format, not as malformed", () => {
    expect(probeImageBytes(new Uint8Array(PNG_SIGNATURE.slice(0, 4)))).toEqual({ ok: false, reason: "unsupported-format" });
  });

  test("a signature not followed by IHDR is refused as malformed", () => {
    const bytes = new Uint8Array([...PNG_SIGNATURE, ...chunk("IDAT", [1, 2, 3])]);
    expect(probeImageBytes(bytes)).toEqual({ ok: false, reason: "malformed-header" });
  });

  test("a zero width or height is refused explicitly, not as a generic malformation", () => {
    expect(probeImageBytes(buildPng({ width: 0, height: 10 }))).toEqual({ ok: false, reason: "zero-dimension" });
    expect(probeImageBytes(buildPng({ width: 10, height: 0 }))).toEqual({ ok: false, reason: "zero-dimension" });
  });
});

describe("the decompression-bomb defence", () => {
  test("a declared dimension over the per-axis ceiling is refused before any decode, from a tiny file", () => {
    const bomb = buildPng({ width: LOGO_MAX_DIMENSION + 1, height: 10, withIdat: false });
    // The whole crafted file is a few dozen bytes — nowhere near real pixel
    // data for a >10,000px-wide image, which is the point: refusal must not
    // depend on ever allocating a bitmap that size.
    expect(bomb.length).toBeLessThan(100);
    expect(probeImageBytes(bomb)).toEqual({ ok: false, reason: "dimensions-too-large" });
  });

  test("two in-bounds axes whose product exceeds the pixel ceiling are refused independently", () => {
    // Chosen so each axis alone is under LOGO_MAX_DIMENSION but the product
    // is comfortably over LOGO_MAX_DECLARED_PIXELS.
    const width = 9000;
    const height = 9000;
    expect(width).toBeLessThanOrEqual(LOGO_MAX_DIMENSION);
    expect(width * height).toBeGreaterThan(LOGO_MAX_DECLARED_PIXELS);
    const bomb = buildPng({ width, height, withIdat: false });
    expect(probeImageBytes(bomb)).toEqual({ ok: false, reason: "pixels-too-large" });
  });

  test("the same bombs are refused for JPEG too", () => {
    const bomb = buildJpeg({ width: LOGO_MAX_DIMENSION + 1, height: 10 });
    expect(probeImageBytes(bomb)).toEqual({ ok: false, reason: "dimensions-too-large" });
  });

  test("dimensions exactly at the ceiling are accepted; one pixel over is refused", () => {
    const atCeiling = buildPng({ width: LOGO_MAX_DIMENSION, height: 1 });
    expect(probeImageBytes(atCeiling).ok).toBe(true);
    const overCeiling = buildPng({ width: LOGO_MAX_DIMENSION + 1, height: 1, withIdat: false });
    expect(probeImageBytes(overCeiling)).toEqual({ ok: false, reason: "dimensions-too-large" });
  });
});

describe("animated PNG (APNG) refusal", () => {
  test("an acTL chunk before IDAT marks the file animated and it is refused", () => {
    const apng = buildPng({ width: 32, height: 32, extraChunks: [buildApngExtraChunk()] });
    expect(probeImageBytes(apng)).toEqual({ ok: false, reason: "animated-not-supported" });
  });

  test("a static PNG with no acTL chunk is accepted", () => {
    const png = buildPng({ width: 32, height: 32 });
    expect(probeImageBytes(png).ok).toBe(true);
  });

  test("JPEG has no animation extension to refuse — a JPEG signature never reaches the animated check", () => {
    const result = probeImageBytes(buildJpeg({ width: 32, height: 32 }));
    expect(result.ok).toBe(true);
  });
});

describe("JPEG start-of-frame scanning", () => {
  test("every valid SOF marker (baseline and progressive) is recognised", () => {
    for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca]) {
      const result = probeImageBytes(buildJpeg({ width: 40, height: 30, sofMarker: marker }));
      expect(result).toEqual({ ok: true, format: "jpeg", width: 40, height: 30, hasAlpha: false });
    }
  });

  test("a JPEG with no SOF marker at all is refused as malformed", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // SOI, EOI, nothing else
    expect(probeImageBytes(bytes)).toEqual({ ok: false, reason: "malformed-header" });
  });

  test("bytes not starting 0xFFD8 are never routed into the JPEG parser at all — refused at detection", () => {
    expect(probeImageBytes(new Uint8Array([0x00, 0x00, 0xff, 0xd9]))).toEqual({ ok: false, reason: "unsupported-format" });
  });
});

describe("probeLogoFile — the File-level entry point", () => {
  test("an empty file is refused without reading any bytes", async () => {
    const file = new File([], "empty.png", { type: "image/png" });
    expect(await probeLogoFile(file)).toEqual({ ok: false, reason: "empty-file" });
  });

  test("a file over the size ceiling is refused from File.size alone, before its bytes are read", async () => {
    const oversized = new Uint8Array(LOGO_MAX_FILE_BYTES + 1);
    const file = new File([oversized], "huge.png", { type: "image/png" });
    expect(await probeLogoFile(file)).toEqual({ ok: false, reason: "too-large" });
  });

  test("the file's declared MIME type is never trusted — a .png-typed file with junk bytes is refused", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "lying.png", { type: "image/png" });
    expect(await probeLogoFile(file)).toEqual({ ok: false, reason: "unsupported-format" });
  });

  test("a genuine PNG file probes successfully end to end", async () => {
    const bytes = buildPng({ width: 16, height: 16 });
    const file = new File([bytes], "mark.png", { type: "image/png" });
    const result = await probeLogoFile(file);
    expect(result).toEqual({ ok: true, format: "png", width: 16, height: 16, hasAlpha: true });
  });
});

describe("bytesFromDataUri — the decoder round-trip helper", () => {
  test("round-trips a PNG's own bytes through a base64 data URI", () => {
    const original = buildPng({ width: 8, height: 8 });
    let binary = "";
    for (const byte of original) binary += String.fromCharCode(byte);
    const dataUri = `data:image/png;base64,${btoa(binary)}`;
    const roundTripped = bytesFromDataUri(dataUri);
    expect(roundTripped).not.toBeNull();
    expect([...roundTripped!]).toEqual([...original]);
    // And the round-tripped bytes still probe exactly as the original did.
    expect(probeImageBytes(roundTripped!)).toEqual(probeImageBytes(original));
  });

  test("a non-data URI, or a data URI with no base64 payload, returns null rather than throwing", () => {
    expect(bytesFromDataUri("https://example.com/logo.png")).toBeNull();
    expect(bytesFromDataUri("data:image/png,not-base64")).toBeNull();
    expect(bytesFromDataUri("not a uri at all")).toBeNull();
  });
});
