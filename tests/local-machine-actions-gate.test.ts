import { afterEach, describe, expect, test } from "bun:test";

import { handleExportRoutes, type Dataset } from "../src/server/management/export-routes";
import { handleHostRoutes } from "../src/server/management/host-routes";
import { requireLoopbackListener } from "../src/server/management/local-machine-gate";
import { setServerRef } from "../src/server/lifecycle";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

function listeningOn(hostname: string | undefined): void {
  setServerRef(hostname === undefined ? undefined : ({ hostname, port: 10100 } as never));
}

afterEach(() => setServerRef(undefined));

function ctx(pathname: string, method: string, body?: unknown): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    }),
    url,
    config: {
      port: 10100,
      hostname: "127.0.0.1",
      providers: {},
    } as OcxConfig,
    deps: {} as ManagementContext["deps"],
    refreshCodexCatalogBestEffort: async () => {},
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

const DATASETS = new Map<string, Dataset>([[
  "requests",
  { id: "requests", label: "Requests", rows: () => [{ ok: true }] },
]]);

describe("local-machine action gate", () => {
  test("launch and install are refused on an exposed listener before catalog lookup or spawn", async () => {
    listeningOn("0.0.0.0");
    for (const path of ["/api/launch", "/api/launch/install"]) {
      const res = await handleHostRoutes(ctx(path, "POST", { id: "totally-made-up" }));
      expect(res?.status, path).toBe(403);
      expect(await res!.json()).toMatchObject({ reason: "loopback-required" });
    }
  });

  test("an unknown listener fails closed for process-starting host routes", async () => {
    listeningOn(undefined);
    for (const path of ["/api/launch", "/api/launch/install"]) {
      const res = await handleHostRoutes(ctx(path, "POST", { id: "totally-made-up" }));
      expect(res?.status, path).toBe(403);
    }
  });

  test("opening an export in VS Code is refused on exposed and unknown listeners", async () => {
    for (const hostname of ["0.0.0.0", undefined]) {
      listeningOn(hostname);
      const res = await handleExportRoutes(ctx("/api/export", "POST", {
        dataset: "requests",
        format: "json",
        openInVsCode: true,
      }), DATASETS);
      expect(res?.status, String(hostname)).toBe(403);
      expect(await res!.json()).toMatchObject({ reason: "loopback-required" });
    }
  });

  test("a known loopback listener passes the shared gate", async () => {
    listeningOn("127.0.0.1");
    expect(requireLoopbackListener(ctx("/api/launch", "POST"), "Launching applications")).toBeNull();
  });
});
