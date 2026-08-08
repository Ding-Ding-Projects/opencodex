import { useLayoutEffect, useState, type RefObject } from "react";
import {
  computePlacement,
  fixedPanelStyle,
  EDGE_PAD_PX,
  type AnchorBox,
  type Placement,
  type PlacementOptions,
} from "../../../shared/m3/anchor";

/**
 * Normalize shared placement for a browser viewport.
 *
 * The shared math supplies the common horizontal alignment and flip decision, but
 * its minimum-height contract is intentionally not a GUI containment contract.
 * A fixed panel must never receive a negative edge coordinate or a max-height
 * larger than the side of the viewport it can paint into. This wrapper is the GUI
 * boundary that keeps menus and editors safe while their owning page scrolls.
 */
export function computeViewportPlacement(
  anchor: AnchorBox,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  options: PlacementOptions = {},
): Placement {
  const raw = computePlacement(anchor, panel, viewport, options);
  const anchorAbove = anchor.bottom <= EDGE_PAD_PX;
  const anchorBelow = anchor.top >= viewport.height - EDGE_PAD_PX;
  const side = anchorBelow ? "above" : anchorAbove ? "below" : raw.side;
  const rawTop = anchor.bottom + (options.gap ?? 8);
  const rawBottom = viewport.height - anchor.top + (options.gap ?? 8);
  const viewportTop = anchorAbove
    ? EDGE_PAD_PX
    : Math.max(EDGE_PAD_PX, Math.min(rawTop, viewport.height - EDGE_PAD_PX));
  const viewportBottom = anchorBelow
    ? EDGE_PAD_PX
    : Math.max(EDGE_PAD_PX, Math.min(rawBottom, viewport.height - EDGE_PAD_PX));
  const maxHeight = Math.max(
    0,
    side === "above"
      ? viewport.height - viewportBottom - EDGE_PAD_PX
      : viewport.height - viewportTop - EDGE_PAD_PX,
  );

  return { ...raw, side, viewportTop, viewportBottom, maxHeight };
}

/** Keep a fixed menu attached to its trigger while any ancestor scrolls. */
export function useAnchoredPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  fallbackWidth: number,
  align: "start" | "end" = "end",
): Placement {
  const [placement, setPlacement] = useState<Placement>(() => computeViewportPlacement(
    { top: 0, bottom: 0, left: 0, right: 0 },
    { width: fallbackWidth, height: 0 },
    { width: 1, height: 1 },
    { align },
  ));

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPlacement(computeViewportPlacement(
        { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right },
        { width: panel.width || fallbackWidth, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight },
        { align },
      ));
    };

    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [align, anchorRef, fallbackWidth, open, panelRef]);

  return placement;
}

export { fixedPanelStyle };
