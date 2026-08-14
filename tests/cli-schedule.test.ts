/**
 * `ocx schedule` — the headless counterpart to the dashboard's Scheduled
 * settings page.
 *
 * Two things this suite has to prove, mirroring `tests/cli-narrator.test.ts`
 * for the same reason: the honest non-answer (`status`/`list`/`show`/
 * `active`) never contacts the runtime at all, and the real passthroughs
 * (`test-api`/`test-ha`/`ha-token`) hit exactly the routes
 * `src/server/management/schedule-routes.ts` exposes, with exactly the body
 * the route expects.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { handleScheduleCommand } from "../src/cli/schedule";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  process.exitCode = 0;
});

function fakeRuntime(responder?: (req: Request, body: unknown) => unknown) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      requests.push({ path: `${url.pathname}${url.search}`, method: req.method, body });
      const custom = responder?.(req, body);
      if (custom !== undefined) return Response.json(custom);
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.log = log; console.error = error; } };
}

describe("ocx schedule — rules are browser-only, and it says so without contacting anything", () => {
  test("status contacts nothing and names where rules actually live", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["status", "--json"], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    const payload = JSON.parse(output.lines.filter(line => line.startsWith("{")).join("\n")) as {
      rules: { readable: boolean; storedIn: string; manageAt: string; precedence: string };
    };
    expect(payload.rules.readable).toBe(false);
    expect(payload.rules.storedIn).toContain("ocx-m3:schedule");
    expect(payload.rules.manageAt).toContain("Scheduled settings");
    expect(payload.rules.precedence).toContain("highest priority wins");
  });

  test("list, show and active each contact nothing and report the same honest non-answer", async () => {
    const runtime = fakeRuntime();
    for (const args of [["list", "--json"], ["show", "evening", "--json"], ["active", "--json"]]) {
      const output = captureStdout();
      try {
        expect(await handleScheduleCommand(args, runtime.deps)).toBe(0);
      } finally {
        output.restore();
      }
      const payload = JSON.parse(output.lines.filter(line => line.startsWith("{")).join("\n")) as {
        rules: { readable: boolean };
      };
      expect(payload.rules.readable).toBe(false);
    }
    expect(runtime.requests).toEqual([]);
  });

  test("show without an id is a usage error", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["show"], runtime.deps)).toBe(2);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    expect(output.lines.join("\n")).toContain("requires a rule id");
  });
});

describe("ocx schedule test-api — passthrough onto POST /api/schedule/resolve-api", () => {
  test("posts the exact body the route expects and prints resolved values", async () => {
    const runtime = fakeRuntime((req) => (
      new URL(req.url).pathname === "/api/schedule/resolve-api"
        ? { ok: true, values: { theme: "dark", density: 3 } }
        : undefined
    ));
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["test-api", "https://example.test/schedule.json", "--json"], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([{
      path: "/api/schedule/resolve-api",
      method: "POST",
      body: { url: "https://example.test/schedule.json" },
    }]);
    const payload = JSON.parse(output.lines.filter(line => line.startsWith("{")).join("\n")) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  test("a reported failure (not thrown) still exits 0, matching ocx narrator's unreachable-catalogue treatment", async () => {
    const runtime = fakeRuntime((req) => (
      new URL(req.url).pathname === "/api/schedule/resolve-api"
        ? { ok: false, reason: "too-large", error: "response exceeded the size limit" }
        : undefined
    ));
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["test-api", "https://example.test/schedule.json"], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(output.lines.join("\n")).toContain("Failed (too-large): response exceeded the size limit");
  });

  test("a URL rejected at the SSRF boundary (HTTP 400) surfaces as a runtime error, not a silent pass", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() { return Response.json({ ok: false, reason: "invalid-url", error: "url must be https://, or http://127.0.0.1 / http://localhost for local development" }, { status: 400 }); },
    });
    servers.push(server);
    const deps = { baseUrl: `http://127.0.0.1:${server.port}` };
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["test-api", "http://169.254.169.254/latest/meta-data"], deps)).not.toBe(0);
    } finally {
      output.restore();
    }
    expect(output.lines.join("\n")).toContain("url must be https://");
  });

  test("requires a URL argument", async () => {
    const runtime = fakeRuntime();
    expect(await handleScheduleCommand(["test-api"], runtime.deps)).toBe(2);
    expect(runtime.requests).toEqual([]);
  });
});

describe("ocx schedule test-ha — passthrough onto POST /api/schedule/ha-state", () => {
  test("posts the exact body the route expects and reports an 'on' state as applying", async () => {
    const runtime = fakeRuntime((req) => (
      new URL(req.url).pathname === "/api/schedule/ha-state" ? { ok: true, state: "on" } : undefined
    ));
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand([
        "test-ha", "--base-url", "https://ha.local", "--entity-id", "input_boolean.evening", "--token-ref", "ha-tok-1",
      ], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([{
      path: "/api/schedule/ha-state",
      method: "POST",
      body: { baseUrl: "https://ha.local", entityId: "input_boolean.evening", tokenRef: "ha-tok-1" },
    }]);
    expect(output.lines.join("\n")).toContain("would apply its values right now");
  });

  test("an 'off' state is reported as not applying, without treating it as a failure", async () => {
    const runtime = fakeRuntime((req) => (
      new URL(req.url).pathname === "/api/schedule/ha-state" ? { ok: true, state: "off" } : undefined
    ));
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand([
        "test-ha", "--base-url", "https://ha.local", "--entity-id", "input_boolean.evening", "--token-ref", "ha-tok-1",
      ], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(output.lines.join("\n")).toContain("would NOT apply right now");
  });

  test("requires all three flags", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["test-ha", "--base-url", "https://ha.local"], runtime.deps)).toBe(2);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    expect(output.lines.join("\n")).toContain("--base-url, --entity-id and --token-ref");
  });
});

describe("ocx schedule ha-token — status and clear, and no way to set one", () => {
  test("status queries GET /api/schedule/ha-token?tokenRef= and never sends a secret", async () => {
    const runtime = fakeRuntime((req) => (
      new URL(req.url).pathname === "/api/schedule/ha-token" ? { configured: true } : undefined
    ));
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["ha-token", "status", "--token-ref", "ha-tok-1", "--json"], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([{ path: "/api/schedule/ha-token?tokenRef=ha-tok-1", method: "GET", body: null }]);
    const payload = JSON.parse(output.lines.filter(line => line.startsWith("{")).join("\n")) as { configured: boolean };
    expect(payload.configured).toBe(true);
  });

  test("clear sends DELETE with only the tokenRef — never a token value", async () => {
    const runtime = fakeRuntime((req) => (
      new URL(req.url).pathname === "/api/schedule/ha-token" ? { ok: true } : undefined
    ));
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["ha-token", "clear", "--token-ref", "ha-tok-1"], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([{ path: "/api/schedule/ha-token", method: "DELETE", body: { tokenRef: "ha-tok-1" } }]);
    expect(output.lines.join("\n")).toContain("Cleared any Home Assistant token");
  });

  test("there is no ha-token set subcommand — the parser has never heard of one", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleScheduleCommand(["ha-token", "set", "--token-ref", "ha-tok-1"], runtime.deps)).toBe(2);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    expect(output.lines.join("\n")).toContain('unknown schedule ha-token command "set"');
  });

  test("requires --token-ref", async () => {
    const runtime = fakeRuntime();
    expect(await handleScheduleCommand(["ha-token", "status"], runtime.deps)).toBe(2);
    expect(runtime.requests).toEqual([]);
  });
});

test("an unknown schedule subcommand is a usage error", async () => {
  const runtime = fakeRuntime();
  expect(await handleScheduleCommand(["nope"], runtime.deps)).toBe(2);
  expect(runtime.requests).toEqual([]);
});
