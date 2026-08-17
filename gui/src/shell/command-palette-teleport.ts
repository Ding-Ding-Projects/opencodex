/**
 * Landing on the exact element a palette result named.
 *
 * The contract is specific about what "selecting a result" has to do: open the
 * owning surface, reveal the exact setting, scroll it into view, focus it and
 * briefly highlight it — landing on a general page and leaving the user to hunt
 * does not satisfy it. Doing that without touching any of the fourteen settings
 * pages (out of scope for this build — see `CommandPalette.tsx`'s header) rules
 * out the obvious approach of stamping a `data-settings-anchor` id on every row
 * those screens render. So this finds the row by the one thing every settings
 * screen already renders identically: the translated label text `t(row.tkey)`
 * puts on screen, which is exactly the string the palette already has.
 *
 * `openPage` is a `setState` call, so the DOM it targets does not exist on the
 * same tick — a caller that searched immediately would find nothing four times
 * out of five and never try again. `waitForLabeledElement` polls for it instead
 * of assuming a single microtask is enough, because pages that fetch their own
 * data can take a render or two longer than a purely local one does.
 */

import type { Page } from "../app-routing";

const HIGHLIGHT_CLASS = "m3-command-palette-highlight";
export const PALETTE_HIGHLIGHT_MS = 2200;

/** Row containers a highlight should wrap around, checked nearest-ancestor first. */
const ROW_ANCESTOR_CLASSES = ["m3-field", "m3-slider-row", "m3-row", "m3-card"];

/** How many ancestors to climb looking for a row container before giving up and using the label itself. */
const MAX_ANCESTOR_CLIMB = 4;

const FOCUSABLE_SELECTOR =
  'button, a[href], input, select, textarea, [role="switch"], [role="radio"], [tabindex]:not([tabindex="-1"])';

function isElementVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  return true;
}

/**
 * The smallest element under `root` whose visible text is the label a settings
 * row renders under.
 *
 * An exact match — an element whose *entire* trimmed text is the label, nothing
 * more — wins over one that merely contains it, and among exact matches the
 * shortest wins: that is the label's own leaf element (a `<span
 * className="m3-field-label">`, typically) rather than a page-wide wrapper that
 * happens to contain it somewhere inside. Not every settings row renders its
 * label as an isolated leaf, though — a `Toggle`'s visible label sits beside the
 * control rather than around it — so a page with no exact match falls back to
 * the smallest element that merely *contains* the text, which is usually the
 * row itself.
 */
export function findLabeledElement(root: ParentNode, label: string): HTMLElement | null {
  const text = label.trim();
  if (!text) return null;

  let bestExact: HTMLElement | null = null;
  let bestExactLen = Infinity;
  let bestContains: HTMLElement | null = null;
  let bestContainsLen = Infinity;

  for (const node of root.querySelectorAll("*")) {
    if (!(node instanceof HTMLElement) || !isElementVisible(node)) continue;
    const content = (node.textContent ?? "").trim();
    if (!content) continue;
    // `<=`, not `<`, on both branches: an ancestor whose only descendant is the
    // labelled leaf has *exactly* the same trimmed text and the same length as
    // that leaf, so it ties rather than loses. `querySelectorAll` visits a
    // parent before its children, so accepting a tie keeps overwriting the
    // "best" match as the walk goes deeper — the leaf, not the wrapper several
    // levels up, is what a `<` comparison would have frozen on first sight of.
    if (content === text) {
      if (content.length <= bestExactLen) { bestExact = node; bestExactLen = content.length; }
    } else if (content.includes(text) && content.length <= bestContainsLen) {
      bestContains = node;
      bestContainsLen = content.length;
    }
  }

  return bestExact ?? bestContains;
}

/** Climb from the label toward whichever ancestor looks like "the row", so the highlight wraps the whole control rather than just its bare text. */
function ancestorRowFor(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el;
  for (let depth = 0; node && depth < MAX_ANCESTOR_CLIMB; depth += 1) {
    if (ROW_ANCESTOR_CLASSES.some(cls => node!.classList.contains(cls))) return node;
    node = node.parentElement;
  }
  return el;
}

function focusableWithin(el: HTMLElement): HTMLElement | null {
  if (el.matches(FOCUSABLE_SELECTOR)) return el;
  const found = el.querySelector(FOCUSABLE_SELECTOR);
  return found instanceof HTMLElement ? found : null;
}

export interface TeleportHighlightOptions {
  /** Overridable for tests; defaults to reading `matchMedia`. */
  reducedMotion?: boolean;
  /** Overridable for tests; defaults to a real `setTimeout`. */
  clearAfter?: (run: () => void, ms: number) => void;
}

function defaultClearAfter(run: () => void, ms: number): void {
  setTimeout(run, ms);
}

/**
 * Scroll the found element's row into view, flash it, and hand focus to
 * whatever in it is actually operable.
 *
 * Focus goes to a real control when the row has one — the toggle, the slider,
 * the select — because that is the element a keyboard user came here to use.
 * A destination row, or a settings row with no live control, has nothing like
 * that; the label itself becomes focusable for the duration of the highlight
 * so Tab and a screen reader both have somewhere to land, and stops being
 * focusable again the moment it loses focus, so teleporting through the app
 * does not leave a trail of `tabindex="-1"` behind it.
 */
export function highlightAndFocus(labelEl: HTMLElement, opts: TeleportHighlightOptions = {}): HTMLElement {
  const target = ancestorRowFor(labelEl);
  const reducedMotion = opts.reducedMotion
    ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const clearAfter = opts.clearAfter ?? defaultClearAfter;

  // Optional-chained: not every DOM implementation carries `scrollIntoView`
  // (the test environment's does not), and a highlight that cannot scroll is
  // still worth showing rather than throwing.
  target.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
  target.classList.add(HIGHLIGHT_CLASS);
  clearAfter(() => target.classList.remove(HIGHLIGHT_CLASS), PALETTE_HIGHLIGHT_MS);

  const interactive = focusableWithin(target);
  if (interactive) {
    interactive.focus({ preventScroll: true });
    return target;
  }

  const alreadyFocusable = labelEl.hasAttribute("tabindex");
  if (!alreadyFocusable) labelEl.setAttribute("tabindex", "-1");
  labelEl.focus({ preventScroll: true });
  if (!alreadyFocusable) {
    labelEl.addEventListener("blur", () => labelEl.removeAttribute("tabindex"), { once: true });
  }
  return target;
}

export interface TeleportWaitOptions {
  /** Overridable for tests: replaces `requestAnimationFrame`-based polling. */
  schedule?: (run: () => void) => void;
  /** Bounds how long this waits before giving up and reporting nothing found. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 45;

function defaultSchedule(run: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/**
 * Poll `getRoot` until it both exists and contains `label`, or give up.
 *
 * `getRoot` is called on every attempt rather than once, deliberately: the
 * element that will contain the label may not exist in the DOM *at all* yet on
 * the first few polls — a newly opened tab mounts its page on the render after
 * the one that added it — so re-resolving the root each time is what lets this
 * see a container that did not exist when polling started.
 */
export function waitForLabeledElement(
  getRoot: () => ParentNode | null,
  label: string,
  opts: TeleportWaitOptions = {},
): Promise<HTMLElement | null> {
  const schedule = opts.schedule ?? defaultSchedule;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return new Promise(resolve => {
    let attempt = 0;
    const tick = () => {
      const root = getRoot();
      const found = root ? findLabeledElement(root, label) : null;
      if (found || attempt >= maxAttempts) {
        resolve(found);
        return;
      }
      attempt += 1;
      schedule(tick);
    };
    tick();
  });
}

export interface TeleportSettingTarget {
  page: Page;
  label: string;
}

export interface TeleportRunner {
  /** Opens (or focuses an already-open tab on) the target page. */
  openPage: (page: Page) => void;
  /** Where to search for the label once the target page is showing. Defaults to `document`. */
  getRoot?: () => ParentNode | null;
  wait?: TeleportWaitOptions;
  highlight?: TeleportHighlightOptions;
}

/** Open the row's owning page, wait for it to render the row, then land on it. */
export async function teleportToSetting(target: TeleportSettingTarget, runner: TeleportRunner): Promise<HTMLElement | null> {
  runner.openPage(target.page);
  const getRoot = runner.getRoot ?? (() => document);
  const el = await waitForLabeledElement(getRoot, target.label, runner.wait);
  if (el) highlightAndFocus(el, runner.highlight);
  return el;
}
