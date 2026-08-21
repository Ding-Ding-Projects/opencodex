import { randomUUID, createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { readCodexTokens } from "./auth-collision";
import { decodeJwtPayload, extractAccountId, refreshChatGPTTokenRaw } from "../oauth/chatgpt";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { resolveCodexHomeDir } from "./home";
import { TokenRefreshError } from "./account-store";

export { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

const NATIVE_REFRESH_LOCK_STALE_MS = 60_000;
const NATIVE_REFRESH_LOCK_WAIT_MS = 65_000;
const NATIVE_REFRESH_LOCK_POLL_MS = 50;
const NATIVE_REFRESH_SKEW_MS = 60_000;

type NativeAuthJson = { tokens?: Record<string, unknown>; [key: string]: unknown };
type NativeToken = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId: string;
};
export interface NativeMainRefreshDependencies {
  readonly refreshToken?: typeof refreshChatGPTTokenRaw;
}
const nativeRefreshFlights = new Map<string, Promise<{ accessToken: string; chatgptAccountId: string } | null>>();

/**
 * Main account plan (e.g. "plus", "go", "free", "team"), populated from the WHAM usage
 * fetch. Used by the rotation usage-score so go/free main accounts score on monthly
 * percent, matching pool-account behavior.
 */
let mainAccountPlan: string | null = null;

export function setMainAccountPlan(plan: string | null): void {
  mainAccountPlan = plan;
}

export function getMainAccountPlan(): string | undefined {
  return mainAccountPlan ?? undefined;
}

/** Read-only main account token from ~/.codex/auth.json, or null when not logged in. */
export function getMainAccountToken(): { accessToken: string; chatgptAccountId: string } | null {
  const tokens = readCodexTokens();
  if (!tokens?.access_token) return null;
  return { accessToken: tokens.access_token, chatgptAccountId: tokens.account_id };
}

function nativeAuthPath(): string { return join(resolveCodexHomeDir(), "auth.json"); }
function nativeLockPath(): string { return `${nativeAuthPath()}.refresh.lock`; }

function readNativeAuth(): NativeAuthJson | null {
  try { return JSON.parse(readFileSync(nativeAuthPath(), "utf8")) as NativeAuthJson; } catch { return null; }
}

function nativeToken(auth: NativeAuthJson | null): NativeToken | null {
  const tokens = auth?.tokens;
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
  if (!accessToken) return null;
  const refreshToken = typeof tokens?.refresh_token === "string" && tokens.refresh_token.trim()
    ? tokens.refresh_token.trim() : undefined;
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : undefined;
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: typeof tokens?.account_id === "string" && tokens.account_id
      ? tokens.account_id
      : extractAccountId(idToken, accessToken) ?? "",
  };
}

function nativeTokenFresh(token: NativeToken | null, now = Date.now()): boolean {
  if (!token?.accessToken) return false;
  const exp = decodeJwtPayload(token.accessToken)?.exp;
  return typeof exp !== "number" || exp * 1000 > now + NATIVE_REFRESH_SKEW_MS;
}

function lockIsStale(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { owner?: unknown; pid?: unknown; acquiredAt?: unknown };
    if (typeof parsed.owner !== "string" || typeof parsed.acquiredAt !== "number") return true;
    if (Date.now() - parsed.acquiredAt <= NATIVE_REFRESH_LOCK_STALE_MS) return false;
    if (typeof parsed.pid === "number") {
      try { process.kill(parsed.pid, 0); return false; } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPERM") return false;
      }
    }
    return true;
  } catch { return true; }
}

function readLockOwner(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { owner?: unknown };
    return typeof parsed.owner === "string" && parsed.owner.length > 0 ? parsed.owner : undefined;
  } catch { return undefined; }
}

async function withNativeRefreshLock<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const dir = resolveCodexHomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = nativeLockPath();
  const deadline = Date.now() + NATIVE_REFRESH_LOCK_WAIT_MS;
  const owner = randomUUID();
  let fd: number | undefined;
  while (fd === undefined) {
    if (signal.aborted) throw signal.reason;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ owner, pid: process.pid, acquiredAt: Date.now() }) + "\n");
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error;
      if (lockIsStale(path)) {
        try { unlinkSync(path); } catch (unlinkError) {
          if (!(typeof unlinkError === "object" && unlinkError !== null && "code" in unlinkError && (unlinkError as { code?: unknown }).code === "ENOENT")) throw unlinkError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for native Codex credential refresh lock");
      await new Promise<void>(resolve => setTimeout(resolve, NATIVE_REFRESH_LOCK_POLL_MS));
    }
  }
  try { return await run(); }
  finally {
    closeSync(fd);
    // A successor may acquire the path after this owner closes its descriptor. Re-read
    // the on-disk owner and remove only our own lock; never unlink a successor's lock.
    if (readLockOwner(path) === owner) {
      try { unlinkSync(path); } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
      }
    }
  }
}

/** Test seam for the owner-CAS release contract; production callers use forceRefreshMainAccountToken. */
export async function withNativeRefreshLockForTests(run: () => Promise<void>): Promise<void> {
  const signal = AbortSignal.timeout(30_000);
  await withNativeRefreshLock(signal, run);
}

function persistNativeToken(auth: NativeAuthJson, token: NativeToken, refreshed: { access: string; refresh?: string; accountId?: string; expires: number }): void {
  const tokens = { ...(auth.tokens ?? {}) };
  tokens.access_token = refreshed.access;
  tokens.refresh_token = refreshed.refresh || token.refreshToken;
  if (refreshed.accountId || token.accountId) tokens.account_id = refreshed.accountId ?? token.accountId;
  atomicWriteFile(nativeAuthPath(), JSON.stringify({ ...auth, tokens }, null, 2) + "\n");
}

export async function forceRefreshMainAccountToken(
  rejectedAccessToken?: string,
  options: { signal?: AbortSignal; dependencies?: NativeMainRefreshDependencies } = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  const initial = nativeToken(readNativeAuth());
  if (!initial?.refreshToken) return null;
  const flightKey = createHash("sha256").update(`native-main-refresh:${initial.refreshToken}`).digest("hex");
  const existing = nativeRefreshFlights.get(flightKey);
  if (existing) return existing;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const flight = withNativeRefreshLock(signal, async () => {
    const lockedAuth = readNativeAuth();
    const locked = nativeToken(lockedAuth);
    if (!locked?.refreshToken || !lockedAuth) return null;
    if (rejectedAccessToken && locked.accessToken !== rejectedAccessToken && nativeTokenFresh(locked)) {
      return { accessToken: locked.accessToken, chatgptAccountId: locked.accountId };
    }
    const lockedBytes = readFileSync(nativeAuthPath());
    const refreshed = await (options.dependencies?.refreshToken ?? refreshChatGPTTokenRaw)(locked.refreshToken, { signal });
    // Whole-file external-writer CAS: no field outside the token object may be lost.
    const latestAuth = readNativeAuth();
    const latest = nativeToken(latestAuth);
    let latestBytes: Buffer;
    try { latestBytes = readFileSync(nativeAuthPath()); } catch { latestBytes = Buffer.alloc(0); }
    if (!latestAuth || !latest || !latestBytes.equals(lockedBytes)) {
      if (latest && nativeTokenFresh(latest)) return { accessToken: latest.accessToken, chatgptAccountId: latest.accountId };
      throw new Error("Native Codex credential changed during refresh; retry the request");
    }
    persistNativeToken(lockedAuth, locked, {
      access: refreshed.access,
      refresh: refreshed.refresh,
      accountId: refreshed.accountId,
      expires: refreshed.expires,
    });
    return { accessToken: refreshed.access, chatgptAccountId: refreshed.accountId ?? locked.accountId };
  }).catch(error => {
    if (error instanceof TokenRefreshError) throw error;
    const reason = error instanceof Error && /invalid|revoked/i.test(error.message) ? "revoked" : "unknown";
    throw new TokenRefreshError(reason as "revoked" | "unknown", "Codex main token refresh failed; reauthenticate the main account.");
  });
  nativeRefreshFlights.set(flightKey, flight);
  try { return await flight; } finally { if (nativeRefreshFlights.get(flightKey) === flight) nativeRefreshFlights.delete(flightKey); }
}

export async function getValidMainAccountToken(
  options: { dependencies?: NativeMainRefreshDependencies } = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  const token = nativeToken(readNativeAuth());
  if (!token) return null;
  if (nativeTokenFresh(token)) return { accessToken: token.accessToken, chatgptAccountId: token.accountId };
  return forceRefreshMainAccountToken(token.accessToken, options);
}

/** A refreshable native credential remains selectable even when its access JWT is expired. */
export function isMainAccountCredentialUsable(now = Date.now()): boolean {
  const token = nativeToken(readNativeAuth());
  return nativeTokenFresh(token, now) || !!token?.refreshToken;
}

/**
 * The main token is usable when it exists and — if its JWT carries a decodable `exp` — is
 * not expired. When `exp` cannot be decoded we treat the token as live (best-effort); an
 * actually-invalid token then surfaces via the upstream 401 → cooldown path.
 */
export function isMainAccountTokenLive(now = Date.now()): boolean {
  const tokens = readCodexTokens();
  if (!tokens?.access_token) return false;
  const payload = decodeJwtPayload(tokens.access_token);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp === undefined || exp > now;
}
