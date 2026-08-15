/**
 * `src/lib/converter/zip-extract.ts` — the bounded, path-safe ZIP extractor.
 *
 * The failure paths come first on purpose: a traversal attempt, a declared-
 * size bomb, an actual-inflate bomb, and malformed input are the properties
 * this contract cares about most, and each is written to prove the refusal
 * happens for the *right* reason (the boundary field), not just that
 * `ok: false` came back somehow.
 */
import { describe, expect, test } from "bun:test";
import { crc32, deflateRawSync } from "node:zlib";
import { buildZip } from "../src/lib/export-archive";
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_ZIP_INPUT_BYTES,
} from "../src/lib/converter/bounds";
import { extractZip } from "../src/lib/converter/zip-extract";

/** Build a ZIP with one entry whose declared central-directory fields are hand-forged, bypassing `buildZip`'s own honesty. */
function buildForgedZip(opts: {
  name: string;
  storedData: Uint8Array;
  declaredCrc?: number;
  declaredUncompressedSize?: number;
  declaredCompressedSize?: number;
  compressionMethod?: number;
  generalPurposeFlag?: number;
}): Uint8Array {
  const nameBytes = new TextEncoder().encode(opts.name);
  const method = opts.compressionMethod ?? 0;
  const body = opts.storedData;
  const crc = opts.declaredCrc ?? crc32(opts.storedData);
  const uncompressedSize = opts.declaredUncompressedSize ?? opts.storedData.length;
  const compressedSize = opts.declaredCompressedSize ?? body.length;
  const gpFlag = opts.generalPurposeFlag ?? 0x0800;

  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, gpFlag, true);
  local.setUint16(8, method, true);
  local.setUint16(10, 0, true);
  local.setUint16(12, 0, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, compressedSize, true);
  local.setUint32(22, uncompressedSize, true);
  local.setUint16(26, nameBytes.length, true);
  local.setUint16(28, 0, true);

  const dir = new DataView(new ArrayBuffer(46));
  dir.setUint32(0, 0x02014b50, true);
  dir.setUint16(4, 20, true);
  dir.setUint16(6, 20, true);
  dir.setUint16(8, gpFlag, true);
  dir.setUint16(10, method, true);
  dir.setUint16(12, 0, true);
  dir.setUint16(14, 0, true);
  dir.setUint32(16, crc, true);
  dir.setUint32(20, compressedSize, true);
  dir.setUint32(24, uncompressedSize, true);
  dir.setUint16(28, nameBytes.length, true);
  dir.setUint32(42, 0, true);

  const offset = 30 + nameBytes.length + body.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + nameBytes.length, true);
  end.setUint32(16, offset, true);

  const parts = [
    new Uint8Array(local.buffer), nameBytes, body,
    new Uint8Array(dir.buffer), nameBytes,
    new Uint8Array(end.buffer),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

describe("extractZip: the safety refusals", () => {
  test("this codebase's own ZIP writer already refuses a traversal path outright — proving the forged fixture below is testing a real attack shape, not a straw man", () => {
    expect(() => buildZip([{ path: "../../etc/passwd", data: new TextEncoder().encode("pwned") }])).toThrow();
  });

  test("refuses a path-traversal entry (../../escape) forged past the writer's own guard", () => {
    const forged = buildForgedZip({ name: "../../etc/passwd", storedData: new TextEncoder().encode("pwned") });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.boundary).toBe("path-traversal");
    }
  });

  test("refuses an absolute-path entry", () => {
    const forged = buildForgedZip({ name: "/etc/passwd", storedData: new TextEncoder().encode("x") });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("path-traversal");
  });

  test("refuses a Windows drive-letter entry", () => {
    const forged = buildForgedZip({ name: "C:/Windows/System32/evil.dll", storedData: new TextEncoder().encode("x") });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("path-traversal");
  });

  test("refuses a backslash-separated entry as unsafe, matching the writer's own convention", () => {
    const forged = buildForgedZip({ name: "a\\..\\..\\evil.txt", storedData: new TextEncoder().encode("x") });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("path-traversal");
  });

  test("refuses an entry whose declared uncompressed size lies past the per-entry bomb limit", () => {
    const forged = buildForgedZip({
      name: "bomb.bin",
      storedData: new Uint8Array(16),
      declaredUncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1,
      declaredCompressedSize: 16,
    });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("bomb-suspected");
  });

  test("refuses a real Deflate stream whose actual decompressed bytes exceed its own declared size (the inflate-time bound fires)", () => {
    // A genuine, honestly-compressed 2 MiB run of a single byte — a real
    // deflate stream, not a forged declaration — but the *declared*
    // uncompressed size in the header understates it by a wide margin, so the
    // hard `maxOutputLength` bound at inflate time is what has to catch this,
    // not merely the ratio check.
    const real = Buffer.alloc(2_000_000, 65);
    const compressed = deflateRawSync(real);
    const forged = buildForgedZip({
      name: "lies-about-its-size.bin",
      storedData: new Uint8Array(compressed),
      compressionMethod: 8,
      declaredUncompressedSize: 1000, // far smaller than the real 2,000,000 bytes
      declaredCompressedSize: compressed.length,
      declaredCrc: 0, // deliberately wrong too; inflate-bound must fire before CRC is ever checked
    });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("bomb-suspected");
  });

  test("refuses a suspiciously high declared compression ratio before ever inflating", () => {
    // A tiny compressed blob claiming an enormous uncompressed size — no real
    // Deflate stream could honestly produce this ratio.
    const forged = buildForgedZip({
      name: "impossible-ratio.bin",
      storedData: new Uint8Array(deflateRawSync(Buffer.alloc(10, 1))),
      compressionMethod: 8,
      declaredUncompressedSize: 50_000_000,
      declaredCompressedSize: 12,
    });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("bomb-suspected");
  });

  test("refuses an archive whose declared entry total exceeds MAX_ZIP_ENTRIES", () => {
    // Forge just the EOCD record's entry count without real entries backing
    // it — the entry-count refusal must fire before any entry is read.
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    const tooMany = MAX_ZIP_ENTRIES + 1;
    end.setUint16(8, tooMany, true);
    end.setUint16(10, tooMany, true);
    end.setUint32(12, 0, true);
    end.setUint32(16, 0, true);
    const result = extractZip(new Uint8Array(end.buffer));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("too-many-entries");
  });

  test("refuses an oversized input before it is parsed at all", () => {
    const huge = new Uint8Array(MAX_ZIP_INPUT_BYTES + 1);
    const result = extractZip(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("too-large");
  });

  test("refuses malformed input with no End Of Central Directory record", () => {
    const result = extractZip(new TextEncoder().encode("this is not a zip file at all"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("refuses an empty buffer", () => {
    const result = extractZip(new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("refuses an entry whose checksum does not match its decompressed bytes (integrity)", () => {
    const forged = buildForgedZip({
      name: "tampered.txt",
      storedData: new TextEncoder().encode("original content"),
      declaredCrc: 0xdeadbeef,
    });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("integrity");
  });

  test("refuses an encrypted entry (general-purpose bit 0)", () => {
    const forged = buildForgedZip({
      name: "secret.txt",
      storedData: new TextEncoder().encode("shh"),
      generalPurposeFlag: 0x0801,
    });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("unsupported");
  });

  test("refuses an entry using the data-descriptor form (general-purpose bit 3)", () => {
    const forged = buildForgedZip({
      name: "streamed.txt",
      storedData: new TextEncoder().encode("streamed"),
      generalPurposeFlag: 0x0808,
    });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("unsupported");
  });

  test("refuses an unsupported compression method", () => {
    const forged = buildForgedZip({
      name: "weird.bin",
      storedData: new Uint8Array(4),
      compressionMethod: 99,
    });
    const result = extractZip(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("unsupported");
  });
});

describe("extractZip: the real, happy path", () => {
  test("extracts a real ZIP built by this codebase's own writer, byte for byte", () => {
    const files = [
      { path: "hello.txt", data: new TextEncoder().encode("hello, world") },
      { path: "dir/nested.txt", data: new TextEncoder().encode("nested content") },
      { path: "big.bin", data: new Uint8Array(50_000).fill(7) }, // large enough to actually deflate, not just store
    ];
    const zip = buildZip(files);
    const result = extractZip(zip);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.length).toBe(3);
    for (const file of files) {
      const entry = result.entries.find(e => e.path === file.path);
      expect(entry).toBeTruthy();
      expect(entry!.isDirectory).toBe(false);
      expect(Buffer.from(entry!.data).equals(Buffer.from(file.data))).toBe(true);
    }
  });

  test("extracts a directory entry as a directory with no data", () => {
    const zip = buildForgedZip({ name: "adir/", storedData: new Uint8Array(0), declaredCrc: 0, declaredUncompressedSize: 0, declaredCompressedSize: 0 });
    const result = extractZip(zip);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].isDirectory).toBe(true);
    expect(result.entries[0].data.byteLength).toBe(0);
  });

  test("an empty archive (zero entries) extracts to zero entries, not an error", () => {
    const zip = buildZip([]);
    const result = extractZip(zip);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries.length).toBe(0);
  });
});
