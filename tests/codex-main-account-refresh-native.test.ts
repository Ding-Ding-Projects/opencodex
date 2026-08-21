import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getValidMainAccountToken } from "../src/codex/main-account";
import type { OAuthCredentials } from "../src/oauth/types";
import { removeTempDir } from "./helpers/temp-dir";

const oldCodexHome = process.env.CODEX_HOME;
const oldGuard = process.env.OCX_TEST_HOME_GUARD;
let home: string;

function jwt(exp: number, accountId = "chatgpt-native"): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({ exp, chatgpt_account_id: accountId })}.sig`;
}

function writeAuth(accessToken: string, refreshToken?: string, accountId = "chatgpt-native"): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    account_id: accountId,
  } }) + "\n");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-native-main-refresh-"));
  process.env.CODEX_HOME = home;
  process.env.OCX_TEST_HOME_GUARD = "1";
});

afterEach(() => {
  removeTempDir(home);
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
  if (oldGuard === undefined) delete process.env.OCX_TEST_HOME_GUARD;
  else process.env.OCX_TEST_HOME_GUARD = oldGuard;
});

describe("native main auth.json refresh", () => {
  test("refreshes from the native refresh token and preserves rotation", async () => {
    writeAuth(jwt(Math.floor(Date.now() / 1000) - 60), "native-refresh-old");
    let calls = 0;
    const result = await getValidMainAccountToken({ dependencies: {
      refreshToken: async (refreshToken: string): Promise<OAuthCredentials> => {
        calls++;
        expect(refreshToken).toBe("native-refresh-old");
        return { access: jwt(Math.floor(Date.now() / 1000) + 3600), refresh: "native-refresh-new", expires: Date.now() + 3600000, accountId: "chatgpt-native" };
      },
    } });
    expect(result?.accessToken).not.toContain("native-refresh-old");
    expect(calls).toBe(1);
    const stored = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { tokens: { refresh_token?: string } };
    expect(stored.tokens.refresh_token).toBe("native-refresh-new");
  });

  test("does not overwrite an external auth.json writer observed by the CAS", async () => {
    writeAuth(jwt(Math.floor(Date.now() / 1000) - 60), "native-refresh-old");
    let release!: () => void;
    let started = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const pending = getValidMainAccountToken({ dependencies: {
      refreshToken: async (): Promise<OAuthCredentials> => {
        started = true;
        await waiting;
        return { access: jwt(Math.floor(Date.now() / 1000) + 3600, "stale-refresh"), refresh: "stale-refresh", expires: Date.now() + 3600000, accountId: "stale-refresh" };
      },
    } });
    while (!started) await Bun.sleep(1);
    writeAuth(jwt(Math.floor(Date.now() / 1000) + 3600, "external-refresh"), "external-refresh", "external-writer");
    release();
    const result = await pending;
    expect(result?.chatgptAccountId).toBe("external-writer");
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))).toMatchObject({ tokens: { refresh_token: "external-refresh" } });
  });

  test("reclaims an old owner lock without exposing its contents", async () => {
    writeAuth(jwt(Math.floor(Date.now() / 1000) - 60), "native-refresh-old");
    writeFileSync(join(home, "auth.json.refresh.lock"), JSON.stringify({ owner: "old-owner", pid: 999999, acquiredAt: Date.now() - 120000 }));
    const result = await getValidMainAccountToken({ dependencies: {
      refreshToken: async (): Promise<OAuthCredentials> => ({ access: jwt(Math.floor(Date.now() / 1000) + 3600), refresh: "native-refresh-new", expires: Date.now() + 3600000, accountId: "chatgpt-native" }),
    } });
    expect(result?.chatgptAccountId).toBe("chatgpt-native");
  });

  test("does not dispatch when auth.json has no refresh token", async () => {
    writeAuth(jwt(Math.floor(Date.now() / 1000) - 60));
    let calls = 0;
    const result = await getValidMainAccountToken({ dependencies: { refreshToken: async () => { calls++; throw new Error("must not dispatch"); } } });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});
