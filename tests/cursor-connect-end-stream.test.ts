import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { encodeConnectFrame } from "../src/adapters/cursor/framing";
import { createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";

const PROVIDER = "opencodex-responses";

async function withH2Server<T>(
  handler: (stream: http2.ServerHttp2Stream) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP/2 fixture did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function startedFrame(callId: string, toolName: string): Uint8Array {
  const toolCall = create(ToolCallSchema, {
    tool: {
      case: "mcpToolCall",
      value: create(McpToolCallSchema, {
        args: create(McpArgsSchema, { name: toolName, toolName, toolCallId: callId, providerIdentifier: PROVIDER }),
      }),
    },
  });
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "toolCallStarted", value: create(ToolCallStartedUpdateSchema, { callId, modelCallId: callId, toolCall }) },
      }),
    },
  })));
}

function clientToolArgsFrame(callId: string, toolName: string, argText: string): Uint8Array {
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 1,
        execId: `exec-${callId}`,
        message: {
          case: "mcpArgs",
          value: create(McpArgsSchema, {
            name: toolName,
            toolName,
            toolCallId: callId,
            providerIdentifier: PROVIDER,
            args: { text: new TextEncoder().encode(JSON.stringify(argText)) },
          }),
        },
      }),
    },
  })));
}

function turnEndedFrame(): Uint8Array {
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
      }),
    },
  })));
}

function cleanEndStreamFrame(): Uint8Array {
  return encodeConnectFrame(new TextEncoder().encode("{}"), { endStream: true });
}

const APPLY_PATCH_TOOL = [{
  name: "apply_patch",
  description: "apply a patch",
  parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  freeform: true,
}] as unknown as CursorRunRequest["tools"];

const ECHO_TOOL = [{
  name: "echo_a",
  description: "echo text",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}] as unknown as CursorRunRequest["tools"];

function requestFor(tools?: CursorRunRequest["tools"]): CursorRunRequest {
  return {
    modelId: "composer-2",
    conversationId: "cursor_connect_end_stream_test",
    system: [],
    messages: [{ role: "user", content: "hello" }],
    ...(tools ? { tools } : {}),
  } as CursorRunRequest;
}

async function drain(baseUrl: string, request: CursorRunRequest): Promise<{ messages: CursorServerMessage[]; failure?: Error }> {
  const transport = createLiveCursorTransport({
    provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
    firstFrameTimeoutMs: 2_000,
  });
  const messages: CursorServerMessage[] = [];
  let failure: Error | undefined;
  try {
    for await (const message of transport.run(request)) messages.push(message);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    await transport.close?.();
  }
  return { messages, failure };
}

function respondWith(frames: Uint8Array[]): (stream: http2.ServerHttp2Stream) => void {
  return stream => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    for (const frame of frames) stream.write(Buffer.from(frame));
    stream.end();
  };
}

describe("Cursor Connect END_STREAM terminal ownership", () => {
  test("settles after turnEnded without waiting for a held-open HTTP body", async () => {
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let fallbackFired = false;
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(turnEndedFrame()));
      stream.write(Buffer.from(cleanEndStreamFrame()));
      fallback = setTimeout(() => {
        fallbackFired = true;
        try { stream.end(); } catch { /* fixture already closed */ }
      }, 1_000);
    }, async baseUrl => {
      const result = await drain(baseUrl, requestFor());
      expect(result.failure).toBeUndefined();
      expect(result.messages.filter(message => message.type === "done")).toHaveLength(1);
    });
    if (fallback) clearTimeout(fallback);
    expect(fallbackFired).toBe(false);
  });

  test("does not replay or fail a terminal accepted before abort-shaped teardown", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(turnEndedFrame()));
      stream.write(Buffer.from(cleanEndStreamFrame()));
      setImmediate(() => {
        const abort = new Error("The operation was aborted");
        abort.name = "AbortError";
        stream.destroy(abort);
      });
    }, async baseUrl => {
      const result = await drain(baseUrl, requestFor());
      expect(result.failure).toBeUndefined();
      expect(result.messages.filter(message => message.type === "done")).toHaveLength(1);
      expect(result.messages.some(message => message.type === "error")).toBe(false);
    });
  });

  test("finalizes a drained client-tool turn before its grace timer", async () => {
    await withH2Server(respondWith([
      startedFrame("call_client_1", "echo_a"),
      clientToolArgsFrame("call_client_1", "echo_a", "A"),
      cleanEndStreamFrame(),
    ]), async baseUrl => {
      const result = await drain(baseUrl, requestFor(ECHO_TOOL));
      expect(result.failure).toBeUndefined();
      expect(result.messages.filter(message => message.type === "tool_call_end")).toHaveLength(1);
      expect(result.messages.filter(message => message.type === "done")).toHaveLength(1);
      expect(result.messages.some(message => message.type === "error")).toBe(false);
    });
  });

  test("fail-closes an open tool call at the clean protocol terminal", async () => {
    await withH2Server(respondWith([
      startedFrame("call_open_1", "apply_patch"),
      cleanEndStreamFrame(),
    ]), async baseUrl => {
      const result = await drain(baseUrl, requestFor(APPLY_PATCH_TOOL));
      expect(result.failure).toBeUndefined();
      expect(result.messages.filter(message => message.type === "tool_call_end")).toHaveLength(0);
      expect(result.messages.filter(message => message.type === "done")).toHaveLength(0);
      expect(result.messages.at(-1)?.type).toBe("error");
      expect((result.messages.at(-1) as { message?: string }).message).toContain("call_open_1");
    });
  });

  test("turnEnded and END_STREAM together admit one terminal", async () => {
    await withH2Server(respondWith([turnEndedFrame(), cleanEndStreamFrame()]), async baseUrl => {
      const result = await drain(baseUrl, requestFor());
      expect(result.failure).toBeUndefined();
      expect(result.messages.filter(message => message.type === "done")).toHaveLength(1);
      expect(result.messages.filter(message => message.type === "error")).toHaveLength(0);
    });
  });
});
