---
title: Exporting lists and acting in bulk
description: Export any list to fifteen formats, as a file or a ZIP or a 7z archive, open it in VS Code, and act on many rows at once without the app lying about what it did.
---

Every list opencodex keeps — the request log, providers, combos, API keys, custom models, token
usage, the changelog, version history, MCP servers — can be exported to any of fifteen formats, on
its own or bundled into an archive, from the dashboard, the management API or the CLI. The same
lists support multi-row selection so an action you would otherwise repeat forty times is done once.

Both features are built around the same idea: **the app must not overstate what it did.** An export
that quietly drops nested fields, or a bulk delete that reports forty when six were protected, is
worse than no feature at all, because you stop checking.

## Formats

| Format | Extension | Good for |
| --- | --- | --- |
| `json` | `.json` | Anything. The only format guaranteed lossless for every list. |
| `jsonl` | `.jsonl` | Streaming into another tool one row at a time. |
| `yaml` | `.yaml` | Reading by eye; config-shaped data. |
| `toml` | `.toml` | Config files. |
| `xml` | `.xml` | Legacy interchange. |
| `csv`, `tsv` | `.csv`, `.tsv` | Spreadsheets. Flat only — see fidelity below. |
| `markdown` | `.md` | Pasting into an issue or a document. |
| `html` | `.html` | Sharing a readable table. |
| `sql` | `.sql` | Loading into a database. |
| `ts`, `js`, `py`, `go` | `.ts`, `.js`, `.py`, `.go` | Dropping straight into code as a literal. |
| `json-schema` | `.schema.json` | Describing the shape rather than the data. |

### Fidelity is computed from your data, not the format name

CSV is lossless for a flat list and lossy for a nested one, so the warning cannot be decided from the
format alone. `GET /api/export/capabilities` runs the real rows through each serialiser and reports
what each would actually lose, which is why the dashboard can tell you before you commit rather than
after you open the file.

The same note travels with the file itself in the `X-Export-Fidelity` response header, so a caller
that skipped the capabilities call still cannot claim it was not told. On the CLI the notes go to
**stderr**, so a piped document stays clean:

```bash
ocx export data requests --format csv > requests.csv
```

## Archives

Ask for `zip` and you get a deterministic archive written natively — no external tool, no temporary
install. Ask for `7z` and opencodex shells out to a real 7-Zip, exposing its full option surface:
compression method and level, dictionary and word size, solid blocks, threads, volume splitting,
password, and header encryption.

Two rules matter more than the options:

- **Header encryption defaults ON when you set a password.** 7-Zip's own default leaves file *names*
  readable in an encrypted archive. If you encrypted an export, you meant the file names too.
- **A missing 7-Zip is refused, never silently downgraded.** If 7-Zip is not installed the request
  fails with `409` and says so. Handing back an unencrypted ZIP to someone who asked for an
  encrypted 7z would tell them their data is protected when it is not.

Whatever is written to disk during a 7z export is plaintext until the archive exists, so the staging
directory is deleted when the request ends, successfully or not.

## Opening the result in VS Code

`openInVsCode` writes the export to its own directory under the system temp root and opens it. It is
never written into your Downloads folder — that directory is one you actively use, and an export
colliding with a file you care about is a bad trade for saving a click. If VS Code cannot be found,
the response says so and links the download rather than failing silently.

## What is never exported

Three of these lists sit next to live credentials, and none of them exports one:

- **Providers** export `apiKeyConfigured: true | false`. Whether a key is set is the useful fact.
- **API keys** export the id, name, creation date and a 12-character prefix — enough to match a row
  against the dashboard, which is what an export of that list is for.
- **MCP servers** export the *names* of their environment variables and connection headers, never the
  values. Both routinely hold a bearer token.

An export is a file whose entire purpose is to be moved somewhere else, and the formats include HTML
and Markdown — precisely what people paste into an issue. Moving real secrets is what `ocx export`
without a subcommand is for, and it says so before it writes anything.

### The usage list and estimated tokens

`usage` aggregates the request log by provider and model. If **any** request in a bucket reported
estimated usage, the whole bucket is marked `estimated: true`. A total that mixes measured and
estimated numbers is estimated, and reporting it as measured because most rows were is the one error
here that costs real money.

## Bulk actions

Lists that support selection give you a tick box per row, shift-click for ranges, and select
all / invert / clear. The bar appears when something is selected and is absent otherwise — a bar
that is always there is chrome.

It refuses the three ways a bulk action normally lies:

1. **A "select all" that means something else.** On a filtered list, "all" can mean the page, the
   search results, or the whole collection. The bar names which: *"3 selected matching the current
   search"* cannot be misread as the collection.
2. **Silently skipped rows.** A row that cannot take part is counted separately and the reason is
   shown — *"1 excluded (open with unsaved changes)"* — because "6 skipped" is not actionable and
   "6 skipped: pinned" is.
3. **Claiming the batch succeeded.** A run that fails at item thirty did twenty-nine things. The
   summary counts successes and failures separately and never says Done when it was not.

Destructive actions stop for a blocking confirmation that states the count and what cannot be
undone. Long runs stay cancellable, and cancelling reports how many were not attempted rather than
pretending the batch simply ended.

## From the CLI

```bash
ocx export data --list
```

```bash
ocx export data usage --format csv --out usage.csv
```

An unknown list or format exits `2` and names the valid ones. Nothing is written on a bad argument.

## From the API

Both endpoints sit behind the standard management-auth gate.

```
GET  /api/export/capabilities        formats, per-dataset fidelity, 7z and VS Code availability
POST /api/export                     { dataset, format | formats, archive?, sevenZip?, openInVsCode? }
POST /api/export/open                { path }
```

`POST /api/export` refuses an unknown format with `400` naming the real spelling rather than
dropping it and returning an archive missing a format you asked for.

## Suggested articles

- [Log files and undoing a clear](/guides/log-files) — where the request log this exports actually
  lives on disk.
- [Web dashboard](/guides/web-dashboard) — the screens these lists appear on.
- [CLI reference](/reference/cli) — every `ocx` command, including the rest of `export`.
