import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { listArchivedCandidates } from "../src/storage/cleanup";
import { decompressRolloutZstUtf8ForTests } from "../src/codex/history-provider";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * Regression guard: archived-session candidate discovery must never follow a
 * symlink, and the `.jsonl.zst` decompressor must never read an oversized
 * input into memory before checking its size.
 *
 * `listArchivedCandidates` used to `statSync` each entry, which follows a
 * symlink and would let a link under `archived_sessions/` stand in for
 * whatever real file it points at -- including one well outside that
 * directory. `decompressRolloutZstUtf8` used to `readFileSync` the whole
 * compressed input before ever consulting `maxBytes`, so a symlink pointing
 * at a huge file would be read into memory in full.
 */

let home = "";

afterEach(() => {
  if (home) {
    try { removeTempDir(home); } catch { /* best-effort */ }
    home = "";
  }
});

describe("listArchivedCandidates symlink safety", () => {
  test("a symlinked entry under archived_sessions/ is skipped, not resolved to its target", () => {
    home = mkdtempSync(join(tmpdir(), "ocx-archive-symlink-"));
    mkdirSync(join(home, "archived_sessions"), { recursive: true });
    mkdirSync(join(home, "elsewhere"), { recursive: true });

    // A real candidate, which must still be listed.
    writeFileSync(join(home, "archived_sessions", "real.jsonl"), "REAL".repeat(10));
    // A file that lives OUTSIDE archived_sessions/, linked to FROM inside it.
    // A vulnerable implementation would follow the link and surface this file's
    // metadata as if it were a normal archived_sessions/ entry.
    writeFileSync(join(home, "elsewhere", "target.jsonl"), "TARGET".repeat(1000));
    symlinkSync(
      join(home, "elsewhere", "target.jsonl"),
      join(home, "archived_sessions", "linked.jsonl"),
    );

    const candidates = listArchivedCandidates(home);
    const relPaths = candidates.map(c => c.relPath).sort();

    expect(relPaths).toEqual(["archived_sessions/real.jsonl"]);
    expect(candidates.some(c => c.physicalRelPaths.includes("archived_sessions/linked.jsonl"))).toBe(false);
  });

  test("a dangling symlink under archived_sessions/ is skipped without throwing", () => {
    home = mkdtempSync(join(tmpdir(), "ocx-archive-symlink-dangling-"));
    mkdirSync(join(home, "archived_sessions"), { recursive: true });
    writeFileSync(join(home, "archived_sessions", "real.jsonl"), "REAL".repeat(10));
    symlinkSync(
      join(home, "nonexistent-target.jsonl"),
      join(home, "archived_sessions", "dangling.jsonl"),
    );

    const candidates = listArchivedCandidates(home);
    expect(candidates.map(c => c.relPath)).toEqual(["archived_sessions/real.jsonl"]);
  });
});

describe("decompressRolloutZstUtf8 input-size guard", () => {
  test("rejects an oversized compressed input before reading it in full", () => {
    home = mkdtempSync(join(tmpdir(), "ocx-rollout-zst-size-"));
    const path = join(home, "oversized.jsonl.zst");
    // Content doesn't need to be valid zstd: the size check must reject the
    // input before any attempt to decompress it.
    writeFileSync(path, "x".repeat(1000));

    expect(() => decompressRolloutZstUtf8ForTests(path, 100)).toThrow("rollout_zst_too_large");
  });

  test("still decompresses a genuine input within the size cap", () => {
    home = mkdtempSync(join(tmpdir(), "ocx-rollout-zst-size-ok-"));
    const path = join(home, "ok.jsonl.zst");
    const original = '{"type":"session_meta"}\n';
    writeFileSync(path, zstdCompressSync(Buffer.from(original, "utf8")));

    expect(decompressRolloutZstUtf8ForTests(path, 1_000_000)).toBe(original);
  });

  test("a symlinked oversized target is rejected without reading the full target into memory", () => {
    home = mkdtempSync(join(tmpdir(), "ocx-rollout-zst-symlink-"));
    mkdirSync(join(home, "elsewhere"), { recursive: true });
    const target = join(home, "elsewhere", "huge.jsonl.zst");
    writeFileSync(target, "y".repeat(1000));
    const link = join(home, "archived_sessions_restore.jsonl.zst");
    symlinkSync(target, link);

    expect(() => decompressRolloutZstUtf8ForTests(link, 100)).toThrow("rollout_zst_too_large");
  });
});
