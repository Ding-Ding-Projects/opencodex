---
title: Debug sandbox — run the app without touching the machine
description: OPENCODEX_DEBUG_SANDBOX runs the real dashboard and proxy while blocking the two things that are awkward to undo — writing config.json and issuing a pairing key.
---

Set `OPENCODEX_DEBUG_SANDBOX=1` and opencodex runs normally with two things switched off: it will
**not write its config to disk**, and it will **not issue a pairing key**. Everything else behaves as
it always does — the dashboard renders, settings toggle, the pairing panel opens, the QR code appears
and its countdown runs.

It exists so the app can be driven, demonstrated and screenshotted without leaving anything behind.

## Turning it on

```bash
OPENCODEX_DEBUG_SANDBOX=1 ocx start
```

On Windows, in PowerShell:

```powershell
$env:OPENCODEX_DEBUG_SANDBOX = "1"; ocx start
```

`1`, `true`, `yes` and `on` all switch it on, in any case. Anything else — including the empty
string, `0` and `false` — leaves it off, so exporting the name with no value in a shell profile does
not quietly arm it.

## What it blocks

| Blocked | Normally | In the sandbox |
| --- | --- | --- |
| Config writes | Every settings change is written to `config.json` | Nothing is written. The file is not created, and an existing one is left byte-for-byte alone |
| Pairing | A correct code mints a data-plane key and persists it | The claim is **refused** with the reason `sandbox`. No key is minted |

These two are singled out because they are the two that are awkward to undo:

- **Config writes.** Toggling *Reachable from other devices* just to see what the screen does
  rewrites `config.json`, and on the next start the proxy really is published to your network. There
  was previously no way to look at that screen in its enabled state without actually enabling it.
- **Pairing.** A key minted to take a screenshot is a live credential that outlives the screenshot,
  and whoever made it is the least likely to remember to revoke it.

Because the config write is what publishes the proxy, blocking it also means the sandbox cannot
publish the proxy to your network by accident.

## How you can tell it is on

Three ways, deliberately — a mode that silently stops settings saving is indistinguishable from a
bug, and "my settings do not save" is the kind of thing that gets reported as data loss.

1. **The proxy logs it once**, the first time it blocks anything:
   ```
   [debug-sandbox] OPENCODEX_DEBUG_SANDBOX is set: config changes are NOT written to disk
   and pairing will not issue a key. Nothing in this session persists.
   ```
2. **Remote access & backup shows a banner** at the top of the panel, before the toggle it explains.
   It is never hidden by the settings search, for the same reason the restart-pending warning is not.
3. **`GET /api/host` reports `debugSandbox: true`**, which is what the banner reads.

A phone that scans a code against a sandboxed desktop is told plainly too, rather than being left to
guess: *"The desktop is running in debug mode… Scanning again will not help."*

## What it deliberately does not do

### It is not a security boundary

Never describe it as one. It is a convenience for the person driving the app, and it lives inside the
process it is protecting — anything already able to set an environment variable on this process could
equally unset it. The real boundaries are the admin token, the pairing token, and the
data-plane/management split, and the sandbox touches none of them.

### It does not fake success

A blocked pairing claim is refused, with a reason of its own, rather than answered with a fabricated
key. A phone told it had paired would fail on every request afterwards with no clue why — a worse
debugging experience than the one this exists to improve.

### It does not change how a wrong code is answered

A wrong or expired code gets exactly the answer it gets outside the sandbox — `mismatch`,
`expired`, `no-pairing`. Only a caller presenting the *correct* live code ever sees `sandbox`.

That is on purpose. If the sandbox answered `sandbox` to any old guess, the refusal would depend on
nothing but the mode, and `POST /api/host/pair/claim` — the one route that answers without a
credential — would become a way for anyone on the network to ask whether your desktop is in debug
mode. It is pinned by a test.

### It does not consume the code it refuses

Nothing was issued, so there is nothing to spend. The same code keeps working, and leaving the
sandbox lets you pair with it for real without generating another.

## Failure modes

| Symptom | Cause |
| --- | --- |
| Settings spring back after a restart | Working as intended. The banner and the log line say so |
| The phone says the desktop is in debug mode | The desktop has the variable set. Restart it without one |
| The variable is set but everything still saves | The value is not one of `1` / `true` / `yes` / `on` |
| No banner, but nothing saves | Something else. The banner is driven by the same check as the block, so they cannot disagree — check the proxy log |

## Verification

`tests/debug-sandbox.test.ts` covers it: the flag's accepted and rejected spellings, that no file
*and no directory* is created, that an existing config is unchanged byte-for-byte and still reads
back the same, that the announcement fires exactly once, that a correct code is refused with no key
minted, that the code survives to pair for real afterwards, that a wrong code still answers
`mismatch`, and that `describeHost` reports the flag.

## Suggested reading

- [Remote access and pairing a phone](/guides/launcher-and-terminal/#pairing-a-phone-with-a-qr-code) —
  the flow this mode lets you exercise safely
- [The web dashboard](/guides/web-dashboard/) — the two-credential split the sandbox does not alter
- [Log files](/guides/log-files/) — where the announcement line is written
