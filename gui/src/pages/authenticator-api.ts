/**
 * Thin fetch wrapper around `/api/host/authenticator/*` (see
 * `src/server/management/authenticator-routes.ts`).
 *
 * Nothing here caches a secret. A pending registration's `secret` passes
 * through exactly once — from the `generate`/`import` response, through the
 * confirm step, into the QR and the manual-entry field — and is discarded the
 * moment the dialog that showed it closes. The entry list this module reads
 * afterward carries only `AuthenticatorEntryMeta`, which has no `secret` field
 * at the type level, not just by convention.
 */

import { readJsonOrThrow } from "../fetch-json";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface AuthenticatorGroup {
  id: string;
  name: string;
  order: number;
}

export interface AuthenticatorEntryMeta {
  id: string;
  issuer: string;
  account: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  groupId: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatorListResponse {
  entries: AuthenticatorEntryMeta[];
  groups: AuthenticatorGroup[];
  serverTime: number;
}

export interface PendingRegistration {
  pendingId: string;
  otpauthUri: string;
  secret: string;
  issuer: string;
  account: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  expiresAt: number;
  serverTime: number;
}

export interface LiveCode {
  code: string;
  nextCode: string;
  digits: number;
  period: number;
  periodStart: number;
  periodEnd: number;
  secondsRemaining: number;
  serverTime: number;
}

export type ConfirmFailureReason = "not-found" | "expired" | "locked" | "wrong-code";

export class ConfirmError extends Error {
  readonly reason: ConfirmFailureReason;
  readonly attemptsRemaining?: number;
  constructor(message: string, reason: ConfirmFailureReason, attemptsRemaining?: number) {
    super(message);
    this.name = "ConfirmError";
    this.reason = reason;
    this.attemptsRemaining = attemptsRemaining;
  }
}

async function post<T>(apiBase: string, path: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await readJsonOrThrow<T>(res, fallback)) as T;
}

export async function fetchAuthenticatorList(apiBase: string, signal?: AbortSignal): Promise<AuthenticatorListResponse> {
  const res = await fetch(`${apiBase}/api/host/authenticator`, { signal });
  return (await readJsonOrThrow<AuthenticatorListResponse>(res, "authenticator.errors.loadFailed")) as AuthenticatorListResponse;
}

export async function fetchLiveCode(apiBase: string, entryId: string, signal?: AbortSignal): Promise<LiveCode> {
  const res = await fetch(`${apiBase}/api/host/authenticator/code?id=${encodeURIComponent(entryId)}`, { signal });
  return (await readJsonOrThrow<LiveCode>(res, "authenticator.errors.codeFailed")) as LiveCode;
}

export interface GenerateInput {
  issuer: string;
  account: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
  groupId?: string | null;
}

export function generatePendingRegistration(apiBase: string, input: GenerateInput): Promise<PendingRegistration> {
  return post(apiBase, "/api/host/authenticator/pending", { mode: "generate", ...input }, "authenticator.errors.generateFailed");
}

export interface ImportUriInput {
  otpauthUri: string;
  groupId?: string | null;
}

export interface ImportManualInput {
  issuer: string;
  account: string;
  secret: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
  groupId?: string | null;
}

export function importPendingRegistration(
  apiBase: string,
  input: ImportUriInput | ImportManualInput,
): Promise<PendingRegistration> {
  return post(apiBase, "/api/host/authenticator/pending", { mode: "import", ...input }, "authenticator.errors.importFailed");
}

export async function confirmPendingRegistration(apiBase: string, pendingId: string, code: string): Promise<AuthenticatorEntryMeta> {
  const res = await fetch(`${apiBase}/api/host/authenticator/pending/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pendingId, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; reason?: ConfirmFailureReason; attemptsRemaining?: number };
    throw new ConfirmError(body.error ?? "authenticator.confirm.wrongCode", body.reason ?? "wrong-code", body.attemptsRemaining);
  }
  const data = await res.json() as { entry: AuthenticatorEntryMeta };
  return data.entry;
}

export async function discardPendingRegistration(apiBase: string, pendingId: string): Promise<void> {
  await fetch(`${apiBase}/api/host/authenticator/pending?id=${encodeURIComponent(pendingId)}`, { method: "DELETE" });
}

export interface EntryPatch {
  issuer?: string;
  account?: string;
  groupId?: string | null;
  order?: number;
}

export async function patchAuthenticatorEntry(apiBase: string, id: string, patch: EntryPatch): Promise<AuthenticatorEntryMeta> {
  const res = await fetch(`${apiBase}/api/host/authenticator/entry?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await readJsonOrThrow<{ entry: AuthenticatorEntryMeta }>(res, "authenticator.errors.saveFailed");
  return data!.entry;
}

export async function deleteAuthenticatorEntry(apiBase: string, id: string): Promise<boolean> {
  const res = await fetch(`${apiBase}/api/host/authenticator/entry?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.ok;
}

export async function bulkDeleteAuthenticatorEntries(apiBase: string, ids: string[]): Promise<{ removed: string[]; skipped: string[] }> {
  return post(apiBase, "/api/host/authenticator/bulk-delete", { ids }, "authenticator.errors.bulkDeleteFailed");
}

export async function bulkSetAuthenticatorGroup(apiBase: string, ids: string[], groupId: string | null): Promise<{ touched: string[]; skipped: string[] }> {
  return post(apiBase, "/api/host/authenticator/bulk-group", { ids, groupId }, "authenticator.errors.bulkGroupFailed");
}

export async function createAuthenticatorGroup(apiBase: string, name: string): Promise<AuthenticatorGroup> {
  const data = await post<{ group: AuthenticatorGroup }>(apiBase, "/api/host/authenticator/groups", { name }, "authenticator.errors.groupFailed");
  return data.group;
}

export async function renameAuthenticatorGroup(apiBase: string, id: string, name: string): Promise<AuthenticatorGroup> {
  const res = await fetch(`${apiBase}/api/host/authenticator/groups?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await readJsonOrThrow<{ group: AuthenticatorGroup }>(res, "authenticator.errors.groupFailed");
  return data!.group;
}

export async function deleteAuthenticatorGroup(apiBase: string, id: string): Promise<boolean> {
  const res = await fetch(`${apiBase}/api/host/authenticator/groups?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.ok;
}

export interface ExportedAuthenticatorEntry {
  issuer: string;
  account: string;
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  otpauthUri: string;
  group: string;
}

export interface AuthenticatorSecretsExport {
  warning: string;
  exportedAt: string;
  entries: ExportedAuthenticatorEntry[];
}

/** The one route in this module that returns real secrets. Callers must gate this behind `SuperConfirmGate`. */
export function exportAuthenticatorSecrets(apiBase: string): Promise<AuthenticatorSecretsExport> {
  return post(apiBase, "/api/host/authenticator/export-secrets", { confirmed: true }, "authenticator.export.failed");
}
