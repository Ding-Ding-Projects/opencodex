import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);
const read = async (name: string) => Bun.file(new URL(name, root)).text();

const requiredFiles = [
  "build-dependencies.json",
  "download-dependencies.bat",
  "download-dependencies.sh",
  "build.bat",
  "build.sh",
  "build-installer.bat",
  "build-installer.sh",
  "docs/build-bootstrap.md",
] as const;

function validateManifest(value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("manifest must be an object");
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) throw new Error("unsupported manifest schema");
  if (manifest.project !== "opencodex") throw new Error("manifest project is missing");
  const toolchain = manifest.toolchain as Record<string, unknown> | undefined;
  if (!toolchain) throw new Error("toolchain inventory is missing");
  const bun = toolchain.bun as Record<string, unknown> | undefined;
  if (!bun || bun.version !== "1.3.14") throw new Error("Bun pin is missing");
  const node = toolchain.node as Record<string, unknown> | undefined;
  if (!node || node.minimumMajor !== 18) throw new Error("Node.js floor is missing");
  const electronBuilder = toolchain.electronBuilder as Record<string, unknown> | undefined;
  if (!electronBuilder || electronBuilder.version !== "26.15.3") {
    throw new Error("electron-builder pin is missing");
  }
  const workspaces = manifest.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length !== 2) {
    throw new Error("both workspace installs are required");
  }
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace !== "object") throw new Error("invalid workspace");
    if ((workspace as Record<string, unknown>).install !== "bun install --frozen-lockfile") {
      throw new Error("workspace install must be frozen");
    }
  }
}

describe("build bootstrap inventory", () => {
  test("keeps every bootstrap surface checked in", async () => {
    for (const name of requiredFiles) {
      expect(await Bun.file(new URL(name, root)).exists(), name).toBe(true);
    }
  });

  test("manifest is complete and its negative regression is real", async () => {
    const manifest = JSON.parse(await read("build-dependencies.json")) as Record<string, unknown>;
    expect(() => validateManifest(manifest)).not.toThrow();

    // Deliberately remove one asserted contract to prove this guard turns red,
    // then restore the in-memory copy and prove the valid contract is green again.
    const broken = structuredClone(manifest) as Record<string, unknown>;
    delete (broken.toolchain as Record<string, unknown>).bun;
    expect(() => validateManifest(broken)).toThrow("Bun pin is missing");
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  test("Windows scripts are rooted, silent-capable, and fail closed", async () => {
    const dependencyScript = await read("download-dependencies.bat");
    const buildScript = await read("build.bat");
    const installerScript = await read("build-installer.bat");
    for (const script of [dependencyScript, buildScript, installerScript]) {
      expect(script).toContain("%~dp0");
      expect(script).toContain("/s");
      expect(script).toContain("--silent");
      expect(script).toContain('"%SILENT%"=="1"');
      expect(script).not.toContain("git push");
      expect(script).not.toContain("npm publish");
      expect(script).not.toMatch(/signtool\s/i);
    }
    expect(dependencyScript).toContain("bun install --frozen-lockfile");
    expect(dependencyScript).toContain("Bun 1.3.14");
    expect(buildScript).toContain("bun run typecheck");
    expect(buildScript).toContain("bun run build:gui");
    expect(buildScript).toContain("gui\\dist\\index.html");
    expect(installerScript).toContain("electron-builder@26.15.3");
    expect(installerScript).toContain("--publish never");
    expect(installerScript).toContain("RELEASES");
    expect(installerScript).toContain("NotSigned");
    expect(installerScript).toContain("SHA256");
    expect(installerScript).toContain("Could not calculate the Setup.exe SHA-256");
    expect(installerScript).toContain("Could not calculate the full nupkg SHA-256");
  });

  test("shell scripts retain the supported platform boundary", async () => {
    const dependencyScript = await read("download-dependencies.sh");
    const buildScript = await read("build.sh");
    const installerScript = await read("build-installer.sh");
    expect(dependencyScript).toContain("bun-v1.3.14");
    expect(dependencyScript).toContain("bun install --frozen-lockfile");
    expect(buildScript).toContain("bun run build:gui");
    expect(installerScript).toContain("Windows-only");
    expect(installerScript).toContain("build-installer.bat");
  });
});
