/**
 * The one string the screenshot harness and the app both have to agree on.
 *
 * `scripts/capture-shots.ts` runs outside the dashboard bundle, so it cannot
 * import `ONBOARDING_KEY` — it writes the flag by name. If the app ever renames
 * that key, the harness carries on writing the old one, the wizard reopens over
 * the phone pass, and `mobile` fails with "1 overlay(s) are covering this page".
 *
 * That failure is quiet in the worst way: a target that refuses to write leaves
 * the *previous* screenshot in place, and a stale screenshot is indistinguishable
 * from a fresh one. It went unnoticed for exactly that reason once already.
 */

import { expect, test } from "bun:test";
import { ONBOARDING_KEY } from "../gui/src/shell/onboarding-state";
import { LOCALES } from "../gui/src/i18n/shared";

test("the capture harness writes the key the app actually reads", async () => {
  const harness = await Bun.file(new URL("../scripts/capture-shots.ts", import.meta.url)).text();
  expect(harness).toContain(`const ONBOARDING_KEY = "${ONBOARDING_KEY}"`);
});

test("it captures in bilingual mode, the mode the shots exist to demonstrate", async () => {
  // English-only screenshots say nothing about whether the Cantonese half
  // exists, fits or wraps — and bilingual is the longest-string case the
  // project's own UI rules single out for validation.
  const harness = await Bun.file(new URL("../scripts/capture-shots.ts", import.meta.url)).text();
  expect(harness).toContain(`const LANG_KEY = "ocx-lang"`);
  expect(harness).toContain(`const CAPTURE_LOCALE = "bi"`);
  expect(LOCALES.some(l => l.code === "bi")).toBe(true);
});

test("and it writes the shape the app accepts", async () => {
  // `readOnboarding` requires `completed === true` exactly; a truthy string or a
  // bare `true` at the top level would be read as "not completed" and show the
  // wizard anyway.
  const harness = await Bun.file(new URL("../scripts/capture-shots.ts", import.meta.url)).text();
  expect(harness).toContain("{ completed: true, at: 1 }");
});
