/**
 * `/api/school-mode` — the universal School Mode toggle and its shared,
 * cross-app record.
 *
 * - GET  /api/school-mode             → current state, never the credential
 * - POST /api/school-mode/enable      → turn on; refused until a credential exists
 * - POST /api/school-mode/disable     → { secret } turn off; verified against the stored credential
 * - POST /api/school-mode/credential  → { newSecret, currentSecret? } set/change the unlock credential
 * - POST /api/school-mode/rename      → { name: string | null } the display name every surface must use
 *
 * This is a **user-experience lock, not a security boundary** (the contract
 * says so explicitly, and every response the GUI renders from this repeats
 * it) — so the routes below optimize for "does what it says" and "never
 * silently disagrees with the shared file", not for defending against a
 * determined local attacker. The one thing that *is* taken seriously is never
 * writing the credential in the clear: only its scrypt hash ever reaches disk
 * (`../../school-mode/store`).
 *
 * The record is shared with every other conforming app on the machine, not
 * scoped to this one — see `../../school-mode/paths` for why it deliberately
 * is not `getConfigDir()`. A directory watcher is started lazily, on the
 * first request this route handles (never merely on module import — every
 * other management-API test in this repo imports this module transitively
 * through `management-api.ts`, and importing it must never touch the real
 * shared directory on the machine running the test), purely so `GET` can
 * report an honest `recordWatchable` flag. The value `GET` actually returns
 * is always a fresh disk read, so correctness never depends on the watch
 * succeeding.
 */

import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import {
  DEFAULT_SCHOOL_MODE_RECORD,
  hashCredential,
  readSchoolModeRecord,
  SCHOOL_MODE_MAX_SECRET_LENGTH,
  SCHOOL_MODE_MIN_SECRET_LENGTH,
  schoolModeDir,
  validateSchoolModeName,
  validateSchoolModeSecret,
  verifyCredential,
  watchSchoolModeRecord,
  writeSchoolModeRecordAtomic,
  type SchoolModeRecord,
  type SchoolModeWatchHandle,
} from "../../school-mode/store";

/**
 * Lazily started on the first request a school-mode route actually handles —
 * never at module-import time. See the module doc comment for why that
 * distinction matters for every *other* management-API test in this repo.
 */
let watchHandle: SchoolModeWatchHandle | undefined;

function ensureWatching(): SchoolModeWatchHandle {
  if (!watchHandle) {
    watchHandle = watchSchoolModeRecord(() => { /* GET always re-reads disk; nothing to cache here */ });
  }
  return watchHandle;
}

/** Test-only: forget the memoized watcher so the next call re-probes a (possibly overridden) path. */
export function resetSchoolModeWatchForTests(): void {
  watchHandle?.stop();
  watchHandle = undefined;
}

function schoolModeStatePayload(): Record<string, unknown> {
  const result = readSchoolModeRecord();
  const { record } = result;
  const watch = ensureWatching();
  return {
    enabled: record.enabled,
    hasCustomName: record.customName !== null,
    customName: record.customName,
    hasCredential: record.credential !== null,
    updatedAt: record.updatedAt,
    recordReadable: result.readable,
    readError: result.readable ? undefined : result.error,
    recordWatchable: watch.watchable,
    watchError: watch.watchable ? undefined : watch.error,
    // The exact folder a user can delete to reset the mode by hand — the
    // documented recovery route, named rather than gestured at, per the
    // toy-lock contract ("recovers by deleting... names the actual folder").
    recordDir: schoolModeDir(),
  };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function handleSchoolModeRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (!url.pathname.startsWith("/api/school-mode")) return null;

  if (url.pathname === "/api/school-mode" && req.method === "GET") {
    return jsonResponse(schoolModeStatePayload(), 200, req, config);
  }

  if (url.pathname === "/api/school-mode/enable" && req.method === "POST") {
    const { record } = readSchoolModeRecord();
    if (!record.credential) {
      return jsonResponse(
        { error: "no-credential", message: "Set an unlock PIN or password before turning School Mode on, so there is a way to turn it off again." },
        409, req, config,
      );
    }
    if (record.enabled) return jsonResponse(schoolModeStatePayload(), 200, req, config);
    const next: SchoolModeRecord = { ...record, enabled: true, updatedAt: Date.now() };
    writeSchoolModeRecordAtomic(next);
    return jsonResponse(schoolModeStatePayload(), 200, req, config);
  }

  if (url.pathname === "/api/school-mode/disable" && req.method === "POST") {
    const body = await readJsonBody(req);
    const secret = body?.secret;
    const { record } = readSchoolModeRecord();
    if (!record.enabled) return jsonResponse(schoolModeStatePayload(), 200, req, config);
    if (!record.credential) {
      // Should not normally happen (enable refuses without a credential), but a
      // hand-edited or foreign-app-written record could reach this shape. The
      // documented recovery is deleting the shared file, exactly as it would
      // be for a forgotten credential.
      return jsonResponse(
        { error: "no-credential", message: "No unlock credential is on record. Delete the shared School Mode file to reset it.", recordDir: schoolModeDir() },
        409, req, config,
      );
    }
    if (typeof secret !== "string" || !verifyCredential(secret, record.credential)) {
      return jsonResponse({ error: "invalid-credential", message: "That PIN or password did not match." }, 401, req, config);
    }
    const next: SchoolModeRecord = { ...record, enabled: false, updatedAt: Date.now() };
    writeSchoolModeRecordAtomic(next);
    return jsonResponse(schoolModeStatePayload(), 200, req, config);
  }

  if (url.pathname === "/api/school-mode/credential" && req.method === "POST") {
    const body = await readJsonBody(req);
    const newSecret = body?.newSecret;
    const currentSecret = body?.currentSecret;
    const { record } = readSchoolModeRecord();

    if (record.credential) {
      if (typeof currentSecret !== "string" || !verifyCredential(currentSecret, record.credential)) {
        return jsonResponse({ error: "invalid-credential", message: "The current PIN or password did not match." }, 401, req, config);
      }
    }

    const validation = validateSchoolModeSecret(newSecret);
    if (!validation.ok) {
      const message = validation.reason === "too-long"
        ? `Use at most ${SCHOOL_MODE_MAX_SECRET_LENGTH} characters.`
        : `Use at least ${SCHOOL_MODE_MIN_SECRET_LENGTH} characters.`;
      return jsonResponse({ error: validation.reason, message }, 400, req, config);
    }

    const next: SchoolModeRecord = {
      ...record,
      credential: hashCredential(newSecret as string),
      updatedAt: Date.now(),
    };
    writeSchoolModeRecordAtomic(next);
    return jsonResponse(schoolModeStatePayload(), 200, req, config);
  }

  if (url.pathname === "/api/school-mode/rename" && req.method === "POST") {
    const body = await readJsonBody(req);
    const name = body?.name === undefined ? null : body.name;
    if (!validateSchoolModeName(name)) {
      return jsonResponse({ error: "invalid-name", message: "That name is empty or too long." }, 400, req, config);
    }
    const { record } = readSchoolModeRecord();
    const trimmed = typeof name === "string" ? name.trim() : null;
    const next: SchoolModeRecord = { ...record, customName: trimmed && trimmed.length > 0 ? trimmed : null, updatedAt: Date.now() };
    writeSchoolModeRecordAtomic(next);
    return jsonResponse(schoolModeStatePayload(), 200, req, config);
  }

  return null;
}

export { DEFAULT_SCHOOL_MODE_RECORD };
