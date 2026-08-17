# GUI And Management API SOT

## Dashboard serving

The bundled React dashboard is built into `gui/dist` and served by the same Bun proxy. `ocx gui`
starts the proxy when needed and opens `http://localhost:<port>`.

All ordinary HTTP responses (excluding successful WebSocket upgrades) include `X-Frame-Options: DENY` and
`Content-Security-Policy: frame-ancestors 'none'`. This prevents another page from framing the local
dashboard or management responses. Embedding the dashboard in an iframe is intentionally
unsupported; deployments that previously relied on such embedding must open it as a top-level page.

## Authentication boundaries

OpenCodex keeps data-plane authentication separate from the management plane. The admin-token
gate is intentionally removed: every `/api/*` route is reachable without `OPENCODEX_ADMIN_AUTH_TOKEN`,
an `admin-api-token` file, or a GUI session.

| Credential class | Sources | Allowed surface |
| --- | --- | --- |
| Data plane | `OPENCODEX_API_AUTH_TOKEN`, the `service-api-token` file loaded through `OCX_API_TOKEN_FILE`, and `config.apiKeys` | `/v1/*` HTTP endpoints and new data-plane WebSocket handshakes only |
| Management plane | None | `/api/*` without an admin credential |

The service token file remains a delivery mechanism for the data-plane environment token. Removing
the management gate is deliberately broad: a non-loopback listener exposes provider settings,
account controls, exports, logs, and other management operations to any caller allowed by the
management CORS policy. Deployments that need confidentiality must keep the proxy loopback-only or
place it behind an external authenticated boundary.

Proxy admission credentials must never reach an upstream provider. The forwarding guard rejects the
`ocx_data_`, `ocx_admin_`, and `ocx_session_` prefixes, historical keys matching
`^ocx_[0-9a-f]{40}$`, both environment tokens by constant-time comparison, and manually configured
data keys by constant-time comparison.

Audit item #16 remains partially deferred. This credential split protects new WebSocket handshakes,
but the following established-connection controls are intentionally outside this batch and must not
be treated as implemented:

- revoke an already established connection when its data key is deleted;
- enforce an idle timeout;
- reauthenticate subsequent frames after the handshake.

## API ownership

`src/server/index.ts` routes unauthenticated `/api/*` requests to `src/server/management-api.ts`:

| Endpoint area | Responsibility |
| --- | --- |
| Config/settings | Read safe config/settings views; mutate supported settings only. Full `PUT /api/config` is disabled so masked secrets are not round-tripped. `PUT /api/settings` accepts `codexAutoStart` and/or `streamMode` (each optional, at least one required); `streamMode` persists the #314 stream-shape selection in config.json because Windows services do not inherit shell env. |
| Startup safety | `GET /api/startup-health` reports whether injected Codex routing is restart-safe, with secret-free service/shim diagnostics. `POST /api/startup-action` provides allowlisted one-click installation for the background service or launcher shim. On Windows a healthy script shim is CLI-only; Codex Desktop requires the background service for full protection. |
| Windows tray | `GET/POST /api/windows-tray` controls an owned, per-user HKCU login tray. The tray delegates fixed actions to the CLI and is never a proxy supervisor or restart-protection signal. |
| Updates | `GET /api/update/check`, `POST /api/update/run`, and `GET /api/update/status` own dashboard self-update state. A launched worker PID is persisted in `update-job.json`; dead PIDs recover immediately, while legacy active records without a PID recover only after ten minutes. Live PIDs remain exclusive regardless of record age. |
| Providers | Create/update/delete ordinary provider configs and enrich registry metadata. The reserved `openai` card exposes Pool(default)/Direct account mode; `openai-apikey` remains the separate API route. |
| Models | Fetch routed model lists, disabled model visibility, and catalog-facing ids. |
| OAuth | Login/status/logout for OAuth-backed providers, plus multiauth account management: `GET /api/oauth/accounts`, `PUT /api/oauth/accounts/active`, `PUT /api/oauth/accounts/alias`, `DELETE /api/oauth/accounts` list masked accounts per provider, switch the active one, edit its display-only alias, and remove one. Login accepts `addAccount: true` to force a fresh browser identity. Device flows return a structured `deviceCode`; the GUI highlights and copies it before the user opens the verification page. |
| Key providers | Expose API-key provider presets for setup and dashboard flows. Multi-key pool per key-auth provider: `GET /api/providers/keys`, `POST /api/providers/keys`, `PUT /api/providers/keys/active`, `PUT /api/providers/keys/alias`, `DELETE /api/providers/keys` masked list, add (upsert + activate), switch, rename, and remove keys. `provider.apiKey` always mirrors the active pool entry so routing stays single-key. |
| OpenAI account mode | Report one OpenAI Codex card with Pool/Direct controls and one API-key card. Mode PATCH persists live without restart or catalog identity changes; Pool owns account/quota controls and Direct uses caller/main login only. Main-account DTOs report real credential presence and terminal `needsReauth` state instead of treating missing/invalid native auth as an unknown quota. |
| Subagents | Read/write the featured `subagentModels` list capped at five ids. `GET/PUT /api/injection-model` manages the shared delegation model/effort selection, the independent OpenCodex guidance switch, and the default-off `syncCodexSubagentDefaults` opt-in for native Codex subagent defaults. When OpenCodex owns the active Codex routing, native `[agents]` defaults apply to newly created Codex tasks after sync/restart; external user-managed provider configs remain untouched. The defaults do not cause delegation and preserve existing user-owned defaults rather than overwriting them. PUT is partial-update: absent keys are unchanged, `null` clears, and non-object bodies are rejected with 400 before field validation. `syncCodexSubagentDefaults: true` requires a nonblank `model` and a supported Codex reasoning effort when effort is set; clearing `model` (null/empty) always clears effort and disables native-default sync even when the stored effort was invalid. |
| V2 / Multi-agent mode | `GET/PUT /api/v2` — reports/sets the codex `multi_agent_v2` feature flag, the 3-state `multiAgentMode` override (`v1`/`default`/`v2`), and the logical maximum thread count. Selecting `v2` enables the native flag and migrates `[agents] max_threads` to the v2 key; selecting `v1` disables it and migrates the same value back. `default` leaves the native flag unchanged. PUT accepts `enabled`, `multiAgentMode`, and/or the compatibility-named `maxConcurrentThreadsPerSession`; contradictory mode/flag pairs are rejected before writes. Every transition is rollback-safe and resyncs the catalog. |
| Logs & Debug | One sidebar entry (`/#logs`) with two tabs. Logs tab: request/runtime logs for local diagnosis. Debug tab (`/#logs/debug`; legacy `/#debug` deep links redirect there): provider + usage toggles, refresh/follow log viewer. `GET/PUT /api/debug`; `GET /api/debug/logs` and `GET /api/debug/usage-logs` (monotonic `after` cursor, legacy `since` accepted). CLI: `ocx debug provider|usage …` (both streams via running proxy API). |
| Log files & undo | `GET /api/logs/footprint` reports both absolute log paths, row/line counts, and the enforced retention. `DELETE /api/logs` commits `usage.jsonl` + `logs/` into the local state-history repo **and awaits that commit** before unlinking either; a failed commit answers `snapshot: false` and the delete still proceeds — history must never fail the operation the user asked for. `POST /api/logs/restore { commit }` writes a revision back, appending a pre-restore commit and a post-restore commit so the undo is itself undoable, and needs no drain or restart because logs are not credentials. Both re-seed the in-memory request and debug rings from disk, or the screen shows the opposite of what just happened. |
| Usage | `GET /api/usage` aggregate read-only summary derived from `~/.opencodex/usage.jsonl`; measured / reported / unreported / unsupported / estimated counts, daily zero-filled grid, model and provider breakdowns. Never exposes prompts. |
| System | `GET /api/system/memory` — service-process runtime/memory identity (pid, Bun version/revision, platform, RSS/heap/external/ArrayBuffers scalars, observed memory = max(RSS, external, ArrayBuffers), `bun:jsc` heap context, streamMode + eager-relay gate decision, watchdog snapshot sliced to the last 60 samples). Scalar-only payload; rides the standard management auth gate and must never move to unauthenticated `/healthz`. Consumed by `ocx doctor`'s Memory/runtime section and the dashboard Memory observability card. |
| Stop | `POST /api/stop` — restore native Codex, stop any installed service, and exit the proxy. |

Provider writes must not round-trip masked API keys as real secrets. Dashboard actions that change
model visibility or subagent selection should trigger catalog/cache sync behavior through the server
path that owns it.

The UI must show one provider card and one Models group for Codex-login OpenAI, describe Pool and
Direct accurately, and keep the main account inside Pool. Public model state keeps virtual Pro ids
even though transport logs may additionally report the resolved base model. Detailed rules live in
[`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

User aliases are display metadata only. Codex pool aliases live on `CodexAccount`, OAuth aliases on
`ProviderAccount`, and API-key aliases reuse the existing key `label`; account ids, credential
identity, active selection, and routing never consult these fields. The matching CLI is
`ocx account alias <provider> <id> <display-name|->` (`rename` is accepted as a synonym).

## Sidebar stop button

The dashboard sidebar includes a stop button that calls `POST /api/stop`. The button shows a
confirmation prompt, then fires the request and accepts the connection drop (the proxy exits). The
endpoint restores native Codex config, stops any installed service to prevent respawn, and exits.

## Startup safety

The dashboard sidebar exposes a **Startup safety** page. Its warning state is derived from active
Codex routing plus the actual service and launcher-shim installation state; the
`codexAutoStart` preference alone is never presented as proof of restart protection. The page shows
copyable repair commands (`ocx service install`, `ocx codex-shim install`, and `ocx restore`). On
Windows it can also install an owned, per-user system tray. The resident tray owns only its icon,
home-scoped singleton, and HKCU Run registration; fixed proxy actions delegate to the CLI so drain,
service conflict handling, native restore, and PID identity remain centralized. Tray presence never
makes `startup.status` protected.

Windows Task Scheduler create failures must not depend solely on localized `schtasks.exe` text.
When the owned fixed-shape `/create /tn opencodex-proxy /xml ... /f` command exits with status 1,
the effective-token elevation probe may classify it as access denied only when the token is known
to be non-elevated. An unavailable probe remains `other` and cannot trigger UAC. Query, run, delete,
native-service, file-write, and foreign task failures never use this fallback.

```text
[Decision Log]
- 목적과 의도: Make Windows scheduler installation recovery work on non-English systems without broadening the commands that may request UAC.
- 기존 구현 및 제약 조건: Access-denied classification parsed English and German stderr. Chinese OEM output decoded as UTF-8 became mojibake, so the fixed scheduler-create failure lost its machine marker and the dashboard could not select its existing elevation transaction.
- 검토한 주요 대안: Add translations and code-page decoders; elevate every scheduler failure; always launch installation elevated; or combine a native effective-token probe with the already fixed command shape and exit status.
- 선택한 방식: Preserve text detection, then use the native token probe only for status-1 creation of the owned `opencodex-proxy` XML task. Unknown probe results fail closed.
- 다른 대안 대신 이 방식을 선택한 이유: Windows localization and OEM code pages are open-ended, while the token state and owned command shape are stable security signals already bounded by the elevated transaction protocol.
- 장점, 단점 및 영향: Non-English users receive stable guidance and dashboard UAC recovery. A non-permission status-1 failure from the exact owned command may be retried once elevated, but foreign operations cannot cross the elevation boundary and the elevated transaction still fails closed.
```

Dashboard updates persist their detached worker PID before returning success. This lets a later run
distinguish a live installer from a worker that crashed. Records created by older versions do not
have a PID, so they remain exclusive for a conservative ten-minute window before automatic
recovery; operators no longer need to delete `update-job.json` after a dead worker.

```text
[Decision Log]
- 목적과 의도: Prevent a crashed dashboard update worker from permanently blocking every later update.
- 기존 구현 및 제약 조건: The job file was written before spawn, the returned PID was not persisted, and active status had no liveness or freshness check.
- 검토한 주요 대안: Require manual deletion; expire all jobs by age; or persist PID and use age only for legacy no-PID records.
- 선택한 방식: Persist and verify PID liveness, with a ten-minute fallback only for legacy records.
- 다른 대안 대신 이 방식을 선택한 이유: It recovers known-dead workers promptly without allowing a second installer beside a long-running live worker.
- 장점, 단점 및 영향: New jobs self-recover after worker death and spawn failures become visible; legacy crashes may remain blocked for up to ten minutes.
```

## UX boundary

The dashboard is a local control surface, not a separate service. It should reflect the same config
and catalog invariants documented in this folder rather than inventing parallel state.

The `/#codex-auth` add-account modal has a three-step manual-code UX contract on top of the existing
OAuth polling API: submit request, waiting-for-login completion, and terminal success/failure. Once
`POST /api/codex-auth/login/code` succeeds, the GUI must keep the input disabled, expose an
`aria-live` status message that the code was accepted, and surface repeated `login-status` polling
network failures as a visible warning instead of silently looking idle again.

## The tab strip, and the invariants groups add to it

Tab semantics are pure functions in `shared/m3/tabs.ts`, and both the dashboard (`gui/src/shell/`)
and the documentation site consume them. Neither surface may re-implement a rule locally: the reason
the module exists is that the two had already drifted, and for one rule in particular that is not
cosmetic — `bulkCloseTargets` is the single answer to "what would this close", read by both the
confirmation preview and the close itself, so a second copy is a dialog that shows four tabs and
shuts five.

Invariants a change must not break:

- **The strip never empties.** Every close path spares one tab; a zero-tab shell has nothing to render.
- **A pin means the tab stays on screen.** It is excluded from close-others, close-to-right and both
  bulk closes by default, it is never overflowed, and it is never hidden by a group collapse.
- **A pinned tab keeps its group.** Layout puts it ahead of every group run rather than inside one —
  the pinned region must stay visible when everything else overflows, and a collapsible header around
  it could not promise that. Membership survives anyway, because "pin this group" has to be
  reversible: erasing it would empty the group as the pin was applied.
- **Collapsing never hides the active tab.** `toggleGroupCollapsed` moves the selection out first, and
  `visibleTabs` exempts the active tab regardless.
- **A search reveals, it does not unfold.** Activating a result inside a collapsed group selects the
  tab and leaves the group collapsed. Expanding would undo a preference the user set.
- **Restore is verbatim.** `reviveTabs` replays a stored strip exactly as written rather than
  re-sorting it; every reducer that can disturb the order re-orders already, so sorting on read only
  ever rearranges a strip that arrived some other way. The renderer coalesces a group's members
  itself, so a scattered stored order still draws one header.
- **Decoration is never identity.** A group's accessible name is its name and member count; its icon,
  badge, small caps and colours are additive. A group header is a button with `aria-expanded`, never a
  `role="tab"` — everything that counts tabs counts that role.
- **Each search field owns its own query.** The four tab searches each call `useSearchQuery`
  separately; there is no shared object for two fields to drift through, and that is structural
  rather than a convention to be remembered.

The tab context menu offers exactly eight commands. Group membership is reached by drag, by
<kbd>Alt</kbd>+Arrow, and from the search panel — not by growing a menu whose shape people have
learned and whose destructive entries sit under the pointer's muscle memory.

## Logs on disk, and the undo that guards deleting them

`src/lib/app-log-file.ts` mirrors every `appendDebugLogLine` into
`~/.opencodex/logs/opencodex.log` (mode `0o600`), timestamped, one line per entry, so the proxy's own
diagnostics survive the process that wrote them and are readable in a text editor with nothing
running. The bound is arithmetic and not a background job: rotate at `MAX_LOG_BYTES` (2 MiB), keep
`MAX_ROTATED_FILES` (3) generations, hard ceiling `MAX_TOTAL_BYTES` (8 MiB). Rotation renames
oldest-first so no generation is overwritten by the one behind it, and every write path is
self-swallowing — a request must never fail because its diagnostics could not be recorded. The ring
buffer is re-seeded from the file at startup (`hydrateDebugLogFromDisk`) exactly as `/api/logs` is
re-seeded from `usage.jsonl`.

`src/lib/state-history.ts` now tracks two independent path sets in the **same** repository:
`TRACKED` (config/accounts/auth) and `TRACKED_LOGS` (`usage.jsonl`, `logs/`). One timeline, two
undos: restoring a credential snapshot must not throw away the logs explaining why, and restoring the
logs must not roll an account back. `git add -- <paths>` stages only what it is handed, so a log-only
commit leaves the state files at whatever the previous tree held.

Three invariants that are silent when broken:

- **The `.gitignore` must whitelist the log paths.** `*` ignores directories too, and a negation
  cannot reach inside an ignored directory — so `logs/` is un-ignored, its contents re-ignored, and
  the files whitelisted by glob. `git add` *refuses* an ignored path rather than warning, so getting
  this wrong means the snapshot never happens and the delete proceeds with nothing behind it.
  `refreshRepoRules` rewrites the rule files on every `ensureRepo`, because a repo created by an
  older build carries rules that exclude the logs.
- **`.gitattributes` carries `* -text`.** Git's Windows default (`core.autocrlf=true`) rewrites LF to
  CRLF on checkout, so a restored file came back with different bytes than were committed. Merely
  wrong for JSONL; unrecoverable for anything encrypted, which fails indistinguishably from
  corruption in the one path whose job is making data recoverable.
- **Identity is content-borne, never positional.** `usage.jsonl` rows are addressed by `requestId`,
  which travels inside the row. Anything bound to a row's *position* — an autoincrement id, a line
  offset, an AEAD AAD derived from either — stops matching the moment a restore lands the row at a
  different offset.

`src/lib/log-store.ts` owns the ordering, and the ordering is the feature: measure, commit, *then*
unlink. A post-hoc commit records the absence rather than the content, so recovery would depend on
some earlier commit happening to hold the rows — never true for the first clear a machine performs.
Revision subjects name what changed with counts (`cleared 1,204 request log rows and 87 app log
lines`), because a history whose rows all say "Updated" is one nobody can navigate; an unchanged
state commits nothing.

## Usage accounting

`src/usage/log.ts` writes append-only JSONL to `~/.opencodex/usage.jsonl` with file mode `0o600`.
`src/usage/summary.ts` turns that file into the `/api/usage` shape — totals, daily zero-filled
grid, model and provider breakdowns, and `measured / reported / unreported / unsupported / estimated` counts.
Missing usage is never treated as zero. The dashboard Usage tab renders the same shape, and the
main Dashboard surfaces a 30d token / coverage summary. The in-memory `requestLog` is capped at
200 entries and is **not** the source of truth for aggregation — the JSONL on disk is.

The management API caches only the compact summary for an exact file revision and query; it never
retains normalized per-request rows after a response. The cache invalidates on any identity, size, or
timestamp change and at the next range expiry or local-day boundary. Rebuilds parse in bounded
batches and yield between them, so unrelated management requests remain serviceable even for a large
existing log. The Dashboard polls its 30-day usage summary independently once per minute, so usage
work cannot delay health/provider/settings state or run every five seconds.

[Decision Log]
- 목적과 의도: Keep dashboard and management requests responsive as `usage.jsonl` grows.
- 기존 구현 및 제약 조건: The JSONL file remains the durable source of truth and may be truncated, replaced, or hand-edited.
- 검토한 주요 대안: Retain normalized rows, maintain a second database, or cache only revision-keyed summaries and cooperatively rebuild them.
- 선택한 방식: Keep only bounded summary results, share full reads by exact file identity, yield during parsing, and poll usage separately at a slower cadence.
- 다른 대안 대신 이 방식을 선택한 이유: It bounds resident heap and avoids a second persistence format while keeping unrelated endpoints responsive.
- 장점, 단점 및 영향: Unchanged queries are cheap and memory stays bounded; a changed large log still consumes rebuild CPU, but cooperatively and at most once per observed revision/query.

For diagnosing upstream-shape / usage-extraction issues run `ocx debug usage on` (or set
`OPENCODEX_USAGE_DEBUG=1` before start). The proxy then writes a rolling debug record per finalized
request to `~/.opencodex/usage-debug.jsonl` (mode `0o600`, auto-trimmed to the most-recent 100 lines
once it exceeds 200) with the upstream content-type, body kind (`sse / json / other / none`), a 2KB
body sample, and the extracted usage. Off by default; the hot path is guarded so production stays
untouched.

## Provider debug logging

Provider transport diagnostics (dropped SSE frames, adapter dial/stream events, etc.) are opt-in:
`ocx debug provider on` / `ocx debug provider off` on the running proxy, the Debug-page toggle, or `OCX_DEBUG=1` on
the next start (legacy `OCX_DEBUG_FRAMES` still enables the same path). Lines
use the `[ocx:<adapter>:<event>]` prefix, go to the proxy terminal, and are buffered for
`ocx debug provider logs` / `ocx debug provider logs -f`. Usage JSONL tails with
`ocx debug usage logs [-f]`. Separate from provider buffered logs above.
