/**
 * The `/api/host/authenticator/*` surface end to end: registration never
 * persists until a real code confirms it, the list never leaks a secret, a
 * bad confirmation code is refused and counted, and the secrets export
 * refuses to run without `confirmed: true`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import { resetPendingRegistrationsForTests } from "../src/lib/pending-authenticator-registrations";
import { totp } from "../src/lib/totp";
import { secretBytes } from "../src/lib/otpauth-uri";
import { removeTempDir } from "./helpers/temp-dir";
// Shadows the global `Request`: a direct-handler test call bypasses the real HTTP
// server, so nothing sets the `Host` header a live request would carry, and
// `isAllowedManagementOrigin` refuses anything without one. `ManagementRequest`
// supplies exactly the header a real server would (see tests/helpers/management-auth.ts).
import { ManagementRequest as Request } from "./helpers/management-auth";

let dir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  dir = mkdtempSync(join(tmpdir(), "ocx-authroutes-"));
  process.env.OPENCODEX_HOME = dir;
  mkdirSync(dir, { recursive: true });
  resetPendingRegistrationsForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (dir) removeTempDir(dir);
  resetPendingRegistrationsForTests();
});

async function call(pathname: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  const url = new URL(`http://localhost${pathname}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const { query: _q, ...rest } = init;
  const req = new Request(url, {
    ...rest,
    headers: { "content-type": "application/json", ...(rest.headers as Record<string, string> | undefined) },
  });
  const res = await handleManagementAPI(req, url, loadConfig());
  expect(res).not.toBeNull();
  const body = await res!.json();
  return { status: res!.status, body };
}

describe("GET /api/host/authenticator", () => {
  test("starts empty and never includes a secret field", async () => {
    const { status, body } = await call("/api/host/authenticator");
    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.groups).toEqual([]);
    expect(typeof body.serverTime).toBe("number");
  });
});

describe("registration: generate -> confirm", () => {
  test("generate creates a pending secret and does not persist an entry", async () => {
    const { status, body } = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({ mode: "generate", issuer: "Example", account: "alice@example.com" }),
    });
    expect(status).toBe(200);
    expect(body.pendingId).toBeTruthy();
    expect(body.otpauthUri).toContain("otpauth://totp/");
    expect(typeof body.secret).toBe("string");
    expect(body.algorithm).toBe("SHA1");
    expect(body.digits).toBe(6);
    expect(body.period).toBe(30);

    const list = await call("/api/host/authenticator");
    expect(list.body.entries).toEqual([]); // still nothing persisted
  });

  test("confirming with the real current code persists the entry and discards the pending row", async () => {
    const gen = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({ mode: "generate", issuer: "Example", account: "alice@example.com" }),
    });
    const code = totp(secretBytes(gen.body.secret), { algorithm: gen.body.algorithm, digits: gen.body.digits, period: gen.body.period });
    const confirm = await call("/api/host/authenticator/pending/confirm", {
      method: "POST",
      body: JSON.stringify({ pendingId: gen.body.pendingId, code }),
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.entry.issuer).toBe("Example");
    expect(confirm.body.entry.account).toBe("alice@example.com");
    expect(confirm.body.entry.secret).toBeUndefined();

    const list = await call("/api/host/authenticator");
    expect(list.body.entries.length).toBe(1);
    expect(list.body.entries[0].id).toBe(confirm.body.entry.id);

    // The pending id is now dead — confirming again fails.
    const again = await call("/api/host/authenticator/pending/confirm", {
      method: "POST",
      body: JSON.stringify({ pendingId: gen.body.pendingId, code }),
    });
    expect(again.status).toBe(404);
    expect(again.body.reason).toBe("not-found");
  });

  test("a wrong code is refused, reports attempts remaining, and persists nothing", async () => {
    const gen = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({ mode: "generate", issuer: "X", account: "a" }),
    });
    const wrong = await call("/api/host/authenticator/pending/confirm", {
      method: "POST",
      body: JSON.stringify({ pendingId: gen.body.pendingId, code: "000000" }),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.reason).toBe("wrong-code");
    expect(typeof wrong.body.attemptsRemaining).toBe("number");

    const list = await call("/api/host/authenticator");
    expect(list.body.entries).toEqual([]);
  });

  test("generate requires an account", async () => {
    const { status, body } = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({ mode: "generate", issuer: "X", account: "" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/account/i);
  });
});

describe("registration: import", () => {
  test("import from an otpauth:// URI requires confirmation exactly like generate", async () => {
    const gen = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({
        mode: "import",
        otpauthUri: "otpauth://totp/GitHub:bob?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30",
      }),
    });
    expect(gen.status).toBe(200);
    expect(gen.body.issuer).toBe("GitHub");
    expect(gen.body.account).toBe("bob");
    expect(gen.body.secret).toBe("JBSWY3DPEHPK3PXP");

    const listBeforeConfirm = await call("/api/host/authenticator");
    expect(listBeforeConfirm.body.entries).toEqual([]);

    const code = totp(secretBytes(gen.body.secret), { algorithm: gen.body.algorithm, digits: gen.body.digits, period: gen.body.period });
    const confirm = await call("/api/host/authenticator/pending/confirm", {
      method: "POST",
      body: JSON.stringify({ pendingId: gen.body.pendingId, code }),
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.entry.issuer).toBe("GitHub");
  });

  test("import from manual fields validates the secret is base32", async () => {
    const { status, body } = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({ mode: "import", issuer: "X", account: "a", secret: "not valid base32 !!" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/base32/i);
  });

  test("import rejects a malformed otpauth URI with a specific message", async () => {
    const { status, body } = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({ mode: "import", otpauthUri: "not a uri" }),
    });
    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
  });

  test("unknown mode is rejected", async () => {
    const { status } = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({ mode: "teleport" }),
    });
    expect(status).toBe(400);
  });
});

describe("DELETE /api/host/authenticator/pending", () => {
  test("cancels a pending registration", async () => {
    const gen = await call("/api/host/authenticator/pending", {
      method: "POST",
      body: JSON.stringify({ mode: "generate", issuer: "X", account: "a" }),
    });
    const del = await call("/api/host/authenticator/pending", { method: "DELETE", query: { id: gen.body.pendingId } });
    expect(del.body.existed).toBe(true);
    const code = totp(secretBytes(gen.body.secret), { algorithm: gen.body.algorithm, digits: gen.body.digits, period: gen.body.period });
    const confirmAfterCancel = await call("/api/host/authenticator/pending/confirm", {
      method: "POST",
      body: JSON.stringify({ pendingId: gen.body.pendingId, code }),
    });
    expect(confirmAfterCancel.status).toBe(404);
  });
});

async function confirmedEntry(issuer: string, account: string) {
  const gen = await call("/api/host/authenticator/pending", {
    method: "POST",
    body: JSON.stringify({ mode: "generate", issuer, account }),
  });
  const code = totp(secretBytes(gen.body.secret), { algorithm: gen.body.algorithm, digits: gen.body.digits, period: gen.body.period });
  const confirm = await call("/api/host/authenticator/pending/confirm", {
    method: "POST",
    body: JSON.stringify({ pendingId: gen.body.pendingId, code }),
  });
  return confirm.body.entry;
}

describe("GET /api/host/authenticator/code", () => {
  test("returns a live code, next code and countdown for a real entry", async () => {
    const entry = await confirmedEntry("X", "a");
    const { status, body } = await call("/api/host/authenticator/code", { query: { id: entry.id } });
    expect(status).toBe(200);
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.nextCode).toMatch(/^\d{6}$/);
    expect(body.period).toBe(30);
    expect(typeof body.secondsRemaining).toBe("number");
    expect(body.secondsRemaining).toBeGreaterThan(0);
    expect(body.secondsRemaining).toBeLessThanOrEqual(30);
  });

  test("404s for an unknown entry", async () => {
    const { status } = await call("/api/host/authenticator/code", { query: { id: "nope" } });
    expect(status).toBe(404);
  });
});

describe("PATCH /entry, DELETE /entry, bulk operations", () => {
  test("rename via PATCH", async () => {
    const entry = await confirmedEntry("Old", "a");
    const { status, body } = await call("/api/host/authenticator/entry", {
      method: "PATCH",
      query: { id: entry.id },
      body: JSON.stringify({ issuer: "New" }),
    });
    expect(status).toBe(200);
    expect(body.entry.issuer).toBe("New");
  });

  test("DELETE removes the entry", async () => {
    const entry = await confirmedEntry("X", "a");
    const del = await call("/api/host/authenticator/entry", { method: "DELETE", query: { id: entry.id } });
    expect(del.status).toBe(200);
    const list = await call("/api/host/authenticator");
    expect(list.body.entries).toEqual([]);
  });

  test("DELETE 404s for an unknown id", async () => {
    const del = await call("/api/host/authenticator/entry", { method: "DELETE", query: { id: "nope" } });
    expect(del.status).toBe(404);
  });

  test("bulk-delete removes multiple and reports skipped ids honestly", async () => {
    const a = await confirmedEntry("X", "a");
    const b = await confirmedEntry("X", "b");
    const { body } = await call("/api/host/authenticator/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: [a.id, b.id, "nope"] }),
    });
    expect(body.removed.sort()).toEqual([a.id, b.id].sort());
    expect(body.skipped).toEqual(["nope"]);
  });

  test("bulk-group assigns a group to multiple entries", async () => {
    const a = await confirmedEntry("X", "a");
    const b = await confirmedEntry("X", "b");
    const group = await call("/api/host/authenticator/groups", { method: "POST", body: JSON.stringify({ name: "Work" }) });
    const { body } = await call("/api/host/authenticator/bulk-group", {
      method: "POST",
      body: JSON.stringify({ ids: [a.id, b.id], groupId: group.body.group.id }),
    });
    expect(body.touched.sort()).toEqual([a.id, b.id].sort());
    const list = await call("/api/host/authenticator");
    expect(list.body.entries.every((e: any) => e.groupId === group.body.group.id)).toBe(true);
  });
});

describe("groups CRUD", () => {
  test("create, rename, delete ungroups members", async () => {
    const created = await call("/api/host/authenticator/groups", { method: "POST", body: JSON.stringify({ name: "Work" }) });
    expect(created.status).toBe(200);
    const groupId = created.body.group.id;

    const entry = await confirmedEntry("X", "a");
    await call("/api/host/authenticator/entry", { method: "PATCH", query: { id: entry.id }, body: JSON.stringify({ groupId }) });

    const renamed = await call("/api/host/authenticator/groups", { method: "PATCH", query: { id: groupId }, body: JSON.stringify({ name: "Personal" }) });
    expect(renamed.body.group.name).toBe("Personal");

    const deleted = await call("/api/host/authenticator/groups", { method: "DELETE", query: { id: groupId } });
    expect(deleted.status).toBe(200);

    const list = await call("/api/host/authenticator");
    expect(list.body.entries[0].groupId).toBeNull();
    expect(list.body.groups).toEqual([]);
  });
});

describe("POST /api/host/authenticator/export-secrets", () => {
  test("refuses without confirmed: true", async () => {
    await confirmedEntry("X", "a");
    const { status, body } = await call("/api/host/authenticator/export-secrets", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/confirm/i);
  });

  test("with confirmed: true, returns entries WITH secrets and a plain-text warning", async () => {
    const entry = await confirmedEntry("X", "alice");
    const { status, body } = await call("/api/host/authenticator/export-secrets", {
      method: "POST",
      body: JSON.stringify({ confirmed: true }),
    });
    expect(status).toBe(200);
    expect(body.warning).toMatch(/plain text/i);
    expect(body.entries.length).toBe(1);
    expect(typeof body.entries[0].secret).toBe("string");
    expect(body.entries[0].secret.length).toBeGreaterThan(0);
    expect(body.entries[0].otpauthUri).toContain("otpauth://totp/");
    expect(body.entries[0].account).toBe("alice");
    void entry;
  });
});

/**
 * `/api/host/authenticator/history*` end to end — real git, real DPAPI,
 * exactly like `tests/secret-history.test.ts`. This file already spawns real
 * processes for every other authenticator test, so the same 30s budget
 * applies here for the same reason `cli-export-history.test.ts` documents.
 */
describe("secret & display-name mutation history", () => {
  const HISTORY_TEST_TIMEOUT_MS = 30_000;

  test("creating, editing and removing an entry each land as their own history commit, with historyRecorded reported back", async () => {
    const created = await confirmedEntry("Example", "alice@example.com");
    // The create route call above is `confirmedEntry`'s own `call(...)`, which
    // does not surface `historyRecorded` to this test — read it back from the
    // route's OWN response instead by making the call directly this time.
    const gen = await call("/api/host/authenticator/pending", { method: "POST", body: JSON.stringify({ mode: "generate", issuer: "X", account: "b" }) });
    const code = totp(secretBytes(gen.body.secret), { algorithm: gen.body.algorithm, digits: gen.body.digits, period: gen.body.period });
    const confirmed = await call("/api/host/authenticator/pending/confirm", { method: "POST", body: JSON.stringify({ pendingId: gen.body.pendingId, code }) });
    expect(confirmed.body.historyRecorded).toBe(true);

    const patched = await call("/api/host/authenticator/entry", {
      method: "PATCH", query: { id: created.id }, body: JSON.stringify({ issuer: "Renamed" }),
    });
    expect(patched.body.historyRecorded).toBe(true);

    const deleted = await call("/api/host/authenticator/entry", { method: "DELETE", query: { id: confirmed.body.entry.id } });
    expect(deleted.body.historyRecorded).toBe(true);

    const history = await call("/api/host/authenticator/history");
    expect(history.status).toBe(200);
    const actions = history.body.entries.map((e: any) => e.action);
    expect(actions).toEqual(["removed", "updated", "created", "created"]); // newest first
    expect(actions.every((a: string) => a !== undefined)).toBe(true);
    // No entry's redacted metadata ever carries a `secret` field.
    for (const entry of history.body.entries) {
      expect(JSON.stringify(entry.redacted)).not.toContain("secret");
    }
  }, HISTORY_TEST_TIMEOUT_MS);

  test("restoring a totp-entry history commit brings the removed account back, secret included", async () => {
    const entry = await confirmedEntry("Example", "restore-me@example.com");
    const beforeDelete = await call("/api/host/authenticator/export-secrets", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    const originalSecret = beforeDelete.body.entries[0].secret;

    await call("/api/host/authenticator/entry", { method: "DELETE", query: { id: entry.id } });
    expect((await call("/api/host/authenticator")).body.entries).toEqual([]);

    const history = await call("/api/host/authenticator/history");
    // The commit taken BEFORE the delete — i.e. the "created" one — is what
    // still has the entry in it; "removed" is the state with it already gone.
    const createdCommit = history.body.entries.find((e: any) => e.action === "created");
    expect(createdCommit).toBeTruthy();

    const restore = await call("/api/host/authenticator/history/restore", {
      method: "POST", body: JSON.stringify({ hash: createdCommit.hash, confirmed: true }),
    });
    expect(restore.status).toBe(200);
    expect(restore.body.ok).toBe(true);
    expect(restore.body.kind).toBe("totp-entry");
    expect(restore.body.entries).toHaveLength(1);
    expect(restore.body.historyRecorded).toBe(true);

    const after = await call("/api/host/authenticator");
    expect(after.body.entries).toHaveLength(1);
    expect(after.body.entries[0].account).toBe("restore-me@example.com");

    const secretsAfter = await call("/api/host/authenticator/export-secrets", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    expect(secretsAfter.body.entries[0].secret).toBe(originalSecret);
  }, HISTORY_TEST_TIMEOUT_MS);

  test("restore refuses without confirmed: true, and rejects a missing hash", async () => {
    const noConfirm = await call("/api/host/authenticator/history/restore", { method: "POST", body: JSON.stringify({ hash: "abc1234" }) });
    expect(noConfirm.status).toBe(400);

    const noHash = await call("/api/host/authenticator/history/restore", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    expect(noHash.status).toBe(400);
  });

  test("the display-name history route records a rename, distinct from a totp-entry mutation", async () => {
    const recorded = await call("/api/host/authenticator/history/display-name", {
      method: "POST", body: JSON.stringify({ action: "renamed", previous: "opencodex", next: "My Robot" }),
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body.historyRecorded).toBe(true);

    const history = await call("/api/host/authenticator/history");
    expect(history.body.entries).toHaveLength(1);
    expect(history.body.entries[0].kind).toBe("display-name");
    expect(history.body.entries[0].redacted).toEqual({ previous: "opencodex", next: "My Robot" });
    expect(history.body.entries[0].hasSensitiveSnapshot).toBe(false);
  }, HISTORY_TEST_TIMEOUT_MS);

  test("export requires confirmation and never carries a secret field", async () => {
    await confirmedEntry("Example", "alice@example.com");
    const refused = await call("/api/host/authenticator/history/export", { method: "POST", body: JSON.stringify({}) });
    expect(refused.status).toBe(400);

    const exported = await call("/api/host/authenticator/history/export", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body.entries)).not.toContain("secret");
  }, HISTORY_TEST_TIMEOUT_MS);

  test("retention: setting a policy is reported, and rejects a bad value", async () => {
    await confirmedEntry("Example", "alice@example.com");
    const bad = await call("/api/host/authenticator/history/retention", { method: "POST", body: JSON.stringify({ days: -1, confirmed: true }) });
    expect(bad.status).toBe(400);

    const ok = await call("/api/host/authenticator/history/retention", { method: "POST", body: JSON.stringify({ days: 90, confirmed: true }) });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.retentionDays).toBe(90);
  }, HISTORY_TEST_TIMEOUT_MS);
});
