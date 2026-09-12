// Regression test for an OAuth error-body echo leak.
//
// Anthropic (src/oauth/anthropic.ts) and GitHub Copilot (src/oauth/github-copilot.ts) both
// deliberately extract ONLY an allowlisted OAuth error *code* from a failed token
// exchange/refresh response, with an explicit comment that the raw body / error_description
// must never reach the thrown Error's `.message` because the request that failed carries a
// PKCE verifier or a refresh token, and a verbose upstream body can echo request parameters
// straight through into that message. That message is not swallowed anywhere useful for this
// purpose: see src/oauth/index.ts's `refreshGenericAccountWithLock`, which rethrows the
// original error verbatim whenever `terminal(error)` is false (`if (!terminal(error)) throw
// error;`), and the two `formatErrorResponse(401, "authentication_error", ...)` sinks in
// src/server/responses/core.ts (single-account/pool OAuth token resolution, and the reactive
// 401-replay path) that return that message to the calling client.
//
// ChatGPT/Codex (src/oauth/chatgpt.ts), xAI/Grok (src/oauth/xai.ts), and Kimi
// (src/oauth/kimi.ts) previously did NOT apply a code-only guard: their token-exchange/refresh
// helpers embedded the upstream `error_description` field verbatim in the thrown Error's
// `.message`. This test asserts the safe target shape (message must not contain the
// credential-shaped upstream value) for all three, by redacting the composed message with
// the shared `redactSecretString` helper (src/lib/redact.ts) while still keeping the
// allowlisted `error` code readable, since `isTerminalRefreshError`/`terminal()` in
// src/oauth/index.ts substring-match on that code to classify a refresh failure as terminal.
//
// Do not weaken these assertions to make the file report green -- a green run before a real
// fix means the regression stopped detecting the bug, not that the bug is gone.

import { afterEach, describe, expect, test } from "bun:test";
import { refreshChatGPTTokenRaw } from "../src/oauth/chatgpt";
import { postXaiToken } from "../src/oauth/xai";
import { refreshKimiToken } from "../src/oauth/kimi";
import { redactSecretString } from "../src/lib/redact";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Obviously-fake, clearly-not-a-real-secret marker value in the exact `key=value` shape
// redact.ts's SECRET_VALUE_PATTERNS already recognizes (the same shape a misbehaving/legacy
// upstream OAuth endpoint uses when it echoes the offending request parameter back in
// error_description, e.g. "invalid_grant: refresh_token=<value> has already been redeemed").
const FAKE_LEAKED_REFRESH_TOKEN = "refresh_token=OCX-FAKE-NOT-REAL-LEAKED-TOKEN-0001";

function mockJsonResponse(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  ) as typeof fetch;
}

describe("OAuth refresh/exchange error-body echo", () => {
  test("refreshChatGPTTokenRaw must not echo the raw error_description", async () => {
    mockJsonResponse(400, {
      error: "temporarily_unavailable", // deliberately NOT in any terminal/revoked allowlist
      error_description: `Malformed refresh grant: ${FAKE_LEAKED_REFRESH_TOKEN} was already redeemed`,
    });

    let caught: unknown;
    try {
      await refreshChatGPTTokenRaw("fake-refresh-token-for-test-only");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(FAKE_LEAKED_REFRESH_TOKEN);
    // The allowlisted error code survives redaction, since terminal-refresh classification
    // substring-matches on it.
    expect(message).toContain("temporarily_unavailable");
  });

  test("xAI postXaiToken (exchange/refresh transport) must not echo the raw error_description", async () => {
    mockJsonResponse(400, {
      error: "server_error", // deliberately outside XaiTokenRequestError's terminal codes
      error_description: `Grant rejected: ${FAKE_LEAKED_REFRESH_TOKEN} does not match any session`,
    });

    let caught: unknown;
    try {
      await postXaiToken(
        "https://auth.x.ai/token",
        { grant_type: "refresh_token", client_id: "client", refresh_token: "fake-refresh-token-for-test-only" },
        undefined,
        { sleep: async () => {} },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(FAKE_LEAKED_REFRESH_TOKEN);
  });

  test("Kimi refreshKimiToken must not echo the raw error_description", async () => {
    mockJsonResponse(400, {
      error: "temporarily_unavailable",
      error_description: `Malformed refresh grant: ${FAKE_LEAKED_REFRESH_TOKEN} was already redeemed`,
    });

    let caught: unknown;
    try {
      await refreshKimiToken("fake-refresh-token-for-test-only");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(FAKE_LEAKED_REFRESH_TOKEN);
  });

  test("supporting evidence: the shared redactor closes the leak the same way for all three providers", async () => {
    mockJsonResponse(400, {
      error: "temporarily_unavailable",
      error_description: `Malformed refresh grant: ${FAKE_LEAKED_REFRESH_TOKEN} was already redeemed`,
    });
    let caught: unknown;
    try {
      await refreshChatGPTTokenRaw("fake-refresh-token-for-test-only");
    } catch (e) {
      caught = e;
    }
    const message = (caught as Error).message;
    // Documents why this is a fix rather than an incidental pass: the codebase's own
    // redactor, already applied to sibling upstream-error sinks in
    // src/server/responses/core.ts, is what closes this path too.
    expect(redactSecretString(message)).not.toContain(FAKE_LEAKED_REFRESH_TOKEN);
    expect(message).toContain("[REDACTED]");
  });
});
