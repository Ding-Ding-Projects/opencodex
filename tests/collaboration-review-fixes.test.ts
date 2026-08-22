import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigDiagnostics, validateConfigCandidate } from "../src/config";
import { salvageSubagentRoles } from "../src/codex/agent-roles";
import { handleResponses } from "../src/server/responses";
import { encryptedInput, routedConfig, codexHeaders, providerResponse, originalFetch } from "./helpers/agent-task-recovery";
import { handleAgentCommand } from "../src/cli/agent";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";

describe("collaboration parent-review boundaries", () => {
  test("salvage scans invalid persisted role arrays with a hard bound", () => {
    const malformed = Array.from({ length: 10_000 }, (_, index) => ({ id: `NOPE-${index}`, description: "x", model: "m", developerInstructions: "y" }));
    const result = salvageSubagentRoles(malformed);
    expect(result.roles).toEqual([]);
    expect(result.warnings.some(warning => warning.includes("first 64"))).toBe(true);
  });

  test("config candidate rejects oversized auto-compaction maps and unsafe role revisions", () => {
    const base = { port: 10100, defaultProvider: "custom", providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } };
    const tooMany = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`model-${index}`, 1_000]));
    expect(validateConfigCandidate({ ...base, providers: { custom: { ...base.providers.custom, modelAutoCompactTokenLimits: tooMany } } })).toMatchObject({ ok: false, error: expect.stringContaining("at most") });
    expect(validateConfigCandidate({ ...base, subagentRolesRevision: -1 })).toMatchObject({ ok: false, error: expect.stringContaining("subagentRolesRevision") });
  });

  test("config diagnostics remove invalid persisted budget maps while retaining providers and warning", () => {
    const previous = process.env.OPENCODEX_HOME;
    const dir = mkdtempSync(join(tmpdir(), "ocx-budget-diagnostics-"));
    process.env.OPENCODEX_HOME = dir;
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({
        port: 10100,
        defaultProvider: "custom",
        providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", modelAutoCompactTokenLimits: { constructor: 1 } } },
      }));
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.config.providers.custom?.modelAutoCompactTokenLimits).toBeUndefined();
      expect(diagnostics.warnings?.some(warning => warning.includes("modelAutoCompactTokenLimits"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ordinary role status DTO omits private developer instructions", async () => {
    const sentinel = "private-instructions-8000-sentinel";
    const config = {
      port: 10100,
      defaultProvider: "openai",
      providers: {},
      subagentRoles: [{ id: "reviewer", description: "review", model: "gpt-5.6-sol", developerInstructions: sentinel, enabled: true }],
    } as any;
    const req = new ManagementRequest("http://localhost/api/subagent-roles");
    const response = await handleManagementAPI(req, new URL(req.url), config);
    expect(response).not.toBeNull();
    const body = await response!.json() as { roles?: Array<Record<string, unknown>> };
    expect(JSON.stringify(body)).not.toContain(sentinel);
    expect(body.roles?.[0]).not.toHaveProperty("developerInstructions");
  });

  test("oversized encrypted-task envelope is rejected before recovery dispatch", async () => {
    const before = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return providerResponse(); }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", ...Object.fromEntries(codexHeaders()) },
        body: JSON.stringify({ model: "xai/grok-4.5", input: encryptedInput({ taskName: `/root/${"x".repeat(400)}` }), stream: false }),
      }), routedConfig({ enabled: true }), { model: "", provider: "" });
      expect(response.status).toBe(400);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = before ?? originalFetch;
    }
  });

  test("role removal CLI performs revision CAS and rejects oversized files before reading", async () => {
    const requests: Array<{ path: string; body: string | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: init?.body as string | undefined });
      return init?.method === "PUT"
        ? Response.json({ ok: true, roles: [] })
        : Response.json({ revision: 7, roles: [] });
    }) as typeof fetch;
    expect(await handleAgentCommand(["roles", "remove", "reviewer", "--json"], { baseUrl: "http://test", fetchImpl })).toBe(0);
    expect(JSON.parse(requests[1]!.body!)).toEqual({ remove: "reviewer", revision: 7 });

    const dir = mkdtempSync(join(tmpdir(), "ocx-role-bound-"));
    try {
      const file = join(dir, "roles.json");
      writeFileSync(file, "x".repeat(128 * 1024 + 1));
      expect(await handleAgentCommand(["roles", "set", "--file", file, "--json"], { baseUrl: "http://test", fetchImpl })).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
