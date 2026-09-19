import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resolveEffectiveUserIdentity } from "../src/codex/user-identity";
import { setTrustedWindowsElevationExecutablesForTests } from "../src/lib/windows-elevation";

/**
 * HUNT-SEC-02: the Windows effective-account lookup in src/codex/user-identity.ts
 * spawned the bare name "powershell.exe", so the interpreter that reports the
 * effective SID was chosen by whatever PATH the hosting process happened to carry.
 * A stripped PATH makes the lookup fail outright (the empty-value refusal recorded
 * in the handoff), and a hostile PATH entry gets to answer the identity question
 * that keys every Codex coordinator namespace. Every other Windows spawn in the
 * tree already goes through resolveTrustedWindowsPowerShellExe(), which pins the
 * interpreter to a System32-contained absolute path.
 *
 * tests/codex-user-identity.test.ts guards the SID shape behind
 * `if (process.platform === "win32")`, so it gives no signal on the Linux hosts
 * this suite normally runs on. This file instead fakes win32 and installs an
 * absolute interpreter path through the elevation module's documented test seam
 * (setTrustedWindowsElevationExecutablesForTests, which exists precisely because
 * Linux CI fakes win32 without a real System32), then reads back the argv the
 * identity lookup actually spawned.
 */

/** Shaped like a real System32 interpreter path; never resolved on this host. */
const FAKE_TRUSTED_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const FAKE_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

describe("hunt-sec-02: the Windows identity lookup spawns a trusted absolute interpreter", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setTrustedWindowsElevationExecutablesForTests({ powershell: FAKE_TRUSTED_POWERSHELL });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    setTrustedWindowsElevationExecutablesForTests(null);
  });

  test("resolveEffectiveUserIdentity never spawns the bare name powershell.exe", () => {
    const spawnedCommands: string[][] = [];
    // Stub rather than wrap: this host has no powershell.exe at all, and the point
    // of the test is the argv the caller chose, not what the interpreter answers.
    const spy = spyOn(Bun, "spawnSync").mockImplementation(((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = args[0];
      if (Array.isArray(command)) spawnedCommands.push(command as string[]);
      return {
        exitCode: 0,
        success: true,
        signalCode: null,
        stdout: new TextEncoder().encode(`${FAKE_SID}\r\n`),
        stderr: new Uint8Array(),
      };
    }) as unknown as typeof Bun.spawnSync);

    try {
      const identity = resolveEffectiveUserIdentity();
      expect(identity).toEqual({ platform: "win32", sid: FAKE_SID });
    } finally {
      spy.mockRestore();
    }

    expect(spawnedCommands.length).toBe(1);
    const argv = spawnedCommands[0] as string[];
    expect(argv[0]).toBe(FAKE_TRUSTED_POWERSHELL);
    expect(argv[0]).not.toBe("powershell.exe");
    // A relative argv[0] is the whole defect: it is what hands interpreter
    // selection to PATH, whatever the leading segments happen to spell.
    expect(argv[0]?.startsWith("C:\\")).toBe(true);
    // The lookup itself must stay unchanged: a profile-free, non-interactive,
    // single-expression invocation.
    expect(argv.slice(1, 5)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  });
});
