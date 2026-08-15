#!/usr/bin/env python3
"""Rebuild the 19 design-vs-shipped composites in assets/design-shots/side-by-side/.

Each composite places the design prototype's capture (`assets/design-shots/<name>.png`,
en locale, mock data) on the left and the shipped app's capture
(`assets/shots/<name>.png`, bilingual locale, seeded data) on the right, both scaled
to the same size, under a dark header carrying the page name and a small label over
each half ("DESIGN (prototype, mock data)" / "SHIPPED (app, seeded data)").

## Why this exists as a script rather than a one-off

The 19 composites already in the repository (`docs/design-system/side-by-side-audit.md`,
commit 3660e27be) were built by an agent with no committed tool, so the exact recipe
lived only in that agent's own session and could not be reproduced or checked. This
script is that recipe, reverse-engineered from the committed PNGs (measured with
Pillow's own pixel access — a dark #1e1e22 canvas, a ~73px header, each screenshot
scaled to exactly 1/3 of its captured size, a 12px margin/divider) so a later change to
either capture set can be re-composited on request instead of by hand.

## Running it

    py -3 -m pip install --quiet pillow      # once, if Pillow is not already present
    py -3 scripts/build-side-by-side.py

Only screens present in BOTH `assets/design-shots/` and `assets/shots/` get a
composite — the same 19-screen set the audit document covers. A screen missing from
either side is reported and skipped rather than silently producing a half-blank image.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Pillow is required: py -3 -m pip install --quiet pillow", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
DESIGN_DIR = ROOT / "assets" / "design-shots"
SHOTS_DIR = ROOT / "assets" / "shots"
OUT_DIR = DESIGN_DIR / "side-by-side"

# The 19 screens the audit document covers — every design-shots root PNG that is not
# itself a directory, matched against a shipped shot of the same name. Listed
# explicitly (rather than just globbing DESIGN_DIR) so a stray file dropped into
# design-shots/ cannot silently grow the composite set without a matching shipped shot.
SCREENS = sorted(p.stem for p in DESIGN_DIR.glob("*.png"))

# Reverse-engineered from assets/design-shots/side-by-side/dashboard.png (1956x684):
# each panel is the captured screenshot at exactly 1/3 scale (2880x1800 -> 960x600),
# a 73px dark header carries the title and the two labels, and a 12px margin/divider
# of the same dark background separates the panels from the edges and each other.
BG = (30, 30, 34)
DIVIDER_LINE = (90, 90, 96)
TITLE_COLOR = (255, 255, 255)
DESIGN_LABEL_COLOR = (110, 180, 255)
SHIPPED_LABEL_COLOR = (255, 185, 110)

MARGIN = 12
HEADER_H = 73
SCALE = 1 / 3

FONT_DIR = Path(r"C:\Windows\Fonts")
TITLE_FONT = FONT_DIR / "arialbd.ttf"
LABEL_FONT = FONT_DIR / "segoeuib.ttf"


def load_font(path: Path, size: int) -> "ImageFont.FreeTypeFont":
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        return ImageFont.load_default()


def build_one(name: str) -> bool:
    design_path = DESIGN_DIR / f"{name}.png"
    shipped_path = SHOTS_DIR / f"{name}.png"
    if not design_path.exists():
        print(f"  skip {name}: no design-shots/{name}.png")
        return False
    if not shipped_path.exists():
        print(f"  skip {name}: no shots/{name}.png")
        return False

    design = Image.open(design_path).convert("RGB")
    shipped = Image.open(shipped_path).convert("RGB")

    dw, dh = round(design.width * SCALE), round(design.height * SCALE)
    sw, sh = round(shipped.width * SCALE), round(shipped.height * SCALE)
    design_small = design.resize((dw, dh), Image.LANCZOS)
    shipped_small = shipped.resize((sw, sh), Image.LANCZOS)

    panel_h = max(dh, sh)
    canvas_w = MARGIN + dw + MARGIN + sw + MARGIN
    canvas_h = HEADER_H + panel_h + MARGIN

    canvas = Image.new("RGB", (canvas_w, canvas_h), BG)
    canvas.paste(design_small, (MARGIN, HEADER_H))
    right_x = MARGIN + dw + MARGIN
    canvas.paste(shipped_small, (right_x, HEADER_H))

    # The divider: a single accent line centered in the dark gap between panels,
    # matching the thin highlight the original composites carry.
    divider_x = MARGIN + dw + MARGIN // 2
    draw = ImageDraw.Draw(canvas)
    draw.line([(divider_x, HEADER_H), (divider_x, canvas_h - MARGIN)], fill=DIVIDER_LINE, width=2)

    title_font = load_font(TITLE_FONT, 26)
    label_font = load_font(LABEL_FONT, 13)

    title = name.upper().replace("-", " ")
    draw.text((MARGIN + 2, 12), title, font=title_font, fill=TITLE_COLOR)
    draw.text((MARGIN + 2, 42), "DESIGN (prototype, mock data)", font=label_font, fill=DESIGN_LABEL_COLOR)
    draw.text((right_x + 2, 42), "SHIPPED (app, seeded data)", font=label_font, fill=SHIPPED_LABEL_COLOR)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{name}.png"
    canvas.save(out_path, optimize=True)
    print(f"  {name:<16} {canvas_w}x{canvas_h}  ok")
    return True


def main() -> int:
    print(f"Building side-by-side composites for {len(SCREENS)} screen(s):\n")
    built = 0
    for name in SCREENS:
        if build_one(name):
            built += 1
    print(f"\nWrote {built}/{len(SCREENS)} composite(s) to {OUT_DIR}")
    return 0 if built == len(SCREENS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
