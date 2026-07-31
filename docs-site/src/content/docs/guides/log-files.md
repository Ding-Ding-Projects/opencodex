---
title: Log files and undoing a clear
description: Where opencodex writes its logs on disk, how large they are allowed to get, and how to put them back after clearing them.
---

opencodex writes its logs to plain files inside its own data directory, so you can read them in a
text editor without the dashboard running, and they survive a restart. Clearing them from the
dashboard commits them to a local git history first, so a clear can be undone.

## Where the files are

Both live in the opencodex data directory — `~/.opencodex` by default, or whatever `OPENCODEX_HOME`
points at. Nothing is ever written inside your own project folders.

| File | What it holds | Read by |
| --- | --- | --- |
| `usage.jsonl` | One JSON row per request: ids, model, provider, status, duration, token counts. Never prompts, never credentials. | Logs screen, Usage screen |
| `logs/opencodex.log` | The proxy's own diagnostic lines, one per line, each prefixed with an ISO-8601 timestamp. | Debug tab |
| `logs/opencodex.log.1` … `.3` | Rotated generations of the same file, newest first. | Debug tab |

The Logs screen prints both absolute paths above the table, so you can copy the one you want without
guessing at it.

```bash
# Windows PowerShell
Get-Content -Tail 50 -Wait $env:USERPROFILE\.opencodex\logs\opencodex.log
```

## Retention

The app log is bounded by arithmetic, not by a background job that might not run:

- the live file rotates once it reaches **2 MiB**,
- **3** rotated generations are kept,
- so `logs/` never exceeds **8 MiB** — four files of 2 MiB.

When a rotation happens the oldest generation is **deleted**, not archived. Nothing else prunes it,
and nothing needs to.

`usage.jsonl` is append-only and is **not** rotated, because the Usage screen's totals are computed
from the whole of it — trimming it would silently change numbers you have already been shown. It
grows slowly (one short JSON line per request) and you clear it deliberately, as below.

## Clearing the logs

**Logs → Clear logs** deletes both files. The confirmation names the exact counts first, because all
three surfaces built from them — the Logs table, the Debug tab, and the Usage totals — go back to
empty together.

Before anything is deleted, the files are committed into the local git repository that already
records account and settings changes (see the version history in `~/.opencodex/.git`). Only then are
they unlinked. That ordering is the whole guarantee: a commit made *after* a deletion would record
the absence, not the content.

If that commit cannot be made — git missing, index locked, disk full — **the clear still happens**
and the notification says the deletion cannot be undone. opencodex will not refuse to do what you
asked because its own bookkeeping repository was busy, and it will not pretend the undo exists when
it does not.

## Putting them back

Open **Version history**. Log snapshots appear on the same timeline as account and settings
snapshots, labelled *Log files*, with a subject naming what was cleared — `cleared 1,204 request log
rows and 87 app log lines`, not `Updated`. Select one and press **Restore logs**.

Restoring a log snapshot does **not** drain requests and does **not** restart the proxy. Logs are not
credentials; nothing in flight is reading them.

The history is **append-only**. Restoring commits the logs as they stand *first*, then writes the
chosen revision over them, then commits that too. So:

- an undo can be undone, and that undo undone in turn,
- nothing is ever rewritten or dropped from the log,
- and you can move between two states without risking either.

Log files that were created *after* the revision you restore are **kept, not deleted**, and the
notification lists them. Deleting them would be the more literal reading of "restore", and it would
also destroy data in the name of recovering it.

## Privacy and scope

- The history repository is **local only**. It is created with no remote and nothing in opencodex
  ever pushes it. Do not add a remote and do not copy it into a synced folder — it also contains the
  account snapshots, which hold OAuth refresh tokens and provider API keys.
- Bytes are stored verbatim. The repository carries a `.gitattributes` with `* -text`, so git's
  line-ending conversion cannot rewrite what you committed; a file restored from history is
  byte-for-byte what went in.
- Request logs never contain prompts, responses, or credentials. Upstream error messages are
  redacted before they are written.

## From the command line

```bash
# every snapshot, newest first
git -C ~/.opencodex log --oneline

# what a given snapshot held
git -C ~/.opencodex show <commit>:usage.jsonl
git -C ~/.opencodex show <commit>:logs/opencodex.log
```

## API

| Route | What it does |
| --- | --- |
| `GET /api/logs/footprint` | Where the logs are, how many rows and lines, and the retention bound. |
| `DELETE /api/logs` | Commits the logs, then deletes them. Answers `snapshot: false` when the commit could not be made. |
| `POST /api/logs/restore` | `{ commit }` — puts a revision back, appending two commits so the restore is itself undoable. |
