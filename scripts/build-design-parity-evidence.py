#!/usr/bin/env python3
"""Materialize parity JSON/diff receipts from existing PNG bytes; never edits images."""
from __future__ import annotations
import hashlib, json, subprocess
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parent.parent
DESIGN = ROOT / "assets" / "design-shots"
SHOTS = ROOT / "assets" / "shots"
COMPS = DESIGN / "side-by-side"
DIFFS = DESIGN / "diffs"
OUT = ROOT / "docs" / "design-system" / "design-parity-inventory.json"
REFERENCE_FILE = "design/OpenCodex M3.dc.html"
CAPTURE_COMMIT = "dc9401145e99c1dc6a5e981e257575749a38f882"

# Hand-written exact screen list. Never derive this from files on disk.
SCREENS = [
    ("dashboard", "Dashboard", "#/dashboard", "Dashboard"),
    ("codex-auth", "Codex Auth", "#/codex-auth", "Codex Auth"),
    ("providers", "Providers", "#/providers", "Providers"),
    ("models", "Models", "#/models", "Models"),
    ("combos", "Combos", "#/combos", "Combos"),
    ("subagents", "Subagents", "#/subagents", "Subagents"),
    ("logs", "Logs & Debug", "#/logs", "Logs and Debug"),
    ("usage", "Usage", "#/usage", "Usage"),
    ("storage", "Storage", "#/storage", "Storage"),
    ("api", "API", "#/api", "API access"),
    ("claude", "Claude", "#/claude", "Claude"),
    ("grok", "Grok", "#/grok", "Grok"),
    ("startup", "Startup", "#/startup", "Startup safety"),
    ("appearance", "Appearance", "#/appearance", "Appearance"),
    ("language", "Language & voice", "#/language", "Language and voice"),
    ("regex", "Regex builder", "#/regex", "Regex builder"),
    ("changelog", "Changelog", "#/changelog", "Changelog"),
    ("history", "Version history", "#/history", "Version history"),
    ("notifications", "Notifications", "#/notifications", "Notifications"),
]
PRIMITIVES = ["buttons", "fields", "menus", "tabs", "dialogs", "navigation", "selection", "typography", "color", "shape", "elevation", "state", "focus", "motion", "accessibility"]
REFERENCE_SHA = hashlib.sha256((ROOT / REFERENCE_FILE).read_bytes()).hexdigest()

def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()

def png(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        image.load()
        return image.size

def make_diff(screen: str, reference: Path, built: Path) -> dict:
    with Image.open(reference).convert("RGB") as left, Image.open(built).convert("RGB") as right:
        if left.size != right.size:
            raise SystemExit(f"{screen}: raw dimensions differ: {left.size} versus {right.size}")
        delta = ImageChops.difference(left, right)
        changed = sum(pixel != (0, 0, 0) for pixel in delta.getdata())
        pixels = left.width * left.height
        stats = ImageStat.Stat(delta)
        maxima = max(extent[1] for extent in delta.getextrema())
        return {
            "schemaVersion": "design-parity-diff/v1",
            "id": screen,
            "inputs": {
                "reference": {"path": rel(reference), "sha256": sha(reference), "width": left.width, "height": left.height},
                "built": {"path": rel(built), "sha256": sha(built), "width": right.width, "height": right.height},
            },
            "comparison": {
                "tool": "Pillow ImageChops.difference",
                "mode": "RGB",
                "threshold": 0,
                "changedPixels": changed,
                "totalPixels": pixels,
                "changedPixelRatio": changed / pixels,
                "meanAbsoluteChannelDifference": sum(stats.mean) / 3,
                "rmsChannelDifference": sum(stats.rms) / 3,
                "maxChannelDifference": maxima,
            },
            "tuple": {"screen": screen, "state": "historical-seeded-default", "theme": "light", "viewport": {"width": 1440, "height": 900}, "scale": 2, "locale": "en-US"},
            "reviewVerdict": "not-approved",
            "reviewReason": "Metrics prioritize review; they do not approve visual parity.",
        }

def row(screen: str, name: str, route: str, section: str, diff: Path) -> dict:
    reference = DESIGN / f"{screen}.png"
    built = SHOTS / f"{screen}.png"
    composite = COMPS / f"{screen}.png"
    rw, rh = png(reference); bw, bh = png(built); cw, ch = png(composite)
    tuple_expected = {"screen": screen, "state": "historical-seeded-default", "theme": "light", "viewport": {"width": 1440, "height": 900}, "scale": 2, "locale": "en-US"}
    tuple_built = dict(tuple_expected); tuple_built["locale"] = "bi"
    audit = {"status": "not-reviewed", "source": "docs/design-system/side-by-side-audit.md", "primitives": {p: {"verdict": "not-reviewed", "reason": "No per-primitive receipt exists for this historical capture; parity remains unverified."} for p in PRIMITIVES}}
    deviations = [
        {"id": "frameless-window-chrome", "scope": "chrome", "reason": "The shipped Windows app uses a custom frameless title bar and controls; the reference app captures only its client area.", "approval": "docs/design-system/m3-port-handoff.md#8 (documented project decision)"},
        {"id": "svg-icons", "scope": "icons", "reason": "The shipped app uses local hand-authored SVG icons instead of the prototype's ligature font; placement and color remain reviewable, glyph geometry is not pixel-equivalent.", "approval": "gui/src/icons.tsx (documented implementation decision)"},
        {"id": "system-cjk-fallback", "scope": "typography", "reason": "The shipped app relies on platform CJK fallback rather than bundling the prototype's network font; the fallback is intentionally documented.", "approval": "ROADMAP.md#appearance (documented project decision)"},
    ]
    return {
        "id": screen, "name": name,
        "reference": {"file": REFERENCE_FILE, "fileSha256": REFERENCE_SHA, "route": f'{REFERENCE_FILE} :: [data-screen-label="{section}"]', "selector": f'[data-screen-label="{section}"]'},
        "realApp": {"route": route, "heading": name, "sourceCommit": CAPTURE_COMMIT, "sourceHash": CAPTURE_COMMIT},
        "tuple": tuple_expected, "captureTuples": {"reference": tuple_expected, "built": tuple_built},
        "deterministicInputs": {"fixture": "historical design mock data versus seeded real-app data", "time": "not-frozen; historical capture receipt unavailable", "motion": "not-recorded; historical capture receipt unavailable", "random": "real-app capture stubbed Math.random=0.001; reference seed not recorded", "fonts": "reference Noto Sans HK/Roboto Flex/Roboto Mono; real app local font stack; receipt unavailable", "network": "reference loopback shell with prototype font request; real app isolated capture; receipt unavailable", "localePolicy": "reference default en; real capture forced bi"},
        "evidence": {"referenceRaw": {"path": rel(reference), "sha256": sha(reference), "width": rw, "height": rh}, "builtRaw": {"path": rel(built), "sha256": sha(built), "width": bw, "height": bh}, "sideBySide": {"path": rel(composite), "sha256": sha(composite), "width": cw, "height": ch}, "diff": {"path": rel(diff), "sha256": sha(diff)}},
        "md3Audit": audit, "deviations": deviations,
        "provenance": {"inventorySourceCommit": CAPTURE_COMMIT, "referenceSourceHash": REFERENCE_SHA, "realSourceCommit": CAPTURE_COMMIT, "referenceCapture": {"tool": "scripts/design-capture-shots.ts", "receipt": "not-recorded", "status": "stale", "reason": "Historical PNG exists but its immutable capture receipt was not committed."}, "builtCapture": {"tool": "scripts/capture-shots.ts", "receipt": "not-recorded", "status": "stale", "reason": "Historical PNG exists but its immutable capture receipt and build artifact hash were not committed."}, "comparison": {"tool": "scripts/build-side-by-side.py", "status": "reconstructed-from-existing-bytes"}, "diff": {"tool": "scripts/build-design-parity-evidence.py", "status": "generated-from-existing-bytes"}},
        "verdict": "stale-evidence", "verdictReasons": ["Reference and built captures use different locale tuples (en versus bi).", "Historical capture receipts and built-artifact hashes are unavailable.", "Per-primitive Material Design 3 review is not recorded for this historical pair."],
    }

def main() -> int:
    DIFFS.mkdir(parents=True, exist_ok=True)
    rows = []
    for screen, name, route, section in SCREENS:
        reference, built, composite = DESIGN / f"{screen}.png", SHOTS / f"{screen}.png", COMPS / f"{screen}.png"
        for path in (reference, built, composite):
            if not path.is_file(): raise SystemExit(f"missing required evidence input: {rel(path)}")
        diff = DIFFS / f"{screen}.json"
        diff.write_text(json.dumps(make_diff(screen, reference, built), indent=2) + "\n", encoding="utf-8")
        rows.append(row(screen, name, route, section, diff))
    try: current = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except (OSError, subprocess.CalledProcessError): current = "not-resolved"
    inventory = {"schemaVersion": "design-parity-inventory/v1", "inventoryId": "desktop-material-design-parity", "sourceCommitAtGeneration": current, "captureSourceCommit": CAPTURE_COMMIT, "referenceFile": REFERENCE_FILE, "screenIds": [s for s, *_ in SCREENS], "rowCount": len(rows), "rows": rows, "status": "stale-evidence; no row is parity-verified"}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} rows and {len(rows)} diff receipts")
    print(f"inventory: {rel(OUT)}")
    print(f"diffs: {rel(DIFFS)}")
    return 0

if __name__ == "__main__": raise SystemExit(main())
