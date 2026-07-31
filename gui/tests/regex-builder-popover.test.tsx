/**
 * The anchored regex builder.
 *
 * The defect this exists to prevent is the one that was shipped: twenty-six
 * search bars "offered" the builder with an `<a href="#regex">`, so reaching for
 * it navigated the whole window to another screen and abandoned the field the
 * user was typing in. The first test therefore asserts the negative — the
 * trigger opens a panel *inside the same subtree* and `location.hash` does not
 * move — because a component that renders a perfect popover and also navigates
 * would pass every other test here.
 *
 * The rest guard the hand-off in both directions (seed in, pattern and mode
 * out), the keyboard contract a non-modal popover still owes (Escape closes and
 * gives focus back), and the safety caps, which are the difference between a
 * pattern that reports an error and one that hangs the tab it was typed into.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { RegexBuilderButton, SearchField } from "../src/shell/RegexBuilderButton";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

interface Applied { pattern: string; flags: string }

/**
 * A host search bar, exactly as a call site will use one: it owns the query and
 * the regex-mode flag, and the button only reads and writes them. Recording the
 * calls rather than only the resulting state is deliberate — a component that
 * set the query but never told the host to switch modes would leave the pattern
 * being matched literally, and the state alone cannot tell the two apart.
 */
function Host({ initial = "", applied, modes, sample }: {
  initial?: string;
  applied: Applied[];
  modes: boolean[];
  sample?: string;
}) {
  const [query, setQuery] = useState(initial);
  const [useRegex, setUseRegex] = useState(false);
  return (
    <div>
      <input aria-label="host search" value={query} onChange={e => setQuery(e.target.value)} />
      <RegexBuilderButton
        value={query}
        sample={sample}
        regex={useRegex}
        onRegexChange={next => { modes.push(next); setUseRegex(next); }}
        onApply={(pattern, flags) => { applied.push({ pattern, flags }); setQuery(pattern); }}
      />
    </div>
  );
}

async function mount(node: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
  });
  return { container, root };
}

const trigger = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const panel = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="dialog"].m3-rxpop');
const patternInput = (c: HTMLElement) => panel(c)!.querySelector<HTMLInputElement>('input[aria-invalid]')!;
const sampleInput = (c: HTMLElement) => panel(c)!.querySelector<HTMLTextAreaElement>("textarea")!;
const errorLine = (c: HTMLElement) => panel(c)!.querySelector<HTMLElement>('[role="alert"]')!;
const applyButton = (c: HTMLElement) =>
  [...panel(c)!.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Use this pattern")!;

/**
 * React shadows `value` with an instance property so it can tell a real edit from
 * a programmatic assignment. Writing through the prototype setter bypasses that
 * tracker, which is what makes the dispatched `input` event look like typing.
 */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

function key(target: Element | null, name: string): void {
  target?.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: name, bubbles: true }) as never);
}

/* --------------------------------------------------------- anchored, not a page -- */

test("the trigger opens a panel beside it and never navigates away", async () => {
  const { container, root } = await mount(<Host applied={[]} modes={[]} />);
  const hashBefore = window.location.hash;

  expect(panel(container)).toBeNull();
  expect(trigger(container).getAttribute("aria-expanded")).toBe("false");

  await act(async () => { trigger(container).click(); });

  // The regression: the old affordance was `<a href="#regex">`, which replaced
  // the screen. The panel has to live in the trigger's own subtree, and the
  // route must not have moved.
  const opened = panel(container);
  expect(opened).not.toBeNull();
  expect(container.contains(opened)).toBe(true);
  expect(trigger(container).parentElement?.contains(opened!)).toBe(true);
  expect(window.location.hash).toBe(hashBefore);
  expect(container.querySelector('a[href="#regex"]')).toBeNull();

  // Non-modal by contract: this is a form beside a field, not a gate in front of it.
  expect(opened!.getAttribute("aria-modal")).toBeNull();
  expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
  expect(trigger(container).getAttribute("aria-controls")).toBe(opened!.id);

  await act(async () => { root.unmount(); });
});

/* ---------------------------------------------------------------- sync in and out -- */

test("opening seeds the pattern from the host field", async () => {
  const { container, root } = await mount(<Host initial="resp_[0-9a-f]+" applied={[]} modes={[]} />);

  await act(async () => { trigger(container).click(); });
  expect(patternInput(container).value).toBe("resp_[0-9a-f]+");

  await act(async () => { root.unmount(); });
});

test("re-opening re-seeds from the field as it is now, not as it was", async () => {
  const { container, root } = await mount(<Host initial="first" applied={[]} modes={[]} />);

  await act(async () => { trigger(container).click(); });
  await act(async () => { trigger(container).click(); });

  const host = container.querySelector<HTMLInputElement>('input[aria-label="host search"]')!;
  await act(async () => { typeInto(host, "second"); });
  await act(async () => { trigger(container).click(); });

  // A seed captured once at first mount would still say "first" here, and the
  // user would silently be editing a stale copy of their own query.
  expect(patternInput(container).value).toBe("second");

  await act(async () => { root.unmount(); });
});

test("applying hands the pattern and flags back and switches the host into regex mode", async () => {
  const applied: Applied[] = [];
  const modes: boolean[] = [];
  const { container, root } = await mount(<Host applied={applied} modes={modes} sample="resp_9fa2c1" />);

  await act(async () => { trigger(container).click(); });
  await act(async () => { typeInto(patternInput(container), "resp_(?<id>[0-9a-f]+)"); });
  await act(async () => { applyButton(container).click(); });

  expect(applied).toEqual([{ pattern: "resp_(?<id>[0-9a-f]+)", flags: "i" }]);
  // Without this the host writes a regex into a field still matching literally,
  // which finds nothing and looks like the builder produced a broken pattern.
  expect(modes).toEqual([true]);
  // Committing closes: the panel exists to produce a pattern, and it has.
  expect(panel(container)).toBeNull();
  expect(document.activeElement).toBe(trigger(container));

  await act(async () => { root.unmount(); });
});

test("an empty or invalid pattern cannot be applied", async () => {
  const applied: Applied[] = [];
  const { container, root } = await mount(<Host applied={applied} modes={[]} />);

  await act(async () => { trigger(container).click(); });
  expect(applyButton(container).disabled).toBe(true);

  await act(async () => { typeInto(patternInput(container), "(?<"); });
  expect(applyButton(container).disabled).toBe(true);
  expect(applied).toEqual([]);

  await act(async () => { root.unmount(); });
});

/* ----------------------------------------------------------------------- keyboard -- */

test("Escape closes the panel and gives focus back to the trigger", async () => {
  const { container, root } = await mount(<Host applied={[]} modes={[]} />);

  await act(async () => { trigger(container).click(); });
  // Focus moves into the panel on open, or a keyboard user has to tab to reach it.
  expect(document.activeElement).toBe(patternInput(container));

  await act(async () => { key(document.activeElement, "Escape"); });

  expect(panel(container)).toBeNull();
  // Dropping focus to <body> restarts a keyboard user at the top of the page.
  expect(document.activeElement).toBe(trigger(container));

  await act(async () => { root.unmount(); });
});

test("a click outside closes the panel", async () => {
  const { container, root } = await mount(<Host applied={[]} modes={[]} />);

  await act(async () => { trigger(container).click(); });
  await act(async () => {
    document.body.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true }) as never);
  });

  expect(panel(container)).toBeNull();

  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------------- errors and caps -- */

test("an invalid pattern is reported rather than thrown", async () => {
  const { container, root } = await mount(<Host applied={[]} modes={[]} />);

  await act(async () => { trigger(container).click(); });
  // An unterminated group: `new RegExp` throws on this, and an uncaught throw
  // during render takes the whole host screen down with it.
  await act(async () => { typeInto(patternInput(container), "(?<"); });

  expect(errorLine(container).textContent).toContain("Invalid pattern");
  expect(panel(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("the pattern cap holds, both for typing and for a seed that is already too long", async () => {
  const { container, root } = await mount(<Host initial={"a".repeat(600)} applied={[]} modes={[]} />);

  await act(async () => { trigger(container).click(); });
  // Seeded from a host query longer than the cap: the panel adopts 400, not 600.
  expect(patternInput(container).value).toHaveLength(400);

  await act(async () => { typeInto(patternInput(container), "b".repeat(900)); });
  expect(patternInput(container).value).toHaveLength(400);

  await act(async () => { root.unmount(); });
});

test("the sample cap holds", async () => {
  const { container, root } = await mount(<Host applied={[]} modes={[]} sample={"x".repeat(30_000)} />);

  await act(async () => { trigger(container).click(); });
  expect(sampleInput(container).value).toHaveLength(20_000);

  await act(async () => { root.unmount(); });
});

test("a zero-width match advances instead of spinning, and stops at the match cap", async () => {
  const { container, root } = await mount(<Host applied={[]} modes={[]} sample="abc" />);

  await act(async () => { trigger(container).click(); });
  // `(?:)` matches the empty string everywhere. Without the forced index
  // advance, exec() returns the same zero-length match forever and this test
  // never finishes rather than failing.
  await act(async () => { typeInto(patternInput(container), "(?:)"); });
  expect(panel(container)!.querySelectorAll(".m3-rxpop-row")).toHaveLength(4);

  // The same pattern on a sample long enough to blow past the 200-match cap.
  await act(async () => { typeInto(sampleInput(container), "y".repeat(1000)); });
  expect(panel(container)!.querySelectorAll(".m3-rxpop-row")).toHaveLength(200);
  expect(panel(container)!.textContent).toContain("200-match cap");

  await act(async () => { root.unmount(); });
});

/* ----------------------------------------------------------------- capture groups -- */

test("capture groups are numbered the way the engine numbers them", async () => {
  const { container, root } = await mount(<Host applied={[]} modes={[]} sample="ab" />);

  await act(async () => { trigger(container).click(); });
  // Two unnamed groups first, so a panel that numbers names in order says $1.
  // The popover and the full page must agree, because they share one evaluator.
  await act(async () => { typeInto(patternInput(container), "(a)(?:x)?(b)(?<tail>c*)"); });

  const cells = [...panel(container)!.querySelectorAll(".m3-rxpop-name")].map(n => n.textContent);
  const indices = [...panel(container)!.querySelectorAll(".m3-rxpop-at")].map(n => n.textContent);
  expect(cells).toEqual(["tail"]);
  expect(indices).toContain("$3");

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------------ SearchField -- */

test("SearchField pairs an input with the trigger and writes the pattern into it", async () => {
  function Wrapper() {
    const [query, setQuery] = useState("");
    return <SearchField value={query} onChange={setQuery} searchLabel="Search rows" placeholder="Search…" />;
  }
  const { container, root } = await mount(<Wrapper />);

  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search rows"]')!;
  await act(async () => { trigger(container).click(); });
  await act(async () => { typeInto(patternInput(container), "\\d+"); });
  await act(async () => { applyButton(container).click(); });

  // The default `onApply` is the one a search bar wants: the pattern becomes the query.
  expect(input.value).toBe("\\d+");

  await act(async () => { root.unmount(); });
});
