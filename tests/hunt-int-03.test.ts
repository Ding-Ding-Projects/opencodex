/**
 * hunt-int-03: the management API has no credential check at all, contradicting
 * the README's documented "Remote access" security contract.
 *
 * `README.md`'s "Remote access" section (~line 589-615) tells a user who exposes
 * opencodex on the LAN (`"hostname": "0.0.0.0"`):
 *
 *   "The dashboard and `/api/*` use a distinct ADMIN credential. A hardened
 *   ADMIN token is created on the proxy host (or supplied through
 *   `OPENCODEX_ADMIN_AUTH_TOKEN`), and a remote dashboard prompts for it."
 *
 * That is not what the code does. `handleManagementAPI` (`src/server/management-api.ts`,
 * ~line 139-149) admits a request into the entire `/api/*` surface (config,
 * provider credentials, OAuth accounts, the embedded terminal gate, scheduling,
 * exports) based solely on `isAllowedManagementOrigin`, an Origin/Host check,
 * plus a body-size cap. No handler in that dispatch chain ever calls
 * `requireApiAuth`, and the one function that could check an admin token,
 * `isManagementAdmissionSecret` in `src/server/auth-cors.ts` (line ~357), which
 * reads `OPENCODEX_ADMIN_AUTH_TOKEN` via `configuredAdminAuthToken()`, is never
 * called as an admission gate anywhere; its only caller is
 * `isProxyAdmissionSecret`, used solely to strip such secrets before an
 * outbound forward, not to admit an inbound request.
 *
 * This IS a deliberate, already-accepted design decision, not a freshly found
 * hole: `src/server/index.ts` line ~556 says outright, "The management plane is
 * intentionally open. Admin-token authentication was removed", `gui/src/api.ts`
 * (lines 1-17) confirms the client side was removed to match ("Admin-token
 * prompts are permanently disabled"), and `ROADMAP.md`'s "Known limitations"
 * section (~line 384) and `docs-site/src/content/docs/reference/configuration.md`
 * (~line 368-396) both correctly and prominently document it: "Management API
 * is intentionally open... Any non-loopback deployment must add an external
 * authenticated boundary before exposing `/api/*`."
 *
 * The actual gap is that this correction never reached every place a user reads
 * it. `README.md` (the project's front page) still asserts the pre-removal
 * behaviour word for word. Even `docs-site/src/content/docs/guides/web-dashboard.md`
 * contradicts itself in one file: its own "Remote access and admission keys"
 * section (line ~43) correctly says "The dashboard never asks for an admin
 * token... `/api/*` management routes are intentionally open", but its later
 * "Connect to another OpenCodex" paragraph (line ~174) still says "The
 * destination dashboard prompts for that proxy's ADMIN token", and the same
 * stale sentence is duplicated in its ja/ko/ru/zh-cn translations. So the
 * likely correct fix here is a documentation correction (matching what
 * ROADMAP.md and the configuration reference already say), not a new code-level
 * admin-token gate; either way, README.md's claim is false against the current
 * code and this test pins the concrete, currently-true fact that makes it false.
 *
 * The practical mechanism: `isAllowedManagementOrigin` -> `managementRequestOrigin`
 * only refuses when an `Origin` header is present AND mismatched. A request
 * with no `Origin` header at all (every plain curl/script/non-browser HTTP
 * client, the exact tooling someone on the same LAN would use) sails through
 * (`!origin || ...` short-circuits true) as long as its `Host` header names the
 * bound address, which is automatic for any client actually connecting there.
 *
 * Expected red now: the test below gets a 200 with the full (redacted-secrets
 * but still live) config DTO for an entirely credential-free GET, on a config
 * that is explicitly bound non-loopback exactly as README's own "Remote
 * access" section instructs a reader to configure. Expected green once README.md
 * (and the stale web-dashboard.md paragraph and its four translations) are
 * corrected to match ROADMAP.md's own accurate description: this exact test
 * would then need to be replaced with one that pins the corrected claim (a
 * credential-free request being admitted is, per ROADMAP.md, the intended
 * behaviour) rather than one that expects a refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { setServerRef } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

let dir = "";
let previousHome: string | undefined;
let previousAdminToken: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  dir = mkdtempSync(join(tmpdir(), "ocx-mgmt-admin-"));
  process.env.OPENCODEX_HOME = dir;
  // The README's own instructions: a hardened ADMIN token exists to gate `/api/*`
  // once the proxy is reachable from other devices. Configuring it here is the
  // documented mitigation a real operator would rely on.
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "hardened-admin-secret";
  // Matches the live-listener boundary `managementRequestOrigin` actually checks
  // (config.hostname alone is not the security decision; see its own comment).
  setServerRef({ hostname: "0.0.0.0", port: 10100 } as never);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  setServerRef(undefined);
  if (dir) removeTempDir(dir);
});

function makeConfig(): OcxConfig {
  return {
    hostname: "0.0.0.0",
    port: 10100,
    defaultProvider: "test",
    providers: {},
    apiKeys: [{
      id: "configured",
      name: "Configured data key",
      key: "ocx_data_configured-secret",
      createdAt: "2026-07-28T00:00:00.000Z",
    }],
  } as OcxConfig;
}

describe("management API vs. the README's documented ADMIN-credential gate", () => {
  test("a credential-free request from a LAN client (no Origin header, matching Host) should be refused, exactly as README 'Remote access' promises", async () => {
    const config = makeConfig();
    // The exact shape of a plain `curl http://<lan-ip>:10100/api/config`: no
    // browser, so no Origin header; no admin token, because the README-promised
    // prompt no longer exists anywhere for a script to answer.
    const req = new Request("http://192.168.1.50:10100/api/config", {
      method: "GET",
      headers: { Host: "192.168.1.50:10100" },
    });
    const response = await handleManagementAPI(req, new URL(req.url), config);

    expect(response).not.toBeNull();
    expect([401, 403]).toContain(response?.status);
  });
});
