/**
 * Build identity.
 *
 * The version sat at 2.7.42 across a dozen installers because the semantic
 * version only moves when someone cuts an npm release. Every case here is about
 * a specific way "which build am I running" could go back to being unanswerable
 * — or worse, answerable with a wrong answer.
 */

import { describe, expect, test } from "bun:test";

import type { DimSumDish } from "../src/shell/dimsum";
import { codenameLabel, fullBuildLabel, readBuildInfo, shortBuildLabel, windowTitle } from "../src/shell/build-info";

const SHA = "e13e261c1f2a3b4c5d6e7f8091a2b3c4d5e6f708";
const PUBLIC_DISH: DimSumDish = {
  id: "hk-dish-0001",
  name: "Classic Har Gow",
  zh: "蝦餃",
  jyutping: "haa1 gaau2",
  emoji: "🥟",
};
const releasedInfo = (build = "34", sha = SHA) => readBuildInfo("2.7.42", build, sha, PUBLIC_DISH);

describe("what a released build reports", () => {
  test("carries the run number and the commit it was built from", () => {
    const info = releasedInfo();
    expect(info.released).toBe(true);
    expect(info.build).toBe("34");
    expect(info.shortCommit).toBe("e13e261c1");
  });

  test("carries the exact public-catalog dish selected by the release", () => {
    const info = releasedInfo();
    expect(info.dish).toEqual(PUBLIC_DISH);
    expect(info.dish?.id).toBe("hk-dish-0001");
  });

  test("admits when the public catalog supplied no codename", () => {
    expect(readBuildInfo("2.7.42", "34", SHA, null).dish).toBeNull();
  });

  test("the label distinguishes two builds of the same version", () => {
    // The whole point. Same semantic version, different builds, different text.
    const a = shortBuildLabel(releasedInfo());
    const b = shortBuildLabel(releasedInfo("35", "0db1c763bae4cc0c03ba616d3db3da34e6b81e98"));
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
      shortBuildLabel(releasedInfo()),
      fullBuildLabel(readBuildInfo("2.7.42", "dev", "")),
    ]) {
      expect(label.endsWith("·")).toBe(false);
      expect(label.includes("· ·")).toBe(false);
      expect(label.trim()).toBe(label);
    }
  });

  test("the port appears only when there is one", () => {
    const info = releasedInfo();
    expect(shortBuildLabel(info, 10100)).toContain(":10100");
    expect(shortBuildLabel(info, null)).not.toContain(":");
  });

  test("the full label carries the English dish name and the commit", () => {
    const info = releasedInfo();
    expect(fullBuildLabel(info)).toContain(info.dish!.name);
    expect(fullBuildLabel(info)).toContain(info.shortCommit);
  });

  test("the short label does not repeat the code name", () => {
    // The dish has its own element in the app bar now. Leaving it here as well
    // printed it twice on one row — and the row is the one that has to fit a
    // page title, a cost meter and four window buttons beside it.
    const info = releasedInfo();
    expect(shortBuildLabel(info)).not.toContain(info.dish!.zh);
  });
});

describe("the code name", () => {
  test("names the release in both languages", () => {
    const info = releasedInfo();
    const name = codenameLabel(info);
    expect(name).toEqual({ zh: info.dish!.zh, name: info.dish!.name });
  });

  test("a local build has none, rather than borrowing one", () => {
    // A code name identifies a published build. Putting one on a local build
    // means two different things answer to the same name, which is the one job
    // a code name has to get right.
    expect(codenameLabel(readBuildInfo("2.7.42", "dev", ""))).toBeNull();
  });
});

describe("the OS window title", () => {
  test("carries the code name, because the taskbar is where builds sit side by side", () => {
    const info = releasedInfo();
    const title = windowTitle(info);
    expect(title).toContain("opencodex");
    expect(title).toContain(info.dish!.zh);
    expect(title).toContain(info.dish!.name);
    expect(title).toContain("build 34");
  });

  test("two builds of one version get two different window titles", () => {
    // The failure this replaces: every build ever shipped showed the same
    // `opencodex · proxy dashboard` in Alt+Tab, so the one place Windows shows
    // two running builds together could not tell them apart.
    const a = windowTitle(releasedInfo());
    const b = windowTitle(releasedInfo("35", "0db1c763bae4cc0c03ba616d3db3da34e6b81e98"));
    expect(a).not.toBe(b);
  });

  test("a local build says so instead of claiming a build number or a dish", () => {
    const title = windowTitle(readBuildInfo("2.7.42", "dev", ""));
    expect(title).toBe("opencodex · v2.7.42 local build");
  });
});
