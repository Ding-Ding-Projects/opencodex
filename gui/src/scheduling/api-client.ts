/**
 * Thin wrappers around `/api/schedule/*` — the only place scheduled-settings
 * code in the renderer is allowed to reach the network, and even then only
 * indirectly: every call here goes to this app's own privileged process
 * (`src/server/management/schedule-routes.ts`), which is the one that
 * actually talks to a rule's API or Home Assistant instance. See that file's
 * doc comment for the SSRF/redirect/size/timeout boundary.
 */

import { sanitizeScheduleValues } from "./schema";
import type { ScheduleValues } from "./types";

export type ScheduleFetchFailureReason =
  | "network" | "refused" | "too-large" | "timeout" | "malformed"
  | "invalid-url" | "invalid-entity" | "invalid-token-ref" | "no-token" | "auth-or-refused" | "http";

export type ScheduleFetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ScheduleFetchFailureReason; error: string };

async function postJson(apiBase: string, path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* leave empty; status alone still tells the caller something failed */ }
  return { status: res.status, data };
}

export async function resolveApiValues(apiBase: string, url: string, signal?: AbortSignal): Promise<ScheduleFetchResult<ScheduleValues>> {
  try {
    const { status, data } = await postJson(apiBase, "/api/schedule/resolve-api", { url }, signal);
    if (status >= 500) return { ok: false, reason: "http", error: `server error (HTTP ${status})` };
    if (data.ok === true) return { ok: true, value: sanitizeScheduleValues(data.values) };
    return { ok: false, reason: (data.reason as ScheduleFetchFailureReason) ?? "network", error: typeof data.error === "string" ? data.error : "the scheduled API could not be reached" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error; // superseded — let the caller's generation guard drop it
    return { ok: false, reason: "network", error: error instanceof Error ? error.message : "network request failed" };
  }
}

export interface HaStateQuery {
  baseUrl: string;
  entityId: string;
  tokenRef: string;
}

export async function fetchHaState(apiBase: string, query: HaStateQuery, signal?: AbortSignal): Promise<ScheduleFetchResult<string>> {
  try {
    const { status, data } = await postJson(apiBase, "/api/schedule/ha-state", query, signal);
    if (status >= 500) return { ok: false, reason: "http", error: `server error (HTTP ${status})` };
    if (data.ok === true && typeof data.state === "string") return { ok: true, value: data.state };
    return { ok: false, reason: (data.reason as ScheduleFetchFailureReason) ?? "network", error: typeof data.error === "string" ? data.error : "Home Assistant could not be reached" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, reason: "network", error: error instanceof Error ? error.message : "network request failed" };
  }
}

export async function haTokenConfigured(apiBase: string, tokenRef: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/api/schedule/ha-token?tokenRef=${encodeURIComponent(tokenRef)}`, { signal });
    const data = await res.json();
    return data?.configured === true;
  } catch {
    return false;
  }
}

export async function storeHaToken(apiBase: string, tokenRef: string, token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${apiBase}/api/schedule/ha-token`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenRef, token }),
    });
    const data = await res.json();
    if (data?.ok === true) return { ok: true };
    return { ok: false, error: typeof data?.error === "string" ? data.error : "could not store the token" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "could not store the token" };
  }
}

export async function clearHaToken(apiBase: string, tokenRef: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${apiBase}/api/schedule/ha-token`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenRef }),
    });
    const data = await res.json();
    if (data?.ok === true) return { ok: true };
    return { ok: false, error: typeof data?.error === "string" ? data.error : "could not clear the token" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "could not clear the token" };
  }
}
