/**
 * ZIP and 7z, for exports that are more than one file.
 *
 * ## Why ZIP is written here and 7z is not
 *
 * **ZIP is implemented in this file**, on `node:zlib`, so it has no dependency
 * and cannot be unavailable. An export that fails because the machine is missing
 * a tool is an export that fails at the moment somebody needed their data, which
 * is the worst possible moment.
 *
 * **7z is the real 7-Zip**, driven as a subprocess. That is deliberate and it is
 * the only honest way to promise "everything 7z offers": LZMA2 and PPMd, solid
 * blocks, volume splitting and encrypted headers are 7-Zip's format and its
 * implementation, and a hand-rolled subset would be a smaller thing wearing the
 * name. When 7-Zip is not installed, that is said plainly and ZIP is offered —
 * never a silent downgrade, because a user who asked for an encrypted 7z and
 * received a plain ZIP has been told their data is protected when it is not.
 *
 * ## The encryption clause
 *
 * `encryptHeaders` defaults to **true** whenever a password is set. An archive
 * whose contents are encrypted but whose filenames are in the clear still tells
 * anyone who finds it what it holds — `salary-review-2026.pdf` discloses most of
 * itself in its name. 7-Zip can hide those and does not by default, so this
 * inverts that default and `describePlan` says so out loud.
 */

import { spawn } from "node:child_process";
import { deflateRawSync, crc32 } from "node:zlib";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** One file destined for an archive. */
export interface ArchiveEntry {
  /** Relative, `/`-separated. Never absolute and never containing `..`. */
  path: string;
  data: Uint8Array;
}

export type ArchiveKind = "zip" | "7z";

/** 7-Zip's compression methods, as its `-m0=` accepts them. */
export type SevenZipMethod = "LZMA2" | "LZMA" | "PPMd" | "BZip2" | "Deflate" | "Copy";

/** 7-Zip's `-mx` levels. 0 stores without compressing. */
export type SevenZipLevel = 0 | 1 | 3 | 5 | 7 | 9;

export interface SevenZipOptions {
  method?: SevenZipMethod;
  /** `-mx`. 0 store, 1 fastest, 5 normal, 9 ultra. */
  level?: SevenZipLevel;
  /** `-md`, e.g. "64m". Larger finds longer matches and costs memory to *both* sides. */
  dictionarySize?: string;
  /** `-mfb`, 5–273. Higher compresses a little better and slower. */
  wordSize?: number;
  /** `-ms`. `true` for fully solid, `false` for none, or a block size like "4g". */
  solid?: boolean | string;
  /** `-mmt`. `true` for all cores, or a specific count. */
  multithread?: boolean | number;
  /** `-v`, e.g. "100m". Splits into numbered volumes. */
  volumeSize?: string;
  /** `-p`. AES-256 either way; see `encryptHeaders`. */
  password?: string;
  /**
   * `-mhe`. Encrypts the filename table too.
   *
   * Defaults to true when a password is set — 7-Zip's own default is off, and an
   * archive that hides contents but publishes names is a weaker promise than the
   * word "encrypted" makes.
   */
  encryptHeaders?: boolean;
}

// ------------------------------------------------------------------- ZIP

/** Local paths must not escape the extraction directory, and must not be absolute. */
export function assertSafePath(path: string): void {
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    throw new Error(`Unsafe archive path (absolute or backslashed): ${path}`);
  }
  if (path.split("/").some(part => part === "..")) {
    throw new Error(`Unsafe archive path (escapes the archive): ${path}`);
  }
}

/** DOS date/time, which is what ZIP stores. Epoch millis in, packed pair out. */
function dosStamp(at: number): { time: number; date: number } {
  const d = new Date(at);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a ZIP.
 *
 * Deflate, with a stored fallback per entry when deflate would make it bigger —
 * which happens for already-compressed data, and storing it is both smaller and
 * faster to read back.
 *
 * `at` is injected rather than read from the clock so the same input produces the
 * same bytes, which is what lets a test compare archives at all.
 */
export function buildZip(entries: ArchiveEntry[], at = Date.now()): Uint8Array {
  for (const entry of entries) assertSafePath(entry.path);

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const { time, date } = dosStamp(at);

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.path);
    const deflated = deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : new Uint8Array(deflated);
    const method = stored ? 0 : 8;
    const sum = crc32(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0x0800, true);       // UTF-8 filename flag
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, sum, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    chunks.push(new Uint8Array(local.buffer), nameBytes, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);             // version made by
    dir.setUint16(6, 20, true);             // version needed
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, sum, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, entry.data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at2 = 0;
  for (const part of all) { out.set(part, at2); at2 += part.length; }
  return out;
}

// ------------------------------------------------------------------- 7z

/** Where 7-Zip usually is, plus whatever is on PATH. */
const SEVENZIP_CANDIDATES = [
  "7z",
  "7zz",
  "7za",
  join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "7-Zip", "7z.exe"),
  "/usr/bin/7z",
  "/usr/local/bin/7z",
  "/opt/homebrew/bin/7z",
];

/**
 * Resolve a bare command against `PATH`, honouring `PATHEXT` on Windows.
 *
 * Doing this properly matters: an earlier version returned the bare name
 * unchecked on the reasoning that the OS would resolve it at spawn time. It
 * short-circuited on the first candidate every time, so the absolute paths below
 * were never reached — meaning `findSevenZip` claimed success on a machine with
 * no 7-Zip at all, and the failure surfaced as a spawn error at the moment
 * somebody pressed Export.
 */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, command + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** The 7-Zip executable, or null when none is installed. */
export function findSevenZip(
  candidates: string[] = SEVENZIP_CANDIDATES,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
    } else {
      const resolved = resolveOnPath(candidate, env);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * The `7z a` arguments for these options.
 *
 * Split out from the spawn so the flags can be asserted without running
 * anything — the encrypted-header default especially, which is a security
 * promise and deserves a test rather than a code read.
 */
export function sevenZipArgs(target: string, options: SevenZipOptions = {}): string[] {
  const args = ["a", "-t7z", "-y", "-bso0", "-bsp0"];
  const method = options.method ?? "LZMA2";
  args.push(`-m0=${method}`);
  args.push(`-mx=${options.level ?? 5}`);
  if (options.dictionarySize) args.push(`-md=${options.dictionarySize}`);
  if (options.wordSize) args.push(`-mfb=${options.wordSize}`);
  if (options.solid !== undefined) {
    args.push(options.solid === true ? "-ms=on" : options.solid === false ? "-ms=off" : `-ms=${options.solid}`);
  }
  if (options.multithread !== undefined) {
    args.push(options.multithread === true ? "-mmt=on" : options.multithread === false ? "-mmt=off" : `-mmt=${options.multithread}`);
  }
  if (options.volumeSize) args.push(`-v${options.volumeSize}`);
  if (options.password) {
    args.push(`-p${options.password}`);
    // Default ON, not 7-Zip's default OFF. See the file header.
    if (options.encryptHeaders !== false) args.push("-mhe=on");
  }
  args.push(target);
  return args;
}

export interface ArchivePlan {
  kind: ArchiveKind;
  /** Every claim this archive makes, in the words the user should see first. */
  notes: string[];
  /** Set when the requested kind cannot be produced on this machine. */
  blocked?: string;
}

/**
 * What this archive will actually be, said before it is built.
 *
 * The two lines that matter are the encryption ones: whether filenames are
 * hidden, and — when they are not — that they are readable to anyone holding the
 * file. Neither is something a user should have to infer from a flag name.
 */
export function describePlan(kind: ArchiveKind, options: SevenZipOptions = {}, sevenZip = findSevenZip()): ArchivePlan {
  if (kind === "zip") {
    const notes = ["Deflate, with entries stored uncompressed where that is smaller."];
    if (options.password) {
      notes.push("This ZIP is NOT encrypted. Encryption is offered on the 7z path only; choose 7z, or remove the password.");
    }
    return { kind, notes };
  }

  if (!sevenZip) {
    return {
      kind,
      notes: [],
      blocked: "7-Zip is not installed, so a .7z cannot be created here. Install it, or export as ZIP — note that ZIP is not encrypted.",
    };
  }

  const notes = [
    `Method ${options.method ?? "LZMA2"} at level ${options.level ?? 5}${options.level === 0 ? " (stored, no compression)" : ""}.`,
  ];
  if (options.dictionarySize) notes.push(`Dictionary ${options.dictionarySize} — extraction needs comparable memory.`);
  if (options.solid === false) notes.push("Non-solid: each file compresses alone, which is larger but lets one file be extracted without the rest.");
  else if (options.solid) notes.push(`Solid${typeof options.solid === "string" ? ` in ${options.solid} blocks` : ""}: smaller, but reading one file may decompress others.`);
  if (options.volumeSize) notes.push(`Split into ${options.volumeSize} volumes — every part is needed to extract.`);
  if (options.password) {
    notes.push(
      options.encryptHeaders === false
        ? "AES-256 on file CONTENTS ONLY — the file names stay readable to anyone who has the archive."
        : "AES-256 on both contents and the file names.",
    );
  } else {
    notes.push("No password: this archive is not encrypted.");
  }
  return { kind, notes };
}

export interface SevenZipResult {
  ok: boolean;
  /** 7-Zip's own words when it refuses; empty on success. */
  message: string;
}

/**
 * Run 7-Zip over a directory that already holds the files.
 *
 * The password goes in `argv`, which is visible in a process list on most
 * systems — 7-Zip offers no stdin path for it, so the honest options were this
 * or no 7z encryption at all. Callers should treat an export password as
 * single-use rather than a reused secret, and the UI says so.
 */
export function runSevenZip(
  sourceDir: string,
  target: string,
  options: SevenZipOptions = {},
  binary = findSevenZip(),
): Promise<SevenZipResult> {
  if (!binary) {
    return Promise.resolve({ ok: false, message: "7-Zip is not installed on this machine." });
  }
  const args = sevenZipArgs(target, options);
  return new Promise(resolve => {
    const child = spawn(binary, [...args, "."], { cwd: sourceDir, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => resolve({ ok: false, message: error.message }));
    child.on("close", code => {
      resolve(code === 0
        ? { ok: true, message: "" }
        : { ok: false, message: stderr.trim() || `7-Zip exited with code ${code}.` });
    });
  });
}
