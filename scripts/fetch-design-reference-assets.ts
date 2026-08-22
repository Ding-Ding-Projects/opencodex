/**
 * Fetch the exact design-reference runtime and font URLs into the committed
 * local vendor directory. Run with Bun. The generated manifest is the receipt
 * for every response; no runtime request is allowed to reach a CDN.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const REACT_URL = "https://unpkg.com/react@18.3.1/umd/react.production.min.js";
export const REACT_DOM_URL = "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js";
export const BABEL_URL = "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js";
export const GOOGLE_FONTS_CSS_URL = "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&family=Roboto+Flex:opsz,wght@8..144,100..1000&family=Roboto+Mono:wght@400;500&family=Noto+Sans+HK:wght@400;500;700&display=swap";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const ROOT = join(import.meta.dir, "..", "design", "shell", "vendor");
const manifestPath = join(ROOT, "manifest.json");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Asset = { kind: string; sourceUrl: string; localPath: string; sha256: string; bytes: number; contentType: string };

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } });
  if (!response.ok) throw new Error(`asset fetch failed ${response.status} ${response.statusText}: ${url}`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") || "application/octet-stream" };
}

async function atomic(path: string, bytes: Uint8Array | string) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

async function main() {
  await mkdir(ROOT, { recursive: true });
  const assets: Asset[] = [];
  for (const [kind, sourceUrl, localPath] of [
    ["runtime", REACT_URL, "runtime/react.production.min.js"],
    ["runtime", REACT_DOM_URL, "runtime/react-dom.production.min.js"],
    ["runtime", BABEL_URL, "runtime/babel.min.js"],
  ] as const) {
    const result = await fetchBytes(sourceUrl);
    const out = join(ROOT, localPath);
    await mkdir(dirname(out), { recursive: true });
    await atomic(out, result.bytes);
    assets.push({ kind, sourceUrl, localPath, sha256: sha256(result.bytes), bytes: result.bytes.byteLength, contentType: result.contentType });
  }

  const css = await fetchBytes(GOOGLE_FONTS_CSS_URL);
  const cssText = new TextDecoder().decode(css.bytes);
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of cssText.matchAll(/url\((['"]?)(https:\/\/[^)'\"]+)\1\)/g)) {
    const url = match[2];
    if (!seen.has(url)) { seen.add(url); urls.push(url); }
  }
  if (!urls.length || !cssText.includes("font-weight") || !cssText.includes("unicode-range")) {
    throw new Error("Google Fonts response did not contain every font-face declaration");
  }
  let localCss = cssText;
  for (const url of urls) {
    const result = await fetchBytes(url);
    const digest = sha256(result.bytes);
    const extension = url.split("?")[0].toLowerCase().endsWith(".woff") ? "woff" : "woff2";
    const localPath = `fonts/font-${digest.slice(0, 24)}.${extension}`;
    const out = join(ROOT, localPath);
    await mkdir(dirname(out), { recursive: true });
    await atomic(out, result.bytes);
    localCss = localCss.split(url).join(`./${localPath}`);
    assets.push({ kind: "font", sourceUrl: url, localPath, sha256: digest, bytes: result.bytes.byteLength, contentType: result.contentType });
  }
  const cssLocalPath = "fonts.css";
  await atomic(join(ROOT, cssLocalPath), localCss);
  assets.push({ kind: "font-css", sourceUrl: GOOGLE_FONTS_CSS_URL, localPath: cssLocalPath, sha256: sha256(new TextEncoder().encode(localCss)), bytes: localCss.length, contentType: "text/css; charset=utf-8" });

  const manifest = { version: 1, source: "design-reference", userAgent: USER_AGENT, assets };
  await atomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const runtimeCount = assets.reduce((count, asset) => count + (asset.kind === "runtime" ? 1 : 0), 0);
  const fontCount = assets.reduce((count, asset) => count + (asset.kind === "font" ? 1 : 0), 0);
  console.log(`Fetched all returned assets: ${assets.length} (${runtimeCount} runtime, ${fontCount} font files).`);
  console.log(`Manifest: ${manifestPath}`);
}

if (import.meta.main) await main();
