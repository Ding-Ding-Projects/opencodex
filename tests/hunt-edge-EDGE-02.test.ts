import { describe, expect, test } from "bun:test";
import { handleModelsRuntimeCommand } from "../src/cli/models-runtime";

/**
 * EDGE-02: `ocx models edit <id> --context-window <value>` in
 * `src/cli/models-runtime.ts` (the `edit` handler, around line 63):
 *
 *   if (contextRaw !== undefined) {
 *     const value = Number(contextRaw.replace(/[_,]/g, ""));
 *     if (!Number.isInteger(value) || value < 0) throw new CliUsageError(...);
 *     patch.contextWindow = value === 0 ? null : value;
 *   }
 *
 * `takeOption` happily returns an empty string as a "provided" flag value
 * (it only rejects a missing value or one that looks like another flag), so
 * `ocx models edit <id> --context-window ""` reaches this branch with
 * `contextRaw = ""`. `"".replace(/[_,]/g, "")` is still `""`, and
 * `Number("")` is `0` (not `NaN`) per the standard `Number()`-on-empty-string
 * coercion. `Number.isInteger(0)` is true and `0 < 0` is false, so the
 * validation the branch exists to perform is skipped entirely, and
 * `value === 0 ? null : value` then does exactly what a deliberate,
 * documented `--context-window 0` does: it PATCHes the model with
 * `contextWindow: null`, clearing any custom override.
 *
 * The CLI's own USAGE line documents `--context-window <tokens|0>` as the
 * only two accepted shapes; an empty string is neither, and every sibling
 * integer option in this file (`--context value`, `--compact-window`, the
 * shared `takeIntegerOption` helper) rejects an empty value with a
 * `CliUsageError`. This one silently succeeds with the opposite of "leave it
 * alone" the moment the value happens to be textually empty — exactly the
 * shape of bug an unset shell variable produces, e.g.
 * `ocx models edit gpt-x --context-window "$CONTEXT_TOKENS"` with
 * `$CONTEXT_TOKENS` unset, which a caller would reasonably expect to error
 * out rather than silently wipe the override.
 *
 * This is a finder-authored regression test (`hunt/edge-cases` lane). It does
 * not fix anything; it drives the real exported command handler with a fake
 * `fetchImpl` so no live proxy is needed, and inspects the exact outgoing
 * PATCH body plus the CLI's own exit code.
 */

describe("EDGE-02: ocx models edit --context-window \"\" (empty string)", () => {
  test("control: a non-numeric context-window value is rejected as a usage error", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const exitCode = await handleModelsRuntimeCommand(
      "edit",
      ["some-custom-id", "--context-window", "not-a-number"],
      { baseUrl: "http://127.0.0.1:1", fetchImpl },
    );

    expect(exitCode).toBe(2); // CliUsageError -> runCliAction's usage-error exit code
    expect(called).toBe(false); // never should have reached the network
  });

  test("an empty-string context-window value is NOT rejected: it silently clears the model", async () => {
    let sentBody: Record<string, unknown> | undefined;
    let sentUrl = "";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      sentUrl = String(url);
      sentBody = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const exitCode = await handleModelsRuntimeCommand(
      "edit",
      ["some-custom-id", "--context-window", ""],
      { baseUrl: "http://127.0.0.1:1", fetchImpl },
    );

    // An empty string is exactly as non-numeric as "not-a-number" above and
    // should fail the same way (exit code 2, no request sent). Instead the
    // handler treats "" as the documented "0" sentinel and actually issues
    // the clearing PATCH.
    expect(exitCode).toBe(2);
    expect(sentUrl).toBe("");
    expect(sentBody).toBeUndefined();
  });
});
