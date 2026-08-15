---
title: PDF tools
description: Inspect, split, merge, extract, reorder, rotate and edit metadata on real PDF files, with every write reopened from disk and proven against what was asked for before it counts as a success.
---

opencodex can inspect, split, merge, extract pages from, reorder, rotate, and edit the metadata of a
PDF file already on the machine it runs on — from the dashboard, the CLI, or the management API. It
is a small, deliberately bounded surface built on [pdf-lib](https://pdf-lib.js.org/), a pure
JavaScript library with no native bindings and no network calls of its own, so it ships inside the
installed app and works with the network unplugged.

This is **not** the universal file converter the project's completeness inventory also names. That
is a separate, still-unbuilt surface with a categorized adapter catalogue covering images, audio,
video, archives and structured data alongside PDF. PDF tools is built so that converter can adopt
these operations later, but it does not attempt to be it.

## The one property every write shares: it is proven, not assumed

A converted file is only as good as the proof that it actually landed correctly. Every mutating
operation here follows the same four steps:

1. **Read the source, bounded.** The file is stat'd before it is read; anything over 200 MiB is
   refused without a single byte being touched.
2. **Run in a bounded worker.** The actual pdf-lib work happens inside a `node:worker_threads`
   worker with a heap ceiling, a wall-clock timeout, and cancellation support — not the main
   process, and not unbounded.
3. **Write atomically.** The result is written to a temporary file in the same directory as the
   destination, then renamed into place. A partially written destination is never observable.
4. **Reopen from disk and validate.** The file that was just written is read back — not the bytes
   this process already had in memory — and reparsed. Its page count, the width/height/rotation of
   every page, and every metadata field the request asked to set are compared against what the
   request actually specified. **Any mismatch deletes the file and reports the exact failure**,
   without leaking the source path, the destination path, or document content into the message.

That fourth step is the load-bearing one. It catches two different kinds of bug at once: a
disk-level problem (a truncated or corrupted write) and a logic-level problem (an operation that
computed the wrong pages, the wrong order, or the wrong rotation) — because the expectation each
write is checked against is derived from the source document and the request, independently of the
bytes the operation actually produced.

### What "page order" verification actually checks

It is not a byte-for-byte content hash. Each output page's expected width, height and rotation are
recorded from the source document before the write happens; after reopening, the same three values
are compared, in position, against what landed on disk. This catches the overwhelming majority of
real bugs — a dropped page, a swapped pair, a wrong rotation, a page count that does not match — but
two source pages of identical size and rotation are indistinguishable to this check. That limit is
recorded here rather than implied away.

## Capabilities are disclosed before anything is written

Before any operation runs, the source is assessed for four boundaries:

| Boundary | Meaning |
| --- | --- |
| `not-a-pdf` | No `%PDF-` header within the first 2 KiB, or no `%%EOF` trailer within the final 4 KiB — decided from the bytes, never from a filename extension or a claimed content type. |
| `malformed` | The header and trailer are present, but pdf-lib cannot parse the body. |
| `encrypted` | The source is password-protected. **pdf-lib cannot decrypt anything** — there is no password option on its loader — so an encrypted PDF is refused outright rather than opened blind. Provide a decrypted copy. |
| `bounds-exceeded` | The document has more than 10,000 pages. |

A source that fails any of these stays completely untouched: `inspect` reports the boundary and a
plain-language reason, and every mutating operation refuses before it does any work.

**Digital signatures are a separate, softer disclosure.** pdf-lib has no signature-preservation
support, so writing a modified copy of a signed PDF always invalidates the signature. A signed
source is detected (a byte-level scan for `/ByteRange` alongside a `/Type /Sig` marker) and
`inspect` reports it — but it does not block a mutating operation. Instead, every write requires
`acknowledgeSigned: true` on a signed source; omitting it is refused with the exact reason, so the
caller cannot land an edit on a signed document without having seen the disclosure.

## From the dashboard

The **PDF tools** page (system navigation) takes an absolute source path, lets you Inspect it to see
page count, per-page size and rotation, metadata and any boundary, then choose an operation and its
destination path(s). Recent operations are kept in a local, searchable history (with the app's usual
plain-text-or-regex search) so you can see what you have already tried.

There is no native file-browse dialog on this page — or on any page in the app yet, this is a
cross-cutting gap rather than something specific to PDF tools — so the source and destination
fields are plain absolute-path text inputs.

## From the CLI

```bash
ocx pdf inspect C:\Users\you\Documents\report.pdf

ocx pdf split C:\report.pdf --ranges 1-2,3-5 \
  --destinations C:\out\part-a.pdf,C:\out\part-b.pdf

ocx pdf merge --sources C:\a.pdf,C:\b.pdf --destination C:\merged.pdf

ocx pdf extract C:\report.pdf --pages 3,1,2 --destination C:\excerpt.pdf

ocx pdf reorder C:\report.pdf --order 3,1,2 --destination C:\reordered.pdf

ocx pdf rotate C:\report.pdf --rotations 1:90,2:180 --destination C:\rotated.pdf

ocx pdf metadata read C:\report.pdf
ocx pdf metadata write C:\report.pdf --destination C:\out.pdf --title "New title"
```

Every mutating command accepts `--acknowledge-signed`. All of them are thin clients over the same
management API the dashboard calls (`--json` for machine-readable output), which is what keeps the
CLI and the dashboard from ever disagreeing about what an operation actually did.

## From the API

Every route is local-machine-gated exactly like `POST /api/export/open`'s VS Code handoff: refused
the instant the proxy is reachable from the LAN, because reading and writing arbitrary local files by
path is not something a remote administrator credential should be able to trigger.

```
POST /api/pdf/inspect     { path } -> capabilities, pages, metadata
GET  /api/pdf/metadata?path=       -> metadata fields
POST /api/pdf/metadata    { path, destination, fields, acknowledgeSigned? }
POST /api/pdf/split       { path, ranges, destinations, acknowledgeSigned? }
POST /api/pdf/merge       { paths, destination, acknowledgeSigned? }
POST /api/pdf/extract     { path, pages, destination, acknowledgeSigned? }
POST /api/pdf/reorder     { path, order, destination, acknowledgeSigned? }
POST /api/pdf/rotate      { path, rotations, destination, acknowledgeSigned? }
```

A refused request reports `{ error, boundary? }`. `boundary` is present when the *source* cannot
satisfy the request (encrypted, malformed, etc. — HTTP 422); its absence means the request itself
was malformed (HTTP 400) or the reopen-validation rolled the write back.

## What is bundled, and what is not

`pdf-lib` is a production dependency (`package.json`'s `dependencies`, not `devDependencies`), so it
ships inside `node_modules/**` in every packaged build alongside the rest of the app's runtime tree
— the same mechanism that bundles every other dependency the desktop installer needs. It has no
native bindings (no `.node` files anywhere under it) and makes no network calls, so it works fully
offline.

The sandbox is a `node:worker_threads` worker with a bounded heap and a wall-clock timeout — a
separate V8 heap and event loop in the same process, which is the isolation this app already uses
elsewhere (`src/storage/policy-job.ts`). It is not a separate OS process or a separate filesystem
namespace; the operations that run inside it make no filesystem or network calls of their own, which
is what keeps "no ambient network" true in practice. A stronger process-level sandbox is a known,
recorded gap rather than something this surface claims to have.

## Suggested articles

- [Export & bulk actions](/guides/export-and-bulk-actions) — the app's other file-producing surface,
  and where its ZIP/7z archive building lives.
- [Web dashboard](/guides/web-dashboard) — the tabbed shell PDF tools' page lives inside.
- [CLI reference](/reference/cli) — every `ocx` command, including the rest of `pdf`.
