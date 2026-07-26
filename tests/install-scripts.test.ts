import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeArtifactNames,
  prepareNativePackage,
  validateNativeDirectory,
  verifyPackReport,
} from "../scripts/prepare-package";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default. Same remedy as
// codex-history-provider / cursor-mcp-stdio.
setDefaultTimeout(30_000);

const root = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(root);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

const MIB = 1024 * 1024;
const nativeVersion = "2.7.35";

function digest(bytes: Uint8Array | string, algorithm: "sha1" | "sha256" | "sha512", encoding: "base64" | "hex"): string {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function sha256(bytes: Uint8Array): string {
  return digest(bytes, "sha256", "hex");
}

function writeNativeFixture(
  nativePath: string,
  version = nativeVersion,
  sizes: Partial<Record<string, number>> = {},
): void {
  mkdirSync(nativePath, { recursive: true });
  const rows: string[] = [];
  for (const name of nativeArtifactNames(version)) {
    const bytes = new Uint8Array(sizes[name] ?? 32);
    bytes.fill(name.length);
    writeFileSync(join(nativePath, name), bytes, { mode: 0o755 });
    chmodSync(join(nativePath, name), 0o755);
    rows.push(`${sha256(bytes)}  ${name}`);
  }
  const manifest = join(nativePath, `ocx_${version}_checksums.txt`);
  writeFileSync(manifest, `${rows.join("\n")}\n`, { mode: 0o644 });
  chmodSync(manifest, 0o644);
}

function packReport(packageRoot: string, unpackedSize: number) {
  const nativePath = join(packageRoot, "bin", "native");
  const nativeFiles = nativeArtifactNames(nativeVersion).map((name) => ({
    path: `bin/native/${name}`,
    size: Bun.file(join(nativePath, name)).size,
    mode: 0o755,
  }));
  const manifestName = `ocx_${nativeVersion}_checksums.txt`;
  const filename = `bitkyc08-opencodex-${nativeVersion}.tgz`;
  const archive = "archive";
  writeFileSync(join(packageRoot, filename), archive);
  return [{
    filename,
    shasum: digest(archive, "sha1", "hex"),
    integrity: `sha512-${digest(archive, "sha512", "base64")}`,
    size: Buffer.byteLength(archive),
    unpackedSize,
    files: [
      { path: "bin/ocx.mjs", size: Bun.file(join(packageRoot, "bin", "ocx.mjs")).size, mode: 0o755 },
      { path: "bin/native-runtime.mjs", size: Bun.file(join(packageRoot, "bin", "native-runtime.mjs")).size, mode: 0o644 },
      { path: "bin/package-main.mjs", size: Bun.file(join(packageRoot, "bin", "package-main.mjs")).size, mode: 0o644 },
      { path: "gui/dist/index.html", size: Bun.file(join(packageRoot, "gui", "dist", "index.html")).size, mode: 0o644 },
      ...nativeFiles,
      { path: `bin/native/${manifestName}`, size: Bun.file(join(nativePath, manifestName)).size, mode: 0o644 },
    ],
  }];
}

describe("install scripts", () => {
  test("npm package main is a Node-safe wrapper while Bun keeps the TypeScript API", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      main?: string;
      exports?: { "."?: { bun?: string; default?: string } };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.main).toBe("./bin/package-main.mjs");
    expect(pkg.exports?.["."]?.bun).toBe("./src/index.ts");
    expect(pkg.exports?.["."]?.default).toBe("./bin/package-main.mjs");
    expect(pkg.dependencies?.zod).toBe("4.4.3");
    expect(pkg.devDependencies?.typescript).toBe("5.9.3");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.3.14");
    expect(pkg.scripts?.dev).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:proxy"]).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:gui"]).toBe("cd gui && bun run dev");
    expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
    expect(pkg.scripts?.["prepare:native-package"]).toBe("bun scripts/prepare-package.ts --native");
    expect(pkg.scripts?.["verify:native-package"]).toBe("bun scripts/prepare-package.ts --verify-pack pack.json");
    expect(pkg.scripts?.["test:native-launcher"]).toBe("node --test scripts/ocx-native-launcher.test.mjs");
    expect(pkg.scripts?.["verify:native-install"]).toBe("node scripts/verify-native-install.mjs pack.json");
    expect(pkg.scripts?.["build:publish"]).toBe("bun run typecheck && bun run build:gui");
    expect(pkg.scripts?.prepack).toBe("bun run prepare:native-package && bun run prepare:package");
    expect(pkg.scripts?.prepublishOnly).toBe("bun scripts/prepare-package.ts --reject-source-publish");
    expect(pkg.files).toContain("assets/banner.png");
    expect(pkg.files).toContain("assets/architecture.png");
    expect(pkg.files).toContain("assets/claude-code-models.gif");
    expect(pkg.files).toContain("assets/codex-app-picker.png");

    const preparePackage = await readText("scripts/prepare-package.ts");
    expect(preparePackage).toContain('stdout: "pipe"');
    expect(preparePackage).toContain("process.stderr.write(build.stdout)");
  });

  test("direct source publish fails closed with the release-workflow recovery path", () => {
    const result = spawnSync("bun", ["scripts/prepare-package.ts", "--reject-source-publish"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("direct source publish is disabled");
    expect(result.stderr).toContain("use the release workflow");
  });

  test("Node can import the package main without executing the CLI", () => {
    const result = spawnSync("node", [
      "-e",
      "import('./bin/package-main.mjs').then(m => { if (m.cliCommand !== 'ocx') process.exit(2); })",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  test("npmignore keeps GUI development docs out of the package", async () => {
    const npmignore = await readText(".npmignore");
    const guiNpmignore = await readText("gui/.npmignore");
    const guiReadme = await readText("gui/README.md");

    expect(npmignore).toContain("gui/README.md");
    expect(guiNpmignore).toContain("README.md");
    expect(guiReadme).toContain("opencodex dashboard");
    expect(guiReadme).toContain("bun run dev:proxy");
    expect(guiReadme).toContain("bun run dev:gui");
    expect(guiReadme).not.toContain("This template provides a minimal setup");
  });

  test("POSIX installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.sh");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("npm install -g @bitkyc08/opencodex");
    expect(script).toContain("command -v ocx");
    expect(script).toContain("ocx help");
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install");
  });

  test("PowerShell installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("& $npm.Source install -g @bitkyc08/opencodex");
    expect(script).toContain("$LASTEXITCODE");
    expect(script).toContain("Get-Command ocx.cmd");
    expect(script).toContain("Get-Command ocx");
    expect(script).toContain("& $ocx.Source help");
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install.ps1");
  });

  test("Node launcher handles npm self-update before starting Bun", async () => {
    const launcher = await readText("bin/ocx.mjs");

    expect(launcher).toContain('process.argv[2] === "update"');
    expect(launcher).toContain('["install", "-g", `${PKG}@${tag}`]');
    expect(launcher).toContain('return String(currentVersion).includes("-preview.") ? "preview" : "latest"');
    expect(launcher).toContain("!isBunGlobalInstall()");
    expect(launcher).toContain("repairCodexShimIfNeeded()");
    expect(launcher).toContain("runNpmSelfUpdate()");
  });

  test("release helper watches the workflow run it just dispatched", async () => {
    const script = await readText("scripts/release.ts");

    expect(script).toContain("waitForReleaseWorkflowRun");
    expect(script).toContain("gh run list --workflow release.yml --branch");
    expect(script).toContain("--commit");
    expect(script).toContain("createdAt,databaseId,headSha,status,url");
    expect(script).toContain("await watchRun(releaseRun.databaseId)");
  });

  test("native directory rejects stale and malformed artifacts", () => {
    const temp = mkdtempSync(join(tmpdir(), "ocx-native-validation-"));
    const nativePath = join(temp, "native");
    try {
      writeNativeFixture(nativePath);
      writeFileSync(join(nativePath, "ocx_2.7.34_linux_amd64"), "stale");
      expect(() => validateNativeDirectory(nativePath, nativeVersion)).toThrow("inventory mismatch");
      rmSync(join(nativePath, "ocx_2.7.34_linux_amd64"));
      const malformedRows = Array.from({ length: 6 }, () => "not a manifest");
      writeFileSync(join(nativePath, `ocx_${nativeVersion}_checksums.txt`), `${malformedRows.join("\n")}\n`);
      expect(() => validateNativeDirectory(nativePath, nativeVersion)).toThrow("malformed native checksum row 1");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("failed native build removes disposable partial output", () => {
    const temp = mkdtempSync(join(tmpdir(), "ocx-native-build-failure-"));
    const nativePath = join(temp, "native");
    try {
      expect(() => prepareNativePackage(nativeVersion, nativePath, () => {
        mkdirSync(nativePath, { recursive: true });
        writeFileSync(join(nativePath, "partial"), "partial");
        throw new Error("injected build failure");
      })).toThrow("injected build failure");
      expect(existsSync(nativePath)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("native staging removes a stale prior version before build", () => {
    const temp = mkdtempSync(join(tmpdir(), "ocx-native-stale-"));
    const nativePath = join(temp, "native");
    try {
      mkdirSync(nativePath, { recursive: true });
      writeFileSync(join(nativePath, "ocx_2.7.34_linux_amd64"), "stale");
      prepareNativePackage(nativeVersion, nativePath, () => {
        expect(existsSync(join(nativePath, "ocx_2.7.34_linux_amd64"))).toBe(false);
        writeNativeFixture(nativePath);
      });
      validateNativeDirectory(nativePath, nativeVersion);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("checksum validation failure removes disposable output before packing", () => {
    const temp = mkdtempSync(join(tmpdir(), "ocx-native-checksum-"));
    const nativePath = join(temp, "native");
    try {
      expect(() => prepareNativePackage(nativeVersion, nativePath, () => {
        writeNativeFixture(nativePath);
        const binary = join(nativePath, nativeArtifactNames(nativeVersion)[0]);
        const bytes = new Uint8Array(Bun.file(binary).size);
        bytes.fill(0xff);
        writeFileSync(binary, bytes, { mode: 0o755 });
      })).toThrow("checksum mismatch");
      expect(existsSync(nativePath)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("pack report enforces exact files modes and size limits", () => {
    const temp = mkdtempSync(join(tmpdir(), "ocx-native-pack-"));
    const nativePath = join(temp, "bin", "native");
    const names = nativeArtifactNames(nativeVersion);
    try {
      mkdirSync(join(temp, "bin"), { recursive: true });
      writeFileSync(join(temp, "bin", "ocx.mjs"), "launcher", { mode: 0o755 });
      writeFileSync(join(temp, "bin", "native-runtime.mjs"), "runtime", { mode: 0o644 });
      writeFileSync(join(temp, "bin", "package-main.mjs"), "package", { mode: 0o644 });
      mkdirSync(join(temp, "gui", "dist"), { recursive: true });
      writeFileSync(join(temp, "gui", "dist", "index.html"), "gui", { mode: 0o644 });
      writeNativeFixture(nativePath, nativeVersion, {
        [names[0]]: 40 * MIB,
        [names[1]]: 1 * MIB,
        [names[2]]: 1 * MIB,
        [names[3]]: 1 * MIB,
        [names[4]]: 1 * MIB,
        [names[5]]: 1 * MIB,
      });
      const reportPath = join(temp, "pack.json");
      const exact = packReport(temp, 256 * MIB);
      writeFileSync(reportPath, JSON.stringify(exact));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).not.toThrow();

      const binaryTooLarge = structuredClone(exact);
      binaryTooLarge[0].files.find((file) => file.path === `bin/native/${names[0]}`)!.size = 40 * MIB + 1;
      writeFileSync(reportPath, JSON.stringify(binaryTooLarge));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("outside 1..40 MiB");

      const packedTooLarge = structuredClone(exact);
      packedTooLarge[0].size = 192 * MIB + 1;
      writeFileSync(reportPath, JSON.stringify(packedTooLarge));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("exceeds 192 MiB");

      const unpackedTooLarge = structuredClone(exact);
      unpackedTooLarge[0].unpackedSize = 256 * MIB + 1;
      writeFileSync(reportPath, JSON.stringify(unpackedTooLarge));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("exceeds 256 MiB");

      const negativePackedSize = structuredClone(exact);
      negativePackedSize[0].size = -1;
      writeFileSync(reportPath, JSON.stringify(negativePackedSize));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("missing filename, shasum, integrity, size");

      const fractionalFileSize = structuredClone(exact);
      fractionalFileSize[0].files[0].size += 0.5;
      writeFileSync(reportPath, JSON.stringify(fractionalFileSize));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("path, size, and integer mode");

      const wrongMode = structuredClone(exact);
      wrongMode[0].files.find((file) => file.path === `bin/native/${names[0]}`)!.mode = 0o644;
      writeFileSync(reportPath, JSON.stringify(wrongMode));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("mode must be 0755");

      const wrongManifestMode = structuredClone(exact);
      wrongManifestMode[0].files.find((file) => file.path.endsWith("_checksums.txt"))!.mode = 0o755;
      writeFileSync(reportPath, JSON.stringify(wrongManifestMode));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("manifest mode must be 0644");

      const wrongLauncherMode = structuredClone(exact);
      wrongLauncherMode[0].files.find((file) => file.path === "bin/ocx.mjs")!.mode = 0o644;
      writeFileSync(reportPath, JSON.stringify(wrongLauncherMode));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("required file mode mismatch");

      const archivePath = join(temp, exact[0].filename);
      writeFileSync(archivePath, "brchive");
      writeFileSync(reportPath, JSON.stringify(exact));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("tarball shasum mismatch");
      writeFileSync(archivePath, "archive");

      const wrongIntegrity = structuredClone(exact);
      wrongIntegrity[0].integrity = `sha512-${"A".repeat(88)}`;
      writeFileSync(reportPath, JSON.stringify(wrongIntegrity));
      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("tarball integrity mismatch");

      if (process.platform !== "win32") {
        const guiDist = join(temp, "gui", "dist");
        const outsideDist = join(temp, "outside-dist");
        rmSync(guiDist, { recursive: true });
        mkdirSync(outsideDist);
        writeFileSync(join(outsideDist, "index.html"), "gui", { mode: 0o644 });
        symlinkSync(outsideDist, guiDist, "dir");
        writeFileSync(reportPath, JSON.stringify(exact));
        expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("traverses symlink");
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
