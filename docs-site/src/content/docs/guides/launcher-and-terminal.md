---
title: Launcher and terminal
description: Install and open the agent CLIs and desktop apps from the dashboard, and run commands in the embedded terminal.
---

The dashboard can install the agent tooling for you and run commands without leaving the app. Two
surfaces cover it: the **Launch** card on the Dashboard, and the **Terminal** screen.

## The Launch card

The card lists every CLI and desktop app opencodex knows about, and probes the machine to see which
are actually present. A target that is installed gets an **Open** button; one that is not gets
**Get it**.

`ocx launch` is the same thing from a shell:

```bash
ocx launch list
```

```bash
ocx launch codex-cli
```

### Get it installs, it does not just link

Pressing **Get it** runs a real installation and streams the package manager's output into the card,
so a slow or failing install is visible rather than a spinner. When it finishes the card re-probes
and the target flips to **Open**.

| Target | How it installs |
| --- | --- |
| Codex CLI | winget `OpenAI.Codex`, else npm `@openai/codex` |
| Claude Code | winget `Anthropic.ClaudeCode`, else npm `@anthropic-ai/claude-code` |
| Grok CLI | npm `@vibe-kit/grok-cli` |
| Claude (desktop) | winget `Anthropic.Claude` |
| ChatGPT (desktop) | **Manual** — opens the download page |
| Grok (desktop) | **Manual** — opens the download page |

winget leads on Windows because it is present by default and needs no Node.js; npm is the
cross-platform route and the only route on macOS and Linux. If neither tool is on the machine, the
button falls back to opening the download page and says why.

:::note
ChatGPT and Grok desktop have no automatic route on purpose. No official package is published for
either, and the packages that *do* match those names come from unrelated publishers. opencodex will
open the vendor's own download page rather than install a community repackage on your behalf.
:::

If an install succeeds but the program is not yet visible, the card says so and asks you to restart
opencodex. That is not a failure: installers extend the machine `PATH`, and an already-running
process keeps the environment it started with.

Nothing about the command line comes from the browser. A request carries a catalog id, which is
looked up on the server; the package id and every argument are constants in the source.

## The embedded terminal

**Terminal** in the sidebar runs commands inside the app — no console window appears, which is the
same rule the launcher follows. Sessions start in your home directory. Pick **Shell** for a general
prompt, or one of the CLIs to run that program directly.

Everything you send is recorded in the transcript alongside the output, so the log reads as a
conversation rather than a list of answers with no questions, and it survives a page reload.

### What it will and will not run

Sessions are piped, not pseudo-terminals. Non-interactive commands work normally:

```bash
codex --help
```

```bash
codex exec "summarise this repo"
```

A **full-screen TUI will not draw here** — that needs a real console. The preset says so before you
start it, and the Launch card opens the full experience in a proper terminal when you want it.

The reason is deliberate: a pseudo-terminal on Windows means ConPTY and a native module. `node-pty`
needs node-gyp and a rebuild against Electron's ABI, and the maintained prebuilt fork is a beta.
opencodex ships four runtime dependencies and a working installer, and neither is worth trading for
a nicer terminal.

### It is off when the proxy is exposed

A terminal is a shell. If the proxy is bound to anything other than loopback — see
[Remote access](/guides/web-dashboard/) and `ocx host` — every terminal route returns `403` and the
screen explains why.

The management credential is deliberately *not* treated as sufficient on its own. A leaked dashboard
token should cost you your provider configuration, not your whole machine.

To override it anyway, set `terminal.allowRemote` in `~/.opencodex/config.json`:

```json
{
  "terminal": { "allowRemote": true }
}
```

:::caution
Turning that on means anyone who can reach the dashboard can run commands as you. There is no
one-click toggle for it for exactly that reason.
:::

### Limits

| Limit | Value |
| --- | --- |
| Concurrent sessions | 12 |
| Scrollback retained per session | 1500 chunks |
| Single input write | 8 KB |

Sessions are killed when opencodex shuts down, so a graceful exit never leaves an orphaned shell
holding your home directory open.

## The mobile remote control

`#/mobile` is a separate surface for a phone: full-bleed, a bottom bar, 44px
targets and safe-area insets, rather than the dashboard squeezed into 390px.
Three panels:

| Panel | What it does |
| --- | --- |
| **Chat** | Send a message to any routed model and watch the reply stream in. |
| **Sessions** | Recent proxy requests — model, provider, status, duration, tokens. |
| **Control** | Pairing state for this device, the proxy's bind, and the API key in use. |

It adds **three** server routes, all of them for pairing: `POST /api/host/pair`
and `DELETE /api/host/pair`, which the desktop calls to mint and cancel a
pairing code, and `POST /api/host/pair/claim`, which the phone calls. That last
one exists because a phone that has never paired holds no credential and so
cannot be served by anything that was already there — it is the only one of the
three that is reachable without the admin token. Everything else the remote does
reuses what other clients use.
Chat posts to the proxy's own `/v1/chat/completions` and the model list comes
from `/v1/models`, both on the data-plane key pairing hands out, so a message
sent from a phone is routed, logged and counted exactly like one sent from
Codex. Sessions read `/api/logs` and Control reads `/api/host`; those are
management routes, so they need the admin token from the desktop and say so
rather than appearing to load forever. A parallel "mobile API" would have been a
second path to the same behaviour and a second place for it to be wrong.

### Pairing a phone with a QR code

The proxy has to be published to your network first, and then restarted — the
listening socket is fixed when the process starts, so enabling remote access
changes the config and nothing else until it comes back up:

```bash
ocx host enable
```

Then open **Remote access & backup** on the desktop and choose **Pair a phone**.
Each QR code carries one of the proxy's addresses *and* a one-time pairing code;
a machine with several network addresses shows one code per address, so scan
whichever matches the network the phone is on. Scanning opens the remote on the
phone, which strips the code out of the URL *first* and only then spends it. The
order matters: it means a failed or expired pairing leaves nothing behind in the
address bar either, so no screenshot, shared link or restored tab can carry a
live code.

What makes showing a credential on a screen acceptable is what the code is:
256 bits of randomness, valid for **one** device, expiring after **five
minutes**, replaced whenever a new one is generated, and cancelled the moment
the panel closes. It mints a data-plane key and never an admin token, so a
paired phone can drive the proxy but cannot reconfigure it.

The key is then **saved in that phone's browser**, so pairing happens once
rather than on every visit. That is a deliberate exception to the rule the
dashboard follows for its own admin token, which is memory-only: an admin token
can export every account, while this one can only send requests. Clear it from
the phone with **Forget this device**, and revoke it on the desktop under
**API keys**, where it is listed as `Paired device`.

If you would rather not use a QR code at all, the Control panel still accepts a
key typed by hand. `ocx host enable` prints the URLs other devices can use, and
requires a credential — the same gate the rest of the exposed surface uses. Open
one of those URLs on the phone and add `#/mobile`, then paste the key into
**Control**. The key is stored on that device only.

:::caution
Publishing the proxy exposes the dashboard too. Only do it on a network you
trust, and never without the credential.
:::
