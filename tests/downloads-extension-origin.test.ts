/**
 * The one deliberate widening of the management-origin gate: a `*-extension://`
 * Origin may reach `/api/downloads/*` even though it is not the dashboard's
 * own origin — see `isAllowedDownloadCaptureOrigin` in `src/server/auth-cors.ts`
 * and where it is consulted in `handleManagementAPI`
 * (`src/server/management-api.ts`).
 *
 * Proven end to end through `handleManagementAPI` itself, not just the pure
 * predicate: a unit test of `isAllowedDownloadCaptureOrigin` could pass while
 * the dispatcher never actually consulted it, which is exactly the gap this
 * file exists to close.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import { isAllowedDownloadCaptureOrigin, isExtensionOrigin } from "../src/server/auth-cors";
import { setServerRef } from "../src/server/lifecycle";
import { resetDownloadManagerForTests } from "../src/lib/downloads/manager";
import { removeTempDir } from "./helpers/temp-dir";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const HOSTILE_ORIGIN = "https://evil.example";

let dir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  dir = mkdtempSync(join(tmpdir(), "ocx-dlorigin-"));
  process.env.OPENCODEX_HOME = dir;
  resetDownloadManagerForTests();
  setServerRef({ hostname: "127.0.0.1", port: 10101 } as never);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (dir) removeTempDir(dir);
  resetDownloadManagerForTests();
  setServerRef(undefined);
});

function requestWithOrigin(pathname: string, origin: string | null, body: unknown = { url: "https://example.test/x" }): Request {
  const url = new URL(`http://127.0.0.1:10101${pathname}`);
  const headers = new Headers({ Host: url.host, "Content-Type": "application/json" });
  if (origin) headers.set("Origin", origin);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("isExtensionOrigin — the predicate this whole widening rests on", () => {
  test("matches the browser-assigned extension origin forms", () => {
    expect(isExtensionOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).toBe(true);
    expect(isExtensionOrigin("moz-extension://12345678-1234-1234-1234-123456789012")).toBe(true);
  });

  test("never matches an ordinary page origin — this is what stops a hostile web page forging its way through", () => {
    expect(isExtensionOrigin("https://evil.example")).toBe(false);
    expect(isExtensionOrigin("http://127.0.0.1:10101")).toBe(false);
    expect(isExtensionOrigin(null)).toBe(false);
  });
});

describe("isAllowedDownloadCaptureOrigin", () => {
  test("true for an extension origin against a loopback-bound listener", () => {
    const config = loadConfig();
    const req = requestWithOrigin("/api/downloads/capture", EXTENSION_ORIGIN);
    expect(isAllowedDownloadCaptureOrigin(req, config)).toBe(true);
  });

  test("false for an ordinary page origin, even against a loopback listener", () => {
    const config = loadConfig();
    const req = requestWithOrigin("/api/downloads/capture", HOSTILE_ORIGIN);
    expect(isAllowedDownloadCaptureOrigin(req, config)).toBe(false);
  });
});

describe("handleManagementAPI — the widening applies to /api/downloads only", () => {
  test("an extension-origin POST to /api/downloads/capture is accepted", async () => {
    const config = loadConfig();
    const req = requestWithOrigin("/api/downloads/capture", EXTENSION_ORIGIN);
    const res = await handleManagementAPI(req, new URL(req.url), config);
    expect(res?.status).toBe(201);
  });

  test("a hostile page origin is still refused for /api/downloads/capture", async () => {
    const config = loadConfig();
    const req = requestWithOrigin("/api/downloads/capture", HOSTILE_ORIGIN);
    const res = await handleManagementAPI(req, new URL(req.url), config);
    expect(res?.status).toBe(403);
  });

  test("the SAME extension origin is still refused for an unrelated management route — the widening is scoped to /api/downloads only", async () => {
    const config = loadConfig();
    const req = requestWithOrigin("/api/config", EXTENSION_ORIGIN, {});
    const res = await handleManagementAPI(req, new URL(req.url), config);
    expect(res?.status).toBe(403);
  });

  test("no Origin header at all — a plain server-to-server or curl-style call — is still accepted (unchanged prior behaviour)", async () => {
    const config = loadConfig();
    const req = requestWithOrigin("/api/downloads/capture", null);
    const res = await handleManagementAPI(req, new URL(req.url), config);
    expect(res?.status).toBe(201);
  });
});
