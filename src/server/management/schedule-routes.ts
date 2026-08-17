/**
 * `/api/schedule/*` — the privileged-process half of scheduled-settings rules.
 *
 * The renderer never calls a scheduled rule's API or Home Assistant instance
 * directly: the dashboard's CSP is `connect-src 'self'` (see
 * `narrator-routes.ts` for the same reasoning applied to Edge TTS), and a
 * scheduled rule's source is data the *user* configured, not something this
 * app should trust with the renderer's own network privileges. Every
 * outbound call this file makes is server-side, validated, bounded and never
 * follows a redirect.
 *
 * Endpoints:
 * - POST   /api/schedule/resolve-api   { url } -> { ok, values } | { ok:false, reason, error }
 * - POST   /api/schedule/ha-state      { baseUrl, entityId, tokenRef } -> { ok, state } | refused
 * - GET    /api/schedule/ha-token?tokenRef=  -> { configured: boolean } — never the token itself
 * - PUT    /api/schedule/ha-token      { tokenRef, token } -> { ok:true } — stores into the OS vault
 * - DELETE /api/schedule/ha-token      { tokenRef } -> { ok:true }
 *
 * SSRF/abuse boundary, applied to every URL this file fetches (a rule's API
 * URL and a rule's Home Assistant base URL alike):
 * - `https:` only, or `http:` restricted to `127.0.0.1` / `localhost` — the
 *   contract's "explicitly bounded loopback development route".
 * - no `user:pass@host` embedded credentials.
 * - `redirect: "manual"` — a 3xx is treated as a refusal, never followed, so a
 *   remote server cannot redirect this process at an internal address.
 * - a byte cap on the response body, read incrementally so an oversized body
 *   is abandoned rather than fully buffered first.
 * - a short, fixed timeout.
 *
 * "Unbounded refresh loops" are prevented on the renderer side: a rule's
 * `refreshMinutes` is clamped to `[REFRESH_MINUTES_MIN, REFRESH_MINUTES_MAX]`
 * in `gui/src/scheduling/schema.ts`, and the runtime hook only polls while its
 * rule is the currently active one — this file only ever answers one request
 * at a time and starts no timer of its own.
 */

import {
  CredentialVaultError,
  deleteVaultSecret,
  hasVaultSecret,
  readVaultSecret,
  storeVaultSecret,
} from "../../lib/os-credential-vault";
import { jsonResponse } from "../auth-cors";
import { requireLoopbackListener } from "./local-machine-gate";
import type { ManagementContext } from "./context";

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 65_536;
const TOKEN_REF_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/i;

/** Shared with the loopback-http exception `gui/src/scheduling/schema.ts` allows. */
function isAllowedRemoteUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) return parsed;
  return null;
}

/**
 * Reads a response body up to `limit` bytes, abandoning the stream once it is
 * exceeded rather than buffering the whole thing first — the same shape as
 * `readBoundedText` in `host-routes.ts`, duplicated here because that one is
 * scoped to a `Request`, not a `Response`.
 */
async function readBoundedResponseText(response: Response, limit: number): Promise<string | null> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

async function fetchBounded(url: URL, headers: Record<string, string>): Promise<
  { ok: true; text: string } | { ok: false; reason: "network" | "refused" | "too-large" | "timeout" | "malformed"; error: string }
> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, reason: isTimeout ? "timeout" : "network", error: error instanceof Error ? error.message : "network request failed" };
  }
  // Manual redirect mode surfaces a 3xx as an opaque-ish response rather than
  // following it; `type` is "opaqueredirect" when it actually attempted one.
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return { ok: false, reason: "refused", error: "the server responded with a redirect, which is not followed" };
  }
  if (!response.ok) {
    return { ok: false, reason: "refused", error: `HTTP ${response.status}` };
  }
  const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
  if (text === null) return { ok: false, reason: "too-large", error: "response exceeded the size limit" };
  return { ok: true, text };
}

/* --------------------------------------------------------- API resolution */

/** Matches `SCHEDULE_VALUE_KEYS` in `gui/src/scheduling/types.ts`. */
const VALUE_KEYS = ["theme", "seed", "density", "fontId", "fontStack", "fontScale", "fontWeight", "locale", "funnyEn", "funnyYue"] as const;

/**
 * Allowlist-validates a resolved API's `values` object down to exactly the
 * fields a scheduled rule may ever set, with the same bounds
 * `gui/src/scheduling/schema.ts` enforces on a locally-typed rule. An
 * unrecognised field, an out-of-range value, or a value of the wrong type is
 * dropped rather than rejecting the whole response — the same
 * "validates-down-to-nothing" contract used everywhere else in this app.
 */
function sanitizeResolvedValues(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (r.theme === "light" || r.theme === "dark" || r.theme === "system") out.theme = r.theme;
  if (typeof r.seed === "string" && /^#[0-9a-fA-F]{3,8}$/.test(r.seed)) out.seed = r.seed;
  const density = Math.round(Number(r.density));
  if (density >= 1 && density <= 5) out.density = density;
  if (typeof r.fontId === "string" && r.fontId.trim()) out.fontId = r.fontId.trim().slice(0, 200);
  if (typeof r.fontStack === "string" && r.fontStack.trim()) out.fontStack = r.fontStack.trim().slice(0, 400);
  if (Number.isFinite(Number(r.fontScale))) out.fontScale = Math.min(1.6, Math.max(0.8, Number(r.fontScale)));
  if (Number.isFinite(Number(r.fontWeight))) out.fontWeight = Math.min(700, Math.max(300, Number(r.fontWeight)));
  if (typeof r.locale === "string" && ["en", "yue", "bi", "de", "ko", "zh", "ru", "ja"].includes(r.locale)) out.locale = r.locale;
  const funnyEn = Math.round(Number(r.funnyEn));
  if (funnyEn >= 1 && funnyEn <= 5) out.funnyEn = funnyEn;
  const funnyYue = Math.round(Number(r.funnyYue));
  if (funnyYue >= 1 && funnyYue <= 5) out.funnyYue = funnyYue;
  return out;
}

async function handleResolveApi(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: { url?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ ok: false, reason: "malformed", error: "invalid JSON body" }, 400, req, config); }
  const raw = typeof body.url === "string" ? body.url.trim() : "";
  const url = raw ? isAllowedRemoteUrl(raw) : null;
  if (!url) {
    return jsonResponse({ ok: false, reason: "invalid-url", error: "url must be https://, or http://127.0.0.1 / http://localhost for local development" }, 400, req, config);
  }
  const fetched = await fetchBounded(url, { Accept: "application/json" });
  if (!fetched.ok) return jsonResponse({ ok: false, reason: fetched.reason, error: fetched.error }, 200, req, config);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.text);
  } catch {
    return jsonResponse({ ok: false, reason: "malformed", error: "response was not valid JSON" }, 200, req, config);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).version !== 1) {
    return jsonResponse({ ok: false, reason: "malformed", error: 'response must be {"version":1,"values":{...}}' }, 200, req, config);
  }
  const values = sanitizeResolvedValues((parsed as Record<string, unknown>).values);
  return jsonResponse({ ok: true, values }, 200, req, config);
}

/* ---------------------------------------------------------- Home Assistant */

async function handleHaState(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: { baseUrl?: unknown; entityId?: unknown; tokenRef?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ ok: false, reason: "malformed", error: "invalid JSON body" }, 400, req, config); }
  const baseUrlRaw = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
  const tokenRef = typeof body.tokenRef === "string" ? body.tokenRef.trim() : "";
  const base = baseUrlRaw ? isAllowedRemoteUrl(baseUrlRaw) : null;
  if (!base) return jsonResponse({ ok: false, reason: "invalid-url", error: "baseUrl must be https://, or http://127.0.0.1 / http://localhost for local development" }, 400, req, config);
  if (!ENTITY_ID_RE.test(entityId)) return jsonResponse({ ok: false, reason: "invalid-entity", error: "entityId must look like domain.object_id, e.g. input_boolean.evening_mode" }, 400, req, config);
  if (!TOKEN_REF_RE.test(tokenRef)) return jsonResponse({ ok: false, reason: "invalid-token-ref", error: "tokenRef is invalid" }, 400, req, config);

  let token: string | null;
  try {
    token = await readVaultSecret(tokenRef);
  } catch (error) {
    // The vault itself failed (not "wrong account" — that already resolves to
    // `null` inside readVaultSecret) rather than "no token stored"; still
    // fails safe by reporting "no usable token", never a stack trace or a
    // PowerShell error string that might carry environment details.
    void error;
    return jsonResponse({ ok: false, reason: "no-token", error: "the OS credential vault is unavailable on this machine" }, 200, req, config);
  }
  if (!token) return jsonResponse({ ok: false, reason: "no-token", error: "no token is stored for this rule" }, 200, req, config);

  const statesUrl = new URL(`/api/states/${encodeURIComponent(entityId)}`, base);
  const fetched = await fetchBounded(statesUrl, { Accept: "application/json", Authorization: `Bearer ${token}` });
  // Never let the raw fetch failure text leak the token — it can't (the token
  // lives only in a header we set, not anything the failure text could echo),
  // but the boundary is worth stating: nothing token-shaped is ever logged or
  // placed in a response body anywhere in this handler.
  if (!fetched.ok) {
    const reason = fetched.reason === "refused" ? "auth-or-refused" : fetched.reason;
    return jsonResponse({ ok: false, reason, error: fetched.error }, 200, req, config);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.text);
  } catch {
    return jsonResponse({ ok: false, reason: "malformed", error: "Home Assistant response was not valid JSON" }, 200, req, config);
  }
  const state = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).state : undefined;
  if (typeof state !== "string" || !state) {
    return jsonResponse({ ok: false, reason: "malformed", error: "Home Assistant response had no state field" }, 200, req, config);
  }
  return jsonResponse({ ok: true, state: state.slice(0, 64) }, 200, req, config);
}

async function handleHaToken(ctx: ManagementContext): Promise<Response> {
  const { req, url, config } = ctx;

  if (req.method === "GET") {
    const tokenRef = (url.searchParams.get("tokenRef") ?? "").trim();
    if (!TOKEN_REF_RE.test(tokenRef)) return jsonResponse({ error: "tokenRef is invalid" }, 400, req, config);
    try {
      return jsonResponse({ configured: hasVaultSecret(tokenRef) }, 200, req, config);
    } catch (error) {
      return jsonResponse({ configured: false, error: error instanceof Error ? error.message : "vault unavailable" }, 200, req, config);
    }
  }

  // Storing and clearing a secret spawns a local PowerShell process to talk to
  // DPAPI; gated exactly like the launcher and installer routes in
  // `host-routes.ts`, for the reason `local-machine-gate.ts` states.
  const localOnly = requireLoopbackListener(ctx, "Storing a Home Assistant token");
  if (localOnly) return localOnly;

  if (req.method === "PUT") {
    let body: { tokenRef?: unknown; token?: unknown };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ ok: false, error: "invalid JSON body" }, 400, req, config); }
    const tokenRef = typeof body.tokenRef === "string" ? body.tokenRef.trim() : "";
    const token = typeof body.token === "string" ? body.token : "";
    if (!TOKEN_REF_RE.test(tokenRef)) return jsonResponse({ ok: false, error: "tokenRef is invalid" }, 400, req, config);
    if (!token.trim()) return jsonResponse({ ok: false, error: "token is required" }, 400, req, config);
    try {
      await storeVaultSecret(tokenRef, token);
      return jsonResponse({ ok: true }, 200, req, config);
    } catch (error) {
      const reason = error instanceof CredentialVaultError ? error.reason : "powershell-failed";
      return jsonResponse({ ok: false, reason, error: error instanceof Error ? error.message : "could not store the token" }, 502, req, config);
    }
  }

  if (req.method === "DELETE") {
    let body: { tokenRef?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* an empty body clears nothing, handled below */ }
    const tokenRef = typeof body.tokenRef === "string" ? body.tokenRef.trim() : "";
    if (!TOKEN_REF_RE.test(tokenRef)) return jsonResponse({ ok: false, error: "tokenRef is invalid" }, 400, req, config);
    deleteVaultSecret(tokenRef);
    return jsonResponse({ ok: true }, 200, req, config);
  }

  return jsonResponse({ error: "method not allowed" }, 405, req, config);
}

export async function handleScheduleRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (url.pathname === "/api/schedule/resolve-api" && req.method === "POST") {
    return handleResolveApi(ctx);
  }
  if (url.pathname === "/api/schedule/ha-state" && req.method === "POST") {
    return handleHaState(ctx);
  }
  if (url.pathname === "/api/schedule/ha-token" && (req.method === "GET" || req.method === "PUT" || req.method === "DELETE")) {
    return handleHaToken(ctx);
  }
  return null;
}
