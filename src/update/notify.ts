import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile, getConfigDir } from "../config";
import { hasStarPromptRun } from "../cli/star-prompt";
import {
  type Channel,
  currentVersion,
  detectInstall,
  latestVersion,
  runUpdate,
  updateCommandStr,
  updateTag,
} from "./index";
import { OPENCODEX_RELEASE_NOTES_URL } from "./links";
import { terminateInstallerProcessTree } from "./install-process.mjs";

const VERSION_FILENAME = "version.json";
export const VERSION_REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20h, matching codex-rs
/** Retry delay after a null, thrown, timed-out, or otherwise unsuccessful refresh. */
export const VERSION_REFRESH_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const RELEASE_NOTES_URL = OPENCODEX_RELEASE_NOTES_URL;

export interface VersionCache {
  latest_version: string;
  /** ISO-8601 (RFC3339) timestamp of the last successful registry check. */
  last_checked_at: string;
  dismissed_version?: string;
  tag: Channel;
}

function versionFilePath(): string {
  return join(getConfigDir(), VERSION_FILENAME);
}

/**
 * Read the cached version info. Returns null on any error or when the cached
 * channel differs from the current one (so a stable<->preview switch re-fetches
 * instead of comparing across channels).
 */
export function readVersionCache(channel: Channel): VersionCache | null {
  try {
    const raw = readFileSync(versionFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<VersionCache>;
    if (typeof parsed.latest_version !== "string" || typeof parsed.last_checked_at !== "string") return null;
    if (parsed.tag !== channel) return null;
    return {
      latest_version: parsed.latest_version,
      last_checked_at: parsed.last_checked_at,
      dismissed_version: typeof parsed.dismissed_version === "string" ? parsed.dismissed_version : undefined,
      tag: parsed.tag,
    };
  } catch {
    return null;
  }
}

export function writeVersionCache(cache: VersionCache): void {
  try {
    atomicWriteFile(versionFilePath(), `${JSON.stringify(cache)}\n`);
  } catch {
    /* best-effort; never block startup */
  }
}

function parseStable(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function parsePreview(v: string): [number, number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function gt(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

/**
 * Channel-aware "is latest newer than current?".
 * - latest channel: compare maj.min.pat only; prereleases are never "newer"
 *   (parity with codex-rs), so stable users are not pushed onto previews.
 * - preview channel: preview-vs-preview compares the trailing -preview.N; a
 *   stable release with a strictly higher base counts as newer (O3), while a
 *   stable release with the same base as the current preview does not.
 */
export function isNewer(latest: string, current: string, channel: Channel): boolean {
  if (channel === "latest") {
    const l = parseStable(latest);
    const c = parseStable(current);
    if (!l || !c) return false;
    return gt(l, c);
  }
  // preview channel
  const lPre = parsePreview(latest);
  const cPre = parsePreview(current);
  if (lPre && cPre) return gt(lPre, cPre);

  const lStable = parseStable(latest);
  if (lStable && cPre) {
    // Stable release vs current preview: newer only if the base is strictly
    // higher than the preview's base (equal base would be a downgrade nag).
    return gt(lStable, [cPre[0], cPre[1], cPre[2]]);
  }
  const cStable = parseStable(current);
  if (lStable && cStable) return gt(lStable, cStable);
  return false;
}

export function isSourceBuildVersion(v: string): boolean {
  return v.trim() === "0.0.0";
}

/** The interactive/TTY + install-method gate shared with the star prompt. */
function interactiveGuardOk(): boolean {
  return !(process.env.OCX_SERVICE || process.env.OCX_BACKGROUND || !process.stdin.isTTY || !process.stdout.isTTY);
}

/**
 * Decide whether this run should even consider showing the prompt. Returns the
 * channel + current version when eligible, else null. Eligibility requires a
 * real global install, a non-source version, the interactive guard, and that
 * the one-time star prompt has already run (first-run yield, O1).
 */
export function shouldConsider(): { channel: Channel; current: string } | null {
  if (detectInstall() === "source") return null;
  const current = currentVersion();
  if (current === "?" || isSourceBuildVersion(current)) return null;
  if (!interactiveGuardOk()) return null;
  if (!hasStarPromptRun()) return null; // yield on the very first run
  return { channel: updateTag(current), current };
}

/** The cached upgrade version to surface, honoring the user's dismissal. */
export function getUpgradeVersionForPopup(
  cache: VersionCache | null,
  current: string,
  channel: Channel,
): string | null {
  if (!cache) return null;
  if (!isNewer(cache.latest_version, current, channel)) return null;
  if (cache.dismissed_version === cache.latest_version) return null;
  return cache.latest_version;
}

function cacheIsStale(cache: VersionCache | null, now = Date.now()): boolean {
  if (!cache) return true;
  const checked = Date.parse(cache.last_checked_at);
  if (!Number.isFinite(checked)) return true;
  return now - checked >= VERSION_REFRESH_INTERVAL_MS;
}

type RefreshTimer = ReturnType<typeof setTimeout>;
const REFRESH_OPERATION_TIMEOUT_MS = 30_000;

export interface VersionRefreshChild {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  once(event: "close" | "error", listener: (...args: any[]) => void): unknown;
  unref(): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface VersionRefreshScheduleOptions {
  now?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => RefreshTimer;
  clearTimeoutFn?: (timer: RefreshTimer) => void;
  /** Test seam; production runs the actual metadata refresh operation. */
  refreshFn?: (channel: Channel, signal?: AbortSignal) => Promise<void> | void;
  /** Re-read the cache after a refresh settles so the next deadline is data-driven. */
  readCacheFn?: (channel: Channel) => VersionCache | null;
  refreshTimeoutMs?: number;
  /** Production-shaped child seam for deterministic lifecycle tests. */
  spawnRefreshChildFn?: (channel: Channel) => VersionRefreshChild;
  /** Stops only the helper child tree owned by this scheduler flight. */
  stopRefreshChildFn?: (child: VersionRefreshChild) => Promise<boolean>;
}

let scheduledVersionRefresh: {
  channel: Channel;
  timer: RefreshTimer;
  clearTimeoutFn: (timer: RefreshTimer) => void;
  generation: number;
} | null = null;
let versionRefreshFlight: Promise<void> | null = null;
let versionRefreshAbort: AbortController | null = null;
let versionRefreshTimeoutTimer: RefreshTimer | null = null;
let versionRefreshStop: (() => Promise<boolean>) | null = null;
let versionRefreshTreeExited = true;
let refreshGeneration = 0;

function refreshTimeoutMs(options: VersionRefreshScheduleOptions): number {
  return Number.isFinite(options.refreshTimeoutMs) && (options.refreshTimeoutMs ?? 0) > 0
    ? Math.trunc(options.refreshTimeoutMs!)
    : REFRESH_OPERATION_TIMEOUT_MS;
}

async function stopOwnedRefreshChild(child: VersionRefreshChild): Promise<boolean> {
  const closed = new Promise<boolean>(resolve => {
    child.once("close", () => resolve(true));
    child.once("error", () => resolve(true));
  });
  let treeStopped = false;
  if (typeof child.pid === "number" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      treeStopped = await terminateInstallerProcessTree(child.pid, {
        terminationGraceMs: 1_000,
        forceWaitMs: 2_000,
        isOriginalLeader: () => child.exitCode == null && child.signalCode == null,
      });
    } catch {
      treeStopped = false;
    }
  } else {
    try { child.kill("SIGTERM"); } catch { /* best-effort owned-child stop */ }
  }
  if (!treeStopped) {
    try { child.kill("SIGKILL"); } catch { /* best-effort owned-child stop */ }
  }
  const exited = await Promise.race([
    closed,
    new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 2_000);
      timer.unref?.();
    }),
  ]);
  return treeStopped && exited;
}

function runRefreshOperation(
  channel: Channel,
  refreshFn: (channel: Channel, signal?: AbortSignal) => Promise<void> | void,
  timeoutMs: number,
): Promise<void> {
  if (versionRefreshFlight) return versionRefreshFlight;
  const controller = new AbortController();
  versionRefreshAbort = controller;
  let operation: Promise<void>;
  try {
    operation = Promise.resolve(refreshFn(channel, controller.signal));
  } catch {
    // A synchronous resolver failure is still a settled, failed refresh: keep
    // the cache timestamp untouched and let the scheduler choose the next bound.
    operation = Promise.resolve();
  }
  const timeout = new Promise<void>(resolve => {
    versionRefreshTimeoutTimer = setTimeout(() => {
      controller.abort();
      const stop = versionRefreshStop;
      if (!stop) {
        versionRefreshTreeExited = true;
        resolve();
        return;
      }
      void stop().then(() => resolve());
    }, timeoutMs);
    versionRefreshTimeoutTimer.unref?.();
  });
  const settled = Promise.race([operation.then(() => undefined, () => undefined), timeout]);
  versionRefreshFlight = settled;
  void settled.then(() => {
    if (versionRefreshTimeoutTimer) clearTimeout(versionRefreshTimeoutTimer);
    versionRefreshTimeoutTimer = null;
    if (versionRefreshFlight === settled) {
      versionRefreshFlight = null;
      versionRefreshAbort = null;
      versionRefreshStop = null;
    }
  });
  return settled;
}

function cacheForNextDeadline(
  channel: Channel,
  before: VersionCache | null,
  readCacheFn: (channel: Channel) => VersionCache | null,
  now: () => number,
): { cache: VersionCache | null; refreshed: boolean } {
  const after = readCacheFn(channel);
  const beforeMs = before ? Date.parse(before.last_checked_at) : Number.NaN;
  const afterMs = after ? Date.parse(after.last_checked_at) : Number.NaN;
  if (after && Number.isFinite(afterMs) && (!Number.isFinite(beforeMs) || afterMs > beforeMs)) {
    return { cache: after, refreshed: true };
  }
  // A failed or abandoned refresh must remain due for the next process start,
  // but an injected operation that settles without writing a cache still gets
  // one bounded retry interval rather than a zero-delay timer loop.
  return {
    cache: {
      latest_version: after?.latest_version ?? before?.latest_version ?? "0.0.0",
      last_checked_at: new Date(now()).toISOString(),
      ...(after?.dismissed_version ?? before?.dismissed_version
        ? { dismissed_version: after?.dismissed_version ?? before?.dismissed_version }
        : {}),
      tag: channel,
    },
    refreshed: false,
  };
}

/**
 * Start the detached helper and keep the refresh flight open until that helper
 * actually exits. This keeps the foreground service non-blocking while the
 * scheduler still single-flights the real metadata operation, not merely the
 * call to spawn it.
 */
function spawnVersionRefresh(
  channel: Channel,
  signal: AbortSignal | undefined,
  options: VersionRefreshScheduleOptions,
): Promise<void> {
  return new Promise(resolve => {
    const entry = process.argv[1];
    if (!entry || !existsSync(entry) || signal?.aborted) {
      versionRefreshTreeExited = true;
      resolve();
      return;
    }
    let settled = false;
    let child: VersionRefreshChild;
    try {
      child = options.spawnRefreshChildFn?.(channel) ?? spawn(process.execPath, [entry, "__refresh-version", channel], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, OCX_BACKGROUND: "1" }, // never let the helper prompt
      });
    } catch {
      versionRefreshTreeExited = true;
      resolve();
      return;
    }
    let stopPromise: Promise<boolean> | null = null;
    const stop = () => {
      if (stopPromise) return stopPromise;
      stopPromise = (options.stopRefreshChildFn ?? stopOwnedRefreshChild)(child);
      return stopPromise;
    };
    versionRefreshStop = stop;
    const abortHandler = () => {
      void stop().then(treeExited => finish(treeExited));
    };
    const finish = (treeExited = true) => {
      if (settled) return;
      settled = true;
      versionRefreshTreeExited = treeExited;
      signal?.removeEventListener("abort", abortHandler);
      if (versionRefreshStop === stop) versionRefreshStop = null;
      resolve();
    };
    try {
      child.once("close", finish);
      child.once("error", finish);
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
      child.unref();
    } catch {
      finish();
    }
  });
}

/**
 * Schedule at most one metadata refresh. A fresh cache schedules the one
 * refresh at its freshness deadline; a missing/stale cache schedules it
 * immediately. Once the actual operation settles, the cache is re-read and
 * the next deadline is scheduled. The timer is unref'd so a service can shut
 * down normally.
 */
function scheduleVersionRefresh(
  channel: Channel,
  cache: VersionCache | null,
  options: VersionRefreshScheduleOptions = {},
  delayOverrideMs?: number,
): void {
  if (scheduledVersionRefresh) {
    if (scheduledVersionRefresh.channel === channel) return;
    const previous = scheduledVersionRefresh;
    scheduledVersionRefresh = null;
    refreshGeneration += 1;
    previous.clearTimeoutFn(previous.timer);
  }
  if (versionRefreshFlight) return;
  const now = options.now ?? Date.now;
  const checked = cache ? Date.parse(cache.last_checked_at) : Number.NaN;
  const dueAt = Number.isFinite(checked) ? checked + VERSION_REFRESH_INTERVAL_MS : now();
  const delayMs = delayOverrideMs == null ? Math.max(0, dueAt - now()) : Math.max(0, delayOverrideMs);
  const generation = refreshGeneration;
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((timer: RefreshTimer) => clearTimeout(timer));
  const refreshFn = options.refreshFn ?? ((tag: Channel, signal?: AbortSignal) => (
    spawnVersionRefresh(tag, signal, options)
  ));
  const readCacheFn = options.readCacheFn ?? readVersionCache;
  const timer = setTimeoutFn(() => {
    if (generation !== refreshGeneration) return;
    scheduledVersionRefresh = null;
    const before = readCacheFn(channel);
    const settled = runRefreshOperation(channel, refreshFn, refreshTimeoutMs(options));
    void settled.then(() => {
      if (refreshGeneration !== generation) return;
      if (!versionRefreshTreeExited) return;
      const next = cacheForNextDeadline(channel, before, readCacheFn, now);
      scheduleVersionRefresh(
        channel,
        next.cache,
        options,
        next.refreshed ? undefined : VERSION_REFRESH_RETRY_INTERVAL_MS,
      );
    });
  }, delayMs);
  timer.unref?.();
  scheduledVersionRefresh = { channel, timer, clearTimeoutFn, generation };
}

export function scheduleVersionRefreshIfStale(
  channel: Channel,
  cache: VersionCache | null,
  options: VersionRefreshScheduleOptions = {},
): void {
  scheduleVersionRefresh(channel, cache, options);
}

/** Cancel the one pending refresh timer during process shutdown or test teardown. */
export function cancelVersionRefreshSchedule(): Promise<void> {
  refreshGeneration += 1;
  const stop = versionRefreshStop;
  versionRefreshAbort?.abort();
  versionRefreshAbort = null;
  const stopping = stop
    ? stop().then(treeExited => { versionRefreshTreeExited = treeExited; })
    : Promise.resolve();
  if (versionRefreshTimeoutTimer) clearTimeout(versionRefreshTimeoutTimer);
  versionRefreshTimeoutTimer = null;
  if (!stop) versionRefreshFlight = null;
  if (scheduledVersionRefresh) {
    const { timer, clearTimeoutFn } = scheduledVersionRefresh;
    scheduledVersionRefresh = null;
    clearTimeoutFn(timer);
  }
  return stopping;
}

process.once("exit", cancelVersionRefreshSchedule);

/**
 * If the cache is missing or older than 20h, kick off a detached helper to
 * refresh it without blocking this (soon-to-be daemon) process. Fire-and-forget.
 */
export function triggerBackgroundRefreshIfStale(channel: Channel, cache: VersionCache | null): void {
  if (!cacheIsStale(cache)) return;
  scheduleVersionRefreshIfStale(channel, cache);
}

/**
 * Body of the hidden `__refresh-version` subcommand: fetch the latest version
 * for the channel and persist it. Only advances `last_checked_at` on success so
 * a failed fetch retries on the next start.
 */
async function performVersionRefresh(
  channel: Channel,
  resolveLatest: (tag: Channel) => string | null = latestVersion,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  const latest = resolveLatest(channel);
  if (!latest) return; // do not dirty the cache or advance the timestamp
  const prev = readVersionCache(channel);
  writeVersionCache({
    latest_version: latest,
    last_checked_at: now(),
    dismissed_version: prev?.dismissed_version,
    tag: channel,
  });
}

export function refreshVersionCache(
  channel: Channel,
  resolveLatest: (tag: Channel) => string | null = latestVersion,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  return runRefreshOperation(
    channel,
    () => performVersionRefresh(channel, resolveLatest, now),
    REFRESH_OPERATION_TIMEOUT_MS,
  );
}

/** Persist a dismissal so this exact version stops prompting. */
function dismissVersion(channel: Channel, version: string): void {
  const cache = readVersionCache(channel);
  if (!cache) return;
  writeVersionCache({ ...cache, dismissed_version: version });
}

function renderPrompt(current: string, latest: string, channel: Channel): string {
  const command = updateCommandStr(detectInstall(), channel);
  return [
    "",
    `  \x1b[38;5;141m✨ Update available!\x1b[0m  \x1b[2m${current} -> ${latest}\x1b[0m`,
    "",
    `  \x1b[2mRelease notes:\x1b[0m ${RELEASE_NOTES_URL}`,
    "",
    `  1) Update now (runs \`${command}\`)`,
    "  2) Skip",
    "  3) Skip until next version",
    "",
    "  [1/2/3] (default 1): ",
  ].join("\n");
}

/**
 * Interactive-only update prompt for `ocx start`. Must be called BEFORE the
 * server binds a port / writes a PID, because "Update now" installs globally
 * and exits. No-op for service/daemon/non-TTY runs and source checkouts.
 * Never throws.
 */
export async function maybeShowUpdatePrompt(): Promise<void> {
  try {
    // Schedule before the interactive guard so service/background starts also
    // refresh metadata at most once without ever opening a prompt.
    const currentForSchedule = currentVersion();
    if (detectInstall() !== "source" && currentForSchedule !== "?" && !isSourceBuildVersion(currentForSchedule)) {
      const channel = updateTag(currentForSchedule);
      scheduleVersionRefreshIfStale(channel, readVersionCache(channel));
    }
    const eligible = shouldConsider();
    if (!eligible) return;
    const { channel, current } = eligible;

    const cache = readVersionCache(channel);
    const latest = getUpgradeVersionForPopup(cache, current, channel);
    if (!latest) return;

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer = "";
    try {
      answer = (await rl.question(renderPrompt(current, latest, channel))).trim();
    } finally {
      rl.close();
    }

    const choice = answer === "" ? "1" : answer;
    if (choice === "1") {
      await runUpdate();
      console.log("\nRestart the proxy:  ocx start");
      process.exit(0);
    } else if (choice === "3") {
      dismissVersion(channel, latest);
    }
    // "2" (or anything else) -> Skip: continue this run unchanged.
  } catch {
    /* never let the update prompt disrupt startup */
  }
}
