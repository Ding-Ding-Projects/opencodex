import { describe, expect, test } from "bun:test";
import { adapterFailureFromMessage, httpStatusFromTerminalError } from "../src/lib/errors";

// COR-02: adapterFailureFromMessage returns an httpStatus that disagrees with its own
// classified error.type/code for quota-exhaustion text, contradicting the mapping the
// SAME module enforces one function away.
//
// src/lib/errors.ts:341-365 computes `httpStatus` from
// `inferHttpStatusFromAdapterMessage(message)` (errors.ts:295-338) BEFORE calling
// `classifyError`. `inferHttpStatusFromAdapterMessage` has no branch for "quota"
// wording at all (its 429 branch only checks resource_exhausted / rate limit / too
// many requests / throttling, see errors.ts:304-310), so a genuine
// "exceeded your current quota" message falls through every branch and lands on the
// generic `return 502;` at the end. `classifyError`, called right after with that same
// message text, independently matches the "exceeded your current quota" phrase
// (errors.ts:171-180) and returns `type: "insufficient_quota", code:
// "insufficient_quota"` regardless of the httpStatus it was handed. The function
// returns both together, so the result pairs `httpStatus: 502` with an
// `insufficient_quota` error.
//
// That pairing is self-contradictory: this exact module's own
// `httpStatusFromTerminalError` (errors.ts:368-395) says
// `if (error.type === "insufficient_quota" || error.code === "insufficient_quota")
// return 429;`, so feeding adapterFailureFromMessage's own `.error` back into
// httpStatusFromTerminalError yields 429, not the 502 adapterFailureFromMessage
// itself returned. A caller that trusts `httpStatus` (bridge.ts's
// adapterFailureFromEvent forwards it verbatim as the actual HTTP response status,
// and it is what /api/logs records) reports a client's exhausted quota as a generic
// upstream server error, bypassing every quota-specific downstream behavior keyed on
// 429 (e.g. resolveClientRetryAfter's explicit "quota-exhausted 429s get no default"
// rule in src/lib/retry-after.ts never even gets a chance to apply, since nothing
// downstream sees a 429 in the first place).
describe("hunt-correct-COR-02: adapterFailureFromMessage disagrees with itself on quota-exhaustion status", () => {
  test("httpStatus for an insufficient_quota message must match the module's own insufficient_quota -> 429 rule", () => {
    const message = "You have exceeded your current quota, please check your plan and billing details.";

    const result = adapterFailureFromMessage(message);

    expect(result.error.type).toBe("insufficient_quota");
    expect(result.error.code).toBe("insufficient_quota");

    // The module's own round-trip for this exact error payload.
    expect(httpStatusFromTerminalError(result.error)).toBe(429);

    // adapterFailureFromMessage must not hand back an httpStatus its own sibling
    // function would immediately disagree with.
    expect(result.httpStatus).toBe(429);
  });
});
