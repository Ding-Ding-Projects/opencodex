import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";

function listenForeign(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing foreign port"));
      resolve({ server, port: address.port });
    });
    server.listen({ host: "127.0.0.1", port: 0 });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function waitForRuntime(path: string): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const runtime = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; port?: unknown };
      if (typeof runtime.pid === "number" && typeof runtime.port === "number") {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz`, {
          signal: AbortSignal.timeout(500),
        });
        const body = await response.json() as { service?: unknown; pid?: unknown };
        if (response.ok && body.service === "opencodex" && body.pid === runtime.pid) {
          return { pid: runtime.pid, port: runtime.port };
        }
      }
    } catch { /* startup not published/healthy yet */ }
    await Bun.sleep(25);
  }
  throw new Error("isolated proxy did not publish identity-healthy runtime state");
}

async function stopChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(8_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

test("two soft starts behind a foreign preferred port create only one fallback daemon", async () => {
  const isolatedRoot = mkdtempSync(join(tmpdir(), "ocx-start-race-"));
  const ocxHome = join(isolatedRoot, "ocx");
  const codexHome = join(isolatedRoot, "codex");
  const { server: foreign, port: preferredPort } = await listenForeign();
  const cli = join(import.meta.dir, "..", "src", "cli", "index.ts");
  const runtimePath = join(ocxHome, "runtime-port.json");
  const configPath = join(ocxHome, "config.json");
  let first: ReturnType<typeof Bun.spawn> | null = null;
  let second: ReturnType<typeof Bun.spawn> | null = null;

  try {
    mkdirSync(ocxHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      port: preferredPort,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:9/v1",
          allowPrivateNetwork: true,
          apiKey: "test-key",
          defaultModel: "test-model",
        },
      },
    }), { encoding: "utf8", flag: "wx" });

    const env = { ...process.env, OPENCODEX_HOME: ocxHome, CODEX_HOME: codexHome, OCX_BACKGROUND: "1" };
    delete env.OCX_SERVICE;
    first = Bun.spawn([process.execPath, cli, "start"], { env, stdout: "pipe", stderr: "pipe" });
    second = Bun.spawn([process.execPath, cli, "start"], { env, stdout: "pipe", stderr: "pipe" });

    let runtime: { pid: number; port: number };
    try {
      runtime = await waitForRuntime(runtimePath);
    } catch (error) {
      const exited = [first, second].filter(child => child.exitCode !== null);
      const details = await Promise.all(exited.map(async child => [
        await new Response(child.stdout).text(),
        await new Response(child.stderr).text(),
      ].filter(Boolean).join(" | ")));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} `
        + `(first=${first.exitCode ?? "running"}, second=${second.exitCode ?? "running"}) ${details.join(" || ")}`,
      );
    }
    expect(runtime.port).not.toBe(preferredPort);
    expect(JSON.parse(readFileSync(configPath, "utf8")).port).toBe(preferredPort);
    expect(foreign.listening).toBe(true);

    const loserCode = await Promise.race([
      first.exited,
      second.exited,
      Bun.sleep(12_000).then(() => null),
    ]);
    expect(loserCode).toBe(1);
    const liveChildren = [first, second].filter(child => child.exitCode === null);
    expect(liveChildren).toHaveLength(1);
    expect(runtime.pid).toBe(liveChildren[0].pid);
  } finally {
    if (first) await stopChild(first);
    if (second) await stopChild(second);
    await closeServer(foreign);
    if (existsSync(isolatedRoot)) rmSync(isolatedRoot, { recursive: true, force: true });
  }
}, 30_000);
