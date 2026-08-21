import { describe, expect, test } from "bun:test";
import { buildOrcaLaunchManifest } from "../src/cli/export";
import type { OrcaCodexHomeDiagnostic } from "../src/codex/home";

const compatible: OrcaCodexHomeDiagnostic = {
  applicable: false,
  mismatch: false,
  effectiveCodexHome: "C:\\Users\\[USER]\\.codex",
  appCodexHome: "C:\\Users\\[USER]\\.codex",
  orcaCodexHome: null,
  warning: null,
  action: null,
};

describe("Orca stopped-proxy launch manifest", () => {
  test("is versioned, secret-free, and argv-only", () => {
    const manifest = buildOrcaLaunchManifest(compatible);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generatedWhileProxyStopped).toBe(true);
    expect(manifest.home.status).toBe("compatible");
    const json = JSON.stringify(manifest);
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("token");
    expect(json).not.toContain("secret");
    expect(manifest.service.ready.argv).toEqual(["ocx", "ready", "--wait", "--json"]);
    expect(manifest.agents.codex.launch.passThroughArgs).toBe(true);
    expect(manifest.agents.claude.launch.passThroughArgs).toBe(true);
  });

  test("returns structured guidance for a genuine Orca/runtime-home conflict", () => {
    const manifest = buildOrcaLaunchManifest({
      ...compatible,
      applicable: true,
      mismatch: true,
      effectiveCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
      orcaCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
      warning: "CODEX_HOME targets an Orca runtime home.",
      action: "Use one intentional home for every launch stage.",
    });
    expect(manifest.home).toEqual({
      status: "conflict",
      conflict: {
        kind: "orca-runtime-home-mismatch",
        effectiveCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
        appCodexHome: "C:\\Users\\[USER]\\.codex",
        orcaCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
        warning: "CODEX_HOME targets an Orca runtime home.",
        action: "Use one intentional home for every launch stage.",
      },
    });
  });
});
