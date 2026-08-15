---
title: Renaming the app
description: Change the name the dashboard shows you, and understand exactly which name every other part of the app keeps using.
---

The dashboard's name is a label, and every other label in this app is yours to change — so this one
is too. **Appearance → App name** replaces the name shown in the navigation rail, in the window
title, and anywhere else the app introduces itself to you.

The important half of this feature is what it does **not** touch. A rename changes presentation and
nothing else: the folder your settings live in, the application id, the installer, and the update
feed all keep the shipped name `opencodex`. That separation is deliberate — if the name you typed
decided where your data was stored, renaming the app would orphan every setting, lock, authenticator
entry and revision you had.

## Where the control is

Open **Appearance** and find the **App name** card, directly above **App logo**. Or press
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> and type `app name` — the command palette finds it by
its label, by its description, and by the words `display name`, `save name` and `reset`.

| Control | What it does |
| --- | --- |
| **Display name** | The name to show. Pre-filled with the name currently in force, never blank. |
| **Save name** | Applies the name. Pressing <kbd>Enter</kbd> in the field does the same thing. |
| **Reset to the shipped name** | One action, back to `opencodex`. No confirmation ladder, nothing else touched. |

The **Save name** button is disabled when there is nothing to save, and says which of the two reasons
applies underneath it: the field is empty, or it already holds the name being shown.

## What reads the display name

Every one of these updates the moment you press **Save name** — there is no restart, and no reload.

| Surface | What it shows |
| --- | --- |
| Navigation rail | The name plate above the version line. |
| App logo, spoken | The logo's accessible name, which on the collapsed rail is the only name of the app on screen. |
| Window title | What the taskbar, <kbd>Alt</kbd>+<kbd>Tab</kbd> and the window list show. The build identity beside it — version, build number, dim sum code name — is unchanged, so a renamed window is still identifiable. |
| First-run welcome | The onboarding wizard's greeting. |

## What keeps the shipped name, always

Two categories, for two different reasons.

**Identity**, because moving it would move your data:

| Thing | Where it actually comes from |
| --- | --- |
| Application-data folder | Electron's `app.getPath("userData")`, derived from `productName` in `electron-builder.yml` at build time. |
| Application id | `appId` in `electron-builder.yml` (`com.opencodex.desktop`). |
| Package name | `name` in `package.json`. |
| Installer and update feed | The release artifacts, built from the same two files. |
| Browser-storage keys | Literal constants (`ocx-m3:v1`, `ocx-applogo:v1`, `ocx-appname:v1`, `ocx-m3:revisions`), each declared beside the store that uses it. |

None of these is built from a name, and none of them reads the rename setting. A user who renames the
app and then looks for their settings has not lost them, because the rename never went near them.

**Outward reports**, because a reader has to know what software they are looking at:

Diagnostics, crash logs, and anything you file as an issue send `opencodex`. A bug report titled
_"Mum's Robot v2.7.42 crashes on startup"_ is a report nobody can act on. The card says so in as many
words, so this is never a surprise.

:::note
The CLI is unaffected in both directions. `ocx` and `opencodex` remain the command names; renaming
the dashboard does not add, remove or alias a command.
:::

## What counts as a name

A name is accepted after normalization, which is applied both when you save it and again every time
it is read back from storage — a hand-edited profile gets the same treatment as the field.

- Trimmed, with runs of whitespace collapsed to single spaces.
- Capped at **60 characters**, counted as code points, so a name ending in an emoji is never cut in
  half.
- Control characters, bidirectional overrides and zero-width characters are stripped. These are
  removed because the name is written into the window title and into an accessible label: a newline
  would break the title, and a bidi override could make the version string beside it read backwards.
- A name that normalizes to nothing is refused, and the card says so rather than silently treating an
  empty field as a reset.
- Typing `opencodex` back in is treated as a reset — it is the same request the reset button makes.

## Language, funny level, and history

The card's copy obeys the app's language modes (English, 廣東話, bilingual) and both funny-level
sliders like any other copy — the sliders themselves live on the dashboard's **Language & voice**
screen, described in [Web Dashboard](/guides/web-dashboard/). What the level never changes is the
facts: which name is in force, that identity does not move, and that diagnostics use the shipped
name are stated at every level, from level 1 to level 5.

Every rename and every reset is recorded in **Version history** as a settings revision, carrying the
previous name, so a rename can be reviewed and undone like any other change.

## Where the setting is stored

In this browser profile's local storage, under `ocx-appname:v1`, as `{"name":"…"}`. It is local to
the machine and the profile: it is never sent anywhere, never included in an export, and never
synchronized. Clearing this site's storage — or the application-data folder, in the desktop shell —
returns the app to the shipped name along with every other local preference.

## Verifying it

1. Rename the app and watch the navigation rail change without a reload.
2. Check the taskbar or <kbd>Alt</kbd>+<kbd>Tab</kbd>: the window title carries the new name and the
   same build identity.
3. Collapse the window below 1240px so the rail shows icons only, and confirm a screen reader still
   announces the app by the new name.
4. Press **Reset to the shipped name** and confirm all three return to `opencodex` in one action.
5. Confirm nothing else moved: your providers, appearance settings, locks and history are all still
   there, because none of them was ever addressed by name.

## Suggested articles

- [Web Dashboard](/guides/web-dashboard/) — the surface this setting lives on, and everything else
  Appearance can change.
- [Export & Bulk Actions](/guides/export-and-bulk-actions/) — what an export does and does not
  carry, including local-only settings like this one.
- [Configuration](/reference/configuration/) — the file-backed settings, which are a different thing
  from browser-local preferences such as the display name.
