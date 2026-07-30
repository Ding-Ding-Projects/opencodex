/**
 * Sessions behind the embedded terminal.
 *
 * ## Why this is gated
 *
 * A terminal is a shell, and this dashboard can be published to other devices
 * (see `ocx host` and the Remote access screen). An embedded terminal reachable
 * from the network is a remote shell with a nice font, so session creation is
 * refused unless the proxy is bound to loopback — or the user has explicitly
 * turned the gate off, having been told what it means. The credential on the
 * management API is not treated as sufficient on its own: a leaked dashboard
 * token should cost you your provider config, not your whole machine.
 *
 * ## Why there is no PTY
 *
 * Rendering a full-screen TUI needs a real pseudo-terminal, which on Windows
 * means ConPTY and a native module. `node-pty` needs node-gyp and a rebuild
 * against Electron's ABI; the maintained prebuilt fork is a beta. This
 * repository ships four runtime dependencies and a working Windows installer,
 * and neither is worth trading for it.
 *
 * So sessions here are piped, not pseudo-terminals. That runs the enormous
 * class of things people actually want a terminal for — `ocx`, git, npm,
 * `codex exec` — and it does not run a full-screen TUI. The UI says so, and
 * offers the external launcher for that case, rather than presenting a
 * terminal that mysteriously renders nothing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

import { resolveLaunchTarget } from "./app-launcher.js";

export interface TerminalPreset {
  id: string;
  label: string;
  /**
   * A launch-catalog id whose resolved binary is run, or null to run the
   * platform shell. Never a command string from a request.
   */
  target: string | null;
  /** Extra arguments, constant per preset. */
  args: string[];
  /** True when this preset drives a full-screen TUI that piping cannot render. */
  fullScreen?: boolean;
}

export const PRESETS: TerminalPreset[] = [
  { id: "shell", label: "Shell", target: null, args: [] },
  // `codex` without a subcommand is the full-screen TUI. Offered anyway,
  // flagged, because `codex --help` and `codex exec ...` typed into it work
  // perfectly well and that is most of what people want here.
  { id: "codex", label: "Codex CLI", target: "codex-cli", args: [], fullScreen: true },
  { id: "claude", label: "Claude Code", target: "claude-cli", args: [], fullScreen: true },
  { id: "grok", label: "Grok CLI", target: "grok-cli", args: [], fullScreen: true },
];

export interface TerminalChunk {
  seq: number;
  text: string;
  /**
   * `in` is the line the user sent. A piped child never echoes its own stdin,
   * so without recording it the transcript reads as answers with no questions.
   * Recorded here rather than drawn client-side so it keeps its true position
   * in the stream and survives a reload.
   */
  stream: "out" | "err" | "in";
}

export interface TerminalSessionView {
  id: string;
  presetId: string;
  label: string;
  state: "running" | "exited";
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  /** True when the preset wanted a TUI this transport cannot render. */
  fullScreen: boolean;
}

interface Session extends TerminalSessionView {
  child: ChildProcess | null;
  chunks: TerminalChunk[];
  seq: number;
}

/** Bounded so a runaway process cannot grow the proxy's heap without limit. */
const MAX_CHUNKS = 1500;
const MAX_SESSIONS = 12;
/** A single write from the client. Long enough for a pasted command, not a file. */
export const MAX_INPUT_BYTES = 8 * 1024;

const sessions = new Map<string, Session>();
let seqId = 0;
let shutdownHookInstalled = false;

/**
 * Ask the server lifecycle to kill our children on the way down.
 *
 * A shell sits waiting for input forever, so terminal children are not turns
 * and will never drain — without this, a graceful exit leaves orphaned
 * processes holding the user's home directory open. Imported lazily and
 * registered on first session so the cost lands only on a process that
 * actually opened a terminal.
 */
function ensureShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  void import("../server/lifecycle.js")
    .then(({ registerShutdownTask }) => registerShutdownTask(killAllSessions))
    .catch(() => { shutdownHookInstalled = false; });
}

function view(session: Session): TerminalSessionView {
  const { child: _child, chunks: _chunks, seq: _seq, ...rest } = session;
  return rest;
}

function record(session: Session, text: string, stream: TerminalChunk["stream"]): void {
  if (!text) return;
  session.chunks.push({ seq: ++session.seq, text, stream });
  if (session.chunks.length > MAX_CHUNKS) {
    session.chunks.splice(0, session.chunks.length - MAX_CHUNKS);
  }
}

/** The interactive shell for this platform. Never `cmd.exe`. */
function shellCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    // -NoLogo keeps the banner out of the scrollback; -NoProfile keeps a user's
    // profile from printing decoration that confuses a piped reader.
    return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"] };
  }
  return { command: process.env.SHELL || "/bin/bash", args: ["-i"] };
}

export type CreateResult =
  | { ok: true; session: TerminalSessionView }
  | { ok: false; error: string };

/**
 * Start a session for a preset.
 *
 * `presetId` is matched against the fixed list above; no command, path or
 * argument from the caller reaches a process.
 */
export function createSession(presetId: string): CreateResult {
  const preset = PRESETS.find(p => p.id === presetId);
  if (!preset) return { ok: false, error: "unknown terminal preset" };

  const live = [...sessions.values()].filter(s => s.state === "running");
  if (live.length >= MAX_SESSIONS) {
    return { ok: false, error: `too many terminal sessions open (limit ${MAX_SESSIONS})` };
  }

  let command: string;
  let args: string[];
  if (preset.target === null) {
    ({ command, args } = shellCommand());
  } else {
    const resolved = resolveLaunchTarget(preset.target);
    if (!resolved) return { ok: false, error: `${preset.label} is not installed on this machine` };
    command = resolved.path;
    args = preset.args;
  }

  // Registered on first use, not at import: a process that never opened a
  // terminal should not pay for this module during shutdown.
  ensureShutdownHook();

  const session: Session = {
    id: `term-${++seqId}`,
    presetId: preset.id,
    label: preset.label,
    state: "running",
    startedAt: Date.now(),
    fullScreen: preset.fullScreen === true,
    child: null,
    chunks: [],
    seq: 0,
  };

  try {
    const child = spawn(command, args, {
      cwd: homedir(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", NO_COLOR: process.env.NO_COLOR ?? "" },
    });
    session.child = child;
    child.stdout?.on("data", (d: Buffer) => record(session, d.toString(), "out"));
    child.stderr?.on("data", (d: Buffer) => record(session, d.toString(), "err"));
    child.on("error", err => {
      record(session, `\n${err instanceof Error ? err.message : String(err)}\n`, "err");
      session.state = "exited";
      session.endedAt = Date.now();
    });
    child.on("close", code => {
      if (session.state === "exited") return;
      session.state = "exited";
      session.exitCode = code ?? undefined;
      session.endedAt = Date.now();
      record(session, `\n[exited with code ${code}]\n`, "err");
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  sessions.set(session.id, session);
  prune();
  return { ok: true, session: view(session) };
}

function prune(): void {
  if (sessions.size <= MAX_SESSIONS * 2) return;
  const dead = [...sessions.values()]
    .filter(s => s.state === "exited")
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  for (const session of dead) {
    if (sessions.size <= MAX_SESSIONS * 2) break;
    sessions.delete(session.id);
  }
}

export function listSessions(): TerminalSessionView[] {
  return [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt).map(view);
}

export interface ReadResult {
  session: TerminalSessionView;
  chunks: TerminalChunk[];
  /** Highest seq in this response; pass back as `since` to continue. */
  cursor: number;
}

export function readSession(id: string, since = 0): ReadResult | null {
  const session = sessions.get(id);
  if (!session) return null;
  const chunks = session.chunks.filter(c => c.seq > since);
  return { session: view(session), chunks, cursor: session.seq };
}

/** Write to a running session's stdin. */
export function writeSession(id: string, data: string): { ok: boolean; error?: string } {
  const session = sessions.get(id);
  if (!session) return { ok: false, error: "unknown terminal session" };
  if (session.state !== "running" || !session.child?.stdin) {
    return { ok: false, error: "session has exited" };
  }
  if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
    return { ok: false, error: `input exceeds ${MAX_INPUT_BYTES} bytes` };
  }
  try {
    session.child.stdin.write(data);
    record(session, data, "in");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function killSession(id: string): { ok: boolean; error?: string } {
  const session = sessions.get(id);
  if (!session) return { ok: false, error: "unknown terminal session" };
  if (session.state !== "running") return { ok: true };
  try {
    session.child?.kill();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stop every running session — used on shutdown so nothing is orphaned. */
export function killAllSessions(): void {
  for (const session of sessions.values()) {
    if (session.state === "running") {
      try { session.child?.kill(); } catch { /* already gone */ }
    }
  }
}

/** Test seam: forget every session, killing anything still running. */
export function resetSessions(): void {
  killAllSessions();
  sessions.clear();
  seqId = 0;
}
