/**
 * Depth from codex-rs's OWN spawn graph (`thread_spawn_edges` in CODEX_HOME/state_N.sqlite).
 *
 * Why this file exists at all: every spawned turn reaches the proxy carrying the SAME markers
 * (`x-openai-subagent: collab_spawn` + `"subagent_kind":"thread_spawn"`) no matter how deep it
 * sits, so a grandchild is indistinguishable from a child by headers alone. Asking the model to
 * report its own depth is worthless — a model that ignores the instruction, or a task body that
 * rides Fernet-encrypted to the native backend (hasUnreadableEncryptedAgentTask exists precisely
 * because opencodex cannot read those), leaves nothing behind. `thread_spawn_edges` is the one
 * depth signal that requires nothing from the model and nothing new from the client: Codex
 * writes the parent->child edge itself, for its own history/cleanup reasons
 * (src/storage/cleanup.ts already reads this table), and the proxy just walks it upward.
 *
 * Everything here is read-only and best-effort. A missing CODEX_HOME (Docker, a remote client),
 * a locked DB, a renamed table, or a schema drift all degrade to "no answer" — which the caller
 * treats as *deeper*, never shallower.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getCodexHome } from "../codex/paths";

const STATE_DB_FILE = /^state_(\d+)\.sqlite$/;

/** Walking a corrupt/cyclic graph must terminate; no real agent tree is this deep. */
const MAX_WALK_STEPS = 64;

/** Edges are re-read at most this often: a spawn storm must not open sqlite per request. */
const EDGE_CACHE_TTL_MS = 2_000;

export interface SpawnEdgeGraph {
  /** child_thread_id -> parent_thread_id */
  parentOf: Map<string, string>;
  /** every id that appears as a parent_thread_id (i.e. has at least one child) */
  parents: Set<string>;
  readAt: number;
}

let cachedGraph: SpawnEdgeGraph | null = null;

/** Test seam: replaces the sqlite read entirely (no CODEX_HOME needed in unit tests). */
let edgeReader: (() => SpawnEdgeGraph | null) | null = null;

export function setSpawnEdgeReaderForTests(reader: (() => SpawnEdgeGraph | null) | null): void {
  edgeReader = reader;
  cachedGraph = null;
  resetHeaderSemanticsForTests();
}

export function buildSpawnEdgeGraph(edges: ReadonlyArray<{ parent: string; child: string }>): SpawnEdgeGraph {
  const parentOf = new Map<string, string>();
  const parents = new Set<string>();
  for (const edge of edges) {
    if (!edge.parent || !edge.child) continue;
    // First writer wins: a child with two recorded parents is schema drift, not a DAG we
    // should average over. Keeping the first keeps the walk deterministic.
    if (!parentOf.has(edge.child)) parentOf.set(edge.child, edge.parent);
    parents.add(edge.parent);
  }
  return { parentOf, parents, readAt: Date.now() };
}

/** Newest `state_N.sqlite` under CODEX_HOME, or null. Mirrors storage/cleanup.ts discovery. */
function newestStateDb(): string | null {
  let home: string;
  try {
    home = getCodexHome();
  } catch {
    return null;
  }
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestVersion = -1;
  for (const name of names) {
    const match = name.match(STATE_DB_FILE);
    if (!match) continue;
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = name;
    }
  }
  return best ? join(home, best) : null;
}

function readSpawnEdgesFromDisk(): SpawnEdgeGraph | null {
  const path = newestStateDb();
  if (!path || !existsSync(path)) return null;
  try {
    // readonly + a SHORT busy timeout: this runs on the request path, and the Codex app is the
    // primary writer. Blocking a proxied turn on someone else's WAL checkpoint is worse than
    // returning "unknown" (which fails safe: the caller clamps).
    const db = new Database(path, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 100");
      const exists = db.query<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      ).get("thread_spawn_edges");
      if (!exists) return null;
      const rows = db.query<{ parent_thread_id: string; child_thread_id: string }, []>(
        `SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges`,
      ).all();
      return buildSpawnEdgeGraph(rows.map(row => ({ parent: row.parent_thread_id, child: row.child_thread_id })));
    } finally {
      db.close();
    }
  } catch {
    // Locked, corrupt, or a future schema. "Cannot know" — never a crash on the request path.
    return null;
  }
}

/**
 * When the last read failed, and for how long that failure is honoured.
 *
 * Failures are cached as well as successes. Only caching the successes meant
 * that in exactly the degraded states this module documents — DB missing,
 * locked by a Codex WAL checkpoint, schema drifted — every spawn-marked request
 * re-ran the synchronous readdir + `new Database()` + query on the request
 * path. `bun:sqlite` is synchronous, so with `PRAGMA busy_timeout = 100` a
 * spawn storm stalls the whole event loop ~100 ms per turn and delays every
 * unrelated proxied request, which is the precise opposite of the "a spawn
 * storm must not open sqlite per request" invariant this cache exists for.
 *
 * The window is shorter than the success TTL: a transient lock should clear
 * quickly, and waiting the full TTL to notice would keep depth unresolved (and
 * therefore nesting disabled) for longer than necessary.
 */
const EDGE_FAILURE_TTL_MS = 750;
let lastFailureAt = 0;

export function spawnEdgeGraph(now = Date.now()): SpawnEdgeGraph | null {
  if (edgeReader) return edgeReader();
  if (cachedGraph && now - cachedGraph.readAt < EDGE_CACHE_TTL_MS) return cachedGraph;
  if (lastFailureAt && now - lastFailureAt < EDGE_FAILURE_TTL_MS) return null;
  const graph = readSpawnEdgesFromDisk();
  if (graph) {
    cachedGraph = graph;
    lastFailureAt = 0;
  } else {
    lastFailureAt = now;
  }
  return graph;
}

/**
 * `x-codex-parent-thread-id` is ambiguously named across Codex versions: on some paths it
 * carries the CHILD's own thread id, on others the parent's. Rather than assume, the semantics
 * are LEARNED from the graph on spawn-marked turns and latched for the process:
 *
 *  - the header value appears as a child_thread_id but never as a parent_thread_id
 *    -> it is the turn's OWN id (a thread that has spawned nothing cannot be a parent, yet
 *       this turn was itself spawned, so the id must be the spawned thread).
 *  - the header value does not appear as a child_thread_id at all, on a turn codex-rs marked
 *    as spawned -> it cannot be the spawned thread's own id, so it is the PARENT's.
 *
 * Until one of those proofs lands, the ambiguous reading is resolved DEEP (`walk + 1`).
 */
export type ParentThreadHeaderSemantics = "own" | "parent";

let latchedSemantics: ParentThreadHeaderSemantics | null = null;

export function resetHeaderSemanticsForTests(): void {
  latchedSemantics = null;
  // The caches are process state too: a test that seeds a graph and then a
  // failure would otherwise inherit the previous case's negative window.
  cachedGraph = null;
  lastFailureAt = 0;
}

export function latchedHeaderSemantics(): ParentThreadHeaderSemantics | null {
  return latchedSemantics;
}

function walkToRoot(graph: SpawnEdgeGraph, threadId: string): number | null {
  let current = threadId;
  let steps = 0;
  const seen = new Set<string>([current]);
  while (steps < MAX_WALK_STEPS) {
    const parent = graph.parentOf.get(current);
    if (parent === undefined) return steps;
    if (seen.has(parent)) return null; // cycle: the graph is not trustworthy here
    seen.add(parent);
    current = parent;
    steps += 1;
  }
  return null;
}

export interface SpawnEdgeDepth {
  depth: number;
  semantics: ParentThreadHeaderSemantics;
  /** False while the header semantics are still unproven and the deep reading was used. */
  latched: boolean;
}

/**
 * Depth of a spawn-marked turn from the persisted graph, or null when it cannot be known.
 *
 * Write latency is deliberately unhandled: on a child's very first request the edge may not be
 * committed yet, so the header looks like "not a child" and the PARENT reading applies —
 * `walk + 1`, i.e. deeper. It self-corrects on the next turn, and the caller never demotes a
 * depth it already recorded, so the conservative first answer is the one that sticks.
 */
export function spawnEdgeDepth(threadId: string | null | undefined, now = Date.now()): SpawnEdgeDepth | null {
  const id = typeof threadId === "string" ? threadId.trim() : "";
  if (!id) return null;
  const graph = spawnEdgeGraph(now);
  if (!graph) return null;

  const isChild = graph.parentOf.has(id);
  const isParent = graph.parents.has(id);

  // An id the graph has never seen is UNKNOWN, not depth 0.
  //
  // `walkToRoot` returns 0 steps both for the genuine root and for an id with
  // no parent edge, and those are not the same thing. A grandchild's edge is
  // written by its parent, and this graph is cached for up to EDGE_CACHE_TTL_MS
  // — so a spawned turn routinely arrives before its own edge is visible.
  // Reporting that as a confident depth 0 told the caller "this is the root",
  // which left the delegation tools in place on a leaf and handed it exactly
  // the nesting the ceiling exists to deny.
  //
  // Latching on an unseen id is just as wrong: `isChild` is false only because
  // the edge has not landed, and that would fix the process-wide reading of the
  // header on an observation that was never evidence of anything.
  if (!isChild && !isParent) return null;

  if (latchedSemantics === null) {
    if (isChild && !isParent) latchedSemantics = "own";
    else if (!isChild) latchedSemantics = "parent";
  }

  if (latchedSemantics === "own") {
    const walked = walkToRoot(graph, id);
    return walked === null ? null : { depth: walked, semantics: "own", latched: true };
  }
  if (latchedSemantics === "parent") {
    const walked = walkToRoot(graph, id);
    return walked === null ? null : { depth: walked + 1, semantics: "parent", latched: true };
  }
  // Ambiguous (a child that is itself a parent, before any proof): take the deeper reading.
  const walked = walkToRoot(graph, id);
  return walked === null ? null : { depth: walked + 1, semantics: "parent", latched: false };
}
