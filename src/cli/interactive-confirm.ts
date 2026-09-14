import { createInterface } from "node:readline/promises";

/**
 * Inline yes/no selector for interactive CLI prompts.
 *
 * Both choices are drawn on one line: the user moves between them with the
 * arrow keys (or Tab), confirms with Enter, or answers straight away with
 * `y`/`n`. Escape and Ctrl-C resolve to "no", so backing out never counts as
 * consent.
 *
 * The highlighted choice is caller-supplied and is what a bare Enter returns.
 * Whatever the default, the selector always shows which side is highlighted, so
 * Enter never does something the screen did not already say it would.
 */

export interface InteractiveConfirmOptions {
  /** Question text rendered before the choices. May contain ANSI styling. */
  question: string;
  /** Which choice starts highlighted, and therefore what a bare Enter returns. */
  defaultYes: boolean;
  /** Key hint shown after the choices. */
  hint?: string;
  /** Overridable for tests; defaults to the process streams. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

// The highlight sets an explicit black-on-white pair rather than bare reverse
// video (\x1b[7m). Reverse alone inherits whatever foreground colour is in
// effect, so on some themes the selected label rendered as black text on a black
// block and the choice became invisible.
const REVERSE = "\x1b[30;47m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[K";

const KEY_ENTER = new Set(["\r", "\n"]);
const KEY_YES_SIDE = new Set(["\x1b[D", "\x1b[A", "\x1bOD", "\x1bOA"]); // left / up
const KEY_NO_SIDE = new Set(["\x1b[C", "\x1b[B", "\x1bOC", "\x1bOB"]); // right / down
const KEY_ESCAPE = "\x1b";
const KEY_INTERRUPT = "\x03";
const KEY_TAB = "\t";

// Every multi-byte sequence onData ever has to reassemble. All of them start
// with KEY_ESCAPE, which is what makes a lone escape byte ambiguous: it is
// either a complete Escape keypress, or the first byte of one of these.
const ESCAPE_SEQUENCES = [...KEY_YES_SIDE, ...KEY_NO_SIDE];

// A lone escape byte waits this long for the rest of a sequence before it is
// resolved as a standalone Escape keypress. Long enough for bytes split
// across reads by a loaded terminal, a slow pipe, or a multiplexer to catch
// up; short enough that a real Escape press still reads as effectively
// instant.
const ESCAPE_DEADLINE_MS = 50;

function renderChoices(question: string, yes: boolean, hint: string): string {
  const yesLabel = yes ? `${REVERSE} Yes ${RESET}` : `${DIM} Yes ${RESET}`;
  const noLabel = yes ? `${DIM} No ${RESET}` : `${REVERSE} No ${RESET}`;
  return `${CLEAR_LINE}${question} ${yesLabel} ${noLabel}  ${DIM}${hint}${RESET}`;
}

function renderAnswer(question: string, yes: boolean): string {
  return `${CLEAR_LINE}${question} ${yes ? "Yes" : "No"}\n`;
}

/** Fallback for terminals without raw mode: a plain typed answer. */
async function readlineConfirm(
  options: InteractiveConfirmOptions,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<boolean> {
  const suffix = options.defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${options.question} ${suffix} `)).trim().toLowerCase();
    if (answer === "") return options.defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Ask a yes/no question with an inline arrow-key selector. Resolves to the
 * user's choice; never throws for input handling and always restores the
 * terminal mode it changed.
 */
export async function interactiveConfirm(options: InteractiveConfirmOptions): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const hint = options.hint ?? "←/→ move · y/n · enter";

  // Raw mode is what makes single-keypress navigation possible. Without it
  // (pipes, some CI shells, Windows consoles without a TTY) fall back to a
  // typed answer rather than silently swallowing the question.
  if (typeof input.setRawMode !== "function") {
    return await readlineConfirm(options, input, output);
  }

  return await new Promise<boolean>(resolve => {
    let yes = options.defaultYes;
    let settled = false;
    const wasRaw = input.isRaw === true;
    const hadOtherReaders = input.listenerCount("data") > 0;

    const paint = () => {
      output.write(renderChoices(options.question, yes, hint));
    };

    // Bytes that open with KEY_ESCAPE and have not yet resolved into either a
    // standalone Escape or a complete multi-byte sequence. Read events, not
    // physical keypresses, are what data arrives in, and a chunk boundary can
    // fall in the middle of a sequence (see the module comment above and
    // hunt-ux-02.test.ts). This buffer, together with escapeTimer, is what
    // lets a sequence split across reads still reassemble correctly.
    let escapeBuffer = "";
    let escapeTimer: ReturnType<typeof setTimeout> | null = null;

    const clearEscapeTimer = () => {
      if (escapeTimer !== null) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
      }
    };

    const isStrictPrefixOfKnownSequence = (candidate: string): boolean => {
      for (const sequence of ESCAPE_SEQUENCES) {
        if (sequence.length > candidate.length && sequence.startsWith(candidate)) return true;
      }
      return false;
    };

    const finish = (answer: boolean, interrupted: boolean) => {
      if (settled) return;
      settled = true;
      clearEscapeTimer();
      input.off("data", onData);
      if (!wasRaw) input.setRawMode(false);
      if (!hadOtherReaders) input.pause();
      output.write(renderAnswer(options.question, answer));
      resolve(answer);
      // A Ctrl-C during the prompt is still a Ctrl-C: hand it back to the
      // process so the normal shutdown path runs instead of being eaten here.
      if (interrupted) process.kill(process.pid, "SIGINT");
    };

    // Resolves one complete key: a control character, a letter, or a full
    // multi-byte sequence. Returns whether `key` was actually recognised, so
    // callers can tell a real key from bytes that matched nothing.
    const dispatchKey = (key: string): boolean => {
      if (key === KEY_INTERRUPT) {
        finish(false, true);
        return true;
      }
      if (key === KEY_ESCAPE) {
        finish(false, false);
        return true;
      }
      if (KEY_ENTER.has(key)) {
        finish(yes, false);
        return true;
      }
      const lower = key.toLowerCase();
      if (lower === "y") {
        finish(true, false);
        return true;
      }
      if (lower === "n") {
        finish(false, false);
        return true;
      }
      if (KEY_YES_SIDE.has(key)) {
        yes = true;
        paint();
        return true;
      }
      if (KEY_NO_SIDE.has(key) || key === KEY_TAB) {
        yes = key === KEY_TAB ? !yes : false;
        paint();
        return true;
      }
      return false;
    };

    const armEscapeTimer = () => {
      clearEscapeTimer();
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        const pending = escapeBuffer;
        escapeBuffer = "";
        if (pending) dispatchKey(pending);
      }, ESCAPE_DEADLINE_MS);
    };

    // Feeds one byte through the escape-sequence buffer. While the buffer is
    // still a strict prefix of a known sequence it is held rather than
    // dispatched, since more bytes could complete it. Any byte that instead
    // completes the buffer into a full key, or that the buffer cannot absorb
    // at all, flushes immediately: there is no need to wait for the deadline
    // once the next chunk already answers the question.
    const feedByte = (ch: string) => {
      if (settled) return;
      const candidate = escapeBuffer + ch;

      if (isStrictPrefixOfKnownSequence(candidate)) {
        escapeBuffer = candidate;
        armEscapeTimer();
        return;
      }

      const previouslyBuffered = escapeBuffer;
      clearEscapeTimer();
      escapeBuffer = "";

      if (dispatchKey(candidate)) return;

      if (previouslyBuffered) {
        // `ch` cannot extend the buffered prefix into anything real. Give the
        // prefix its own chance to resolve first (a lone KEY_ESCAPE is a
        // complete key by itself; anything else buffered was never
        // independently meaningful and is dropped here exactly as an
        // unrecognised chunk always was), then evaluate `ch` again with a
        // clean buffer.
        dispatchKey(previouslyBuffered);
        if (settled) return;
        feedByte(ch);
      }
      // else: a single fresh byte matching nothing at all. Ignore, as before.
    };

    const onData = (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of data) {
        feedByte(ch);
        if (settled) return;
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    paint();
  });
}
