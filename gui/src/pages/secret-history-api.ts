/**
 * Thin fetch wrapper around `/api/host/authenticator/history*` (see
 * `src/server/management/authenticator-routes.ts` and `src/lib/secret-history.ts`).
 *
 * Nothing here ever sees a TOTP secret. `SecretHistoryEntry.redacted` is
 * exactly what the server calls "redacted" — issuer/account/group metadata,
 * or a display-name before/after pair — never a secret, and `hasSensitiveSnapshot`
 * only says whether an encrypted blob exists server-side, never its contents.
 * A restore response's `entries`/`groups` DOES carry secrets (it is the
 * decrypted, restored authenticator state), exactly like
 * `authenticator-api.ts`'s own `exportAuthenticatorSecrets` — callers must
 * gate reaching either behind the reused credential-vault password/TOTP check.
 */

import { readJsonOrThrow } from "../fetch-json";

export interface SecretHistoryEntry {
  hash: string;
  short: string;
  kind: string;
  action: string;
  at: string;
  redacted: Record<string, unknown>;
  hasSensitiveSnapshot: boolean;
}

export interface SecretHistoryList {
  entries: SecretHistoryEntry[];
  retentionDays: number | null;
}

export async function fetchSecretHistory(apiBase: string, signal?: AbortSignal): Promise<SecretHistoryList> {
  const res = await fetch(`${apiBase}/api/host/authenticator/history`, { signal });
  return (await readJsonOrThrow<SecretHistoryList>(res, "secretHistory.errors.loadFailed")) as SecretHistoryList;
}

export interface RestoreTotpResult {
  ok: true;
  kind: "totp-entry";
  entries: { id: string; issuer: string; account: string }[];
  groups: unknown[];
  historyRecorded: boolean;
  historyReason?: string;
}
export interface RestoreDisplayNameResult {
  ok: true;
  kind: "display-name";
  value: string | null;
}
export type RestoreResult = RestoreTotpResult | RestoreDisplayNameResult;

export async function restoreSecretHistory(apiBase: string, hash: string): Promise<RestoreResult> {
  const res = await fetch(`${apiBase}/api/host/authenticator/history/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash, confirmed: true }),
  });
  return (await readJsonOrThrow<RestoreResult>(res, "secretHistory.errors.restoreFailed")) as RestoreResult;
}

export interface SecretHistoryExport {
  warning: string;
  exportedAt: string;
  entries: SecretHistoryEntry[];
}

export async function exportSecretHistory(apiBase: string): Promise<SecretHistoryExport> {
  const res = await fetch(`${apiBase}/api/host/authenticator/history/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed: true }),
  });
  return (await readJsonOrThrow<SecretHistoryExport>(res, "secretHistory.errors.exportFailed")) as SecretHistoryExport;
}

export interface RetentionResult {
  ok: boolean;
  prunedCount: number;
  keptCount: number;
  retentionDays: number | null;
  reason?: string;
}

export async function setSecretHistoryRetention(apiBase: string, days: number | null): Promise<RetentionResult> {
  const res = await fetch(`${apiBase}/api/host/authenticator/history/retention`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days, confirmed: true }),
  });
  return (await readJsonOrThrow<RetentionResult>(res, "secretHistory.errors.retentionFailed")) as RetentionResult;
}

export interface RecordDisplayNameHistoryInput {
  action: "renamed" | "reset" | "restored";
  previous: string;
  next: string;
}

/**
 * Best-effort: called AFTER `theme/app-name.ts` already committed the rename
 * locally, exactly like every other history call here. A failed request
 * (network hiccup, server not reachable in a browser-only preview) is
 * reported to the caller so it can notify, but never unwinds the rename that
 * already happened in the browser store.
 */
export async function recordDisplayNameHistory(
  apiBase: string,
  input: RecordDisplayNameHistoryInput,
): Promise<{ historyRecorded: boolean; historyReason?: string }> {
  try {
    const res = await fetch(`${apiBase}/api/host/authenticator/history/display-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { historyRecorded: false, historyReason: "request-failed" };
    return await res.json() as { historyRecorded: boolean; historyReason?: string };
  } catch {
    return { historyRecorded: false, historyReason: "request-failed" };
  }
}
