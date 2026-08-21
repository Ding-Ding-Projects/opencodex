/**
 * Windows DPAPI-backed secret storage — the "operating-system credential
 * vault" the scheduled-settings contract requires for a Home Assistant
 * long-lived access token.
 *
 * `System.Security.Cryptography.ProtectedData` (DPAPI) ties the ciphertext to
 * the signed-in Windows account: nobody who is not signed in as this user can
 * decrypt it, even with the file in hand, and there is nothing to type or
 * remember — it is the same primitive Windows Credential Manager itself is
 * built on. This app's active delivery scope is Windows only (see the shared
 * agent instructions' Windows-only scope note), so DPAPI *is* the vault here,
 * without adding a native `keytar`-style dependency to what has otherwise
 * been a dependency-free proxy (`bun`, `zod`, `@bufbuild/protobuf`, the MCP
 * SDK — see `package.json`).
 *
 * `resolveTrustedWindowsPowerShellExe()` (from `./windows-elevation`) is
 * reused for exactly what it already guarantees: the *real*
 * `System32\WindowsPowerShell\v1.0\powershell.exe`, resolved via
 * `GetSystemDirectoryW` rather than trusted from `process.env`, and never
 * elevated — DPAPI's `CurrentUser` scope needs no admin token, so unlike
 * `windows-elevation.ts` this never shows a UAC prompt.
 *
 * The plaintext token never touches a command-line argument (visible, if only
 * briefly, to anything enumerating processes) and never touches a log: it is
 * written to the child's stdin as JSON, and the child's stdout carries only
 * base64 — either the ciphertext (encrypt) or the recovered plaintext
 * (decrypt), read back over a pipe this process owns exclusively.
 *
 * The ciphertext file (`schedule-secrets.json`, beside `config.json` in
 * `getConfigDir()`) is deliberately its own file, outside the user's checkout
 * (`getConfigDir()` resolves under the OS user profile — see `config.ts`),
 * and is never included in `ocx export` / `GET /api/host/export` — that
 * bundle enumerates `config.json`, `codex-accounts.json` and `auth.json` by
 * name in `src/server/management/host-routes.ts` and nothing here adds to it.
 * The file holds ciphertext only; even a full copy of it is worthless off
 * this Windows account.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { resolveTrustedWindowsPowerShellExe } from "./windows-elevation";

/**
 * Not a secret — DPAPI's optional "additional entropy" only raises the bar
 * against a *different* local app decrypting this app's blobs with its own
 * DPAPI call; the ciphertext's real protection is the Windows account key
 * DPAPI itself manages. Never treat this constant as sensitive.
 */
const ENTROPY = "opencodex-schedule-ha-token-v1";

const VAULT_TIMEOUT_MS = 10_000;
const TOKEN_REF_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** A generous ceiling for a pasted long-lived access token; not a real secret length disclosure. */
const TOKEN_MAX_LENGTH = 8192;

export type CredentialVaultFailureReason = "unsupported-platform" | "invalid-token-ref" | "powershell-failed" | "timeout";

export class CredentialVaultError extends Error {
  constructor(readonly reason: CredentialVaultFailureReason, message: string) {
    super(message);
    this.name = "CredentialVaultError";
  }
}

function secretsFilePath(): string {
  return join(getConfigDir(), "schedule-secrets.json");
}

interface StoredSecret {
  alg: "dpapi-currentuser";
  ciphertext: string;
  createdAt: string;
}
type SecretsFile = Record<string, StoredSecret>;

function readSecretsFile(): SecretsFile {
  const path = secretsFilePath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw as SecretsFile : {};
  } catch {
    // A corrupt file fails closed to "no secrets stored" rather than throwing —
    // callers treat that exactly like "never configured", which is safe.
    return {};
  }
}

function writeSecretsFile(file: SecretsFile): void {
  writeFileSync(secretsFilePath(), JSON.stringify(file, null, 2), "utf8");
}

export function assertValidTokenRef(tokenRef: string): void {
  if (!TOKEN_REF_RE.test(tokenRef)) {
    throw new CredentialVaultError("invalid-token-ref", "tokenRef must be 1-80 characters of letters, digits, underscore or hyphen.");
  }
}

/** Test-only seam for the PowerShell child process. */
let spawnForTests: typeof spawn | null = null;
export function setCredentialVaultSpawnForTests(next: typeof spawn | null): void {
  spawnForTests = next;
}

/** Reads a JSON payload on stdin, writes a bounded base64 result to stdout. */
const ENCRYPT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$json = [Console]::In.ReadToEnd()",
  "$obj = $json | ConvertFrom-Json",
  "$bytes = [Convert]::FromBase64String($obj.plaintextB64)",
  "$entropy = [Text.Encoding]::UTF8.GetBytes($obj.entropy)",
  "$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($enc))",
].join("; ");

const DECRYPT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "try {",
  "  $json = [Console]::In.ReadToEnd()",
  "  $obj = $json | ConvertFrom-Json",
  "  $bytes = [Convert]::FromBase64String($obj.ciphertextB64)",
  "  $entropy = [Text.Encoding]::UTF8.GetBytes($obj.entropy)",
  "  $dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "  [Console]::Out.Write([Convert]::ToBase64String($dec))",
  "} catch {",
  "  [Console]::Error.Write($_.Exception.Message)",
  "  exit 1",
  "}",
].join("; ");

function runVaultScript(script: string, stdinPayload: string): Promise<string> {
  if (process.platform !== "win32") {
    return Promise.reject(new CredentialVaultError("unsupported-platform", "The OS credential vault is only available on Windows."));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const spawnFn = spawnForTests ?? spawn;
      child = spawnFn(resolveTrustedWindowsPowerShellExe(), [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new CredentialVaultError("powershell-failed", error instanceof Error ? error.message : String(error)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(new CredentialVaultError("timeout", "The Windows credential vault did not respond in time."));
    }, VAULT_TIMEOUT_MS);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => { stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: string | Buffer) => { stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8"); });

    child.once("error", (error: Error) => {
      settle(() => reject(new CredentialVaultError("powershell-failed", error.message)));
    });
    child.once("close", (code: number | null) => {
      settle(() => {
        if (code !== 0) {
          reject(new CredentialVaultError("powershell-failed", stderr.trim() || `PowerShell exited with code ${code}`));
          return;
        }
        resolve(stdout.trim());
      });
    });

    // Written to stdin, never to argv or a log — see the module doc comment.
    child.stdin?.end(stdinPayload, "utf8");
  });
}

function runVaultScriptSync(script: string, stdinPayload: string): string {
  if (process.platform !== "win32") throw new CredentialVaultError("unsupported-platform", "The OS credential vault is only available on Windows.");
  try {
    return execFileSync(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], { windowsHide: true, input: stdinPayload, encoding: "utf8", timeout: VAULT_TIMEOUT_MS, maxBuffer: TOKEN_MAX_LENGTH * 4 }).trim();
  } catch (error) {
    throw new CredentialVaultError("powershell-failed", error instanceof Error ? error.message : String(error));
  }
}

/** Encrypts and stores `plaintext` under `tokenRef`, replacing any prior value. */
export async function storeVaultSecret(tokenRef: string, plaintext: string): Promise<void> {
  assertValidTokenRef(tokenRef);
  if (!plaintext || plaintext.length > TOKEN_MAX_LENGTH) {
    throw new CredentialVaultError("invalid-token-ref", `token must be 1-${TOKEN_MAX_LENGTH} characters.`);
  }
  const plaintextB64 = Buffer.from(plaintext, "utf8").toString("base64");
  const ciphertext = await runVaultScript(ENCRYPT_SCRIPT, JSON.stringify({ plaintextB64, entropy: ENTROPY }));
  const file = readSecretsFile();
  file[tokenRef] = { alg: "dpapi-currentuser", ciphertext, createdAt: new Date().toISOString() };
  writeSecretsFile(file);
}

/** Synchronous counterpart for request routing, which is intentionally synchronous today. */
export function storeVaultSecretSync(tokenRef: string, plaintext: string): void {
  assertValidTokenRef(tokenRef);
  if (!plaintext || plaintext.length > TOKEN_MAX_LENGTH) throw new CredentialVaultError("invalid-token-ref", `token must be 1-${TOKEN_MAX_LENGTH} characters.`);
  const ciphertext = runVaultScriptSync(ENCRYPT_SCRIPT, JSON.stringify({
    plaintextB64: Buffer.from(plaintext, "utf8").toString("base64"), entropy: ENTROPY,
  }));
  const file = readSecretsFile();
  file[tokenRef] = { alg: "dpapi-currentuser", ciphertext, createdAt: new Date().toISOString() };
  writeSecretsFile(file);
}

/**
 * Decrypts and returns the token stored under `tokenRef`, or `null` when
 * nothing is stored *or* decryption fails (wrong account, corrupted blob,
 * vault unavailable) — callers treat both the same way: this rule has no
 * usable token right now, so it contributes nothing rather than throwing.
 */
export async function readVaultSecret(tokenRef: string): Promise<string | null> {
  assertValidTokenRef(tokenRef);
  const entry = readSecretsFile()[tokenRef];
  if (!entry) return null;
  try {
    const plaintextB64 = await runVaultScript(DECRYPT_SCRIPT, JSON.stringify({ ciphertextB64: entry.ciphertext, entropy: ENTROPY }));
    return Buffer.from(plaintextB64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function readVaultSecretSync(tokenRef: string): string | null {
  assertValidTokenRef(tokenRef);
  const entry = readSecretsFile()[tokenRef];
  if (!entry) return null;
  try {
    const plaintextB64 = runVaultScriptSync(DECRYPT_SCRIPT, JSON.stringify({ ciphertextB64: entry.ciphertext, entropy: ENTROPY }));
    const plaintext = Buffer.from(plaintextB64, "base64").toString("utf8");
    return plaintext && plaintext.length <= TOKEN_MAX_LENGTH ? plaintext : null;
  } catch {
    return null;
  }
}

export function hasVaultSecret(tokenRef: string): boolean {
  assertValidTokenRef(tokenRef);
  return tokenRef in readSecretsFile();
}

export function deleteVaultSecret(tokenRef: string): void {
  assertValidTokenRef(tokenRef);
  const file = readSecretsFile();
  if (tokenRef in file) {
    delete file[tokenRef];
    writeSecretsFile(file);
  }
}
