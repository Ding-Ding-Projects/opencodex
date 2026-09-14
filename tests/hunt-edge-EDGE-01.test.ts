import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * EDGE-01: the management-plane request-size gate in
 * `src/server/management-api.ts` is:
 *
 *   const contentLength = Number(req.headers.get("content-length") ?? "0");
 *   if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
 *     return jsonResponse({ error: "request body too large" }, 413, req, config);
 *   }
 *
 * `Number("not-a-number")` is `NaN`, and `Number.isFinite(NaN)` is `false`, so an
 * unparseable `Content-Length` header makes the whole guard a no-op: a genuinely
 * oversized body sails straight past the "reject before any handler buffers it"
 * check the comment above it promises. The neighbouring file's own docstring
 * ("Management bodies are small JSON ... Reject oversized payloads before any
 * handler buffers them — the data plane has its own decompression cap") says
 * this is the *only* size guard for this plane, so the bypass is not redundant
 * with anything else upstream or downstream.
 *
 * This is a finder-authored regression test (`hunt/edge-cases` lane). It does
 * not fix anything; it only proves the gap is real against the exact exported
 * function the route dispatcher calls, with a genuinely oversized 3 MiB body
 * (not just a spoofed header) so the byte count really does violate the 2 MiB
 * limit.
 */

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function minimalConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-hunt-edge-01-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) removeTempDir(testHome);
  testHome = "";
});

const TWO_MIB = 2 * 1024 * 1024;
const OVERSIZED_BODY = "x".repeat(TWO_MIB + 1024 * 1024); // 3 MiB, genuinely over the limit

describe("EDGE-01: management-api content-length size gate", () => {
  test("control: a well-formed oversized content-length is rejected with 413", async () => {
    const req = new Request("http://localhost/api/does-not-exist", {
      method: "POST",
      // A real Bun.serve()-received request always carries Host (the client sent
      // it; HTTP/1.1 requires it). A directly-constructed Request does not get
      // one for free, so it is set explicitly here to match what handleManagementAPI
      // actually receives in production, rather than tripping its unrelated
      // "no Host header" 403 path.
      headers: { Host: "localhost", "content-length": String(OVERSIZED_BODY.length), "content-type": "application/json" },
      body: OVERSIZED_BODY,
    });
    const response = await handleManagementAPI(req, new URL(req.url), minimalConfig(), {});
    expect(response).not.toBeNull();
    expect(response?.status).toBe(413);
  });

  test("a non-numeric content-length header lets a genuinely 3 MiB body through the size gate", async () => {
    // Same 3 MiB body as the control above; only the header text changes.
    const req = new Request("http://localhost/api/does-not-exist", {
      method: "POST",
      headers: { Host: "localhost", "content-length": "not-a-number", "content-type": "application/json" },
      body: OVERSIZED_BODY,
    });
    // Sanity: the runtime really did keep the spoofed header and really did send
    // all 3 MiB of body, so this is not a JavaScript-engine artifact.
    expect(req.headers.get("content-length")).toBe("not-a-number");

    const response = await handleManagementAPI(req, new URL(req.url), minimalConfig(), {});
    // The gate exists specifically to stop this: a request whose body is over
    // 2 MiB must never reach route dispatch. It should still be 413 here. It
    // is not: `Number.isFinite(NaN)` short-circuits the whole check to "allow",
    // so this unmatched route falls through to the function's final `return
    // null` instead of ever being rejected for size.
    expect(response?.status).toBe(413);
  });
});
