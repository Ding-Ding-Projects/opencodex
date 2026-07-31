import { M3_EN, M3_OVERRIDES } from "./i18n/m3";
import { detectInitial } from "./i18n/shared";

let installed = false;
/** Shared 401 refresh gate — concurrent waiters join one prompt / token resolution. */
let promptInFlight: Promise<string | null> | null = null;
/**
 * After the user cancels (or submits blank) once, suppress further prompts for this page
 * lifetime so a staggered 401 fan-out does not reopen the dialog N times (#647 / Codex).
 * A full reload clears module state and allows prompting again.
 */
let promptCancelled = false;

function needsApiAuth(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    // Absolute cross-origin URLs must never get the local API token or 401 prompt.
    if (url.origin !== window.location.origin) return false;
    return url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Legacy sessionStorage key from pre-memory auth — wiped once on install, never read. */
const LEGACY_TOKEN_KEY = "opencodex-api-token";

/** In-memory only — never write tokens to web storage (XSS can read sessionStorage/localStorage). */
let memoryToken: string | null = null;
let memoryCsrfToken: string | null = null;
let memorySessionOrigin: string | null = null;

function readToken(): string | null {
  return memoryToken;
}

function storeToken(token: string): void {
  memoryToken = token;
}

function clearToken(): void {
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
}

function takeMetaContent(name: string): string | null {
  const element = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  const content = element?.content.trim() || null;
  element?.remove();
  return content;
}

function loadInjectedSession(): void {
  const token = takeMetaContent("opencodex-session-token");
  const csrfToken = takeMetaContent("opencodex-session-csrf");
  const origin = takeMetaContent("opencodex-session-origin");
  if (!token?.startsWith("ocx_session_") || !csrfToken || origin !== window.location.origin) return;
  memoryToken = token;
  memoryCsrfToken = csrfToken;
  memorySessionOrigin = origin;
}

/** Clear memory only when it still holds `expected` (avoid wiping a newer concurrent store). */
function clearTokenIfCurrent(expected: string | null): void {
  if (expected != null && readToken() === expected) clearToken();
}

function clearLegacySessionToken(): void {
  try {
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* session storage may be disabled */
  }
}

function withToken(input: RequestInfo | URL, init: RequestInit | undefined, token: string): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("X-OpenCodex-API-Key", token);
  if (memorySessionOrigin && memoryCsrfToken && token.startsWith("ocx_session_")) {
    headers.set("X-OpenCodex-GUI-Origin", memorySessionOrigin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      headers.set("X-OpenCodex-CSRF-Token", memoryCsrfToken);
    }
  }
  if (input instanceof Request) return [new Request(input, { headers }), init ? { ...init, headers } : undefined];
  return [input, { ...init, headers }];
}

/**
 * The 401 re-prompt is user-facing copy, so it lives in `i18n/m3.ts` with every other string.
 * `api.ts` installs its fetch wrapper before React mounts, so it cannot use `useT()`; it resolves
 * the key here with the same locale-override → English-fallback order `LanguageProvider` uses.
 */
function adminTokenPromptMessage(): string {
  const key = "auth.adminTokenPrompt" as const;
  return M3_OVERRIDES[detectInitial()]?.[key] ?? M3_EN[key];
}

/**
 * How the token is asked for.
 *
 * `installApiAuthFetch()` runs before React mounts, so this module cannot render
 * a dialog itself — it can only call whatever the app has registered by the time
 * a 401 actually arrives. `shell/api-token-prompt.tsx` registers the M3 prompt
 * from inside the provider tree; anything that has not registered one — a
 * script importing this module, a test, a 401 landing in the gap before React
 * mounts — falls back to `window.prompt`.
 */
type TokenRequester = (message: string) => Promise<string | null>;

let tokenRequester: TokenRequester | null = null;

/** Register the app's own prompt. Pass null on unmount so a dead dialog is not called. */
export function setTokenRequester(requester: TokenRequester | null): void {
  tokenRequester = requester;
}

/**
 * Ask for a token, by whatever means this environment actually has.
 *
 * **Electron does not implement `window.prompt` and throws when it is called.**
 * That threw straight out of the fetch wrapper, so in the desktop app a single
 * 401 broke every caller that touched it — including Exit, which reported
 * "Could not exit cleanly: prompt() is not supported" and then did not exit.
 * A missing way to ask for a token means the request is unauthenticated, which
 * is a `null`; it is not an exception for callers to trip over.
 */
async function askForToken(): Promise<string | null> {
  const message = adminTokenPromptMessage();
  if (tokenRequester) return (await tokenRequester(message))?.trim() || null;
  try {
    return window.prompt(message)?.trim() || null;
  } catch {
    // No prompt in this environment (Electron, a sandboxed iframe, a headless
    // test). Nothing to ask with, so nothing was entered.
    return null;
  }
}

/**
 * Resolve a token after a 401. Concurrent callers share one in-flight resolution so a dashboard
 * fan-out does not open one prompt per /api request (#647). Re-reads memoryToken before
 * prompting so waiters that wake after another request already stored a token do not re-prompt.
 */
async function resolveTokenAfter401(failedToken: string | null): Promise<string | null> {
  if (promptCancelled) return null;
  if (promptInFlight) return promptInFlight;

  promptInFlight = (async () => {
    if (promptCancelled) return null;
    const current = readToken();
    if (current && current !== failedToken) return current;

    const prompted = await askForToken();
    if (prompted) {
      storeToken(prompted);
      return prompted;
    }
    promptCancelled = true;
    return null;
  })().finally(() => {
    promptInFlight = null;
  });

  return promptInFlight;
}

export function installApiAuthFetch(): void {
  if (installed) return;
  installed = true;
  // Drop any leftover XSS-readable token; new tokens stay memory-only (no read/migrate).
  clearLegacySessionToken();
  loadInjectedSession();
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!needsApiAuth(input)) return originalFetch(input, init);

    const token = readToken();
    const [firstInput, firstInit] = token ? withToken(input, init, token) : [input, init];
    const response = await originalFetch(firstInput, firstInit);
    if (response.status !== 401) return response;

    // Another request may have stored a token while this one was in flight (or while prompt blocked).
    const refreshed = readToken();
    if (refreshed && refreshed !== token) {
      const [retryInput, retryInit] = withToken(input, init, refreshed);
      const retry = await originalFetch(retryInput, retryInit);
      if (retry.status !== 401) return retry;
      clearTokenIfCurrent(refreshed);
    } else {
      clearTokenIfCurrent(token);
    }

    const nextToken = await resolveTokenAfter401(token);
    if (!nextToken) return response;

    const [retryInput, retryInit] = withToken(input, init, nextToken);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401) clearTokenIfCurrent(nextToken);
    return retry;
  };
}

/** Test-only: allow a fresh `installApiAuthFetch()` in the same module instance. */
export function resetApiAuthFetchForTests(): void {
  installed = false;
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
  promptInFlight = null;
  promptCancelled = false;
}
