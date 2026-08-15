---
title: Secret & display-name history
description: A password-protected, encrypted local history of every TOTP-entry change and every rename of this app — and exactly what it does and does not protect.
---

Every time you add, change or remove an account in the built-in **Authenticator**, and every time you
rename this app, that change is recorded — separately from every other local history this app keeps —
in its own encrypted, password-protected git repository. That is what makes "I deleted the wrong
account" or "what was this called last week" recoverable, without ever writing a TOTP secret to disk
in the clear.

## Where the control is

Open **Authenticator** and press **History…**, beside **Export secrets…**. The panel is reachable from
there for both kinds of change this history keeps — the display-name history lives here too, rather
than on Appearance, because this is the one password-protected surface the contract asks for.

## Setting it up, and opening it

The first time you open it, you choose a password or an authenticator code to protect it — the exact
same choice, and the exact same underlying credential store, that every other **toy lock** in this app
uses (see [Locks & Support Tickets](/guides/locks/) if that feature exists in your build). It is a
separate credential from any other lock you have set: nothing here is shared or inherited.

Opening the panel needs that credential. Restoring a revision, exporting the history, and changing how
long history is kept **each ask for it again** — there is no "unlocked once, free access to everything"
state. That repetition is deliberate: each of those four actions is independently gated, exactly as the
contract requires.

## What gets recorded, and what does not

| Action | Recorded as |
| --- | --- |
| Adding an account | `Account added` |
| Editing an account's issuer/name | `Account changed` |
| Removing one account | `Account removed` |
| Removing several at once | `Accounts removed` |
| Renaming this app | `App renamed` |
| Resetting the app's name | `App name reset` |
| Restoring a past revision | `Restored from history` |
| Changing how long history is kept | `Retention changed` |

Every entry carries a **redacted** summary — issuer, account, group, or the previous/next display
name — that is always safe to read, search and filter without unlocking anything beyond the panel
itself. An account mutation additionally carries an **encrypted snapshot** of the full authenticator
state at that moment (TOTP secrets included), protected with AES-256-GCM under a key that lives only
in this Windows account's DPAPI-protected credential vault — never in this repository, never derived
from the password you set for the panel. A copy of the repository on its own, or on a different
machine or account, decrypts nothing.

:::note
A display-name change carries no encrypted snapshot at all — a name is not a secret, so there is
nothing to protect beyond the redacted before/after pair already shown.
:::

## Restoring a revision

Select an entry, press **Restore this revision**, and confirm with your password or code again. An
account-history restore writes the full snapshot back — every entry and group as they were at that
moment — and is itself recorded as a new `Restored from history` entry, never as a silent rewrite: the
history is append-only, so a restore can always be restored away from in turn. A display-name restore
re-applies that name through the normal rename path, which records its own entry the same way an
ordinary rename does.

If a revision shows **"This entry has no recoverable snapshot"**, the encryption key was unavailable
the moment it was written (see below) — its redacted summary is still there, but there is nothing to
restore from it.

## Exporting

**Export redacted history** downloads exactly what the panel already shows you: issuer, account,
group, timestamps, and display-name changes — never a TOTP secret, never the encrypted bytes
themselves. It needs the same fresh confirmation as a restore.

## Retention

Set a number of days and press **Apply** to prune anything older, or leave it blank to keep everything
forever. Pruning physically rewrites the underlying repository to hold only what the policy keeps —
it is the one action here that is not append-only, which is exactly why it is behind its own fresh
confirmation. It never prunes to nothing: the single most recent entry always survives, whatever the
policy says.

## Fail-safe, and honest when something did not work

If the DPAPI vault or git itself is unavailable, an account mutation still completes — your entry is
still added, changed or removed — but you are told the history commit did not happen, with a plain
reason, rather than a silent "it worked". Nothing here is ever able to block or roll back the real
change to your accounts on the strength of the history feature being unavailable.

## Where it lives, and what it is separate from

This is its own local-only git repository, in a `secret-history` subdirectory inside this app's
configuration directory — deliberately **not** the same repository the [account & log
history](/guides/web-dashboard/) keeps for provider accounts and OAuth tokens. That other history is
plaintext by design, with your explicit consent, for a different set of credentials; mixing a TOTP
secret into it would be exactly the mistake this feature exists to prevent. Never synced, never
pushed, never leaves this machine.

## Suggested articles

- [Web Dashboard](/guides/web-dashboard/) — the account/log history this feature is deliberately
  separate from, and everything else the dashboard can do.
- [Renaming the app](/guides/rename-the-app/) — the display-name feature half of this history.
- [Export & Bulk Actions](/guides/export-and-bulk-actions/) — how this export compares to the app's
  other export routes, including the one that really does contain plaintext secrets.
