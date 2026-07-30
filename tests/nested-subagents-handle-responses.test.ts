/**
 * handleResponses integration for nested sub-agents: the ceilings must be enforced on the body
 * that actually reaches the provider, not merely described to the model — and a config without
 * the `nestedSubagents` block must produce a byte-identical upstream request.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../src/server/responses";
import { __resetNestedSubagentRegistryForTests } from "../src/server/nested-subagents";
import { setSpawnEdgeReaderForTests } from "../src/server/nested-subagents-edges";
import type { OcxConfig } from "../src/types";
import type { RequestLogContext } from "../src/server/request-log";
import { removeTempDir } from "./helpers/temp-dir";

const originalFetch = globalThis.fetch;
let testDir = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-nested-hr-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  __resetNestedSubagentRegistryForTests();
  // No CODEX_HOME state DB in this fixture: depth must come from the addresses alone, which is
  // also the Docker deployment shape.
  setSpawnEdgeReaderForTests(() => null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetNestedSubagentRegistryForTests();
  setSpawnEdgeReaderForTests(null);
  removeTempDir(testDir);
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function routedConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "xai-test" },
    },
    ...overrides,
  } as OcxConfig;
}

const COLLAB_TOOL_SPECS = [
  { type: "function", name: "spawn_agent", description: "spawn", parameters: { type: "object", properties: {} } },
  { type: "function", name: "send_message", description: "send", parameters: { type: "object", properties: {} } },
  { type: "function", name: "list_agents", description: "list", parameters: { type: "object", properties: {} } },
  { type: "function", name: "shell", description: "run", parameters: { type: "object", properties: {} } },
];

function spawnBody(recipient: string, author = "/root"): Record<string, unknown> {
  return {
    model: "xai/grok-4.5",
    stream: false,
    tools: COLLAB_TOOL_SPECS,
    input: [
      {
        type: "agent_message",
        id: "019f5e7f-ac31-7610-b69c-43ae41759fce",
        author,
        recipient,
        content: [{ type: "input_text", text: "TASK: build the thing" }],
      },
    ],
  };
}

function captureUpstream(): { bodies: string[] } {
  const capture = { bodies: [] as string[] };
  globalThis.fetch = (async (_input, init) => {
    capture.bodies.push(typeof init?.body === "string" ? init.body : "");
    return Response.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "grok-4.5",
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
  return capture;
}

async function post(
  config: OcxConfig,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-openai-subagent": "collab_spawn",
        "session_id": "sess-nested",
        ...extraHeaders,
      }),
      body: JSON.stringify(body),
    }),
    config,
    logCtx,
  );
}

describe("nested sub-agents through handleResponses", () => {
  test("a grandchild at maxDepth reaches the provider with NO delegation tools", async () => {
    const capture = captureUpstream();
    const config = routedConfig({ nestedSubagents: { enabled: true, maxDepth: 2 } });

    const response = await post(config, spawnBody("/root/worker/helper", "/root/worker"));
    expect(response.status).toBe(200);
    expect(capture.bodies).toHaveLength(1);

    const sent = JSON.parse(capture.bodies[0]) as {
      tools?: Array<{ function?: { name?: string }; name?: string }>;
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolNames = (sent.tools ?? []).map(tool => tool.function?.name ?? tool.name);
    expect(toolNames).toContain("shell");
    expect(toolNames).not.toContain("spawn_agent");
    expect(toolNames).not.toContain("send_message");
    expect(toolNames).not.toContain("list_agents");

    // ...and the model is told WHY they vanished, so it does the work instead of reporting a
    // broken environment.
    const developer = JSON.stringify(sent.messages);
    expect(developer).toContain("leaf agent");
  });

  test("a child below the ceiling keeps its delegation tools", async () => {
    const capture = captureUpstream();
    const config = routedConfig({ nestedSubagents: { enabled: true, maxDepth: 2 } });

    const response = await post(config, spawnBody("/root/worker"));
    expect(response.status).toBe(200);

    const sent = JSON.parse(capture.bodies[0]) as { tools?: Array<{ function?: { name?: string } }> };
    const toolNames = (sent.tools ?? []).map(tool => tool.function?.name);
    expect(toolNames).toContain("spawn_agent");
    expect(toolNames).toContain("send_message");
  });

  test("a depth KNOWN to exceed the ceiling is refused before any upstream call", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    }) as typeof fetch;
    const config = routedConfig({ nestedSubagents: { enabled: true, maxDepth: 1 } });

    const response = await post(config, spawnBody("/root/worker/helper", "/root/worker"));
    expect(response.status).toBe(400);
    expect(fetchCalls).toBe(0);
    const payload = await response.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("subagent_depth_limit_exceeded");
    expect(payload.error.message).toContain("maximum of 1");
  });

  test("an unresolvable depth is clamped, never refused", async () => {
    const capture = captureUpstream();
    const config = routedConfig({ nestedSubagents: { enabled: true, maxDepth: 2 } });

    // Bare (non-path) addresses: nothing resolves, no state DB to fall back to.
    const response = await post(config, {
      model: "xai/grok-4.5",
      stream: false,
      tools: COLLAB_TOOL_SPECS,
      input: [{ type: "agent_message", author: "probe_all", recipient: "root", content: [{ type: "input_text", text: "TASK" }] }],
    });
    expect(response.status).toBe(200);
    const sent = JSON.parse(capture.bodies[0]) as { tools?: Array<{ function?: { name?: string } }> };
    expect((sent.tools ?? []).map(tool => tool.function?.name)).not.toContain("spawn_agent");
  });

  test("the per-depth effort cap tightens and cannot raise the existing cap", async () => {
    const capture = captureUpstream();
    const config = routedConfig({
      subagentEffortCap: "high",
      nestedSubagents: { enabled: true, maxDepth: 3, depths: [{ effortCap: "low" }] },
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test",
          reasoningEfforts: ["low", "medium", "high", "max"],
        },
      },
    });

    await post(config, { ...spawnBody("/root/worker"), reasoning: { effort: "max", summary: "auto" } });
    const sent = JSON.parse(capture.bodies[0]) as { reasoning_effort?: string };
    // depth-1 row says low; subagentEffortCap says high; lowest wins.
    expect(sent.reasoning_effort).toBe("low");
  });

  test("with NO nestedSubagents block the upstream request is byte-identical", async () => {
    const withoutFeature = captureUpstream();
    await post(routedConfig(), spawnBody("/root/worker/helper", "/root/worker"));

    __resetNestedSubagentRegistryForTests();
    const withDisabledBlock = captureUpstream();
    await post(
      routedConfig({ nestedSubagents: { enabled: false, maxDepth: 1 } }),
      spawnBody("/root/worker/helper", "/root/worker"),
    );

    expect(withDisabledBlock.bodies[0]).toBe(withoutFeature.bodies[0]);
    // And the delegation tools a pre-feature user relied on are still there.
    const sent = JSON.parse(withoutFeature.bodies[0]) as { tools?: Array<{ function?: { name?: string } }> };
    expect((sent.tools ?? []).map(tool => tool.function?.name)).toContain("spawn_agent");
  });
});
