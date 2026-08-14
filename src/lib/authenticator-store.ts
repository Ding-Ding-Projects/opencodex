/**
 * Persistent storage for the built-in authenticator's TOTP entries.
 *
 * ## Where the secrets live, and why this is the codebase's vault
 *
 * There is no `safeStorage`/`keytar`/DPAPI bridge anywhere in this codebase
 * (see `docs/FEATURE-INVENTORY.md`, slice 6) — the desktop shell's preload is
 * deliberately minimal (`electron/preload.cjs`) and the dashboard it serves is
 * reached over plain HTTP from a browser, which has no OS-vault API to call
 * even if one were bridged. What this codebase already treats as its
 * credential vault, for every other secret it holds — OAuth refresh tokens in
 * `src/oauth/store.ts`'s `auth.json` — is a per-user file under
 * `getConfigDir()`, written atomically, `chmod 0o600` on the file and
 * `0o700` on its directory, with `icacls`-based ACL hardening layered on top
 * on Windows (`hardenSecretPath`/`hardenSecretDir` in
 * `src/lib/windows-secret-acl.ts`) so only the owning account can read it.
 * That is the established, audited pattern this store follows exactly, rather
 * than inventing a second, weaker one just for TOTP secrets.
 *
 * Stored as `authenticator.json`, deliberately not `config.json` and
 * deliberately not `auth.json` — a name of its own means it is *not* in
 * `state-history.ts`'s `TRACKED` allowlist, so it can never enter a version-
 * history commit. The contract this file exists to satisfy says secrets must
 * never land in "settings files, presets, logs, screenshots, history entries
 * or Git"; the file's name is what keeps that true rather than a comment
 * promising it.
 *
 * ## What never touches disk
 *
 * A secret being *registered* (freshly generated, or imported from a pasted
 * URI/QR) is **not** written here until the user types back one live code —
 * see `pending-authenticator-registrations.ts`. Pending registrations live in
 * an in-memory, TTL-bounded map only, so a mistyped or mis-scanned secret
 * that is never confirmed leaves no trace on disk at all.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile, backupInvalidConfig, getConfigDir, hardenConfigDir, hardenExistingSecret } from "../config";
import { DEFAULT_ALGORITHM, DEFAULT_DIGITS, DEFAULT_PERIOD, MAX_DIGITS, MIN_DIGITS, TOTP_ALGORITHMS, type TotpAlgorithm } from "./totp";
import { isValidBase32 } from "./base32";

export interface AuthenticatorGroup {
  id: string;
  name: string;
  order: number;
}

export interface AuthenticatorEntry {
  id: string;
  issuer: string;
  account: string;
  /** Canonical unpadded uppercase base32 — the one thing this file exists to protect. */
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  groupId: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** The same fields, minus `secret` — everything the GUI list, search and export may see. */
export type AuthenticatorEntryMeta = Omit<AuthenticatorEntry, "secret">;

export function toEntryMeta(entry: AuthenticatorEntry): AuthenticatorEntryMeta {
  const { secret: _secret, ...meta } = entry;
  return meta;
}

interface AuthenticatorFile {
  version: 1;
  entries: AuthenticatorEntry[];
  groups: AuthenticatorGroup[];
}

const EMPTY: AuthenticatorFile = { version: 1, entries: [], groups: [] };

export function getAuthenticatorStorePath(): string {
  return join(getConfigDir(), "authenticator.json");
}

function isTotpAlgorithm(value: unknown): value is TotpAlgorithm {
  return typeof value === "string" && (TOTP_ALGORITHMS as readonly string[]).includes(value);
}

/** Defensive normalization: a hand-edited or future-version file degrades to safe defaults per-field, never a crash. */
function normalizeEntry(raw: unknown): AuthenticatorEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.secret !== "string" || !isValidBase32(r.secret)) return null;
  const digits = typeof r.digits === "number" && Number.isInteger(r.digits) && r.digits >= MIN_DIGITS && r.digits <= MAX_DIGITS
    ? r.digits : DEFAULT_DIGITS;
  const period = typeof r.period === "number" && Number.isFinite(r.period) && r.period > 0 ? r.period : DEFAULT_PERIOD;
  const now = new Date().toISOString();
  return {
    id: r.id,
    issuer: typeof r.issuer === "string" ? r.issuer : "",
    account: typeof r.account === "string" ? r.account : "",
    secret: r.secret.toUpperCase(),
    algorithm: isTotpAlgorithm(r.algorithm) ? r.algorithm : DEFAULT_ALGORITHM,
    digits,
    period,
    groupId: typeof r.groupId === "string" ? r.groupId : null,
    order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : 0,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
  };
}

function normalizeGroup(raw: unknown): AuthenticatorGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "",
    order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : 0,
  };
}

function normalizeFile(raw: unknown): AuthenticatorFile {
  if (!raw || typeof raw !== "object") return { ...EMPTY, entries: [], groups: [] };
  const r = raw as Record<string, unknown>;
  const entries = Array.isArray(r.entries) ? r.entries.map(normalizeEntry).filter((e): e is AuthenticatorEntry => e !== null) : [];
  const groups = Array.isArray(r.groups) ? r.groups.map(normalizeGroup).filter((g): g is AuthenticatorGroup => g !== null) : [];
  return { version: 1, entries, groups };
}

function loadFile(): AuthenticatorFile {
  const path = getAuthenticatorStorePath();
  hardenConfigDir();
  hardenExistingSecret(path);
  if (!existsSync(path)) return { ...EMPTY, entries: [], groups: [] };
  try {
    return normalizeFile(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    // A corrupt secrets file is backed up (never silently discarded — that
    // would be an unannounced loss of every registered factor) and treated as
    // empty going forward rather than crashing every route that reads it.
    backupInvalidConfig(path);
    return { ...EMPTY, entries: [], groups: [] };
  }
}

function persist(file: AuthenticatorFile): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else { try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ } }
  hardenConfigDir();
  atomicWriteFile(getAuthenticatorStorePath(), JSON.stringify(file, null, 2) + "\n");
  hardenExistingSecret(getAuthenticatorStorePath());
}

/** Every entry, including its secret. Callers within this module and its route handler only — never returned to the GUI directly. */
export function loadAuthenticatorEntries(): AuthenticatorEntry[] {
  return loadFile().entries;
}

export function loadAuthenticatorGroups(): AuthenticatorGroup[] {
  return loadFile().groups;
}

/** The full secret-bearing record for computing a live code — the one legitimate reason to read `secret` outside this module. */
export function getAuthenticatorEntry(id: string): AuthenticatorEntry | null {
  return loadFile().entries.find(e => e.id === id) ?? null;
}

export interface NewAuthenticatorEntry {
  issuer: string;
  account: string;
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  groupId?: string | null;
}

export function addAuthenticatorEntry(fields: NewAuthenticatorEntry): AuthenticatorEntry {
  const file = loadFile();
  const now = new Date().toISOString();
  const maxOrder = file.entries.reduce((max, e) => Math.max(max, e.order), -1);
  const entry: AuthenticatorEntry = {
    id: randomUUID(),
    issuer: fields.issuer.trim(),
    account: fields.account.trim(),
    secret: fields.secret.toUpperCase(),
    algorithm: fields.algorithm,
    digits: fields.digits,
    period: fields.period,
    groupId: fields.groupId ?? null,
    order: maxOrder + 1,
    createdAt: now,
    updatedAt: now,
  };
  file.entries.push(entry);
  persist(file);
  return entry;
}

export interface EntryPatch {
  issuer?: string;
  account?: string;
  groupId?: string | null;
  order?: number;
}

export function updateAuthenticatorEntry(id: string, patch: EntryPatch): AuthenticatorEntry | null {
  const file = loadFile();
  const entry = file.entries.find(e => e.id === id);
  if (!entry) return null;
  if (patch.issuer !== undefined) entry.issuer = patch.issuer.trim();
  if (patch.account !== undefined) entry.account = patch.account.trim();
  if (patch.groupId !== undefined) entry.groupId = patch.groupId;
  if (patch.order !== undefined) entry.order = patch.order;
  entry.updatedAt = new Date().toISOString();
  persist(file);
  return entry;
}

/** Returns the number of entries actually removed (0 or 1) — bulk callers sum this rather than assuming success. */
export function removeAuthenticatorEntry(id: string): number {
  const file = loadFile();
  const before = file.entries.length;
  file.entries = file.entries.filter(e => e.id !== id);
  if (file.entries.length === before) return 0;
  persist(file);
  return 1;
}

/** Bulk delete, one persisted write for the whole batch rather than N. Returns the ids actually removed. */
export function removeAuthenticatorEntries(ids: string[]): string[] {
  const file = loadFile();
  const idSet = new Set(ids);
  const removed = file.entries.filter(e => idSet.has(e.id)).map(e => e.id);
  if (removed.length === 0) return [];
  file.entries = file.entries.filter(e => !idSet.has(e.id));
  persist(file);
  return removed;
}

export function bulkSetGroup(ids: string[], groupId: string | null): string[] {
  const file = loadFile();
  const idSet = new Set(ids);
  const touched: string[] = [];
  const now = new Date().toISOString();
  for (const entry of file.entries) {
    if (idSet.has(entry.id)) {
      entry.groupId = groupId;
      entry.updatedAt = now;
      touched.push(entry.id);
    }
  }
  if (touched.length > 0) persist(file);
  return touched;
}

export function addAuthenticatorGroup(name: string): AuthenticatorGroup {
  const file = loadFile();
  const maxOrder = file.groups.reduce((max, g) => Math.max(max, g.order), -1);
  const group: AuthenticatorGroup = { id: randomUUID(), name: name.trim(), order: maxOrder + 1 };
  file.groups.push(group);
  persist(file);
  return group;
}

export function updateAuthenticatorGroup(id: string, patch: { name?: string; order?: number }): AuthenticatorGroup | null {
  const file = loadFile();
  const group = file.groups.find(g => g.id === id);
  if (!group) return null;
  if (patch.name !== undefined) group.name = patch.name.trim();
  if (patch.order !== undefined) group.order = patch.order;
  persist(file);
  return group;
}

/** Deletes the group and ungroups its members — never deletes their entries. */
export function removeAuthenticatorGroup(id: string): boolean {
  const file = loadFile();
  const before = file.groups.length;
  file.groups = file.groups.filter(g => g.id !== id);
  if (file.groups.length === before) return false;
  for (const entry of file.entries) if (entry.groupId === id) entry.groupId = null;
  persist(file);
  return true;
}

/** Test isolation: no production caller should ever want this. */
export function resetAuthenticatorStoreForTests(): void {
  if (existsSync(getAuthenticatorStorePath())) persist({ ...EMPTY, entries: [], groups: [] });
}
