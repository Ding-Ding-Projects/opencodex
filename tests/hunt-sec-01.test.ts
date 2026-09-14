/**
 * Hunt SEC-01: a genuine (non-timeout) icacls denial in non-fatal ("required: false")
 * mode is swallowed completely silently by `hardenEntry` in
 * `src/lib/windows-secret-acl.ts` — no thrown error, no console warning, nothing.
 *
 * `tests/windows-secret-acl.test.ts` already proves the timeout branch warns
 * ("a genuine timeout on a required path soft-fails with a warning instead of
 * blocking auth") and that a `required: true` denial throws instead of warning
 * ("a real permission failure on a required path still throws (no blanket
 * soft-fail)" — that test asserts `expect(warnings).toEqual([])` for exactly
 * that reason: the thrown error IS the notification). Neither of those covers
 * a genuine non-timeout denial in `required: false` mode, which is the mode
 * `hardenConfigDir()` / `hardenExistingSecret()` in `src/config.ts` actually use
 * to protect the OAuth token store (`src/oauth/store.ts`), the Codex account
 * store (`src/codex/account-store.ts`) and the authenticator/TOTP secret store
 * (`src/lib/authenticator-store.ts`) — and both of those wrapper functions
 * discard the returned `HardenResult` entirely (bare `hardenSecretDir(dir,
 * { required: false });` / `hardenSecretPath(path, { required: false });` with
 * no captured variable). So when icacls genuinely fails (not merely times out)
 * on an existing secrets directory or file, the secret is left protected by
 * nothing stronger than `chmodSync`'s POSIX-bit emulation — which the module's
 * own header comment says does NOT remove inherited permissions from other
 * local Windows accounts — and there is no warning, no log line, and no
 * diagnostic anywhere an operator could ever see.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hardenSecretDir,
  hardenSecretPath,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
  type IcaclsResult,
} from "../src/lib/windows-secret-acl";
import { removeTempDir } from "./helpers/temp-dir";

let testDir = "";
let warnings: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-acl-hunt-"));
  setPlatformForTests("win32");
  resetHardenedStateForTests();
  process.env.USERNAME ??= "tester";
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
});

afterEach(() => {
  console.warn = realWarn;
  setPlatformForTests(null);
  setIcaclsRunnerForTests(null);
  resetHardenedStateForTests();
  if (testDir && existsSync(testDir)) removeTempDir(testDir);
  testDir = "";
});

/** A genuine, non-timeout icacls denial (exit code 5 == ERROR_ACCESS_DENIED). */
const denied: IcaclsResult = { success: false, exitCode: 5, timedOut: false, stdout: "" };

describe("hunt-sec-01: non-fatal ACL hardening must not fail silently", () => {
  test("a real icacls denial on a non-required secret FILE still warns the operator", () => {
    setIcaclsRunnerForTests(() => denied);
    const filePath = join(testDir, "auth.json");
    writeFileSync(filePath, "{}", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    // The secret was genuinely not hardened...
    expect(result.ok).toBe(false);
    // ...so something MUST tell the operator. Today nothing does: hardenEntry's
    // non-timeout, non-required branch returns `{ ok: false, diagnostics }`
    // straight past the one console.warn call in the whole function, which only
    // fires on the timeout branch above it.
    expect(warnings.some(w => w.toLowerCase().includes("acl"))).toBe(true);
  });

  test("a real icacls denial on a non-required secret DIRECTORY still warns the operator", () => {
    setIcaclsRunnerForTests(() => denied);

    const result = hardenSecretDir(testDir, { required: false });

    expect(result.ok).toBe(false);
    expect(warnings.some(w => w.toLowerCase().includes("acl"))).toBe(true);
  });
});
