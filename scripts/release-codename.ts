/**
 * Resolve one unused release codename from the public dim-sum catalog.
 *
 * Consumer repositories are not an image authority. The catalog record and the
 * downloadable photo both come from Ding-Ding-Projects/dim-sum-photos, and the
 * photo stays there: opencodex links it instead of attaching another copy.
 * Network or catalog failure is deliberately non-fatal. A build number and SHA
 * still identify the release truthfully when no verified dish can be resolved.
 */

import { basename } from "node:path";

export const PUBLIC_CATALOG_URL =
  "https://raw.githubusercontent.com/Ding-Ding-Projects/dim-sum-photos/main/catalog/index.json";
export const PUBLIC_PHOTO_REPOSITORY = "Ding-Ding-Projects/dim-sum-photos";
export const PUBLIC_CATALOG_RELEASES = ["catalog-v1-part-003", "catalog-v1-part-002", "catalog-v1"] as const;

const MAX_CATALOG_BYTES = 12 * 1024 * 1024;
const MAX_DISHES = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

export interface PublicCatalogDish {
  id: string;
  slug: string;
  name: { en: string; zhHant: string };
  jyutping?: string;
  image: { path: string; alt?: { en?: string; yue?: string } };
}

interface PublicCatalog {
  schemaVersion: string | number;
  dishes: PublicCatalogDish[];
}

interface GitHubRelease {
  name?: string | null;
  body?: string | null;
  assets?: Array<{ name?: string | null }>;
}

export interface ResolvedCodename {
  dish: PublicCatalogDish;
  releaseTag: string;
  photoUrl: string;
}

function stableHash(value: string): number {
  let result = 0x811c9dc5;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

export function validateDish(value: unknown): PublicCatalogDish | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PublicCatalogDish>;
  const id = boundedText(candidate.id, 80);
  const slug = boundedText(candidate.slug, 180);
  const en = boundedText(candidate.name?.en, 180);
  const zhHant = boundedText(candidate.name?.zhHant, 180);
  const imagePath = boundedText(candidate.image?.path, 260);
  const jyutping = candidate.jyutping == null ? undefined : boundedText(candidate.jyutping, 180) ?? undefined;
  if (!id || !slug || !en || !zhHant || !imagePath) return null;
  if (!/^hk-dish-\d{4}$/.test(id) || !/^images\/[a-z0-9][a-z0-9.-]*\.png$/i.test(imagePath)) return null;
  return { id, slug, name: { en, zhHant }, jyutping, image: { path: imagePath, alt: candidate.image?.alt } };
}

export function publicAssetName(dish: PublicCatalogDish): string {
  return basename(dish.image.path);
}

export function publicPhotoUrl(releaseTag: string, dish: PublicCatalogDish): string {
  return `https://github.com/${PUBLIC_PHOTO_REPOSITORY}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(publicAssetName(dish))}`;
}

export function releaseMentionsDish(releaseText: string, dish: PublicCatalogDish): boolean {
  const text = releaseText.normalize("NFKC").toLocaleLowerCase("en-US");
  const english = dish.name.en.normalize("NFKC").toLocaleLowerCase("en-US");
  const chinese = dish.name.zhHant.normalize("NFKC").toLocaleLowerCase("en-US");
  return text.includes(publicAssetName(dish).toLocaleLowerCase("en-US"))
    || text.includes(dish.id.toLocaleLowerCase("en-US"))
    || (text.includes(english) && text.includes(chinese));
}

export async function selectUnusedPublishedDish(
  sha: string,
  dishes: PublicCatalogDish[],
  priorReleaseText: string,
  findPublishedTag: (dish: PublicCatalogDish) => Promise<string | null>,
): Promise<ResolvedCodename | null> {
  if (dishes.length === 0) return null;
  const start = stableHash(sha) % dishes.length;
  for (let offset = 0; offset < dishes.length; offset += 1) {
    const dish = dishes[(start + offset) % dishes.length];
    if (releaseMentionsDish(priorReleaseText, dish)) continue;
    const releaseTag = await findPublishedTag(dish);
    if (releaseTag) return { dish, releaseTag, photoUrl: publicPhotoUrl(releaseTag, dish) };
  }
  return null;
}

async function fetchBoundedJson(url: string, headers: HeadersInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "opencodex-release-codename", ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_CATALOG_BYTES) throw new Error(`response exceeds ${MAX_CATALOG_BYTES} bytes`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) throw new Error(`response exceeds ${MAX_CATALOG_BYTES} bytes`);
  return JSON.parse(text) as unknown;
}

async function loadCatalog(): Promise<PublicCatalogDish[]> {
  const raw = await fetchBoundedJson(PUBLIC_CATALOG_URL) as Partial<PublicCatalog>;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.dishes) || raw.dishes.length > MAX_DISHES) {
    throw new Error("public catalog has an invalid or unbounded dishes collection");
  }
  const dishes = raw.dishes.map(validateDish).filter((dish): dish is PublicCatalogDish => dish !== null);
  if (dishes.length !== raw.dishes.length) throw new Error("public catalog contains an invalid dish record");
  return dishes;
}

async function loadPriorReleaseText(repository: string, token?: string): Promise<string> {
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  const chunks: string[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const raw = await fetchBoundedJson(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      headers,
    );
    if (!Array.isArray(raw)) throw new Error("GitHub releases response is not an array");
    const releases = raw as GitHubRelease[];
    for (const release of releases) {
      chunks.push(release.name ?? "", release.body ?? "", ...(release.assets ?? []).map(asset => asset.name ?? ""));
    }
    if (releases.length < 100) break;
  }
  return chunks.join("\n");
}

async function findPublishedTag(dish: PublicCatalogDish): Promise<string | null> {
  for (const tag of PUBLIC_CATALOG_RELEASES) {
    const response = await fetch(publicPhotoUrl(tag, dish), {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": "opencodex-release-codename" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 200 && response.status < 400) return tag;
    if (response.status !== 404) throw new Error(`public photo probe returned HTTP ${response.status}`);
  }
  return null;
}

function emitEnvironment(resolved: ResolvedCodename | null): void {
  const values: Record<string, string> = resolved ? {
    DISH_AVAILABLE: "true",
    DISH_ID: resolved.dish.id,
    DISH_NAME: resolved.dish.name.en,
    DISH_ZH: resolved.dish.name.zhHant,
    DISH_JYUTPING: resolved.dish.jyutping ?? "",
    DISH_PHOTO: resolved.photoUrl,
    DISH_RELEASE_TAG: resolved.releaseTag,
  } : {
    DISH_AVAILABLE: "false",
    DISH_ID: "",
    DISH_NAME: "",
    DISH_ZH: "",
    DISH_JYUTPING: "",
    DISH_PHOTO: "",
    DISH_RELEASE_TAG: "",
  };
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${key} contains a line break`);
  }
  console.log(Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"));
}

/** `bun scripts/release-codename.ts <sha> [owner/repo]` prints GITHUB_ENV lines. */
if (import.meta.main) {
  const sha = process.argv[2];
  const repository = process.argv[3] ?? "Ding-Ding-Projects/opencodex";
  if (!sha) {
    console.error("usage: bun scripts/release-codename.ts <sha> [owner/repo]");
    process.exit(2);
  }
  try {
    const [dishes, priorReleaseText] = await Promise.all([
      loadCatalog(),
      loadPriorReleaseText(repository, process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
    ]);
    const resolved = await selectUnusedPublishedDish(sha, dishes, priorReleaseText, findPublishedTag);
    if (!resolved) console.error("::warning::No unused published public dim-sum photo was available; releasing without a codename.");
    emitEnvironment(resolved);
  } catch (error) {
    console.error(`::warning::Public dim-sum codename unavailable; releasing without one: ${error instanceof Error ? error.message : String(error)}`);
    emitEnvironment(null);
  }
}
