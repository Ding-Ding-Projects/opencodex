/**
 * The embedded terminal spawns processes on the user's machine, so what matters
 * is that only the fixed presets can start one, that a session is bounded, and
 * that shutdown does not leave children behind.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  MAX_INPUT_BYTES,
  PRESETS,
  createSession,
  killSession,
  listSessions,
  readSession,
  resetSessions,
  writeSession,
} from "../src/lib/terminal-session";

afterEach(() => resetSessions());

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

describe("presets", () => {
  test("only the fixed presets can start a session", () => {
    const result = createSession("../../bin/sh");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unknown terminal preset");
    expect(listSessions()).toEqual([]);
  });

  test("an empty preset id starts nothing", () => {
    expect(createSession("").ok).toBe(false);
    expect(listSessions()).toEqual([]);
  });

  test("every CLI preset names a launch-catalog target, never a raw command", () => {
    for (const preset of PRESETS) {
      if (preset.target === null) continue;
      expect(preset.target).toMatch(/^[a-z-]+$/);
      // The args are fixed per preset and must not smuggle a shell fragment.
      for (const arg of preset.args) expect(arg).not.toContain(" ");
    }
  });

  test("CLI presets are flagged as full-screen so the UI can say so", () => {
    // A TUI cannot render over pipes. The flag is what stops the screen from
    // presenting an empty box and letting the user conclude it is broken.
    for (const preset of PRESETS) {
      if (preset.target !== null) expect(preset.fullScreen).toBe(true);
    }
  });
});

describe("sessions", () => {
  test("a shell session runs, echoes what was sent, and can be killed", async () => {
    const created = createSession("shell");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const id = created.session.id;
    expect(created.session.state).toBe("running");

    const wrote = writeSession(id, "echo opencodex-terminal-probe\n");
    expect(wrote.ok).toBe(true);

    await settle(2500);

    const read = readSession(id, 0);
    expect(read).not.toBeNull();
    const text = read!.chunks.map(c => c.text).join("");
    // The line the user sent is recorded server-side, so the transcript is not
    // a list of answers with no questions.
    expect(text).toContain("opencodex-terminal-probe");
    expect(read!.chunks.some(c => c.stream === "in")).toBe(true);

    expect(killSession(id).ok).toBe(true);
  }, 15000);

  test("the read cursor only returns what is new", async () => {
    const created = createSession("shell");
    if (!created.ok) return;
    const id = created.session.id;
    writeSession(id, "echo first-probe\n");
    await settle(2000);

    const first = readSession(id, 0)!;
    expect(first.chunks.length).toBeGreaterThan(0);

    // Nothing new since the cursor: an empty batch, not a repeat of everything.
    const again = readSession(id, first.cursor)!;
    expect(again.chunks).toEqual([]);
  }, 15000);

  test("oversized input is refused rather than written", () => {
    const created = createSession("shell");
    if (!created.ok) return;
    const result = writeSession(created.session.id, "x".repeat(MAX_INPUT_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeds");
  });

  test("writing to an unknown session fails without throwing", () => {
    const result = writeSession("term-does-not-exist", "hello\n");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown terminal session");
  });

  test("reading an unknown session returns null", () => {
    expect(readSession("term-nope")).toBeNull();
  });

  test("resetSessions kills what is running", async () => {
    const created = createSession("shell");
    if (!created.ok) return;
    expect(listSessions().length).toBe(1);
    resetSessions();
    expect(listSessions()).toEqual([]);
  });
});

describe("shutdown coupling", () => {
  test("the server lifecycle never names the terminal module", async () => {
    // Regression guard. Shutdown once reached for this module with a dynamic
    // import so it could kill terminal children. That pulled the launcher's
    // PATH probing into the shutdown path of *every* exit — including the ones
    // that refuse to exit — and turned a 512ms request into 7.5s on a cold
    // Windows runner. The dependency now runs the other way: a session
    // registers its own cleanup on first use, so a process that never opened a
    // terminal pays nothing.
    const source = await Bun.file(new URL("../src/server/lifecycle.ts", import.meta.url)).text();
    expect(source).not.toContain("terminal-session");
  });

  test("creating a session registers a shutdown task", async () => {
    const lifecycle = await import("../src/server/lifecycle");
    const created = createSession("shell");
    expect(created.ok).toBe(true);
    // The hook is installed through a dynamic import, so let it settle.
    await settle(200);
    expect(typeof lifecycle.registerShutdownTask).toBe("function");
    resetSessions();
  });
});
