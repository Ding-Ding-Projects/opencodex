import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSecurityHeaders, corsHeaders } from "../src/server/auth-cors";
import { serveGuiFile } from "../src/server/gui-static";

const EXPECTED = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'",
};

describe("clickjacking response headers", () => {
  test("the shared browser header set denies all framing", () => {
    expect(browserSecurityHeaders()).toEqual(EXPECTED);
  });

  test("API and preflight headers include the framing policy", () => {
    expect(corsHeaders()).toMatchObject(EXPECTED);
  });

  test("static dashboard responses include the framing policy", async () => {
    const guiDist = mkdtempSync(join(tmpdir(), "ocx-gui-headers-"));
    writeFileSync(
      join(guiDist, "index.html"),
      "<!doctype html><title>test</title><script>window.__ocxTest = true</script>",
    );
    try {
      const response = serveGuiFile("/", guiDist);
      expect(response).not.toBeNull();
      expect(response?.headers.get("X-Frame-Options")).toBe("DENY");
      const policy = response?.headers.get("Content-Security-Policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
      expect(await response?.text()).toMatch(/<script nonce="[A-Za-z0-9+/=]+"/);
    } finally {
      rmSync(guiDist, { recursive: true, force: true });
    }
  });
});
