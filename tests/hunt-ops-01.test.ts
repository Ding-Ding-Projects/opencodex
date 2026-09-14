/**
 * Regression for an ACL-hardening observability gap (candidate OPS-01).
 *
 * windows-secret-acl.ts soft-fails a required hardenSecretPath/hardenSecretDir
 * call when icacls genuinely times out (by design -- see the module's own test
 * "a genuine timeout on a required path soft-fails with a warning instead of
 * blocking auth" in tests/windows-secret-acl.test.ts) instead of blocking the
 * write. That trade-off is deliberate, already tested, and is NOT what this
 * test is about.
 *
 * What is untested: once that soft-fail happens, nothing outside the module
 * can learn about it.
 *   - timedOutPaths (the module's own record of which paths are currently
 *     running without hardening) is a private module-level Set. No exported
 *     reader exists -- only test-only setter/reset seams are exported.
 *   - The only trace left behind is a bare console.warn() call. This app's
 *     own persisted log / in-memory debug ring never captures it:
 *     src/lib/debug.ts routes only debugDroppedFrame()/debugProviderDiagnostic()
 *     through emitDebugLine() -> appendDebugLogLine(), and only when
 *     isDebugEnabled() is on. A plain console.warn from elsewhere in the
 *     codebase (including this module) bypasses that pipeline entirely.
 *   - src/cli/doctor.ts never mentions ACL or hardening state anywhere (every
 *     "collect*" diagnostic it composes was inspected; none reads this
 *     module).
 *
 * So the exact failure already reproduced in this project's own baseline run
 * ("ACL hardening timed out (ETIMEDOUT) ... continuing without NTFS ACL",
 * observed several times, plus one outright "ACL hardening failed") leaves a
 * user's secret directory running without per-user NTFS protection with no
 * supported way to notice -- short of reading raw stderr off a background
 * service process that normally has no attached console at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acl from "../src/lib/windows-secret-acl";
import { removeTempDir } from "./helpers/temp-dir";

let testDir = "";
const realWarn = console.warn;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-acl-observability-"));
  acl.setPlatformForTests("win32");
  acl.resetHardenedStateForTests();
  process.env.USERNAME ??= "tester";
});

afterEach(() => {
  if (testDir && existsSync(testDir)) removeTempDir(testDir);
  testDir = "";
  acl.setPlatformForTests(null);
  acl.setIcaclsRunnerForTests(null);
  acl.resetHardenedStateForTests();
  console.warn = realWarn;
});

describe("OPS-01: a soft-failed required ACL harden is invisible outside the module", () => {
  test("a timed-out required hardenSecretDir leaves no exported trail for diagnostics to read", () => {
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    acl.setIcaclsRunnerForTests(() => ({ success: false, exitCode: null, timedOut: true, stdout: "" }));

    // Reproduce the exact baseline symptom: a required directory harden (e.g. the
    // config dir, hardened at startup with required: true) times out.
    const result = acl.hardenSecretDir(testDir, { required: true });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContain("ETIMEDOUT");
    expect(warnings.some(w => w.includes("continuing without NTFS ACL harden"))).toBe(true);

    // The module DOES remember this internally -- a second call on the same path
    // short-circuits to "skipped" -- so the information exists. It is just never
    // exposed past the module boundary.
    expect(acl.hardenSecretDir(testDir, { required: true }).diagnostics).toContain("skipped");

    // A diagnostics consumer (doctor, a health endpoint, a future structured
    // status report) needs to discover this WITHOUT already knowing which exact
    // path to re-probe -- that is the whole point of a health check. Doing so
    // requires an exported reader over the paths this module already knows are
    // degraded. None exists today: the module's only exports are the harden
    // functions themselves and test-only setter/reset seams.
    const reader = Object.keys(acl).find(name => /timedout|timeout|degraded|unhardened/i.test(name)
      && typeof (acl as unknown as Record<string, unknown>)[name] === "function");
    expect(
      reader,
      "expected windows-secret-acl.ts to export a reader over paths with a soft-failed " +
        "(timed-out) required ACL harden, so doctor/diagnostics can report them without " +
        "already knowing the exact path; only test-only setter/reset seams are exported today",
    ).toBeDefined();
  });
});
