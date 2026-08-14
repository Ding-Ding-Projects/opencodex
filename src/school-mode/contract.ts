/**
 * The School Mode contract's pure, side-effect-free constants and validation
 * — the one thing both the server (`./store.ts`, which owns the shared file
 * and everything Node-only about it) and the GUI (`gui/src/school-mode/`,
 * which never imports `node:fs` or `node:crypto`) need to agree on.
 *
 * Splitting this out is what lets the renderer pre-validate a PIN/password or
 * a name against the *exact* bounds the server enforces — not an
 * independently maintained copy of the same three numbers that could quietly
 * drift out of step with what the server actually accepts. Nothing here
 * touches the filesystem, the network, or a credential's hash: this is the
 * schema, not the store.
 */

export const SCHOOL_MODE_SCHEMA_VERSION = 1 as const;

/** Bounds a rename may be refused under, so a hostile/mistaken file cannot wedge every surface that renders it. */
export const SCHOOL_MODE_MAX_NAME_LENGTH = 80;
/** A PIN/password shorter than this is refused outright — long enough to not be a single keystroke, short enough to stay a "toy lock" a phone keypad can hold. */
export const SCHOOL_MODE_MIN_SECRET_LENGTH = 4;
export const SCHOOL_MODE_MAX_SECRET_LENGTH = 256;

export interface SchoolModeSecretValidation {
  readonly ok: boolean;
  readonly reason?: "too-short" | "too-long";
}

export function validateSchoolModeSecret(secret: unknown): SchoolModeSecretValidation {
  if (typeof secret !== "string") return { ok: false, reason: "too-short" };
  if (secret.length < SCHOOL_MODE_MIN_SECRET_LENGTH) return { ok: false, reason: "too-short" };
  if (secret.length > SCHOOL_MODE_MAX_SECRET_LENGTH) return { ok: false, reason: "too-long" };
  return { ok: true };
}

export function validateSchoolModeName(name: unknown): boolean {
  if (name === null) return true;
  return typeof name === "string" && name.trim().length > 0 && name.length <= SCHOOL_MODE_MAX_NAME_LENGTH;
}
