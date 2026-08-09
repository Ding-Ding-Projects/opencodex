import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { isProcessAlive } from "./process-control";

export const PROXY_START_LOCK_TIMEOUT_MS = 10_000;
export const PROXY_START_LOCK_STALE_MS = 2_000;

interface ProxyStartLockRecord {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
}

interface ProxyStartLockOwnerEvidence {
  token: string;
  pid: number;
  createdAt: number;
  ownerPath: string;
  bytes: string;
  directoryDevice: number;
  directoryInode: number;
  directoryMtimeMs: number;
  ownerDevice: number;
  ownerInode: number;
  ownerMtimeMs: number;
  ownerSize: number;
}

export interface ProxyStartLock {
  release(): void;
}

export interface ProxyStartLockOptions {
  timeoutMs?: number;
  intervalMs?: number;
  staleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
}

export class ProxyStartLockTimeoutError extends Error {
  constructor() {
    super("Another OpenCodex proxy start is still in progress.");
    this.name = "ProxyStartLockTimeoutError";
  }
}

function lockPath(): string {
  return join(getConfigDir(), "proxy-start.lock");
}

const OWNER_FILENAME_RE = /^([1-9]\d*)-(0|[1-9]\d*)-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$/i;

function parseOwnerFilename(entry: string): Pick<ProxyStartLockOwnerEvidence, "token" | "pid" | "createdAt"> | null {
  const match = OWNER_FILENAME_RE.exec(entry);
  if (!match) return null;
  const pid = Number(match[1]);
  const createdAt = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  return { token: entry.slice(0, -".json".length), pid, createdAt };
}

/**
 * Read evidence that survives a crash between owner-file creation and JSON write.
 * The strict filename contains the owner PID and creation time, so a zero-byte or
 * partially written record can still be reclaimed without guessing ownership.
 */
function readOwnerEvidence(path: string): ProxyStartLockOwnerEvidence | null {
  try {
    const directoryStat = lstatSync(path);
    if (!directoryStat.isDirectory()) return null;
    const entries = readdirSync(path);
    if (entries.length !== 1) return null;
    const filename = parseOwnerFilename(entries[0]);
    if (!filename) return null;
    const ownerPath = join(path, entries[0]);
    const stat = lstatSync(ownerPath);
    if (!stat.isFile() || stat.size > 4_096) return null;
    const bytes = readFileSync(ownerPath, "utf8");
    const confirmedStat = lstatSync(ownerPath);
    if (!confirmedStat.isFile()
      || confirmedStat.size > 4_096
      || confirmedStat.dev !== stat.dev
      || confirmedStat.ino !== stat.ino
      || confirmedStat.size !== stat.size
      || confirmedStat.mtimeMs !== stat.mtimeMs) return null;
    return {
      ...filename,
      ownerPath,
      bytes,
      directoryDevice: directoryStat.dev,
      directoryInode: directoryStat.ino,
      directoryMtimeMs: directoryStat.mtimeMs,
      ownerDevice: stat.dev,
      ownerInode: stat.ino,
      ownerMtimeMs: stat.mtimeMs,
      ownerSize: stat.size,
    };
  } catch {
    return null;
  }
}

function sameOwnerEvidence(left: ProxyStartLockOwnerEvidence, right: ProxyStartLockOwnerEvidence): boolean {
  return left.token === right.token
    && left.pid === right.pid
    && left.createdAt === right.createdAt
    && left.bytes === right.bytes
    && left.directoryDevice === right.directoryDevice
    && left.directoryInode === right.directoryInode
    && left.directoryMtimeMs === right.directoryMtimeMs
    && left.ownerDevice === right.ownerDevice
    && left.ownerInode === right.ownerInode
    && left.ownerMtimeMs === right.ownerMtimeMs
    && left.ownerSize === right.ownerSize;
}

function readOwner(path: string): { record: ProxyStartLockRecord; evidence: ProxyStartLockOwnerEvidence } | null {
  const evidence = readOwnerEvidence(path);
  if (!evidence) return null;
  try {
    const { bytes } = evidence;
    const value = JSON.parse(bytes) as Partial<ProxyStartLockRecord>;
    if (value.version !== 1
      || typeof value.token !== "string" || value.token.length === 0
      || evidence.token !== value.token
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || value.pid !== evidence.pid
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
      || value.createdAt !== evidence.createdAt) return null;
    return { record: value as ProxyStartLockRecord, evidence };
  } catch {
    return null;
  }
}

function reclaimOwnerEvidence(
  path: string,
  observed: ProxyStartLockOwnerEvidence,
  options: Required<Pick<ProxyStartLockOptions, "staleMs" | "now" | "isAlive">>,
): boolean {
  const newestOwnershipTime = Math.max(observed.createdAt, observed.directoryMtimeMs, observed.ownerMtimeMs);
  if (options.now() - newestOwnershipTime <= options.staleMs) return false;
  if (options.isAlive(observed.pid)) return false;
  const current = readOwnerEvidence(path);
  if (!current || !sameOwnerEvidence(observed, current)) return false;
  try {
    // The token is in the owner filename. A successor uses a different path, so this
    // unlink cannot remove its ownership record even if it wins immediately afterward.
    unlinkSync(observed.ownerPath);
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function reclaimStaleLock(path: string, options: Required<Pick<ProxyStartLockOptions, "staleMs" | "now" | "isAlive">>): boolean {
  const observed = readOwner(path);
  if (!observed) {
    // A hard kill after open("wx") but before the JSON write leaves a zero-byte or
    // partial record. Its strictly validated filename is sufficient dead-owner
    // evidence; arbitrary/ambiguous directory contents still fail closed.
    const partialOwner = readOwnerEvidence(path);
    if (partialOwner) return reclaimOwnerEvidence(path, partialOwner, options);
    // Recover only an old EMPTY directory (process died between mkdir and owner write).
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || readdirSync(path).length !== 0 || options.now() - stat.mtimeMs <= options.staleMs) return false;
      rmdirSync(path);
      return true;
    } catch {
      return false;
    }
  }
  const { evidence } = observed;
  const newestOwnershipTime = Math.max(observed.record.createdAt, evidence.directoryMtimeMs, evidence.ownerMtimeMs);
  if (options.now() - newestOwnershipTime <= options.staleMs) return false;
  if (options.isAlive(observed.record.pid)) return false;
  const current = readOwner(path);
  if (!current
    || current.record.token !== observed.record.token
    || !sameOwnerEvidence(evidence, current.evidence)) return false;
  return reclaimOwnerEvidence(path, evidence, options);
}

function tryAcquire(options: ProxyStartLockOptions): ProxyStartLock | null {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = lockPath();
  const now = options.now ?? Date.now;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const createdAt = now();
    const record: ProxyStartLockRecord = {
      version: 1,
      token: `${process.pid}-${createdAt}-${randomUUID()}`,
      pid: process.pid,
      createdAt,
    };
    const ownerPath = join(path, `${record.token}.json`);
    let createdDirectory = false;
    let fd: number | null = null;
    try {
      mkdirSync(path, { mode: 0o700 });
      createdDirectory = true;
      fd = openSync(ownerPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      closeSync(fd);
      fd = null;
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          const current = readOwner(path);
          if (!current || current.record.token !== record.token) return;
          try {
            unlinkSync(ownerPath);
            rmdirSync(path);
          } catch { /* a later start can recover an uncertain lock */ }
        },
      };
    } catch (error) {
      if (fd !== null) try { closeSync(fd); } catch { /* best-effort */ }
      if (createdDirectory) {
        try { unlinkSync(ownerPath); } catch { /* owner may not exist */ }
        try { rmdirSync(path); } catch { /* another owner or uncertain directory */ }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && reclaimStaleLock(path, {
        staleMs: options.staleMs ?? PROXY_START_LOCK_STALE_MS,
        now,
        isAlive: options.isAlive ?? isProcessAlive,
      })) continue;
      return null;
    }
  }
  return null;
}

/** Acquire the cross-process gate spanning the final liveness probe through bind/state write. */
export async function acquireProxyStartLock(options: ProxyStartLockOptions = {}): Promise<ProxyStartLock> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? PROXY_START_LOCK_TIMEOUT_MS);
  const intervalMs = Math.max(1, options.intervalMs ?? 50);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    const acquired = tryAcquire(options);
    if (acquired) return acquired;
    const remaining = deadline - now();
    if (remaining <= 0) throw new ProxyStartLockTimeoutError();
    await sleep(Math.min(intervalMs, remaining));
  }
}
