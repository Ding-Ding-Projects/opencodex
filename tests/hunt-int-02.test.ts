/**
 * hunt-int-02: `sendResponseToWebSocket` parses an upstream "successful JSON"
 * body without a try/catch, unlike every sibling JSON.parse in the same file.
 *
 * `src/server/ws-bridge.ts` has three call sites that parse an upstream body as
 * JSON:
 *   - `payloadType()` (an SSE frame's payload): wrapped in try/catch, returns
 *     `null` on failure, and the caller turns that into a clean `protocol_error`
 *     frame plus `reportTerminal("incomplete")`.
 *   - `errorPayloadFromText()` (a non-2xx body): wrapped in try/catch, falls
 *     back to a synthesized `upstream_error` object on failure.
 *   - `sendResponseToWebSocket()` itself, for a 2xx response whose content-type
 *     is `application/json` (line ~360) or whose sniffed body starts with `{`
 *     (line ~383): `JSON.parse(text)` / `JSON.parse(trimmed)` with NO try/catch
 *     at all.
 *
 * A malformed body with either shape is entirely realistic (a truncated
 * response from a flaky upstream, a proxy that mislabels an error page as
 * `application/json`, a server bug) and is exactly the condition the other two
 * call sites in this same file were hardened against. Here it instead throws a
 * raw `SyntaxError` out of `sendResponseToWebSocket`, which the only caller
 * (`src/server/index.ts`'s `response.create` handler, ~line 1053) does catch,
 * but its catch block has no knowledge of the WS turn's terminal-outcome
 * bookkeeping: it sends a generic `proxy_error` 502 and finalizes the request
 * log, but the `onTerminal`/`setTerminalOutcomeRecorder` callback that every
 * other error path in `ws-bridge.ts` calls on the way out is never invoked,
 * because the throw happens before `sendResponseToWebSocket` ever reaches it.
 * Compare `tests/ws-endpoint.test.ts` "unexpected successful HTML and empty 204
 * become standalone protocol errors", which already proves the shape-sniffed
 * non-JSON case (HTML, empty body) is handled cleanly. This is the same
 * "successful but unusable body" family, just JSON-shaped instead, and it is
 * untested and unguarded.
 *
 * Expected red now: both tests below fail. `sendResponseToWebSocket` rejects
 * with a raw SyntaxError instead of resolving, so `terminals`/`sent` are never
 * populated the way the assertions expect. Expected green after a correct fix
 * (wrap both `JSON.parse` calls the same way `payloadType()` already does, and
 * fall through to the existing `protocol_error` 502 branch on failure): both
 * tests resolve normally, `onTerminal` is called with `"incomplete"`, and the
 * client receives a `type: "error"` frame instead of the connection's turn
 * silently losing its terminal-outcome bookkeeping.
 */
import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { sendResponseToWebSocket, type WsData } from "../src/server/ws-bridge";

function mockWs(sendResult = 1): { ws: ServerWebSocket<WsData>; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    data: {} as WsData,
    send: (m: string) => { sent.push(m); return sendResult; },
  } as unknown as ServerWebSocket<WsData>;
  return { ws, sent };
}

describe("sendResponseToWebSocket vs. an unparseable 'successful' body", () => {
  test("content-type: application/json with a truncated body becomes a protocol error, not a thrown SyntaxError", async () => {
    const { ws, sent } = mockWs();
    const terminals: string[] = [];
    await sendResponseToWebSocket(ws, new Response("{\"id\":\"trunc", {
      headers: { "content-type": "application/json" },
    }), () => true, {
      onTerminal: status => terminals.push(status),
    });
    expect(JSON.parse(sent.at(-1)!).type).toBe("error");
    expect(terminals).toEqual(["incomplete"]);
  });

  test("a sniffed (mislabelled) body that starts with '{' but is not valid JSON becomes a protocol error, not a thrown SyntaxError", async () => {
    const { ws, sent } = mockWs();
    const terminals: string[] = [];
    await sendResponseToWebSocket(ws, new Response("{ this is not json", {
      headers: { "content-type": "text/plain" },
    }), () => true, {
      onTerminal: status => terminals.push(status),
    });
    expect(JSON.parse(sent.at(-1)!).type).toBe("error");
    expect(terminals).toEqual(["incomplete"]);
  });
});
