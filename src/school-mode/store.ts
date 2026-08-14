/**
 * The School Mode record: read, write, hash/verify the unlock credential, and
 * watch the shared file for changes made by *any* process — this app's own
 * other window, its CLI, or a completely different conforming app.
 *
 * ## Fail-closed reading, not fail-off reading
 *
 * A missing file is the ordinary "nobody has ever turned this on" state and
 * reads as `enabled: false` with no credential. That is different from a file
 * that exists but cannot be trusted — wrong permissions, truncated by a crash
 * mid-write, or written by a future schema version this build does not
 * understand. Those report `readable: false` and keep serving the last
 * in-memory snapshot this process actually saw, rather than silently
 * collapsing to "off": per the contract, a control that cannot read or watch
 * the shared record has to *say so*, not quietly behave as though the mode
 * were disabled. Collapsing to "off" on a read failure would be exactly the
 * wrong direction for a feature whose entire point is that it cannot be
 * bypassed by an app that merely stops looking.
 *
 * ## The credential is never stored in the clear
 *
 * `hashCredential`/`verifyCredential` use scrypt with a random per-record
 * salt. The record itself only ever holds `{ algorithm, saltB64, hashB64 }` —
 * never the PIN/password text. This is a toy lock, not a security boundary
 * (the contract says so explicitly), but "not a security boundary" describes
 * what the feature is *for*, not a license to write the plaintext to disk.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { schoolModeDir, schoolModeRecordPath } from "./paths";
// Re-exported for every existing caller of this module — the bounds and
// validators moved to `./contract` so the GUI can import the exact same
// ones, but `store.ts` stays the one place the server imports them from.
export {
  SCHOOL_MODE_MAX_NAME_LENGTH,
  SCHOOL_MODE_MAX_SECRET_LENGTH,
  SCHOOL_MODE_MIN_SECRET_LENGTH,
  SCHOOL_MODE_SCHEMA_VERSION,
  validateSchoolModeName,
  validateSchoolModeSecret,
  type SchoolModeSecretValidation,
} from "./contract";
import {
  SCHOOL_MODE_MAX_NAME_LENGTH,
  SCHOOL_MODE_MAX_SECRET_LENGTH,
  SCHOOL_MODE_MIN_SECRET_LENGTH,
  SCHOOL_MODE_SCHEMA_VERSION,
} from "./contract";

export interface SchoolModeCredential {
  readonly algorithm: "scrypt";
  readonly saltB64: string;
  readonly hashB64: string;
}

export interface SchoolModeRecord {
  readonly version: 1;
  readonly enabled: boolean;
  /** `null` means the shipped "School mode" name; non-null is the user's chosen name. */
  readonly customName: string | null;
  readonly credential: SchoolModeCredential | null;
  readonly updatedAt: number;
}

export const DEFAULT_SCHOOL_MODE_RECORD: SchoolModeRecord = {
  version: SCHOOL_MODE_SCHEMA_VERSION,
  enabled: false,
  customName: null,
  credential: null,
  updatedAt: 0,
};

const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function isCredentialShape(value: unknown): value is SchoolModeCredential {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.algorithm === "scrypt" && typeof v.saltB64 === "string" && typeof v.hashB64 === "string"
    && v.saltB64.length > 0 && v.hashB64.length > 0;
}

/** Structural validation only — never throws, so a corrupt file is a rejection, not a crash. */
export function parseSchoolModeRecord(raw: unknown): SchoolModeRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.version !== SCHOOL_MODE_SCHEMA_VERSION) return null;
  if (typeof v.enabled !== "boolean") return null;
  if (v.customName !== null && typeof v.customName !== "string") return null;
  if (typeof v.customName === "string" && v.customName.length > SCHOOL_MODE_MAX_NAME_LENGTH) return null;
  if (v.credential !== null && !isCredentialShape(v.credential)) return null;
  if (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt)) return null;
  return {
    version: SCHOOL_MODE_SCHEMA_VERSION,
    enabled: v.enabled,
    customName: (v.customName as string | null) ?? null,
    credential: (v.credential as SchoolModeCredential | null) ?? null,
    updatedAt: v.updatedAt,
  };
}

export interface SchoolModeReadResult {
  readonly record: SchoolModeRecord;
  /** False when the file exists but could not be trusted (I/O error, corrupt JSON, bad schema). */
  readonly readable: boolean;
  readonly error?: string;
}

/** The last record this process actually managed to read — served back on a read failure instead of a silent "off". */
let lastKnownGood: SchoolModeRecord = DEFAULT_SCHOOL_MODE_RECORD;

/** Test-only: reset the in-memory fallback between cases. */
export function resetSchoolModeStoreForTests(): void {
  lastKnownGood = DEFAULT_SCHOOL_MODE_RECORD;
}

export function readSchoolModeRecord(recordPath: string = schoolModeRecordPath()): SchoolModeReadResult {
  let raw: string;
  try {
    raw = readFileSync(recordPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      // The ordinary "never turned on" state — not a failure.
      lastKnownGood = DEFAULT_SCHOOL_MODE_RECORD;
      return { record: DEFAULT_SCHOOL_MODE_RECORD, readable: true };
    }
    return {
      record: lastKnownGood,
      readable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return {
      record: lastKnownGood,
      readable: false,
      error: `School Mode record is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const record = parseSchoolModeRecord(parsedJson);
  if (!record) {
    return { record: lastKnownGood, readable: false, error: "School Mode record does not match the schema this build understands" };
  }
  lastKnownGood = record;
  return { record, readable: true };
}

/**
 * Atomic write: temp file in the same directory, then rename over the
 * destination, so a reader (this process's own watcher, another app, a crash
 * mid-write) never observes a half-written record.
 */
export function writeSchoolModeRecordAtomic(record: SchoolModeRecord, recordPath: string = schoolModeRecordPath()): void {
  const dir = dirname(recordPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  hardenSecretDir(dir, { required: false });
  const tmp = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* platform may ignore chmod */ }
  hardenSecretPath(tmp, { required: false });
  renameSync(tmp, recordPath);
  hardenSecretPath(recordPath, { required: false });
  lastKnownGood = record;
}

export function hashCredential(secret: string): SchoolModeCredential {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return { algorithm: "scrypt", saltB64: salt.toString("base64"), hashB64: hash.toString("base64") };
}

/** Timing-safe: never short-circuits on the first mismatched byte. */
export function verifyCredential(secret: string, credential: SchoolModeCredential): boolean {
  try {
    const salt = Buffer.from(credential.saltB64, "base64");
    const expected = Buffer.from(credential.hashB64, "base64");
    const actual = scryptSync(secret, salt, expected.length, SCRYPT_OPTIONS);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * Watching — the server-side half of "live, not on restart".
 *
 * `fs.watch` on the *directory* rather than the file: an atomic write is a
 * rename over the destination, which on most platforms invalidates a watch
 * held on the old inode/handle rather than firing a change event through it.
 * Watching the directory and filtering by filename survives that.
 * ------------------------------------------------------------------------- */

export interface SchoolModeWatchHandle {
  readonly watchable: boolean;
  readonly error?: string;
  stop(): void;
}

const WATCH_DEBOUNCE_MS = 50;

/**
 * Watch the shared record for changes made by any process. `onChange` is
 * called with the freshly read result after a short debounce (a rename is
 * often two filesystem events in quick succession).
 *
 * Returns synchronously with `watchable: false` and a reason when the
 * directory cannot be created or `fs.watch` itself refuses (unsupported
 * filesystem, permissions) — the caller (the management route) surfaces that
 * on the control rather than pretending the record is being watched.
 */
export function watchSchoolModeRecord(
  onChange: (result: SchoolModeReadResult) => void,
  recordPath: string = schoolModeRecordPath(),
): SchoolModeWatchHandle {
  const dir = dirname(recordPath);
  const fileName = recordPath.slice(dir.length + 1);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      watchable: false,
      error: `could not create the School Mode directory: ${error instanceof Error ? error.message : String(error)}`,
      stop: () => {},
    };
  }

  let watcher: FSWatcher;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const fire = (): void => {
    if (stopped) return;
    onChange(readSchoolModeRecord(recordPath));
  };

  try {
    watcher = watch(dir, { persistent: false }, (_eventType, changedName) => {
      if (changedName && changedName !== fileName) return;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fire, WATCH_DEBOUNCE_MS);
    });
  } catch (error) {
    return {
      watchable: false,
      error: `could not watch the School Mode directory: ${error instanceof Error ? error.message : String(error)}`,
      stop: () => {},
    };
  }

  watcher.on("error", () => { /* a watch error leaves the last-known-good state in place; polling GET still works */ });

  return {
    watchable: true,
    stop: () => {
      stopped = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      try { watcher.close(); } catch { /* already closed */ }
    },
  };
}

/** So a caller can check "does this record even exist yet" before deciding whether reset-by-deletion applies. */
export function schoolModeRecordExists(recordPath: string = schoolModeRecordPath()): boolean {
  return existsSync(recordPath);
}

/** Delete the shared record — the same recovery a user could do by hand from a file manager. Exposed for tests/CLI parity; the GUI documents the path rather than offering a button, per the toy-lock contract. */
export function deleteSchoolModeRecord(recordPath: string = schoolModeRecordPath()): void {
  try {
    unlinkSync(recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  lastKnownGood = DEFAULT_SCHOOL_MODE_RECORD;
}

export { schoolModeDir, schoolModeRecordPath };
