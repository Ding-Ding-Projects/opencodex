/**
 * Byte-level probing for a candidate app-logo image, before anything is ever
 * decoded.
 *
 * This is the "verify the actual bytes rather than trusting an extension or
 * MIME claim" half of the app-logo customization contract. A `File` named
 * `mark.png` with `type: "image/png"` proves nothing on its own — both are
 * strings the picker chose, not facts about the bytes — so every candidate is
 * identified by its real magic-byte signature and its header-declared
 * dimensions are read and bounded *before* a single pixel is decoded.
 *
 * That ordering is the decompression-bomb defence. A PNG's `IHDR` chunk can
 * declare a width and height of billions while the file itself is a few
 * hundred bytes (the compressed data need not describe real pixels to be
 * syntactically valid), so a decoder that trusted the file and allocated a
 * bitmap for whatever the header claimed would be handed exactly the attack
 * this module exists to refuse. Every bound here is checked against the
 * *declared* header values, which cost nothing to read, so a bomb is refused
 * before the expensive step — an actual decode — ever runs.
 *
 * Only PNG and JPEG are recognised. Both are deliberately chosen for having no
 * legitimate single-frame ambiguity: JPEG has no animation extension at all,
 * and PNG's animation extension (APNG) is a well-defined marker chunk
 * (`acTL`) that must appear before the first `IDAT`, so "is this the animated
 * kind" is answerable from the header alone. WebP and GIF both encode
 * animation in ways that would need substantially more format-specific
 * parsing to rule out reliably from raw bytes, for a marginal gain over the
 * two formats this already covers — so they are refused as an unsupported
 * format rather than partially trusted.
 *
 * Nothing in this file touches the DOM, a canvas, or the network. It is pure
 * byte arithmetic over a `Uint8Array`, which is what makes it exercisable in
 * full from a plain unit test — including the decompression-bomb case, which
 * needs nothing but a 33-byte crafted header to prove.
 */

/** Hard ceiling on the *input* file, checked against `File.size` before a
 *  single byte is read into memory. A logo is a small mark, not a photo
 *  archive — 8 MiB is generous for a legitimate high-resolution source and
 *  small enough that even a refused file costs nothing to reject. */
export const LOGO_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** No header may declare either axis larger than this, checked against the
 *  declared value alone — never against a decoded bitmap, which would already
 *  be too late. */
export const LOGO_MAX_DIMENSION = 10_000;

/** No header may declare a pixel count (`width * height`) larger than this,
 *  independent of the per-axis bound above: a 9 000 × 9 000 declaration
 *  passes the per-axis check but is an 81-megapixel decode target, which this
 *  catches instead. ~25 megapixels is far beyond any legitimate app-mark
 *  source (the shipped mark is 512 × 512 — a quarter of a million pixels). */
export const LOGO_MAX_DECLARED_PIXELS = 25_000_000;

/** Every reason a candidate is refused, exhaustive by construction — a reason
 *  added to this union without a matching row in the settings screen's
 *  explanation table is a compile error there, not a silent "invalid". */
export type LogoProbeRejectReason =
  | "empty-file"
  | "too-large"
  | "unsupported-format"
  | "malformed-header"
  | "zero-dimension"
  | "dimensions-too-large"
  | "pixels-too-large"
  | "animated-not-supported";

export interface LogoProbeOk {
  readonly ok: true;
  readonly format: "png" | "jpeg";
  readonly width: number;
  readonly height: number;
  /** From the PNG colour type alone (4 = grey+alpha, 6 = RGBA); a palette
   *  entry (type 3) may still carry transparency through a `tRNS` chunk this
   *  does not scan for, so `false` there means "not declared", not "proven
   *  opaque" — the real answer comes from the decode step later in the
   *  pipeline. JPEG has no alpha channel at all, so this is always `false`. */
  readonly hasAlpha: boolean;
}

export interface LogoProbeReject {
  readonly ok: false;
  readonly reason: LogoProbeRejectReason;
}

export type LogoProbeResult = LogoProbeOk | LogoProbeReject;

function reject(reason: LogoProbeRejectReason): LogoProbeReject {
  return { ok: false, reason };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read 4 ASCII bytes as a chunk-type string; never throws on out-of-range
 *  input, so a truncated chunk header degrades to a string that simply will
 *  not match `"acTL"`/`"IDAT"` rather than crashing the scan. */
function ascii4(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) return "";
  let out = "";
  for (let i = 0; i < 4; i++) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}

/** Chunks scanned looking for `acTL` before giving up. A legitimate PNG has
 *  a handful of chunks (IHDR, gAMA/cHRM/sRGB/pHYs/tEXt, then IDAT) before its
 *  pixel data begins; 64 is generous headroom while still bounding the scan
 *  independently of the file-size ceiling above. */
const PNG_CHUNK_SCAN_CAP = 64;

function probePng(bytes: Uint8Array): LogoProbeResult {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + IHDR body (13) + CRC (4).
  if (bytes.length < 33) return reject("malformed-header");
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return reject("malformed-header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstLength = view.getUint32(8, false);
  const firstType = ascii4(bytes, 12);
  if (firstType !== "IHDR" || firstLength !== 13) return reject("malformed-header");

  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const colorType = bytes[25]!;

  if (width === 0 || height === 0) return reject("zero-dimension");
  if (width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) return reject("dimensions-too-large");
  // `width * height` can exceed 2^31 for adversarial input; both operands are
  // already bounded to LOGO_MAX_DIMENSION above, so this product cannot
  // overflow `Number`'s safe-integer range before the comparison runs.
  if (width * height > LOGO_MAX_DECLARED_PIXELS) return reject("pixels-too-large");

  // Scan forward from the chunk after IHDR, looking for `acTL` — the APNG
  // animation-control chunk, which the spec requires to precede the first
  // `IDAT`. Reaching IDAT (or running out of scannable chunks) with no acTL
  // found means "not animated"; the scan is bounded on three independent
  // axes — buffer length, a hard chunk-count cap, and a "did this chunk
  // actually advance the offset" guard — so a malformed length field can
  // never turn this into an unbounded loop.
  let offset = 8 + 8 + 13 + 4;
  let scanned = 0;
  while (offset + 8 <= bytes.length && scanned < PNG_CHUNK_SCAN_CAP) {
    const length = view.getUint32(offset, false);
    const type = ascii4(bytes, offset + 4);
    if (type === "acTL") return reject("animated-not-supported");
    if (type === "IDAT") break;
    const next = offset + 8 + length + 4;
    if (length < 0 || next <= offset || next > bytes.length + 4) break;
    offset = next;
    scanned++;
  }

  const hasAlpha = colorType === 4 || colorType === 6;
  return { ok: true, format: "png", width, height, hasAlpha };
}

/** JPEG markers with no length-prefixed payload — SOI, EOI, the eight RSTn
 *  restart markers, and TEM — are skipped without reading a length field.
 *  Every other marker in the 0xFF-prefixed stream carries a 2-byte
 *  big-endian length (inclusive of the length field itself) immediately
 *  after the marker byte. */
function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/** SOF0…SOF15 (0xC0–0xCF) carry frame dimensions, excluding 0xC4 (DHT), 0xC8
 *  (reserved/JPG), and 0xCC (DAC) — none of which are start-of-frame markers
 *  despite sitting in the same numeric range. */
function isStartOfFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Segments scanned looking for a start-of-frame marker before giving up.
 *  Bounded independently of file size for the same reason the PNG chunk scan
 *  is — a crafted segment length must not be able to turn this into an
 *  effectively unbounded walk. */
const JPEG_SEGMENT_SCAN_CAP = 4096;

function probeJpeg(bytes: Uint8Array): LogoProbeResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return reject("malformed-header");
  let offset = 2;
  let scanned = 0;
  while (offset < bytes.length && scanned < JPEG_SEGMENT_SCAN_CAP) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    // Marker codes may be preceded by any number of 0xFF fill bytes.
    let markerPos = offset + 1;
    while (markerPos < bytes.length && bytes[markerPos] === 0xff) markerPos++;
    if (markerPos >= bytes.length) return reject("malformed-header");
    const marker = bytes[markerPos]!;
    if (marker === 0xd9) break; // EOI
    if (isStandaloneJpegMarker(marker)) {
      offset = markerPos + 1;
      scanned++;
      continue;
    }
    const segStart = markerPos + 1;
    if (segStart + 2 > bytes.length) return reject("malformed-header");
    const segLength = (bytes[segStart]! << 8) | bytes[segStart + 1]!;
    if (segLength < 2) return reject("malformed-header");
    if (isStartOfFrameMarker(marker)) {
      // Payload: precision(1) + height(2 BE) + width(2 BE) + …
      if (segStart + 2 + 5 > bytes.length) return reject("malformed-header");
      const height = (bytes[segStart + 3]! << 8) | bytes[segStart + 4]!;
      const width = (bytes[segStart + 5]! << 8) | bytes[segStart + 6]!;
      if (width === 0 || height === 0) return reject("zero-dimension");
      if (width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) return reject("dimensions-too-large");
      if (width * height > LOGO_MAX_DECLARED_PIXELS) return reject("pixels-too-large");
      // Baseline/progressive JFIF carries no alpha channel; the Adobe APP14
      // "transform" extension some encoders emit is not honoured by the
      // canvas decode this pipeline uses downstream, so claiming alpha here
      // would assert something the rest of the pipeline cannot back up.
      return { ok: true, format: "jpeg", width, height, hasAlpha: false };
    }
    const next = segStart + segLength;
    if (next <= offset) return reject("malformed-header");
    offset = next;
    scanned++;
  }
  return reject("malformed-header");
}

function detectFormat(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  return null;
}

/**
 * Probe raw image bytes end to end: format detection by magic bytes, then
 * format-specific header parsing with every bound enforced against the
 * *declared* values before any decode is attempted.
 *
 * Pure and synchronous, so this is exactly what re-validates a cached
 * variant's own bytes (the decoder round-trip check) as much as it is what
 * validates a freshly uploaded file's contents.
 */
export function probeImageBytes(bytes: Uint8Array): LogoProbeResult {
  if (bytes.length === 0) return reject("empty-file");
  const format = detectFormat(bytes);
  if (format === "png") return probePng(bytes);
  if (format === "jpeg") return probeJpeg(bytes);
  return reject("unsupported-format");
}

/**
 * Validate a user-picked `File` end to end. The size check runs against
 * `File.size` — metadata the browser already has — before `file.arrayBuffer()`
 * is ever called, so an oversized file is refused without its contents being
 * read into memory at all.
 */
export async function probeLogoFile(file: File): Promise<LogoProbeResult> {
  if (file.size === 0) return reject("empty-file");
  if (file.size > LOGO_MAX_FILE_BYTES) return reject("too-large");
  const buffer = await file.arrayBuffer();
  return probeImageBytes(new Uint8Array(buffer));
}

/** Decode a `data:` URI's own payload back into bytes, for the decoder
 *  round-trip check: every variant this pipeline produces is re-probed
 *  through {@link probeImageBytes} using exactly this function, so a browser
 *  that mis-encoded a corner case is caught rather than trusted on the
 *  strength of having produced *a* string. Returns `null` for anything that
 *  is not a base64 `data:` URI rather than throwing, so a malformed producer
 *  fails the round-trip check instead of crashing it. */
export function bytesFromDataUri(dataUri: string): Uint8Array | null {
  const match = /^data:[^;,]+;base64,([a-zA-Z0-9+/=]+)$/.exec(dataUri);
  if (!match) return null;
  try {
    const binary = atob(match[1]!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
