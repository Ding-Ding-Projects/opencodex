import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeApiKey } from "../src/cli/opencode";
import type { OcxConfig } from "../src/types";

/**
 * SEC-01 (Copilot admission security review, lane F10 slice 1): a data-plane API
 * key created with purpose "github-copilot-desktop" is meant to be an
 * integration-scoped credential that identifies the GitHub Copilot Desktop
 * client and nothing else (issue #10: "Integration-scoped, reveal-once API
 * key with loopback-only admission and no upstream forwarding").
 *
 * `opencodeApiKey` (src/cli/opencode.ts) — and five sibling call sites
 * (src/server/system-env.ts:51,277; src/server/management/agent-settings-routes.ts:98,689;
 * src/cli/claude-desktop.ts:47) — pick the admission credential for OTHER local
 * integrations (the opencode CLI launcher, Claude Code's ANTHROPIC_AUTH_TOKEN
 * shell/launchctl injection, and Claude Desktop's third-party gateway config
 * file) with `config.apiKeys?.[0]?.key`, without checking `entry.purpose`.
 *
 * `config.apiKeys` is append-only creation order (see the `POST /api/keys`
 * handler in src/server/management/oauth-account-routes.ts:534:
 * `config.apiKeys = [...(config.apiKeys ?? []), entry]`), so if a user's very
 * first key is the one generated from the new "Generate" button on the API
 * Access page's GitHub Copilot Desktop card, `apiKeys[0]` IS the
 * purpose-scoped key. Every one of those call sites then silently adopts it
 * as a generic bearer credential for an unrelated integration — defeating the
 * "integration-scoped" contract and, for src/server/index.ts's
 * copilotProfileAdmission() (which classifies by credential VALUE, not by
 * caller identity), can misroute or 403 that integration's own /v1/models
 * traffic once it presents the same value.
 *
 * This test pins the simplest, side-effect-free reproduction: with only a
 * purpose-scoped key configured and no generic credential anywhere,
 * opencodeApiKey() must NOT return the Copilot-scoped secret as opencode's
 * own admission token. It currently does, which is the bug.
 */
describe("SEC-01: purpose-scoped API key leaking into unrelated local integrations", () => {
  let testDir = "";
  let previousHome: string | undefined;
  let previousApiToken: string | undefined;

  beforeEach(() => {
    // Same isolation pattern as tests/copilot-desktop-profile.test.ts: an
    // OPENCODEX_HOME pointed at a fresh temp directory keeps getConfigDir()
    // (and therefore the service-token-file fallback opencodeApiKey() also
    // consults) away from the real ~/.opencodex on this machine.
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-sec-01-"));
    process.env.OPENCODEX_HOME = testDir;
    previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("opencodeApiKey never hands out a github-copilot-desktop-purpose secret as generic admission", () => {
    const COPILOT_SECRET = "ocx_data_copilot_only_secret_must_stay_scoped";
    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", apiKey: "upstream-key" },
      },
      // The ONLY configured key is purpose-scoped to the GitHub Copilot
      // Desktop integration profile — no generic data-plane key exists.
      apiKeys: [{
        id: "copilot-key",
        name: "GitHub Copilot Desktop",
        key: COPILOT_SECRET,
        createdAt: "2026-09-14T00:00:00.000Z",
        purpose: "github-copilot-desktop",
      }],
    };

    // No OPENCODEX_API_AUTH_TOKEN and no on-disk service token file (isolated
    // OPENCODEX_HOME): the only candidate opencodeApiKey() can fall through to
    // is config.apiKeys[0].key, which today is the Copilot-only secret.
    const key = opencodeApiKey(config, {});

    // The integration-scoped Copilot key must never be reused as opencode's
    // own generic admission credential. Today it is — this assertion is the
    // confirmed candidate, expected RED against the current implementation.
    expect(key).not.toBe(COPILOT_SECRET);
  });
});
