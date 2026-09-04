import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAccountSet, saveCredential } from "../src/oauth/store";
import { clearOAuthPoolState, recordOAuthAccountCooldown, resolveOAuthAccountForSession } from "../src/oauth/provider-pool";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

const priorHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-antigravity-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearOAuthPoolState("google-antigravity");
});

afterEach(() => {
  clearOAuthPoolState("google-antigravity");
  removeTempDir(home);
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
});

describe("Antigravity cooldown selection", () => {
  test("a cooled account is excluded and the next account is selected", async () => {
    await saveCredential("google-antigravity", { access: "a", refresh: "ra", expires: Date.now() + 3_600_000, accountId: "a", projectId: "pa" });
    await saveCredential("google-antigravity", { access: "b", refresh: "rb", expires: Date.now() + 3_600_000, accountId: "b", projectId: "pb" });
    const accountIds = getAccountSet("google-antigravity")!.accounts.map(account => account.id);
    const config = {
      providers: { "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", accountPool: { enabled: true, strategy: "round-robin" } } },
      defaultProvider: "google-antigravity",
    } as OcxConfig;
    recordOAuthAccountCooldown("google-antigravity", accountIds[0]!, null, Date.now(), 60_000);
    const selected = resolveOAuthAccountForSession("google-antigravity", "turn-a", config);
    expect(selected.accountId).toBe(accountIds[1]);
    expect(selected.reason).not.toBe("all-cooled");
  });
});
