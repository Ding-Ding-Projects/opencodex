/**
 * Local git history for the built-in authenticator's TOTP entries and the
 * app's renamable display name — the "Secret and display-name mutation
 * history" contract (`docs/FEATURE-INVENTORY.md`).
 *
 * ## Why this cannot be `state-history.ts`
 *
 * `state-history.ts` already keeps a local git history of this app's other
 * durable state, and it is explicit that its history is **plaintext by
 * design** — its own generated README says the repository "contains SECRETS
 * — OAuth refresh tokens and provider API keys", stored in the clear with the
 * user's consent. That is a deliberate, documented trade-off for that
 * feature, and it is the exact opposite of what this contract asks for: a
 * TOTP secret must never become plaintext git data, encrypted-or-redacted or
 * nothing at all. So this module owns a **second, separate** git repository
 * — its own directory, its own `.git`, its own identity — rather than adding
 * a path to `state-history.ts`'s `TRACKED` list. Mixing the two would mean
 * one careless future change away from a TOTP secret landing in the
 * plaintext-by-design repository.
 *
 * ## What a commit actually holds
 *
 * Every commit rewrites one file, `entry.json`, to a JSON object:
 *
 *     { kind, action, at, redacted, encrypted }
 *
 * `redacted` is always safe to read in the clear — issuer, account, group,
 * algorithm, digits, period, a display name, a retention day count. Never a
 * TOTP secret. `encrypted` is either `null` (nothing sensitive about this
 * mutation — a display-name change, a retention-policy change) or an
 * AES-256-GCM ciphertext of the full sensitive payload (today: the entire
 * `{entries, groups}` authenticator state, secrets included), so a restore
 * can recover more than the single field that changed. The encryption key is
 * a random 256-bit value generated once and held only in the Windows DPAPI
 * vault (`os-credential-vault.ts`) — never written to this repository, never
 * derived from anything a caller supplies. A copy of this repository, on its
 * own, decrypts nothing.
 *
 * Same file, tracked the same way `state-history.ts` tracks `config.json`:
 * each commit is a full snapshot of `entry.json` at that moment, so
 * `git log -- entry.json` is the whole mutation history and `git show
 * <hash>:entry.json` is one mutation's full record, exactly as
 * `listStateHistoryEntries`/`git show <hash>:auth.json` already work there.
 *
 * ## Fail-safe, and visible about it
 *
 * Every public function here returns a result object rather than throwing.
 * A mutation to `authenticator.json` or the display-name store must never be
 * blocked or rolled back because this repository, its git binary, or the OS
 * vault is unavailable — the caller performs the real mutation first and
 * calls this module second, best-effort, and reports the honest
 * `recorded: false` / `reason` back to the GUI so a recovery notification can
 * be shown rather than a silent "it worked".
 *
 * ## What is deliberately NOT here
 *
 * No winget auto-install of git (unlike `state-history.ts`): if a user only
 * ever touches the authenticator and never adds an account, `state-history.ts`
 * may never have triggered that install either, so duplicating it here would
 * be redundant machinery for a fail-safe path that is allowed to say
 * "git-unavailable" and stop. Documented as a known limitation rather than a
 * silent gap.
 */

import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { hasVaultSecret, readVaultSecret, storeVaultSecret } from "./os-credential-vault";

const REPO_SUBDIR = "secret-history";
const TRACKED_FILE = "entry.json";
const RETENTION_FILE = "retention.json";
/** The OS-vault token ref this module's AES-256-GCM key is stored under. Matches `TOKEN_REF_RE` in `os-credential-vault.ts`. */
const VAULT_KEY_REF = "secret-history-encryption-key";

function repoDir(configDir: string): string {
  return join(configDir, REPO_SUBDIR);
}

const GITIGNORE = `# opencodex secret & display-name history.
# Redacted metadata and AES-256-GCM ciphertext only — see README-SECRET-HISTORY.md.
*
!.gitignore
!.gitattributes
!README-SECRET-HISTORY.md
!${TRACKED_FILE}
`;

/** Same reasoning as `state-history.ts`: a ciphertext whose bytes moved on checkout fails to decrypt in a way indistinguishable from corruption. */
const GITATTRIBUTES = `# opencodex secret & display-name history — never transform stored bytes.
* -text
`;

const README = `# opencodex secret & display-name history

This is a LOCAL-ONLY git repository, separate from the account-history
repository beside it, written automatically when a TOTP entry is added,
changed or removed, and when the app's display name is set or reset.

Every commit rewrites one file, \`${TRACKED_FILE}\`:

    git -C . log --oneline
    git -C . show <commit>:${TRACKED_FILE}

Its "redacted" field is always plain text — issuer, account, group, a display
name, a retention day count. Its "encrypted" field, when present, is an
AES-256-GCM ciphertext of the sensitive payload (a TOTP secret, in full). The
key that ciphertext needs is NOT in this repository: it lives only in this
Windows account's DPAPI-protected credential vault. A copy of this directory
on its own, or on a different machine or account, decrypts nothing.

Never add a remote, never push it, never copy it somewhere synced or shared.
`;

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface OnDiskRecord {
  kind: string;
  action: string;
  at: string;
  redacted: Record<string, unknown>;
  encrypted: EncryptedBlob | null;
}

export type SecretHistoryFailureReason =
  | "git-unavailable"
  | "vault-unavailable"
  | "commit-failed"
  | "invalid-commit"
  | "decrypt-failed"
  | "not-found"
  | "invalid-retention";

export interface RecordSecretHistoryInput {
  /** Generic subject type — "totp-entry" and "display-name" today, but nothing here is specific to either. */
  kind: string;
  /** What happened: "created" | "updated" | "removed" | "bulk-removed" | "renamed" | "reset" | "restored" | "retention-changed" | ... */
  action: string;
  /** Safe fields only — never a secret. Written to git as plaintext JSON and readable without the vault key. */
  redacted: Record<string, unknown>;
  /** The sensitive payload to protect, or `null`/`undefined` when this mutation has nothing sensitive to snapshot. */
  sensitive: unknown;
}

export interface RecordSecretHistoryResult {
  recorded: boolean;
  hash?: string;
  reason?: SecretHistoryFailureReason;
}

export interface SecretHistoryEntry {
  hash: string;
  short: string;
  kind: string;
  action: string;
  at: string;
  redacted: Record<string, unknown>;
  /** Whether this commit carries an encrypted snapshot at all — restorable in principle, subject to the vault key still being available. */
  hasSensitiveSnapshot: boolean;
}

export interface RestoreSecretHistoryResult {
  ok: boolean;
  reason?: SecretHistoryFailureReason;
  kind?: string;
  action?: string;
  redacted?: Record<string, unknown>;
  /** Present only when the commit had an encrypted snapshot and decryption succeeded. */
  sensitive?: unknown;
}

export interface PruneResult {
  ok: boolean;
  prunedCount: number;
  keptCount: number;
  reason?: SecretHistoryFailureReason;
}

/* ------------------------------------------------------------------ git -- */

interface GitResult {
  ok: boolean;
  stdout: string;
}

function runGit(dir: string, args: string[], timeoutMs = 15_000, extraEnv?: Record<string, string>): Promise<GitResult> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn("git", ["-C", dir, ...args], {
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve({ ok: false, stdout: "" });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, stdout: "" }); });
    child.on("exit", code => { clearTimeout(timer); resolve({ ok: code === 0, stdout: stdout.trim() }); });
  });
}

async function gitAvailable(): Promise<boolean> {
  return (await runGit(".", ["--version"])).ok;
}

function refreshRepoRules(dir: string): void {
  for (const [name, content] of [[".gitignore", GITIGNORE], [".gitattributes", GITATTRIBUTES]] as const) {
    const path = join(dir, name);
    try {
      if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
      writeFileSync(path, content, "utf8");
    } catch { /* a read-only dir leaves the old rules in place; commits still try */ }
  }
}

/** No auto-install of git — see the module header for why that is a deliberate, documented gap rather than an oversight. */
async function ensureRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return false; }
  }
  if (!(await gitAvailable())) return false;
  if (existsSync(join(dir, ".git"))) {
    refreshRepoRules(dir);
    return true;
  }
  if (!(await runGit(dir, ["init", "--quiet"])).ok) return false;
  try {
    writeFileSync(join(dir, ".gitignore"), GITIGNORE, "utf8");
    writeFileSync(join(dir, ".gitattributes"), GITATTRIBUTES, "utf8");
    writeFileSync(join(dir, "README-SECRET-HISTORY.md"), README, "utf8");
  } catch {
    return false;
  }
  await runGit(dir, ["config", "user.name", "opencodex secret history"]);
  await runGit(dir, ["config", "user.email", "secret-history@localhost"]);
  await runGit(dir, ["config", "core.autocrlf", "false"]);
  return true;
}

function sanitizeSubject(text: string): string {
  const clean = text.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  return clean || "secret history change";
}

/* ------------------------------------------------------------ encryption -- */

/**
 * Reads the module's AES-256-GCM key from the OS vault, generating and
 * storing a fresh one on first use. Returns `null` on ANY failure — vault
 * unsupported platform, PowerShell/DPAPI failure, timeout — which callers
 * treat uniformly as "cannot protect a sensitive snapshot right now".
 */
async function getOrCreateEncryptionKey(): Promise<Buffer | null> {
  try {
    if (!hasVaultSecret(VAULT_KEY_REF)) {
      const key = randomBytes(32);
      await storeVaultSecret(VAULT_KEY_REF, key.toString("base64"));
      return key;
    }
    const stored = await readVaultSecret(VAULT_KEY_REF);
    if (!stored) return null;
    const key = Buffer.from(stored, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function encryptJson(key: Buffer, value: unknown): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decryptJson<T>(key: Buffer, blob: EncryptedBlob): T {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/* -------------------------------------------------------------- commits -- */

async function commitRecord(dir: string, record: OnDiskRecord): Promise<{ ok: boolean; hash?: string }> {
  if (!(await ensureRepo(dir))) return { ok: false };
  try {
    writeFileSync(join(dir, TRACKED_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    return { ok: false };
  }
  const added = await runGit(dir, ["add", "--", ".gitignore", ".gitattributes", "README-SECRET-HISTORY.md", TRACKED_FILE]);
  if (!added.ok) return { ok: false };
  const subject = sanitizeSubject(`${record.kind}: ${record.action}`);
  const committed = await runGit(dir, ["commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", subject]);
  if (!committed.ok) return { ok: false };
  const rev = await runGit(dir, ["rev-parse", "HEAD"]);
  return { ok: true, hash: rev.ok ? rev.stdout.trim() : undefined };
}

async function recordMutationNow(input: RecordSecretHistoryInput, configDir: string): Promise<RecordSecretHistoryResult> {
  const dir = repoDir(configDir);
  let encrypted: EncryptedBlob | null = null;
  if (input.sensitive !== null && input.sensitive !== undefined) {
    const key = await getOrCreateEncryptionKey();
    if (!key) return { recorded: false, reason: "vault-unavailable" };
    encrypted = encryptJson(key, input.sensitive);
  }
  const record: OnDiskRecord = {
    kind: input.kind, action: input.action, at: new Date().toISOString(), redacted: input.redacted, encrypted,
  };
  const result = await commitRecord(dir, record);
  if (!result.ok) {
    return { recorded: false, reason: (await gitAvailable()) ? "commit-failed" : "git-unavailable" };
  }
  return { recorded: true, hash: result.hash };
}

/**
 * Snapshots are serialized through this chain so concurrent mutations
 * (an add racing a rename, a restore racing a retention change) cannot race
 * each other's `git add`/`commit` on the shared index — exactly the same
 * reasoning as `state-history.ts`'s own queue.
 *
 * Public queued entry points call `recordMutationNow`/`doPrune` directly
 * rather than each other, so a queued call is never nested inside another
 * queued call — nesting would deadlock, since the inner call's `.then()`
 * would wait for the outer call to settle while the outer call awaits it.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Records one mutation as a new, append-only commit. Never throws; a failure
 * to record is reported, never silently swallowed, and never blocks or
 * rolls back the caller's real mutation — call this AFTER the real change
 * already succeeded.
 */
export function recordSecretHistoryMutation(
  input: RecordSecretHistoryInput,
  configDir: string = getConfigDir(),
): Promise<RecordSecretHistoryResult> {
  const next = queue.then(() => recordMutationNow(input, configDir)).catch(
    (): RecordSecretHistoryResult => ({ recorded: false, reason: "commit-failed" }),
  );
  queue = next;
  return next;
}

/* --------------------------------------------------------------- listing -- */

/** Every mutation, newest first. Reads directly from git — nothing cached, nothing that a "restart" could leave stale. */
export function listSecretHistoryEntries(limit = 50, configDir: string = getConfigDir()): SecretHistoryEntry[] {
  const dir = repoDir(configDir);
  if (!existsSync(join(dir, ".git"))) return [];
  try {
    const log = spawnSync("git", ["-C", dir, "log", `-${Math.max(1, Math.min(500, limit))}`, "--format=%H"], {
      encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    if (log.status !== 0 || !log.stdout.trim()) return [];
    const hashes = log.stdout.trim().split("\n");
    const out: SecretHistoryEntry[] = [];
    for (const hash of hashes) {
      const show = spawnSync("git", ["-C", dir, "show", `${hash}:${TRACKED_FILE}`], {
        encoding: "utf8", timeout: 15_000, windowsHide: true,
      });
      if (show.status !== 0) continue;
      try {
        const record = JSON.parse(show.stdout) as OnDiskRecord;
        out.push({
          hash, short: hash.slice(0, 7), kind: record.kind, action: record.action, at: record.at,
          redacted: record.redacted ?? {}, hasSensitiveSnapshot: record.encrypted !== null,
        });
      } catch { /* an unreadable commit is skipped rather than crashing the whole list */ }
    }
    return out;
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- restore -- */

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Reads and, when the commit carries an encrypted snapshot, decrypts one
 * historical mutation. Never writes anything back — the caller decides how
 * to apply `redacted`/`sensitive` to the live store, and is expected to call
 * {@link recordSecretHistoryMutation} again afterward with `action:
 * "restored"` so the restore itself becomes a new, append-only commit rather
 * than a silent rewrite of history.
 */
export async function restoreSecretHistorySnapshot(
  hash: string,
  configDir: string = getConfigDir(),
): Promise<RestoreSecretHistoryResult> {
  const dir = repoDir(configDir);
  if (!COMMIT_HASH_RE.test(hash)) return { ok: false, reason: "invalid-commit" };
  if (!existsSync(join(dir, ".git"))) return { ok: false, reason: "not-found" };
  // `<hash>^{commit}` refuses anything that is not a real commit in this repo.
  if (!(await runGit(dir, ["cat-file", "-e", `${hash}^{commit}`])).ok) return { ok: false, reason: "not-found" };
  const show = await runGit(dir, ["show", `${hash}:${TRACKED_FILE}`]);
  if (!show.ok) return { ok: false, reason: "not-found" };
  let record: OnDiskRecord;
  try {
    record = JSON.parse(show.stdout) as OnDiskRecord;
  } catch {
    return { ok: false, reason: "not-found" };
  }
  if (!record.encrypted) {
    return { ok: true, kind: record.kind, action: record.action, redacted: record.redacted ?? {} };
  }
  const key = await getOrCreateEncryptionKey();
  if (!key) return { ok: false, reason: "vault-unavailable" };
  try {
    const sensitive = decryptJson(key, record.encrypted);
    return { ok: true, kind: record.kind, action: record.action, redacted: record.redacted ?? {}, sensitive };
  } catch {
    return { ok: false, reason: "decrypt-failed" };
  }
}

/* ------------------------------------------------------------- retention -- */

/** `null` means "keep forever" — no automatic pruning until the user sets a policy. */
export function getSecretHistoryRetentionDays(configDir: string = getConfigDir()): number | null {
  const path = join(repoDir(configDir), RETENTION_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { days?: unknown };
    return typeof raw.days === "number" && Number.isFinite(raw.days) && raw.days > 0 ? raw.days : null;
  } catch {
    return null;
  }
}

function writeRetentionFile(dir: string, days: number | null): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, RETENTION_FILE), JSON.stringify({ days }), "utf8");
  } catch { /* best-effort local policy file — a failed write here does not stop the caller's request */ }
}

/**
 * Physically rewrites the repository to hold only the commits the current
 * retention policy keeps, preserving their original content and dates.
 *
 * Not append-only — this is the one deliberate exception the contract itself
 * names ("prune… by an explicit retention policy"), gated behind its own
 * fresh credential check on the GUI side. Safety net: the existing `.git` is
 * renamed aside before anything is rewritten and only deleted once the
 * rebuild has fully succeeded; any failure along the way restores it
 * untouched rather than leaving a half-rebuilt repository.
 */
async function doPrune(configDir: string): Promise<PruneResult> {
  const dir = repoDir(configDir);
  const gitDir = join(dir, ".git");
  if (!existsSync(gitDir)) return { ok: true, prunedCount: 0, keptCount: 0 };

  const days = getSecretHistoryRetentionDays(configDir);
  if (days === null) return { ok: true, prunedCount: 0, keptCount: listSecretHistoryEntries(500, configDir).length };
  if (!(await gitAvailable())) return { ok: false, prunedCount: 0, keptCount: 0, reason: "git-unavailable" };

  const all = listSecretHistoryEntries(500, configDir); // newest first
  const cutoff = Date.now() - days * 86_400_000;
  let kept = all.filter(e => new Date(e.at).getTime() >= cutoff);
  // Never prune to nothing: at least the single most recent mutation always survives.
  if (kept.length === 0 && all.length > 0) kept = [all[0]!];
  const prunedCount = all.length - kept.length;
  if (prunedCount <= 0) return { ok: true, prunedCount: 0, keptCount: kept.length };

  const payloads: { at: string; subject: string; content: string }[] = [];
  for (const entry of kept.slice().reverse()) { // oldest -> newest, for replay order
    const show = await runGit(dir, ["show", `${entry.hash}:${TRACKED_FILE}`]);
    if (!show.ok) continue;
    payloads.push({ at: entry.at, subject: `${entry.kind}: ${entry.action}`, content: show.stdout });
  }

  const backupDir = `${gitDir}.pruning-backup-${Date.now()}`;
  try {
    renameSync(gitDir, backupDir);
  } catch {
    return { ok: false, prunedCount: 0, keptCount: all.length, reason: "commit-failed" };
  }

  let rebuilt = true;
  if (!(await ensureRepo(dir))) rebuilt = false;
  for (const payload of payloads) {
    if (!rebuilt) break;
    try {
      writeFileSync(join(dir, TRACKED_FILE), payload.content, "utf8");
    } catch {
      rebuilt = false;
      break;
    }
    const added = await runGit(dir, ["add", "--", ".gitignore", ".gitattributes", "README-SECRET-HISTORY.md", TRACKED_FILE]);
    if (!added.ok) { rebuilt = false; break; }
    const committed = await runGit(
      dir,
      ["commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", sanitizeSubject(payload.subject)],
      15_000,
      { GIT_AUTHOR_DATE: payload.at, GIT_COMMITTER_DATE: payload.at },
    );
    if (!committed.ok) { rebuilt = false; break; }
  }

  if (!rebuilt || payloads.length === 0) {
    // Roll back completely: discard whatever partial rebuild happened and restore the original repo untouched.
    try { rmSync(gitDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try {
      renameSync(backupDir, gitDir);
    } catch {
      // The backup could not be restored under the expected name — it is left on disk under its
      // backup name rather than risking data loss by deleting it, and the failure is reported.
    }
    return { ok: false, prunedCount: 0, keptCount: all.length, reason: "commit-failed" };
  }

  try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* a leftover backup directory is harmless */ }
  return { ok: true, prunedCount, keptCount: payloads.length };
}

/** Applies the currently-configured retention policy right now, without changing it. */
export function pruneSecretHistoryByRetention(configDir: string = getConfigDir()): Promise<PruneResult> {
  const next = queue.then(() => doPrune(configDir)).catch(
    (): PruneResult => ({ ok: false, prunedCount: 0, keptCount: 0, reason: "commit-failed" }),
  );
  queue = next;
  return next;
}

/**
 * Sets the retention policy, records the change as its own redacted commit
 * (best-effort — a failure here does not stop the policy from taking
 * effect), and prunes to it immediately. One queue entry for the whole
 * operation, so it cannot race a concurrent mutation or another prune.
 */
export function setSecretHistoryRetentionDays(
  days: number | null,
  configDir: string = getConfigDir(),
): Promise<PruneResult & { reason?: SecretHistoryFailureReason }> {
  if (days !== null && (!Number.isInteger(days) || days <= 0)) {
    return Promise.resolve({ ok: false, prunedCount: 0, keptCount: 0, reason: "invalid-retention" });
  }
  const next = queue.then(async () => {
    writeRetentionFile(repoDir(configDir), days);
    await recordMutationNow(
      { kind: "retention", action: "retention-changed", redacted: { days }, sensitive: null },
      configDir,
    );
    return doPrune(configDir);
  }).catch((): PruneResult => ({ ok: false, prunedCount: 0, keptCount: 0, reason: "commit-failed" }));
  queue = next;
  return next;
}

/** Test isolation only: drops the module's write queue back to a resolved state so a hung prior test cannot bleed into the next one. */
export function resetSecretHistoryQueueForTests(): void {
  queue = Promise.resolve();
}
