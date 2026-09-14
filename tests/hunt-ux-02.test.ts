import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { interactiveConfirm } from "../src/cli/interactive-confirm";

/**
 * Candidate UX-02.
 *
 * `interactiveConfirm` (src/cli/interactive-confirm.ts) reads raw keypresses
 * from `data` events and treats a chunk that is *exactly* the one-byte escape
 * character (`"\x1b"`, `KEY_ESCAPE`) as Escape: it calls `finish(false, false)`
 * immediately, decline, no further input read (see the `onData` closure and
 * the `if (key === KEY_ESCAPE) return finish(false, false);` line).
 *
 * The four arrow keys the same handler recognises for navigation are the
 * *three*-byte ANSI sequences `"\x1b[D"`, `"\x1b[A"`, `"\x1b[C"`, `"\x1b[B"`
 * (`KEY_YES_SIDE` / `KEY_NO_SIDE`) -- every one of which also begins with that
 * same `"\x1b"` byte. The handler only recognises them when all three bytes of
 * the sequence arrive together in one `data` event; there is no partial-escape
 * buffering.
 *
 * That assumption does not hold in general. A `PassThrough` (and, by the same
 * Node stream mechanics, a real TTY under load, over SSH, or through a
 * multiplexer) delivers two back-to-back `.write()` calls as two separate
 * `data` events rather than coalescing them -- confirmed directly against this
 * Node runtime:
 *
 *     const p = new PassThrough();
 *     p.on("data", c => console.log(JSON.stringify(String(c))));
 *     p.write("\x1b"); p.write("[D");
 *     // logs "" and "[D" as two separate events, not one "[D"
 *
 * So whenever a terminal (or anything relaying keystrokes to one, such as a
 * slow pipe or a multiplexed session) happens to split an arrow-key escape
 * sequence across two reads, `interactiveConfirm` sees a bare `"\x1b"` first
 * and immediately resolves the whole prompt to "No" -- before the user ever
 * gets to move the highlight or press Enter, and before the trailing `"[D"`
 * (now read by nobody, the listener was already removed) can say otherwise.
 * For a prompt guarding a destructive action, the failure direction happens to
 * be the safe one (it declines rather than consents), but it is still a
 * confusing state exactly in this lens: the user pressed a navigation key, the
 * screen printed "No" and moved on, and nothing told them their keypress was
 * read as Escape.
 */

function makeTty() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
  input.isRaw = false;
  input.setRawMode = ((mode: boolean) => {
    input.isRaw = mode;
    return input;
  }) as NodeJS.ReadStream["setRawMode"];

  const frames: string[] = [];
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    frames.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return write(chunk as string, ...(rest as []));
  }) as NodeJS.WriteStream["write"];

  return { input, output, frames };
}

const ENTER = "\r";

describe("hunt-ux-02: an arrow key split across two terminal reads is read as Escape", () => {
  test("a left-arrow whose escape sequence arrives in two data events still moves the highlight", async () => {
    const { input, output } = makeTty();
    const pending = interactiveConfirm({ question: "Continue?", defaultYes: false, input, output });

    // One physical left-arrow keypress, delivered the way a real terminal may
    // deliver it under load: the ESC byte and the "[D" that completes the
    // sequence arrive as two separate reads instead of one.
    input.write("\x1b");
    input.write("[D");
    input.write(ENTER);

    // A left-arrow is documented navigation (KEY_YES_SIDE): it should move the
    // highlight to "Yes" so the following Enter confirms it. Losing the bare
    // "\x1b" to the Escape branch instead resolves the whole prompt to
    // false the instant the first byte arrives, before Enter is even sent.
    expect(await pending).toBe(true);
  });
});
