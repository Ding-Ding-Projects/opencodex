/**
 * `/api/host/authenticator/*` — the built-in TOTP authenticator's API.
 *
 * Two registration routes feed one confirmation route, on purpose: whether a
 * secret is freshly generated (this app is the one issuing a factor — the
 * "TOTP registration shows a QR" contract) or imported from a pasted
 * `otpauth://` URI or manual fields (this app is the *authenticator side* of
 * someone else's registration — the "built-in authenticator" contract), both
 * land in the same pending-then-confirm flow, because a mis-scanned QR and a
 * mistyped secret are exactly the same risk in both directions. Neither path
 * writes to disk until `pending/confirm` verifies one live code.
 *
 * Every response that carries a live code, or the moment a secret is created,
 * includes `serverTime` (epoch ms) so the GUI can report client/server clock
 * skew — the one honest clock signal available without a network call (see
 * `secondsRemaining`/`totpStep` in `src/lib/totp.ts` and the GUI's
 * `authenticator-clock.ts`).
 */

import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import {
  addAuthenticatorEntry,
  addAuthenticatorGroup,
  bulkSetGroup,
  getAuthenticatorEntry,
  loadAuthenticatorEntries,
  loadAuthenticatorGroups,
  removeAuthenticatorEntries,
  removeAuthenticatorEntry,
  removeAuthenticatorGroup,
  replaceAuthenticatorState,
  toEntryMeta,
  updateAuthenticatorEntry,
  updateAuthenticatorGroup,
  type AuthenticatorEntryMeta,
} from "../../lib/authenticator-store";
import {
  getSecretHistoryRetentionDays,
  listSecretHistoryEntries,
  recordSecretHistoryMutation,
  restoreSecretHistorySnapshot,
  setSecretHistoryRetentionDays,
} from "../../lib/secret-history";
import {
  checkPendingRegistrationCode,
  createPendingRegistration,
  discardPendingRegistration,
  getPendingRegistration,
} from "../../lib/pending-authenticator-registrations";
import { buildOtpauthUri, OtpauthUriError, parseOtpauthUri, secretBytes } from "../../lib/otpauth-uri";
import {
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  MAX_DIGITS,
  MIN_DIGITS,
  TOTP_ALGORITHMS,
  generateSecret,
  secondsRemaining,
  totp,
  totpStep,
  type TotpAlgorithm,
} from "../../lib/totp";
import { base32Encode, isValidBase32 } from "../../lib/base32";

function isTotpAlgorithm(value: unknown): value is TotpAlgorithm {
  return typeof value === "string" && (TOTP_ALGORITHMS as readonly string[]).includes(value);
}

/** Shared field validation for both the generate and manual-import branches of `pending`. */
function normalizeAlgorithmDigitsPeriod(body: Record<string, unknown>): { algorithm: TotpAlgorithm; digits: number; period: number } | { error: string } {
  const algorithm = body.algorithm === undefined ? DEFAULT_ALGORITHM : body.algorithm;
  if (!isTotpAlgorithm(algorithm)) return { error: `algorithm must be one of ${TOTP_ALGORITHMS.join(", ")}` };
  const digits = body.digits === undefined ? DEFAULT_DIGITS : Number(body.digits);
  if (!Number.isInteger(digits) || digits < MIN_DIGITS || digits > MAX_DIGITS) {
    return { error: `digits must be an integer ${MIN_DIGITS}-${MAX_DIGITS}` };
  }
  const period = body.period === undefined ? DEFAULT_PERIOD : Number(body.period);
  if (!Number.isFinite(period) || period <= 0) return { error: "period must be a positive number of seconds" };
  return { algorithm, digits, period };
}

function entryCodeResponse(entry: { secret: string; algorithm: TotpAlgorithm; digits: number; period: number }) {
  const now = Date.now() / 1000;
  const step = totpStep(now, entry.period);
  const bytes = secretBytes(entry.secret);
  const code = totp(bytes, { algorithm: entry.algorithm, digits: entry.digits, period: entry.period, time: now });
  const nextCode = totp(bytes, { algorithm: entry.algorithm, digits: entry.digits, period: entry.period, time: (step + 1) * entry.period });
  const periodStart = step * entry.period;
  return {
    code,
    nextCode,
    digits: entry.digits,
    period: entry.period,
    periodStart: Math.round(periodStart * 1000),
    periodEnd: Math.round((periodStart + entry.period) * 1000),
    secondsRemaining: secondsRemaining(entry.period, now),
    serverTime: Date.now(),
  };
}

/**
 * Records one TOTP-entry mutation into the secret history: called AFTER the
 * real mutation on `authenticator.json` already succeeded, and its return
 * value never unwinds that mutation on failure — see `secret-history.ts`'s
 * module header. The sensitive payload is always the FULL current state
 * (entries with secrets, plus groups), not just the one entry that changed,
 * so a restore can bring back more than a single field; `redacted` carries
 * the same state with every secret stripped, which is what the history
 * manager browses and diffs without ever touching the vault key.
 *
 * Awaited by every call site (rather than fire-and-forget) specifically so
 * `historyRecorded`/`historyReason` can ride along in the same response the
 * GUI already reads — a silent fire-and-forget commit would make the
 * contract's "fail-safe and VISIBLE" requirement unreachable from the client.
 */
async function recordTotpHistory(
  action: string,
  changed?: { id: string; issuer: string; account: string },
): Promise<{ historyRecorded: boolean; historyReason?: string }> {
  const entries = loadAuthenticatorEntries();
  const groups = loadAuthenticatorGroups();
  const result = await recordSecretHistoryMutation({
    kind: "totp-entry",
    action,
    redacted: {
      entries: entries.map(toEntryMeta),
      groups,
      ...(changed ? { changedEntryId: changed.id, changedIssuer: changed.issuer, changedAccount: changed.account } : {}),
    },
    sensitive: { entries, groups },
  });
  return { historyRecorded: result.recorded, historyReason: result.reason };
}

export async function handleAuthenticatorRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  const respond = (data: unknown, status = 200) => jsonResponse(data, status, req, config);

  /* -------------------------------------------------------------- list */

  if (url.pathname === "/api/host/authenticator" && req.method === "GET") {
    const entries = loadAuthenticatorEntries().map(toEntryMeta) as AuthenticatorEntryMeta[];
    const groups = loadAuthenticatorGroups();
    return respond({ entries, groups, serverTime: Date.now() });
  }

  /* -------------------------------------------------------------- live code */

  if (url.pathname === "/api/host/authenticator/code" && req.method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    const entry = id ? getAuthenticatorEntry(id) : null;
    if (!entry) return respond({ error: "entry not found" }, 404);
    return respond(entryCodeResponse(entry));
  }

  /* -------------------------------------------------------------- registration: generate or import, pending confirmation */

  if (url.pathname === "/api/host/authenticator/pending" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    const mode = body.mode;
    const groupId = typeof body.groupId === "string" ? body.groupId : null;

    if (mode === "generate") {
      const issuer = typeof body.issuer === "string" ? body.issuer : "";
      const account = typeof body.account === "string" ? body.account.trim() : "";
      if (!account) return respond({ error: "account is required" }, 400);
      const parsed = normalizeAlgorithmDigitsPeriod(body);
      if ("error" in parsed) return respond({ error: parsed.error }, 400);
      const secretBytesValue = generateSecret(parsed.algorithm);
      const secret = base32Encode(secretBytesValue, { padding: false });
      const reg = createPendingRegistration({ issuer, account, secret, ...parsed, groupId });
      const otpauthUri = buildOtpauthUri({ issuer, account, secret, ...parsed });
      return respond({
        pendingId: reg.id, otpauthUri, secret, issuer: reg.issuer, account: reg.account,
        algorithm: reg.algorithm, digits: reg.digits, period: reg.period,
        expiresAt: reg.expiresAt, serverTime: Date.now(),
      });
    }

    if (mode === "import") {
      let issuer: string, account: string, secret: string, algorithm: TotpAlgorithm, digits: number, period: number;
      if (typeof body.otpauthUri === "string") {
        try {
          const parsedUri = parseOtpauthUri(body.otpauthUri);
          ({ issuer, account, secret, algorithm, digits, period } = parsedUri);
        } catch (error) {
          return respond({ error: error instanceof OtpauthUriError ? error.message : "could not parse otpauth:// URI" }, 400);
        }
      } else {
        issuer = typeof body.issuer === "string" ? body.issuer : "";
        account = typeof body.account === "string" ? body.account.trim() : "";
        secret = typeof body.secret === "string" ? body.secret.trim() : "";
        if (!account) return respond({ error: "account is required" }, 400);
        if (!secret || !isValidBase32(secret)) return respond({ error: "secret must be valid base32" }, 400);
        const parsed = normalizeAlgorithmDigitsPeriod(body);
        if ("error" in parsed) return respond({ error: parsed.error }, 400);
        ({ algorithm, digits, period } = parsed);
      }
      const reg = createPendingRegistration({ issuer, account, secret, algorithm, digits, period, groupId });
      const otpauthUri = buildOtpauthUri({ issuer, account, secret, algorithm, digits, period });
      return respond({
        pendingId: reg.id, otpauthUri, secret, issuer: reg.issuer, account: reg.account,
        algorithm: reg.algorithm, digits: reg.digits, period: reg.period,
        expiresAt: reg.expiresAt, serverTime: Date.now(),
      });
    }

    return respond({ error: 'mode must be "generate" or "import"' }, 400);
  }

  if (url.pathname === "/api/host/authenticator/pending/confirm" && req.method === "POST") {
    let body: { pendingId?: unknown; code?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    const pendingId = typeof body.pendingId === "string" ? body.pendingId : "";
    const code = typeof body.code === "string" ? body.code : "";
    if (!pendingId || !code) return respond({ error: "pendingId and code are required" }, 400);
    const result = checkPendingRegistrationCode(pendingId, code);
    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        "not-found": "This registration has already been used, cancelled, or never existed.",
        expired: "This registration expired. Start again and confirm within 10 minutes.",
        locked: "Too many wrong codes. Start the registration again.",
        "wrong-code": "That code did not match. Check the time on this device and try again.",
      };
      const status = result.reason === "wrong-code" ? 400 : result.reason === "not-found" ? 404 : 410;
      return respond({ error: messages[result.reason], reason: result.reason, attemptsRemaining: "attemptsRemaining" in result ? result.attemptsRemaining : undefined }, status);
    }
    const reg = result.registration;
    const entry = addAuthenticatorEntry({
      issuer: reg.issuer, account: reg.account, secret: reg.secret,
      algorithm: reg.algorithm, digits: reg.digits, period: reg.period, groupId: reg.groupId,
    });
    discardPendingRegistration(reg.id);
    const history = await recordTotpHistory("created", { id: entry.id, issuer: entry.issuer, account: entry.account });
    return respond({ entry: toEntryMeta(entry), ...history });
  }

  if (url.pathname === "/api/host/authenticator/pending" && req.method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    if (!id) return respond({ error: "missing id" }, 400);
    const existed = getPendingRegistration(id) !== null;
    discardPendingRegistration(id);
    return respond({ ok: true, existed });
  }

  /* -------------------------------------------------------------- entry mutation */

  if (url.pathname === "/api/host/authenticator/entry" && req.method === "PATCH") {
    const id = url.searchParams.get("id") ?? "";
    if (!id) return respond({ error: "missing id" }, 400);
    let body: { issuer?: unknown; account?: unknown; groupId?: unknown; order?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    const patch: Parameters<typeof updateAuthenticatorEntry>[1] = {};
    if (typeof body.issuer === "string") patch.issuer = body.issuer;
    if (typeof body.account === "string") patch.account = body.account;
    if (body.groupId === null || typeof body.groupId === "string") patch.groupId = body.groupId;
    if (typeof body.order === "number") patch.order = body.order;
    const updated = updateAuthenticatorEntry(id, patch);
    if (!updated) return respond({ error: "entry not found" }, 404);
    const history = await recordTotpHistory("updated", { id: updated.id, issuer: updated.issuer, account: updated.account });
    return respond({ entry: toEntryMeta(updated), ...history });
  }

  if (url.pathname === "/api/host/authenticator/entry" && req.method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    if (!id) return respond({ error: "missing id" }, 400);
    // Read before removing so the redacted "what was deleted" summary can name it.
    const before = getAuthenticatorEntry(id);
    const removed = removeAuthenticatorEntry(id);
    if (removed === 0) return respond({ error: "entry not found" }, 404);
    const history = await recordTotpHistory("removed", before ? { id: before.id, issuer: before.issuer, account: before.account } : undefined);
    return respond({ ok: true, ...history });
  }

  if (url.pathname === "/api/host/authenticator/bulk-delete" && req.method === "POST") {
    let body: { ids?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : [];
    if (ids.length === 0) return respond({ error: "ids must be a non-empty array" }, 400);
    const removed = removeAuthenticatorEntries(ids);
    const history = removed.length > 0 ? await recordTotpHistory("bulk-removed") : { historyRecorded: true as const };
    return respond({ removed, skipped: ids.filter(id => !removed.includes(id)), ...history });
  }

  if (url.pathname === "/api/host/authenticator/bulk-group" && req.method === "POST") {
    let body: { ids?: unknown; groupId?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : [];
    const groupId = body.groupId === null || typeof body.groupId === "string" ? body.groupId : null;
    if (ids.length === 0) return respond({ error: "ids must be a non-empty array" }, 400);
    const touched = bulkSetGroup(ids, groupId);
    return respond({ touched, skipped: ids.filter(id => !touched.includes(id)) });
  }

  /* -------------------------------------------------------------- groups */

  if (url.pathname === "/api/host/authenticator/groups" && req.method === "POST") {
    let body: { name?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return respond({ error: "name is required" }, 400);
    return respond({ group: addAuthenticatorGroup(name) });
  }

  if (url.pathname === "/api/host/authenticator/groups" && req.method === "PATCH") {
    const id = url.searchParams.get("id") ?? "";
    if (!id) return respond({ error: "missing id" }, 400);
    let body: { name?: unknown; order?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    const patch: { name?: string; order?: number } = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.order === "number") patch.order = body.order;
    const group = updateAuthenticatorGroup(id, patch);
    if (!group) return respond({ error: "group not found" }, 404);
    return respond({ group });
  }

  if (url.pathname === "/api/host/authenticator/groups" && req.method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    if (!id) return respond({ error: "missing id" }, 400);
    if (!removeAuthenticatorGroup(id)) return respond({ error: "group not found" }, 404);
    return respond({ ok: true });
  }

  /* -------------------------------------------------------------- secrets export (super-confirm gated on the GUI side; `confirmed` is defense in depth) */

  if (url.pathname === "/api/host/authenticator/export-secrets" && req.method === "POST") {
    let body: { confirmed?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    if (body.confirmed !== true) {
      return respond({ error: "this export writes usable secrets in the clear and requires explicit confirmation" }, 400);
    }
    const entries = loadAuthenticatorEntries();
    const groups = loadAuthenticatorGroups();
    const rows = entries.map(e => ({
      issuer: e.issuer,
      account: e.account,
      secret: e.secret,
      algorithm: e.algorithm,
      digits: e.digits,
      period: e.period,
      otpauthUri: buildOtpauthUri(e),
      group: groups.find(g => g.id === e.groupId)?.name ?? "",
    }));
    return respond({
      warning: "This file contains usable TOTP secrets in plain text. Anyone who reads it can generate valid codes for every entry below. Store it nowhere but a password manager, and delete it as soon as you have moved it.",
      exportedAt: new Date().toISOString(),
      entries: rows,
    });
  }

  /* -------------------------------------------------------------- secret & display-name history
   *
   * These routes carry no server-side credential of their own — this app has
   * no multi-user auth model, exactly like every other route above. The
   * password/TOTP gate the contract requires is enforced client-side (the
   * built-in toy-lock credential system, `gui/src/shell/credential-vault.ts`,
   * reused under its own fixed lock id) before the GUI ever calls these.
   * `confirmed: true` on the mutating routes is the same defense-in-depth
   * `export-secrets` above already uses: not the real gate, a second check
   * that a script cannot accidentally satisfy by omission.
   */

  if (url.pathname === "/api/host/authenticator/history" && req.method === "GET") {
    return respond({
      entries: listSecretHistoryEntries(200),
      retentionDays: getSecretHistoryRetentionDays(),
    });
  }

  if (url.pathname === "/api/host/authenticator/history/restore" && req.method === "POST") {
    let body: { hash?: unknown; confirmed?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    if (body.confirmed !== true) return respond({ error: "a history restore requires explicit confirmation" }, 400);
    const hash = typeof body.hash === "string" ? body.hash : "";
    if (!hash) return respond({ error: "hash is required" }, 400);

    const snapshot = await restoreSecretHistorySnapshot(hash);
    if (!snapshot.ok) return respond({ error: `could not restore that revision: ${snapshot.reason}`, reason: snapshot.reason }, 409);

    if (snapshot.kind === "totp-entry") {
      const payload = snapshot.sensitive as { entries?: unknown; groups?: unknown } | undefined;
      if (!payload) return respond({ error: "that revision has no recoverable snapshot", reason: "not-found" }, 409);
      const { entries, groups } = replaceAuthenticatorState(payload.entries, payload.groups);
      const history = await recordTotpHistory("restored");
      return respond({
        ok: true, kind: "totp-entry",
        entries: entries.map(toEntryMeta), groups,
        ...history,
      });
    }

    if (snapshot.kind === "display-name") {
      const redacted = snapshot.redacted as { previous?: unknown; next?: unknown } | undefined;
      const value = typeof redacted?.next === "string" ? redacted.next : null;
      // The GUI applies `value` to `theme/app-name.ts` itself (that store is a
      // browser-only singleton this server never touches) and then calls the
      // display-name history route below with action "restored" to record it.
      return respond({ ok: true, kind: "display-name", value });
    }

    return respond({ error: `unknown history kind "${snapshot.kind}"` }, 409);
  }

  if (url.pathname === "/api/host/authenticator/history/export" && req.method === "POST") {
    let body: { confirmed?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    if (body.confirmed !== true) return respond({ error: "exporting history requires explicit confirmation" }, 400);
    return respond({
      warning: "This export carries only redacted metadata — issuer, account, group, timestamps, display-name changes. It never carries a TOTP secret.",
      exportedAt: new Date().toISOString(),
      entries: listSecretHistoryEntries(500),
    });
  }

  if (url.pathname === "/api/host/authenticator/history/retention" && req.method === "POST") {
    let body: { days?: unknown; confirmed?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    if (body.confirmed !== true) return respond({ error: "changing retention requires explicit confirmation" }, 400);
    const days = body.days === null ? null : Number(body.days);
    if (days !== null && (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0)) {
      return respond({ error: "days must be a positive integer or null" }, 400);
    }
    const result = await setSecretHistoryRetentionDays(days);
    return respond({ ...result, retentionDays: getSecretHistoryRetentionDays() }, result.ok ? 200 : 409);
  }

  /**
   * The one mutation this server does not own: the display name lives only in
   * the GUI's browser-local `theme/app-name.ts` store. The GUI calls this
   * AFTER that store already committed the rename, exactly like every other
   * history route — best-effort, reported back rather than silently dropped.
   */
  if (url.pathname === "/api/host/authenticator/history/display-name" && req.method === "POST") {
    let body: { action?: unknown; previous?: unknown; next?: unknown };
    try { body = await req.json(); } catch { return respond({ error: "malformed request body" }, 400); }
    const action = typeof body.action === "string" ? body.action : "renamed";
    const previous = typeof body.previous === "string" ? body.previous : "";
    const next = typeof body.next === "string" ? body.next : "";
    const result = await recordSecretHistoryMutation({
      kind: "display-name",
      action,
      redacted: { previous, next },
      sensitive: null,
    });
    return respond({ historyRecorded: result.recorded, historyReason: result.reason });
  }

  return null;
}
