import { createHash } from "node:crypto";

export const DESKTOP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_DESKTOP_UPDATE_FEED =
  "https://update.electronjs.org/Ding-Ding-Projects/opencodex/win32-x64/";

const ALLOWED_FEED_HOSTS = new Set(["github.com", "update.electronjs.org"]);
const STATUS = new Set([
  "current",
  "checking",
  "available",
  "downloading",
  "ready",
  "failed",
  "offline",
  "cancelled",
  "corrupt",
]);

/**
 * Electron's Squirrel updater only accepts a release directory. GitHub's
 * `releases/download/<tag>/` assets provide that directory when the tag is
 * resolved by the release API; keep the host and path fixed so a configuration
 * typo cannot turn the updater into an arbitrary HTTPS fetcher.
 */
export function assertAllowedDesktopFeed(feedUrl) {
  if (typeof feedUrl !== "string" || feedUrl.length === 0 || feedUrl.trim() !== feedUrl || feedUrl.includes("%")) {
    throw new Error("Desktop update feed must be HTTPS allowlisted URL");
  }
  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch {
    throw new Error("Desktop update feed must be HTTPS allowlisted URL");
  }
  const authority = /^https:\/\/([^/?#]+)\//.exec(feedUrl)?.[1] ?? "";
  const rawPath = /^https:\/\/[^/?#]+(\/[^?#]*)$/.exec(feedUrl)?.[1] ?? "";
  const hostname = parsed.hostname.toLowerCase();
  const githubDownloadPath = /^\/Ding-Ding-Projects\/opencodex\/releases\/download\/[^/]+\/$/;
  const electronUpdatePath = /^\/Ding-Ding-Projects\/opencodex\/win32-x64(?:\/[^/]+)?\/?$/;
  const exactShape =
    (hostname === "update.electronjs.org" && electronUpdatePath.test(parsed.pathname)) ||
    (hostname === "github.com" && (
      parsed.pathname === "/Ding-Ding-Projects/opencodex/releases/latest/download/" ||
      githubDownloadPath.test(parsed.pathname)
    ));
  if (
    parsed.protocol !== "https:" ||
    !ALLOWED_FEED_HOSTS.has(hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !authority ||
    authority.includes("@") ||
    authority.includes(":") ||
    !rawPath ||
    parsed.pathname !== rawPath ||
    !exactShape
  ) {
    throw new Error("Desktop update feed must be HTTPS allowlisted URL");
  }
  return parsed.href;
}

/** Parse the compact Squirrel RELEASES index, rejecting malformed records. */
export function parseSquirrelReleases(text) {
  if (typeof text !== "string") throw new Error("Squirrel RELEASES is not text");
  const records = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3 || !/^[a-f0-9]{40}$/i.test(parts[0])) {
      throw new Error("Squirrel RELEASES contains a malformed record");
    }
    const size = Number(parts[1]);
    if (!Number.isSafeInteger(size) || size <= 0 || !/^[^\\/]+\.nupkg$/i.test(parts[2])) {
      throw new Error("Squirrel RELEASES contains a malformed package record");
    }
    records.push({ sha1: parts[0].toLowerCase(), size, filename: parts[2] });
  }
  if (records.length === 0) throw new Error("Squirrel RELEASES is empty");
  return records;
}

/** Independently confirm the package bytes match the Squirrel RELEASES row. */
export async function validateSquirrelPackage(record, bytes) {
  if (!record || !(bytes instanceof Uint8Array)) return { ok: false, reason: "invalid package record or bytes" };
  const actualSize = bytes.byteLength;
  const actualSha1 = createHash("sha1").update(bytes).digest("hex");
  if (actualSize !== record.size) {
    return { ok: false, reason: `Squirrel package size mismatch for ${record.filename}` };
  }
  if (actualSha1 !== record.sha1) {
    return { ok: false, reason: `Squirrel package hash mismatch for ${record.filename}` };
  }
  return { ok: true };
}

function errorStatus(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? error).toLowerCase();
  if (code.includes("HASH") || code.includes("RELEASE") || message.includes("hash") || message.includes("releases")) {
    return "corrupt";
  }
  if (
    code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" ||
    message.includes("offline") || message.includes("network") || message.includes("internet")
  ) return "offline";
  return "failed";
}

function safeReleaseNotes(value) {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adapt Electron's built-in Squirrel updater to a small, testable state machine.
 * Electron owns RELEASES parsing, package download, hash validation, and the
 * replacement transaction. This wrapper adds bounded scheduling, explicit user
 * installation, cancellation, and honest state for the renderer.
 */
export function createDesktopAutoUpdater({
  updater,
  feedUrl = DEFAULT_DESKTOP_UPDATE_FEED,
  packaged = false,
  intervalMs = DESKTOP_UPDATE_INTERVAL_MS,
  onState = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!updater || typeof updater.on !== "function") throw new Error("Electron autoUpdater is required");
  const state = {
    status: "current",
    version: null,
    progress: 0,
    releaseNotesUrl: "https://github.com/Ding-Ding-Projects/opencodex/releases/latest",
    error: null,
  };
  let timer = null;
  let started = false;

  const publish = (patch) => {
    Object.assign(state, patch);
    if (!STATUS.has(state.status)) state.status = "failed";
    onState({ ...state });
  };

  updater.on("checking-for-update", () => publish({ status: "checking", error: null }));
  updater.on("update-available", info => publish({
    status: "available",
    version: typeof info?.version === "string" ? info.version : null,
    progress: 0,
    error: null,
  }));
  updater.on("download-progress", info => publish({
    status: "downloading",
    progress: Math.max(0, Math.min(100, Number(info?.percent) || 0)),
    error: null,
  }));
  updater.on("update-not-available", info => publish({
    status: "current",
    version: typeof info?.version === "string" ? info.version : state.version,
    progress: 0,
    error: null,
  }));
  updater.on("update-downloaded", info => publish({
    status: "ready",
    version: typeof info?.version === "string" ? info.version : state.version,
    progress: 100,
    releaseNotesUrl: safeReleaseNotes(info?.releaseNotes) ?? state.releaseNotesUrl,
    error: null,
  }));
  updater.on("error", error => publish({ status: errorStatus(error), error: String(error?.message ?? error) }));

  const check = async () => {
    if (!packaged) return { ...state };
    const url = assertAllowedDesktopFeed(feedUrl);
    if (state.status === "downloading" || state.status === "ready") return { ...state };
    updater.setFeedURL({ url });
    updater.checkForUpdates();
    return { ...state };
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setIntervalFn(() => check().catch(error => publish({
      status: errorStatus(error),
      error: String(error?.message ?? error),
    })), intervalMs);
  };

  const start = async () => {
    if (!packaged) return { ...state };
    if (started) return { ...state };
    let initialError = null;
    try {
      await check();
      started = true;
    } catch (error) {
      // Keep the retry loop alive even when feed setup or the first check throws.
      // A transient startup failure must not permanently disable manual retry.
      initialError = error;
      started = false;
      publish({ status: errorStatus(error), error: String(error?.message ?? error) });
    }
    schedule();
    if (initialError) throw initialError;
    return { ...state };
  };

  const stop = () => {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    started = false;
  };

  return {
    start,
    check,
    stop,
    snapshot: () => ({ ...state }),
    cancel: () => {
      if (typeof updater.stopDownload === "function") updater.stopDownload();
      publish({ status: "cancelled", error: null });
      return { ...state };
    },
    install: async ({ confirm = async () => true } = {}) => {
      if (state.status !== "ready" || typeof updater.quitAndInstall !== "function") {
        return { ok: false, reason: "update_not_ready" };
      }
      if (!(await confirm())) return { ok: false, reason: "cancelled" };
      // Never call this from startup or a timer: installation/restart is always
      // an explicit user action from the ready banner.
      updater.quitAndInstall(false, true);
      return { ok: true };
    },
  };
}
