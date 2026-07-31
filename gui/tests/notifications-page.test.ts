import { expect, test } from "bun:test";

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

// A11Y-TONE-01: a row's tone was encoded only as a container colour behind an icon,
// which is nothing to a screen reader and very little to anyone who cannot separate
// the error and warning containers. Every row must name its tone in words.
test("every notification row names its tone in text, not only in colour", async () => {
  const page = await read("../src/pages/Notifications.tsx");
  for (const key of ["notif.toneErrorOne", "notif.toneWarnOne", "notif.toneSuccessOne", "notif.toneInfoOne"]) {
    expect(page).toContain(key);
  }
  // The name is rendered, not merely declared: the row meta translates the tone's key.
  expect(page).toContain("t(chip.nameKey)");
});

// SEARCH-BUILDER-01: plain text stays the default and the full builder is reachable
// from an affordance beside the field, never only from a distant menu.
test("the notification search keeps plain text default and links the regex builder", async () => {
  const page = await read("../src/pages/Notifications.tsx");
  expect(page).toContain('useState(false)');
  expect(page).toContain("search.regexHint");
  // The affordance opens the builder beside the field. It used to be
  // `<a href="#regex">`, which navigated the window to the builder page and left
  // the search — and the history being searched — behind.
  expect(page).toContain("<RegexBuilderButton");
  expect(page).not.toContain('href="#regex"');
  expect(page).toContain('role="search"');
});

// The screen leads with the shared body-large page lead rather than a hand-rolled
// paragraph, so its measure and colour cannot drift from the other screens.
test("the notifications screen uses the shared page lead", async () => {
  const page = await read("../src/pages/Notifications.tsx");
  expect(page).toContain('className="m3-page-lead"');
  expect(page).toContain("notif.historySub");
});
