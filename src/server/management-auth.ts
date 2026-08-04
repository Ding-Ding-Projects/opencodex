import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { adminApiTokenFilePath } from "../lib/admin-secrets";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import type { OcxConfig } from "../types";
import {
  isAllowedManagementOrigin,
  isApiAuthRequired,
  isDataPlaneAdmissionSecret,
  isLoopbackHostname,
  managementRequestOrigin,
  parseHttpHost,
} from "./auth-cors";

const GUI_SESSION_LIMIT = 128;

/**
 * GUI sessions do not expire on a clock.
 *
 * They used to carry a fixed five-minute `expiresAt` that nothing ever extended,
 * so an open dashboard started answering 401 to every `/api/*` call five minutes
 * after it loaded and stayed that way — the session token arrives in the page's
 * HTML, so only a full reload could mint another one. What made it read as a
 * random fault rather than a timer was that nobody watches an idle panel for
 * five minutes: you would tab away, come back, and find the banner already up.
 *
 * The lifetime is now the process. That is the honest bound anyway — the map is
 * in-memory, so every session dies when the proxy stops, and the credential was
 * never persisted anywhere a restart could recover it. The security properties
 * that actually do the work are unchanged: a session is only ever minted for a
 * same-origin loopback page, it stays bound to the exact protocol/host/port it
 * was issued to, and state-changing requests still need its CSRF token.
 */
interface GuiSessionRecord {
  csrfToken: string;
  origin: string;
}

export interface GuiSessionBootstrap extends GuiSessionRecord {
  token: string;
}

export type ManagementAuthState =
  | {
    available: true;
    token: string;
    source: "environment" | "file";
    sessions: Map<string, GuiSessionRecord>;
  }
  | { available: false; reason: string };

function fail(reason: string): ManagementAuthState {
  return { available: false, reason };
}

function assertSafeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("management token directory is not a regular directory");
  chmodSync(path, 0o700);
  const hardened = hardenSecretDir(path, { required: true });
  if (!hardened.ok) throw new Error("management token directory ACL hardening did not complete");
}

function readExistingToken(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) {
    throw new Error("management token path is not a regular secret file");
  }
  chmodSync(path, 0o600);
  const hardened = hardenSecretPath(path, { required: true });
  if (!hardened.ok) throw new Error("management token file ACL hardening did not complete");
  const token = readFileSync(path, "utf8").trim();
  if (!/^ocx_admin_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("management token file is invalid");
  return token;
}

function removeBestEffort(path: string): void {
  try { unlinkSync(path); } catch { /* fail-closed state is preserved by the caller */ }
}

function createTokenFile(path: string): string {
  const directory = dirname(path);
  const token = `ocx_admin_${randomBytes(32).toString("base64url")}`;
  const temporary = join(directory, `.${randomUUID()}.admin-token.tmp`);
  let linked = false;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${token}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o600);
    const temporaryHardened = hardenSecretPath(temporary, { required: true });
    if (!temporaryHardened.ok) throw new Error("management token temporary ACL hardening did not complete");
    try {
      linkSync(temporary, path);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readExistingToken(path);
      throw error;
    }
    const finalHardened = hardenSecretPath(path, { required: true });
    if (!finalHardened.ok) throw new Error("management token file ACL hardening did not complete");
    return token;
  } catch (error) {
    if (linked) removeBestEffort(path);
    throw error;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    removeBestEffort(temporary);
  }
}

function ready(token: string, source: "environment" | "file", config: OcxConfig): ManagementAuthState {
  if (isDataPlaneAdmissionSecret(token, config)) {
    return fail("management credential conflicts with a data-plane credential");
  }
  return { available: true, token, source, sessions: new Map() };
}

export function initializeManagementAuthState(config: OcxConfig): ManagementAuthState {
  const environmentToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
  if (environmentToken) {
    return ready(environmentToken, "environment", config);
  }
  try {
    const path = adminApiTokenFilePath();
    assertSafeDirectory(dirname(path));
    let token: string;
    try {
      token = readExistingToken(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      token = createTokenFile(path);
    }
    return ready(token, "file", config);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "management token initialization failed");
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Move a session to the end of the map so the `GUI_SESSION_LIMIT` eviction below
 * drops the least *recently used* rather than the least recently issued.
 *
 * Without this the cap quietly becomes the expiry it replaced: a dashboard left
 * open while 128 other pages load would have its still-in-use session evicted
 * purely for being old, which is the same 401 by another route. `Map` iterates
 * in insertion order, so re-inserting on each successful validation is the whole
 * of the LRU.
 */
function touchSession(
  state: Extract<ManagementAuthState, { available: true }>,
  token: string,
  session: GuiSessionRecord,
): void {
  state.sessions.delete(token);
  state.sessions.set(token, session);
}

function randomSessionSecret(prefix: "ocx_session_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function issueGuiSession(
  req: Request,
  config: OcxConfig,
  state: ManagementAuthState,
): GuiSessionBootstrap | null {
  if (isApiAuthRequired(config) || !state.available || req.method !== "GET" || !isAllowedManagementOrigin(req, config)) return null;
  const host = parseHttpHost(req.headers.get("Host"));
  if (!host || !isLoopbackHostname(host.hostname)) return null;
  const origin = managementRequestOrigin(req, config);
  if (!origin) return null;
  while (state.sessions.size >= GUI_SESSION_LIMIT) {
    const leastRecentlyUsed = state.sessions.keys().next().value as string | undefined;
    if (!leastRecentlyUsed) break;
    state.sessions.delete(leastRecentlyUsed);
  }
  const token = randomSessionSecret("ocx_session_");
  const session: GuiSessionRecord = {
    csrfToken: randomBytes(32).toString("base64url"),
    origin,
  };
  state.sessions.set(token, session);
  return { token, ...session };
}

export function requireManagementAuth(
  req: Request,
  state: ManagementAuthState,
  config?: OcxConfig,
): Response | null {
  if (!state.available) {
    return Response.json({ error: "management API unavailable" }, { status: 503 });
  }
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (actual && equalSecret(actual, state.token)) return null;
  if (actual && config) {
    const session = state.sessions.get(actual);
    if (session) {
      const requestOrigin = managementRequestOrigin(req, config);
      const claimedOrigin = req.headers.get("x-opencodex-gui-origin");
      const browserOrigin = req.headers.get("Origin");
      const sameOrigin = requestOrigin === session.origin
        && claimedOrigin === session.origin
        && (!browserOrigin || browserOrigin === session.origin);
      const safeMethod = req.method === "GET" || req.method === "HEAD";
      const csrf = req.headers.get("x-opencodex-csrf-token")?.trim();
      if (sameOrigin && (safeMethod || (browserOrigin === session.origin && !!csrf && equalSecret(csrf, session.csrfToken)))) {
        touchSession(state, actual, session);
        return null;
      }
    }
  }
  return Response.json({ error: "opencodex admin token required" }, { status: 401 });
}
