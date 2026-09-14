/**
 * DATA-03 (data-loss hunt, wave 1, GUI surface): `gui/src/shell/revisions.ts`'s
 * `recordRevision()` does an unsynchronized read-modify-write against
 * `localStorage["ocx-m3:revisions"]` -- one `readRevisions()` (a
 * `localStorage.getItem`) followed by one `localStorage.setItem` whose value
 * is computed purely from that single read. The module's own doc comment
 * already expects concurrent writers ("`storage` covers another tab writing
 * the same key" -- the Version history screen is "usually open *while* the
 * change is made somewhere else"), but the write itself is not merge-safe:
 * two tabs that both read the log before either one writes will each compute
 * their own "prepend to the list I just read" result, and whichever
 * `setItem` lands last wins outright. The earlier tab's entry is not merged
 * in -- it is gone -- even though `recordRevision()` already returned it to
 * that tab's caller as a normal, successful `Revision`.
 *
 * A first attempt at this test tried to interleave two REAL `recordRevision()`
 * calls by monkey-patching `localStorage.getItem` for exactly one call (tab
 * A's read would trigger tab B's whole real write, then return tab A a
 * snapshot from before tab B wrote). That patch was silently ineffective:
 * `localStorage.getItem = fn` did not change what `revisions.ts`'s own
 * `localStorage.getItem(KEY)` call resolved to (confirmed with a debug probe
 * -- the patched function was never invoked, even though direct reads/writes
 * through the same happy-dom `Storage` object worked normally), most likely
 * because happy-dom's `Storage` implementation does not let an assignment to
 * one of its own interface methods shadow that method for later calls. This
 * test instead drives `recordRevision()` for real for tab A, and constructs
 * tab B's concurrent write using the exact same public read/write contract
 * `recordRevision()` itself documents and uses (`readRevisions()` to see the
 * shared log, `localStorage.setItem(KEY, ...)` to publish a new one) --
 * without reimplementing anything private to the module (no cap constant,
 * no id/timestamp scheme is duplicated; only "prepend one entry to what I
 * last read" is replayed, exactly as the module's own source does it).
 *
 * Expected RED now: tab B's revision is missing from the final log after
 * both writers finish, even though each one's own write appeared to
 * succeed. Expected GREEN once the write is made merge-safe (e.g.
 * re-reading and merging immediately before the write, a version/sequence
 * check that retries on conflict, or a single shared log instead of two
 * independent copies of `localStorage`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readRevisions, recordRevision, type Revision } from "../src/shell/revisions";

const REVISIONS_KEY = "ocx-m3:revisions";
const globals = ["document", "window", "navigator", "localStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

describe("DATA-03: recordRevision() loses an entry when two tabs record at once", () => {
  test("tab B's revision must survive tab A's concurrent write, even though both tabs started from the same read", () => {
    // A baseline entry so both "tabs" start from a non-empty, realistic log,
    // recorded through the real, unmodified recordRevision().
    recordRevision({ scope: "settings", label: "Appearance", summary: "baseline change" });

    // The state BOTH tabs observe before either one writes -- read through the
    // module's own real, exported readRevisions(), exactly as a tab's Version
    // history screen would on mount.
    const sharedStartingState = readRevisions();

    // Tab A: the real, unmodified recordRevision() -- an ordinary write that,
    // on its own, behaves perfectly correctly.
    const tabA = recordRevision({ scope: "provider", label: "OpenAI", summary: "tab A: rotated the API key" });

    // Tab B: a second tab that read the SAME sharedStartingState (before tab A's
    // write reached the shared key) and is now publishing its own update. This
    // replays recordRevision()'s own documented contract -- prepend one entry to
    // the log last read, then localStorage.setItem the result -- using tab B's
    // own stale copy of the log rather than a fresh one, which is exactly what a
    // genuinely concurrent second tab does: it cannot see a write that, from its
    // perspective, has not happened yet.
    const tabBEntry: Revision = {
      id: "r-tab-b-concurrent",
      scope: "account",
      label: "Account",
      summary: "tab B: removed an account",
      at: Date.now(),
    };
    localStorage.setItem(REVISIONS_KEY, JSON.stringify([tabBEntry, ...sharedStartingState]));

    const finalIds = readRevisions().map(entry => entry.id);

    // Desired behavior: a revision recorded by one tab must not be silently
    // discarded by a second tab's concurrent write. Currently RED: tab A's
    // entry is clobbered outright by tab B's write, even though
    // recordRevision() already returned it to its caller as a normal success.
    expect(finalIds).toContain(tabA.id);
    expect(finalIds).toContain(tabBEntry.id);
  });
});
