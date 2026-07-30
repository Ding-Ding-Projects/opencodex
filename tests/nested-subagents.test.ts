/**
 * Nested sub-agents (src/server/nested-subagents.ts): depth derivation from sources the model
 * cannot influence, the ceilings actually being enforced on the request body, the unknown-depth
 * path failing toward "deeper", and — the constraint that matters most to existing users — a
 * config without the block behaving exactly as it did before the feature existed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig } from "../src/config";
import { removeTempDir } from "./helpers/temp-dir";
import {
  __nestedSubagentSessionCountForTests,
  __resetNestedSubagentRegistryForTests,
  agentAddressDepth,
  captureAgentLineage,
  COLLAB_TOOL_NAMES,
  depthRowFor,
  evaluateNestedSubagents,
  leafDeveloperNote,
  NESTED_DEFAULTS,
  NESTED_MAX_DEPTH_LIMIT,
  nestedSubagentSettings,
  stripCollabToolsInPlace,
  SUBAGENT_DEPTH_LIMIT_CODE,
  worstCaseSpawnCount,
} from "../src/server/nested-subagents";
import {
  buildSpawnEdgeGraph,
  latchedHeaderSemantics,
  resetHeaderSemanticsForTests,
  setSpawnEdgeReaderForTests,
  spawnEdgeDepth,
} from "../src/server/nested-subagents-edges";
import { applyEffortCap, effortCapAppliesTo, effortCapFor } from "../src/server/effort-policy";
import { collabSurface, multiAgentGuidanceText } from "../src/server/responses";
import { applyInjectionPlaceholders } from "../src/server/responses/collaboration";
import { sanitizeEncryptedContentInPlace } from "../src/server/responses/encrypted-payload";
import type { OcxConfig, OcxNestedSubagentsConfig, OcxParsedRequest, OcxTool } from "../src/types";

afterEach(() => {
  __resetNestedSubagentRegistryForTests();
  setSpawnEdgeReaderForTests(null);
  resetHeaderSemanticsForTests();
});

const SPAWN_HEADERS = (extra: Record<string, string> = {}): Headers =>
  new Headers({ "x-openai-subagent": "collab_spawn", ...extra });
const MAIN_HEADERS = (extra: Record<string, string> = {}): Headers => new Headers(extra);

function nested(overrides: Partial<OcxNestedSubagentsConfig> = {}): Pick<OcxConfig, "nestedSubagents"> {
  return { nestedSubagents: { enabled: true, ...overrides } };
}

const V2_TOOLS: OcxTool[] = [
  { name: "spawn_agent", description: "", parameters: {} },
  { name: "send_message", description: "", parameters: {} },
  { name: "shell", description: "", parameters: {} },
];

function makeParsed(options: { tools?: OcxTool[]; rawTools?: unknown[]; input?: unknown[]; reasoning?: string } = {}): OcxParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: options.tools ?? V2_TOOLS.map(tool => ({ ...tool })),
    },
    stream: true,
    options: options.reasoning ? { reasoning: options.reasoning as never } : {},
    _rawBody: {
      model: "gpt-5.6-sol",
      tools: options.rawTools ?? [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "send_message" },
        { type: "function", name: "shell" },
      ],
      input: options.input ?? [],
      ...(options.reasoning ? { reasoning: { effort: options.reasoning, summary: "auto" } } : {}),
    },
  } as OcxParsedRequest;
}

/** A NEW_TASK agent_message shaped like the one codex-rs appends to a spawned child's input. */
function taskItem(author: string, recipient: string, text = "TASK: do the thing"): Record<string, unknown> {
  return {
    type: "agent_message",
    id: "019f5e7f-ac31-7610-b69c-43ae41759fce",
    author,
    recipient,
    content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: ${recipient}\nSender: ${author}\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: text },
    ],
  };
}

// ---------------------------------------------------------------------------

describe("settings resolution", () => {
  test("absent block disables the feature entirely", () => {
    expect(nestedSubagentSettings({})).toBeNull();
    expect(nestedSubagentSettings({ nestedSubagents: {} })).toBeNull();
    expect(nestedSubagentSettings({ nestedSubagents: { enabled: false, maxDepth: 4 } })).toBeNull();
  });

  test("defaults are conservative and mutually consistent", () => {
    const settings = nestedSubagentSettings(nested())!;
    expect(settings.maxDepth).toBe(NESTED_DEFAULTS.maxDepth);
    expect(settings.maxChildrenPerNode).toBe(NESTED_DEFAULTS.maxChildrenPerNode);
    expect(settings.maxTotalSpawnsPerSession).toBe(NESTED_DEFAULTS.maxTotalSpawnsPerSession);
    // 3 children + 9 grandchildren = 12 = the session budget: three knobs, one ceiling.
    expect(worstCaseSpawnCount(settings)).toBe(settings.maxTotalSpawnsPerSession);
  });

  test("hand-edited values are clamped at READ time, not merely validated at write time", () => {
    const settings = nestedSubagentSettings(nested({
      maxDepth: 99,
      maxChildrenPerNode: 0,
      maxTotalSpawnsPerSession: -5,
      maxTurnsPerSpawnedAgent: 999_999,
      unknownDepthAssumption: 50,
    }))!;
    expect(settings.maxDepth).toBe(NESTED_MAX_DEPTH_LIMIT);
    expect(settings.maxChildrenPerNode).toBe(1);
    expect(settings.maxTotalSpawnsPerSession).toBe(1);
    expect(settings.maxTurnsPerSpawnedAgent).toBe(1000);
    expect(settings.unknownDepth).toBeLessThanOrEqual(settings.maxDepth);
  });

  test("unresolvable depth defaults to the deepest level (fail deep), and 1 is an explicit opt-in", () => {
    expect(nestedSubagentSettings(nested({ maxDepth: 3 }))!.unknownDepth).toBe(3);
    expect(nestedSubagentSettings(nested({ maxDepth: 3, unknownDepthAssumption: 1 }))!.unknownDepth).toBe(1);
  });

  test("non-ladder effort strings in a depth row are dropped, never passed through as a cap", () => {
    const settings = nestedSubagentSettings(nested({
      depths: [{ effortCap: "turbo", injectionEffort: "nope" }, { effortCap: "low", injectionEffort: "high" }],
    }))!;
    expect(depthRowFor(settings, 1)).toEqual({
      models: undefined,
      injectionModel: undefined,
      injectionEffort: undefined,
      effortCap: undefined,
    });
    expect(depthRowFor(settings, 2)?.effortCap).toBe("low");
  });

  test("the last depth row extends to every deeper level; depth 0 has no row", () => {
    const settings = nestedSubagentSettings(nested({ maxDepth: 4, depths: [{ effortCap: "high" }, { effortCap: "low" }] }))!;
    expect(depthRowFor(settings, 0)).toBeUndefined();
    expect(depthRowFor(settings, 1)?.effortCap).toBe("high");
    expect(depthRowFor(settings, 2)?.effortCap).toBe("low");
    expect(depthRowFor(settings, 4)?.effortCap).toBe("low");
  });
});

// ---------------------------------------------------------------------------

describe("depth derivation: agent addresses", () => {
  test("path-shaped addresses count segments", () => {
    expect(agentAddressDepth("/root")).toBe(0);
    expect(agentAddressDepth("/root/worker")).toBe(1);
    expect(agentAddressDepth("/root/worker/helper")).toBe(2);
  });

  test("bare names contribute NOTHING rather than a shallow 0", () => {
    // tests/responses-parser-agent-message.test.ts carries author:"probe_all", recipient:"root".
    // Counting those as depth 0 would under-report depth — the one unsafe direction.
    expect(agentAddressDepth("root")).toBeNull();
    expect(agentAddressDepth("probe_all")).toBeNull();
    expect(agentAddressDepth("/other/worker")).toBeNull();
    expect(agentAddressDepth(undefined)).toBeNull();
    expect(agentAddressDepth(42)).toBeNull();
  });

  test("capture reads the tail NEW_TASK item past trailing metadata", () => {
    const capture = captureAgentLineage(nested(), [
      { type: "message", role: "user", content: [{ type: "input_text", text: "env" }] },
      taskItem("/root", "/root/worker/helper"),
      { type: "additional_tools", tools: [] },
      { type: "compaction_trigger" },
    ])!;
    expect(capture.taskRecipient).toBe("/root/worker/helper");
    expect(capture.taskAuthor).toBe("/root");
    expect(capture.taskDepth).toBe(2);
  });

  test("evaluate resolves depth from the task address", () => {
    const capture = captureAgentLineage(nested(), [taskItem("/root", "/root/worker")]);
    const decision = evaluateNestedSubagents({
      config: nested(),
      headers: SPAWN_HEADERS(),
      parsed: makeParsed(),
      capture,
    })!;
    expect(decision.depth).toBe(1);
    expect(decision.certainty).toBe("known");
    expect(decision.sources.join(",")).toContain("address:task=1");
  });
});

describe("depth derivation: thread_spawn_edges", () => {
  test("own-id header semantics are LEARNED from the graph, then latched", () => {
    // "child-1" is a child_thread_id but never a parent_thread_id: a thread that has spawned
    // nothing cannot be a parent, yet this turn was spawned — so the header carries its own id.
    setSpawnEdgeReaderForTests(() => buildSpawnEdgeGraph([
      { parent: "root-1", child: "child-1" },
    ]));
    expect(latchedHeaderSemantics()).toBeNull();
    expect(spawnEdgeDepth("child-1")).toEqual({ depth: 1, semantics: "own", latched: true });
    expect(latchedHeaderSemantics()).toBe("own");
  });

  test("parent-id header semantics are learned from a spawn-marked turn whose id is not a child", () => {
    setSpawnEdgeReaderForTests(() => buildSpawnEdgeGraph([
      { parent: "root-1", child: "child-1" },
    ]));
    expect(spawnEdgeDepth("root-1")).toEqual({ depth: 1, semantics: "parent", latched: true });
  });

  test("an ambiguous id (child AND parent) before any proof resolves DEEP", () => {
    setSpawnEdgeReaderForTests(() => buildSpawnEdgeGraph([
      { parent: "root-1", child: "mid-1" },
      { parent: "mid-1", child: "leaf-1" },
    ]));
    const resolved = spawnEdgeDepth("mid-1")!;
    expect(resolved.latched).toBe(false);
    // walk(mid-1) is 1; the deep (parent-id) reading is 2.
    expect(resolved.depth).toBe(2);
  });

  test("a cyclic graph yields no answer rather than a wrong one", () => {
    setSpawnEdgeReaderForTests(() => buildSpawnEdgeGraph([
      { parent: "a", child: "b" },
      { parent: "b", child: "a" },
    ]));
    expect(spawnEdgeDepth("a")).toBeNull();
  });

  test("evaluate uses the spawn graph with no addresses present at all", () => {
    setSpawnEdgeReaderForTests(() => buildSpawnEdgeGraph([
      { parent: "root-1", child: "kid-1" },
      { parent: "kid-1", child: "grandkid-1" },
    ]));
    const decision = evaluateNestedSubagents({
      config: nested({ maxDepth: 3 }),
      headers: SPAWN_HEADERS({ "x-codex-parent-thread-id": "grandkid-1", "session_id": "s-edges" }),
      parsed: makeParsed(),
      capture: null,
    })!;
    expect(decision.depth).toBe(2);
    expect(decision.certainty).toBe("known");
  });
});

describe("depth derivation: corroborating sources and the maximum rule", () => {
  test("the deepest source wins (a stale edge row cannot make a deep child look shallow)", () => {
    setSpawnEdgeReaderForTests(() => buildSpawnEdgeGraph([{ parent: "root-1", child: "kid-1" }]));
    const capture = captureAgentLineage(nested({ maxDepth: 3 }), [taskItem("/root/worker", "/root/worker/helper")]);
    const decision = evaluateNestedSubagents({
      config: nested({ maxDepth: 3 }),
      headers: SPAWN_HEADERS({ "x-codex-parent-thread-id": "kid-1", "session_id": "s-max" }),
      parsed: makeParsed(),
      capture,
    })!;
    // spawn_edges says 1, the address says 2 -> 2.
    expect(decision.depth).toBe(2);
  });

  test("codex-rs's own leaf guard is a free upper bound", () => {
    // Spawn-marked but handed no collaboration tools: the client already refused this level.
    const decision = evaluateNestedSubagents({
      config: nested({ maxDepth: 3 }),
      headers: SPAWN_HEADERS({ "session_id": "s-leafguard" }),
      parsed: makeParsed({ tools: [{ name: "shell", description: "", parameters: {} }], rawTools: [] }),
      capture: null,
    })!;
    expect(decision.depth).toBe(3);
    expect(decision.clamp).toBe(true);
    expect(decision.sources.join(",")).toContain("client_leaf=3");
  });

  test("the invented sentinel is ignored unless explicitly trusted, and may only raise", () => {
    const input = [taskItem("/root", "/root/worker", "[[ocx:d=3]] TASK: go")];
    expect(captureAgentLineage(nested(), input)!.sentinelDepth).toBeUndefined();
    const trusted = captureAgentLineage(nested({ trustTaskSentinel: true }), input)!;
    expect(trusted.sentinelDepth).toBe(3);

    const raised = evaluateNestedSubagents({
      config: nested({ maxDepth: 3, trustTaskSentinel: true }),
      headers: SPAWN_HEADERS({ "session_id": "s-sentinel" }),
      parsed: makeParsed(),
      capture: trusted,
    })!;
    expect(raised.depth).toBe(3); // address said 1; the sentinel raised it, never lowered it
  });

  test("a sentinel claiming a SHALLOWER depth cannot demote the address reading", () => {
    const capture = captureAgentLineage(
      nested({ trustTaskSentinel: true }),
      [taskItem("/root/worker", "/root/worker/helper", "[[ocx:d=0]] TASK: go")],
    )!;
    const decision = evaluateNestedSubagents({
      config: nested({ maxDepth: 3, trustTaskSentinel: true }),
      headers: SPAWN_HEADERS({ "session_id": "s-sentinel-low" }),
      parsed: makeParsed(),
      capture,
    })!;
    expect(decision.depth).toBe(2);
  });

  test("a node's depth is never demoted by a later turn that resolves shallower", () => {
    const config = nested({ maxDepth: 3 });
    const headers = SPAWN_HEADERS({ "session_id": "s-nodemote" });
    const deep = captureAgentLineage(config, [taskItem("/root/worker", "/root/worker/helper")]);
    expect(evaluateNestedSubagents({ config, headers, parsed: makeParsed(), capture: deep })!.depth).toBe(2);

    // Same node, a later turn whose input no longer carries a path-shaped address.
    const bare = captureAgentLineage(config, [
      { type: "agent_message", author: "probe_all", recipient: "/root/worker/helper", content: [] },
    ]);
    const later = evaluateNestedSubagents({ config, headers, parsed: makeParsed(), capture: bare })!;
    expect(later.depth).toBe(2);
  });

  test("a non-spawn turn is depth 0 unless the registry already knows the node deeper", () => {
    const config = nested({ maxDepth: 3 });
    const root = evaluateNestedSubagents({
      config,
      headers: MAIN_HEADERS({ "session_id": "s-root" }),
      parsed: makeParsed(),
      capture: null,
    })!;
    expect(root.depth).toBe(0);
    expect(root.clamp).toBe(false);

    // A child's follow-up turn that lost its markers keeps its depth ONLY once the spawn graph
    // has proven x-codex-parent-thread-id carries the turn's own id — aliasing under the
    // unproven reading would pin a child's depth onto its parent's thread key.
    setSpawnEdgeReaderForTests(() => buildSpawnEdgeGraph([{ parent: "t-root", child: "t-followup" }]));
    const headers = SPAWN_HEADERS({ "session_id": "s-followup", "x-codex-parent-thread-id": "t-followup" });
    const capture = captureAgentLineage(config, [taskItem("/root", "/root/worker")]);
    expect(evaluateNestedSubagents({ config, headers, parsed: makeParsed(), capture })!.depth).toBe(1);
    expect(latchedHeaderSemantics()).toBe("own");
    const followUp = evaluateNestedSubagents({
      config,
      headers: MAIN_HEADERS({ "session_id": "s-followup", "x-codex-parent-thread-id": "t-followup" }),
      parsed: makeParsed(),
      capture: null,
    })!;
    expect(followUp.depth).toBe(1);
  });

  test("without that proof a lost-marker follow-up falls back to depth 0 rather than guessing", () => {
    // Stated plainly because it is a real gap, not an oversight: with no spawn graph the proxy
    // cannot tell whose thread id it is holding, and pinning a child's depth to the wrong key
    // would clamp the ROOT agent. Depth 0 here is the lesser wrong; the session spawn budget
    // still bounds the tree.
    const config = nested({ maxDepth: 3 });
    const headers = SPAWN_HEADERS({ "session_id": "s-noproof", "x-codex-parent-thread-id": "t-noproof" });
    const capture = captureAgentLineage(config, [taskItem("/root", "/root/worker")]);
    expect(evaluateNestedSubagents({ config, headers, parsed: makeParsed(), capture })!.depth).toBe(1);
    const followUp = evaluateNestedSubagents({
      config,
      headers: MAIN_HEADERS({ "session_id": "s-noproof", "x-codex-parent-thread-id": "t-noproof" }),
      parsed: makeParsed(),
      capture: null,
    })!;
    expect(followUp.depth).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("unknown depth fails safe", () => {
  test("nothing resolves -> deepest level, clamped, warned once, never refused", () => {
    const config = nested({ maxDepth: 2 });
    const headers = SPAWN_HEADERS({ "session_id": "s-unknown" });
    const first = evaluateNestedSubagents({ config, headers, parsed: makeParsed(), capture: null })!;
    expect(first.certainty).toBe("assumed");
    expect(first.depth).toBe(2);
    expect(first.clamp).toBe(true);
    expect(first.clampReason).toBe("unknown_depth");
    expect(first.refuse).toBeUndefined();
    expect(first.warnUnknown).toBe(true);

    // The warning is loud ONCE per session, not on every turn.
    const second = evaluateNestedSubagents({ config, headers, parsed: makeParsed(), capture: null })!;
    expect(second.warnUnknown).toBe(false);
    expect(second.clamp).toBe(true);
  });

  test("unknownDepthAssumption:1 is the explicit opt-in to nest optimistically", () => {
    const decision = evaluateNestedSubagents({
      config: nested({ maxDepth: 2, unknownDepthAssumption: 1 }),
      headers: SPAWN_HEADERS({ "session_id": "s-optimistic" }),
      parsed: makeParsed(),
      capture: null,
    })!;
    expect(decision.depth).toBe(1);
    expect(decision.clamp).toBe(false);
    expect(decision.certainty).toBe("assumed");
  });

  test("an unreadable (Fernet) task body still fails safe rather than resolving shallow", () => {
    // The native path encrypts the task text; only the sibling address fields survive. With the
    // addresses absent too, there is nothing left to read — and that must clamp, not permit.
    const capture = captureAgentLineage(nested(), [{
      type: "agent_message",
      content: [{ type: "encrypted_content", encrypted_content: "gAAAAAB".padEnd(140, "x") }],
    }]);
    const decision = evaluateNestedSubagents({
      config: nested({ maxDepth: 2 }),
      headers: SPAWN_HEADERS({ "session_id": "s-fernet" }),
      parsed: makeParsed(),
      capture,
    })!;
    expect(decision.certainty).toBe("assumed");
    expect(decision.clamp).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("ceilings are enforced on the request body", () => {
  test("the leaf clamp strips collab tools from ALL FOUR injection points", () => {
    const parsed = makeParsed({
      rawTools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "shell" },
        { type: "namespace", name: "agents", tools: [{ name: "spawn_agent" }, { name: "send_input" }] },
        { type: "namespace", name: "mcp", tools: [{ name: "search" }] },
      ],
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "send_message" }, { type: "function", name: "apply_patch" }] },
        {
          type: "tool_search_output",
          call_id: "c1",
          status: "completed",
          // tool_search re-exposes loaded tools MID-TURN; miss this and a clamped leaf simply
          // re-acquires spawn_agent and the ceiling evaporates.
          tools: [{ type: "function", name: "spawn_agent" }, { type: "function", name: "grep" }],
        },
      ],
    });

    const removed = stripCollabToolsInPlace(parsed);
    // body.tools(1) + namespace inner(2) + additional_tools(1) + tool_search_output(1) + context.tools(2)
    expect(removed).toBe(7);

    const raw = parsed._rawBody as { tools: Array<Record<string, unknown>>; input: Array<Record<string, unknown>> };
    expect(raw.tools.map(tool => tool.name)).toEqual(["shell", "mcp"]);
    // The emptied "agents" namespace is dropped entirely rather than left as a hollow shell.
    expect(raw.tools.find(tool => tool.name === "agents")).toBeUndefined();
    expect((raw.input[0].tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(["apply_patch"]);
    expect((raw.input[1].tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(["grep"]);
    expect(parsed.context.tools!.map(tool => tool.name)).toEqual(["shell"]);
  });

  test("a stripped leaf loses its collab surface but KEEPS its effort caps", () => {
    // effortCapAppliesTo admits a child by its spawn markers regardless of tool surface, so the
    // clamp needs no change there — locked here because losing it would let a clamped leaf run
    // uncapped at the top rung.
    const parsed = makeParsed({ reasoning: "ultra" });
    stripCollabToolsInPlace(parsed);
    expect(collabSurface(parsed)).toBeNull();
    const config = { port: 1, providers: {}, defaultProvider: "openai", subagentEffortCap: "high" } as OcxConfig;
    expect(effortCapAppliesTo(collabSurface(parsed), SPAWN_HEADERS(), config)).toBe(true);
    const capped = applyEffortCap(parsed, SPAWN_HEADERS(), config, ["low", "medium", "high", "max"]);
    expect(capped).toEqual({ from: "ultra", to: "high", subagent: true });
  });

  test("reaching maxDepth clamps rather than refusing", () => {
    const config = nested({ maxDepth: 2 });
    const capture = captureAgentLineage(config, [taskItem("/root/worker", "/root/worker/helper")]);
    const decision = evaluateNestedSubagents({
      config,
      headers: SPAWN_HEADERS({ "session_id": "s-maxdepth" }),
      parsed: makeParsed(),
      capture,
    })!;
    expect(decision.depth).toBe(2);
    expect(decision.clamp).toBe(true);
    expect(decision.clampReason).toBe("max_depth");
    expect(decision.refuse).toBeUndefined();
    expect(decision.childRow).toBeUndefined();
  });

  test("a depth KNOWN to exceed maxDepth is refused outright", () => {
    const config = nested({ maxDepth: 1 });
    const capture = captureAgentLineage(config, [taskItem("/root/worker", "/root/worker/helper")]);
    const decision = evaluateNestedSubagents({
      config,
      headers: SPAWN_HEADERS({ "session_id": "s-refuse" }),
      parsed: makeParsed(),
      capture,
    })!;
    expect(decision.refuse?.code).toBe(SUBAGENT_DEPTH_LIMIT_CODE);
    expect(decision.refuse?.message).toContain("maximum of 1");
  });

  test("per-node fan-out is enforced against the node's own later turns", () => {
    const config = nested({ maxDepth: 3, maxChildrenPerNode: 2 });
    const session = { "session_id": "s-fanout" };
    for (const child of ["/root/a", "/root/b"]) {
      evaluateNestedSubagents({
        config,
        headers: SPAWN_HEADERS(session),
        parsed: makeParsed(),
        capture: captureAgentLineage(config, [taskItem("/root", child)]),
      });
    }
    // "/root" has now been observed spawning 2 children; its own next turn loses delegation.
    const parent = evaluateNestedSubagents({
      config,
      headers: MAIN_HEADERS(session),
      parsed: makeParsed(),
      capture: captureAgentLineage(config, [taskItem("/root/a", "/root")]),
    })!;
    expect(parent.depth).toBe(0);
    expect(parent.clamp).toBe(true);
    expect(parent.clampReason).toBe("fanout_exhausted");
    expect(parent.remainingChildren).toBe(0);
  });

  test("the session spawn budget holds with ZERO depth resolution and finally refuses", () => {
    // The load-bearing bound: it needs only codex-rs's spawn markers, so it survives a Docker
    // deployment with no CODEX_HOME, encrypted tasks, and bare addresses all at once.
    const config = nested({ maxDepth: 3, maxChildrenPerNode: 32, maxTotalSpawnsPerSession: 2 });
    const session = { "session_id": "s-budget" };
    const spawnChild = (address: string) => evaluateNestedSubagents({
      config,
      headers: SPAWN_HEADERS(session),
      parsed: makeParsed(),
      capture: captureAgentLineage(config, [taskItem("/root", address)]),
    })!;
    expect(spawnChild("/root/a").refuse).toBeUndefined();
    expect(spawnChild("/root/b").refuse).toBeUndefined();
    expect(spawnChild("/root/b").clamp).toBe(true); // budget spent -> no further growth
    const third = spawnChild("/root/c");
    expect(third.refuse?.code).toBe(SUBAGENT_DEPTH_LIMIT_CODE);
    expect(third.refuse?.message).toContain("budget of 2");
  });

  test("the turn-count guard is a strict over-count that only bites in a loop", () => {
    // One agent taking many turns must NOT trip the agent budget (it is still one agent), but a
    // session grinding out more turns than budget*turnsPerAgent is a loop and does trip this.
    const config = nested({ maxDepth: 3, maxChildrenPerNode: 32, maxTotalSpawnsPerSession: 4, maxTurnsPerSpawnedAgent: 1 });
    const headers = SPAWN_HEADERS({ "session_id": "s-turns" });
    const capture = captureAgentLineage(config, [taskItem("/root", "/root/a")]);
    for (let turn = 1; turn <= 4; turn += 1) {
      expect(evaluateNestedSubagents({ config, headers, parsed: makeParsed(), capture })!.clampReason).toBeUndefined();
    }
    const fifth = evaluateNestedSubagents({ config, headers, parsed: makeParsed(), capture })!;
    expect(fifth.clamp).toBe(true);
    expect(fifth.clampReason).toBe("turn_budget");
  });

  test("the registry is bounded — a delegation storm cannot grow proxy memory without limit", () => {
    const config = nested();
    for (let i = 0; i < 400; i += 1) {
      evaluateNestedSubagents({
        config,
        headers: SPAWN_HEADERS({ "session_id": `storm-${i}` }),
        parsed: makeParsed(),
        capture: null,
      });
    }
    expect(__nestedSubagentSessionCountForTests()).toBeLessThanOrEqual(200);
  });

  test("the leaf note explains WHY the tools vanished", () => {
    const decision = evaluateNestedSubagents({
      config: nested({ maxDepth: 1 }),
      headers: SPAWN_HEADERS({ "session_id": "s-note" }),
      parsed: makeParsed(),
      capture: captureAgentLineage(nested({ maxDepth: 1 }), [taskItem("/root", "/root/worker")]),
    })!;
    const note = leafDeveloperNote(decision);
    expect(note).toContain("delegation depth 1 of a maximum of 1");
    expect(note).toContain("leaf agent");
    expect(note.startsWith("<multi_agent_mode>")).toBe(true);
  });

  test("COLLAB_TOOL_NAMES covers both collaboration surfaces", () => {
    for (const name of ["spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents", "send_input", "resume_agent", "close_agent"]) {
      expect(COLLAB_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(COLLAB_TOOL_NAMES.has("shell")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("per-depth effort caps only tighten", () => {
  const base = { port: 1, providers: {}, defaultProvider: "openai" } as OcxConfig;

  test("a depth cap joins the lowest-wins reduce", () => {
    expect(effortCapFor(base, true, "medium")).toBe("medium");
    expect(effortCapFor({ ...base, subagentEffortCap: "low" }, true, "high")).toBe("low");
    expect(effortCapFor({ ...base, effortCap: "low" }, false, "max")).toBe("low");
  });

  test("a depth cap cannot RAISE an existing cap", () => {
    expect(effortCapFor({ ...base, subagentEffortCap: "low" }, true, "max")).toBe("low");
  });

  test("an unrankable depth cap is ignored entirely", () => {
    expect(effortCapFor(base, true, "turbo")).toBeUndefined();
    expect(effortCapFor({ ...base, effortCap: "high" }, true, "turbo")).toBe("high");
  });
});

// ---------------------------------------------------------------------------

describe("pre-sanitize ordering", () => {
  test("capture MUST run before sanitizeEncryptedContentInPlace, which deletes the addresses", () => {
    const input = [taskItem("/root", "/root/worker")];
    const before = captureAgentLineage(nested(), input)!;
    expect(before.taskDepth).toBe(1);

    // Same body, now sanitized: agent_message -> message and author/recipient are gone.
    expect(sanitizeEncryptedContentInPlace(input)).toBe(1);
    expect(input[0]).not.toHaveProperty("author");
    expect(input[0]).not.toHaveProperty("recipient");

    const after = captureAgentLineage(nested(), input)!;
    expect(after.taskDepth).toBeUndefined();
    expect(after.taskRecipient).toBeUndefined();
    // ...which would silently degrade every spawn to "unknown" (i.e. permanently clamped).
    const decision = evaluateNestedSubagents({
      config: nested(),
      headers: SPAWN_HEADERS({ "session_id": "s-order" }),
      parsed: makeParsed(),
      capture: after,
    })!;
    expect(decision.certainty).toBe("assumed");
  });

  test("core.ts calls captureAgentLineage before sanitizeEncryptedContentInPlace", async () => {
    const source = await Bun.file(new URL("../src/server/responses/core.ts", import.meta.url)).text();
    const capture = source.indexOf("captureAgentLineage(config");
    const sanitize = source.indexOf("sanitizeEncryptedContentInPlace(");
    expect(capture).toBeGreaterThan(-1);
    expect(sanitize).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(sanitize);
  });
});

// ---------------------------------------------------------------------------

describe("an untouched config behaves exactly as before", () => {
  test("every entry point is inert with no nestedSubagents block", () => {
    expect(captureAgentLineage({}, [taskItem("/root", "/root/worker")])).toBeNull();
    expect(evaluateNestedSubagents({
      config: {},
      headers: SPAWN_HEADERS(),
      parsed: makeParsed(),
      capture: null,
    })).toBeNull();
    expect(__nestedSubagentSessionCountForTests()).toBe(0);
  });

  test("the capture gate returns before touching the body at all", () => {
    // A Proxy that throws on ANY property read: if the gate were not the first statement, the
    // scan below it would trip this.
    const tripwire = new Proxy([], {
      get() { throw new Error("nested-subagents capture touched the body while disabled"); },
    });
    expect(() => captureAgentLineage({}, tripwire)).not.toThrow();
    expect(() => captureAgentLineage({ nestedSubagents: { enabled: false } }, tripwire)).not.toThrow();
  });

  test("ordinary main-turn traffic allocates nothing even while the feature is ON", () => {
    // Enabled must not mean "every unrelated request now churns a registry entry".
    for (let i = 0; i < 50; i += 1) {
      const decision = evaluateNestedSubagents({
        config: nested(),
        headers: MAIN_HEADERS({ "session_id": `plain-${i}` }),
        parsed: makeParsed(),
        capture: null,
      })!;
      expect(decision.depth).toBe(0);
      expect(decision.clamp).toBe(false);
    }
    expect(__nestedSubagentSessionCountForTests()).toBe(0);
  });

  test("compaction turns are maintenance and bypass the feature entirely", () => {
    const parsed = makeParsed();
    parsed._compactionRequest = true;
    expect(evaluateNestedSubagents({
      config: nested({ maxDepth: 1 }),
      headers: SPAWN_HEADERS({ "session_id": "s-compact" }),
      parsed,
      capture: null,
    })).toBeNull();
  });

  test("effortCapFor with no depth argument resolves identically to before", () => {
    const config = { port: 1, providers: {}, defaultProvider: "openai", effortCap: "high", subagentEffortCap: "medium" } as OcxConfig;
    expect(effortCapFor(config, true)).toBe("medium");
    expect(effortCapFor(config, false)).toBe("high");
    expect(effortCapFor(config, true, undefined)).toBe("medium");
  });

  test("guidance text is byte-identical without the depth option", async () => {
    const deps = {
      resolveEffectiveSubagentRoster: () => ({
        advertised: [{ model: "gpt-5.6-terra", efforts: ["high", "max"] }],
        candidates: [{ model: "gpt-5.6-terra", efforts: ["high", "max"] }],
        excluded: [],
      }),
    } as never;
    const options = { injectionModel: "gpt-5.6-terra", subagentModels: ["gpt-5.6-terra"] };
    const withoutDepth = await multiAgentGuidanceText(makeParsed(), options, deps);
    const withUndefinedDepth = await multiAgentGuidanceText(makeParsed(), { ...options, depth: undefined }, deps);
    expect(withoutDepth).toBe(withUndefinedDepth);
    expect(withoutDepth).not.toContain("sub-agent depth");

    const withDepth = await multiAgentGuidanceText(
      makeParsed(),
      { ...options, depth: { depth: 1, maxDepth: 2, remainingChildren: 3, remainingSessionSpawns: 9 } },
      deps,
    );
    expect(withDepth).toContain("You are at sub-agent depth 1 of a maximum of 2");
    expect(withDepth).toContain("3 more sub-agent(s)");
    // The depth sentence precedes the roster, so the char-budget trim can only eat the roster.
    expect(withDepth!.indexOf("sub-agent depth")).toBeLessThan(withDepth!.indexOf("Available models"));
  });

  test("depth placeholders expand to empty strings when nesting is off", () => {
    expect(applyInjectionPlaceholders("d={{depth}}/{{maxdepth}} r={{remaining}}")).toBe("d=/ r=");
    expect(applyInjectionPlaceholders(
      "d={{depth}}/{{maxdepth}} r={{remaining}}",
      undefined,
      undefined,
      undefined,
      undefined,
      { depth: 2, maxDepth: 3, remainingChildren: 1, remainingSessionSpawns: 4 },
    )).toBe("d=2/3 r=1");
  });

  test("the existing placeholders are unchanged", () => {
    expect(applyInjectionPlaceholders("{{model}}|{{effort}}|{{roster}}|{{fallback}}", "m", "e", "r", "f")).toBe("m|e|r|f");
  });
});

// ---------------------------------------------------------------------------

describe("config loading", () => {
  const savedHome = process.env.OPENCODEX_HOME;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocx-nested-"));
    process.env.OPENCODEX_HOME = dir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = savedHome;
    if (dir && existsSync(dir)) removeTempDir(dir);
    dir = "";
  });

  function writeConfig(value: unknown): void {
    writeFileSync(getConfigPath(), JSON.stringify(value), "utf-8");
  }

  const BASE = {
    port: 12345,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://example.test", authMode: "forward" } },
    defaultProvider: "openai",
  };

  test("a valid block round-trips through the schema", () => {
    writeConfig({ ...BASE, nestedSubagents: { enabled: true, maxDepth: 3, depths: [{ effortCap: "high" }] } });
    const config = loadConfig();
    expect(config.port).toBe(12345);
    expect(nestedSubagentSettings(config)!.maxDepth).toBe(3);
  });

  test("a hand-edited garbage block disables ONLY the feature — providers and port survive", () => {
    // The repair path that fires on a failed parse resets providers and pool accounts to
    // defaults. A typo in an optional delegation knob must never be worth that.
    writeConfig({ ...BASE, nestedSubagents: "yes please" });
    const config = loadConfig();
    expect(config.port).toBe(12345);
    expect(config.providers.openai).toBeDefined();
    expect(nestedSubagentSettings(config)).toBeNull();
  });

  test("out-of-range numbers survive the parse and are clamped at read", () => {
    writeConfig({ ...BASE, nestedSubagents: { enabled: true, maxDepth: 99, maxTotalSpawnsPerSession: 10_000 } });
    const settings = nestedSubagentSettings(loadConfig())!;
    expect(settings.maxDepth).toBe(NESTED_MAX_DEPTH_LIMIT);
    expect(settings.maxTotalSpawnsPerSession).toBe(512);
  });

  test("a fresh config has no nestedSubagents block at all", () => {
    expect(getDefaultConfig().nestedSubagents).toBeUndefined();
    expect(nestedSubagentSettings(getDefaultConfig())).toBeNull();
  });
});
