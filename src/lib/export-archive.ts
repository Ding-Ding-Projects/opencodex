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
 * ## Encryption is deliberately unavailable for now
 *
 * 7-Zip accepts a password only as a command-line argument. That exposes it to
 * process inspection on common operating systems. Until a protected input path
 * exists, password-bearing requests are rejected before a child is spawned.
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
  /** Reserved for a future protected input path; non-empty values are refused. */
  password?: string;
  /** Reserved alongside `password`; requesting encrypted headers is refused. */
  encryptHeaders?: boolean;
}

const SEVEN_ZIP_METHODS = new Set<SevenZipMethod>(["LZMA2", "LZMA", "PPMd", "BZip2", "Deflate", "Copy"]);
const SEVEN_ZIP_LEVELS = new Set<SevenZipLevel>([0, 1, 3, 5, 7, 9]);
const SEVEN_ZIP_OPTION_KEYS = new Set<keyof SevenZipOptions>([
  "method", "level", "dictionarySize", "wordSize", "solid", "multithread",
  "volumeSize", "password", "encryptHeaders",
]);

export type SevenZipOptionsParseResult =
  | { ok: true; options: SevenZipOptions }
  | { ok: false; error: string };

export const SEVEN_ZIP_ENCRYPTION_UNAVAILABLE_REASON =
  "encrypted 7z export is disabled because 7-Zip exposes passwords in process arguments; it will remain unavailable until a protected password-input channel exists";

function boundedSizeError(value: string, field: string, maxBytes: number): string | null {
  const match = /^([1-9]\d{0,5})([kmg])$/i.exec(value);
  if (!match) return `${field} must be a positive size such as 64m`;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : 1024 ** 3;
  if (amount * multiplier > maxBytes) return `${field} is larger than the supported safety limit`;
  return null;
}

/** Validate and normalize every caller-controlled 7-Zip option before spawn. */
export function parseSevenZipOptions(value: unknown): SevenZipOptionsParseResult {
  if (value === undefined) return { ok: true, options: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "sevenZip must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(key => !SEVEN_ZIP_OPTION_KEYS.has(key as keyof SevenZipOptions));
  if (unknown.length) return { ok: false, error: `unknown sevenZip option(s): ${unknown.join(", ")}` };

  const options: SevenZipOptions = {};
  if (raw.method !== undefined) {
    if (typeof raw.method !== "string" || !SEVEN_ZIP_METHODS.has(raw.method as SevenZipMethod)) {
      return { ok: false, error: "sevenZip.method is not supported" };
    }
    options.method = raw.method as SevenZipMethod;
  }
  if (raw.level !== undefined) {
    if (typeof raw.level !== "number" || !SEVEN_ZIP_LEVELS.has(raw.level as SevenZipLevel)) {
      return { ok: false, error: "sevenZip.level must be one of 0, 1, 3, 5, 7, or 9" };
    }
    options.level = raw.level as SevenZipLevel;
  }
  if (raw.dictionarySize !== undefined) {
    if (typeof raw.dictionarySize !== "string") return { ok: false, error: "sevenZip.dictionarySize must be a string" };
    const error = boundedSizeError(raw.dictionarySize, "sevenZip.dictionarySize", 256 * 1024 ** 2);
    if (error) return { ok: false, error };
    options.dictionarySize = raw.dictionarySize.toLowerCase();
  }
  if (raw.wordSize !== undefined) {
    if (typeof raw.wordSize !== "number" || !Number.isInteger(raw.wordSize) || raw.wordSize < 5 || raw.wordSize > 273) {
      return { ok: false, error: "sevenZip.wordSize must be an integer from 5 through 273" };
    }
    options.wordSize = raw.wordSize;
  }
  if (raw.solid !== undefined) {
    if (typeof raw.solid === "boolean") options.solid = raw.solid;
    else if (typeof raw.solid === "string") {
      const error = boundedSizeError(raw.solid, "sevenZip.solid", 64 * 1024 ** 3);
      if (error) return { ok: false, error };
      options.solid = raw.solid.toLowerCase();
    } else return { ok: false, error: "sevenZip.solid must be a boolean or bounded size" };
  }
  if (raw.multithread !== undefined) {
    if (typeof raw.multithread === "boolean") options.multithread = raw.multithread;
    else if (
      typeof raw.multithread === "number"
      && Number.isInteger(raw.multithread)
      && raw.multithread >= 1
      && raw.multithread <= 32
    ) options.multithread = raw.multithread;
    else return { ok: false, error: "sevenZip.multithread must be a boolean or an integer from 1 through 32" };
  }
  if (raw.volumeSize !== undefined) {
    if (typeof raw.volumeSize !== "string") return { ok: false, error: "sevenZip.volumeSize must be a string" };
    if (raw.volumeSize.trim()) {
      return { ok: false, error: "split-volume 7z exports are not supported by the single-file download endpoint" };
    }
  }
  if (raw.password !== undefined) {
    if (typeof raw.password !== "string") return { ok: false, error: "sevenZip.password must be a string" };
    if (raw.password.length > 0) return { ok: false, error: SEVEN_ZIP_ENCRYPTION_UNAVAILABLE_REASON };
  }
  if (raw.encryptHeaders !== undefined) {
    if (typeof raw.encryptHeaders !== "boolean") return { ok: false, error: "sevenZip.encryptHeaders must be a boolean" };
    if (raw.encryptHeaders) return { ok: false, error: SEVEN_ZIP_ENCRYPTION_UNAVAILABLE_REASON };
    options.encryptHeaders = false;
  }
  return { ok: true, options };
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
 * anything, including proving rejected options never become child arguments.
 */
export function sevenZipArgs(target: string, options: SevenZipOptions = {}): string[] {
  const parsed = parseSevenZipOptions(options);
  if (!parsed.ok) throw new Error(parsed.error);
  options = parsed.options;
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
 * Encryption requests are rejected during option parsing. The remaining plan
 * states plainly that an accepted archive is unencrypted.
 */
export function describePlan(kind: ArchiveKind, options: SevenZipOptions = {}, sevenZip = findSevenZip()): ArchivePlan {
  const parsed = parseSevenZipOptions(options);
  if (!parsed.ok) return { kind, notes: [], blocked: parsed.error };
  options = parsed.options;
  if (kind === "zip") {
    const notes = ["Deflate, with entries stored uncompressed where that is smaller."];
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
  notes.push("No password: this archive is not encrypted.");
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
 * Password-bearing and malformed options are refused before spawn. 7-Zip has no
 * protected password-input path, so allowing its `-p...` argv form would expose
 * a user secret to process inspection.
 */
export function runSevenZip(
  sourceDir: string,
  target: string,
  options: SevenZipOptions = {},
  binary = findSevenZip(),
): Promise<SevenZipResult> {
  const parsed = parseSevenZipOptions(options);
  if (!parsed.ok) return Promise.resolve({ ok: false, message: parsed.error });
  if (!binary) {
    return Promise.resolve({ ok: false, message: "7-Zip is not installed on this machine." });
  }
  const args = sevenZipArgs(target, parsed.options);
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
