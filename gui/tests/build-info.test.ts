/**
 * Build identity.
 *
 * The version sat at 2.7.42 across a dozen installers because the semantic
 * version only moves when someone cuts an npm release. Every case here is about
 * a specific way "which build am I running" could go back to being unanswerable
 * — or worse, answerable with a wrong answer.
 */

import { describe, expect, test } from "bun:test";

import { codenameFor, DISHES } from "../src/shell/dimsum";
import { fullBuildLabel, readBuildInfo, shortBuildLabel } from "../src/shell/build-info";

const SHA = "e13e261c1f2a3b4c5d6e7f8091a2b3c4d5e6f708";

describe("what a released build reports", () => {
  test("carries the run number and the commit it was built from", () => {
    const info = readBuildInfo("2.7.42", "34", SHA);
    expect(info.released).toBe(true);
    expect(info.build).toBe("34");
    expect(info.shortCommit).toBe("e13e261c1");
  });

  test("names the same dish the release title does", () => {
    // The release runs `codenameFor` over the commit to title the build; this
    // runs the same function over the same commit. A second source of truth —
    // an env var carrying the dish name — would agree right up until one of the
    // two was set wrong, and a build displaying a different dish from its own
    // release is worse than displaying none.
    const info = readBuildInfo("2.7.42", "34", SHA);
    expect(info.dish?.id).toBe(codenameFor(SHA).id);
    expect(DISHES.some(d => d.id === info.dish?.id)).toBe(true);
  });

  test("the label distinguishes two builds of the same version", () => {
    // The whole point. Same semantic version, different builds, different text.
    const a = shortBuildLabel(readBuildInfo("2.7.42", "34", SHA));
    const b = shortBuildLabel(readBuildInfo("2.7.42", "35", "0db1c763bae4cc0c03ba616d3db3da34e6b81e98"));
    expect(a).not.toBe(b);
    expect(a).toContain("2.7.42");
    expect(b).toContain("2.7.42");
  });
});

describe("what a local build reports", () => {
  test("admits it is not a release rather than inventing a number", () => {
    const info = readBuildInfo("2.7.42", "dev", "");
    expect(info.released).toBe(false);
    expect(info.dish).toBeNull();
    expect(fullBuildLabel(info)).toContain("local build");
    // No run number, so none is shown — not "build dev".
    expect(shortBuildLabel(info)).toBe("v2.7.42");
  });

  test("an empty build string is treated as local, not as a release named ''", () => {
    expect(readBuildInfo("2.7.42", "", "").released).toBe(false);
  });
});

describe("the label itself", () => {
  test("omits what it does not know instead of leaving a dangling separator", () => {
    // A label ending in " · " reads as a rendering bug, and it is one.
    for (const label of [
      shortBuildLabel(readBuildInfo("2.7.42", "dev", "")),
      shortBuildLabel(readBuildInfo("2.7.42", "34", SHA)),
      fullBuildLabel(readBuildInfo("2.7.42", "dev", "")),
    ]) {
      expect(label.endsWith("·")).toBe(false);
      expect(label.includes("· ·")).toBe(false);
      expect(label.trim()).toBe(label);
    }
  });

  test("the port appears only when there is one", () => {
    const info = readBuildInfo("2.7.42", "34", SHA);
    expect(shortBuildLabel(info, 10100)).toContain(":10100");
    expect(shortBuildLabel(info, null)).not.toContain(":");
  });

  test("the full label carries the English dish name the short one drops", () => {
    // The app bar is one row shared with a title, a cost meter and the window
    // controls, so the short form uses the Chinese name alone. The full name
    // has to survive somewhere, or the hover says nothing the line did not.
    const info = readBuildInfo("2.7.42", "34", SHA);
    expect(fullBuildLabel(info)).toContain(info.dish!.name);
    expect(fullBuildLabel(info)).toContain(info.shortCommit);
  });
});
