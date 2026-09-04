---
title: Personal vocabulary
description: Load a bounded local JSON glossary for authored interface wording without uploading it.
---

The settings page includes a personal-vocabulary row even before a file exists. Choose a local
JSON file through the native file picker to apply replacements to authored interface wording on
this documentation site. The file is read in the browser and is never uploaded or sent to a
server.

## Neutral schema

The site accepts only version `1` with a flat `entries` object:

```json
{
  "version": 1,
  "entries": {
    "alpha": "beta"
  }
}
```

The example is intentionally neutral; it is not a bundled vocabulary. The validator rejects a
malformed document, duplicate or unsafe keys, unknown top-level fields, unknown versions,
non-string values, empty or overlong keys, overlong replacements, more than 500 entries, nested
objects beyond depth 2, and payloads larger than 64 KiB. Validation completes before any
replacement is applied, so a rejected file cannot partially change the interface.

## Browser-local persistence and recovery

After a successful validation, the complete validated document is cached in browser storage and
revalidated through the same schema on the next load. A corrupt, stale, or unsupported cache is
discarded fail-closed and the original shipped wording remains active. Replacing a file leaves the
previous valid document active until the replacement has passed validation. **Clear local
vocabulary** removes the cache and restores the original wording immediately.

The loader has no network route. It does not retain the selected file name or path, and the
ordinary settings, exports, history, diagnostics, and public documentation contain no user file
contents or replacement values. If the browser refuses storage, the validated selection remains
active for the current page only and the next load safely returns to the original wording.

## Search and School mode

The row is indexed by the settings search and its adjacent anchored regex builder. School mode is
the documentation site's browser-storage equivalent of the shared product mode: while it is on,
the site forces English, removes bilingual/playful controls, dim-sum controls, and the vocabulary
row from the visible settings and search results, while preserving the stored choices. The School
mode row remains reachable even if a search query is active, so the visitor can turn it off. Clear
this site's browser data to reset the local mode.

## Verification

The focused contract and mounted-surface tests cover the empty, loaded, invalid, replacement,
clear, persistence, cache refusal, no-network, latest-operation-wins, search, anchored-builder,
and School-mode suppression paths. The docs-site build is the packaged proof that the settings
island and its localized dictionaries compile into the static site.
