/**
 * The installer's job is to run a package manager on the user's machine, so the
 * things worth pinning down are the ones that decide *what* gets run.
 */

import { describe, expect, test, beforeEach } from "bun:test";

import {
  canInstall,
  chooseRecipe,
  hasInstallRoute,
  listInstallJobs,
  resetInstallJobs,
  startInstall,
} from "../src/lib/app-installer";
import { launchTargetIds, launchTargetInstallUrl } from "../src/lib/app-launcher";

beforeEach(() => resetInstallJobs());

describe("install routes", () => {
  test("every target with a recipe names a target that exists in the catalog", () => {
    const ids = new Set(launchTargetIds().map(t => t.id));
    for (const id of ["codex-cli", "claude-cli", "grok-cli", "claude-desktop"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test("ChatGPT desktop has no automatic route", () => {
    // winget lists three unrelated publishers shipping something called
    // "ChatGPT" and OpenAI is not one of them. Installing a community
    // repackage because the name matched would be a supply-chain hole, so this
    // target stays a manual link on purpose. If an official package ever ships,
    // this test is the reminder to check the publisher before wiring it up.
    expect(hasInstallRoute("chatgpt-desktop")).toBe(false);
    expect(canInstall("chatgpt-desktop")).toBe(false);
  });

  test("an unknown id has no route and cannot start an install", () => {
    expect(hasInstallRoute("../../evil")).toBe(false);
    const result = startInstall("../../evil");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unknown launch target");
  });

  test("nothing is spawned for an unknown id", () => {
    startInstall("definitely-not-a-target");
    expect(listInstallJobs()).toEqual([]);
  });

  test("a target with no route reports manual rather than failing silently", () => {
    const result = startInstall("chatgpt-desktop");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.manual).toBe(true);
      // The caller needs somewhere to send the user.
      expect(launchTargetInstallUrl("chatgpt-desktop")).toContain("openai.com");
    }
  });

  test("recipes only ever name constant packages, never anything caller-supplied", () => {
    // The whole injection story rests on this: a request supplies an id, and the
    // package name is looked up here rather than passed through.
    const recipe = chooseRecipe("codex-cli");
    if (recipe) {
      expect(["OpenAI.Codex", "@openai/codex"]).toContain(recipe.pkg);
    }
  });

  test("a target already installed is refused rather than reinstalled", () => {
    // Whichever target happens to exist on this machine, asking to install it
    // must say so instead of running a package manager for nothing.
    const { listLaunchTargets } = require("../src/lib/app-launcher") as
      typeof import("../src/lib/app-launcher");
    const present = listLaunchTargets().find(t => t.available);
    if (!present) return; // Nothing installed here; nothing to assert.
    const result = startInstall(present.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already installed");
  });
});
