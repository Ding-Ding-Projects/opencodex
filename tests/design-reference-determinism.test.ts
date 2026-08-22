import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertSinglePageTarget } from "../scripts/design-reference-capture";

const ROOT = join(import.meta.dir, "..");
const shell = join(ROOT, "design", "shell", "main.mjs");
const capture = join(ROOT, "scripts", "design-reference-capture.ts");
const fetcher = join(ROOT, "scripts", "fetch-design-reference-assets.ts");

async function source(path: string) { return readFile(path, "utf8"); }

test("DP-DET-006 shell owns an exact deterministic route and receipt", async () => {
  const text = await source(shell);
  expect(text).toContain("resolveCaptureRoute");
  expect(text).toContain("screen");
  expect(text).toContain("state");
  expect(text).toContain("theme");
  expect(text).toContain("viewport");
  expect(text).toContain("scale");
  expect(text).toContain("locale");
  expect(text).toContain("writeCaptureReceipt");
  expect(text).toContain("fixtureRevision");
  expect(text).toContain("sourceCommit");
});

test("DP-DET-006 blocks ambient network and external runtime/font assets", async () => {
  const text = await source(shell);
  expect(text).toContain("onBeforeRequest");
  expect(text).toContain("allowAmbientNetwork: false");
  expect(text).toContain("REMOTE_ASSET_REDIRECTS");
  expect(text).toContain("vendor");
});

test("DP-DET-006 preload freezes time, random, locale, timers, and motion", async () => {
  const text = await source(join(ROOT, "design", "shell", "preload.mjs"));
  expect(text).toContain("FIXED_TIME_MS");
  expect(text).toContain("Math.random");
  expect(text).toContain("Date.now");
  expect(text).toContain("Intl.DateTimeFormat");
  expect(text).toContain("setTimeout");
  expect(text).toContain("requestAnimationFrame");
  expect(text).toContain("prefers-reduced-motion");
});

test("DP-DET-006 CDP validator requires exactly one page target", async () => {
  const text = await source(capture);
  expect(text).toContain("targets.length !== 1");
  expect(text).toContain('target.type !== "page"');
  expect(text).toContain("normalizeUrl");
  expect(text).toContain("webSocketDebuggerUrl");
  expect(text).not.toContain("targets.find(");
  expect(text).not.toContain("targets.filter(");
});

test("DP-DET-006 vendor fetcher records every exact source and SHA-256", async () => {
  const text = await source(fetcher);
  expect(text).toContain("User-Agent");
  expect(text).toContain("font-weight");
  expect(text).toContain("unicode-range");
  expect(text).toContain("sha256");
  expect(text).toContain("all returned");
  expect(text).toContain("REACT_URL");
  expect(text).toContain("GOOGLE_FONTS_CSS_URL");
});

test("DP-DET-006 generated vendor manifest covers every local runtime/font asset", async () => {
  const manifest = JSON.parse(await source(join(ROOT, "design", "shell", "vendor", "manifest.json")));
  expect(manifest.version).toBe(1);
  expect(manifest.assets.length).toBeGreaterThan(3);
  const css = await source(join(ROOT, "design", "shell", "vendor", "fonts.css"));
  expect(css).not.toContain("https://");
  expect((css.match(/@font-face/g) || []).length).toBeGreaterThan(100);
  expect(css).toContain("font-weight");
  expect(css).toContain("unicode-range");
  for (const asset of manifest.assets) {
    expect(asset.sourceUrl).toMatch(/^https:\/\//);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    const bytes = await readFile(join(ROOT, "design", "shell", "vendor", asset.localPath));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    expect((await stat(join(ROOT, "design", "shell", "vendor", asset.localPath))).isFile()).toBe(true);
  }
}, 30000);

test("DP-DET-006 target isolation rejects every non-single-page shape", () => {
  const expected = "http://127.0.0.1:9333/OpenCodex%20M3.dc.html?screen=dashboard&state=overview";
  expect(() => assertSinglePageTarget([], expected)).toThrow("CDP_TARGET_COUNT_NOT_ONE");
  expect(() => assertSinglePageTarget([{ type: "service_worker", url: expected, webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/one" }], expected)).toThrow("CDP_TARGET_NOT_PAGE");
  expect(() => assertSinglePageTarget([{ type: "page", url: expected + "-other", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/one" }], expected)).toThrow("CDP_TARGET_URL_MISMATCH");
  expect(assertSinglePageTarget([{ type: "page", url: expected, webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/one" }], expected).type).toBe("page");
});
