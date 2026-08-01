---
title: Debug sandbox — change nothing, issue nothing
description: OPENCODEX_DEBUG_SANDBOX runs the real dashboard and proxy while blocking the two things that are awkward to undo — writing config.json and issuing a data-plane key.
---

Set `OPENCODEX_DEBUG_SANDBOX=1` and opencodex runs normally with two things switched off: it will
**not write its config to disk**, and it will **not issue a data-plane key**. Everything else behaves
as it always does — the dashboard renders, settings toggle, the pairing panel opens, the QR code
appears and its countdown runs.

It exists so the app can be driven, demonstrated and screenshotted without changing the machine's
configuration or minting a credential somebody has to remember to revoke.

:::caution[It does not make the process leave no trace]
This blocks **configuration changes and credential issuance**. It does not stop opencodex writing
its other files. The usage log, the diagnostic log, the crash log, the responses state file, the pid
and runtime-port files, the local git state history, the admin credential file on a fresh config
directory, and the OAuth credential store on sign-in or token refresh are all written as normal — and
the config directory and log tree are created at startup before the flag is consulted.

If you need a run that genuinely leaves nothing behind, point `OPENCODEX_HOME` at a throwaway
directory and delete it afterwards. This flag complements that; it does not replace it.
:::

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
| `config.json` writes via `saveConfig` | Every settings change is written | Nothing is written. An existing file is left byte-for-byte alone |
| Pairing | A correct code mints a data-plane key and persists it | The claim is **refused** with the reason `sandbox`. No key is minted |
| Minting a data-plane key | `mintDataPlaneKey` mints on demand — including the one-click *enable remote access* opt-in | Refused. `mintDataPlaneKey` throws as a backstop, and each caller checks first and reports honestly |
| `POST /api/keys` | Mints its own `ocx_data_…` key without going through `mintDataPlaneKey` | Refused with `409` |
| `POST /api/host/restore` | Rewrites the state files **directly**, not through `saveConfig` | Refused with `409`, before anything drains — this is the one action that would otherwise really change the machine |

One thing that is **not** blocked and looks like it should be: a key **you supply yourself** through
the custom-key field is still accepted into the running config. Nothing issues it and nothing writes
it, but it is live against this process until it stops.

These two are singled out because they are the two that are awkward to undo:

- **Config writes.** Toggling *Reachable from other devices* just to see what the screen does
  rewrites `config.json`, and on the next start the proxy really is published to your network. There
  was previously no way to look at that screen in its enabled state without actually enabling it.
- **Pairing.** A key minted to take a screenshot is a live credential that outlives the screenshot,
  and whoever made it is the least likely to remember to revoke it.

Because the config write is what publishes the proxy, blocking it also means the sandbox cannot
publish the proxy to your network by accident.

## How you can tell it is on

A mode that silently stops settings saving is indistinguishable from a bug, and "my settings do not
save" is the kind of thing that gets reported as data loss. So it says so:

1. **Remote access & backup shows a banner**, first in the card and above the toggle it explains.
   The settings search cannot hide it — it is not behind a `matches(...)` gate, and it keeps the card
   itself on screen even when a query filters every row out.
2. **`GET /api/host` reports `debugSandbox: true`**, which is what the banner reads. Anything else
   built on that endpoint gets the same signal for free.
3. **The proxy writes one line to stderr**, the first time it blocks anything:
   ```
   [debug-sandbox] OPENCODEX_DEBUG_SANDBOX is set: config changes are NOT written to disk
   and no data-plane key will be issued. Other files (logs, usage, state) are still written
   as normal — set OPENCODEX_HOME to a throwaway directory if you need a clean slate.
   ```

:::note
The banner is the reliable one. The log line only fires on the **first blocked action**, so a session
that just looks at the dashboard and changes nothing never prints it — and because it goes to stderr
rather than through the app's own logger, it does not appear in `logs/opencodex.log` either. Look at
Remote access, or at `GET /api/host`, rather than hunting the log.
:::

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
| Settings spring back after a restart | Working as intended. The banner on Remote access says so |
| The phone says the desktop is in debug mode | The desktop has the variable set. Restart it without one |
| The variable is set but everything still saves | The value is not one of `1` / `true` / `yes` / `on` |
| No banner, but nothing saves | Something else — the banner and the block read the same flag, so they cannot disagree. Check `GET /api/host` |
| Files still appearing under `OPENCODEX_HOME` | Expected. Only config writes and key issuance are blocked; see the caution at the top |

## Verification

`tests/debug-sandbox.test.ts` — **17 tests**. The flag's accepted and rejected spellings; that
`saveConfig` creates no config file, leaves an existing one unchanged byte-for-byte, and that a
re-read still returns the original; that the announcement fires exactly once and names the variable;
that a correct code is refused with no key minted; that the refused code survives to pair for real
once the sandbox is off; that a wrong code still answers `mismatch` and an absent pairing still
answers `no-pairing`; that `mintDataPlaneKey` throws its backstop; that `PUT /api/host` with either
`mintKeyIfMissing` or `newKeyName` returns **no** key while still reaching the exposed state; that
the same request outside the sandbox still mints, so the fix did not quietly disable the feature;
and that `describeHost` reports the flag.

The key-minting cases exist because the first version of this mode **did** hand out a live
`ocx_…` key from the one-click *enable remote access* path, captioned "shown once, store it now".
It was found by running the built app and looking at the screen, not by reading the code — which is
why the tests now drive the real route over a real socket rather than calling the function.

## Suggested reading

- [Remote access and pairing a phone](/guides/launcher-and-terminal/#pairing-a-phone-with-a-qr-code) —
  the flow this mode lets you exercise safely
- [The web dashboard](/guides/web-dashboard/) — the two-credential split the sandbox does not alter
- [Log files](/guides/log-files/) — where the announcement line is written
