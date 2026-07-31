import { describe, expect, test } from "bun:test";
import { requestProxyStop } from "../src/stop-proxy";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("App proxy stop", () => {
  test("releases the pending UI and exposes a non-2xx server message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({
        success: false,
        message: "native Codex restore failed",
      }, 500)) as typeof fetch,
      formatFailure: status => `Failed to stop proxy (HTTP ${status}).`,
    });

    expect(outcome).toEqual({ accepted: false, message: "native Codex restore failed" });
  });

  test("rejects an HTTP 200 cleanup failure and exposes its server message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({
        success: false,
        message: "native Codex cleanup failed",
      })) as typeof fetch,
      formatFailure: status => `Failed to stop proxy (HTTP ${status}).`,
    });

    expect(outcome).toEqual({ accepted: false, message: "native Codex cleanup failed" });
  });

  test("treats a stop timeout like a dropped connection", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => {
        throw new DOMException("The operation timed out.", "AbortError");
      }) as typeof fetch,
      timeoutMs: 1,
    });

    expect(outcome).toEqual({ accepted: true });
  });

  test("uses the localized fallback when the server omits a message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({}, 503)) as typeof fetch,
      formatFailure: status => `HTTP ${status} stop failed`,
    });

    expect(outcome).toEqual({ accepted: false, message: "HTTP 503 stop failed" });
  });

  /**
   * The Material 3 shell replaced `alert()` with a persistent error snackbar:
   * informational and failure messages are non-modal by contract, and an error
   * notice stays on screen until dismissed rather than blocking the page. The
   * behaviour under test is unchanged — a rejected stop must release the pending
   * UI and surface the server's own remediation text, never swallow it.
   */
  test("App clears stopping state and reports every rejected stop outcome", async () => {
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    const handleStopIdx = app.indexOf("const handleStop");
    const endIdx = app.indexOf("const activePage", handleStopIdx);
    expect(handleStopIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(handleStopIdx);
    const handler = app.slice(handleStopIdx, endIdx);

    expect(handler).toContain("await requestProxyStop(API_BASE");
    expect(handler).toContain("if (!outcome.accepted)");
    expect(handler).toContain("setStopping(false)");
    // The server's message is surfaced verbatim, and as an error so it persists.
    expect(handler).toContain("body: outcome.message");
    expect(handler).toContain('tone: "error"');
    // A stop is a decision, so the confirmation stays blocking — but it is the
    // app's own M3 dialog now. The native `confirm()` drew a grey OS box whose
    // buttons the app could neither theme nor label, so this asserts both halves:
    // the awaited promise API, and the message still coming from the dictionary.
    expect(handler).toContain("await confirm({");
    expect(handler).toContain('body: t("dash.stopConfirm")');
    expect(handler).toContain("if (!confirmed) return;");
  });
});
