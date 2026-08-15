---
title: File converter
description: A categorized adapter catalogue — three families genuinely bundled and proven at runtime, everything else listed honestly as disabled with its exact missing dependency, byte-detected and never guessed from a filename.
---

opencodex ships a universal file converter surface with a categorized adapter catalogue, byte-level
detection, and a rule that governs everything in it: **an adapter is enabled only when every
dependency it needs is bundled inside the installed app and proven to work offline** — never because
a tool happens to be on `PATH`, never because a network service answered, and never because a
developer machine happens to have something installed that a user's machine will not.

## What is actually bundled today, and what that word does and does not mean

Three of the eight required categories carry a real, working, bundled adapter:

- **Documents / PDF**, backed by [pdf-lib](https://pdf-lib.js.org/) — the same dependency that
  already powers the dedicated [PDF Tools](/guides/pdf-tools/) page. Rather than re-implementing
  PDF's seven operations (inspect, split, merge, extract, reorder, rotate, edit metadata) a second
  time on this page, detecting a PDF source here hands off directly to that page, carrying the file
  path with it.
- **Archives / ZIP extraction**, on `node:zlib` alone — no external dependency. `zip-extract.ts` is a
  pure, filesystem-free ZIP central-directory parser; `archive-service.ts` is its fs-facing layer.
  This is the missing read half of the ZIP *writer* [Export & bulk actions](/guides/export-and-bulk-actions/)
  already ships.
- **Structured Data / CSV, TSV, JSON and XML**, also hand-written and bounded with no external
  dependency. `delimited.ts` converts CSV/TSV to and from JSON; `xml-convert.ts` converts JSON to and
  from XML.

**"Bundled" here is a narrower claim than "you can convert this file today," and the catalogue is
honest about the gap rather than blurring it.** PDF is the one family with the full chain: a route,
a CLI command, and a GUI action that actually performs the conversion — detect a PDF on the
Converter page and an **Open in PDF Tools** button appears, handing the file straight to the seven
real operations documented there. ZIP extraction and the four structured-data formats are genuinely
bundled and genuinely proven to work at catalogue-build time (see the next section), and the catalogue
lists them as `bundled: true` — searchable, correctly labelled, with their real operations named —
but **no HTTP route, CLI command, or GUI button exists yet that actually runs one.** Detecting a ZIP
or a CSV file today tells you accurately that opencodex has a working extractor or converter for it
in the codebase; it does not yet let you click anything to use it. That is real, scoped, unfinished
work, not a hidden capability.

Every other format the contract's eight categories name — Images, Audio, Video, Code/Text, and
Binary Encodings, plus 7-Zip/TAR/gzip within Archives and YAML/TOML within Structured Data — is real
in the catalogue too: searchable, listed by name, and honestly marked **disabled**, with the exact
dependency it is missing named next to it. Hiding a capability gap reads as completeness that is not
there, which is exactly what this catalogue's design refuses to do.

## How "bundled" is proven, never just asserted

`bundled: true` is never a static flag in the registry for any format. `buildConverterCatalog()`
runs a genuine runtime self-test for each of the three families every time the catalogue is built:

- **`isPdfLibReachable()`** performs a real `await import("pdf-lib")` and checks that `PDFDocument`
  actually resolves to a function.
- **`isZipExtractReachable()`** builds a small real ZIP archive with the existing writer, then
  extracts it back with the new reader and checks the round trip.
- **`isStructuredDataReachable()`** runs a real JSON→CSV→JSON round trip and a real JSON→XML→JSON
  round trip through the actual conversion functions.

If any of these fails — a broken install, a corrupted dependency — that family's catalogue entry
reports `bundled: false` with the exact reason, rather than the catalogue lying about what a broken
copy of the app can actually do.

## Why the remaining categories are disabled, specifically

Two shapes of "disabled" appear in the catalogue, worth telling apart:

- **Genuinely missing.** Images, Audio and Video need a real codec or transcoder — something like
  libvips/sharp for images or ffmpeg for audio and video — and nothing of the kind is a
  `dependencies` entry in this project's `package.json`. A `PATH`-discovered `ffmpeg` on a developer's
  machine would make these *look* enabled while violating the one rule this catalogue exists to
  enforce, so they stay off. Code/Text and Binary Encodings are in a milder version of the same
  state: Node's own runtime can already produce Base64, hex, and plain-text/line-ending conversions
  with no external dependency at all, but nothing wires any of that through this contract's bounds,
  sandbox, disclosure and output-validation pipeline yet, so they are recorded `NOT_BUILT_YET` rather
  than quietly half-built.
- **A real precedent exists, but is not (or cannot be) wired through this contract.** Within
  Archives, **TAR** and **gzip** are the same shape as ZIP was before this pass — `node:zlib` can
  gzip/gunzip with no dependency, and a TAR reader/writer needs none either — but neither has been
  built yet. **7-Zip** is different in kind: the existing 7z support in `export-archive.ts` spawns
  the real `7z` executable discovered on `PATH`, which this contract's rule explicitly forbids
  counting as "bundled," so 7-Zip cannot become an honest `bundled: true` without a real embedded
  implementation, not just more wiring. Within Structured Data, **YAML** and **TOML** need a
  hand-written, bounded parser of the same shape as the CSV/XML ones this pass built — real,
  buildable work that has not happened yet.

Every one of these reasons is visible directly in the catalogue next to the format it describes —
open the File Converter page, expand any disabled row, and read the exact sentence.

## Byte-level detection, never a filename

Detection reads only a bounded leading slice of a file (**4,100 bytes** at most) and classifies it by
real signatures: PDF's `%PDF-` header, PNG's 8-byte magic number, JPEG's SOI marker, GIF, WebP, BMP,
WAV, FLAC, OGG, MP3, an MP4/WebM `ftyp`/EBML marker, AVI, 7z, gzip, ZIP's local-file-header, and tar,
so on for every binary format the catalogue names. Text-structured formats (JSON, XML, HTML, CSV) use
a bounded heuristic instead, over at most **4,096 bytes** — a `{`/`[` prefix "is consistent with
JSON," never "confirmed as JSON," because a bounded prefix of a large file is expected to be
truncated mid-token. When nothing recognisable is found, the result says so plainly rather than
guessing: an unknown, malformed, empty, or oversized (over **500 MiB**, refused before a byte of
content is read) source is reported with its exact boundary, and no format name is invented for it.

A file extension is never consulted. A `.txt` file containing PNG bytes is detected as PNG.

## Security considerations

Every bundled adapter enforces resource and safety bounds explicitly, and each was proven
load-bearing by disabling it and watching the specific test fail before trusting it green again.

**ZIP extraction:**

| Bound | Limit | What it stops |
| --- | --- | --- |
| Input size | 200 MiB | Refused before a single byte is parsed |
| Central-directory entries | 20,000 | Refused before any entry is read |
| One entry's declared uncompressed size | 500 MiB | Refused as a suspected bomb before inflation |
| Sum of every entry's declared size | 1 GiB | Refused before inflation |
| Compression ratio | 1,200:1 | Refused before inflation — Deflate cannot legitimately exceed roughly 1,032:1, so a declared ratio past this is an early, honest refusal, never the *only* defense |
| Actual inflated bytes | bounded via `inflateRawSync`'s `maxOutputLength` | A hard backstop independent of what a declared size claims |
| Path safety | `assertSafePath` (shared with the existing ZIP writer) | Refuses `..`, an absolute path, a drive letter, or a backslash-separated entry name — and refuses the **whole archive**, never just the one bad entry |
| Integrity | CRC32 per entry | A tampered entry is refused rather than extracted with silently wrong bytes |

**Structured data (CSV/TSV/JSON/XML):**

| Bound | Limit |
| --- | --- |
| Input size | 50 MiB |
| Output size | 150 MiB |
| Nesting depth (JSON and XML alike) | 64 |
| CSV/TSV rows | 500,000 |
| CSV/TSV columns per row | 2,000 |
| CSV/TSV cell length | 100,000 characters |
| XML element/node count | 200,000 |

XML gets two **independent** defenses against a billion-laughs-style entity-expansion attack, proven
independent by disabling each alone and watching the refusal survive for a different reason: every
markup declaration (`<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`, `<!NOTATION`) is refused
outright rather than parsed, and separately, only the five predefined XML entities plus numeric
character references are ever decoded — so a custom entity reference is refused even with no DOCTYPE
present at all. The depth and node-count bounds above catch a flat or deeply-nested bomb built with no
entities at all; the XML parser is iterative (an explicit stack, never recursion), specifically so an
over-limit document is refused as a clean boundary rather than crashing on a call-stack overflow.

Every fs-facing write (`archive-service.ts`'s multi-file extraction, `structured-service.ts`'s
single-file conversion) is atomic — a staging directory or temp file, then a rename — so a failed
conversion leaves the destination completely untouched, including when the destination already holds
unrelated content.

Lossy conversions are disclosed on every successful result, not left for a caller to discover later:
CSV/TSV state that every cell becomes plain text (numbers/booleans/null all read back as strings) and
that a nested value is JSON-stringified into its cell; XML states that attributes are never emitted on
the write side, that scalars become plain element text, and that attribute ordering and insignificant
whitespace are not guaranteed through a round trip.

## Reached from the dashboard, the CLI, and one shared module underneath both

- **Dashboard:** the File Converter page, reachable from the nav. A source path field runs detection;
  the catalogue below it is searchable per category, each with its own regex-capable search field.
  Only a detected PDF shows a working action button today.
- **CLI:** `ocx convert catalog` lists every format's status; `ocx convert detect <path>` runs the
  same byte-level detection headlessly. Neither has an `ocx convert run`-style execution command yet.
- **Underneath both:** `src/lib/converter/{types,bounds,detect,registry,service}.ts`. The dashboard's
  catalog fetch and the CLI's `catalog` subcommand call the exact same `buildConverterCatalog()`; the
  dashboard's detect action and `ocx convert detect` call the exact same `detectSourceAtPath()`. The
  CLI and the dashboard cannot disagree about what the catalogue says or what a detection pass found,
  because there is only one implementation for either question to be answered by.

Both surfaces are gated the same way PDF Tools and the export/VS Code handoff are: refused the
instant the management proxy is reachable from the LAN, because detection and any future conversion
both read arbitrary local files.

## Verification

- `tests/converter-detect.test.ts` — **23 tests**, including the adversarial cases (a NUL byte,
  random bytes, ordinary prose) and the "returns `undefined`, never a guess" contract.
- `tests/converter-registry.test.ts` — **12 tests**, covering both branches of every family's
  reachability self-test.
- `tests/converter-zip-extract.test.ts` — **19 tests**; `tests/converter-archive-service.test.ts` —
  **9 tests**. Path traversal, both zip-bomb bounds independently, CRC32 tamper detection, and atomic
  writes are each exercised by watching the specific defense fail on purpose first.
- `tests/converter-delimited.test.ts` — **20 tests**; `tests/converter-xml.test.ts` — **31 tests**;
  `tests/converter-structured-service.test.ts` — **12 tests**. Both independent XML entity-expansion
  defenses, the JSON depth bound, and the atomic single-file write are covered the same way.
- `gui/tests/converter-handoff.test.ts` and `gui/tests/converter-page.test.tsx` — **10 tests**
  together, covering the one-shot PDF hand-off (read-and-strip, read-once, no-param, the built hash
  itself) and the dashboard page's own wiring.

All of the above pass with `bun test`; `bun run typecheck` and `bun x tsc -b` inside `gui/` are both
clean.

## What is not built yet

The full contract also asks for real conversion **execution** for ZIP and structured data (a route, a
CLI command, and a GUI action — today only PDF has this, via the hand-off), batch selection with the
project's bulk-action rules, progress and cancellation, a result history, an unlimited resumable
queue with crash recovery, YAML and TOML support, and Images/Audio/Video/Code-Text/Binary-Encodings
adapters generally. `docs/FEATURE-INVENTORY.md` records the whole of this as real, scoped, future
work rather than implying it is done.

## Suggested articles

- [PDF tools](/guides/pdf-tools) — the one family this converter can actually run end to end today,
  and the seven operations a detected PDF hands off to.
- [Export & bulk actions](/guides/export-and-bulk-actions) — the existing ZIP/7z **writer** this
  converter's new ZIP **reader** complements.
- [Web dashboard](/guides/web-dashboard) — the tabbed shell the Converter page lives inside.
- [Ollama suite manager](/guides/ollama-manager) — the other locally-gated feature that shipped in
  the same cycle, with the same "catalogue is honest, execution is partial" shape.
