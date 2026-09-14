"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  assessPrDescription,
  collectPrQualityFailures,
} = require("./pr-quality.cjs");

describe("assessPrDescription", () => {
  it("rejects empty and comment-only bodies", () => {
    assert.equal(assessPrDescription("").ok, false);
    assert.equal(assessPrDescription("   ").ok, false);
    assert.equal(
      assessPrDescription("<!-- release notes by coderabbit.ai -->\n\n<!-- end -->").reason,
      "empty",
    );
  });

  it("rejects placeholder-only bodies", () => {
    assert.equal(assessPrDescription("N/A").reason, "placeholder");
    assert.equal(assessPrDescription("TODO").reason, "placeholder");
  });

  it("rejects literal escaped newlines like #644", () => {
    const body =
      "## What changed\\n- make the Windows tray launcher resolve Codex home\\n\\n## Validation\\n- git diff --check";
    assert.equal(assessPrDescription(body).reason, "escaped_newlines");
  });

  it("rejects thin real-newline bodies", () => {
    assert.equal(assessPrDescription("fix stuff").reason, "thin");
  });

  it("rejects an untouched GitHub PR template as empty/thin", () => {
    const body = [
      "## Summary",
      "",
      "- Explain the user-visible or maintainer-facing change.",
      "",
      "## Verification",
      "",
      "- List the commands or checks you ran.",
      "",
      "## Checklist",
      "",
      "- [ ] Scope stays focused and avoids unrelated cleanup.",
      "- [ ] Docs or release notes were updated when needed.",
      "- [ ] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.",
    ].join("\n");
    const result = assessPrDescription(body);
    assert.equal(result.ok, false);
    assert.ok(result.reason === "empty" || result.reason === "thin");
  });

  it("accepts two rich markdown sections", () => {
    const body = [
      "## Summary",
      "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
      "",
      "## Test plan",
      "- Launch the tray app after setting CODEX_HOME",
      "- Confirm the listener and launcher use the same workspace root",
    ].join("\n");
    assert.equal(assessPrDescription(body).ok, true);
  });

  it("accepts unstructured bodies that are long enough with multiple blocks", () => {
    const p1 =
      "Updates the Windows tray launcher to resolve the active Codex home through the shared helper so listener and launcher stay aligned.";
    const p2 =
      "Validated with git diff --check on the changed tray module; typecheck was not available in that session so CI must cover it.";
    assert.equal(assessPrDescription(`${p1}\n\n${p2}`).ok, true);
  });
});

describe("collectPrQualityFailures", () => {
  // main is now the only allowed base: there is no separate integration
  // branch to skip ancestry checks for, and no ancestry check at all.
  // A rewrite onto an unrelated tip is caught by ordinary review, not by
  // this gate. These scenarios exercise the allow-list and the description
  // check as the two remaining, independent failure sources.
  const allowed = ["main"];
  const richBody = [
    "## Summary",
    "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
    "",
    "## Test plan",
    "- Launch the tray app after setting CODEX_HOME",
    "- Confirm the listener and launcher use the same workspace root",
  ].join("\n");

  it("reports wrong_base for a PR that does not target the allowed base", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: richBody,
    });
    assert.deepEqual(
      failures.map((f) => f.code),
      ["wrong_base"],
    );
  });

  it("reports wrong_base and bad_description together for an empty body on the wrong base", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: "",
    });
    assert.ok(failures.some((f) => f.code === "wrong_base"));
    assert.ok(failures.some((f) => f.code === "bad_description"));
  });

  it("reports nothing for the allowed base with a rich description", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: richBody,
    });
    assert.deepEqual(failures, []);
  });

  it("reports only bad_description when the base is already correct", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: "fix stuff",
    });
    assert.deepEqual(
      failures.map((f) => f.code),
      ["bad_description"],
    );
  });

  it("evaluates allowedBases generically rather than a hardcoded list", () => {
    // Nothing in collectPrQualityFailures may hardcode "main": passing a
    // different allow-list must change which base is accepted.
    const failures = collectPrQualityFailures({
      baseRef: "trunk",
      allowedBases: ["trunk"],
      body: richBody,
    });
    assert.deepEqual(failures, []);
  });
});
