/**
 * Nested sub-agents: letting a spawned agent spawn its own agents, bounded.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. codex-rs marks every spawned child turn identically —
 * `x-openai-subagent: collab_spawn` plus `"subagent_kind":"thread_spawn"` inside
 * `x-codex-turn-metadata` (see src/server/effort-policy.ts, which matches them exactly). A child
 * spawned by the root and a child spawned by that child arrive looking the same. So the moment
 * delegation guidance is handed to a spawned agent, the tree can grow without limit and nothing
 * in a single request says how deep it already is. Each level burns a full context of tokens, and
 * a delegation loop (A spawns B spawns A') has no natural stopping point. Depth is therefore not
 * a nicety here; it is the only thing standing between "sub-agents inside sub-agents" and a
 * runaway bill.
 *
 * WHAT OPENCODEX CAN AND CANNOT DO. The `spawn_agent` tool belongs to the Codex client. opencodex
 * does not implement spawning and cannot cancel a spawn that already happened. Enforcement here
 * splits, deliberately and visibly:
 *
 *   - UNIGNORABLE: mutations of the request body the model actually receives. The leaf clamp
 *     physically removes the collaboration tools (`spawn_agent`, `send_message`, …) from every
 *     place they can enter a turn, so a clamped agent has nothing to call. The per-depth effort
 *     cap rewrites both request shapes exactly as applyEffortCap already does. Neither depends on
 *     the client cooperating — the client is downstream of the edit.
 *   - ADVISORY: the injected per-depth roster and preferred model/effort. A model that ignores
 *     them spawns on the wrong model at the wrong rung, and the server-side cap clamps it anyway.
 *     That is exactly today's advisory/enforced split, extended per depth, not a new promise.
 *
 * HOW DEPTH IS KNOWN (see resolveDepth below for the ordering):
 *   1. `thread_spawn_edges` — Codex's own parent->child table in its own state DB. Requires
 *      nothing from the model. Primary. (src/server/nested-subagents-edges.ts)
 *   2. Path-shaped agent addresses (`author:"/root"`, `recipient:"/root/worker"`) that codex-rs
 *      already puts on `agent_message` items — segment count is depth. Corroborator, not primary:
 *      the repo's own fixtures disagree about the address format (tests/responses-parser-agent-
 *      message.test.ts carries bare `author:"probe_all", recipient:"root"`), and a bare name would
 *      count as depth 0 forever — the UNSAFE direction. So a non-path address contributes nothing
 *      rather than a shallow answer.
 *   3. codex-rs's own leaf guard: a spawn-marked turn arriving with NO collaboration tools means
 *      the client already refused to give this level delegation. Free upper-bound witness.
 *   4. An `[[ocx:d=N]]` sentinel in the task body — an invented convention, off by default, and
 *      allowed only to RAISE the believed depth. Its one honest use is a deployment with no local
 *      CODEX_HOME (Docker) and no path addresses, where nothing else resolves.
 *
 * The resolver takes the MAXIMUM of whatever resolves and never demotes a depth it has already
 * recorded for a node. When nothing resolves the depth is `unknown`, treated as `maxDepth`
 * (clamped, warned once, never refused) — a wrong clamp only removes nesting, a wrong refusal
 * breaks a legitimate depth-1 flow that works today.
 *
 * WHAT "ULTRA INSIDE ULTRA" ACTUALLY SHIPS AS — say this before anyone builds a mental model on
 * it. `ultra` never reaches a provider: src/reasoning-effort.ts mapReasoningEffort converts it to
 * `max` before ANY request, mirroring codex-rs's own `reasoning_effort_for_request`. So nesting
 * `ultra` at depth 2 does not buy a higher upstream reasoning tier than `max` — there isn't one.
 * What a depth row's `injectionEffort: "ultra"` buys is the DELEGATION behaviour the rung stands
 * for in Codex ("maximum reasoning with automatic task delegation"): the child is told it may
 * delegate, and is given a roster scoped to its level. The reasoning depth is `max` at every
 * level, at every depth, and no configuration here changes that.
 */
import { isCodexReasoningEffort } from "../reasoning-effort";
import type { OcxConfig, OcxNestedSubagentDepthConfig, OcxParsedRequest } from "../types";
import { isThreadSpawnRequest } from "./effort-policy";
import { latchedHeaderSemantics, spawnEdgeDepth } from "./nested-subagents-edges";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** A tree deeper than this is a delegation loop, not a plan. Hard ceiling on the config value. */
export const NESTED_MAX_DEPTH_LIMIT = 4;
export const NESTED_MAX_CHILDREN_LIMIT = 32;
export const NESTED_MAX_SESSION_SPAWNS_LIMIT = 512;
export const NESTED_MAX_TURNS_PER_AGENT_LIMIT = 1000;

export const NESTED_DEFAULTS = {
  maxDepth: 2,
  maxChildrenPerNode: 3,
  maxTotalSpawnsPerSession: 12,
  maxTurnsPerSpawnedAgent: 40,
} as const;

export interface ResolvedDepthRow {
  models?: string[];
  injectionModel?: string;
  injectionEffort?: string;
  effortCap?: string;
}

export interface ResolvedNestedSettings {
  maxDepth: number;
  maxChildrenPerNode: number;
  maxTotalSpawnsPerSession: number;
  maxTurnsPerSpawnedAgent: number;
  unknownDepth: number;
  spawnEdgeLookup: boolean;
  trustTaskSentinel: boolean;
  depths: ResolvedDepthRow[];
}

/**
 * Clamp at READ time, not only at write time. The schema validates what the dashboard writes,
 * but config.json is a plain file a user can hand-edit: `"maxDepth": 99` must become 4 here, not
 * become 99 because it happened to parse. Same reasoning as injectionEffort's boundary
 * validation — a bad value degrades the optional feature, never the whole config.
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function resolveDepthRow(row: unknown): ResolvedDepthRow {
  const source = (row ?? {}) as OcxNestedSubagentDepthConfig;
  const models = Array.isArray(source.models)
    ? source.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
    : undefined;
  return {
    models: models && models.length > 0 ? models : undefined,
    injectionModel: typeof source.injectionModel === "string" && source.injectionModel.trim().length > 0
      ? source.injectionModel
      : undefined,
    // Effort strings are validated against the Codex ladder here, exactly as injectionEffort is
    // at the API boundary: an unknown rung must not become an unrankable "cap" that silently
    // disables the reduce in effortCapFor.
    injectionEffort: typeof source.injectionEffort === "string" && isCodexReasoningEffort(source.injectionEffort)
      ? source.injectionEffort
      : undefined,
    effortCap: typeof source.effortCap === "string" && isCodexReasoningEffort(source.effortCap)
      ? source.effortCap
      : undefined,
  };
}

/** Resolved settings, or null when the feature is off (the ONLY thing most callers check). */
export function nestedSubagentSettings(config: Pick<OcxConfig, "nestedSubagents">): ResolvedNestedSettings | null {
  const raw = config.nestedSubagents;
  if (!raw || raw.enabled !== true) return null;
  const maxDepth = clampInt(raw.maxDepth, NESTED_DEFAULTS.maxDepth, 1, NESTED_MAX_DEPTH_LIMIT);
  return {
    maxDepth,
    maxChildrenPerNode: clampInt(raw.maxChildrenPerNode, NESTED_DEFAULTS.maxChildrenPerNode, 1, NESTED_MAX_CHILDREN_LIMIT),
    maxTotalSpawnsPerSession: clampInt(
      raw.maxTotalSpawnsPerSession,
      NESTED_DEFAULTS.maxTotalSpawnsPerSession,
      1,
      NESTED_MAX_SESSION_SPAWNS_LIMIT,
    ),
    maxTurnsPerSpawnedAgent: clampInt(
      raw.maxTurnsPerSpawnedAgent,
      NESTED_DEFAULTS.maxTurnsPerSpawnedAgent,
      1,
      NESTED_MAX_TURNS_PER_AGENT_LIMIT,
    ),
    // Fail deep by default: an unresolved depth is treated as the deepest permitted level, so
    // it gets clamped instead of granted another level of nesting.
    unknownDepth: clampInt(raw.unknownDepthAssumption, maxDepth, 1, maxDepth),
    spawnEdgeLookup: raw.spawnEdgeLookup !== false,
    trustTaskSentinel: raw.trustTaskSentinel === true,
    depths: Array.isArray(raw.depths) ? raw.depths.map(resolveDepthRow) : [],
  };
}

/**
 * Policy row for turns at `depth`. Row index 0 describes depth 1; the LAST configured row
 * extends to every deeper level, so one row means "same policy everywhere". Depth 0 (the root
 * agent) has no row — it keeps the top-level config exactly as it is today.
 */
export function depthRowFor(settings: ResolvedNestedSettings, depth: number): ResolvedDepthRow | undefined {
  if (depth <= 0 || settings.depths.length === 0) return undefined;
  const index = Math.min(depth - 1, settings.depths.length - 1);
  return settings.depths[index];
}

/** Worst-case thread count for a fully fanned-out tree — what "maxDepth 3 / fanout 4" costs. */
export function worstCaseSpawnCount(settings: ResolvedNestedSettings): number {
  let total = 0;
  let level = 1;
  for (let depth = 1; depth <= settings.maxDepth; depth += 1) {
    level *= settings.maxChildrenPerNode;
    total += level;
    if (total >= settings.maxTotalSpawnsPerSession) return settings.maxTotalSpawnsPerSession;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Agent addresses
// ---------------------------------------------------------------------------

/**
 * Depth of a path-shaped agent address: `/root` -> 0, `/root/worker` -> 1.
 *
 * Returns null for anything that is not clearly path-shaped and rooted. That includes the bare
 * `"root"` / `"probe_all"` forms present in this repo's fixtures. Guessing 0 for a bare name
 * would under-report depth — the one direction this feature must never fail in — so an
 * unrecognized address contributes NOTHING and the other sources decide.
 */
export function agentAddressDepth(address: unknown): number | null {
  if (typeof address !== "string") return null;
  const trimmed = address.trim();
  if (!trimmed.startsWith("/")) return null;
  const segments = trimmed.split("/").filter(segment => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments[0] !== "root") return null;
  if (segments.length - 1 > NESTED_MAX_DEPTH_LIMIT * 4) return null; // absurd; treat as unparseable
  return segments.length - 1;
}

function normalizedAddress(address: unknown): string | null {
  if (typeof address !== "string") return null;
  const trimmed = address.trim();
  if (!trimmed || trimmed.length > 512) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Pre-sanitize lineage capture
// ---------------------------------------------------------------------------

/**
 * INVENTED CONVENTION (see OcxNestedSubagentsConfig.trustTaskSentinel). Nothing in codex-rs
 * writes this; it exists only so a deployment with no other signal can opt into one.
 */
const TASK_DEPTH_SENTINEL = /\[\[ocx:d=(\d{1,2})\]\]/;

export interface LineageCapture {
  /** Address the tail NEW_TASK item is addressed TO (this turn's own agent), when path-shaped. */
  taskRecipient?: string;
  /** Address that sent it (this turn's parent). */
  taskAuthor?: string;
  /** Depth derived from taskRecipient. */
  taskDepth?: number;
  /** Deepest path-shaped recipient anywhere in the input (last-resort address reading). */
  deepestRecipientDepth?: number;
  /** author -> recipient pairs observed, for fan-out accounting. */
  edges: Array<{ author: string; recipient: string }>;
  /** Depth claimed by an `[[ocx:d=N]]` sentinel in the tail task text, when present. */
  sentinelDepth?: number;
}

function readableTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown; encrypted_content?: unknown };
    if ((record.type === "input_text" || record.type === "text") && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "encrypted_content" && typeof record.encrypted_content === "string") {
      // Plaintext-in-an-encrypted-slot is the common spawn shape (sanitizeEncryptedContentInPlace
      // exists for it). Genuine Fernet ciphertext just contributes noise no regex will match.
      parts.push(record.encrypted_content);
    }
  }
  return parts.join("\n");
}

/**
 * Capture lineage from the RAW request input.
 *
 * ORDERING IS LOAD-BEARING: this must run BEFORE sanitizeEncryptedContentInPlace, which rewrites
 * `agent_message` -> `message` and DELETES the `id`/`author`/`recipient` fields this reads
 * (src/server/responses/encrypted-payload.ts). Run it after, and the addresses are simply gone.
 *
 * The `enabled` gate is the FIRST statement on purpose: for every user who never turns the
 * feature on, this function must not scan the input, allocate a map, or touch the body at all.
 */
export function captureAgentLineage(
  config: Pick<OcxConfig, "nestedSubagents">,
  input: unknown,
): LineageCapture | null {
  const settings = nestedSubagentSettings(config);
  if (!settings) return null;
  if (!Array.isArray(input)) return null;

  const capture: LineageCapture = { edges: [] };

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if ((item as { type?: unknown }).type !== "agent_message") continue;
    const message = item as { author?: unknown; recipient?: unknown };
    const author = normalizedAddress(message.author);
    const recipient = normalizedAddress(message.recipient);
    if (author && recipient) capture.edges.push({ author, recipient });
    const depth = agentAddressDepth(recipient);
    if (depth !== null && (capture.deepestRecipientDepth === undefined || depth > capture.deepestRecipientDepth)) {
      capture.deepestRecipientDepth = depth;
    }
  }

  // The tail NEW_TASK item is this turn's own task. Walk back past trailing metadata exactly as
  // hasUnreadableEncryptedAgentTask does — compaction_trigger/additional_tools are not turns.
  let index = input.length - 1;
  while (index >= 0) {
    const type = input[index] && typeof input[index] === "object"
      ? (input[index] as { type?: unknown }).type
      : undefined;
    if (type !== "compaction_trigger" && type !== "additional_tools") break;
    index -= 1;
  }
  const tail = index >= 0 ? input[index] : undefined;
  if (tail && typeof tail === "object" && (tail as { type?: unknown }).type === "agent_message") {
    const message = tail as { author?: unknown; recipient?: unknown; content?: unknown };
    const recipient = normalizedAddress(message.recipient);
    const author = normalizedAddress(message.author);
    if (recipient) capture.taskRecipient = recipient;
    if (author) capture.taskAuthor = author;
    const depth = agentAddressDepth(recipient);
    if (depth !== null) capture.taskDepth = depth;
    if (settings.trustTaskSentinel) {
      const match = TASK_DEPTH_SENTINEL.exec(readableTextOf(message.content));
      if (match) {
        const claimed = Number(match[1]);
        if (Number.isFinite(claimed) && claimed >= 0 && claimed <= NESTED_MAX_DEPTH_LIMIT * 4) {
          capture.sentinelDepth = claimed;
        }
      }
    }
  }

  return capture;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const SESSION_IDLE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 200;
/** Bound on distinct node keys tracked per session, so a hostile/looping client cannot grow the map. */
const MAX_NODES_PER_SESSION = 4096;

interface SessionState {
  lastUsedAt: number;
  /** node key -> best known depth. NEVER demoted: a turn that loses its markers keeps its depth. */
  depths: Map<string, number>;
  /** parent node key -> child node keys observed under it. */
  children: Map<string, Set<string>>;
  /** distinct child node keys seen in this session (the agent budget). */
  spawnedNodes: Set<string>;
  /** every spawn-marked turn seen (the turn-count runaway guard). */
  spawnTurns: number;
  unknownWarned: boolean;
}

const sessions = new Map<string, SessionState>();

export function __resetNestedSubagentRegistryForTests(): void {
  sessions.clear();
}

export function __nestedSubagentSessionCountForTests(): number {
  return sessions.size;
}

function pruneExpiredSessions(now: number): void {
  for (const [key, state] of sessions) {
    if (now - state.lastUsedAt > SESSION_IDLE_TTL_MS) sessions.delete(key);
  }
}

function pruneLruSessions(): void {
  while (sessions.size > MAX_SESSIONS) {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, state] of sessions) {
      if (state.lastUsedAt < oldest) {
        oldest = state.lastUsedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    sessions.delete(oldestKey);
  }
}

function sessionFor(key: string, now: number): SessionState {
  pruneExpiredSessions(now);
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsedAt = now;
    return existing;
  }
  const created: SessionState = {
    lastUsedAt: now,
    depths: new Map(),
    children: new Map(),
    spawnedNodes: new Set(),
    spawnTurns: 0,
    unknownWarned: false,
  };
  sessions.set(key, created);
  // AFTER the insert, so the map is never observed above the cap even for one call.
  pruneLruSessions();
  return created;
}

/**
 * Session identity for accounting. Deliberately NOT the hashed log conversation id: this map is
 * in-process, never persisted, and must group a parent turn with the children it spawned even
 * when only some of them carry a session header.
 *
 * Known coarseness: turns carrying none of these headers share one "anonymous" bucket and
 * therefore one spawn budget. Codex sends `session_id` on every turn, so in practice this bites
 * only synthetic traffic — and it errs toward clamping sooner, not later.
 */
export function nestedSessionKey(headers: Headers): string {
  const raw = headers.get("session_id")
    ?? headers.get("session-id")
    ?? headers.get("x-codex-window-id")
    ?? headers.get("x-codex-parent-thread-id")
    ?? "";
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 256) : "anonymous";
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type NestedClampReason =
  | "max_depth"
  | "unknown_depth"
  | "fanout_exhausted"
  | "session_budget"
  | "turn_budget"
  | "client_leaf";

export interface NestedSubagentDecision {
  settings: ResolvedNestedSettings;
  depth: number;
  certainty: "known" | "assumed";
  /** Which sources contributed, for the request log / injection debug. */
  sources: string[];
  /** Children this node may still spawn (0 when exhausted or clamped). */
  remainingChildren: number;
  /** Sub-agents the session may still spawn. */
  remainingSessionSpawns: number;
  /** True when the collaboration tool set must be stripped from this turn. */
  clamp: boolean;
  clampReason?: NestedClampReason;
  /** Set only when the turn must be refused outright (HTTP 400). */
  refuse?: { code: string; message: string };
  /** True exactly once per session, the first time a spawn resolves `unknown`. */
  warnUnknown: boolean;
  /** Effort ceiling for THIS turn's depth (folded into the existing lowest-wins reduce). */
  effortCap?: string;
  /** Policy row describing the CHILDREN this turn may spawn (depth + 1). */
  childRow?: ResolvedDepthRow;
}

export const SUBAGENT_DEPTH_LIMIT_CODE = "subagent_depth_limit_exceeded";

interface DepthCandidate {
  depth: number;
  source: string;
  known: boolean;
}

function collabToolNamesPresent(parsed: OcxParsedRequest): boolean {
  for (const tool of parsed.context.tools ?? []) {
    if (tool.name === "spawn_agent") return true;
  }
  return false;
}

/**
 * Resolve this turn's depth from every available source, taking the maximum.
 *
 * "Maximum" is the whole safety argument: each source can only be wrong by under-reporting
 * (a missing edge row, a bare address, a lost sentinel), never by inventing depth that is not
 * there. Taking the max therefore fails toward "deeper", which costs at worst one lost level
 * of nesting; taking a minimum or a "most trusted single source" would fail toward "shallower",
 * which is unbounded growth.
 */
function resolveDepth(args: {
  settings: ResolvedNestedSettings;
  parsed: OcxParsedRequest;
  capture: LineageCapture | null;
  session: SessionState;
  nodeKeys: readonly string[];
  spawn: boolean;
  /** Already resolved by the caller: the latch it sets also decides node-key aliasing. */
  edge: ReturnType<typeof spawnEdgeDepth>;
}): { depth: number; certainty: "known" | "assumed"; sources: string[] } {
  const { settings, parsed, capture, session, nodeKeys, spawn, edge } = args;
  const candidates: DepthCandidate[] = [];

  // Registry: a node we already resolved keeps its depth even on a later turn that lost every
  // marker (a child's follow-up turn arrives looking like a plain main turn).
  let remembered: number | undefined;
  for (const key of nodeKeys) {
    const value = session.depths.get(key);
    if (value !== undefined) remembered = remembered === undefined ? value : Math.max(remembered, value);
  }
  if (remembered !== undefined) candidates.push({ depth: remembered, source: "registry", known: true });

  if (!spawn && candidates.length === 0) {
    // Not a spawned turn and nothing remembered: this is the root agent.
    return { depth: 0, certainty: "known", sources: ["root"] };
  }

  if (spawn) {
    // 1. Codex's own spawn graph — the only source that needs nothing from the model.
    if (edge) {
      candidates.push({
        depth: edge.depth,
        source: edge.latched ? `spawn_edges:${edge.semantics}` : "spawn_edges:unlatched",
        known: true,
      });
    }

    // 2. Path-shaped addresses.
    if (capture?.taskDepth !== undefined) {
      candidates.push({ depth: capture.taskDepth, source: "address:task", known: true });
    } else if (capture?.deepestRecipientDepth !== undefined) {
      // Last resort within this source: an agent's inbox holds its own address and (on
      // fork_turns spawns) its ancestors' — never a descendant's. A parent's own outgoing
      // send_message can appear too, which biases DEEPER, i.e. safe.
      candidates.push({ depth: capture.deepestRecipientDepth, source: "address:deepest", known: true });
    }

    // 3. codex-rs's own leaf guard already fired: this turn was spawned but was handed no
    // collaboration tools, which the client only does at ITS max spawn depth. Free upper bound.
    if (!collabToolNamesPresent(parsed)) {
      candidates.push({ depth: settings.maxDepth, source: "client_leaf", known: false });
    }

    // 4. Invented sentinel, opt-in, raise-only (it is already only ever folded into a max).
    if (settings.trustTaskSentinel && capture?.sentinelDepth !== undefined) {
      candidates.push({ depth: capture.sentinelDepth, source: "sentinel", known: false });
    }
  }

  if (candidates.length === 0) {
    return { depth: settings.unknownDepth, certainty: "assumed", sources: ["unknown"] };
  }

  let depth = 0;
  for (const candidate of candidates) depth = Math.max(depth, candidate.depth);
  const known = candidates.some(candidate => candidate.known);
  return {
    depth,
    certainty: known ? "known" : "assumed",
    sources: candidates.map(candidate => `${candidate.source}=${candidate.depth}`),
  };
}

/**
 * The whole nested-subagent policy for one turn. Returns null when the feature is off — that
 * null is what keeps an untouched config byte-for-byte unchanged, so it is checked FIRST.
 */
export function evaluateNestedSubagents(args: {
  config: Pick<OcxConfig, "nestedSubagents">;
  headers: Headers;
  parsed: OcxParsedRequest;
  capture: LineageCapture | null;
  now?: number;
}): NestedSubagentDecision | null {
  const settings = nestedSubagentSettings(args.config);
  if (!settings) return null;
  const { headers, parsed, capture } = args;
  const now = args.now ?? Date.now();

  // Compaction turns are maintenance, not agent turns — the same carve-out effortCapAppliesTo
  // makes. Clamping tools or injecting a leaf note into a summarization turn would corrupt the
  // summary for no safety gain (a compaction turn cannot spawn anything).
  if (parsed._compactionRequest === true) return null;

  const spawn = isThreadSpawnRequest(headers);
  const sessionKey = nestedSessionKey(headers);
  // Ordinary traffic (a plain main turn on a thread nothing has been spawned from, a Claude Code
  // request passing through) must not allocate or churn a session entry: peek first, and answer
  // "root, unclamped" without touching the registry when there is nothing to remember.
  if (!spawn && !sessions.has(sessionKey)) {
    return {
      settings,
      depth: 0,
      certainty: "known",
      sources: ["root"],
      remainingChildren: settings.maxChildrenPerNode,
      remainingSessionSpawns: settings.maxTotalSpawnsPerSession,
      clamp: false,
      warnUnknown: false,
      effortCap: undefined,
      childRow: depthRowFor(settings, 1),
    };
  }
  const session = sessionFor(sessionKey, now);

  // Node identity: the agent's own address when it is path-shaped, else its thread id. The
  // thread-id fallback is coarse (children of one parent can collide), which UNDER-counts
  // fan-out — so it can only make the ceiling arrive late, never wrongly early.
  const threadId = headers.get("x-codex-parent-thread-id")?.trim();
  const threadKey = threadId ? `thread:${threadId}` : "thread:anonymous";
  const nodeKey = capture?.taskRecipient ?? threadKey;
  // Resolved up front because the header-semantics latch it sets also decides whether the
  // thread key may be aliased to the address key below.
  const edge = spawn && settings.spawnEdgeLookup ? spawnEdgeDepth(threadId, now) : null;
  // Alias the address key to the thread key ONLY once the spawn graph has proven that
  // `x-codex-parent-thread-id` carries the turn's OWN id. Aliasing under the unproven reading
  // would attach a child's depth to its PARENT's thread key and over-clamp the parent — the one
  // "fail deep" that costs a legitimate level of delegation rather than buying safety.
  const nodeKeys = nodeKey !== threadKey && latchedHeaderSemantics() === "own"
    ? [nodeKey, threadKey]
    : [nodeKey];
  const parentKey = capture?.taskAuthor ?? null;

  const resolved = resolveDepth({ settings, parsed, capture, session, nodeKeys, spawn, edge });

  // Never demote: once a node has been seen at a depth, a later turn that resolves shallower
  // (a lost header, a compacted input with no addresses) must not win it back a level.
  let previous: number | undefined;
  for (const key of nodeKeys) {
    const value = session.depths.get(key);
    if (value !== undefined) previous = previous === undefined ? value : Math.max(previous, value);
  }
  const depth = previous !== undefined ? Math.max(previous, resolved.depth) : resolved.depth;
  for (const key of nodeKeys) {
    if (session.depths.size < MAX_NODES_PER_SESSION || session.depths.has(key)) session.depths.set(key, depth);
  }

  let warnUnknown = false;
  if (spawn) {
    session.spawnTurns += 1;
    if (session.spawnedNodes.size < MAX_NODES_PER_SESSION) session.spawnedNodes.add(nodeKey);
    if (parentKey) {
      const siblings = session.children.get(parentKey) ?? new Set<string>();
      if (siblings.size < MAX_NODES_PER_SESSION) siblings.add(nodeKey);
      session.children.set(parentKey, siblings);
    }
    if (resolved.certainty === "assumed" && !session.unknownWarned) {
      // A quiet over-clamp is the worst failure mode this feature has: the user enables
      // nesting, every child resolves unknown, every child is clamped, nesting never happens
      // and nothing says why. Say it once, loudly, per session.
      session.unknownWarned = true;
      warnUnknown = true;
    }
  }

  const observedChildren = session.children.get(nodeKey)?.size ?? 0;
  const remainingChildren = Math.max(0, settings.maxChildrenPerNode - observedChildren);
  const remainingSessionSpawns = Math.max(0, settings.maxTotalSpawnsPerSession - session.spawnedNodes.size);
  const turnBudget = settings.maxTotalSpawnsPerSession * settings.maxTurnsPerSpawnedAgent;

  let clamp = false;
  let clampReason: NestedClampReason | undefined;
  const setClamp = (reason: NestedClampReason): void => {
    if (!clamp) {
      clamp = true;
      clampReason = reason;
    }
  };

  if (depth >= settings.maxDepth) setClamp(resolved.certainty === "assumed" ? "unknown_depth" : "max_depth");
  if (spawn && !collabToolNamesPresent(parsed)) setClamp("client_leaf");
  if (remainingChildren <= 0) setClamp("fanout_exhausted");
  if (remainingSessionSpawns <= 0) setClamp("session_budget");
  if (session.spawnTurns > turnBudget) setClamp("turn_budget");

  // Refusal is reserved for the two cases where letting the turn run would be worse than
  // breaking it: a depth we KNOW exceeds the ceiling (an inferred or unknown depth never
  // refuses — a wrong refusal breaks a legitimate flow), and a spent session budget, which is
  // the one bound that holds with no depth resolution at all.
  let refuse: NestedSubagentDecision["refuse"];
  if (resolved.certainty === "known" && depth > settings.maxDepth) {
    refuse = {
      code: SUBAGENT_DEPTH_LIMIT_CODE,
      message: `Sub-agent nesting depth ${depth} exceeds the configured maximum of ${settings.maxDepth}. `
        + "Raise nestedSubagents.maxDepth to allow deeper delegation.",
    };
  } else if (spawn && session.spawnedNodes.size > settings.maxTotalSpawnsPerSession) {
    refuse = {
      code: SUBAGENT_DEPTH_LIMIT_CODE,
      message: `This session has already spawned its budget of ${settings.maxTotalSpawnsPerSession} sub-agents. `
        + "Raise nestedSubagents.maxTotalSpawnsPerSession to allow more.",
    };
  }

  return {
    settings,
    depth,
    certainty: resolved.certainty,
    sources: resolved.sources,
    remainingChildren: clamp ? 0 : remainingChildren,
    remainingSessionSpawns,
    clamp,
    clampReason,
    refuse,
    warnUnknown,
    effortCap: depthRowFor(settings, depth)?.effortCap,
    childRow: clamp ? undefined : depthRowFor(settings, depth + 1),
  };
}

// ---------------------------------------------------------------------------
// Leaf clamp
// ---------------------------------------------------------------------------

/**
 * The collaboration tool set, both surfaces. v2: spawn_agent/send_message/followup_task/
 * interrupt_agent/list_agents. v1: spawn_agent/send_input/resume_agent/close_agent.
 * Matching codex-rs's own leaf guard, which hands a depth-limited child no collab tools at all.
 */
export const COLLAB_TOOL_NAMES: ReadonlySet<string> = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "send_input",
  "resume_agent",
  "close_agent",
]);

function isCollabSpec(spec: unknown): boolean {
  if (!spec || typeof spec !== "object") return false;
  const name = (spec as { name?: unknown }).name;
  return typeof name === "string" && COLLAB_TOOL_NAMES.has(name);
}

/** Filter one wire tool-spec array in place; returns how many specs were removed. */
function stripSpecArray(specs: unknown[]): number {
  let removed = 0;
  for (let i = specs.length - 1; i >= 0; i -= 1) {
    const spec = specs[i];
    if (isCollabSpec(spec)) {
      specs.splice(i, 1);
      removed += 1;
      continue;
    }
    // Namespaced surface: the collab tools can ride inside a `namespace` spec's inner list.
    if (spec && typeof spec === "object" && (spec as { type?: unknown }).type === "namespace") {
      const inner = (spec as { tools?: unknown }).tools;
      if (Array.isArray(inner)) {
        removed += stripSpecArray(inner);
        if (inner.length === 0) {
          specs.splice(i, 1);
        }
      }
    }
  }
  return removed;
}

/**
 * Remove the collaboration tools from EVERY path by which they can reach the model. Missing any
 * one of these makes the ceiling decorative:
 *   1. `_rawBody.tools`            — the ordinary declaration.
 *   2. `additional_tools` input items — the Codex Desktop responses_lite WS path puts tools
 *                                       INSIDE input (src/responses/parser.ts).
 *   3. `tool_search_output.tools`  — tool_search re-exposes loaded tools to the model MID-TURN,
 *                                    so a clamped leaf could otherwise re-acquire spawn_agent.
 *   4. `parsed.context.tools`      — what routed/translated adapters actually send.
 * Returns the number of specs removed (0 means the turn had none to begin with).
 */
export function stripCollabToolsInPlace(parsed: OcxParsedRequest): number {
  let removed = 0;
  const raw = parsed._rawBody as { tools?: unknown; input?: unknown } | undefined;

  if (raw && Array.isArray(raw.tools)) removed += stripSpecArray(raw.tools);

  if (raw && Array.isArray(raw.input)) {
    for (const item of raw.input) {
      if (!item || typeof item !== "object") continue;
      const type = (item as { type?: unknown }).type;
      if (type !== "additional_tools" && type !== "tool_search_output") continue;
      const tools = (item as { tools?: unknown }).tools;
      if (Array.isArray(tools)) removed += stripSpecArray(tools);
    }
  }

  if (Array.isArray(parsed.context.tools)) {
    const before = parsed.context.tools.length;
    parsed.context.tools = parsed.context.tools.filter(tool => !COLLAB_TOOL_NAMES.has(tool.name));
    removed += before - parsed.context.tools.length;
  }

  return removed;
}

/**
 * Developer note paired with the strip. The tools vanishing without explanation reads to the
 * model as a broken environment; saying why (and that the work is now its own) is the difference
 * between a leaf that does the task and a leaf that reports it cannot.
 */
export function leafDeveloperNote(decision: NestedSubagentDecision): string {
  const { settings, depth, certainty, clampReason } = decision;
  const reason = clampReason === "fanout_exhausted"
    ? `you have already spawned the maximum of ${settings.maxChildrenPerNode} sub-agents`
    : clampReason === "session_budget" || clampReason === "turn_budget"
      ? `this session has spent its budget of ${settings.maxTotalSpawnsPerSession} sub-agents`
      : certainty === "assumed"
        ? `your delegation depth could not be determined, so it is treated as the maximum of ${settings.maxDepth}`
        : `you are at delegation depth ${depth} of a maximum of ${settings.maxDepth}`;
  return "<multi_agent_mode>"
    + `Sub-agent delegation is unavailable on this turn: ${reason}. `
    + "The spawn_agent and related collaboration tools have been removed from this request — "
    + "you are a leaf agent. Complete the task yourself with the tools you have, and do not "
    + "describe the work as blocked on delegation."
    + "</multi_agent_mode>";
}
