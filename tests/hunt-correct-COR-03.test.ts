import { describe, expect, test } from "bun:test";
import { relaySseWithResponsesItemIdRepair } from "../src/server/responses-item-id-repair";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function parseSse(text: string): Promise<Record<string, unknown>[]> {
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim())
    .filter((payload): payload is string => !!payload && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
}

// COR-03: the item-id repair cache keys a minted/repaired id by (type, output_index)
// ONLY (src/server/responses-item-id-repair.ts:58-64, `outputIds: Record<type,
// Map<number, string>>`), and once an entry exists for that pair,
// rememberMappedId (responses-item-id-repair.ts:66-85) returns it unconditionally:
// `const existing = state.outputIds[type].get(outputIndex); if (existing) return
// existing;`, without ever comparing the new event's own `item.id` against the id
// that produced that cached entry. The module's own decision log documents that it
// defends against "malformed stream이 output_index를 다른 item type에 재사용해도"
// (a malformed stream reusing output_index across a DIFFERENT item type), which the
// per-type Map does handle. It does not defend the case actually reachable through
// the very same code path: a malformed/reindexing gateway reusing output_index for a
// second, genuinely different item of the SAME type. The second item's own real id
// is read (responses-item-id-repair.ts:75) and then thrown away unread, because the
// cache hit at line 74 returns before line 75 is ever reached.
//
// Impact: two distinct reasoning blocks with different real content silently end up
// sharing one id in the client-facing stream, which is precisely the "Codex Desktop
// card correlation" the repair exists to stabilize, per its own decision log. A
// client keying UI state by item id can no longer tell the two blocks apart.
describe("hunt-correct-COR-03: item-id repair bleeds one item's identity onto a later, unrelated item", () => {
  test("a second reasoning block that reuses output_index keeps its own id, not the first block's", async () => {
    const upstream = [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_0"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_0"}}\n\n',
      // A second, unrelated reasoning item reuses output_index 0. Its id ("rs_9") is
      // not a configured placeholder and is not the first item's id: a completely
      // ordinary, already-valid id from the caller's point of view.
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_9"}}\n\n',
      'data: {"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"rs_9","delta":"second block"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_9"}}\n\n',
    ].join("");

    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      reasoning: ["rs_0"],
    })));

    const firstAddedId = (events[0].item as Record<string, unknown>).id;
    const secondAddedId = (events[2].item as Record<string, unknown>).id;
    const secondDeltaItemId = events[3].item_id;
    const secondDoneId = (events[4].item as Record<string, unknown>).id;

    // The first block is a configured placeholder and is correctly minted a
    // canonical id.
    expect(firstAddedId).toMatch(/^rs_ocx_[0-9a-f]+_0$/);

    // The second block is a different item with its own valid id ("rs_9"), which is
    // not a configured placeholder: it must be left alone, and it must certainly
    // never become indistinguishable from the first block.
    expect(secondAddedId).toBe("rs_9");
    expect(secondDeltaItemId).toBe("rs_9");
    expect(secondDoneId).toBe("rs_9");
    expect(secondAddedId).not.toBe(firstAddedId);
  });
});
