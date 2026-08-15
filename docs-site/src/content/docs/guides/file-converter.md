---
title: File converter
description: A categorized adapter catalogue — every format the contract names, listed honestly as bundled-and-enabled or disabled-with-its-exact-reason, byte-detected and never guessed from a filename.
---

opencodex ships a universal file converter surface with a categorized adapter catalogue, byte-level
detection, and a rule that governs everything in it: **an adapter is enabled only when every
dependency it needs is bundled inside the installed app and proven to work offline** — never because
a tool happens to be on `PATH`, never because a network service answered, and never because a
developer machine happens to have something installed that a user's machine will not.

## What is actually enabled today: Documents / PDF, and nothing else

Exactly one of the eight required categories is enabled: **Documents / PDF**, backed by
[pdf-lib](https://pdf-lib.js.org/) — the same dependency that already powers the dedicated
[PDF Tools](/guides/pdf-tools/) page, tested there across 70 cases with no network access and no
external process. Rather than re-implementing PDF's seven operations (inspect, split, merge,
extract, reorder, rotate, edit metadata) a second time on this page, detecting a PDF source here
hands off directly to that page, carrying the file path with it. One working implementation, reached
from two places, instead of two implementations that could quietly drift apart.

Every other format the contract's eight categories name — Images, Audio, Video, Archives, Structured
Data/Spreadsheets, Code/Text, and Binary Encodings — is real in the catalogue: searchable, listed by
name, and honestly marked **disabled**, with the exact dependency it is missing named next to it.
Hiding a capability gap reads as completeness that is not there, which is exactly what this
catalogue's design refuses to do.

## Why the other seven categories are disabled, specifically

Two shapes of "disabled" appear in the catalogue, and they are worth telling apart:

- **Genuinely missing.** Images, Audio and Video need a real codec or transcoder — something like
  libvips/sharp for images or ffmpeg for audio and video — and nothing of the kind is a
  `dependencies` entry in this project's `package.json`. A `PATH`-discovered `ffmpeg` on a developer's
  machine would make these *look* enabled while violating the one rule this catalogue exists to
  enforce, so they stay off.
- **A real precedent exists, but is not wired through this contract yet.** Two cases are worth
  naming precisely, because they are the strongest near-term candidates for a second bundled family:
  - **ZIP.** `src/lib/export-archive.ts` already writes ZIP archives on `node:zlib` alone — no
    external dependency, genuinely bundled and offline — but it only *creates* archives; it has no
    extraction path, and it has not been wired through this converter's bounds, sandbox, disclosure
    and output-validation pipeline. That is real future work, not a missing-dependency gap.
  - **Structured Data (CSV, JSON, YAML, XML, TOML).** JSON is native to the JavaScript runtime, and a
    bounded, hand-written CSV/YAML/XML/TOML parser needs no external dependency either — the same
    shape as the ZIP writer above. None of that has been built yet, so these formats stay disabled
    rather than half-built.
  - **7-Zip** is the one archive format that genuinely cannot be bundled without a real dependency:
    the existing 7z support in `export-archive.ts` spawns the actual `7z` executable discovered on
    `PATH`, which this contract's rule explicitly forbids counting as "bundled."

Every one of these reasons is visible directly in the catalogue next to the format it describes —
open the File Converter page, expand any disabled row, and read the exact sentence.

## Byte-level detection, never a filename

Detection reads only a bounded leading slice of a file (4,100 bytes at most) and classifies it by
real signatures: PNG's 8-byte magic number, JPEG's SOI marker, a ZIP local-file-header, an MP4
`ftyp` box, and so on for every binary format the catalogue names. Text-structured formats (JSON,
XML, CSV) use a bounded heuristic instead — a `{`/`[` prefix "is consistent with JSON," never
"confirmed as JSON," because a bounded prefix of a large file is expected to be truncated mid-token.
When nothing recognisable is found, the result says so plainly rather than guessing: an unknown,
malformed, empty, or oversized source is reported with its exact boundary, and no format name is
invented for it.

A file extension is never consulted. A `.txt` file containing PNG bytes is detected as PNG.

## Reached from the dashboard, the CLI, and one shared module underneath both

- **Dashboard:** the File Converter page, reachable from the nav. A source path field runs detection;
  the catalogue below it is searchable per category, each with its own regex-capable search field.
- **CLI:** `ocx convert catalog` lists every format's status; `ocx convert detect <path>` runs the
  same byte-level detection headlessly.
- **Underneath both:** `src/lib/converter/{registry,service,detect}.ts`. The dashboard's catalog
  fetch and the CLI's `catalog` subcommand call the exact same `buildConverterCatalog()`; the
  dashboard's detect action and `ocx convert detect` call the exact same `detectSourceAtPath()`. The
  CLI and the dashboard cannot disagree about what the catalogue says or what a detection pass found,
  because there is only one implementation for either question to be answered by.

Both surfaces are gated the same way PDF Tools and the export/VS Code handoff are: refused the
instant the management proxy is reachable from the LAN, because detection reads arbitrary local
files.

## What is not built yet

The full contract also asks for a preview, batch selection with the project's bulk-action rules,
progress and cancellation, a result history, an unlimited resumable queue with crash recovery, and
real conversion execution for every enabled format. None of that exists for any category beyond the
PDF hand-off described above — this pass built the catalogue, the registry contract, byte-level
detection, and adopted PDF Tools as the first genuinely bundled family. The rest is real, scoped,
future work, and `docs/FEATURE-INVENTORY.md` records it as such rather than implying it is done.
