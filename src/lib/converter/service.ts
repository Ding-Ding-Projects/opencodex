/**
 * The filesystem-facing layer for the converter's detection pass.
 *
 * Mirrors `src/lib/pdf-tools/service.ts`'s shape deliberately: stat first,
 * refuse before content is touched if the source is unreasonable, read only a
 * bounded slice, and hand plain bytes to a pure function (`sniffFormat`) that
 * has no filesystem access of its own and is trivially unit-testable. This is
 * the one place both `src/server/management/converter-routes.ts` and
 * `src/cli/converter.ts` call into, so the GUI and the CLI can never disagree
 * about what a detection pass found.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { MAGIC_SCAN_BYTES, MAX_DETECT_SOURCE_BYTES } from "./bounds";
import { sniffFormat } from "./detect";
import type { DetectedSource } from "./types";

/** Read only the leading `MAGIC_SCAN_BYTES` of a file — never the whole thing. */
function readLeadingBytes(path: string, maxBytes: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, read);
  } finally {
    closeSync(fd);
  }
}

export async function detectSourceAtPath(path: string): Promise<DetectedSource> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, boundary: "unreadable", reason: "the source file could not be found", bytesInspected: 0 };
  }
  if (!stat.isFile()) {
    return { ok: false, boundary: "unreadable", reason: "the source path is not a regular file", bytesInspected: 0 };
  }
  if (stat.size === 0) {
    return { ok: false, boundary: "empty", reason: "the source file is empty", bytesInspected: 0 };
  }
  if (stat.size > MAX_DETECT_SOURCE_BYTES) {
    return {
      ok: false, boundary: "too-large",
      reason: `the source is ${stat.size} bytes, over the ${MAX_DETECT_SOURCE_BYTES} byte detection limit`,
      bytesInspected: 0,
    };
  }

  let prefix: Uint8Array;
  try {
    prefix = readLeadingBytes(path, Math.min(MAGIC_SCAN_BYTES, stat.size));
  } catch {
    return { ok: false, boundary: "unreadable", reason: "the source file could not be read", bytesInspected: 0 };
  }
  if (prefix.byteLength < 4) {
    return { ok: false, boundary: "too-small", reason: "the file is too small to carry a recognisable signature", bytesInspected: prefix.byteLength };
  }

  const sniff = sniffFormat(prefix);
  return {
    ok: true,
    formatId: sniff.formatId,
    category: sniff.category,
    evidence: sniff.evidence,
    bytesInspected: prefix.byteLength,
  };
}
