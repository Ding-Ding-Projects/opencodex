import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeBuildIdentity,
  packageRootExists,
  readCliBuildStamp,
  readPackageIdentity,
  resolvedEntryPath,
} from "../src/lib/build-identity";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ocx-build-identity-"));
}

describe("build identity", () => {
  test("readPackageIdentity reads the real package.json name and version", () => {
    const dir = tempRoot();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: "9.9.9" }));
      expect(readPackageIdentity(dir)).toEqual({ name: "@bitkyc08/opencodex", version: "9.9.9" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readPackageIdentity fails closed to 'unknown' rather than throwing or guessing", () => {
    const dir = tempRoot();
    try {
      // No package.json written at all.
      expect(readPackageIdentity(dir)).toEqual({ name: "unknown", version: "unknown" });
      writeFileSync(join(dir, "package.json"), "{not valid json");
      expect(readPackageIdentity(dir)).toEqual({ name: "unknown", version: "unknown" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readCliBuildStamp says 'dev' honestly when build-info.json is absent", () => {
    const dir = tempRoot();
    try {
      expect(readCliBuildStamp(dir)).toEqual({ build: "dev", commit: "", shortCommit: "", released: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readCliBuildStamp reports the release identity CI actually stamped", () => {
    const dir = tempRoot();
    try {
      writeFileSync(
        join(dir, "build-info.json"),
        JSON.stringify({ build: "482", commit: "abcdef0123456789abcdef0123456789abcdef01" }),
      );
      expect(readCliBuildStamp(dir)).toEqual({
        build: "482",
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        shortCommit: "abcdef012",
        released: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readCliBuildStamp never invents a build number from a malformed file", () => {
    const dir = tempRoot();
    try {
      writeFileSync(join(dir, "build-info.json"), "{not valid json");
      expect(readCliBuildStamp(dir)).toEqual({ build: "dev", commit: "", shortCommit: "", released: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packageRootExists reflects the real filesystem, not an assumption", () => {
    const dir = tempRoot();
    try {
      expect(packageRootExists(dir)).toBe(true);
      expect(packageRootExists(join(dir, "does-not-exist"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolvedEntryPath reports the actual argv[1], not a guess", () => {
    expect(resolvedEntryPath(["node", "/some/script.ts", "--flag"])).toBe("/some/script.ts");
    expect(resolvedEntryPath(["node"])).toBe("unknown");
    expect(resolvedEntryPath()).toBe(process.argv[1]);
  });

  test("describeBuildIdentity composes name, version and dev/build status into one line", () => {
    const dir = tempRoot();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: "1.2.3" }));
      expect(describeBuildIdentity(dir)).toBe("@bitkyc08/opencodex@1.2.3 · local build");

      writeFileSync(join(dir, "build-info.json"), JSON.stringify({ build: "17", commit: "deadbeefcafefeed12345678901234567890abcd" }));
      expect(describeBuildIdentity(dir)).toBe("@bitkyc08/opencodex@1.2.3 · build 17 · deadbeefc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("this repo's own package identity is the fork, not upstream", async () => {
    const identity = readPackageIdentity();
    expect(identity.name).toBe("@bitkyc08/opencodex");
  });
});
