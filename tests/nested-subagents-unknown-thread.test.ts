/**
 * Depth resolution when the spawn-edge graph does not know the thread yet.
 *
 * The graph is written by the *parent* and read here through a cache, so a
 * spawned turn routinely arrives before its own edge is visible. Reading that
 * as "no parent, therefore depth 0" is indistinguishable from the genuine root
 * — and depth 0 is the one answer that leaves the delegation tools in place.
 * The whole ceiling evaporates on exactly the turns it was built for.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  resetHeaderSemanticsForTests,
  setSpawnEdgeReaderForTests,
  spawnEdgeDepth,
  type SpawnEdgeGraph,
} from "../src/server/nested-subagents-edges";

function graphOf(edges: [parent: string, child: string][]): SpawnEdgeGraph {
  const parentOf = new Map<string, string>();
  const parents = new Set<string>();
  for (const [parent, child] of edges) {
    parentOf.set(child, parent);
    parents.add(parent);
  }
  return { parentOf, parents, readAt: Date.now() } as SpawnEdgeGraph;
}

afterEach(() => {
  setSpawnEdgeReaderForTests(null);
  resetHeaderSemanticsForTests();
});

describe("unknown thread ids", () => {
  test("a thread absent from the graph resolves to unknown, not depth 0", () => {
    // root -> A exists; C was spawned but its edge has not landed in this read.
    setSpawnEdgeReaderForTests(() => graphOf([["root", "A"]]));
    expect(spawnEdgeDepth("C")).toBeNull();
  });

  test("a known child still resolves", () => {
    setSpawnEdgeReaderForTests(() => graphOf([["root", "A"]]));
    const resolved = spawnEdgeDepth("A");
    expect(resolved).not.toBeNull();
    expect(typeof resolved!.depth).toBe("number");
  });

  test("a known parent still resolves", () => {
    // `root` has spawned, so it is in the graph even with no parent of its own.
    setSpawnEdgeReaderForTests(() => graphOf([["root", "A"]]));
    expect(spawnEdgeDepth("root")).not.toBeNull();
  });

  test("an unknown id does not latch the header semantics", () => {
    // Latching on an id the graph has never seen fixes the process-wide reading
    // of the header on an observation that was never evidence of anything.
    const { latchedHeaderSemantics } = require("../src/server/nested-subagents-edges") as
      typeof import("../src/server/nested-subagents-edges");
    setSpawnEdgeReaderForTests(() => graphOf([["root", "A"]]));
    spawnEdgeDepth("totally-unseen");
    expect(latchedHeaderSemantics()).toBeNull();
  });

  test("no graph at all is unknown rather than root", () => {
    setSpawnEdgeReaderForTests(() => null);
    expect(spawnEdgeDepth("anything")).toBeNull();
  });

  test("an absent thread id is unknown", () => {
    setSpawnEdgeReaderForTests(() => graphOf([["root", "A"]]));
    expect(spawnEdgeDepth(null)).toBeNull();
    expect(spawnEdgeDepth(undefined)).toBeNull();
    expect(spawnEdgeDepth("")).toBeNull();
  });
});
