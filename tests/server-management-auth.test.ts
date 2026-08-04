import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { serveGuiFile } from "../src/server/gui-static";
import { isProxyAdmissionSecret } from "../src/server/auth-cors";
import { removeTempDir } from "./helpers/temp-dir";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-management-open-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) removeTempDir(testHome);
  testHome = "";
});

describe("management plane without an admin-token gate", () => {
  test("management routes accept no credential, a data key, or a legacy admin key", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      for (const headers of [undefined, { "x-opencodex-api-key": "data-secret" }, { "x-opencodex-api-key": "admin-secret" }]) {
        const response = await fetch(new URL("/api/config", server.url), headers ? { headers } : undefined);
        expect(response.status).toBe(200);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("data-plane authentication remains separate on a remote bind", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/v1/models", server.url));
      expect(missing.status).toBe(401);
      const accepted = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(accepted.status).toBe(200);
      const admin = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(admin.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("the server never creates or reads an admin-token file", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const legacyPath = join(testHome, "admin-api-token");
    writeFileSync(legacyPath, "legacy-token\n", "utf8");
    const server = startServer(0);
    try {
      expect(existsSync(legacyPath)).toBe(true);
      expect((await fetch(new URL("/api/config", server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("the removed GUI-session endpoint is not needed and pages contain no session bootstrap", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const guiDist = join(testHome, "gui");
    mkdirSync(guiDist);
    writeFileSync(join(guiDist, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    const page = serveGuiFile("/", guiDist);
    expect(await page?.text()).not.toContain("opencodex-session-token");

    const server = await startServer(config);
    try {
      const session = await fetch(new URL("/api/gui-session", server.url));
      expect(session.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test("management CORS still reflects allowed same-origin requests", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      const origin = server.url.origin;
      const sameOrigin = await fetch(new URL("/api/config", server.url), { headers: { Origin: origin } });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(origin);
    } finally {
      await server.stop(true);
    }
  });

  test("proxy admission credentials remain blocked from upstream forwarding", () => {
    const config = remoteConfig();
    for (const value of ["ocx_admin_legacy", "ocx_session_legacy", "ocx_data_legacy", "data-secret", "admin-secret"]) {
      expect(isProxyAdmissionSecret(value, config)).toBe(true);
    }
  });
});
