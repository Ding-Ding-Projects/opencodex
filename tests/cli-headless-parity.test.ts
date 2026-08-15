import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccessCommand } from "../src/cli/access";
import { handleAgentCommand } from "../src/cli/agent";
import { handleComboCommand } from "../src/cli/combo";
import { handleConfigCommand } from "../src/cli/config-command";
import { handleGrokCommand } from "../src/cli/integrations";
import { handleModelsRuntimeCommand } from "../src/cli/models-runtime";
import { handleProviderRuntimeCommand } from "../src/cli/provider-runtime";
import { collectApiCallSites } from "./helpers/api-call-sites";
import { removeTempDir } from "./helpers/temp-dir";

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

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.[jt]sx?$/.test(name) ? [path] : [];
  });
}

describe("headless GUI parity CLI", () => {
  // The endpoints are the ones the GUI actually requests. `collectApiCallSites`
  // parses each file and takes only paths sitting inside a request target, so
  // the documentation browser's bundled article corpus — which quotes other
  // vendors' base URLs and names routes in Markdown tables — no longer arrives
  // here disguised as GUI behaviour. See that helper for why prose was ever
  // able to fail this test.
  test("every GUI management endpoint belongs to a documented CLI resource", () => {
    const guiRoot = join(import.meta.dir, "..", "gui", "src");
    const endpoints = new Set<string>();
    for (const path of sourceFiles(guiRoot)) {
      for (const endpoint of collectApiCallSites(readFileSync(path, "utf8"), path)) endpoints.add(endpoint);
    }
    const coverage: Array<[string, string]> = [
      ["/api/claude-code", "ocx claude config"],
      ["/api/claude-desktop", "ocx claude desktop"],
      ["/api/claude/", "ocx observe"],
      ["/api/codex-auth", "ocx account"],
      ["/api/oauth", "ocx account"],
      ["/api/copilot-desktop", "ocx access"],
      ["/api/providers/keys", "ocx account"],
      ["/api/providers", "ocx provider"],
      ["/api/provider-", "ocx provider/models"],
      ["/api/selected-models", "ocx models"],
      ["/api/custom-models", "ocx models"],
      ["/api/model", "ocx models"],
      // `ocx narrator voices --source edge --edge` and `ocx narrator speak`
      // reach these two routes, so the catalogue and the synthesiser are both
      // driveable from a shell rather than only from the voice picker.
      ["/api/narrator", "ocx narrator"],
      // `ocx schedule test-api`/`test-ha`/`ha-token status|clear` reach these
      // three routes headlessly; `status`/`list`/`show`/`active` cover the
      // rest of the family by honestly reporting that rules themselves are
      // browser-only state (see src/cli/schedule.ts).
      ["/api/schedule", "ocx schedule"],
      ["/api/school-mode", "ocx school-mode"],
      ["/api/changelog", "ocx changelog"],
      ["/api/combos", "ocx combo"],
      ["/api/debug", "ocx debug/observe"],
      ["/api/diagnostics", "ocx system"],
      ["/api/effort", "ocx agent"],
      // `ocx export data <list>` — the same registry, serialisers and redaction
      // the route uses, so neither surface can offer a list the other cannot.
      ["/api/export", "ocx export data"],
      ["/api/grok", "ocx grok"],
      ["/api/host", "ocx host/export"],
      ["/api/injection", "ocx agent"],
      ["/api/keys", "ocx access"],
      ["/api/launch", "ocx launch"],
      ["/api/logs", "ocx observe"],
      ["/api/config", "ocx config"],
      ["/api/settings", "ocx system"],
      ["/api/shadow", "ocx models"],
      ["/api/sidecar", "ocx agent"],
      ["/api/startup", "ocx system"],
      ["/api/stop", "ocx stop"],
      ["/api/storage", "ocx observe"],
      ["/api/subagent", "ocx agent"],
      ["/api/sync", "ocx system sync"],
      ["/api/system", "ocx observe/system"],
      ["/api/terminal", "ocx terminal"],
      ["/api/update", "ocx system update"],
      ["/api/usage", "ocx observe usage"],
      ["/api/v2", "ocx v2/agent"],
      ["/api/windows-tray", "ocx tray"],
      ["/api/changelog", "ocx changelog"],
      ["/api/export", "ocx export data"],
      ["/api/host", "ocx host/export/restart"],
      ["/api/launch", "ocx launch"],
      ["/api/terminal", "ocx terminal"],
    ];
    const uncovered = [...endpoints].filter(endpoint => !coverage.some(([prefix]) => endpoint === prefix || endpoint.startsWith(prefix)));
    expect(uncovered).toEqual([]);
  });

  // The guard above is only worth its green tick if the scan can tell the two
  // apart, so prove both directions rather than assuming them: prose that names
  // a route is not a call site, and a call site is still found through an
  // interpolated base, a bare path, and an interpolated final segment.
  test("the endpoint scan reads call sites, not documentation prose", () => {
    // No scheme anywhere in this body, so only the "a URL has no whitespace"
    // rule can be rejecting it — the case the corpus's Markdown tables hit.
    const corpus = [
      'export const DOCS_ARTICLES = [{"id":"guides/models","body":"The reference table lists',
      "`GET /api/key-providers` and `PUT /api/disabled-models` under Models.\"}];",
    ].join(" ");
    expect([...collectApiCallSites(corpus, "generated-articles.ts")]).toEqual([]);

    // Whitespace-free, so only the "somebody else's origin" rule can reject it.
    const vendor = 'export const KILO_BASE = "https://api.kilo.ai/api/gateway";';
    expect([...collectApiCallSites(vendor)]).toEqual([]);

    const comment = "// School Mode's store polls `/api/school-mode` on its own\nexport const x = 1;";
    expect([...collectApiCallSites(comment)]).toEqual([]);

    const calls = [
      "const a = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`);",
      'const b = await fetch("/api/keys", { method: "POST" });',
      "const c = await fetch(`${apiBase}/api/launch/install/${id}`);",
    ].join("\n");
    expect([...collectApiCallSites(calls)].sort()).toEqual([
      "/api/keys", "/api/launch/install", "/api/providers",
    ]);
  });

  test("provider edit reuses the management provider patch", async () => {
    const runtime = fakeRuntime();
    const code = await handleProviderRuntimeCommand("edit", [
      "ark", "--base-url", "https://example.test/v1", "--api-key-transport", "bearer", "--enabled", "off", "--live-models", "on", "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/providers?name=ark",
      method: "PATCH",
      body: { baseUrl: "https://example.test/v1", apiKeyTransport: "bearer", disabled: true, liveModels: true },
    }]);
  });

  test("model context all maps to the atomic GUI endpoint", async () => {
    const runtime = fakeRuntime();
    const code = await handleModelsRuntimeCommand("context", ["all", "on", "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/provider-context-caps", method: "PUT", body: { setAll: true } });
  });

  test("combo set parses ordered weighted targets", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand([
      "set", "fast", "--targets", "ark/model-a:2,openai/gpt-5.5", "--strategy", "failover", "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.body).toEqual({
      id: "fast",
      combo: {
        strategy: "failover",
        stickyLimit: 1,
        targets: [
          { provider: "ark", model: "model-a", weight: 2 },
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    });
  });

  test("agent effort and roster use the same live mutation routes as GUI", async () => {
    const runtime = fakeRuntime();
    expect(await handleAgentCommand(["effort", "set", "--main", "high", "--subagent", "medium", "--json"], runtime.deps)).toBe(0);
    expect(await handleAgentCommand(["subagents", "set", "a/model,b/model", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests.map(row => [row.path, row.body])).toEqual([
      ["/api/effort-caps", { effortCap: "high", subagentEffortCap: "medium" }],
      ["/api/subagent-models", { models: ["a/model", "b/model"] }],
    ]);
  });

  test("API key create returns the one-time key through the access command", async () => {
    const runtime = fakeRuntime((req) => new URL(req.url).pathname === "/api/keys"
      ? { id: "key-1", name: "deploy", key: "ocx_secret" }
      : undefined);
    expect(await handleAccessCommand(["key", "create", "deploy", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/keys", method: "POST", body: { name: "deploy" } });
  });

  test("Grok include edits the persisted exclusion set before apply", async () => {
    const runtime = fakeRuntime((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/grok" && req.method === "GET") return { excluded: ["a", "b"] };
      return undefined;
    });
    expect(await handleGrokCommand(["include", "a", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests[1]).toEqual({ path: "/api/grok/selection", method: "PUT", body: { excluded: ["b"] } });
  });

  test("config set validates the complete candidate before the atomic write", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cli-config-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({
        port: 10100,
        providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
        defaultProvider: "openai",
      }));
      expect(await handleConfigCommand(["set", "codexAutoStart", "false", "--json"])).toBe(0);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).codexAutoStart).toBe(false);
      expect(await handleConfigCommand(["set", "port", "-1", "--json"])).not.toBe(0);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).port).toBe(10100);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTempDir(home);
    }
  });
});
