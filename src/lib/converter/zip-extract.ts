/**
 * A bounded, path-safe ZIP extractor — the missing half of
 * `src/lib/export-archive.ts`'s dependency-free ZIP writer.
 *
 * ZIP is written elsewhere in this codebase on `node:zlib` alone, with no
 * external dependency. This module extracts the same format to the same
 * standard: no external dependency, and every one of the converter
 * contract's specific safety rules enforced explicitly rather than assumed.
 *
 * The central directory (never the local headers alone) is the source of
 * truth for what the archive contains — reading only local headers in file
 * order is what lets a spoofed local header disagree with what a tool later
 * lists, which is a real ZIP-parsing confusion class. Every declared size is
 * bounded *before* a single byte is inflated, every path is proven safe
 * before any byte is written, and the actual inflate call is *also* bounded
 * (`maxOutputLength`) so a declared size that lies cannot exhaust memory
 * either. Extraction is all-or-nothing: one unsafe path, one size that looks
 * like a bomb, or one checksum mismatch refuses the *entire* archive rather
 * than silently skipping the one bad entry, so a caller can never end up
 * holding a partial, seemingly-successful extraction.
 *
 * Deliberately out of scope, named rather than silently mishandled:
 *  - **ZIP64** (archives needing 64-bit sizes/offsets) — refused with a clear
 *    reason. This converter's own size bounds sit far below the 4 GiB
 *    boundary where ZIP64 would ever be needed for a legitimate input.
 *  - **Multi-disk (spanned) archives** — refused; there is exactly one file
 *    to read from here.
 *  - **Encrypted entries** — refused, matching `export-archive.ts`'s existing
 *    "no password channel exists yet" precedent for 7z.
 *  - **The data-descriptor form** (general-purpose bit 3: sizes trail the
 *    compressed data instead of living in the local header) — refused rather
 *    than parsed, to avoid trusting an optional, unauthenticated trailer to
 *    say how much memory to allocate.
 *  - **Backslash-separated entry names** — refused as unsafe by
 *    `assertSafePath`, the same rule the writer already enforces on the way
 *    in.
 *  - **Unix symlink entries** (an external-attributes bit some archivers set)
 *    — never interpreted. Every entry is written as a plain file or a plain
 *    directory; nothing this module produces can ever itself be a symlink.
 *  - Only compression method 0 (Store) and 8 (Deflate) are read; anything
 *    else is refused as unsupported.
 */
import { crc32, inflateRawSync } from "node:zlib";
import { assertSafePath } from "../export-archive";
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_COMPRESSION_RATIO,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_ZIP_INPUT_BYTES,
  MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
} from "./bounds";

export interface ExtractedZipEntry {
  /** Relative, "/"-separated, already proven safe by `assertSafePath`. */
  path: string;
  isDirectory: boolean;
  data: Uint8Array;
}

export type ZipExtractBoundary =
  | "too-large"
  | "too-many-entries"
  | "malformed"
  | "unsupported"
  | "path-traversal"
  | "bomb-suspected"
  | "integrity";

export type ExtractZipResult =
  | { ok: true; entries: ExtractedZipEntry[] }
  | { ok: false; boundary: ZipExtractBoundary; reason: string };

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const CENTRAL_DIRECTORY_FIXED_SIZE = 46;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const MAX_COMMENT_LENGTH = 0xffff;

const GP_FLAG_ENCRYPTED = 0x0001;
const GP_FLAG_DATA_DESCRIPTOR = 0x0008;

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function fail(boundary: ZipExtractBoundary, reason: string): ExtractZipResult {
  return { ok: false, boundary, reason };
}

/**
 * Scan backward for the End Of Central Directory record. The comment field
 * is variable length and attacker-controlled, so a bare signature match is
 * not enough to trust — a candidate is only accepted when its own declared
 * comment length exactly accounts for the rest of the buffer.
 */
function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number | null {
  if (bytes.byteLength < EOCD_FIXED_SIZE) return null;
  const searchFloor = Math.max(0, bytes.byteLength - EOCD_FIXED_SIZE - MAX_COMMENT_LENGTH);
  for (let offset = bytes.byteLength - EOCD_FIXED_SIZE; offset >= searchFloor; offset--) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_FIXED_SIZE + commentLength === bytes.byteLength) return offset;
  }
  return null;
}

interface ParsedCentralEntry {
  path: string;
  isDirectory: boolean;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

/**
 * Extract every entry from a ZIP archive already held in memory.
 *
 * Pure and filesystem-free by design: nothing here opens a file, spawns a
 * process, or reaches the network, so this function is trivially and safely
 * unit-testable with adversarial byte arrays. `archive-service.ts` is the fs-
 * facing layer that reads a real source file and writes real entries to disk.
 */
export function extractZip(bytes: Uint8Array): ExtractZipResult {
  if (bytes.byteLength > MAX_ZIP_INPUT_BYTES) {
    return fail("too-large", `the archive is ${bytes.byteLength} bytes, over the ${MAX_ZIP_INPUT_BYTES} byte limit`);
  }
  if (bytes.byteLength === 0) {
    return fail("malformed", "the archive is empty");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes, view);
  if (eocdOffset === null) {
    return fail("malformed", "no End Of Central Directory record was found — this is not a valid ZIP archive");
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirDisk = view.getUint16(eocdOffset + 6, true);
  const entriesThisDisk = view.getUint16(eocdOffset + 8, true);
  const entriesTotal = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || centralDirDisk !== 0 || entriesThisDisk !== entriesTotal) {
    return fail("unsupported", "multi-disk (spanned) ZIP archives are not supported");
  }
  if (entriesTotal === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    return fail("unsupported", "ZIP64 archives are not supported — this converter's own size bounds sit well below the range ZIP64 exists for");
  }
  if (entriesTotal > MAX_ZIP_ENTRIES) {
    return fail("too-many-entries", `the archive declares ${entriesTotal} entries, over the ${MAX_ZIP_ENTRIES} limit`);
  }
  if (centralDirOffset + centralDirSize > eocdOffset) {
    return fail("malformed", "the central directory does not fit before the End Of Central Directory record");
  }

  const parsed: ParsedCentralEntry[] = [];
  let totalUncompressed = 0;
  let cursor = centralDirOffset;

  for (let i = 0; i < entriesTotal; i++) {
    if (cursor + CENTRAL_DIRECTORY_FIXED_SIZE > bytes.byteLength) {
      return fail("malformed", "the central directory is truncated");
    }
    if (view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      return fail("malformed", `central directory entry ${i} has a bad signature`);
    }
    const gpFlag = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const entryCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      return fail("unsupported", `entry ${i} uses ZIP64 extra fields, which are not supported`);
    }
    const nameStart = cursor + CENTRAL_DIRECTORY_FIXED_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) return fail("malformed", `central directory entry ${i} is truncated`);
    const rawName = utf8Decoder.decode(bytes.subarray(nameStart, nameEnd));

    if (gpFlag & GP_FLAG_ENCRYPTED) {
      return fail("unsupported", `entry "${rawName}" is encrypted — there is no password channel for archive extraction yet`);
    }
    if (gpFlag & GP_FLAG_DATA_DESCRIPTOR) {
      return fail("unsupported", `entry "${rawName}" stores its sizes in a trailing data descriptor instead of its local header, which is not supported`);
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      return fail("unsupported", `entry "${rawName}" uses compression method ${compressionMethod} — only Store (0) and Deflate (8) are supported`);
    }

    const isDirectory = rawName.endsWith("/") && uncompressedSize === 0 && compressedSize === 0;
    const normalized = rawName.replace(/\/+$/, "");
    try {
      assertSafePath(normalized);
    } catch (error) {
      return fail("path-traversal", `entry "${rawName}" has an unsafe path: ${(error as Error).message}`);
    }

    totalUncompressed += uncompressedSize;
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      return fail("bomb-suspected", `entry "${rawName}" declares ${uncompressedSize} uncompressed bytes, over the ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES} byte per-entry limit`);
    }
    if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      return fail("bomb-suspected", `the archive's declared uncompressed total exceeds the ${MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES} byte limit`);
    }
    if (compressionMethod === 8 && compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > MAX_ZIP_ENTRY_COMPRESSION_RATIO) {
        return fail("bomb-suspected", `entry "${rawName}" claims a ${ratio.toFixed(0)}:1 compression ratio, over the ${MAX_ZIP_ENTRY_COMPRESSION_RATIO}:1 limit a single Deflate stream can legitimately reach`);
      }
    }

    parsed.push({
      path: normalized, isDirectory, compressionMethod, compressedSize, uncompressedSize,
      crc32: entryCrc, localHeaderOffset,
    });
    cursor = nameEnd + extraLength + commentLength;
  }

  // Second pass: every entry above is already proven safe and within bounds.
  // Now, and only now, read and inflate the actual bytes.
  const entries: ExtractedZipEntry[] = [];
  for (const entry of parsed) {
    if (entry.isDirectory) {
      entries.push({ path: entry.path, isDirectory: true, data: new Uint8Array(0) });
      continue;
    }
    if (entry.localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE > bytes.byteLength) {
      return fail("malformed", `entry "${entry.path}"'s local file header does not fit in the archive`);
    }
    if (view.getUint32(entry.localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
      return fail("malformed", `entry "${entry.path}" has a bad local file header signature`);
    }
    const localNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localHeaderOffset + 28, true);
    const dataStart = entry.localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > bytes.byteLength || dataEnd > bytes.byteLength) {
      return fail("malformed", `entry "${entry.path}" data is truncated`);
    }
    const compressed = bytes.subarray(dataStart, dataEnd);

    let data: Uint8Array;
    if (entry.compressionMethod === 0) {
      if (compressed.byteLength !== entry.uncompressedSize) {
        return fail("malformed", `entry "${entry.path}" is stored but its size does not match its declared uncompressed size`);
      }
      data = new Uint8Array(compressed);
    } else {
      try {
        data = new Uint8Array(inflateRawSync(Buffer.from(compressed), {
          maxOutputLength: Math.max(entry.uncompressedSize, 1),
        }));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ERR_BUFFER_TOO_LARGE") {
          return fail("bomb-suspected", `entry "${entry.path}" inflated past its own declared size — refused rather than allocating further`);
        }
        return fail("malformed", `entry "${entry.path}" could not be decompressed: ${(error as Error).message}`);
      }
      if (data.byteLength !== entry.uncompressedSize) {
        return fail("malformed", `entry "${entry.path}" decompressed to ${data.byteLength} bytes, not its declared ${entry.uncompressedSize}`);
      }
    }

    const actualCrc = crc32(data);
    if (actualCrc !== entry.crc32) {
      return fail("integrity", `entry "${entry.path}" failed its checksum after decompression — the archive is corrupt or was tampered with`);
    }
    entries.push({ path: entry.path, isDirectory: false, data });
  }

  return { ok: true, entries };
}
