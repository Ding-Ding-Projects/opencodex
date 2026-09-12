// Regression test for a Codex warmup error-body echo leak.
//
// src/codex/warmup.ts's `readErrorDetail()` deliberately reads only the upstream ChatGPT
// backend's structured JSON error fields (`error.message`, `detail`, `error`, `message`) rather
// than raw response text, with an explicit comment: "Non-JSON response body may contain
// sensitive data (tokens, credentials). Only surface structured error messages, never raw
// text." That comment shows the author already understood the threat model this file's own
// request creates (`tryWarmup` sends `Authorization: Bearer <access token>` -- a live Codex
// access token -- to https://chatgpt.com/backend-api/codex/responses) -- but the guard only
// covered the raw-non-JSON-body shape of that threat. A JSON error body whose own `message`/
// `detail` field echoes request/header content (a realistic diagnostic-error shape, e.g.
// `{"error":{"message":"invalid bearer <token>"}}`) sailed straight through: nothing in
// readErrorDetail, CodexWarmupError, codexWarmupFailureReason, or the caller in
// src/codex/auth-api.ts's `verifyCodexAccountWarmup` (`const upstream = err instanceof
// CodexWarmupError ? err.upstreamDetail : undefined; ... error: upstream ? \`Codex account
// warmup failed: ${upstream}\` : ...`) called redactSecretString on it. That JSON response
// (`code: "codex_warmup_failed"`) is exactly the body auth-api.ts's `/api/codex-auth/login`
// handler reads to build `codexAuthLoginState`'s `error` field, which reaches the GUI toast via
// `/api/codex-auth/login-status` and gui/src/components/use-add-codex-account-oauth.ts's
// `dispatch({ type: "set-error", error: st.error ?? ... })` -- the "Add Codex account" flow.
//
// This test exercises the lowest-level, self-contained function so it has no unrelated
// dependencies. It asserts the safe target shape (upstreamDetail must not contain the
// credential-shaped value).
//
// Do not weaken these assertions to make the file report green.

import { afterEach, describe, expect, test } from "bun:test";
import { CodexWarmupError, warmCodexAccount } from "../src/codex/warmup";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const FAKE_LEAKED_ACCESS_TOKEN = "Bearer sk-ocx-FAKE-NOT-REAL-ACCESS-TOKEN-0002";

describe("Codex warmup error-body echo", () => {
  test("warmCodexAccount must not echo a credential-shaped upstream JSON error message", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { message: `Rejected token: ${FAKE_LEAKED_ACCESS_TOKEN} does not match any session` } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )
    ) as typeof fetch;

    let caught: unknown;
    try {
      await warmCodexAccount({ accessToken: "fake-access-token-for-test-only", chatgptAccountId: "acct-test" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(CodexWarmupError);
    const upstreamDetail = (caught as CodexWarmupError).upstreamDetail;
    // Safe target shape: the credential-shaped upstream value must never survive into
    // upstreamDetail (which src/codex/auth-api.ts's verifyCodexAccountWarmup embeds verbatim
    // into the JSON response the GUI's Add-Codex-account toast then displays).
    expect(upstreamDetail ?? "").not.toContain(FAKE_LEAKED_ACCESS_TOKEN);
    // The redaction marker proves the detail was actually scrubbed, not merely absent.
    expect(upstreamDetail ?? "").toContain("[REDACTED]");
  });

  test("the code/status fields used for retry and classification are unaffected by redaction", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { message: `Rejected token: ${FAKE_LEAKED_ACCESS_TOKEN} does not match any session` } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )
    ) as typeof fetch;
    let caught: unknown;
    try {
      await warmCodexAccount({ accessToken: "fake-access-token-for-test-only", chatgptAccountId: "acct-test" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CodexWarmupError);
    expect((caught as CodexWarmupError).code).toBe("http_status");
    expect((caught as CodexWarmupError).status).toBe(401);
  });
});
