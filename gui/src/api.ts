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

/**
 * The unwrapped `fetch`, captured at install.
 *
 * Session renewal must not go through the wrapper: `/api/gui-session` is an
 * `/api/` path, so a wrapped call would attach the dead token, take its own 401
 * and try to renew again — recursion, on the exact path whose job is to break it.
 */
let originalFetchRef: typeof window.fetch | null = null;

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
 * Surfaces where a 401 must NOT ask for an admin token.
 *
 * The mobile remote is one. It is reached by scanning a pairing QR and what it
 * receives is a **data-plane** key, while `/api/*` accepts only the management
 * credential — so every management read from a phone answers 401 by design.
 * Asking for an admin token there is wrong three times over: the phone user does
 * not have one, cannot produce one from the phone, and the dialog's own copy
 * says a data-plane key will not work for `/api/*`. The result was that a
 * successful pairing presented itself as a credential failure.
 *
 * Suppressing only silences the *prompt*. The 401 still reaches the caller,
 * which is what lets the mobile screen say plainly that a panel needs the
 * desktop instead of hanging on "Loading…". It also deliberately does not set
 * `promptCancelled`, so leaving that surface restores normal behaviour rather
 * than latching the dashboard into never asking again.
 */
let promptSuppressed = false;

export function setAdminTokenPromptSuppressed(suppressed: boolean): void {
  promptSuppressed = suppressed;
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
 * Silently mint a new GUI session, the way loading the page would.
 *
 * The session token arrives in the page HTML and nothing renewed it, so any
 * event that emptied the server's session map — a proxy restart, most obviously
 * — stranded the open dashboard on 401 forever and raised the "Admin token
 * needed" dialog. That ask is wrong on a local machine: the credential is on
 * disk, the app can prove same-origin loopback, and a user should never be
 * asked to paste a token to repair something a reload would have fixed.
 *
 * `/api/gui-session` re-runs the same proof the server runs when serving the
 * page, so this grants nothing that reloading would not. Failure is a `null`,
 * never a throw: a dead renewal must fall through to the existing prompt path
 * rather than break the caller that triggered it.
 */
let renewalInFlight: Promise<string | null> | null = null;
/**
 * Set once the server has said this page cannot hold a session (a remote
 * dashboard, a non-loopback binding). That answer will not change for this page
 * lifetime, so without latching it every subsequent 401 in a fan-out would fire
 * another doomed renewal — turning one refused request into a request storm.
 */
let renewalRefused = false;

function renewSession(): Promise<string | null> {
  if (renewalRefused) return Promise.resolve(null);
  // Concurrent 401s share one renewal, exactly as they share one prompt.
  if (renewalInFlight) return renewalInFlight;
  renewalInFlight = requestSession().finally(() => { renewalInFlight = null; });
  return renewalInFlight;
}

async function requestSession(): Promise<string | null> {
  try {
    const response = await originalFetchRef?.("/api/gui-session", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response) return null;
    // 403 is the server saying this page may never hold a session. Latch it so a
    // fan-out does not re-ask once per request.
    if (response.status === 403) {
      renewalRefused = true;
      return null;
    }
    if (!response.ok) return null;
    const session = await response.json() as { token?: unknown; csrfToken?: unknown; origin?: unknown };
    const { token, csrfToken, origin } = session;
    // A malformed body is not a transient failure — the endpoint answered, it
    // just cannot give this page a session. Latch it like a refusal.
    if (typeof token !== "string" || !token.startsWith("ocx_session_")) {
      renewalRefused = true;
      return null;
    }
    if (typeof csrfToken !== "string" || !csrfToken) {
      renewalRefused = true;
      return null;
    }
    // Never adopt a session bound to some other origin — that would attach this
    // page's requests to a session it cannot legitimately hold.
    if (origin !== window.location.origin) {
      renewalRefused = true;
      return null;
    }
    memoryToken = token;
    memoryCsrfToken = csrfToken;
    memorySessionOrigin = origin;
    return token;
  } catch {
    // Offline, proxy down, malformed body. Nothing renewed.
    return null;
  }
}

/**
 * Resolve a token after a 401. Concurrent callers share one in-flight resolution so a dashboard
 * fan-out does not open one prompt per /api request (#647). Re-reads memoryToken before
 * prompting so waiters that wake after another request already stored a token do not re-prompt.
 */
async function resolveTokenAfter401(failedToken: string | null): Promise<string | null> {
  // Checked before `promptCancelled` so a suppressed surface never latches the
  // cancel flag on behalf of the whole page load.
  if (promptSuppressed) return null;
  // `promptCancelled` latches the *prompt*, not repair. A user who dismissed the
  // dialog once still gets a silently renewed session — otherwise one cancel
  // permanently disables the automatic path, and the page stays broken for a
  // reason the user has no way to connect to the click they made.
  if (promptCancelled) return renewSession();
  if (promptInFlight) return promptInFlight;

  promptInFlight = (async () => {
    if (promptCancelled) return null;
    const current = readToken();
    if (current && current !== failedToken) return current;

    // Repair before asking. This is the ordinary case on a local machine — the
    // session lapsed with the proxy, not the user's authority — so it must be
    // tried first, and silently. Only a genuinely unrenewable session (a remote
    // dashboard, a non-loopback binding) reaches the prompt below.
    const renewed = await renewSession();
    if (renewed) return renewed;

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
  originalFetchRef = originalFetch;
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
  originalFetchRef = null;
  renewalInFlight = null;
  renewalRefused = false;
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
  promptInFlight = null;
  promptCancelled = false;
  promptSuppressed = false;
}
