/**
 * WebSocket turn budgets in tests/server-auth.test.ts must stay generous.
 *
 * That file already documents the failure mode in a comment above the option
 * auth matrix test: Windows CI running the full suite can spend more than a
 * second just opening a WebSocket turn. A budget tuned to a quiet developer
 * machine then rejects a turn that was merely slow, and the damage does not
 * stop at one red test. The rejected turn leaves its server and its fetch
 * override alive, the late restore lands during the next test, and a case that
 * asserts a mocked 500 sees a real 502 instead. One tight number produces two
 * failures in unrelated tests, which is the worst kind of flake to chase.
 *
 * A timing budget cannot be proven correct by another timing test: a test that
 * waits five seconds to show that five seconds are available is just as
 * load-sensitive as the budget it guards, and it would pass on this quiet
 * machine whatever the budgets said. So this guard reads the source instead and
 * asserts the floor directly. It is deterministic, it costs milliseconds, and
 * it fails the moment someone reintroduces a one-second budget.
 *
 * This guard deliberately does not assert that the flake itself is gone. The
 * cascade only reproduces under full-suite contention on Windows and cannot be
 * observed here.
 */
import { describe, expect, test } from "bun:test";

const SOURCE_PATH = "tests/server-auth.test.ts";

/** The floor every WebSocket turn budget in that file has to clear. */
const MINIMUM_BUDGET_MS = 5_000;

/**
 * The per-test override a WebSocket test needs so that a slow but healthy turn
 * is not cut short by bun's own default test timeout instead.
 */
const MINIMUM_TEST_TIMEOUT_MS = 30_000;

/**
 * Rejection deadlines written as `setTimeout(() => reject(new Error(msg)), delay)`.
 * The delay is captured as raw source text because it may be a numeric literal
 * with digit separators or, once the budgets share one value, an identifier.
 */
const REJECTION_TIMER =
  /setTimeout\(\s*\(\)\s*=>\s*reject\(\s*new Error\(\s*(`[^`]*`|"[^"]*"|'[^']*')\s*\)\s*\)\s*,\s*([A-Za-z0-9_]+)\s*\)/g;

/**
 * Only WebSocket turns are in scope. The same file has an unrelated 500 ms
 * deadline that races a client abort against an upstream cancellation, and that
 * one is a real assertion about promptness rather than a patience budget, so
 * widening this filter would break a test that is doing its job.
 */
const WEBSOCKET_MESSAGE = /websocket|web socket|\bws\b/i;

interface Budget {
  /** The message the rejection carries, used to name the site in failures. */
  readonly message: string;
  /** The delay expression exactly as it appears in the source. */
  readonly expression: string;
  /** 1-based line number of the deadline, for a failure a reader can navigate to. */
  readonly line: number;
}

async function readSource(): Promise<string> {
  return await Bun.file(new URL(`../${SOURCE_PATH}`, import.meta.url)).text();
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

function collectWebSocketBudgets(source: string): Budget[] {
  const budgets: Budget[] = [];
  for (const match of source.matchAll(REJECTION_TIMER)) {
    const message = match[1].slice(1, -1);
    if (!WEBSOCKET_MESSAGE.test(message)) continue;
    budgets.push({ message, expression: match[2], line: lineOf(source, match.index ?? 0) });
  }
  return budgets;
}

/**
 * Resolve a delay expression to milliseconds. A numeric literal resolves to
 * itself; anything else has to be a module-level `const NAME = <number>;` in the
 * same file, which is how a shared budget constant is expected to be written.
 * An identifier that cannot be resolved returns null so the caller can fail with
 * a message that says what it could not find, rather than silently passing.
 */
function resolveBudget(expression: string, source: string): number | null {
  const literal = Number(expression.replaceAll("_", ""));
  if (Number.isFinite(literal)) return literal;
  const declaration = new RegExp(`^const ${expression}\\s*=\\s*([0-9_]+)\\s*;`, "m").exec(source);
  if (!declaration) return null;
  return Number(declaration[1].replaceAll("_", ""));
}

/**
 * Split the file into one chunk per top-level `test(` in its describe block, so
 * a budget can be attributed to the test that owns it and that test's closing
 * line can be inspected for a timeout override.
 */
function testBlocks(source: string): Array<{ title: string; body: string }> {
  const blocks: Array<{ title: string; body: string }> = [];
  const starts = [...source.matchAll(/^ {2}test\(\s*("[^"]*"|`[^`]*`)/gm)];
  for (const [index, start] of starts.entries()) {
    const from = start.index ?? 0;
    const to = index + 1 < starts.length ? starts[index + 1].index ?? source.length : source.length;
    blocks.push({ title: start[1].slice(1, -1), body: source.slice(from, to) });
  }
  return blocks;
}

describe("server-auth websocket turn budgets", () => {
  test("every websocket rejection budget clears the five second floor", async () => {
    const source = await readSource();
    const budgets = collectWebSocketBudgets(source);

    // A regex that matched nothing would make every assertion below vacuous, so
    // the count of known sites is pinned first. Six is what the file carries:
    // two in the option auth matrix test and four more in the WebSocket tests.
    expect(budgets.length).toBeGreaterThanOrEqual(6);

    const tooTight = budgets
      .map(budget => ({ budget, resolved: resolveBudget(budget.expression, source) }))
      .filter(entry => entry.resolved === null || entry.resolved < MINIMUM_BUDGET_MS)
      .map(entry => `${SOURCE_PATH}:${entry.budget.line} "${entry.budget.message}" uses ${entry.budget.expression}`);

    expect(tooTight).toEqual([]);
  });

  test("websocket budgets are declared once rather than repeated as literals", async () => {
    const source = await readSource();
    const budgets = collectWebSocketBudgets(source);

    // Six copies of the same number is how four of them drifted out of step with
    // the other two in the first place: whoever lifted the matrix test had no way
    // to see the rest. One named constant makes the next lift reach every site.
    const distinct = new Set(budgets.map(budget => budget.expression));
    expect([...distinct]).toHaveLength(1);
    expect(Number.isFinite(Number([...distinct][0].replaceAll("_", "")))).toBe(false);
  });

  test("tests holding a websocket budget raise their own test timeout", async () => {
    const source = await readSource();
    const owning = testBlocks(source).filter(block => collectWebSocketBudgets(block.body).length > 0);

    expect(owning.length).toBeGreaterThanOrEqual(5);

    // The budget only buys patience inside the turn. Without a matching per-test
    // override, bun's default timeout fires first and the test fails for the very
    // reason the budget was widened to tolerate.
    const unguarded = owning
      .filter(block => {
        const override = /\}\s*,\s*\{[^}]*timeout:\s*([0-9_]+)[^}]*\}\s*\)\s*;/.exec(block.body);
        return !override || Number(override[1].replaceAll("_", "")) < MINIMUM_TEST_TIMEOUT_MS;
      })
      .map(block => `"${block.title}"`);

    expect(unguarded).toEqual([]);
  });
});
