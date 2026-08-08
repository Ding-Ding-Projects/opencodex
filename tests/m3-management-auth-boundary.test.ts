import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

interface RouteProbe {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const PROTECTED_M3_ROUTES: RouteProbe[] = [
  { method: "GET", path: "/api/changelog" },
  { method: "GET", path: "/api/export/capabilities?dataset=requests" },
  { method: "POST", path: "/api/export", body: { dataset: "requests", format: "json" } },
  { method: "GET", path: "/api/host" },
  { method: "PUT", path: "/api/host", body: { exposed: false } },
  { method: "POST", path: "/api/host/pair" },
  { method: "DELETE", path: "/api/host/pair" },
  { method: "GET", path: "/api/host/pair/claim" },
  { method: "GET", path: "/api/host/export" },
  { method: "GET", path: "/api/host/history" },
  { method: "POST", path: "/api/host/restore", body: {} },
  { method: "POST", path: "/api/host/exit", body: {} },
  { method: "POST", path: "/api/host/discover", body: {} },
  { method: "GET", path: "/api/launch" },
  { method: "POST", path: "/api/launch", body: { id: "not-a-target" } },
  { method: "GET", path: "/api/launch/install" },
  { method: "POST", path: "/api/launch/install", body: { id: "not-a-target" } },
  { method: "GET", path: "/api/launch/install/not-a-job" },
  { method: "GET", path: "/api/logs/footprint" },
  { method: "DELETE", path: "/api/logs" },
  { method: "POST", path: "/api/logs/restore", body: {} },
  { method: "GET", path: "/api/terminal" },
  { method: "POST", path: "/api/terminal", body: { preset: "not-a-preset" } },
  { method: "GET", path: "/api/terminal/not-a-session" },
  { method: "DELETE", path: "/api/terminal/not-a-session" },
  { method: "POST", path: "/api/terminal/not-a-session/input", body: { data: "ignored" } },
];

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
      },
    },
  } as OcxConfig;
}

function request(base: URL, probe: RouteProbe, token?: string): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set("x-opencodex-api-key", token);
  if (probe.body) headers.set("content-type", "application/json");
  return fetch(new URL(probe.path, base), {
    method: probe.method,
    headers,
    ...(probe.body ? { body: JSON.stringify(probe.body) } : {}),
  });
}

let home = "";
let previousHome: string | undefined;
let previousAdmin: string | undefined;
let previousData: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  previousData = process.env.OPENCODEX_API_AUTH_TOKEN;
  home = mkdtempSync(join(tmpdir(), "ocx-m3-auth-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  saveConfig(config());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
  if (previousData === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousData;
  removeTempDir(home);
  home = "";
});

describe("M3 management route authentication", () => {
  test("every new management route rejects both missing and data-plane credentials", async () => {
    const server = startServer(0);
    try {
      for (const probe of PROTECTED_M3_ROUTES) {
        expect((await request(server.url, probe)).status, `${probe.method} ${probe.path} without a credential`).toBe(401);
        expect(
          (await request(server.url, probe, "data-secret")).status,
          `${probe.method} ${probe.path} with a data-plane credential`,
        ).toBe(401);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("the admin credential reaches each route family", async () => {
    const server = startServer(0);
    try {
      for (const probe of [
        { method: "GET", path: "/api/changelog" },
        { method: "GET", path: "/api/export/capabilities?dataset=requests" },
        { method: "GET", path: "/api/host" },
        { method: "GET", path: "/api/host/history" },
        { method: "GET", path: "/api/launch" },
        { method: "GET", path: "/api/launch/install" },
        { method: "GET", path: "/api/logs/footprint" },
        { method: "GET", path: "/api/terminal" },
      ] satisfies RouteProbe[]) {
        expect((await request(server.url, probe, "admin-secret")).status, probe.path).toBe(200);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("only POST pairing claim bypasses admin auth and it still spends no invalid token", async () => {
    const server = startServer(0);
    try {
      const claim = await request(server.url, {
        method: "POST",
        path: "/api/host/pair/claim",
        body: { token: "not-a-valid-token" },
      });
      expect(claim.status).toBe(400);
      expect(claim.headers.get("cache-control")).toBe("no-store");
      expect(await claim.json()).toMatchObject({ reason: "no-pairing" });

      expect((await request(server.url, {
        method: "GET",
        path: "/api/host/pair/claim",
      })).status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });
});
