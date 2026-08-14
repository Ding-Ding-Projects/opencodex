/**
 * Where a toy lock's credential actually lives, and the one place in this app
 * that touches a password or a TOTP secret.
 *
 * ## This is a toy lock, not a security boundary
 *
 * Every function here exists to slow down the person holding the mouse, not to
 * keep anyone out who has the machine. Nothing stored by this module is ever
 * described as "securing", "protecting" or "encrypting" data — see
 * `locks.ts` and the wizard/unlock surfaces for the disclosure copy that says so
 * out loud, every time, at every funny level.
 *
 * ## Where the "operating-system credential vault" lives here
 *
 * The shared contract asks for the OS credential vault under a stable account
 * key. This build is a browser-rendered GUI — served over Vite in dev, and
 * loaded as the same bundle inside the Electron shell's renderer in
 * `electron/main.mjs` — and neither the renderer nor the (deliberately minimal,
 * see `electron/preload.cjs`) desktop bridge exposes anything resembling
 * `safeStorage`, `keytar` or a platform credential manager. Grepping the tree
 * before writing this file found no existing vault integration to follow.
 *
 * So this is the same substitution the shared contract explicitly allows for a
 * page that has no OS vault to reach: "the site says plainly what it uses
 * instead and how to reset it" — the Pages/documentation-site rule, applied
 * here because it is the honest description of what this build actually is.
 * What it uses instead is a namespaced `localStorage` bucket, isolated from
 * every other store in the app (prefs, revisions, settings drafts, exports):
 * nothing here is ever serialized into a settings file, an export, a revision
 * snapshot or a screenshot. Recovery is exactly the browser-storage line the
 * contract itself gives: clearing this origin's local storage clears every
 * lock at once. `locks.ts` and the unlock/recovery surfaces name the concrete
 * application-data folder when the desktop bridge can resolve one (see
 * `app-data-path.ts`), and fall back to this same "clear this site's storage"
 * wording when it cannot.
 *
 * A real OS vault (Electron `safeStorage`, or a future `opencodexDesktop`
 * bridge) is a strictly better place for this to live, and the seam is drawn on
 * purpose: every credential access in the app goes through the six functions
 * this module exports, so swapping the storage backend later is a change to
 * this one file, not a hunt through every caller.
 *
 * ## What is never done, anywhere in this module
 *
 *  - A password is hashed (PBKDF2-SHA-256, salted, 100 000 iterations) and only
 *    the hash is ever written down. `verifyPasswordCredential` compares hashes;
 *    it never has the plaintext to compare against and never returns it.
 *  - A TOTP secret is generated locally (`randomBase32Secret`), shown to the
 *    user exactly once during registration so they can add it to their own
 *    authenticator app, and then stored — never displayed again, never
 *    re-derived for display, never logged. Verifying a code never reveals the
 *    secret or the expected code; it returns a bare boolean.
 *  - Nothing exported by this module accepts a caller-supplied "tell me the
 *    stored value" request. There isn't one to ask for.
 */

const VAULT_KEY = "ocx-m3:lock-vault";

export type CredentialMethod = "password" | "totp";
export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

interface PasswordEntry {
  method: "password";
  /** Base64, random per credential. */
  salt: string;
  /** Base64 PBKDF2 output. Never the plaintext, never reversible. */
  hash: string;
  iterations: number;
}

interface TotpEntry {
  method: "totp";
  /** Base32, the secret the user's own authenticator app also holds. */
  secret: string;
  digits: number;
  /** Seconds. */
  period: number;
  algorithm: TotpAlgorithm;
}

type VaultEntry = PasswordEntry | TotpEntry;

export interface PasswordCredentialInput { method: "password"; password: string }
export interface TotpCredentialInput {
  method: "totp";
  /** Base32. */
  secret: string;
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
}
export type CredentialInput = PasswordCredentialInput | TotpCredentialInput;

const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;
const DEFAULT_ALGORITHM: TotpAlgorithm = "SHA-1";
const PBKDF2_ITERATIONS = 100_000;
/** ±1 period either side of "now", the usual TOTP tolerance for clock drift. */
const TOTP_SKEW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function readVault(): Record<string, VaultEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(VAULT_KEY) || "{}");
    return raw && typeof raw === "object" ? raw as Record<string, VaultEntry> : {};
  } catch {
    return {};
  }
}

function writeVault(next: Record<string, VaultEntry>): void {
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(next));
  } catch { /* quota — the caller's own action still completed in memory */ }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** RFC 4648 base32, no padding — the form every authenticator app expects to paste in. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes a base32 secret. Whitespace and casing are tolerated — the same forgiveness a real authenticator app gives when a secret is typed by hand. */
export function base32Decode(secret: string): Uint8Array {
  const cleaned = secret.replace(/[^A-Za-z2-7]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A fresh random secret, ready to display for manual entry into the user's own authenticator. 20 bytes (160 bits) is the RFC 4226 recommendation. */
export function randomBase32Secret(byteLength = 20): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

function randomSaltBytes(byteLength = 16): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Constant-time-ish comparison — irrelevant for a toy lock's threat model, cheap to do properly anyway. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmac(secret: Uint8Array, message: Uint8Array, algorithm: TotpAlgorithm): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, message as BufferSource);
  return new Uint8Array(signature);
}

/** RFC 4226 HOTP over an arbitrary counter. Exported so tests can run the RFC 6238 Appendix B vectors directly against known secret bytes. */
export async function hotp(secretBytes: Uint8Array, counter: number, digits: number, algorithm: TotpAlgorithm): Promise<string> {
  const counterBytes = new Uint8Array(8);
  // Counter is a 64-bit big-endian integer; JS numbers are safe here well past
  // any TOTP counter this app will ever see (the low 32 bits carry everything
  // up to roughly the year 6429 at a 30-second step).
  let value = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const digest = await hmac(secretBytes, counterBytes, algorithm);
  const offset = digest[digest.length - 1]! & 0x0f;
  const binCode = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  const code = String(binCode % 10 ** digits);
  return code.padStart(digits, "0");
}

/** RFC 6238 TOTP: HOTP over the time step, not a caller-supplied counter. */
export async function totpCode(
  secretBytes: Uint8Array,
  atMs: number,
  period: number,
  digits: number,
  algorithm: TotpAlgorithm,
): Promise<string> {
  const counter = Math.floor(atMs / 1000 / period);
  return hotp(secretBytes, counter, digits, algorithm);
}

/**
 * Whether `code` matches the secret at `atMs`, within `±skewSteps` periods.
 *
 * The skew window is what keeps a slightly-drifted phone clock or a code typed
 * a couple of seconds late from reading as "wrong" — the same tolerance every
 * real authenticator-checking service applies.
 */
export async function verifyTotpAt(
  secretBytes: Uint8Array,
  code: string,
  atMs: number,
  period: number,
  digits: number,
  algorithm: TotpAlgorithm,
  skewSteps = TOTP_SKEW_STEPS,
): Promise<boolean> {
  const trimmed = code.trim();
  if (!/^\d+$/.test(trimmed) || trimmed.length !== digits) return false;
  const counter = Math.floor(atMs / 1000 / period);
  for (let delta = -skewSteps; delta <= skewSteps; delta++) {
    const candidate = await hotp(secretBytes, counter + delta, digits, algorithm);
    if (candidate === trimmed) return true;
  }
  return false;
}

/** Stores a fresh credential for `lockId`, replacing whatever was there. */
export async function storeCredential(lockId: string, input: CredentialInput): Promise<void> {
  const vault = readVault();
  if (input.method === "password") {
    const salt = randomSaltBytes();
    const hash = await pbkdf2(input.password, salt, PBKDF2_ITERATIONS);
    vault[lockId] = { method: "password", salt: toBase64(salt), hash: toBase64(hash), iterations: PBKDF2_ITERATIONS };
  } else {
    vault[lockId] = {
      method: "totp",
      secret: input.secret.replace(/\s+/g, "").toUpperCase(),
      digits: input.digits ?? DEFAULT_DIGITS,
      period: input.period ?? DEFAULT_PERIOD,
      algorithm: input.algorithm ?? DEFAULT_ALGORITHM,
    };
  }
  writeVault(vault);
}

export function removeCredential(lockId: string): void {
  const vault = readVault();
  if (!(lockId in vault)) return;
  delete vault[lockId];
  writeVault(vault);
}

export function hasCredential(lockId: string): boolean {
  return lockId in readVault();
}

/** Which method a stored credential uses — never its value, length or composition. */
export function credentialMethod(lockId: string): CredentialMethod | null {
  return readVault()[lockId]?.method ?? null;
}

/** True only for a genuine password match. False for a missing credential, a TOTP-method lock, or a mismatch — the caller cannot tell which from the return value alone, which is deliberate. */
export async function verifyPasswordCredential(lockId: string, password: string): Promise<boolean> {
  const entry = readVault()[lockId];
  if (!entry || entry.method !== "password") return false;
  const salt = fromBase64(entry.salt);
  const candidate = await pbkdf2(password, salt, entry.iterations);
  return bytesEqual(candidate, fromBase64(entry.hash));
}

/** True only for a genuine TOTP match, evaluated at `atMs` (defaults to now — a parameter purely so tests can pin a fixed instant). */
export async function verifyTotpCredential(lockId: string, code: string, atMs: number = Date.now()): Promise<boolean> {
  const entry = readVault()[lockId];
  if (!entry || entry.method !== "totp") return false;
  return verifyTotpAt(base32Decode(entry.secret), code, atMs, entry.period, entry.digits, entry.algorithm);
}

/** Verifies whatever method the stored credential actually uses, given whichever input the unlock prompt collected. */
export async function verifyCredential(
  lockId: string,
  input: { password?: string; code?: string },
  atMs: number = Date.now(),
): Promise<boolean> {
  const method = credentialMethod(lockId);
  if (method === "password" && input.password !== undefined) return verifyPasswordCredential(lockId, input.password);
  if (method === "totp" && input.code !== undefined) return verifyTotpCredential(lockId, input.code, atMs);
  return false;
}

/**
 * Wipes every credential at once — what "delete the application-data folder"
 * (or, in this browser fallback, "clear this site's storage") actually does to
 * this bucket. Exposed for the Support Tickets "resolution" step and for tests;
 * never wired to anything reachable except through that recovery path, because
 * this is the one action a locked-out user with no other route has left.
 */
export function clearAllCredentials(): void {
  try { localStorage.removeItem(VAULT_KEY); } catch { /* ignore */ }
}
