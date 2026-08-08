/**
 * The gate in front of the embedded terminal.
 *
 * This is the one behaviour where being wrong is not a bug but a foothold: a
 * terminal route answering on an exposed bind turns a leaked dashboard
 * credential into command execution on the host. Every route is checked, not
 * just session creation, because a reader or a writer against an existing
 * session would be just as good to an attacker.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { handleHostRoutes } from "../src/server/management/host-routes";
import { setServerRef } from "../src/server/lifecycle";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

/**
 * Pretend the process is listening on `hostname`.
 *
 * The gate reads the live listener, not `config.hostname`, so a test that only
 * set the config would be exercising a field the production code deliberately
 * ignores — and would have passed against the vulnerable version.
 */
function listeningOn(hostname: string | undefined): void {
  setServerRef(hostname === undefined ? undefined : ({ hostname, port: 10100 } as never));
}

afterEach(() => setServerRef(undefined));

function ctx(pathname: string, method: string, config: Partial<OcxConfig>): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  return {
    req: new Request(url, {
      method,
      ...(method === "POST" ? { body: "{}", headers: { "Content-Type": "application/json" } } : {}),
    }),
    url,
    config: { port: 10100, ...config } as OcxConfig,
    deps: {} as ManagementContext["deps"],
    refreshCodexCatalogBestEffort: async () => {},
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

const ROUTES: Array<[string, string]> = [
  ["/api/terminal", "GET"],
  ["/api/terminal", "POST"],
  ["/api/terminal/term-1", "GET"],
  ["/api/terminal/term-1", "DELETE"],
  ["/api/terminal/term-1/input", "POST"],
];

describe("terminal route gate", () => {
  test("every terminal route is refused on an all-interfaces bind", async () => {
    listeningOn("0.0.0.0");
    for (const [path, method] of ROUTES) {
      const res = await handleHostRoutes(ctx(path, method, { hostname: "0.0.0.0" }));
      expect(res).not.toBeNull();
      expect(`${method} ${path} → ${res!.status}`).toBe(`${method} ${path} → 403`);
    }
  });

  test("a LAN address is refused too, not just 0.0.0.0", async () => {
    listeningOn("192.168.1.50");
    const res = await handleHostRoutes(ctx("/api/terminal", "GET", { hostname: "192.168.1.50" }));
    expect(res!.status).toBe(403);
    const body = await res!.json() as { error?: string };
    // The message has to say what to do, not merely that the door is shut.
    expect(body.error).toContain("127.0.0.1");
  });

  test("loopback is allowed", async () => {
    listeningOn("127.0.0.1");
    const res = await handleHostRoutes(ctx("/api/terminal", "GET", { hostname: "127.0.0.1" }));
    expect(res!.status).toBe(200);
    const body = await res!.json() as { presets?: unknown[] };
    expect(Array.isArray(body.presets)).toBe(true);
  });

  test("a listener on loopback is allowed even with no hostname in config", async () => {
    // The config field is irrelevant to the decision; only the listener counts.
    listeningOn("127.0.0.1");
    const res = await handleHostRoutes(ctx("/api/terminal", "GET", {}));
    expect(res!.status).toBe(200);
  });

  test("a config edit cannot open the gate while the listener is still exposed", async () => {
    // The whole point. `PUT /api/host` can rewrite config.hostname at runtime,
    // but the socket stays bound where Bun.serve put it until a restart. A gate
    // reading the config would hand out a shell on a LAN-reachable listener.
    listeningOn("0.0.0.0");
    const res = await handleHostRoutes(ctx("/api/terminal", "GET", { hostname: "127.0.0.1" }));
    expect(res!.status).toBe(403);
  });

  test("no listener yet is treated as exposed, not as safe", async () => {
    listeningOn(undefined);
    const res = await handleHostRoutes(ctx("/api/terminal", "GET", { hostname: "127.0.0.1" }));
    expect(res!.status).toBe(403);
  });

  test("the explicit opt-in re-opens it on an exposed bind", async () => {
    listeningOn("0.0.0.0");
    const res = await handleHostRoutes(
      ctx("/api/terminal", "GET", { hostname: "0.0.0.0", terminal: { allowRemote: true } }),
    );
    expect(res!.status).toBe(200);
  });

  test("allowRemote only counts when it is exactly true", async () => {
    // A truthy-but-not-true value from a hand-edited config must not open the
    // door: this is the one setting where a loose check is a security bug.
    listeningOn("0.0.0.0");
    for (const value of ["true", 1, {}, [], "yes"] as unknown[]) {
      const res = await handleHostRoutes(
        ctx("/api/terminal", "GET", { hostname: "0.0.0.0", terminal: { allowRemote: value as boolean } }),
      );
      expect(`${JSON.stringify(value)} → ${res!.status}`).toBe(`${JSON.stringify(value)} → 403`);
    }
  });
});
