---
title: CLI Reference
description: Every ocx command and flag.
---

The opencodex CLI is `ocx`. Run `ocx help` (or `--help` / `-h`) for top-level usage.
Run `ocx help <command>` for commands registered in the help table. Help and version commands are
read-only and do not start, stop, install, uninstall, or rewrite Codex/opencodex state.

## Global agent memory

### `ocx memory` versus `ocx memory-sync`

`ocx memory [--json]` remains the runtime observability alias for `ocx observe memory`; it reads proxy-process memory state and does not manage global agent files. `ocx memory-sync` is the separate, provenance-checked integration with `https://github.com/Ding-Ding-Projects/agent-global-memory`.

```text
ocx memory-sync status [--repo PATH] [--target all|claude,codex,opencode] [--home PATH]
ocx memory-sync install [--repo PATH] [--target all|claude,codex,opencode] [--home PATH] [--dry-run] [--yes]
ocx memory-sync uninstall [--repo PATH] [--target all|claude,codex,opencode] [--home PATH] [--dry-run] [--yes]
ocx memory-sync profile list [--repo PATH] [--json]
ocx memory-sync profile show <slug> [--repo PATH] [--json]
```

Repository resolution is `--repo`, then `OPENCODEX_GLOBAL_MEMORY_REPO`, then `../agent-global-memory` beside a source checkout. OpenCodex never clones or downloads a repository. The repository must have the exact canonical `origin` URL (optional `.git` suffix), a matching Git root, the canonical payload and skill, and the platform synchronizer inside the repository boundary. Symlinks and Windows reparse-point escapes fail closed.

`all`, `claude`, `codex`, and `opencode` select synchronizer targets. `--home` is passed to the canonical script for target-home resolution and is never persisted in `config.json`. Install and uninstall require `--yes` unless `--dry-run` is supplied. The canonical exit contract is preserved: `0` means current/success, `1` means missing or drifted status (or cancellation), and `2` means conflict or operational error. The adapter launches PowerShell or Bash with `shell: false` and bounded output.

Profiles are read-only Markdown files under `memory/projects/*.md`. `profile list` returns sorted safe slugs and relative paths; `profile show` returns the bounded UTF-8 Markdown text. Profiles are project-scoped reference material and are not automatically applied to Claude, Codex, OpenCode, or OpenCodex prompts. Slugs must match `^[a-z0-9][a-z0-9-]*$`; traversal, symlinks/reparse points, escapes, and files larger than 256 KiB are rejected. Use `--json` for the versioned `{ schemaVersion: 1, repository, profiles }` or profile-show result.

## Setup & lifecycle

### `ocx setup` · `ocx init`

Interactive setup wizard (`init` is the compatibility alias). Prompts for a provider (preset or custom), API key (literal or `${ENV}`),
default model, and proxy port; saves `~/.opencodex/config.json`; optionally injects the proxy into
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); and optionally installs the Codex
autostart shim.

### `ocx start [--port <port>]`

Start the proxy server (preferred port `10100`). With no `--port`, this is an automatic start: if the
configured preference is occupied, opencodex records another available port in `runtime-port.json`
and syncs Codex to that live listener without changing the configured preference. An explicit
`--port` is a hard pin: opencodex waits for that exact port and fails if it stays occupied; it never
hops. Update handoffs and dashboard restarts also pin their captured live port.

Startup uses a cross-process lock and stable OpenCodex identity-health checks, not just PID-file or
TCP reachability. A concurrent starter cannot create a duplicate fallback daemon. On start it syncs
each provider's models into Codex's catalog. On shutdown it restores native Codex unless it was
launched as a managed service (`OCX_SERVICE=1`). A healthy owner is identity-checked before stale
journal recovery, so a dead launcher PID cannot make a live proxy lose its injected Codex state.
The resulting stale-session warning reports recovery and is not a Bun-crash classifier.

The external Node npm launcher supervises only direct `start` and `ensure` invocations. It forwards
Bun stderr byte-for-byte, retains an attempt-local 64 KiB tail for classification, and retries
exactly once only after abnormal termination plus the exact `oh no: Bun has crashed` marker.
Ordinary failures are never retried. `OPENCODEX_BUN_PATH` is used only when it resolves to a readable
regular file of at least 1,000,000 bytes (approximately 1 MiB); a rejected value is not echoed, and
the launcher falls back to bundled Bun. This check does not verify binary identity or a publisher
signature. See [Bun Startup Crash Recovery on
Windows](/troubleshooting/bun-startup-crashes/).

A healthy owner is identity-checked before stale journal recovery, so a dead launcher PID cannot
make a live proxy lose its injected Codex state. On the TypeScript fallback, the external Node
launcher retries `start` once only for an abnormal exit carrying Bun's official crash marker;
ordinary command failures are never retried. The packaged Go runtime does not invoke Bun for its
native proxy process. See [Bun Startup Crashes on Windows](/troubleshooting/bun-startup-crashes/).

```bash
ocx start
ocx start --port 8080
```

### `ocx codex [codex args...]`

Launch Codex through opencodex. If no healthy proxy is running, the command starts one in the
background on the configured port. It then refreshes Codex's provider configuration against the
live port, resolves the selected Codex runtime, and forwards every remaining argument unchanged.

```bash
ocx codex
ocx codex exec --skip-git-repo-check "Reply with READY"
```

### `ocx stop`

Stop the running proxy and restore native Codex. If a managed background service is installed,
`ocx stop` stops and verifies the service manager first so it cannot respawn the proxy. It then
identity-checks proxy termination before removing runtime state or restoring Codex, Grok, and
environment routing. Manager or proxy uncertainty fails closed and preserves that owned state for
recovery. The same action is available from the web dashboard's **Stop** button (`POST /api/stop`).

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

Restore native Codex **without** stopping the proxy — strips the injected config lines and routed
catalog entries so plain `codex` works natively again. `eject` is an alias of `restore`.

Pass `back` to either spelling to re-point plain `codex` at an already-running proxy without changing
the proxy lifecycle:

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

Explicit recovery for older development builds that remapped Codex App history before reversible
backup support existed. Close Codex first if its history database is locked.

### `ocx restart`

Run `stop` followed by `ensure`: stop the proxy/service, restore native Codex, start the proxy in the
background, and sync the live port back into Codex.

### `ocx ensure`

Idempotently ensure a background proxy is running, then sync its live model catalog. If
`codexAutoStart` is `false`, it prints that autostart is disabled and does nothing. The external
launcher gives `ensure` the same one-retry, panic-qualified supervision described under `start`; it
does not retry an ordinary nonzero result.

### `ocx status [--json]`

Print a read-only diagnostic summary: proxy PID, `/healthz` reachability, dashboard URL,
config path, default provider, Codex autostart setting, service state, shim state, and the redacted
effective Codex home. Only the explicit, high-confidence Windows Orca runtime-home signature adds an
actionable App-home mismatch warning; it never changes `CODEX_HOME` automatically.

Human output also includes an **OAuth health** block after the OAuth logins summary: `OAuth health:
ok` when every known account is healthy, or `OAuth health: warning` with one redacted line per
non-healthy account (provider, masked account id, status such as reauthentication required / rate or
quota limited / refresh conflict) plus an optional `Action:` hint. Account ids are redacted; tokens
and emails are never printed. The `--json` contract does not currently include this health block.

Use `--json` for a machine-readable, read-only diagnostics contract:

```bash
ocx status
ocx status --json
```

Abbreviated example shape:

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

The real object also includes `listen` (port, hostname, runtime/config source), config load
diagnostics, and bundled Codex plugin diagnostics. The JSON schema is additive-only: future versions
may add fields, but existing fields should stay stable. It intentionally excludes API keys, OAuth
tokens, authorization headers, request content, emails, and account identities.

### `ocx health [--json]`

Identity-check the live proxy. Human output reports PID/port; `--json` emits `{ok, pid, port}`. The
command exits 0 only when healthy and 1 otherwise, making it suitable for service probes.

### `ocx export <path> --yes` · `ocx export data …`

`ocx export data <dataset>` exports a redacted dashboard dataset and may write to stdout. Use
`--list` to see datasets and formats, and `--out <path>` to write a file.

`ocx export <path> --yes` is the separate full-state backup. It includes config, account state,
API keys, MCP credentials, and OAuth access/refresh tokens in plaintext. The destination must be a
new file: opencodex creates it exclusively with private permissions (and a hardened Windows ACL),
refuses stdout, refuses overwrite/symlink replacement, and deletes an empty partial file if
hardening fails. Store the result encrypted, never commit or upload it, and delete it when no longer
needed.

On Windows, secret-file ACL hardening normally performs the existing grant, inheritance, and broad
ACE-removal sequence. Large already-hardened trees may opt into a strict read-before-write proof by
setting `OPENCODEX_ACL_VERIFY_EXISTING=1` before starting opencodex. The read is accepted only when
the complete `icacls` listing contains exactly one explicit Full Control ACE for the current effective
SID, accepting file `(F)` and directory `(OI)(CI)(F)` shapes, with no inherited marker, extra ACE,
localized-summary confusion, or principal mismatch. Any missing,
localized, SID-shaped, or otherwise ambiguous identity falls back to the existing hardening mutation;
the optimization never turns uncertainty into an ACL bypass. Remove the variable to return to the
normal mutation-first path.

### `ocx host <status|enable|disable>`

Configure trusted-LAN access without putting credentials in command arguments. `enable --yes`
accepts an IPv4 address, IPv6 address, or DNS hostname through `--hostname`; `--new-key [name]`
generates a data-plane key and shows it once. `status` identity-probes a running proxy and prints its
active bind/port and remote URLs, including an automatic fallback port. When the proxy is stopped it
prints the configured values. Run `ocx host status` for the remote connection URL; `ocx status` also
reports the identity-verified live port.
The remote dashboard separately prompts for that proxy's ADMIN token. Direct HTTP is unencrypted;
prefer an SSH tunnel outside a trusted LAN.

### `ocx uninstall` &nbsp;·&nbsp; `ocx remove`

Stop the service and proxy, remove the service and Codex shim, restore native Codex, then remove
opencodex local config only if all restore steps succeeded. `remove` is an alias of `uninstall`.

## Models & Codex

### `ocx sync [--restart-codex]`

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

If long-lived Codex `app-server` processes are still running, `ocx sync` warns that they may keep
serving the previous in-memory model list even though `opencodex-catalog.json` / `models_cache.json`
were updated. Pass `--restart-codex` to send `SIGTERM` only to matching `codex … app-server` and
`codex-code-mode-host` processes owned by the current user (active turns may be interrupted). Broad
`pkill -f codex` matching is intentionally avoided.

### `ocx sync-cache [--restart-codex]`

Invalidate Codex's local model picker cache so it is rebuilt from the active opencodex catalog. The
same stale-`app-server` warning and optional `--restart-codex` behavior as `ocx sync` apply.

### `ocx v2 [subcommand]`

Manage the Codex `multi_agent_v2` feature flag and the 3-state multi-agent surface mode.

| Subcommand | Action |
| --- | --- |
| `status` (default) | Report the current v2 flag, multi-agent mode, and thread concurrency. |
| `on` | Enable the `multi_agent_v2` feature in `$CODEX_HOME/config.toml` and resync the catalog. |
| `off` | Disable the `multi_agent_v2` feature and resync. |
| `mode v1` | Force ALL models to v1, disable native v2, and preserve the thread limit under `[agents] max_threads`. |
| `mode default` | Respect upstream model pins (sol/terra=v2, luna=v1, rest=codex flag). Install default. |
| `mode v2` | Force ALL models to v2, enable native v2, and migrate the same thread limit to the v2 key. |
| `threads <n>` | Set the active v1/v2 thread limit (integer >= 1). |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

The `mode` subcommand writes `multiAgentMode` to the opencodex config and resyncs the Codex catalog.
`mode v1`/`mode v2` and `on`/`off` move the current numeric thread limit between the valid v1/v2
Codex keys while flipping the native feature through `codex features enable|disable`. A failed
transition restores the original `config.toml`.
Changes apply to new Codex sessions; running sessions keep their pinned surface.

## Headless dashboard parity

Operational dashboard features are also available without a browser. These commands locate the
identity-checked running proxy (including a fallback runtime port) and reuse the same management
routes, validation, live configuration, and catalog refresh side effects as the GUI.

| Resource | Commands |
| --- | --- |
| Routing | `ocx combo ...` or `ocx route combo ...` |
| Agent policy | `ocx agent injection|effort|subagents|fallback|sidecar ...` |
| Observability | `ocx observe logs|usage|storage|memory|debug ...` |
| Narrator voices | `ocx narrator status|voices|speak ...` |
| Scheduled settings | `ocx schedule status|list|show|active|test-api|test-ha|ha-token ...` |
| API admission | `ocx access key|endpoints|models|test ...` |
| Claude Code | `ocx claude config status|set ...` |
| Grok Build | `ocx grok status|exclude|include|set|clear|apply ...` |
| Runtime control | `ocx system status|settings|startup|diagnostics|sync|update ...` |
| Offline config | `ocx config show|get|set|unset|validate|export|import ...` |

List/status is the default where unambiguous. Use `--json` for structured snapshots and
`ocx observe logs --follow --jsonl` for a streaming request-log feed. Destructive removal/import
and update actions require `--yes`. Live operations require a running proxy; validated config
inspection and import/export work offline.

```bash
ocx provider test ark
ocx models live --provider ark --json
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
ocx agent subagents set ark/model-a,openai/gpt-5.5
ocx observe usage --range 30d --json
ocx access key create deployment
ocx system settings --stream-mode eager-relay
```

Theme, language, navigation, and other purely visual browser state intentionally have no CLI
equivalent — including the narrator's own on/off switch and its per-language voice choice, and
scheduled-settings *rules* themselves (their days/time window, priority, and what they set), all of
which are per-visitor browser state rather than server configuration. The narrator's voice catalogues
and its synthesis are management routes, so those do have one: see `ocx narrator` below. Likewise, a
scheduled rule's remote sources (a candidate API URL, a Home Assistant entity) are validated through
real management routes, so those are headlessly testable too: see `ocx schedule` below. Cloudflare
Tunnel setup is not part of this command set.

### `ocx models [subcommand]`

List the models statically seeded in configured providers. `--provider` filters one configured
provider and `--json` returns model metadata. `live` reads the running catalog; `add`, `edit`,
`remove`, and `list-custom` manage manual catalog entries; `enable`, `disable`, and `provider`
control visibility; `selected` controls a provider allowlist; `context` controls provider context
caps; and `shadow` manages background shadow-call interception.

### `ocx provider <subcommand>`

Non-interactive provider management. Registry entries are seeded by name; a custom name requires
both `--adapter` and `--base-url`.

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` | `--json` | List configured providers and the remaining registry entries. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | Add a registry/custom provider. `--force` overwrites; `--sync` refreshes a running proxy in human-output mode. |
| `edit <name>` | provider field flags, `--json` | Edit validated live provider fields without replacing key pools. |
| `test <name>` | `--json` | Probe the real upstream model endpoint. |
| `show <name>` | `--json` | Show config with API keys masked. |
| `remove <name>` | `--json` | Remove a non-default provider; the last provider cannot be removed. |
| `set-default <name>` | `--json` | Select an existing provider as the default. |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | Read or update the provider model allowlist. |
| `quota` | `--refresh`, `--json` | Read provider quota reports. |
| `presets` | `--json` | List dashboard provider presets. |
| `account-mode` | `pool`, `direct`, `--json` | Select pooled or direct Codex account routing. |

```bash
ocx provider list --json
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
```

### `ocx account <subcommand>`

List and switch provider accounts and API-key pools through the running proxy. The shipped help
surface is:

```text
Usage: ocx account <list|current|use|refresh|auto-switch|remove|add-key> ...

List and switch provider accounts and API-key pools (GUI parity).

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
Codex pool switches apply to new sessions; running threads keep their account.
```

All subcommands require the proxy to be running; the CLI auto-resolves its recorded runtime port.
Successful operations exit 0. Invalid usage, an unknown provider or account/key id, an unreachable
proxy, or an API failure exits 1. Credential fields are displayed exactly as the management API
returns them (including its masking); raw API keys and OAuth tokens are never returned. Display
conveniences are synthesized client-side, same as the dashboard: `main` is the CLI alias for the
Codex App login in the `openai` account pool, OAuth accounts without an email appear as
`Account N`, and the plan/label column falls back across plan, masked email, label, and masked key.

`--json` account rows use this common shape (optional fields are omitted when unavailable):

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

#### `ocx account list [provider] [--json] [--all]`

Without a provider, lists the Codex pool, OAuth accounts, and configured API-key pools. Empty
providers are skipped unless `--all` is present. With a provider, lists only that credential family.
Human output uses `PROVIDER TYPE ID PLAN/LABEL STATUS`; a manually chosen Codex row is marked `selected`.
When a stored Kiro account exists, the output notes that Kiro has one login slot and that signing in
again replaces the current account. An empty result is still success. `--json` returns:

```text
{ accounts: AccountRow[], notes: string[] }
```

#### `ocx account current <provider> [--json]`

Shows the active account or key. A Codex pool with no manual pin reports automatic lowest-usage
selection; another family with no active credential reports that state and still exits 0. `--json`
returns:

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

#### `ocx account use <provider> <account-or-key-id|main> [--json]`

Selects an existing Codex account, OAuth account, or API key. For `openai`, `main` selects the Codex
App login. Codex selections apply only to **new sessions**; existing threads keep their account, and
an enabled auto-switch threshold may later override the manual pin. Unknown providers or ids exit 1.
`--json` returns:

```text
{ ok: true, provider, type, activeId }
```

#### `ocx account refresh <provider> [--json]`

For the Codex pool, use `ocx account refresh openai [--json]`. It force-refreshes account quotas and
prints available weekly/monthly percentages and reset times; missing quota data is reported as
unknown, not 0%. Its JSON envelope is `{ accounts: AccountRow[] }`, with `quota` on each Codex row.

For OAuth and API-key providers, this force-refreshes the provider quota-report endpoint; it is not a
token re-login or a plain account-list re-read. `--json` returns
`{ provider, report: ProviderQuotaReport | null }`. A provider with no supported quota report prints
`no quota report available for <provider>` and exits 0. Unknown providers and management-API
failures exit 1; an upstream quota probe that fails or times out degrades to a null or stale
report instead (exit 0), matching the dashboard's quota bars.

#### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

Controls only the `openai` Codex account pool. `on` sets 80%, `off` sets 0%, `status` reads the current
value, and `threshold <n>` accepts an integer from 0 through 100. Other providers and invalid values
exit 1. `--json` returns:

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

#### `ocx account remove <provider> <id|main> --yes [--json]`

This guarded, non-interactive deletion requires `--yes`. Before deleting, it verifies that the id
exists; a missing id exits 1 without sending DELETE. The main Codex App login cannot be removed, so
`remove openai main --yes` is refused. After deletion, the family is read again: removing the pinned
Codex account clears the pin and returns to automatic selection; OAuth promotes the first remaining
account or reports none; API-key pools promote the first remaining key or report none. `--json`
success and failure shapes are:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }
{ error: string } // stderr, exit 1
```

#### `ocx account add-key <provider> [--label <label>] [--json]`

Adds and activates a key for an API-key provider. The key is read only from non-TTY piped/redirected
stdin; interactive TTY input, empty input, OAuth/Codex providers, and API failures exit 1. The key is
never echoed, including when it appears inside a label. Prefer a secret manager or a here-string:

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` returns `{ ok: true, id: string | null, label?: string }` and never includes the key.

### `ocx narrator <status|voices|speak>`

The headless counterpart to the dashboard's narrator voice picker. It lists the voices this computer
can speak with, lists the Microsoft Edge online catalogue, and synthesizes one line to an MP3 through
the same `/api/narrator/*` routes the dashboard uses.

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `status` | `--edge`, `--json` | Installed voices, the synthesis bounds, and where the narrator's settings actually live. |
| `voices` | `--source <local\|edge\|all>`, `--lang <tag>`, `--search <text>`, `--limit <n>`, `--edge`, `--json` | List voices from either source. Defaults to `local`. |
| `speak` | `--voice <name>`, `--rate <n>`, `--pitch <n>`, `--out <path>\|-`, `--edge`, `--json` | Synthesize one line and write the MP3. |

```bash
ocx narrator status
ocx narrator voices --lang en
ocx narrator voices --source edge --lang zh-HK --edge
ocx narrator speak "早晨" --voice zh-HK-HiuMaanNeural --edge --out morning.mp3
```

`--lang` matches on the subtag boundary, so `zh` finds both `zh-HK` and `zh-CN` while `en` does not
claim `enm`. `--rate` and `--pitch` are multipliers from 0.5 to 2, where 1 is the voice's own normal
delivery. A line is capped at 600 characters, and the command refuses a longer one locally rather
than sending it. `--out -` writes raw MP3 bytes to stdout and refuses to do so into a terminal.

**Microsoft Edge online voices are a network source, and `--edge` is required by every path that
reaches it.** Speaking with one sends the text you pass to Microsoft, over the internet, every time
it speaks; listing the catalogue contacts the same service but sends no narrated text. Installed
platform voices stay on this computer and need no network at all. Nothing here contacts Microsoft
without `--edge`, and the refusal you get without it states what would be sent and to whom. The
service is the undocumented one Edge itself uses to read pages aloud: Microsoft publishes no contract
for it and can change or block it at any time, so a sudden refusal is the service refusing this
client rather than a fault in your text or your chosen voice.

Installed voices are enumerated from the operating system's own speech platform, which is Windows
only today; elsewhere `status` reports them as unavailable with the reason rather than as an empty
list. That set is the machine's, not the browser's, so it can differ slightly from what the
dashboard's picker offers.

Whether the narrator speaks at all, which language it narrates, the voice, rate and pitch chosen for
each narrated language, and whether the Edge source is switched on are stored per visitor in the
dashboard's own browser profile (local storage key `ocx-m3:v1`). They are not server configuration,
so `ocx narrator status` reports them as unreadable rather than guessing at a default. Change them in
the dashboard under **Language & voice**.

### `ocx schedule <status|list|show|active|test-api|test-ha|ha-token>`

The headless counterpart to the dashboard's **Scheduled settings** page — with one honest limit: a
scheduled-settings *rule* (its days/time window, priority, and what it sets) lives only in the
dashboard's own browser profile (local storage key `ocx-m3:schedule`), created, edited and deleted
entirely client-side. Nothing about a rule's shape, or which one is currently matching, is ever sent
to or stored by the proxy process, so this command cannot list, inspect, or report the active rule —
and says so plainly, the same way `ocx narrator status` reports the narrator's own browser-only
preferences as unreadable rather than guessing.

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `status` | `--json` | Where rules live, the precedence rule, and which checks below are available headlessly. |
| `list` | `--json` | States that rules cannot be listed from here and names where to find them. |
| `show <id>` | `--json` | States that a rule cannot be inspected by id from here and names where to find it. |
| `active` | `--json` | States that the currently-winning rule cannot be reported from here and names where to find it. |
| `test-api <url>` | `--json` | Test an api-sourced rule's endpoint through the same server-side `resolve-api` route the dashboard uses. |
| `test-ha` | `--base-url <url>`, `--entity-id <id>`, `--token-ref <ref>`, `--json` | Test a Home Assistant-gated rule's entity through the same server-side `ha-state` route the dashboard uses. |
| `ha-token status` | `--token-ref <ref>`, `--json` | Whether a Home Assistant token is stored for a rule — never its value. |
| `ha-token clear` | `--token-ref <ref>`, `--json` | Delete a stored Home Assistant token. |

```bash
ocx schedule status
ocx schedule test-api https://example.com/opencodex-schedule.json
ocx schedule test-ha --base-url https://homeassistant.local:8123 --entity-id input_boolean.evening_mode --token-ref my-rule-id
ocx schedule ha-token status --token-ref my-rule-id
```

**Precedence rule** (stated here, never recomputed — there is no rule data in this process to compute
it over): when more than one enabled rule matches the current moment, the highest `priority` wins; a
tie goes to whichever rule was created more recently.

**What genuinely is headless.** An `api`- or `homeAssistant`-sourced rule depends on a remote endpoint
the dashboard already validates through `/api/schedule/resolve-api` and `/api/schedule/ha-state` —
server-side, bounded, SSRF-checked (`https://`, or `http://127.0.0.1`/`http://localhost` for local
development), and never called directly from the renderer. `test-api` and `test-ha` are thin
passthroughs onto those same routes, so you can find out whether a candidate URL or Home Assistant
entity will actually resolve *before* pasting it into the dashboard's rule editor, without a browser.
A reported failure (an unreachable host, a malformed response, a wrong entity state) exits `0` just
like `ocx narrator voices --edge` reporting an unreachable Edge catalogue — the check ran and gave a
definite answer, which is success for this command even when the answer is "no". A request rejected
at the SSRF boundary (an invalid URL) is a genuine usage problem and exits non-zero.

**There is no `ha-token set`.** Storing one requires the plaintext token, and this command never
accepts, prints, or logs a secret. Type it once into the dashboard's own password field under
**Scheduled settings** — the same boundary `ocx host` draws around minting a data-plane key versus
ever printing one back out.

## Authentication

### `ocx login <provider>`

Start the provider's registered login flow. OAuth providers open a browser and store auto-refreshed
credentials under `~/.opencodex/`; API-key login providers open their key dashboard, prompt for the
key, validate it when possible, and save the resulting provider config. The command prints the
currently accepted OAuth and API-key provider ids when the name is missing or unknown.

Use the same command to **reauthenticate** after `ocx status` / `ocx doctor` reports
reauthentication required or a terminal refresh failure (or use Reauthenticate in the dashboard).
Codex pool accounts are not a public `ocx login` provider — reauthenticate via the dashboard Codex
account pool (Reauthenticate) instead.

```bash
ocx login xai
ocx login anthropic
```

### `ocx logout <provider>`

Remove the stored OAuth credential for a provider.

## Dashboard

### `ocx gui`

Open the [web dashboard](/guides/web-dashboard/) at `http://localhost:<port>`, auto-starting
the proxy if it isn't running.

## Remote access & backup

### `ocx host <status|enable|disable|token>`

Expose the proxy and dashboard to other devices on your network — the supported alternative to
hand-editing `hostname`. Binding beyond loopback already forces a credential onto every `/api/*`
and data-plane request; this command refuses to write a config the next `ocx start` would reject.

```bash
ocx host status
ocx host enable --new-key --yes
ocx host token
ocx host disable
```

| Subcommand | Action |
| --- | --- |
| `status` | Bind address, whether other devices can reach it, whether a credential is configured, and the URLs to open. |
| `enable` | Bind to the network. Requires `--yes` **and** an existing data-plane credential (or `--new-key` / `--key` to create one in the same command). |
| `disable` | Return `hostname` to `127.0.0.1` (this machine only). |
| `token` | Legacy no-op reporting that the dashboard and `/api/*` no longer use an admin token. |

| Flag | Meaning |
| --- | --- |
| `--hostname <addr>` | Bind address for `enable` (default `0.0.0.0`, all interfaces). A loopback address is rejected — use `disable` instead. |
| `--new-key [name]` | Generate a data-plane API key (default name `network`) and print it **once**. |
| `--key <value>` | Store a user-chosen data-plane key (at least 12 characters, no whitespace). It sits in plaintext in `config.json`, so never reuse a real password. |
| `--yes` | Confirm that the proxy becomes reachable by other devices. `enable` refuses without it. |
| `--json` | Machine-readable output. |

Either way a restart applies the change: `ocx stop && ocx start`.

`ocx host token` is retained only as a compatibility command. It prints no secret and reports that
the management plane is open. Configure the data-plane key before exposing the proxy and use an
external authenticated boundary for remote management.

:::caution[Trusted networks only]
`enable` binds to your local network. It does not open a firewall port, forward anything, or expose
the proxy to the internet — and there is no TLS, so the data-plane key crosses the network in cleartext.
Anyone who can reach the port and holds the key can drive the proxy and every provider account
behind it.
:::

### `ocx export <path|->` &nbsp;·&nbsp; `ocx export --history`

Write one JSON bundle (mode `600`) holding the full config, every Codex account with its OAuth
credentials, and the main auth record. **It contains plaintext secrets**: the command refuses
without `--yes`, prints a warning on stderr even when piping to `-`, and masks nothing, because a
masked backup cannot be restored. Store it encrypted and delete it when you are done.

```bash
ocx export backup.json --yes
ocx export --history
```

`--history` lists the account-change snapshots opencodex commits into a **local-only** git
repository inside `~/.opencodex` on every account add or remove. That history contains secrets, has
no remote configured, and must never be pushed:

```bash
git -C ~/.opencodex show <hash>:codex-accounts.json
```

## Background service

### `ocx service [subcommand]`

Run opencodex as a login-managed background service (macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**) that auto-starts on login and auto-restarts on crash. Service runs set
`OCX_SERVICE=1` so a restart doesn't churn the Codex config. A normal service start uses the
availability-first port policy, but it reports success only after stable OpenCodex health is tied to
service-owned runtime state; an unrelated direct proxy is not adopted as the service child.

| Subcommand | Action |
| --- | --- |
| none | Install and start when both backends are proven absent; otherwise refresh and restart the installed backend without re-registering it. |
| `install` | Create and start the service. |
| `repair` | Refresh an installed backend and restart it without registration. |
| `restart` | Alias of `repair`. |
| `start` | Start an installed service. |
| `stop` | Stop the service and restore native Codex. |
| `status` | Report whether the service is running. |
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

```bash
ocx service
ocx service install
ocx service repair
ocx service restart
ocx service status
ocx service uninstall
```

The bare command validates arguments before probing installation. On Windows, Task Scheduler and
WinSW are combined into an installed/absent/unknown state. Unknown status refuses registration and
asks for `ocx service status`; only proven absence enters the registration path. A scheduler stop is
also verified before asset rewrites, and uninstall keeps assets, install state, and token metadata
when deletion or post-delete absence cannot be proven. A protected persisted service token may satisfy
the non-loopback auth preflight when the current environment has no token; it is never printed or
copied into command output.

On Windows, creating the Task Scheduler entry requires elevation. Recognized localized
access-denied text keeps the existing guidance path. If that text is unreadable, the fallback
requires the owned command shape `/create /tn opencodex-proxy /xml <non-empty-path> /f`, status 1,
and a confirmed non-elevated token; the dashboard's Startup Safety action can then request UAC
automatically. If that fallback cannot determine the token state, it retains the original scheduler
error. Foreign tasks and operations can never emit the automatic-elevation marker. Approve the
dashboard UAC prompt or rerun `ocx service install` in an elevated PowerShell window.

### `ocx codex-shim <subcommand>`

Wrap a script-based `codex` launcher on PATH with a lightweight autostart script. Real `codex.exe`
targets are left untouched to avoid breaking exact executable invocations.

If a completed external Codex update overwrites an installed shim, the next ordinary `ocx` command
backs up the stable new launcher and restores the shim before dispatch. A launcher that is still
changing is left untouched and retried later. Repair failures warn without failing the requested
command; manual fallback: `ocx codex-shim install`. Set `codexShimAutoRestore` to `false`, or set
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` for a process-level opt-out.

| Subcommand | Action |
| --- | --- |
| `install` | Install the shim (or repair if stale). |
| `uninstall` | Remove the shim and restore the original Codex binary. |
| `remove` | Alias of `uninstall`. |
| `status` | Report shim state (installed / stale / missing). |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
Use `ocx service` for an always-on background proxy (recommended). Use `ocx codex-shim` for
lightweight, on-demand startup without a daemon — the proxy starts only when `codex` is launched.
:::

## Diagnostics

### `ocx doctor`

Run read-only environment and connectivity diagnostics: state paths and filesystem type, WSL dual
installs, proxy environment/config, ChatGPT reachability, Codex plugin and project-config warnings,
and pending history migration. The Codex app-home targeting section also detects the narrow Windows
Orca runtime-home mismatch and explains service migration when applicable. Paths shown by this new
diagnostic redact the OS username. Doctor prints repair hints but does not apply them.

The **OAuth reliability** section reports whether credential storage is writable, whether refresh
single-flight / lock files can be created under `OPENCODEX_HOME`, non-healthy OAuth or Codex pool
accounts (redacted ids) with a recovery `Action:`, and a static OK that the Codex forward path does
not fabricate official-client metadata. Doctor never mutates credentials or applies repairs.

### `ocx debug [provider|usage …]`

Read or change runtime debug overrides through the running proxy's management API.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

With no scope, `ocx debug` prints usage and, when the proxy is stopped, the next-start environment
defaults. Provider debug defaults from `OCX_DEBUG=1` (legacy `OCX_DEBUG_FRAMES=1` also works); usage
debug defaults from `OPENCODEX_USAGE_DEBUG=1`.

## Updating

### `ocx update`

Self-update opencodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you're already on the newest version for that
tag. A running proxy is stopped before files are replaced; an installed service is rebuilt and
started automatically, while a foreground installation prints `ocx start` as the next step. On
Unix, the updater first checks that the configured npm cache is owned by the current user. It aborts
before stopping the proxy when it finds a foreign-owned cache entry or cannot inspect the cache, so
you can correct the cache ownership or configure a user-owned cache and retry without losing the
running service.

```bash
ocx update
ocx update --tag preview
```

New versions become available the moment the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.

## Help

`ocx help`, `ocx --help`, `ocx -h` — print top-level usage and examples.

`ocx help <command>`, `ocx <command> --help`, `ocx <command> -h` — print command-specific usage for
commands registered in `src/cli/help.ts`. The full `provider`, `debug`, and `v2` subcommand contracts
are documented above.

Unknown commands remain errors even when a help flag is present, so scripts can rely on the exit
code instead of scraping text.

## Version

`ocx --version`, `ocx -v`, `ocx version` — print a single script-friendly version line and exit.

## Internal commands

Two dispatch targets are intentionally omitted from normal help: `__refresh-version [preview]`
refreshes the update-notification cache in a detached process, and
`__gui-update-worker <job-id> [latest|preview] [restart]` runs a dashboard update job. They are
implementation details, not stable user-facing commands.

The dashboard persists the detached update worker PID and automatically recovers an active job if
that worker is no longer alive. Active records written by older releases without a PID are treated
as stale after ten minutes. A live worker remains protected from concurrent updates even if the
update takes longer than that window.
