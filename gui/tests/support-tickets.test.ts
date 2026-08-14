/**
 * The joke recovery desk's data model — sequential numbers, status theatre,
 * and the proof that clearing storage clears tickets too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { advanceTicket, createTicket, findTicket, readTickets } from "../src/shell/support-tickets";

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

describe("creating tickets", () => {
  test("gets a sequential number, starting above 1000", () => {
    const first = createTicket({ category: "lockedOut", description: "Forgot my password" });
    const second = createTicket({ category: "somethingElse", description: "Just curious" });
    expect(first.number).toBeGreaterThan(1000);
    expect(second.number).toBe(first.number + 1);
  });

  test("starts at status \"open\" with a severity from the honest, unenforced pool", () => {
    const ticket = createTicket({ category: "lockedOut", description: "x" });
    expect(ticket.status).toBe("open");
    expect(["low", "medium", "high", "critical"]).toContain(ticket.severity);
  });

  test("carries the lock's label when opened from a specific lock", () => {
    const ticket = createTicket({ category: "lockedOut", description: "x", lockLabel: "Navigation rail" });
    expect(ticket.lockLabel).toBe("Navigation rail");
  });

  test("newest first in readTickets()", () => {
    const a = createTicket({ category: "lockedOut", description: "a" });
    const b = createTicket({ category: "lockedOut", description: "b" });
    expect(readTickets()[0]!.id).toBe(b.id);
    expect(readTickets()[1]!.id).toBe(a.id);
  });
});

describe("the status theatre", () => {
  test("advances open -> underReview -> resolved, then stays resolved", () => {
    const ticket = createTicket({ category: "lockedOut", description: "x" });
    expect(findTicket(ticket.id)!.status).toBe("open");
    expect(advanceTicket(ticket.id)!.status).toBe("underReview");
    expect(advanceTicket(ticket.id)!.status).toBe("resolved");
    expect(advanceTicket(ticket.id)!.status).toBe("resolved");
  });

  test("advancing a nonexistent ticket is a no-op, not a crash", () => {
    expect(advanceTicket("does-not-exist")).toBeUndefined();
  });
});

describe("cleared by exactly the same storage wipe that resets every toy lock", () => {
  test("clearing the app's local storage empties the ticket queue", () => {
    createTicket({ category: "lockedOut", description: "x" });
    createTicket({ category: "somethingElse", description: "y" });
    expect(readTickets().length).toBe(2);

    localStorage.removeItem("ocx-m3:support-tickets");

    expect(readTickets().length).toBe(0);
  });
});
