import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeApiKey } from "../src/cli/opencode";
import { selectGenericApiKey } from "../src/lib/data-plane-api-key";
import type { OcxConfig } from "../src/types";

/**
 * SEC-01 (Copilot admission security review, issue #10): a data-plane API key
 * created with purpose "github-copilot-desktop" is an integration-scoped
 * credential that identifies the GitHub Copilot Desktop client and nothing else
 * ("Integration-scoped, reveal-once API key with loopback-only admission and no
 * upstream forwarding").
 *
 * Before the fix, `opencodeApiKey` (src/cli/opencode.ts) and six sibling call
 * sites (src/server/system-env.ts, twice; src/server/management/agent-settings-routes.ts,
 * twice; src/cli/claude-desktop.ts; src/cli/claude.ts) picked the admission
 * credential for OTHER local integrations (the opencode CLI launcher, Claude
 * Code's ANTHROPIC_AUTH_TOKEN for both `ocx claude` and the shell/launchctl
 * injection, and Claude Desktop's third-party gateway config file) with
 * `config.apiKeys?.[0]?.key`, without checking `entry.purpose`.
 *
 * `config.apiKeys` is append-only creation order (the `POST /api/keys` handler
 * in src/server/management/oauth-account-routes.ts does
 * `config.apiKeys = [...(config.apiKeys ?? []), entry]`), so when a user's very
 * first key is the one generated from the "Generate" button on the API Access
 * page's GitHub Copilot Desktop card, `apiKeys[0]` IS the purpose-scoped key.
 * Every one of those call sites then silently adopted it as a generic bearer
 * credential for an unrelated integration, defeating the "integration-scoped"
 * contract. Because src/server/index.ts's copilotProfileAdmission() classifies
 * by credential VALUE rather than by caller identity, that integration's own
 * /v1/models traffic could then be misrouted or rejected with 403 once it
 * presented the same value.
 *
 * This file pins the simplest, side-effect-free reproduction: with only a
 * purpose-scoped key configured and no generic credential anywhere,
 * opencodeApiKey() must not return the Copilot-scoped secret as opencode's own
 * admission token. It also pins the selector every fixed call site now shares.
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
      // Desktop integration profile; no generic data-plane key exists.
      apiKeys: [{
        id: "copilot-key",
        name: "GitHub Copilot Desktop",
        key: COPILOT_SECRET,
        createdAt: "2026-09-14T00:00:00.000Z",
        purpose: "github-copilot-desktop",
      }],
    };

    // No OPENCODEX_API_AUTH_TOKEN and no on-disk service token file (isolated
    // OPENCODEX_HOME): the only configured candidate opencodeApiKey() could fall
    // through to is the Copilot-only secret, so it must land on the "ocx"
    // placeholder instead, exactly as it does with no keys configured at all.
    const key = opencodeApiKey(config, {});

    // The integration-scoped Copilot key must never be reused as opencode's
    // own generic admission credential. This assertion failed against the
    // unfiltered `config.apiKeys?.[0]?.key` selection and passes with the fix.
    expect(key).not.toBe(COPILOT_SECRET);
    expect(key).toBe("ocx");
  });
});

// The shared selector behind every fixed call site. These cases pin the property the
// review asked for: the choice is made by purpose, never by list position, and a list
// holding only scoped keys is indistinguishable from an empty one.
describe("selectGenericApiKey chooses by purpose, never by position", () => {
  const copilot = {
    id: "copilot-key",
    name: "GitHub Copilot Desktop",
    key: "ocx_data_copilot_only_secret_must_stay_scoped",
    createdAt: "2026-09-14T00:00:00.000Z",
    purpose: "github-copilot-desktop" as const,
  };
  const generic = { id: "generic-key", name: "main", key: "ocx_data_generic", createdAt: "2026-09-15T00:00:00.000Z" };
  const base: OcxConfig = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", apiKey: "upstream-key" } },
  };

  test("an absent or empty list yields nothing", () => {
    expect(selectGenericApiKey(base)).toBeUndefined();
    expect(selectGenericApiKey({ ...base, apiKeys: [] })).toBeUndefined();
  });

  test("a lone generic key is returned unchanged", () => {
    expect(selectGenericApiKey({ ...base, apiKeys: [generic] })).toBe(generic);
  });

  test("a generic key is found behind a scoped key that was created first", () => {
    expect(selectGenericApiKey({ ...base, apiKeys: [copilot, generic] })).toBe(generic);
  });

  test("a generic key ahead of a scoped key is returned", () => {
    expect(selectGenericApiKey({ ...base, apiKeys: [generic, copilot] })).toBe(generic);
  });

  test("a list holding only scoped keys behaves like an empty list", () => {
    expect(selectGenericApiKey({ ...base, apiKeys: [copilot] })).toBeUndefined();
  });

  test("an unrecognized purpose value still counts as scoped", () => {
    const future = { ...generic, id: "future-key", purpose: "some-future-integration" };
    expect(selectGenericApiKey({ ...base, apiKeys: [future] })).toBeUndefined();
    expect(selectGenericApiKey({ ...base, apiKeys: [future, generic] })).toBe(generic);
  });
});
