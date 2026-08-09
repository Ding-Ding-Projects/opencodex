import { YAML } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  PUBLIC_CATALOG_RELEASES,
  PUBLIC_PHOTO_REPOSITORY,
  publicAssetName,
  publicPhotoUrl,
  releaseMentionsDish,
  selectUnusedPublishedDish,
  validateDish,
  type PublicCatalogDish,
} from "../scripts/release-codename";

const DISHES: PublicCatalogDish[] = [
  {
    id: "hk-dish-0001",
    slug: "classic-har-gow",
    name: { en: "Classic Har Gow", zhHant: "蝦餃" },
    jyutping: "haa1 gaau2",
    image: { path: "images/hk-dish-0001-classic-har-gow.png" },
  },
  {
    id: "hk-dish-0002",
    slug: "scallop-har-gow",
    name: { en: "Scallop Har Gow", zhHant: "帶子蝦餃" },
    image: { path: "images/hk-dish-0002-scallop-har-gow.png" },
  },
];

describe("public catalog validation", () => {
  test("accepts bounded authoritative records", () => {
    expect(validateDish(DISHES[0])).toEqual(DISHES[0]);
  });

  test("rejects malformed ids, paths, and multiline names", () => {
    expect(validateDish({ ...DISHES[0], id: "../dish" })).toBeNull();
    expect(validateDish({ ...DISHES[0], image: { path: "../secret.png" } })).toBeNull();
    expect(validateDish({ ...DISHES[0], name: { en: "Har\nGow", zhHant: "蝦餃" } })).toBeNull();
  });
});

describe("public photo URLs", () => {
  test("point only at published public-catalog release assets", () => {
    const url = publicPhotoUrl(PUBLIC_CATALOG_RELEASES[2], DISHES[0]);
    expect(url).toBe(
      `https://github.com/${PUBLIC_PHOTO_REPOSITORY}/releases/download/catalog-v1/hk-dish-0001-classic-har-gow.png`,
    );
    expect(publicAssetName(DISHES[0])).toBe("hk-dish-0001-classic-har-gow.png");
    expect(url).not.toContain("opencodex");
    expect(url).not.toContain("/main/");
  });
});

describe("one-use codename selection", () => {
  test("skips a dish already named by a prior release", async () => {
    const result = await selectUnusedPublishedDish(
      "same-sha",
      DISHES,
      "build 149 · 蝦餃 Classic Har Gow",
      async dish => dish.id === "hk-dish-0002" ? "catalog-v1" : null,
    );
    expect(result?.dish.id).toBe("hk-dish-0002");
    expect(result?.photoUrl).toContain("catalog-v1/hk-dish-0002-scallop-har-gow.png");
  });

  test("recognizes both historical names and exact public asset names", () => {
    expect(releaseMentionsDish("Classic Har Gow · 蝦餃", DISHES[0])).toBe(true);
    expect(releaseMentionsDish("asset hk-dish-0001-classic-har-gow.png", DISHES[0])).toBe(true);
    expect(releaseMentionsDish("Scallop Har Gow · 帶子蝦餃", DISHES[0])).toBe(false);
  });

  test("omits the codename when no unused published asset exists", async () => {
    expect(await selectUnusedPublishedDish("sha", DISHES, "", async () => null)).toBeNull();
    expect(await selectUnusedPublishedDish("sha", [], "", async () => "catalog-v1")).toBeNull();
  });

  test("is deterministic for a stable candidate set", async () => {
    const choose = () => selectUnusedPublishedDish("stable-sha", DISHES, "", async () => "catalog-v1");
    expect((await choose())?.dish.id).toBe((await choose())?.dish.id);
  });
});

describe("automatic release publication", () => {
  const workflow = YAML.parse(readFileSync(new URL("../.github/workflows/auto-release.yml", import.meta.url), "utf8")) as {
    jobs: { release: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> } };
  };
  const steps = workflow.jobs.release.steps;
  const step = (name: string) => {
    const found = steps.find(candidate => candidate.name === name);
    if (!found) throw new Error(`missing workflow step: ${name}`);
    return found;
  };

  test("resolves the catalog with the least-privilege token chain", () => {
    const pick = step("Pick the dim sum codename");
    expect(pick.env?.GH_TOKEN).toContain("secrets.RELEASE_TOKEN");
    expect(pick.env?.GH_TOKEN).toContain("secrets.ORG_TOKEN");
    expect(pick.run).toContain("scripts/release-codename.ts");
  });

  test("links the public photo without attaching a consumer-repository copy", () => {
    const publish = step("Create the release").run ?? "";
    expect(publish).toContain("$DISH_PHOTO");
    expect(publish).toContain("DISH_RELEASE_TAG");
    expect(publish).not.toContain("gui/public/dimsum");
    expect(publish).not.toContain("photo_asset");
    expect(publish).not.toMatch(/gh release create[\s\S]*\.webp/);
  });

  test("finalizes exact workflow timing after release publication", () => {
    const publish = step("Create the release").run ?? "";
    expect(publish).toContain("Workflow started");
    expect(publish).toContain("Workflow completed");
    expect(publish).toContain("Workflow duration");
    expect(publish.indexOf("gh release edit")).toBeGreaterThan(publish.indexOf("gh release create"));
  });
});
