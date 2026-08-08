/**
 * Where an anchored, non-modal surface goes.
 *
 * Ported from the placement maths inside `gui/src/shell/RegexBuilderButton.tsx`,
 * which had it as a file-local function. Every anchored surface in this
 * repository needs the same three answers — flip above when there is more room
 * there, clamp horizontally so a trigger near an edge shifts the panel instead
 * of letting it render off-screen, and cap the height to the space that is
 * actually available — and each surface that re-derives them gets a slightly
 * different one. The regex popover, the tab-search panel, the settings search
 * results and (next) the per-element appearance editor all resolve through this.
 *
 * Pure and rect-driven on purpose: it behaves identically against a stubbed
 * layout in a test as it does in a browser. The alternative — reading the DOM
 * from inside the component — is untestable, and untestable placement is how a
 * popover ends up half off the screen on exactly one phone width.
 *
 * Two coordinate spaces are returned, because the panels need both.
 *
 * `left` is relative to the anchor, for a panel absolutely positioned inside the
 * trigger's own wrapper — it then moves with the trigger for free and can never
 * visually detach.
 *
 * `viewportLeft` / `viewportTop` / `viewportBottom` are for a panel positioned
 * `fixed`, and that is not a stylistic alternative: an `overflow: auto` ancestor
 * clips absolutely positioned descendants, and these panels live inside two of
 * them — the tab strip scrolls horizontally below 50em, and the tab-search
 * panel's own body scrolls vertically. A builder opened from a search bar inside
 * either would be cut off at the container's edge, which on a phone means cut off
 * almost entirely. Only `position: fixed` escapes that, and a fixed panel needs
 * viewport coordinates and a listener to stay attached — which the callers
 * already have, because they reposition on scroll and resize anyway.
 *
 * `viewportBottom` rather than a second top: a panel that flips above its trigger
 * has to keep its BOTTOM edge against the trigger, and a `top` computed from a
 * height that then changes (the content grows, the height cap shrinks it) leaves
 * a gap or an overlap. Anchoring the edge that must not move removes the problem
 * instead of tracking it.
 *
 * What it deliberately does NOT do: decide whether to be modal. A viewport too
 * small for an anchored panel is a caller's decision, because only the caller
 * knows what it must return focus to; this module reports the room it found and
 * lets the caller act on it.
 */

/** Gap between the trigger and the panel. */
export const GAP_PX = 8;
/** Margin the panel keeps from the viewport edge. */
export const EDGE_PAD_PX = 8;
/** Below this the panel is not worth showing at all, so a cramped viewport scrolls it instead. */
export const MIN_PANEL_HEIGHT_PX = 220;

export interface Placement {
  side: "below" | "above";
  /** Anchor-relative, for a panel absolutely positioned inside the anchor's wrapper. */
  left: number;
  /** Viewport-relative, for a panel positioned `fixed` so no ancestor can clip it. */
  viewportLeft: number;
  /** Use when `side` is `below`. */
  viewportTop: number;
  /** Distance from the viewport's bottom edge. Use when `side` is `above`. */
  viewportBottom: number;
  maxHeight: number;
}

/**
 * The placement a panel holds for the one render before it has been measured.
 *
 * Never painted: callers measure in `useLayoutEffect`, which runs after the DOM
 * is built and before the browser paints, so the real placement is in place by
 * the first frame. It exists so the state has a shape rather than a null, and it
 * is off-screen-safe if a caller ever measures in a plain effect instead.
 */
export const INITIAL_PLACEMENT: Placement = {
  side: "below",
  left: 0,
  viewportLeft: EDGE_PAD_PX,
  viewportTop: EDGE_PAD_PX,
  viewportBottom: EDGE_PAD_PX,
  maxHeight: MIN_PANEL_HEIGHT_PX,
};

export interface AnchorBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlacementOptions {
  /**
   * Which edge the panel lines up with.
   *
   * `end` (the default) right-aligns it to the trigger, which is what a trigger
   * sitting at the end of a search row needs — a left-aligned panel there hangs
   * off the right of the page. `start` is for a trigger at the start of a row.
   * Either way the horizontal clamp below has the final word.
   */
  align?: "start" | "end";
  /** Overrides the gap, for a surface that sits flush against its anchor. */
  gap?: number;
}

/**
 * Place a panel of a known size against a known anchor.
 *
 * The order matters: the flip decision is made from the space above and below
 * BEFORE the height is capped, so a panel that would fit above only after being
 * shrunk is not shrunk to justify a flip nobody needed. The outer `max` in the
 * horizontal clamp wins when the panel is wider than the viewport — it is then
 * pinned to the left edge and scrolls inside itself, rather than being pushed off
 * both edges at once, which is the phone case.
 */
export function computePlacement(
  anchor: AnchorBox,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  options: PlacementOptions = {},
): Placement {
  const gap = options.gap ?? GAP_PX;
  const spaceBelow = viewport.height - anchor.bottom - EDGE_PAD_PX;
  const spaceAbove = anchor.top - EDGE_PAD_PX;
  const above = panel.height + gap > spaceBelow && spaceAbove > spaceBelow;

  const aligned = options.align === "start" ? anchor.left : anchor.right - panel.width;
  const furthestLeft = viewport.width - panel.width - EDGE_PAD_PX;
  const viewportLeft = Math.max(EDGE_PAD_PX, Math.min(aligned, Math.max(EDGE_PAD_PX, furthestLeft)));

  return {
    side: above ? "above" : "below",
    left: viewportLeft - anchor.left,
    viewportLeft,
    viewportTop: anchor.bottom + gap,
    viewportBottom: Math.max(EDGE_PAD_PX, viewport.height - anchor.top + gap),
    maxHeight: Math.max(MIN_PANEL_HEIGHT_PX, (above ? spaceAbove : spaceBelow) - gap),
  };
}

/**
 * The inline style a `fixed` anchored panel needs, from a placement.
 *
 * A helper rather than three lines repeated in every panel, because getting it
 * wrong is silent: setting `top` on a panel that flipped above leaves it sitting
 * on top of its own trigger, which looks like a rendering glitch rather than a
 * placement bug. The returned object is deliberately assignable to React's
 * `CSSProperties` without importing React here.
 */
export function fixedPanelStyle(placement: Placement): {
  position: "fixed";
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
} {
  return {
    position: "fixed",
    left: placement.viewportLeft,
    ...(placement.side === "above"
      ? { bottom: placement.viewportBottom }
      : { top: placement.viewportTop }),
    maxHeight: placement.maxHeight,
  };
}
