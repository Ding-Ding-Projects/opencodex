/**
 * The installer's job is to run a package manager on the user's machine, so the
 * things worth pinning down are the ones that decide *what* gets run.
 */

import { describe, expect, test, beforeEach } from "bun:test";

import {
  canInstall,
  chooseRecipe,
  hasInstallRoute,
  installInvocation,
  installRecipesFor,
  listInstallJobs,
  resetInstallJobs,
  startInstall,
} from "../src/lib/app-installer";
import { launchTargetIds, launchTargetInstallUrl, WINDOWS_TERMINAL_ID } from "../src/lib/app-launcher";

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

  test("Windows Terminal resolves to Microsoft's own winget package", () => {
    // The launcher will not open a CLI without a terminal and will not fall back
    // to a legacy console, so this package is what turns that refusal into an
    // offer. Pinned by id because the id is the security claim: verified against
    // the live catalogue as "Windows Terminal", publisher "Microsoft
    // Corporation". A near-miss id is how a friendly button installs someone
    // else's package.
    const recipes = installRecipesFor(WINDOWS_TERMINAL_ID);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.method).toBe("winget");
    expect(recipes[0]!.pkg).toBe("Microsoft.WindowsTerminal");
    expect(recipes[0]!.platforms).toEqual(["win32"]);
  });

  test("the Windows Terminal install runs winget directly, never through a shell", () => {
    const invocation = installInvocation(installRecipesFor(WINDOWS_TERMINAL_ID)[0]!);
    expect(invocation.args.join(" ")).toContain("install --id Microsoft.WindowsTerminal --source winget");
    // Unattended, or a licence prompt would hang forever behind a hidden window.
    expect(invocation.args).toContain("--disable-interactivity");
    // The one thing this must never become: a shell, or a console interpreter
    // wrapping the package manager.
    expect(invocation.file).not.toMatch(/cmd\.exe|powershell|sh$/i);
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
    if (!result.ok) {
      expect(result.error).toContain("already installed");
      // Flagged, not just worded. A dashboard installing Windows Terminal in
      // order to retry a launch has to tell "nothing to do, go ahead" apart from
      // "that failed", and matching on English prose to do it would break the
      // retry the moment the sentence changed.
      expect(result.installed).toBe(true);
    }
  });
});
