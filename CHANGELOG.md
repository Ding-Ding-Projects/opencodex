# Changelog

Generated from release tags by `bun scripts/generate-changelog.ts`.
Preview tags are omitted. The dashboard reads this file through `/api/changelog`.

## Unreleased

Hand-written until the next release tag exists. The generator rebuilds this file
from tags and takes each entry from a commit subject, so these lines are absorbed
into their release section — not lost — the next time it runs.

- feat(gui): show every context-menu item's keyboard shortcut from one binding registry
- fix(test): read GUI endpoints from call sites, not documentation prose

## 2.7.42 — 2026-07-28

- fix(ci): tighten issue-quality soft-pass structure gate
- fix(ci): soft-pass detailed issues after maintainer retitle
- fix(cli): make star prompt opt-in
- fix(bridge): CodeRabbit follow-ups for phase omit and content_filter (#556)
- fix(bridge): keep wire heartbeats during adapter-only progress
- fix(images): support custom relay providers
- fix(memory): observe external Windows retention
- fix(codex): report catalog and cache write signals
- fix(claude): resolve Desktop 3P paths by target platform
- fix(ci): remove broken devlog gitlinks
- fix(logs): classify requested output limits correctly
- fix(gui): give every OAuth login surface the same copy affordance (#544)
- docs(grok): rewrap the fence-clamp comment
- docs(devlog): correct the residual-defect classification after the audit
- docs(devlog): reproduce and classify the three residual Grok sweep defects
- docs(devlog): correct the enforce-target remediation after the audit found it unworkable
- docs(devlog): diagnose the enforce-target permission defect and its state-corruption edge
- docs(devlog): fold the WP3 audit corrections into the PR disposition
- docs(providers): distinguish the two GLM routes in every locale
- test(providers): cover the BigModel contract and the id-collision trap
- feat(providers): add the Zhipu BigModel provider under a non-colliding id
- docs(devlog): refresh the PR disposition against live state before acting
- docs(devlog): correct the PR #536 plan after auditing it against the tree
- docs(devlog): plan the PR #536 Zhipu BigModel provider rework
- fix(grok): stop the orphan sweep from eating the fence it sits next to
- refactor(gui): move the login-URL block styles out of the workspace stylesheet
- fix(gui): give every copy affordance one honest protocol
- docs(devlog): fix the clamp plan's child-scan guard before it reintroduces #511
- docs(devlog): plan the copy-protocol unification and style ownership cleanup
- fix(bridge): classify terminal chat answers
- docs(devlog): plan the Grok fence-clamp fix for the #511 follow-up
- docs(devlog): retract the #511 closure — the sweep destroys an adjacent fence
- fix(ci): preserve nested issue sections
- docs(devlog): record the login-URL parity outcome and the two plan deviations
- fix(gui): restore the non-secure-context clipboard fallback
- fix(desktop): resolve the Claude Desktop config library the way Desktop does
- fix(adapters): restore desktop config and reasoning summaries
- docs(devlog): fold the WP1 pre-build audit blockers into the path-fix plan
- refactor(gui): fold the two duplicated login-URL blocks into the shared one
- fix(gui): give the Codex account modal the login URL, not just a copy button
- fix(gui): derive login-URL copy feedback instead of resetting in an effect
- feat(gui): add the shared OAuth login-URL block
- docs(devlog): plan login-URL copy parity across all three OAuth surfaces
- docs(devlog): fold the A-phase audit blockers into the triage plan
- docs(devlog): plan the 260727 bug triage loop (issue/PR matrices + #539 RCA)
- fix(storage): allowlist cleanup test hooks on management API
- fix(storage): address CodeRabbit review on chunking and errors
- fix(storage): address Codex review on cleanup safety and recovery
- test(storage): close read-only SQLite handles in busy-satellite regression
- ci: close stale needs-info even when roadmap is also set
- fix(storage): make satellite lock acquisition and consolidate restore race-safe
- fix(storage): hold satellite write locks through snapshot and delete
- test(ci): drop redundant stale path allowlist coverage
- ci: drop unused contents permission and tighten path assertions
- fix(kiro): harden completion and throttle recovery
- test(ci): pin stale-needs-info.yml in Cross-platform CI path allowlist
- ci: ensure stale label exists and disable PR unstaling
- ci: harden stale needs-info workflow against Codex review
- ci: auto-close stale needs-info issues after inactivity
- docs(plan): name the external blocker holding wp8 and c5
- docs(plan): mark the main promotion deferred, not forgotten
- fix(gui): restore the copy-login-URL affordance in OAuth login flows
- chore(loop): record the wp9 phase transitions
- docs(plan): the second review found four more leaks, all reproduced first
- test(cli): pin the line break to either CR or LF
- fix(cli): close four more ways the authorization code reached stderr
- fix(storage): persist full satellite backup before any delete commit
- fix(cli): stop an unknown flag from being read as the authorization code
- fix(cli): redact the space-separated --code, and refuse a repeated one
- test(cli): reach the redaction through a command that does not parse --code
- fix(cli): let the OAuth code reach the proxy without passing through argv
- fix(storage): make multi-DB cleanup recoverable under state lock
- docs(plan): the plan review found two blockers, both reproduced
- docs(plan): defer the main promotion, keep the finding it surfaced
- docs(plan): wp8 promotes the gate to main, which is where it actually runs
- fix(storage): reconcile logs/goals/memories on archived cleanup
- chore(loop): close wp5 on dev; c5 stays open until the gate is promoted to main
- docs(plan): record rounds 15-17 of the PR-target gate coverage review
- test(ci): a path filter decides whether the job runs, so pin the list
- test(ci): the harness answers node24, and a narrowed trigger is a mutation
- fix(gui): reset permanent mode on dismiss and localize presets
- ci: run PR checks on dev2-go, so an accepted PR is also a checked one
- fix(storage): address CodeRabbit TOCTOU and recovery messaging
- docs: dev2-go takes pull requests now, in all eight places that said otherwise
- ci: let pull requests target dev2-go, not just dev
- fix(gui): sync cleanup busyRef in an effect
- chore(loop): close wp7 with rounds 11-14 evidence, leave wp5 pending approval
- fix(storage): write cleanup manifest before DB commit
- fix(storage): resolve remaining CodeRabbit cleanup review notes
- test(ci): state fields are read for truthiness, not for their type
- test(ci): trust state written by a version the reader does not know
- fix(storage): bind cleanup to preview digest and make it atomic
- test(ci): cover reachable states, and reject the way Octokit rejects
- test(ci): pin the trigger's shape, not just its name and event list
- test(ci): model the webhook payload, and assert what the comment says
- test(ci): match the shape of each injected binding, not just its name
- test(ci): build the harness scope from the pinned action, not by hand
- test(ci): drain deferred work and cover PRs the author already touched
- fix(storage): address CodeRabbit review on cleanup APIs and i18n
- feat(cli): add headless dashboard parity
- chore(loop): record wp7 hardening rounds in the goalplan ledger
- test(ci): close the harness's global escapes and error-shape gap
- test(ci): make the PR-target harness behave like the real runner
- feat(storage): archived cleanup with quarantine default (phase 2)
- test(ci): run the PR-target script instead of reading it
- test(ci): pin the PR-target workflow by allowlist instead of deny-list
- test(ci): close six more PR-target bypasses an audit round found
- test(ci): tie each draft helper to its GraphQL mutation
- test(ci): stop the comment stripper from truncating string literals
- test(ci): parse the PR-target workflow instead of grepping it
- test(ci): close three holes in the PR-target characterisation tests
- test(ci): pin the current behaviour of the PR target check
- docs(devlog): reconcile the plan with what the check actually did
- docs(devlog): record what the target-branch check actually did to a stacked PR
- docs: mark the maintainer-change procedure as in progress, not complete
- docs: state what the maintainer addition does and does not enforce
- docs: add @Wibias as a maintainer
- docs: carry the branch policy to the public guide and resolve a reviewer conflict
- docs: document dev2-go as an integration line and welcome porting/rebase PRs
- docs(devlog): close the docs-only roadmap cycle for the governance intake
- docs(devlog): record the recommended gate option and its test conditions
- docs(devlog): fix two plan commands that do not actually run
- docs(devlog): bind the split to a frozen SHA and check approvals against the current head
- docs(devlog): correct the plan — a dev2-go PR cannot merge while the check forces draft
- docs(devlog): correct the plan after the fourth audit — sticky automation, live PR state, real approval
- docs(devlog): split the PR-target gate out after three audits broke three designs
- docs(devlog): replace path inference with maintainer labels after the second audit
- docs(devlog): rewrite the governance plan after the audit found it would not take effect
- docs(devlog): plan the governance intake — dev2-go PRs, PR split, maintainer addition
- fix(ci): cancel stale labeler runs on human label changes
- feat(ci): label sentence-case PR titles without conventional colon
- fix(ci): address PR labeler review feedback
- fix(ci): stop PR labeler from reverting human type labels
- docs(devlog): triage the overnight merges, open PRs, and issue backlog
- docs(devlog): close out the Grok dead-port cycle with audit rebuttals and live evidence
- fix(grok): surface a fence that points at a port we are not listening on
- docs(devlog): root-cause the Grok retry loop as opencodex entries pinned to a dead port
- fix Console Go tool schema sanitization
- fix(ci): close freeform issue-quality template bypass
- fix(gui): avoid control-char regex in conversation filter
- fix(logs): address Codex review on conversation correlation (#522)
- fix(kiro): force non-retryable fallback incompletes after prior output
- fix(kiro): force non-retryable classified errors after flushed output
- feat(logs): correlate requests by conversation id (#330)
- fix(kiro): gate fallback setup retryability on prior output
- fix(kiro): address Codex review on stream catch retryability
- fix(kiro): treat pre-output stream socket closes as retryable
- test(combos): cover incompatible omission reason in sync CLI summary
- fix(combos): distinguish incomplete vs incompatible omission reasons
- fix(logs): show effective reasoning effort (#494)
- test(proxy): raise Windows CI budgets for OpenAI auth matrix
- fix(update): require correlated identity after npm GUI restart
- test(gui): expect Models visibility counts as visible
- fix(proxy): sanitize passthrough Retry-After on non-empty errors
- fix(gui): treat unknown combo effort ladders as empty
- fix(combos): address Codex review on catalog omission surfacing
- fix(gui): avoid Set inference error in combo effort intersection
- fix(gui): type attentionCopy with TFn for combo catalog warnings
- fix(gui): isolate debug PUT-order test from client-resource cache
- docs(i18n): align zh/ja config concurrent-edit warnings with #488
- fix(ux): clarify config edits, combo effort picker, model hide naming (#488)
- test(proxy): align #452 Retry-After: 0 expectation with client preserve
- fix(update): require evidence before skipping npm GUI restart
- fix(combos): surface catalog omissions in sync and GUI (#484)
- fix(proxy): harden Retry-After client vs cooldown split
- fix(update): skip redundant GUI restart after npm self-update
- fix(proxy): attach Retry-After on retryable 429s for Codex (#507)
- fix(gui): keep a window.event stub across rail-hover teardown
- fix(ci): force unknown language on incomplete translation attempts
- fix(ci): stop false-English bookkeeping on incomplete translation parses
- fix(gui): flush React teardown before happy-dom window restore
- fix(ci): keep sticky visible translation control comments
- fix(grok): sweep an orphan's sub-tables too, not just its parent
- docs(devlog): record the orphan sweep against the real Grok config
- fix(grok): adopt our own pre-fence model entries so context windows are honoured
- docs(devlog): plan Grok orphan adoption and triage the open PRs
- fix(ci): tighten translation completion contract for parse and apply
- fix(ci): address CodeRabbit translation-state follow-ups
- fix(ci): separate translation rate-limit attempts from completed sources
- fix(ci): preserve literal backslashes when repairing translation JSON
- feat(ci): inline-translate non-English issue comments
- fix(ci): repair invalid LLM JSON escapes in issue translation
- test(claude): prove the settings.json hijack defence per auth resolution
- fix(codex): make manual account selection immediate
- fix(openai-responses): handle image tool conflicts in additional_tools
- fix(release): classify preview lookup by HTTP status, not stderr
- fix(release): baseline only on newest meaningfully carried preview
- fix(release): harden preview note carry for Codex review
- fix(release): carry preview changelog into latest notes
- fix(service): use path-aware trusted executable containment
- fix(service): address CodeRabbit Windows elevation review follow-ups
- fix(service): fail closed on unverifiable Task Scheduler probes
- fix(service): keep elevation spawn tests working without System32
- fix(service): resolve elevated Windows binaries via GetSystemDirectoryW
- fix(service): harden elevation scripts and timeout reconciliation
- fix(service): keep install lock across elevation request timeouts
- fix(service): replace elevated temp-file IPC with protocol exit codes
- fix(service): use one UAC for create+run and fail closed on /run
- fix(service): address CodeRabbit elevation review comments
- fix(service): elevate only structured schtasks create denials
- fix(service): address Windows elevation review feedback
- fix(service): retry Windows background install with UAC elevation

## 2.7.41 — 2026-07-27

- fix(test): make the auth-detect fixtures platform-neutral
- docs(devlog): close out the auth-auto unit with the round-5 review disposition
- fix(claude): keep auto reachable and stop reading our own key as user auth
- docs(devlog): record the WP4 hardening audit and its writer-inventory blocker
- fix(codex): route runtime account writes through the guarded saver
- docs(claude): explain what auto auth mode decides and when
- fix(config): stop service-time saves from clobbering hand-edited claudeCode
- fix(claude): reach plain claude launches when auth mode is auto
- feat(gui): offer an auto auth mode and explain what the next launch will do
- docs(readme): show the four supported clients in a 2x2 gallery
- feat(api): expose the three-state Claude auth mode and its resolution
- feat(claude): resolve the auth mode from detection and fix the marker ordering
- feat(claude): make authMode three-state and migrate legacy subscription intent
- feat(claude): detect Claude auth presence with three-valued semantics
- docs(devlog): record the fourth audit round in the phase map
- docs(devlog): widen the save boundary to request-path config writers
- docs(devlog): bind the detector env, own the config baseline, and label the daemon snapshot
- docs(devlog): fix the marker ordering and split the auth-auto phases after round 2
- docs(devlog): fold the auth-auto audit blockers back into the roadmap
- docs(devlog): plan auth-detected auto mode for the Claude connection
- fix(cli): separate PowerShell recovery commands
- fix(cli): make Orca recovery guidance executable
- fix(test): restore CI timeout assertions
- test(ci): pin split timeout ceilings
- ci: allow Windows suite to finish
- fix(usage): reject non-file log paths
- fix(state): contain directory iteration failures
- fix(state): cap directory enumeration
- fix(cli): harden Orca home diagnostics
- fix(state): make stale cleanup race-safe
- fix(usage): bound dashboard summary caching
- fix(usage): preserve read failure diagnostics
- fix(cli): diagnose Orca Codex home mismatch
- fix(state): recover abandoned response snapshots
- fix(usage): keep large dashboard logs responsive
- test(grok): resolve the writer-boundary paths cross-platform for Windows CI
- fix(docs): claim "opencodex" as the Google site name
- feat(gui): give the Grok page per-model switches in the shared collapse chrome
- feat(cli,docs): surface proxy-down restart guidance and Kiro CLI prerequisite
- feat(grok): add per-model selection state with alias-stable exclusion and guarded re-apply routes
- feat(claude): normalize Desktop 3P labels and guard the written model list
- feat(usage): bucket Grok traffic under its own surface, and stop the codex filter swallowing claude-desktop
- feat(gui,claude): surface the Desktop 1M capability as a read-only chip
- docs(devlog): record the live render evidence for the context fixes
- fix(gui,claude): show 1M contexts and real native windows on Desktop and Grok
- docs(devlog): name both native-context consumers in the defect map
- docs(devlog): verify Grok extra_headers and the native-1M writer gap
- docs(devlog): correct the defect root causes after adversarial review
- docs(devlog): root-cause the context, claude-api, tag, and usage defects
- fix(providers): recover a config migrated across Alibaba regions
- test(gui): cover the Desktop row disclosure and record its render evidence
- feat(providers): add a provider-id reference rewriter
- feat(gui): collapse Desktop model rows to a summary, expanding to the edit controls
- fix(codex): give users an escape from a stuck quota cooldown
- fix(codex): stop the config journal from freezing its first snapshot
- docs(devlog): call the rewriter deterministic, not pure — it mutates in place
- docs(devlog): 260726 issue loop roadmap — 21 issues triaged, 3 phases at diff level
- feat(gui): stack the Claude Desktop families vertically behind collapsible headers
- docs(devlog): fold the plan audit back into the model UX roadmap
- docs(devlog): plan the vertical, collapsible model UX for Desktop and Grok
- docs(devlog): record newness explicitly instead of inferring it
- docs(devlog): tour is first-run only, and the rescan found the trigger is broken
- docs(devlog): record the guided-tour interview decisions and contradiction scan
- docs(devlog): record the guided-tour draft, deferred to a later release
- docs(devlog): design the declarative announcement + onboarding substrate
- feat(grok): add a read-only Grok status surface to the dashboard
- feat(gui): keep the Claude Desktop lanes navigable as models grow
- fix(grok): send native context windows so Sol stops reporting 200k
- fix(gui): keep the locale menu inside the sidebar as locales grow
- fix(claude): stop the Desktop profile parser from rejecting applied-state markers
- docs(devlog): 260726 GUI/Grok improvement roadmap — 5 items, causes located
- fix(router): warn when a pinned provider discards a configured baseUrl
- docs(devlog): 260726 PR rework v2 roadmap — 14 open PRs classified
- fix(gui): propagate health-only reauth into Providers attention state
- test(proxy): add endpoint regressions for model_not_found fidelity
- fix(proxy): force cyber_policy to HTTP 400 over upstream 5xx
- docs(devlog): record the final gate results for the merge hardening unit
- test(gui): guard Claude Desktop locale coverage against blank values
- fix(cli): surface why a proxy stop failed instead of a bare failure line
- fix(proxy): address cyber_policy review feedback
- fix(responses): strip max_output_tokens and metadata in forward mode
- docs: retire the claudedesktop branch from the branch policy
- fix(proxy): preserve OpenAI cyber_policy errors end-to-end
- test(gui): assert the Claude tab wrapper mounts the stacked ClaudeCode page
- fix(oauth): address CodeRabbit review on PR 479
- fix(oauth): address Codex review on health CLI/GUI paths
- test(gui): align next-session badge assertion with OAuth health
- fix(oauth): point Codex reauth actions at the dashboard
- fix(cli): use ocx login in OAuth recovery actions
- docs: document OAuth reliability and diagnostics
- test(codex): lock metadata pass-through and non-fabrication
- fix(gui): never fall back to raw account id in health UI
- feat(gui): surface OAuth account health diagnostics
- feat(cli): add OAuth reliability checks to ocx doctor
- feat(cli): show OAuth health in ocx status
- feat(oauth): add shared account health projection
- feat(oauth): lock and CAS generic provider token refresh
- test(oauth): cover forbidden keys in logOAuthEvent
- feat(oauth): add redacted structured OAuth event logger
- feat(privacy): add maskAccountId for OAuth diagnostics
- docs: add OAuth reliability design and implementation plan
- fix(gui): await provider refresh before notes editor closes
- fix(gui): address Codex and CodeRabbit follow-up review
- fix(test): drop assertions for removed unused GUI exports
- chore(gui): document intentional react-doctor policy disables
- fix(gui): clear remaining react-doctor code findings
- fix(registry): fill per-model modality defaults beneath user overrides
- fix(xai): declare grok image input so combos are not advertised text-only
- fix(codex): omit remaining when post-reset WHAM refresh is not fresh
- fix(codex): return authoritative remaining after reset-credit consume
- fix(gui): make Codex reauth StrictMode-safe and abort stalled polls
- fix(gui): address CodeRabbit findings on Codex account pool
- fix(gui): harden Codex OAuth typing and update seam tests after extract
- fix(gui): address Codex review on OAuth cleanup and reset a11y
- refactor(gui): react-doctor cleanup for Codex accounts
- fix(gui): address remaining CodeRabbit nits on #470
- fix(gui): keep Claude sidecar Auto as a selectable draft
- docs(devlog): 260726 배치 실행 영수증 — 통합 5건, close 5건, 보안보류 리뷰 5건
- docs(providers): add free-provider directory as inert metadata (#405)
- feat(minimax): support split reasoning and adaptive thinking (#431)
- fix(gui): resolve ClaudeCode eslint and sidecar Auto persist gap
- fix(gui): serialize Subagents save with ref guard and readJsonOrThrow
- test(gui): close regression gaps in the react-doctor page fixes (#468)
- fix(ci): harden web-search byte-liveness timing and address #470 review notes
- test(gui): cover Claude toggle and Subagents busy races
- fix(gui): preserve last-good API keys when refresh fails
- fix(kiro): honor native stop reasons and Opus 5 effort (#460)
- docs(devlog): WP2 A-gate 반영 — #429를 보안 보류로 재분류
- fix(gui): close Startup/Storage/Usage abort and Debug PUT races
- fix(gui): address CodeRabbit findings on Claude toggle, Subagents busy, logs keydown tests
- test: raise Windows timeout for multi-agent boolean/inline migration
- fix(gui): point rail delete seam test at extracted Providers CRUD hook
- fix(gui): handle undefined JSON bodies in Providers fetch/oauth hooks
- refactor(gui): react-doctor cleanup for Models
- fix(gui): harden Dashboard poll edge cases after Codex review
- fix(gui): tighten Providers extract types after rebase
- fix(gui): re-split ClaudeCode and ApiKeys after foundations rebase
- fix(gui): address CodeRabbit Combos a11y and numeric guards
- fix(gui): restore request ownership for misc react-doctor pages
- fix(gui): harden Subagents empty-body load handling after rebase
- refactor(gui): react-doctor cleanup for Providers
- refactor(gui): react-doctor cleanup for Dashboard
- refactor(gui): react-doctor cleanup for App, Logs, and Subagents
- refactor(gui): react-doctor cleanup for Startup/Debug/Storage/Usage
- docs: clarify Bun CLI requirement for source development (#437)
- docs(devlog): 260726 PR close/rework 로드맵 — 11문서 diff-level 계약
- fix(gui): keep combo detail draft updater pure under Strict Mode
- fix(gui): address CodeRabbit OpenAI recovery follow-ups
- fix(gui): address Combos review blockers for clientKey and dialog dismissal
- refactor(gui): split Combos workspace for react-doctor
- fix(gui): defer client-resource store eviction across resubscribe churn
- fix(gui): scope API auth fetch to same-origin /api and /v1
- fix(gui): address remaining CodeRabbit findings on foundations
- fix(gui): replace aborted client-resource fetches when subscribers remain
- fix(proxy): run DNS guard on disabled OpenAI re-enable
- fix(gui): abort in-flight client-resource fetches owned by unsubscribers
- fix(gui): wipe legacy API token storage and per-subscriber poll fetchers
- fix(proxy): tighten canonical OpenAI recovery security gates
- fix(gui): harden client-resource and fetch-json for review findings
- chore: untrack .codexclaw goalplan artifacts
- test(gui): cover Codex Auth OpenAI recovery click journey
- fix(gui): address Codex review on OpenAI recovery gates
- fix(gui): gate OpenAI recovery on canonical provider shape
- fix(gui): restore OpenAI account setup paths（恢复入口）
- chore: untrack .codexclaw goalplan artifacts
- chore: untrack .codexclaw goalplan artifacts
- fix(gui): add react-doctor shared foundations
- chore(gui): pin react-doctor to 0.9.1
- fix(proxy): preserve Retry-After and redact tenant URLs in debug
- fix(proxy): only wrap empty passthrough error bodies
- fix(proxy): stop surfacing empty 503 bodies as Codex Unknown error
- fix(gui): document /v1/models auth in German API Access copy
- test(api-access): tighten Messages gate and IPv6 Host coverage
- fix(gui): address CodeRabbit ApiKeys i18n and UX nits
- fix(gui): move ApiKeys helpers out of the component module
- fix(api-access): gate Messages, classify aliases, and use request host
- fix(subagents): require pool accounts from resolved routes
- fix(update): protect live allowlisted listeners from TCP row resets
- fix(subagents): classify fallback nativeness from resolved routes
- fix(ci): treat this/current/present issue as one-sided related attributions
- fix(subagents): preview account before fallback and finalize terminals
- fix(ci): reject mixed HTTP/errno related failure signatures
- test(ci): lock related matcher against issue-number signature collision
- fix(ci): address CodeRabbit findings on triage and translation durability
- fix(ci): require shared quantifiers to bind to concrete failure tokens
- fix(ci): reject related matches with distinct failure signatures
- test(subagents): use documented native slugs in encrypted fallback coverage
- fix(ci): harden triage related matching and translation state safety
- fix(subagents): settle fallback before normalize and share quota primes
- fix(ci): restore marker-only bot comments for English cooldown state
- fix(ci): delete English control comments only after cache save
- fix(subagents): await quota prime, atomic fallback PUT, shared rate-limit health
- fix(subagents): harden fallback routing for #391
- fix(subagents): address follow-up PR #391 review feedback
- fix(subagents): address PR #391 review feedback
- fix(subagents): defer fallback until auth and record tee failures
- fix(subagents): harden quota-aware model fallback routing
- feat: quota-aware subagent model fallback chain (#374)
- fix(ci): store English translation cooldown off the issue timeline.
- fix(update): never kill arbitrary ocx listeners during port reclaim
- docs(grok): state what the integration actually does on non-loopback and reload
- fix(lifecycle): keep the Grok fence and the service in agreement on teardown
- fix(grok): refuse auto-registration on non-loopback binds
- fix(grok): canonicalize both TOML key segments and restore user config byte-for-byte
- docs(devlog): fold A-gate audit into the roadmap — B1 reverts to refusing non-loopback auto-registration (env_key leaks the xAI session token), B5 makes inject injective, 030/040 close the teardown hole and the unsafe tests
- docs(devlog): 260726 grok build production roadmap — blocker inventory + upstream source evidence + 5 implementation cycles
- docs(devlog): wp6 receipt — pre-QA smokes (tool-call round-trip 2-layer proof, catalog, reasoning bridge)
- docs(site): Grok Build integration guide
- docs(devlog): wp4 plan + receipt (ensure/restart hardening, heartbeat decision)
- fix(cli): restart proceeds past service-manager stop failure
- feat(grok): deterministic fence on ensure/restart + heartbeat safety regression
- docs(devlog): wp3 design + receipt (grok config auto-inject, 4-round review)
- fix(grok): decode TOML \uXXXX/\UXXXXXXXX escapes when reserving user aliases
- fix(grok): recognize quoted/whitespace-padded TOML model headers for alias reservation
- fix(grok): data-safety hardening for config inject/strip
- feat(grok): auto-register/unregister opencodex models in Grok Build config
- feat(grok): fenced managed-block inject/strip module for ~/.grok/config.toml
- fix(usage): preserve raw adapter usage provenance via bridge onUsage callback
- docs(devlog): wp1 receipt — usage details always-emit verified (3-way grok exit 0)
- fix(usage): always emit token-detail objects for strict Responses/chat clients
- docs(devlog): grok-build bridge roadmap (a5727c5 pull, smoke matrix, wp1/wp2 plan)
- chore: .codexclaw 추적 해제 — gitignore 원래 의도로 복원
- fix(ci): keep English translation state in bot-owned comments
- docs(devlog): WP8 실행 영수증 — dev ebc62d1f, CI 6/6, PR 8건+이슈 3건 close, 리뷰 11건
- fix(ci): silence English translation bookkeeping and harden related-issue matches
- fix(update): harden port reclaim against foreign sockets and fake Windows signals.
- docs(devlog): WP8 A-gate 반영 — #426 STALE 보류, 게시 10건 확정, rebase 완료 문구
- fix(update): reclaim configured port after stop instead of hopping
- feat(observability): response-store metrics + BizRouter preset
- feat(gui): add custom models from provider workspace (#448)
- docs(devlog): WP6 A-gate blocker 4건 반영 — source-side live count, required prop, Retry CTA, 테스트 배치
- fix(models): make switches reflect final visibility
- docs(devlog): WP5 A-gate blocker 3건 반영 — Models.tsx 충돌 해소 계약, 빈 provider 규칙, stale-generation 테스트
- fix(codex): reset main runtime state after account switch
- docs(devlog): WP4 A-gate 반영 — 호환형 접근 A 확정, 정책 분리표, 2원인 활성화 테스트
- fix(kiro): report context pressure for compaction
- docs(devlog): WP3 A-gate 활성화 공백 2건 반영 — fallback rebuilt estimate 구별, non-stream closure 활성화
- fix(responses): validate message content blocks before use (#435)
- docs(devlog): WP2 마지막 blocker — 통합 assertion을 Google wire 단독으로 확정
- docs(devlog): WP2 fresh 감사 blocker 3건 반영 — 무효절 명시, 통합테스트에 image/file 활성화, file precedence 보강
- docs(devlog): WP2 계획 재설계 — 범위를 PR #436으로 환원, 빈 content 정규화 무효화
- docs(devlog): WP2 A-gate 라운드2 반영 — canonical diff 교체, call-site 정규화, file precedence, Cursor 회귀
- docs(devlog): WP2 A-gate blocker 4건 반영 — 빈 content 정규화, file precedence 개정, detail narrowing
- fix(google): never emit empty or malformed content parts (#420)
- docs(devlog): WP1 A-gate residual 반영 — PRE_APPLY_HEAD 규칙, dev 기준점 갱신, 점유 마커 22건 기록
- docs(devlog): A-gate residual 3건 정리 — sync.ts 경로 교정, 11건 범위, 체크리스트 이동
- docs(devlog): #426/#431 리뷰 본문 추가 — 게시대상 11건 전량 확보
- docs(devlog): A-gate 라운드2 blocker 반영 — 게시대상 11건 확정, #437 defer, WP6/WP7 게이트 필수화
- docs(devlog): A-gate blocker 6건 반영 — 기준점 규칙, 보안 정책, PR manifest, 활성화 테스트
- docs(devlog): 260725 PR/이슈 rework 로드맵 — 9문서 diff-level 계약
- docs(readme): Claude Code 시연 GIF + 실행 우선 히어로 + X 핸들
- fix(api-access): address Codex review on model IDs and endpoint URLs
- fix(api-access): address review feedback for external catalog page
- feat(api-access): expose gateway endpoints and external model catalog
- fix(i18n): add missing Claude Desktop keys to ja/ru locales
- fix(i18n): remove stray rebase conflict-marker lines from locale files
- feat(claude): desktop prefer1m + Claude-shaped alias guard (Luna research 260722)
- feat(gui): desktop status bar + effort transparency + health display
- feat(claude): desktop auto-apply + health monitoring
- feat(claude): desktop client surface discrimination in request logging
- feat(claude): desktop applied-state fingerprint + transactional write + status endpoint
- fix(claude): stabilize desktop apply and legacy aliases
- feat(gui): add Claude Desktop family editor
- fix(claude): protect unavailable desktop routes
- docs(claude): explain desktop family routing
- feat(claude): add desktop family profiles

## 2.7.40 — 2026-07-25

- docs(devlog): record dev integration and issue closure receipts
- docs(devlog): fold integration audit blockers into plan
- docs(devlog): plan local dev integration and issue closure
- chore(goalplan): 260725 버그 스윕 종료 — 5건 수정 완료
- docs(devlog): 260725 버그 스윕 종료 요약
- feat(providers): allow a per-model wire override on mixed gateways (#404)
- docs(devlog): #404 modelAdapters 구현 계약 (A-gate PASS)
- fix(cursor): estimate context from the sent payload when no checkpoint exists (#373)
- docs(devlog): #373 prepared-request 구현 계약 (A-gate PASS)
- fix(responses): stop treating a Responses wire as compaction-trigger support (#422)
- docs(devlog): #422 capability gate 구현 계약 (A-gate PASS)
- fix(service): read omitted Task Scheduler defaults as defaults (#432)
- fix(codex): probe a cooled-down account instead of pinning it for the full window (#433)
- docs(devlog): #433 유닛 분리 — probe lease 구현 계약
- docs(devlog): 260725_bug_sweep r3 — 계획 정밀도 정책 전환 + 사실 오류 정정
- docs(devlog): 260725_bug_sweep r2 — A-gate blocker 12건 반영
- docs(devlog): 260725_bug_sweep 로드맵 — 미해결 비-GUI 버그 5건 diff-level 계획
- docs(readme): 번역 README를 readme/ 폼으로 정리
- fix(gui): ApiKeys/ClaudeCode 클래식 스택 레이아웃 복원
- fix(gui): sidecar 카드 좁은 폭 깨짐 수정 + Usage 스택 레이아웃 복원
- docs(gui): resolveAppHashChange 주석 정정 — Classic/Workspace 선호 설명 제거
- docs(site): Classic/Workspace 절 교체 (WP6) + Back 계약 회귀
- fix(gui): WP5 리뷰 블로커 + docs-site 동기화 (WP6)
- feat(gui): Classic 뷰 경로 철거 (WP5)
- test(gui): WP4 렌더링 기반 회귀 (리뷰 블로커)
- feat(gui): Providers 레일 행 호버 삭제 (WP4)
- fix(gui): 늦게 마운트한 표면의 auto-switch 하이드레이션 (WP3 B3)
- fix(usage): claude-opus-5 가격 등록 (WP7)
- fix(gui): WP3 리뷰 블로커 — 중복 폴링 제거, pause 스케줄링, 전환 경계
- feat(gui): Codex 계정 상태 리프팅 + Overview 계정 조작 (WP3)
- style(gui): Dashboard 레일 죽은 CSS 제거 (WP2 리뷰 블로커)
- feat(gui): Codex Auth 승격 + Dashboard 상단 탭 (WP2)
- fix(gui): address CodeRabbit Claude workspace review
- fix(gui): polish Claude workspace rail and shared select focus
- test(gui): Subagents 동작 수준 회귀 추가 (WP1 리뷰 블로커)
- fix(gui): fix rail row border clipping (outline -> inset shadow)
- gui: add Claude Code workspace view (section rail + main pane)
- feat(gui): Subagents를 Classic 단일 구현으로 통합 (WP1)
- docs(devlog): B5 잔여 지시문 정정 — 이동표의 observer 인자 전달 문장 제거
- docs(devlog): B5 종결 — observer 전달을 subscribeLoadObserver 단일 경로로 통일
- docs(devlog): A-gate 2차 — 070 중복 복구, src 범위 문장 정정, 050 stale 위험 갱신, 030 pause 토큰/observer 계약 확정
- docs(devlog): A-gate 블로커 7건 수정 — 잘못된 bun test 필터, 누락 게이트, 레일 prop 경로, 폴링 소유권, 인용 정정
- fix(docs): Google-compliant favicon — 192x192 PNG + root favicon.ico
- docs(devlog): WP0 로드맵 사이클 — 010~070 decade 문서 (Classic 철거 유닛)
- docs(devlog): Q1-Q8 확정 + WP7 opus-5 가격 + decade 문서 맵 (I-phase 종료)
- docs(devlog): I-phase 인터뷰 확정 — D1~D5 결정, WP2b Dashboard 상단 탭, WP3a 상태 리프팅, WP6 docs 동기화
- fix(gui): harden API Keys workspace overview, create, and landmarks
- test(gui): align API Keys workspace create-guard assertion
- fix(gui): address API Keys workspace review findings
- fix(gui): wire API Keys workspace to global viewMode
- gui: drop per-tab apikeys toggle (sidebar owns it)
- feat(gui): add API Keys workspace view (rail + main, classic toggle)
- fix(gui): stabilize Logs silent refresh and Usage workspace a11y
- docs(devlog): WP3 재정의 — Codex Auth 진입이 아니라 Provider Overview 탭의 계정 조작 통합
- docs(devlog): 260725_gui_view_consolidation P — Classic 뷰 철거 + Subagents/Codex Auth/레일 개편 계획
- fix(gui): stop Logs auto-refresh from flashing Loading above the table
- feat(gui): add Usage workspace wired to global view toggle
- Disable cancel-in-progress for issue-quality workflow concurrency.
- Address CodeRabbit follow-ups on translation rate-limit persistence.
- fix(gui): show Subagents public selector without inferred provider metadata
- Fix PR #440 production parser, block markers, and control-state encoding.
- fix(gui): pass string model ids into Subagents i18n params
- fix(gui): address Codex review on Subagents workspace
- feat(gui): add Subagents workspace wired to global view toggle
- Address CodeRabbit review on inline issue translation.
- Fix PR #440 translation correctness bugs (stale apply, suffix, control state).
- Address Codex review feedback on inline issue translation.
- fix(gui): stack Models workspace when content width is squeezed
- Add inline issue translation with rate limits to issue-quality workflow.
- fix(gui): satisfy eslint hook-state rules
- fix(gui): address codex and coderabbit review feedback
- fix(gui): stabilize models and dashboard control spacing
- fix(gui): show Select keyboard focus and keep session viewMode without storage
- fix(gui): retarget Providers workspace subroute contract after route extract
- fix(gui): treat Classic/Workspace as preference, not history navigation
- fix(gui): guard shadow-call parse failures and close Select review gaps
- fix(gui): replace Providers hash passively; make Select a combobox (#428)
- fix(gui): clear App/Select lint for viewMode deep-link and option ids
- fix(gui): finish PR #428 review — viewMode props, Select a11y, poll ownership
- fix(gui): remove unused writeProvidersViewPreference
- fix(gui): address CodeRabbit and Codex review on workspace toggle
- fix(cursor): harden shell-bridge choice, arg normalize, and allowed_tools priority (#399)
- fix(gui): drop Providers classic toggle and harden dashboard selects
- fix(ci): stop mixed-script CJK from inflating word counts
- fix(ci): tighten issue-quality word count and fenced placeholders
- fix(ci): harden issue-quality terseness and workflow_dispatch PR guard
- fix(ci): address issue-quality review feedback
- fix(ci): reject low-effort feature reports in issue-quality bot
- fix(gui): keep dashboard hooks stable when connection errors
- fix(gui): port upstream dashboard health and guidance into workspace dashboard
- fix(cursor): address CodeRabbit shell-choice and policy assertions (#399)
- fix(cursor): address Codex review on shell bridge aliases
- fix(cursor): stop models narrating native shell as blocked (#399)
- docs(devlog): archive 260724_bugfix_train to _fin (all 6 cycles complete, PR #337 merged)
- feat(gui): configure Codex auto-switch threshold (#337)
- docs(devlog): archive 22 completed/stale _plan units to _fin
- docs(devlog): PR/Issue triage 260725 — tier analysis + priority matrix
- fix(web-search): bound sidecar search deadline to 60s + graceful degradation (#398) (#416)
- fix(gui): portal select dropdowns to avoid clipping (#393)
- fix(anthropic): guard premature no-tool completions (#394)
- fix(openai-chat): keep system messages first (#397)
- feat(live): sideband frame forensics + multibyte UTF-8 transparency tests
- fix(codex): clear stale weekly quota on WHAM/header refresh (#382) (#390)
- fix(cursor): drop dead pin-eviction loop after CodeRabbit review (#399)
- fix(cursor): address CodeRabbit shell-bridge review (#399)
- fix(cursor): harden shell-bridge alias admission and budget pinning (#399)
- fix(cursor): rewrite shell bridge cmd args to command (#399)
- fix(cursor): stop false shell/read blocked reports (#399)
- fix(docs): redesign header preference controls
- docs: move public site to opencodex.me
- fix(claude): sanitize WebSearch domain filters for routed models
- feat(gui): styled hover tooltip to replace native title popups
- fix(gui): replace raw multi_agent_v2 key with Sub-agent label in toast
- fix(gui): restore models picker-order hint (it explains the visibility switches)
- fix(gui): drop redundant set-all label next to cap switch
- fix(gui): models controls layout (set-all next to cap, collapse/expand placement, drop orderHint)
- feat(gui): models collapse/expand all + context for set-all cap switch
- fix(gui): fix rail row border clipping (outline -> inset shadow)
- fix(gui): restore combos block in models workspace + fix rail row border clipping
- feat(gui): dashboard models as searchable per-provider accordion
- fix(gui): keep Select dropdown in viewport (flip up + right-align shadow call)
- fix(gui): let modal backdrop blur show through (lighter overlay tint)
- fix(gui): unify dashboard help popups as centered blurred modals
- gui: drop per-tab models toggle (sidebar owns it)
- gui: add global Workspace/Classic toggle to sidebar
- gui: drop per-tab dashboard toggle (sidebar owns it) + models summary table
- gui: add global Workspace/Classic toggle to sidebar
- fix(gui): cap dashboard workspace tables with internal scroll + sticky header
- fix(gui): uniform 16px vertical rhythm across dashboard overview boxes
- fix(gui): dashboard workspace visual polish (rail header, sidecar grid, spacing)
- gui: add Dashboard workspace view (section rail + main pane)
- gui: add Models workspace view (provider rail + main pane)

## 2.7.39 — 2026-07-24

- No user-facing changes recorded.

## 2.7.37 — 2026-07-24

- fix(server): join GPT-Live sideband on the API host, not backend-api
- fix(server): forward Frameless voice protocol headers on /v1/live relay
- docs(devlog): 260724_gpt_live_hotfix P — #379 status + release plan
- docs(devlog): sse_hardening closeout — all phases landed, WP5b post-hoc C notes, carried-out-of-scope list
- docs(devlog): triage final — #356/#358/#377 MERGED, #378 CLOSED, #370/#376/#379 DEFER
- fix(bridge): pull-driven backpressure for routed SSE streams (WP5b/052)
- docs(devlog): fold WP5b A-gate fix — gated flag mechanics, ungated emit, state hoisting, HWM=1 precision
- fix(server): complete voice relay with sideband WS and AVAS query
- fix(server): address /v1/live review feedback for voice relay
- fix(server): relay ChatGPT/Codex App voice via POST /v1/live
- fix: harden shim restore lock ownership
- fix(responses): bound runTurn event backlog + close fetch-to-reader abort race (WP5a/051)
- docs(devlog): split 050 into 051 (abort guard + queue cap) / 052 (pull-driven) with DECIDED semantics folds
- docs(devlog): WP5 P stale check — gate cleared, fresh anchors, WP2 cleanup-ordering preservation constraint
- style(gui): compact Claude navigation switch
- feat(gui): merge Claude toggle into navigation
- fix: harden Codex shim auto-restore
- docs(devlog): triage #366 merged after author rebuild (Hypatia r2 closed); dedupe rows
- fix(google): ignore whitespace-only EOF residual (C-review Low fold for WP4)
- fix(sse): count upstream comment keepalives as adapter activity (WP4/040)
- fix(gui): address discovery and helper review blockers
- Clarify apply patch envelope
- test(discovery): cover failure activation states
- docs(claude): document native helper fallback
- fix(gui): clarify Claude helper fallback
- feat(gui): show model discovery failures
- feat(api): expose provider discovery status
- fix(catalog): track provider discovery status
- fix: commit shim state inside guarded repair
- docs: document Codex shim auto-restore
- fix: auto-restore replaced Codex shims
- docs(devlog): triage #369 MERGED; dedupe table rows
- docs(devlog): fold WP4 A-gate fix — 5-tier line classification + EOF comment-residual rule
- fix(cursor): keep isolated turns from mutating parent continuity state
- docs(devlog): WP4 P stale check — bridge clock-reset verified (any event resets stall), anchors refreshed
- docs(devlog): 030 activation wording matches realized converter-level tests
- fix(chat): route stall/eof incompletes to error frames instead of clean [DONE] (WP3/030)
- docs(devlog): WP3 A-gate precision — collectChatCompletion needs no code change (error-frame path structural)
- fix(cursor): omit tool-result roots that cannot fit the byte budget
- docs(devlog): WP3 P stale check — post-#363 anchors (incomplete case :348, collectChatCompletion :479)
- chore: untrack .codexclaw again (local FSM/goalplan state is gitignored; keeps privacy:scan green)
- fix(cursor): address CodeRabbit continuity follow-ups
- fix(cursor): address continuity review findings
- fix(cursor): stable conversation continuity for store:false turns
- fix(cursor): always send requested_model for external models
- docs(devlog): triage complete #355/#356/#366/#368 DEFER + #336 MERGED; wp2 goalplan state
- fix(bridge): terminal exactly-once + cache incomplete responses for replay (WP2/020)
- docs(devlog): fold WP2 A-gate fix — incomplete caching limited to max_output_tokens (content_filter excluded)
- fix(kiro): keep progress text nonterminal
- docs(devlog): fold WP2 A-gate fix — terminal cleanup ordering (abort first, fire-and-forget return), catch guard
- docs(devlog): WP2 P stale check — fresh runTurnAbort/cancel-callback anchors post-#352
- docs(devlog): triage complete — #337/#358 DEFER (gui boundary), wrong-branch PRs noted
- docs(devlog): triage #355/#356 DEFER + #336 MERGE_AND_IMPROVE recorded
- docs(i18n): sync ja/ko/ru sub-agent surface with v2 encrypted-task fail-fast contract (#336 improve)
- fix(codex): sandbox runtime probe CODEX_HOME so --version side effects never dirty the user's home
- fix(codex): sandbox runtime probe CODEX_HOME — codex --version no longer writes tmp/ into the user's real CODEX_HOME (wp-probe-readonly)
- docs(devlog): fold probe plan A-gate fix — mkdtemp failure returns probe-sandbox-unavailable, nested cleanup catch
- docs(devlog): probe-readonly hotfix plan (C2)
- chore: untrack .codexclaw (gitignored local state; fixes privacy:scan home-path flags)
- docs(devlog): triage decisions #360 MERGED, #356 DEFER with review comment
- fix(adapters): terminal truth — fail closed on truncated streams, propagate finish reasons (WP1/010)
- docs(devlog): pr_triage unit — #363/#352 MERGE_AS_IS executed (affc477e, beab5b3e); goalplan roadmap lock
- docs(devlog): fold WP1 A-gate fix — unify terminal-signal definition, drop dead spec, precise test-update list
- docs(devlog): fold A-gate round-2 blockers — sync hard-cap decision, SseRecord union type contract
- docs(devlog): fold A-gate round-1 blockers into sse_hardening roadmap (runTurn abort, decoder comment yield, PR sequencing, UTF-8 flush, heartbeat export correction)
- docs(devlog): 260724_sse_hardening roadmap — 000 plan, research 001-002, decade docs 010-050
- fix(release): skip generate-notes without a channel previous tag
- fix(release): assemble notes before pushing the version tag
- fix(release): fail closed on notes API and drop dead edit path
- fix(release): include merges and direct commits in channel release notes
- fix(chat-completions): emit tool call arguments once
- fix(tests): widen management-server suite timeouts for Windows full-suite load
- fix(codex): key catalog cache by runtime and address CodeRabbit follow-ups
- fix(codex): address remaining CodeRabbit comments on runtime PR
- fix oversized Responses call IDs on replay
- fix(codex): harden Windows Codex exec and isolate catalog resolve deps
- fix(codex): cover mkdir persist, surface persist errors, tighten SemVer compare
- fix(codex): drop plan doc and address new CodeRabbit findings
- fix(codex): address runtime PR review feedback
- fix(codex): harden runtime resolver edge cases and keep sync stdout clean
- docs(v2): explain encrypted agent task routing
- fix(v2): harden routed Fernet task guard
- fix(codex): stabilize Codex runtime selection across sync and clamp
- fix(actions): persist maintainer override so edits cannot re-close
- fix(actions): US spelling aliases and stronger kind override rules
- fix(actions): harden soft-pass and gate feature alias detection
- fix(actions): soft-pass translated issue headings and kind-label
- test(codex): cover bounded pool model retry
- fix(codex): retry allow-listed pool model rejection
- feat(codex): support request-local pool exclusion
- Update issue-triage.yml
- docs(devlog): fold CodeRabbit PR350 review — retry transport boundary, httpStatus union split, CYCLE6_BASE_SHA wording
- fix(actions): address remaining issue-triage review findings
- perf(relay): parse each SSE payload once in persistence-capable inspectors
- fix(actions): harden issue-triage review findings
- docs(devlog): wp2 plan audit amendments — WS-REBIND-01, ELIGIBLE-01, 10-test negative matrix
- fix(actions): harden issue-triage duplicate detection
- fix(catalog): strip Fast service tier from gpt-5.3-codex-spark
- test(responses): cover passthrough replay state regressions
- fix(responses): dedupe replayed developer guidance
- fix(relay): reconstruct completed SSE output items
- docs(devlog): wp1 stale-check amendment — inspector-local accumulator, audit round fixes
- feat(usage): apply OpenAI priority (Fast) service tier price multiplier to cost estimates
- docs(devlog): bugfix-train roadmap unit — 000 master plan + diff-level decade docs 010-061
- docs(devlog): remove trailing whitespace from memory roadmap
- docs: Windows memory troubleshooting page + structure SoT sync (#314 WP5)
- feat(doctor): service memory/runtime section via /api/system/memory (#314 WP4)
- feat(server): RSS memory watchdog + authed /api/system/memory endpoint (#314 WP3)
- feat(stream): eager bounded single-reader SSE relay behind runtime gate (#314 WP2)
- feat(stream): runtime stream-capability gate + persisted streamMode setting (#314 WP1)
- devlog(win-mem-safestream): docs-first roadmap — 000 plan, 001 research, 010-050 diff-level phase docs (#314 mitigation)

## 2.7.36 — 2026-07-23

- fix(release): channel-aware changelog — preview compares preview, latest compares latest
- fix(gui): separate logs and usage error states
- feat(gui): move startup health into dashboard
- fix(gui): add page error boundary
- fix(gui): raise light-theme focus-ring contrast to 3:1 + add tray uninstall confirmation
- docs: update source references for catalog/management-api/responses restructure
- fix(tray): normalize equivalent home paths to consistent Run registry value
- feat(models): add claude-opus-5 to anthropic/cursor/kiro catalogs
- test(gui): add combo workspace creation assertions (idInternalHint + created path)
- docs: sync localized guides for external-provider mode behavior
- test(codex): add restoreNativeCodex external-provider preservation regression
- fix(cli): guard reconcileJournal against external-provider config overwrite
- fix(actions): wire issue-triage job outputs to parse step
- feat(gui): add one-click startup installers
- feat(windows): add branded tray icons
- fix(gui): ignore stale settings polls
- fix: address tray and startup review feedback
- fix(windows): keep tray recovery controls actionable
- fix(windows): distinguish missing tray registry keys
- fix: reject ambiguous local routing state
- fix: keep lifecycle diagnostics backend-consistent
- fix(windows): fail closed on stale lifecycle state
- feat(windows): add restart-safe tray controls
- fix: surface restart-unsafe Codex routing
- fix(gui): render first combo editor inline
- test(codex): cover external provider guidance
- fix(codex): preflight external provider ownership
- fix(codex): clarify external provider handoff
- fix(codex): preserve external model providers
- refactor(server): split responses.ts (2146) into 5 modules + 8-line facade
- refactor(gui): extract hooks + components from Providers.tsx (1426→844)
- fix(catalog): fail open on missing modelId in reasoning-summary lookup
- docs(devlog): wp4 A fold-back — add config prop to OAuthPanel (Pauli GO-WITH-FIXES, Medium blocker: keyProviders block reads config?.providers[name])
- fix(cursor): surface zero-frame stream end as unexpected-EOF transport error
- fix: resolve shim, summary, and main auth issues
- fix(cursor): transport hardening — settled terminal guard, session errors, destroy fallback, discovery retry + cooldown
- docs(devlog): wp4 P stale-check — Providers.tsx unchanged (1426); 040 anchors verified (refs :95-101, callbacks :259/:546); App.tsx sole importer
- fix(cursor): keep explicit body/size overflow variants in the 400 path
- refactor(server): split management-api.ts (1940) into 7 domain route modules + facade
- fix(errors): cursor rate-limit prefix wins over quota detail; require size cue in overflow regex
- fix(cursor): classify quota-style resource_exhausted as 429 rate limiting
- test(responses-state): prove TTL/count-prune byte accounting; strip sizeBytes from snapshots
- fix(cursor): persist conversation continuation across store:false requests
- docs(devlog): wp3 A fold-back — resolve oauth-reauth-bind source-text test (update read path to oauth-account-routes.ts; only test edit, justified)
- docs(devlog): wp3 P stale-check — management-api.ts unchanged (1940), (method,path) uniqueness invariant verified (72 matchers, all unique)
- refactor(catalog): split catalog.ts (2426) into 7 acyclic modules + 11-line facade
- docs(devlog): fold audit r3 residuals; roadmap locked at GO-WITH-FIXES
- docs(devlog): fold audit r1+r2 blockers into cursor context continuity roadmap
- fix(catalog): default supports_reasoning_summaries to false for unknown models (#323)
- fix(shim): scan all args for internal commands, not just $1 (#322)
- docs: add roadmap for untouched issue sweep (WP0)
- fix(auth): expose needsReauth on __main__ account and mark on 401/403 (#327)
- docs(devlog): wp2 A fold-back r3 — move path helpers + backup primitives to parsing.ts so bundled.ts is self-contained (no bundled->sync edge)
- docs(devlog): wp2 A fold-back — resolve metadata<->sync + effort<->sync import cycles (move listCatalogNativeSlugs to metadata; extract bundled.ts)
- docs(devlog): 260723 cursor context continuity roadmap (000 research + 010/020/030 diff-level phases)
- docs(devlog): wp2 P stale-check — catalog.ts 2408->2426 on current base; design holds (symbol-based), line anchors re-derived live in B
- docs(devlog): wp1 B/D record — Split B execution note + Split C deferred
- refactor(tests): split provider-management validation tests into management-provider-validation.test.ts (60 cases preserved, 355 expect() identical)
- docs(devlog): hybrid archive finished plan units on dev
- refactor(tests): split combo management API tests into combo-management-api.test.ts (49 cases preserved, 333 expect() identical)
- docs(devlog): wp1 A residual — fix stale verified-structure summary (mgmt slice :676-1286)
- docs(devlog): wp1 A fold-back — VALID_COMBO must be copied (used by mgmt tests); correct mgmt slice to :676-1286
- test(usage): cover Antigravity Claude Sonnet official pricing
- fix(usage): price Antigravity Claude Opus via official Anthropic rates
- fix(usage): collapse Antigravity model rows to call/picker bases
- docs(devlog): wp1 P stale-check — verify combos.test.ts structure + tsconfig include:[src] (tests not typechecked)
- docs(devlog): fold A-gate blockers (CatalogModel/RawEntry, isShadowSourceModel, safeConfigDTO anchors) into 010/020/050
- docs(devlog): 260723_large_file_restructure roadmap (000 + 010-050 diff-level decade docs)

## 2.7.35 — 2026-07-23

- docs(devlog): archive finished plan units and record codex-rs research
- devlog: push record — dev fast-forwarded a0b9688d..3a87829f, PR #304 auto-closed
- devlog: integration record — maintainer dev a0b9688d joined with local stack (ab72fc10, tree d31cce0d), 3676 tests green
- fix(actions): allow PR labeler to label fork PRs
- devlog: WP6 merge record + final stack summary — #304 landed (bb94ecbe, security CLEAN), stack complete
- devlog: 260723_issue_fixes loop close-out (DONE — #315/#311/#252)
- docs(ko): fix particle after haiku placeholder
- docs(claude-code): sync sonnet->haiku placeholder guidance across locales (issue #252)
- fix(claude): recommend haiku as the inert subagent model placeholder (issue #252)
- docs(responses): document shadow-intercept foreground-match tradeoff; restore codexLogAccountId comment
- devlog: WP5 merge record — #279 landed locally (eebd4977 + 2 audited fixups), 3651 tests green
- fixup(#279 local): abortable SSE decoder so client cancel promptly releases idle upstream (Sol re-verify blocker)
- fixup(#279 local): keep /v1/models on requireApiAuth; drive chat-completions SSE via shared decoder (Sol audit blockers 1+3)
- fix(responses): match shadow call intercept against a source-model set (issue #311)
- devlog: correct #314 Bun 1.4 guidance — canary-only, bump waits for stable
- Document Cursor exec policy and catalog troubleshooting
- style(chat): remove trailing blank line
- fix(quota): classify monthly primary_window via limit_window_seconds (issue #315)
- fix(cursor): gate external continuation replay and rekey usage carry-forward
- devlog: WP4 #309 Sol audit FAIL (codec collision nondeterminism + Vertex allowlist overreach) — NEEDS_HUMAN, not merged
- devlog: 260723_issue_fixes WP0 roadmap — diff-level docs for #315/#311/#252 (Sol-audited, 3 rounds)
- devlog: WP2 merge record — #307 landed locally (2523a6f5), 3631 tests green; WP3 #317 NOOP
- devlog: 260723 issue triage r2 — new-pile sweep (#314 memleak, Sol lanes)
- devlog: 260723 open PR review — 4 merge-ready, 1 security-review, 1 hold, 1 close, 1 draft
- fix(deps): raise fast-uri floor to 3.1.4
- fix(cursor): replay external model tool continuations with fresh conversation ids
- fix(codex): classify monthly WHAM windows
- fix(anthropic): preserve terminal SSE frames
- fix(models): preserve empty providers and discovery controls
- fix(google): eliminate Antigravity request-shape 400s
- Preserve custom model display names
- fix(kiro): complete turns on clean text EOF
- fix(test): isolate suite from user state
- fix(kiro): align Codex capabilities and live commentary
- fix(cli): resolve ephemeral port before Codex injection
- refactor(kiro): centralize duplicate answer check
- fix(kiro): address integration review findings
- fix(kiro): suppress duplicate completion fallback
- test(kiro): complete integration hardening rollout
- fix(chat-completions): resolve typecheck errors for CI
- fix(chat-completions): keep function.name on tool_call deltas for ChatGPT clients
- fix(chat-completions): surface real errors and reconcile done-frame args
- fix(chat-completions): address Copilot App review blockers
- feat: add GitHub Copilot App OpenAI-compatible chat completions surface
- fix(kiro): harden streaming auth and retries
- feat(kiro): require explicit turn completion
- feat(kiro): preserve request history and continuation state
- feat(responses): add provider-aware terminal state

## 2.7.34 — 2026-07-23

- fix(release): pin the audited SHA through dispatch and workflow
- ci: run gui tests in cross-platform CI
- devlog: merge-readiness judgment for bucket2-fixes (content green, 3 conditions to merge)
- devlog: record bucket-2 implementation outcomes (WP2-WP6) + branch metadata
- docs: document multiAgentGuidanceEnabled across en/ja/ko/ru/zh-cn configuration reference (#300)
- feat(multi-agent): add multiAgentGuidanceEnabled kill switch (#300)
- docs: sync guidance roster contract across README + en/ja/ko/ru/zh-cn (#295)
- fix(multi-agent): accurate schema-agnostic v2 guidance roster (#295)
- fix(gui): honest Auto-connect state on non-Darwin hosts (#287)
- fix(catalog): enforce destination policy on model discovery + safe JSON diagnostics (#292)
- docs: document responsesPath across en/ja/ko/ru/zh-cn configuration + adapters references (#289)
- fix(providers): add optional responsesPath for key-auth openai-responses providers (#289)
- devlog: add bucket-2 fix roadmap (010/020/030/040/041) + bucket-1 action record
- ci: rebuild issue triage, PR labeler, and release note categories
- ci: rebuild issue triage, PR labeler, and release notes
- devlog: add 260723 issue triage unit — 11 overnight issues, 3 buckets, 6 Sol investigation lanes
- devlog: mark PR #255 rebuild as DEFERRED — needs atomic batch endpoint
- fix(v2): fail fast on unreadable routed agent tasks
- devlog: finalize overnight PR review — 3 merged, 6 rebuild, 1 keep-open
- feat(kiro): harden completion and transport integration
- feat(cursor): add Router optimization levels
- devlog: update CI workflow PR analysis — Sol FAIL x3, REBUILD_ON_DEV
- devlog: update PR #283 analysis — Sol FAIL, REBUILD_ON_DEV
- devlog: update PR #293 analysis — Sol FAIL, REBUILD_ON_DEV
- devlog: update PR #255 analysis — Sol FAIL verdict, REBUILD_ON_DEV
- fix(server): return 400 instead of 500 for non-streaming adapter request
- devlog: add 260723 overnight PR review unit (docs-only Phase 0)
- chore(governance): add CodeRabbit config, AGENTS.md, and branch policy docs
- fix: show codex auth submission state
- fix: verify GUI update restarts stay healthy
- Fix Cursor native exec marker authorization
- feat: add Tencent Coding Plan and SiliconFlow
- fix(gui): clarify missing Cursor cache telemetry
- fix(workflows): remove duplicate labelBasedKind declaration in enforce-issue-quality
- fix(cursor): harden context usage carry
- fix(cursor): carry context usage across tool finalizes
- fix: add opt-in responses item id repair
- test(sidecar): use explicit ChatGPT auth intent
- fix(sidecar): verify direct helper auth origin
- fix(anthropic): preserve adaptive thinking output headroom (#256)
- fix: gate native effort clamp by route identity
- fix(catalog): include native OpenAI slugs in combo member resolution (issue #268)
- fix: add output defaults and hide web-search replay markers (#269)
- feat: add combo rename and public aliases (#238)

## 2.7.33 — 2026-07-22

- fix(init): publish preserved rollback snapshot with no-replace copy
- fix(init): preserve valid pre-migration rollback backup instead of unconditional delete
- docs: document maintainers and review ownership (#264)
- fix: stabilize merged PR integrations
- ci: improve issue intake, enforce minimum quality, and ping PR authors on wrong-branch retarget (#229)
- fix(config): replace stale pre-migration backup instead of crashing (#258)
- feat: add Japanese (ja) localization across GUI, docs-site, and README (#244)
- fix(gui): remove non-actionable API-key rows from Accounts tab (#231)
- fix(combo): strip content-encoding on re-serialized child requests (#230)
- fix: resolve unanswered auth and provider issues
- fix(cli): clarify ocx init prompts to indicate default provider selection
- fix(router): improve error message when no OpenAI provider is configured
- devlog: remove archived antigravity effort routing originals (moved to _fin)
- feat(gui): add per-model cost breakdown to provider Usage tab
- cli: document v2 mode/threads subcommands in help
- fix(antigravity): dedupe required tool fields
- fix(adapter): ensure root object type for Kimi tool schemas
- fix(server): sanitize reasoning content in v1 compact endpoint
- cli: harden help — models subcommands + v2 entry
- cli: add models add/remove/list-custom subcommands
- gui: enlarge model hover tooltip
- i18n: add custom model chip keys for zh/de/ru
- gui: fix tooltip flip-up boundary to match max-height
- gui: add custom model chip UI — header button, modal, hover popup, row badges
- feat(openrouter): add configurable provider routing
- models: fix custom model dedup + decodeURIComponent guard
- models: merge custom models into catalog
- models: add custom model management API
- models: add custom model config type
- devlog: add sonnet 4.6 thinking verification to research doc
- antigravity: add claude-sonnet-4-6 effort control via thinkingConfig (Anthropic adaptive thinking verified)
- devlog: archive antigravity effort routing to _fin (WP0-WP3 DONE)
- antigravity: effort routing fixtures + oauth reconcile test for collapsed model list
- antigravity: CCA buildRequest effort routing via resolveAntigravityEffortWireModel + thinkingConfig
- antigravity: collapse effort-variant models into base IDs with effort routing infrastructure
- devlog: antigravity effort routing docs-first WP0 (000_plan + 001_research + 010_models + 020_adapter)
- fix(oauth): resolve Kiro login flow before blocking on manual paste
- fix(usage): add qwen3.8-max-preview temporary Routeway pricing for both alibaba token plans
- fix(codex): clamp catalog reasoning efforts to installed binary's ladder
- feat(google): add gemini-3.5-flash-lite to catalog
- fix(update): fall back to direct proxy start when service reinstall fails (#227)
- fix(i18n): complete RU parity with dev en.ts + refresh RU docs (#211)
- fix(adapters): forward prompt_cache_key through openai-chat adapter (#217) (#224)
- fix(responses): strip mismatched agent_message item ids before passthrough (#215)

## 2.7.31 — 2026-07-22

- docs(devlog): record #202/#209 fixes + push + green CI (pre-merge report)
- test(storage): give fixture-home scanner tests an explicit 15s timeout (Windows CI flake)
- fix(gui): i18n combo effort-none option + avoid ref access during render in codex-auth modal (lint)
- fix(oauth): durable generation-bound refresh intent prevents Anthropic stale-lock token replay (#209)
- fix(google): surface Vertex defaultModel in catalog when models list is absent (#202)
- docs(devlog): merge-readiness review of 6 issue patches (2 blockers: #202, #209)
- fix(codex): reclassify mid-stream reset as transient + escalating account cooldown + affinity diagnostics (#186)
- feat(codex-auth): add manual redirect-URL/code paste for headless account add (#183)
- fix(oauth): generation-safe Anthropic refresh + structured token errors + local-cli ownership (#209)
- fix(combos,cursor,google): nullable combo effort + capability-aware injection, cursor effort metadata invariant, vertex discovery diagnostics (#202, #179)
- fix(gui): expose allowPrivateNetwork opt-in for built-in cloud presets (#212)
- fix(service): locale-safe sc.exe 1060 detection + tri-state lifecycle guards (#216, #199)
- docs(devlog): 260722_issue_bug_sweep WP3 — diff-level patch plans 010/011/020/021/022/030/031 + 008 cursor-effort research
- docs(devlog): record Gemini 3.6 dev merge
- docs(devlog): close Gemini 3.6 rollout
- feat(google): add Gemini 3.6 Flash tiers
- docs(devlog): align Gemini price manifest
- docs(devlog): fold Gemini 3.6 audit fixes
- docs(devlog): authorize Gemini 3.6 implementation
- docs(devlog): 260722_issue_bug_sweep WP2 — RCA docs 002-007 (W/N/O/R/S/V clusters)
- docs(devlog): 260722_issue_bug_sweep WP1 — issue inventory + roadmap MOC (000/001)
- docs(devlog): plan Gemini 3.6 rollout
- feat(gui): merge Debug into Logs page as tab (#logs/debug), drop debug sidebar item
- fix(gui): match combo section chevron sizing to provider groups + wp1 evidence
- feat(gui): move combos into Models page section, drop combos sidebar item
- docs(devlog): 260721_sidebar_diet roadmap (combo->models section, logs&debug merge)
- fix(providers): complete intl token-plan context metadata
- fix(i18n): add 13 missing Russian GUI keys
- chore(devlog): archive 260720_wrapup_prs → _fin
- chore(devlog): archive 260720_toks_speed_price_columns → _fin
- chore(devlog): archive 260720_frontier_docs_site → _fin
- chore(devlog): archive 260719_pr152_159_dev_absorb → _fin
- chore(devlog): archive 260718_provider_workspace + workspace_design_parity → _fin
- feat(providers): harden alibaba token plan entries + add qwen3.8-max-preview to intl
- feat: add russian (ru) localization for gui, docs-site, and readme (#207)
- ci: enforce PR target branch (must target dev) (#204)
- fix(codex): rework soft-avoid pool affinity with semantic terminal status (#205)

## 2.7.30 — 2026-07-21

- fix: alibaba-token-plan-intl reviewer fixes + tests
- feat: add alibaba-token-plan-intl provider for international token plan
- fix(test): clean WAL/SHM residue in storage-scanner fixture + remove Windows-illegal ? from URI test path
- fix(privacy): allow test-fixture sk- sentinels in privacy scan
- Revert "fix: preserve configured Alibaba Token Plan base URL (#189)"
- fix(router): route self-namespaced native ids whole; correct OrcaRouter params from live tests
- fix(providers): address OrcaRouter reasoning/temperature review feedback
- feat(providers): add OrcaRouter (OpenAI-compatible adaptive router)
- fix(gui): restore Providers workspace parity (#169)
- fix(storage): use immutable readonly opens for DB row counts (#187)
- docs: record unanswered issue triage
- test(cli): keep account fixtures privacy-safe (#180)
- fix(gui): surface provider errors and clarify estimates (#181 #198)
- fix(cursor): bound serialized tool catalogs (#190)

## 2.7.29 — 2026-07-21

- fix(privacy): allow test-fixture sk- sentinels in privacy scan
- feat(providers): add Cloudflare Workers AI provider (#191)
- fix: restore GUI request logs after ocx stop/start (#195)
- fix(update): hard-pin listen port after update, preserve port=0 ephemeral (#193)
- fix(alibaba): preserve reasoning_content for qwen3.8-max-preview (#197)
- fix: preserve configured Alibaba Token Plan base URL (cherry-pick #189)
- Revert "fix: preserve configured Alibaba Token Plan base URL (#189)"
- fix: preserve configured Alibaba Token Plan base URL (#189)
- docs(cli): match the shipped help surface exactly (Usage: prefix) (#180)
- fix(cli): redact add-key label before JSON serialization + harden --yes guard test (#180)
- fix(cli): redact add-key label before JSON serialization (#180)
- docs(cli): document ocx account family across locales and READMEs (#180)
- fix(cli): route account refresh through provider-quotas endpoint (#180)
- feat(cli): add ocx account refresh/auto-switch/remove/add-key (#180)
- fix(cli): harden ocx account error propagation and split api layer (#180)
- feat(cli): add ocx account list|current|use for GUI credential parity (#180)

## 2.7.28 — 2026-07-20

- fix(test): update oauth-tos-warning assertions for native dialog conversion
- fix(gui): scope OAuth login generation per provider + abort orphan Codex flows
- feat(providers): Re-authenticate for OAuth and Codex accounts (#171)
- fix(gui): focus trap, Anthropic-specific ToS wording, provider-aware saferPath
- feat(gui): warn before high-risk subscription OAuth login (#176)
- feat(gui): warn before high-risk subscription OAuth login (#176)
- feat(gui): read-only Storage diagnostics page (Phase 1 of #42) (#173)
- fix(gui): defer setState in qwen-cloud effect to satisfy lint
- fix(providers): rename qwen-portal to Qwen Cloud + fix baseUrl (#185)
- fix(antigravity): stop forwarding Responses item ids as thoughtSignature (#182)
- fix(proxy): raise default upstream stall timeout to 300s (#170)
- fix(ci): unbreak React Doctor on fork PRs + local eslint gate (#172)
- fix: expose allowPrivateNetwork opt-in across GUI, API PATCH, and CLI (#175)
- docs(devlog): WP6 usage cost row render evidence
- fix(usage): split unmetered from unpriced, memoize price resolution (WP6 audit fold)
- feat(usage): cumulative estimated cost row on Usage page (WP6)
- feat(usage): expand price overlay to 35 keys + model-level official-price fallback (WP5)
- feat(logs): TTFT instrumentation — one-shot firstOutputMs across bridge/native SSE/sidecar, persisted + additive /api/logs
- docs(devlog): WP4 audit fold — sidecar bridge, combo separation fixture, direct-input validation
- feat(docs-site): split Benchmarks into its own sidebar category with per-domain pages
- feat(logs): production-grade detail dialog — all-row details, sectioned layout, cost breakdown, combo attempts table
- docs(devlog): WP3 audit fold — stale-check v2 supersedes body spec
- feat(docs-site): Benchmarks page — port PR #144 Frontier boards to the docs site
- fix(logs): round estimated cost to 4 decimal places
- feat(logs): tok/s + estimated cost columns — /api/logs display metrics, 10-col table, 4-locale i18n
- docs(devlog): WP2 audit fold — landed-API adapter, normalizer-first reason classification
- feat(usage): cost estimation core — jawcode cost metadata, expected-price overlay, cache-safe normalization, combo summing, tok/s helper
- docs(devlog): WP1 audit fold — cost core PRD v3 (legacy cache disambiguation, verified-derived, 11 overlay keys)
- docs(devlog): 260720 toks/price observability roadmap — research 000-004 + decade docs 010-040
- docs(devlog): v2.7.27 release record

## 2.7.27 — 2026-07-20

- docs(devlog): wrap-up plan for devlog-lane finish + PR/issue triage + main/preview prep
- fix(service): abort native uninstall when the SCM registration is unverifiable
- test(service): make winsw missing-exe probe test platform-aware
- fix(service): scan all sc.exe streams for 1060 + sc-delete stale registration without exe
- chore(devlog): archive 260720 windows-service + claude-authmode plans to _fin
- feat(gui): float enabled models to the top of each provider group
- fix(update): side-effect-free update --help (#168) + pipe GUI-worker child stdio (port #167)
- fix(service): fail-closed WinSW status probe — unknown ≠ nonexistent
- fix(service): tighten fail-open lifecycle + fix regression gate assertions (sol pre-push audit)
- feat(service): backend-preserving update paths + README SoT correction (#165, #166)
- fix(service): stopwait race, transactional backend switch enforcement, conflicting flags rejection (sol audit round 3)
- feat(service): opt-in native Windows service backend via WinSW (--native) (#166)
- fix(service): launch Windows service wrapper hidden via wscript VBS launcher (#165)
- docs(devlog): fix winsw /p argv order + WP3 state relocation phrase (audit round 2)
- docs(devlog): windows service implementation roadmap (040-070) after sol audit round 1
- feat(claude): defend proxy routing from leftover settings.json env hijack
- fix(claude): persist dashboard authMode and reconcile system env on subscription switch-back
- docs(devlog): windows service console-window investigation + issues #165/#166
- chore: remove Dependabot config

## 2.7.26 — 2026-07-19

- fix(tests): widen kiro sqlite suite timeout for Windows CI cold runners
- test(release): teach the gh shim to answer service-lifecycle run lists
- fix(release): wait for Service lifecycle before dispatching the Release workflow
- fix(windows): honest timeout diagnostics, bounded retry, and configurable ACL budget
- docs(devlog): record integration closeout — all gates green on dabf9de4
- docs(devlog): record WP7 render-grounding close-out
- fix(gui): keep the keyboard focus ring when dialogs close via Escape
- fix(gui): clean native dialog overlay and sticky info focus ring
- docs(providers): correct preset counts and Copilot OAuth guidance across locales
- fix(oauth): harden GitHub Copilot device flow — key compat, grant renewal, redaction, identity
- test: satisfy privacy-scan for GitHub Copilot OAuth fixtures
- feat(oauth): add GitHub Copilot device-flow login for Copilot Pro
- feat(providers): add Alibaba Token Plan Qwen 3.8
- fix(quota): active-key-only Kimi probe, null-aware envelope unwrap, key-mode gate
- fix(quota): accurate Cursor totals and restore missing Kimi usage
- fix(logs): narrow client-close matcher to locally produced abort phrases
- fix(logs): preserve explicit client_cancelled error type for combo/compact
- fix(logs): classify web-search client aborts as 499, not upstream 502
- fix(oauth): migrate legacy identity-less Kimi rows and prefer user_id across tokens
- fix(oauth): extract Kimi JWT user_id so multiauth keeps two accounts
- fix(windows): timeout-only ACL soft-fail with honest error codes and shared deadline
- fix(update): verify pid identity before kill targets and wait on captured pre-update port
- test: shrink usage-debug long-run loop so pre-push does not time out under load
- test: update Windows restart source contract for pinned --port startArgs
- fix: keep configured port after update restart and stop Windows console flashes
- docs(devlog): roadmap for community PR #152-#159 absorb onto dev
- feat(providers): prewire qwen3.8 max preview

## 2.7.25 — 2026-07-18

- docs(devlog): retire completed plans to _fin, drop renamed account-mode test, update zh-CN README
- feat(routing): alias slash-containing model ids for Codex one-slash tagging
- docs(structure): record dangling tool_calls repair in transports SoT
- fix(openai-chat): repair dangling tool_calls for strict chat providers
- fix(ci): widen web-search heartbeat test timing margin for windows runners

## 2.7.24 — 2026-07-18

- fix(gui): align Combos workspace with landed combo contracts
- feat(gui): wire Combos workspace into the dashboard
- feat(gui): reconstruct Combos workspace surface
- docs: prefer user-owned Node and widen Bun troubleshooting discoverability
- fix(gui): initialize note draft on edit click instead of set-state-in-effect
- fix(ci): make windows test paths and platform assertions cross-platform
- test(combos): prove catalog and usage closeout end to end
- feat(combos): persist ordered provider attempt attribution
- fix(combos): derive catalog capabilities from every member
- test(combos): fault-inject failover auth adapter and safety paths
- fix(combos): isolate every provider attempt through the full response pipeline
- feat(combos): reconstruct target cooldown plumbing
- test(combos): lock config API routing and 020 activation boundaries
- fix(combos): make selection deterministic and runtime eligibility fail closed
- feat(combos): land validated CRUD and routing on current dev
- feat(combos): reconstruct virtual model namespace primitives
- fix: preserve 401 precedence in PR #145 error labels
- fix: absorb PR #145 403 permission labels
- docs(sub-agents): state v2 native-to-routed NEW_TASK encryption limitation
- docs(install): correct bun postinstall recovery command across install surfaces
- docs: close provider workspace verification
- fix: harden provider workspace integration
- docs: define provider workspace interaction grammar
- fix: make provider workspace rail responsive
- docs: record account workspace verification
- feat: add provider workspace account switching
- docs: plan provider workspace accounts and rail
- feat: show Kimi subscription quotas
- fix(gui): align workspace icons with source SVGs
- fix(gui): hide duplicated rail status text
- style(gui): polish detail view — tabs, sections, key-value layout
- style(gui): tighten workspace dashboard spacing + rail density
- fix(gui): improve wide-screen layout + update OpenCode icon
- feat(gui): add 2-column overview layout + notes (Phase 030)
- feat(gui): add detail header actions (Phase 020)
- feat(gui): add aggregate overview dashboard (Phase 010)
- fix(ci): install GUI deps before root tests
- fix(catalog): preserve callable Kimi and Grok models
- feat(providers): unlock Kimi K3 reasoning tiers
- fix(gui): Subagents page Set optimization, flex layout, and button types (pr140 rebuild WP154)
- fix(gui): ApiKeys page button types and input accessibility (pr140 rebuild WP153)
- fix(gui): Logs page native dialog, helper extraction, and accessibility (pr140 rebuild WP152)
- fix(gui): Debug page helper extraction and button types (pr140 rebuild WP151)
- fix(gui): ClaudeCode page helper extraction and button types (pr140 rebuild WP150)
- fix(gui): Usage page component extraction and accessibility (pr140 rebuild WP141)
- fix(gui): Dashboard native dialogs, accessibility, and helper extraction (pr140 rebuild WP140)
- fix(gui): Models page accessibility and helper extraction (pr140 rebuild WP130)
- fix(gui): modal focus-trap and dialog semantics (pr140 rebuild WP120)
- chore(gui): responsive consolidation and orphan locale cleanup (pr139 rebuild WP100)
- feat(gui): provider workspace settings, auth, and JSON editor panels (pr139 rebuild WP091)
- feat(gui): provider workspace detail panels — overview, models, usage (pr139 rebuild WP090)
- feat(gui): providers workspace shell with hash-addressable view (pr139 rebuild WP080b)
- feat(gui): provider workspace rail slice with kind classification (pr139 rebuild WP080a)
- feat(gui): quota rows from the normalized multi-window contract (pr139 rebuild WP070)
- refactor(gui): extract CodexAccountPool from the Codex Auth page (pr139 rebuild WP060)
- feat(gui): tabbed add-provider catalog with accounts/free/paid browse (pr139 rebuild WP050b)
- test+docs: single-provider option E2E, isolated smoke tooling, SoT sync to codexAccountMode contract (single-provider-option cycle 3)
- feat(gui): add-provider catalog data owner with three-way preset tiers (pr139 rebuild WP050a)
- fix(api): accept Google models-array shape in connectivity probe, pin public-oauth cancel guard (pr139 rebuild WP040 audit follow-up)
- feat(api): provider field-mask PATCH, honest connectivity probe, guarded local auth (pr139 rebuild WP040)
- feat: codexAccountMode surfaces — Providers Pool/Direct control, CodexAuth banner rework, mode PATCH, runtime child rename (single-provider-option cycle 2)
- test(cursor): pin close-before-backoff scheduling and terminal-error precedence (pr140 rebuild WP180 audit follow-up)
- fix(cursor): close each failed retry attempt before backoff and contain close errors (pr140 rebuild WP180)
- test: re-pin CodexAuth next-session badge assertion to pool/direct conditional (pr140 rebuild WP170 follow-up)
- feat(anthropic): bounded parallel image normalization first pass (pr140 rebuild WP170)
- feat(update): immutable update target with pre-flight integrity metadata check (pr140 rebuild WP160)
- feat: single openai provider with codexAccountMode pool/direct option, v2 migration absorbing openai-multi (single-provider-option cycle 1)
- feat(ci): pinned advisory React Doctor tooling (pr140 rebuild WP110)
- feat(gui): provider workspace data helpers with three-tier classification (pr139 rebuild WP030)
- feat(quota): normalized multi-window quota contract with cursor probe and race-safe caching (pr139 rebuild WP020)
- fix: close final OpenAI hardening audit blockers
- docs: three-tier OpenAI SoT sync across docs-site locales, structure invariants, chase inventory (openai-hardening cycle C follow-up)
- feat(providers): free-tier pricing contract distinct from key-optional (pr139 rebuild WP010)
- docs: close out three-tier OpenAI hardening unit, archive to _fin (openai-hardening cycle C)
- test: three-tier OpenAI E2E matrix, migration restore proof, isolated runtime smoke (openai-hardening cycle B)
- fix(kiro): seed GPT-5.6 Sol/Terra/Luna from official Kiro catalog (#141)
- Revert "fix(kiro): seed GPT-5.6 Sol/Terra/Luna from official Kiro catalog (#141)"
- fix(kiro): seed GPT-5.6 Sol/Terra/Luna from official Kiro catalog (#141)
- fix: API-only max-input min-wins routing, self-reference validator activation proof (openai-hardening cycle A)
- feat: complete OpenAI management GUI hardening
- fix: complete OpenAI API hardening audit
- docs: three-tier OpenAI provider table in README, final integration verification (wp-050)
- feat: management GUI three-tier presentation — icons, preset provider seed, mode DTO (wp-040)
- feat: OpenAI API official GPT-5.6 metadata and Pro virtual aliases (wp-030)
- test: close OpenAI tier hardening audit
- feat: atomic three-tier OpenAI activation — route-aware auth, central sidecar, startup migration, legacy chatgpt retirement (wp-020)
- feat: add OpenAI tier foundation
- docs: lock OpenAI hardening roadmap
- docs: close provider chase roadmap cycle
- docs: plan non-openai provider chase
- docs(chase): audit jawcode model imports
- docs(chase): add model provider reference lane

## 2.7.23 — 2026-07-17

- fix(providers): split Kimi K3 context tiers
- feat(providers): add Kimi K3 models

## 2.7.22 — 2026-07-16

- fix: remap primary_window to weekly instead of dropping it
- fix(gui): remove window.open popup in account-add modal, fix oversized icon
- refactor: remove 5-hour quota window from GPT plans
- docs: SoT sync for grok-build hardening + promote devlog unit to _fin (260716_grok_build_hardening)
- feat(providers): official xAI header parity — per-attempt x-grok-req-id, stable session/conv affinity, compatibility profile, executor-preserving header timeout (devlog 260716_grok_build_hardening/050)
- feat(server): reactive 401 refresh-and-replay for OAuth-backed xAI requests — generation-checked singleflight refresh, fresh transport re-resolution, single replay (devlog 260716_grok_build_hardening/040)
- feat(oauth): two-lock xAI refresh transaction — per-account intent lock across IdP exchange, global store-write lock + async mutation funnel, generation-guarded persist, bounded token retry (devlog 260716_grok_build_hardening/030)
- fix(oauth): single-owner semantics for Grok CLI imported credentials — re-read ~/.grok/auth.json before refresh, later-expiresAt adoption with zero IdP calls, detach to oauth on refresh (devlog 260716_grok_build_hardening/020)
- fix(responses): fold reasoning into the following assistant turn — one Grok wire message with reasoning_content, signed ocxr1 siblings preserved separately, boundary clears (devlog 260716_grok_build_hardening/010)
- docs(devlog): grok-build hardening roadmap unit — 000 plan + 010-050 diff-level decade docs, 6-round audit synthesis (260716_grok_build_hardening)
- docs(devlog): close passthrough follow-ups unit with implementation evidence, promote to _fin
- feat(claude): bound native passthrough body occupancy — idle-only stall guard + byte cap (devlog 260716_passthrough_followups/010)
- ci: sync service-lifecycle trigger paths with release gate (add src/cli.ts) + PR/push path-set equality contract test (devlog 260716_passthrough_followups/020)
- feat: persist failure diagnostics to usage.jsonl (030)
- fix(claude): unify native passthrough header-deadline fallback at 200s (devlog 260716_passthrough_followups/030)
- feat: map transient upstream 5xx to Anthropic 529 overloaded_error on the Claude path (020)
- feat(claude): reclassify transient upstream 5xx as Anthropic 529 overloaded (parallel-session WIP, verified: tsc + 35 targeted tests green)
- docs(devlog): archive 260716_release_2721 to _fin (unit closed with evidence)
- feat: pre-stream transient 5xx retry on ChatGPT passthrough (010)
- docs(devlog): passthrough follow-ups unit — body-occupancy design, workflow path sync, timeout fallback unification (sol research + audit folded)
- docs(devlog): receipt for deep ~/Developer/codex grok-build analysis upgrade
- docs(devlog): live smoke Grok Build → OpenCodex models
- docs(devlog): Grok Build can consume OpenCodex models via Responses
- docs(devlog): close release train v2.7.21 with evidence

## 2.7.21 — 2026-07-16

- docs(devlog): WP2-P amendments — cleanup-oracle seam + delegation split
- fix(claude): guarantee header-deadline cleanup on every passthrough fetch path
- docs(devlog): release train v2.7.21 roadmap (000-040, audit folded)
- docs(devlog): close usage surface filter
- feat(gui): add responsive usage surface filter
- feat(usage): filter aggregates by client surface
- test: make v2 mode CLI fixture accept Windows codex.cmd enable args
- test: update TicketBadge i18n expectation and soft-skip Windows symlink EPERM
- gui: drop accidental lint:i18n dump artifacts
- gui: finish AddProviderModal i18n and silence virtualizer lint noise
- docs(devlog): plan usage surface filter
- fix(claude): guard routed agents from blocked skills
- fix(claude): clear passthrough deadline after headers
- Create sync-locale-keys.mjs
- Improvements
- gui: skip url/css/fetch/t() fragments in i18n lint
- gui: dynamic i18n locale hint and hardcoded snippets in lint
- feat(gui): enforce no hardcoded UI strings via ESLint i18n rules

## 2.7.20 — 2026-07-15

- test(cursor): make executor fixtures cross-platform
- docs(gui): correct design-system primitive map
- gui: unify design system and typography
- fix(codex): relPath home containment — component boundary + platform case semantics
- fix(windows): launch .cmd shims and platform shells correctly — win-exec launcher + 4 call sites
- fix(claude): elide blocked-skill bundles on Windows paths — normalize backslashes before basename split
- docs+seo: surface Claude Code across README/site/npm metadata — subtitle in 3 READMEs, site description/tagline/JSON-LD (keywords+featureList), npm description+keywords

## 2.7.19 — 2026-07-15

- oauth(pr132-stack): kind-aware state enforcement + sync submit validation, 4KiB input cap, modal i18n + aria-label + explicit ok flag, address-bar hint copy, deterministic PKCE-continuity tests + route tests
- provider(pr129-stack): persisted random client id replaces machine fingerprint, 401-only retry with body drain, bootstrap timeout/abort/single-flight, contract-risk provider note, activation-level tests
- provider(pr128-stack): restore header precedence, drop unused icon hints + premature mimo alias, bound non-JSON error-log inspection to 8KiB prefix, Zen free-tier data-use warning, dedupe symlink-test guard
- tooling(pr130-stack): hooks-dir via git rev-parse, backup-then-install policy, prepush single source + privacy:scan, visible EPERM skip, BOM/claim cleanup
- fix(opencode-free): dynamic model discovery, tool-schema normalization, and provider note exposure
- fix(opencode-free): match public transport and replay reasoning
- fix(opencode-free): avoid persisting registry-only auth headers
- fix(opencode-free): restrict live discovery to -free models
- test(opencode-free): lock user apiKey precedence over static auth header
- fix(gui): label saved free providers and preserve user auth headers
- fix(gui): label saved free providers and preserve user auth headers
- fix(gui): add OAuth manual redirect URL / code paste fallback
- fix(gui): simplify free provider add flow and add provider icons
- fix(gui): simplify free provider add flow and add provider icons
- test: skip symlink test on Windows without elevated symlink rights (EPERM)
- test: skip symlink test on Windows without elevated symlink rights (EPERM)
- test(mimo-free): verify deriveProviderPresets exposes keyOptional for GUI picker
- feat(gui): expose keyOptional through presets API + Free badge + optional key field in AddProviderModal
- feat(gui): expose keyOptional through presets API + Free badge + optional key field in AddProviderModal
- test: skip symlink test on Windows without elevated symlink rights (EPERM)
- tooling: add pre-push hook matching the CI gate
- fix(mimo-free): use abortSignal not signal on AdapterFetchContext
- feat(provider): add MiMo Free -- keyless Xiaomi MiMo public tier
- feat(provider): add OpenCode Free -- keyless public-tier provider

## 2.7.18 — 2026-07-15

- feat: anthropic image guard/normalize, kiro image retry, claude authMode proxy, GUI model info improvements
- fix(nvidia): harden NIM provider for kimi family + surface openai-chat upstream error detail (#126)
- feat(gui): off-canvas drawer nav on narrow screens
- cursor(native-exec): default to codex-sandbox (approve most), align docs
- harden(cursor): fail-closed native-local-exec default (revert permissive codex-sandbox default)
- fix(cursor): approve web/exa search interaction gates so web search works
- fix(cursor): stop leaking assistant tool calls as [Tool Call] text into model prompt

## 2.7.17 — 2026-07-14

- test(passthrough): add store:false id stripping and web_search_call prefix coverage
- fix(openai): strip item ids when store is false
- fix(bridge): mint ws_ ids for web_search_call items
- fix(bridge): use correct tool call id prefixes
- fix(openai): strip non-msg item ids from passthrough message input
- test(streaming): bound burst replay delivery groups
- chore(ci): bump setup-node to v6.4.0, deploy-pages to v5.0.0, withastro/action to v6.1.2
- chore(deps): ignore major dependabot bumps for typescript and gui @types/node
- fix(xai): preserve union tool grammar
- fix(xai): normalize nested tool schemas
- fix(streaming): flush bursty responses incrementally

## 2.7.16 — 2026-07-14

- harden(cursor): default nativeLocalExec to codex-sandbox

## 2.7.15 — 2026-07-14

- harden(cursor): improve native exec rejection messages with exec_command fallback guidance

## 2.7.14 — 2026-07-14

- harden(upstream): propagate stream flag to web-search loop fetch path
- fix(upstream): pass stream flag to fetchWithAttemptDeadline for identity encoding

## 2.7.13 — 2026-07-13

- chore: add .claude/ to .gitignore
- harden(cursor): unify effort suffixes, sanitize wire IDs, add consistency invariant
- fix(cursor): strip cursor- wire prefix from GetUsableModels IDs (#117)

## 2.7.12 — 2026-07-13

- chore: bump version to 2.7.12
- fix(cursor): harden native-exec unknown case to keep stream alive
- fix(cursor): handle unknown interaction query cases gracefully (#116)

## 2.7.11 — 2026-07-13

- fix(upstream): preserve live SSE delivery
- fix(upstream): suppress Accept-Encoding to prevent SSE buffering via Brotli/gzip

## 2.7.10 — 2026-07-13

- fix: harden xai cache-aware key failover

## 2.7.9 — 2026-07-13

- fix(xai): case-insensitive user override for Grok CLI default headers
- fix(xai): prompt-cache affinity — x-grok-conv-id from prompt_cache_key + grok reasoning_content replay
- docs: cross-vendor sidecar matrix guide + config reference (en/ko/zh-cn)
- feat(config): two-setting sidecar GUI + Claude override + management API
- feat(sidecar): claude-inbound auth reachability + anthropic vision backend
- feat(web-search): anthropic-backed sidecar + backend-pluggable SidecarPlan
- feat(claude): translate web_search_call frames to server_tool_use + web_search_tool_result
- fix: route xAI OAuth through subscription transport
- fix(claude): production hardening — 2 BLOCKERs + 8 MAJORs from sol gap audit
- docs(claude-code): comprehensive 3-locale guide rewrite + types.ts comment fix
- feat(docs-site): hero product-word drum — Codex/Claude rotateX cylinder
- fix(gui): stable seq-keyed virtualization + useCallback load (merge review)
- fix(merge): resolve semantic conflicts with dev security/lint hardening
- fix(claude): isolate agent registry tests and resync definitions
- docs(devlog): 260712 PR batch landing unit (#96-#103) — plan, audits, DONE record
- test(ci): assert GUI lint/build gates stay wired
- ci: fix privacy-scan token-looking fixture + platform-correct claudeConfigDir assertion
- fix(gui): abort stale usage requests on range change and unmount
- ux(claude): GUI hardening round — audit 080 folded
- fix(ssrf): resolve hostnames at provider write time + reserved IPv4 ranges
- fix(decompress): enforce body cap during inflation via zlib maxOutputLength
- ux(claude): modelMap relabeled as interception with empty-by-default framing (Desktop gets its own tab later)
- ux(claude): collapse model sections — drop default-model and tier-model pickers, keep background helper + modelMap
- ux(claude): drop legacy context-override and always-effort rows; reword auto-context copy
- fix(claude): dispatcher directive hands a placeholder model instead of demanding omission — ocx-route makes the argument inert
- fix(claude): injected agent bodies state their ACTUAL routed model — stop subagent identity confusion
- feat(claude): ocx-route directive — proxy re-routes injected-agent turns past the CLI's frontmatter fallback
- fix(claude): ocx-self pins the picker-saved default model — frontmatter 'inherit' disproven live
- fix: restore service.ts imports clobbered by an accidental editor paste (swept into e779ca12 by git add -A)
- fix(claude): ocx-* agent descriptions instruct dispatch WITHOUT the model argument
- feat(claude): roster agent injection — dispatch any routed model as a subagent_type
- fix(claude): elide the REAL skill-bundle carrier — sibling text block, not the tool_result
- feat(claude): proxy-side bundled-skill elision for routed models (blockedSkills)
- feat(claude): per-surface discovery ids — readable claude-ocx for CLI, hashed family isolated to Desktop
- chore(claude): remove temp diagnostic dump (170k prefix root-caused: real client payload)
- docs(devlog): record 040 crash-guard cycle
- fix(crash-guard): classify locked-ReadableStream sink-close teardown as benign
- fix(claude): pre-write CLI gateway-models cache — picker never refreshes without a token
- feat(claude): auto-context — conditional [1m] marking + AUTO_COMPACT_WINDOW 350k default
- fix(gui): wire injection log view and polish debug log page
- fix: retry transient Windows atomic renames
- test: isolate aggregate test files
- test: stabilize Windows integration fixtures
- refactor: satisfy GUI lint rules
- refactor: share upstream retry and error handling
- chore: strengthen CI and release safeguards
- fix: harden request and provider security
- feat(claude): native CLI context accounting + subagent tier slots + smarter caching
- feat(claude): Desktop context/effort levers — static supports1m config + opt-in env pair
- feat(claude): Desktop effort capabilities + usage/cache transparency
- fix(claude): build Desktop 3P registry at startup + filter disabled models
- feat(claude): Desktop 3P auto-config with SHA-256 encoded model aliases
- ux(claude): redesign controls with toggle switches + setting-row layout
- feat(claude): add Fast Mode toggle for OpenAI models in Claude GUI
- fix(claude): remove _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL — it disables gateway discovery
- ux(claude): add red warning for auto-connect, remove confirm popup + stale i18n keys
- ux(claude): rewrite all GUI text in plain language across 4 locales
- fix(claude): systemEnv defaults to OFF + enable warning popup
- feat(claude): harden system-env with shell hook auto-install + ensure path + uninstall cleanup
- fix(claude): write shell-hook env file alongside launchctl for Terminal.app compatibility
- feat(claude): inject system-wide env vars via launchctl on ocx start/stop
- fix(claude): force first-party detection so connectors/Design/Files stay alive through proxy
- docs(claude): effort matching, prompt caching, token display, production notes
- feat(claude): tag /v1/messages traffic with surface=claude + GUI log filter
- feat(claude): production-harden the outbound SSE surface
- harden(cursor): align mcp_tools with cursorToolsForActivePrompt filter + regression tests
- fix(claude): synthesize session_id header for ChatGPT-backend cache affinity
- fix(claude): send prompt_cache_key so OpenAI-routed turns hit the prompt cache
- fix(claude): honor Claude Code /effort via adaptive output_config wire
- fix(cursor): make client MCP tools callable via AgentRunRequest.mcp_tools
- fix(usage): unify token accounting convention + cache read/write transparency
- feat(claude): subscription-preserving launch + native Anthropic passthrough
- fix(claude): correct request-log status + token accounting for /v1/messages
- fix(claude): survive real Claude Code wire quirks on native ChatGPT routes
- feat(cursor): nativeLocalExec policy mode (off/codex-sandbox/on) for server-driven local exec
- feat(gui+docs): Claude ON sidebar toggle, Claude settings page, claude-code management API, docs
- feat(claude): ocx claude launcher + gateway model discovery aliases
- feat(claude): Anthropic Messages inbound (/v1/messages + count_tokens) via translate-and-replay
- feat: model ordering docs + v2 thread-limit transition + GUI model reorder groundwork

## 2.7.8 — 2026-07-11

- fix(server): normalize plaintext agent messages before parsing
- fix(server): sanitize plaintext encrypted_content before parse so routed sub-agents receive spawn payloads
- Preserve agent_message boundaries to prevent Anthropic signed-thinking replay failures

## 2.7.7 — 2026-07-11

- docs: sync effortCap/subagentEffortCap rows to shipped v2 gate semantics (3 locales)
- fix(search): give the alpha/search relay its own total deadline (search.timeoutMs)
- harden effort-cap gate: strict thread-spawn markers, surface-agnostic child admission, compaction bypass
- fix: relay Codex alpha search requests (#89)
- fix(openai-responses): strip hosted image_generation that conflicts with declared image_gen tool (#90)
- feat(effort-cap): gate caps to the v2 feature surface
- feat(effort-cap): hard reasoning-effort ceiling for main and sub-agent turns
- feat(deepseek): route direct DeepSeek image input through the vision sidecar (#88)
- fix(gui): center switch knob with flex padding track
- fix(gui): vertically center switch knob in track
- fix(gui): polish update modal close button, switch contrast, and command wrap
- fix(win): skip non-executable shim backups in codex probe candidates

## 2.7.6 — 2026-07-10

- feat: web-search stall timeout + progress stream, images proxy hardening, adapter error redaction
- fix(anthropic): strip Codex's Responses-only encrypted marker from tool input_schema (#85)
- fix(google,kiro): strip Codex's Responses-only encrypted marker from tool schemas (#85)
- fix(server): relay /v1/images to an OpenAI upstream for built-in image_gen (#83)
- fix(opencode-go): hide unavailable hy3 from catalogs (#82)
- ci(release): harden release and docs-deploy gates
- ci: harden cross-platform CI and service-lifecycle workflows
- fix(opencode-go): replay DeepSeek V4 reasoning_content on tool-call turns (#78) + hy3-preview catalog regression guard (#82)

## 2.7.4 — 2026-07-10

- docs: v2 sub-agent injection — READMEs + docs-site (en/ko/zh)
- feat(debug): injection-log flag — gate multi-agent guidance logs behind a checkbox

## 2.7.3 — 2026-07-10

- feat(multi-agent): slim v2 guidance to 700-char budget; v1 back to Proactive-only

## 2.7.2 — 2026-07-10

- feat(multi-agent): v2 surface prompt injection with sub-agent roster
- fix(i18n): translate dash.updateRetry for ko/zh
- docs: refresh guides and localized site
- fix(update): bound GUI retries and remove sync backoff
- feat(hardening): respect local provider endpoints
- fix(gui): auto-retry npm update check on latest_unavailable with Retry button (#77)
- fix(gui): replace question-mark help glyphs
- fix(gui): open language menu below the row on mobile top-bar layout
- feat(gui): add German locale and language dropdown (#79)
- fix(request-log): surface incomplete_details.reason as upstreamError (#80)
- Harden aggregator provider catalog paths
- feat(hardening): WP7 CN providers — model refresh + scoped bracket-strip
- feat(hardening): WP6 xai/kimi group + shared openai-chat surface
- feat(hardening): WP5 kiro — blank-token throw, transient-only retry, framing errors
- feat(hardening): WP4 cursor — turn-failure semantics, alias removal, typed discovery errors
- feat(hardening): WP3 google family — loud auth/envelope failures, AI Studio model refresh
- feat(hardening): WP2 anthropic family — loud credential failures, ctx map completion
- feat(hardening): WP1 openai-responses family — azure loud failures, dead branch removal, template-preset baseUrl respect

## 2.7.1 — 2026-07-10

- feat: add subagent effort and stabilize preview CI
- docs: record preview release gates
- feat: add cursor gpt-5.6 preview models
- test: update codex warmup payload expectations
- fix: send codex warmup input as response items
- fix(anthropic): normalize tool input_schema type + raise decompress body cap
- docs: document where to set unsafeAllowNativeLocalExec for Cursor
- fix(cursor): enable multi-account OAuth by extracting JWT identity
- fix: web-search sidecar stall timeout + search hardening

## 2.7.0 — 2026-07-10

- ci(release): use bundled npm for publishing
- gui+server: polish subagent injection picker
- gui+server: subagent prompt injection-model pick (API + dashboard select)
- docs-site: landing round 4 — scene scrolltelling per motion.md
- fix(warmup): surface upstream error detail and retry fallback models on 400
- docs-site: landing round 3 — brand chips, splash hamburger, cinematic scroll
- devlog: 260710 PR cherry-pick plan
- fix(server): restore httpStatusFromTerminalError re-export after PR #74 cherry-pick
- feat(diagnostics): warn when project .codex/config.toml bypasses OpenCodex (cherry-pick PR #70)
- feat(debug): unified provider/usage debug CLI and GUI tab (cherry-pick PR #74)
- fix(anthropic): normalize tool input schemas (cherry-pick PR #76)
- fix(responses): insert developer message before compaction_trigger
- docs-site: liquid-glass redesign — aside-grammar landing, pill header, ima2 hero fields, SEO
- gui: replace emoji with Lucide SVG icons for sol/terra/luna
- gui: add ☀️🌍🌙 icons to gpt-5.6-sol/terra/luna globally
- sidecar: default model gpt-5.4-mini → gpt-5.6-luna + codex-spark in search only
- gui+catalog: remove codex-spark from vision sidecar + reduce context to 100k
- docs: add sub-agent surface guide to Starlight docs-site
- ci: deploy docs/ static site instead of Astro docs-site
- gui: 6-col grid stat-row + docs link to #sub-agent-surface
- gui: CSS grid stat-row + custom Select on all pages
- gui: stat min-width 160px for wider wrap threshold
- gui: stat-row flex-basis 150px for earlier wrap on narrow screens
- gui: replace all Dashboard native selects with custom Select
- gui: custom Select component + stat min-height 80px
- gui: stat boxes equal height with flex column center
- gui: track+floating pill segmented control — no pill-in-pill
- gui: sort usage models + providers by token count descending
- docs: GitHub Pages documentation site
- gui: design audit fixes — hover, dialog semantics, label consistency
- gui: remove inner borders, pill everything, clean glass
- gui: ? next to label, pill spacing, liquid-glass dropdowns
- gui: sub-agent label, pill buttons, ? help modal with docs link
- gui: liquid glass modal — heavy tint overlay + glass-regular card
- gui: compact dashboard mode buttons to prevent cell overflow
- gui: flex-wrap stat-row balanced layout + liquid glass modal
- gui: proper modal for help popup, localStorage collapse, stat-row fix
- gui: adjust stat grid to 6 columns for dashboard mode cell
- gui: fix toggleCodexAutoStart function ordering in Dashboard
- docs-site: document 3-state multi-agent mode + ultra (en/ko/zh-cn)
- gui: v1/base/v2 segmented control + dashboard mode cell + help popup
- docs + gui: 3-state mode documentation + segmented control aria fix
- catalog: fix default-mode stale multi_agent_version + CI test fix
- gui: fix dead toggleV2 + preserve multiAgentMode in thread updates
- v2: 3-state multi-agent mode — v1 / default / v2
- devlog: remove completed plan documents
- cli: v2 subcommand + usage summary + docs updates
- gui: v2 toggle UI, models page polish, dashboard + usage refinements
- openai-chat: parallel tool calls opt-in + provider registry parity
- cursor: x-session-id, effort map updates, live-transport hardening
- reasoning: ultra→max boundary + raw reasoning hide + effort tests
- catalog: decouple ultra from v2 toggle — always advertise ultra
- catalog: keep install default on v1 but allow switching to v2
- catalog: default unpinned models to v1 multi-agent surface
- responses: split mixed encrypted slots so embedded Fernet task bodies stay decryptable
- responses: v1-surface ultra delegation prompt + encrypted-slot sanitizer for native children
- models: native GPT on/off toggles via disabledModels bare slugs
- catalog: pin upstream models.json snapshot (PR #31684) for exact gpt-5.6 native specs
- cursor: add x-session-id header and dynamic timeZone in protobuf body
- fix(cursor): harden PR #73 follow-ups
- fix(cursor): upstream error mapping transport stability auto model request logs
- docs: document where to set unsafeAllowNativeLocalExec for Cursor
- fix(cursor): enable multi-account OAuth by extracting JWT identity
- feat(catalog): 260709 model refresh — grok-4.5, live-first discovery
- feat(reasoning): port upstream codex-rs ultra effort semantics

## 2.6.32 — 2026-07-08

- fix(tests): align rebased sol/terra/luna branch with post-restructure tree
- fix(auth): verify Codex pool accounts with warmup
- feat(catalog): add GPT-5.6 Sol Terra Luna rollout metadata
- fix(anthropic): guard against empty text content blocks (400 rejection)
- fix(ci): make WSL path logic host-independent (posix ops) + generic test fixtures
- fix(wsl): honor wsl.conf automount root + systemd/localhost guidance
- fix(wsl): guard against WSL+Windows dual Codex installs
- fix(compat): cross-platform Claude Code token detect + gcloud ADC path resolution
- docs(devlog): record ABSOLUTE PASS gate verdict + sol re-rebase evidence
- docs(devlog): final migration-audit report + stabilization evidence ledger update
- fix(migration): dev->dev-B side-effect closure — deterministic legacy oauth ids, cli.ts compat stub, image-guard unknown-dim trim, freeform input streaming
- test(coverage): web-search failover/timeout, WS 426 HTTP fallback, compact v1 error path
- fix(tests): timeout headroom for install-scripts on slow Windows runners
- fix(server): stabilization sweep — failover CAS, compaction cache exclusion, compact pool auth
- fix(web-search): preserve signed thinking in synthetic web_search replay
- fix(sidecar): web-search 429 failover + timeouts, vision fail-closed, coverage drift
- fix(catalog): advertise image input for vision-sidecar-covered models
- fix(tests): explicit timeouts for Windows-CI-slow sqlite and child-spawn suites
- fix(server): production hardening from security + robustness audit
- feat(providers): multi-key 429 failover with cooldown-aware rotation
- fix(tests): fail-fast sqlite busy timeout knob for history sync tests
- fix(tests): privacy-scan-safe fixtures in multiauth/key-pool tests
- fix(ci): update workflow paths after src restructure
- fix(ci): mark preview releases as prerelease so GitHub latest stays stable
- fix(anthropic): send adaptive thinking for models that reject thinking.type enabled
- feat(providers): add anthropic-apikey built-in for direct Anthropic API-key billing
- feat(anthropic): extended-thinking signature round-trip (ocxr1 envelope)
- docs(site): restructure paths, multiauth + API key pool guides (en/ko/zh)
- docs(structure): align maintainer docs with the src restructure and server split
- refactor(server): split index.ts into responsibility modules
- fix(update): package launcher path after src/update/ move
- refactor(src): restructure top-level modules into semantic folders
- chore(tests,docs): CODEX_HOME isolation for cli-provider tests; gitignore test tmp dirs; structure docs refresh
- feat(gui): multiauth account dropdowns, key pool UI, token formatting, responsive fixes
- feat(responses): ocxr1 reasoning-envelope scaffold (parked WIP)
- fix(server): WS 426 gate, /v1/* JSON 404 guard, request-log terminal metadata
- feat(providers): thinkingToggleModels — vendor thinking on/off ladder
- feat(auth): multi-account OAuth store + API-key pool with management API
- feat(responses): codex-rs wire compat, continuation cache, remote compaction v1+v2
- fix(anthropic): image-limit guard + assistant-tail continue nudge
- fix: Windows/Linux hardening - readonly steady-state history gate + CRLF-preserving injection
- fix: set gpt-5.4 default context_window to 1M (was inheriting 272k from template)
- fix: guardian re-counts before stopping; honest deferred-migration message
- feat: background history-migration guardian for the Design B upgrade path
- docs: narrow the history-safe injection claim to what actually ships
- test+docs: Design B integration tests, README note, devlog closeout
- fix: honest inject message when a user-owned openai_base_url blocks routing
- feat: Design B injection - point built-in openai provider at the proxy
- fix: tighten decodeRequestBody input type for tsc
- feat: decode zstd/gzip/deflate request bodies on /v1/responses
- fix: replace token-looking test strings to pass privacy scan

## 2.6.25 — 2026-07-05

- fix: remove oversized IconKey from API page heading

## 2.6.24 — 2026-07-05

- fix: use config.port instead of undefined listenPort in /api/keys
- feat: API Keys tab in dashboard + key generation/auth
- fix: allow CORS from any loopback origin regardless of port
- fix: replace token-looking test strings to pass privacy scan

## 2.6.23 — 2026-07-05

- fix: replace token-looking test strings to pass privacy scan
- feat: add restart, health commands + provider add --sync
- fix: strict arg parsing, mutating --json, richer model metadata
- feat: add non-interactive provider and models CLI commands
- feat(providers): show OAuth quota on provider cards

## 2.6.22 — 2026-07-05

- fix(service): harden cursor exec and service setup

## 2.6.21 — 2026-07-04

- feat(anthropic): improve prompt caching and provider timeouts
- docs(structure): design methodology for new GUI surfaces (CATALOG-DESIGN-FIRST-01)
- docs: add demo GIF to README (en/ko/zh) + docs-site landing

## 2.6.20 — 2026-07-03

- fix(server): finalize native-passthrough request log on client cancel (#44)
- fix(deploy): close windows-deploy-stability audit — restart EINVAL, systemd SSH, localhost bind

## 2.6.19 — 2026-07-03

- feat(gui): Models page allowlist editor + search/pagination for large providers (#52)
- feat(catalog): per-provider selectedModels allowlist to trim oversized catalogs (#52)
- feat(passthrough): clean response.failed terminal on mid-stream SSE reset
- refactor(adapters): consolidate abort/sleep helpers into upstream-retry
- chore(test): pin bun test discovery to ./tests via bunfig
- feat(oauth): token guardian — opt-in proactive OAuth refresh with risk-tiered policies
- docs(structure): document upstream reset retry in transports SOT
- feat(retry): wrap upstream fetch call sites with reset retry
- refactor(kiro): import shared abort/sleep helpers from upstream-retry
- feat(retry): add upstream-retry module — reset-only fetch retry with abortable backoff
- preserve deepseek thinking history (#61)
- clarify doctor proxy env diagnostics (#60)

## 2.6.18 — 2026-07-03

- test(cursor): privacy-scan-safe fixtures in cursor-errors redaction tests
- feat(cursor): WP3 — refuse native file mutations when apply_patch is advertised
- fix(cursor): loop 9 — answer interactionQuery, complete shellResult frames, WP2b/WP1/P0
- fix(lifecycle): loop 8 — adversarial-review findings on loops 6-7
- feat(cli): ocx restore back — reverse switch onto the running proxy
- fix(history): surface skipped Codex history restore instead of silent no-op, retry on lock
- fix(platform): loop 7 — OAuth ::1 conflict fallback, bind-race retry, Windows service write order
- fix(lifecycle): loop 6 — stale-pid purge, orphan-proxy recovery, IPv6 URL/NO_PROXY parity
- feat(gui): add maintenance sync and update actions
- fix(lifecycle): loop 5 — service-aware update stop gate, purge install state on helper uninstall
- fix(lifecycle): loop 4 — review findings: update transaction hardening, IPv6 probe URLs, ~ parity
- fix(lifecycle): loop 3 — identity-checked runtime-first liveness, stale-path detection, stop-before-update
- fix(platform): loop 2 — catalog .cmd probe, OAuth dual-bind, hostname-aware stop, ~ expansion, Git-Bash shim
- fix(platform): Windows/Linux deploy stability — encoding, graceful stop, loopback, spawn hardening
- feat(net): outbound proxy support + models fetch failure cooldown
- fix(google): list Generative Language models via x-goog-api-key + /v1beta
- feat(adapters): tool-catalog nudge for non-OpenAI models + cursor live model discovery
- fix(usage): fold ChatGPT pool and OpenAI passthrough into one openai usage row
- fix(codex): cap spark context window
- fix(cursor): report checkpoint context as visible usage
- fix(cursor): revocable grace finalize closes parallel client-tool race
- fix(cursor): complete client tool round-trip via turn-1 done + full prompt replay
- fix(cursor): make client tool calling round-trip via multi-turn continuation
- feat(models): remove per-provider All on/off buttons
- fix(cursor): suppress post-terminal heartbeats with a state terminated guard
- fix(cursor): heartbeat during silent tool-call assembly to avoid upstream_stall_timeout
- fix(cursor): stop double-counting context usage (absolute totalTokens vs additive output)
- fix(cursor): serialize parallel tool calls via deferred atomic emission
- fix(cursor): add composer-2.5-fast and align static catalog limits to jawcode SOT
- fix(cursor): buffer client-tool args, normalize once at completion
- feat(cursor): harden token refresh with timeout + bounded retry
- feat(cursor): schema-aware tool-arg key normalization
- feat(cursor): mark usage as estimated + extend provider check
- fix(cursor): fail-closed truncation when turn ends with open tool calls
- feat(cursor): actionable error classification + secret/path redaction
- feat(cursor): transport retry on pre-commit failures + first-frame timeout
- test(cursor): pin native-exec no-arg advertised tool-call branch
- fix(cursor): reconcile tool args + commit no-arg calls + fail closed on overlap
- fix(router): explicit defaultModel outranks known-model pattern routing
- test(oauth): use unregistered provider id for unsupported-provider assertion
- fix(cursor): preserve Responses tool result continuations
- fix(cursor): continue synthetic Responses tool calls
- fix(cursor): decode native exec tool calls for Responses
- fix(cursor): route Responses tools through request context
- feat(cursor): bridge Responses tools through Cursor provider
- fix(cursor/mcp): listMcpResources returns honest error when no executor is wired
- feat(cursor/mcp): pass real MCP image bytes through + live stdio integration test
- test(cursor): cover recordScreen dispatcher-boundary throw containment
- feat(cursor): honest computer-use / record-screen executor hooks
- test(cursor): strengthen MCP executor coverage from independent review
- feat(cursor): real MCP tool executor — make MCP tool-calls work end-to-end
- fix(cursor): correct gpt-5.1-codex base to gpt-5.1-codex-max/-mini
- feat(cursor): live GetUsableModels — filter the catalog to the account's models
- fix(cursor): de-speculate gpt/grok/gemini catalog to real Cursor bases
- fix(cursor): align claude catalog ids with the real Cursor names + advertise effort
- fix(cursor): map reasoning effort per-model to the real tier ceiling
- fix(cursor): map reasoning effort into the model-id suffix (fixes bare-model not_found)
- fix(cursor): send rootPromptMessagesJson as blob IDs (fixes 'Blob not found')
- test(cursor): guard token precedence (managed apiKey beats forwarded header)
- feat(cli): show OAuth login status (incl cursor) in ocx status
- feat(oauth): register Cursor as a standalone OAuth provider
- feat(oauth): implement standalone Cursor OAuth PKCE flow
- fix(cursor): treat empty Connect end-stream frame as success, not error
- fix(cursor): preserve split connect frames
- fix(router): prefer OpenAI for bare GPT models
- feat(cursor): complete native exec bridge coverage
- feat(cursor): enable live transport bridge
- fix(cursor): preserve native codex catalog rows
- fix(cursor): show complete static catalog
- feat(cursor): expand static model catalog
- feat(cursor): expose safe dashboard preset
- test(cursor): add live smoke credential gate
- feat(cursor): expose safe static provider metadata
- feat(cursor): add mocked runTurn transport
- feat(cursor): add disabled oauth shell
- feat(cursor): add connect framing helpers
- feat(cursor): add safe runTurn scaffold

## 2.6.17 — 2026-07-01

- fix(codex-catalog): include documented native slugs in picker
- fix(anthropic): drop reconstructed thinking signatures

## 2.6.16 — 2026-07-01

- fix(bridge): include Anthropic cached input in Responses usage
- fix(usage): count Anthropic cache detail in display totals
- feat(usage): expose Anthropic cache read write tokens
- docs(cache): plan cache read write telemetry
- fix(anthropic): enable native automatic prompt caching
- docs(cache): gate automatic Anthropic caching
- docs(cache): record provider cache parity plan

## 2.6.15 — 2026-07-01

- Revert "feat(gui): add cyberpunk routing mockup"
- fix(antigravity): expose cached token hits
- feat(gui): add cyberpunk routing mockup
- fix(usage): show cached token totals
- fix(cache): preserve prompt cache metadata
- fix(anthropic): enable prompt cache breakpoints
- chore: ignore local agent artifacts
- docs(devlog): prune completed plan notes
- fix(antigravity): resolve client aliases to wire models
- fix(usage): count Kiro estimates as measured
- feat(providers): add claude sonnet 5 parity

## 2.6.14 — 2026-07-01

- fix(openai-chat): emit the final EOF frame's content via a shared line handler
- docs(devlog): record WP2 deployability hardening (EOF fix + fingerprint refactor + codex-spark strip)
- fix(adapters): harden client fingerprints, codex-spark tool strip, and openai-chat EOF
- docs(devlog): record deployability hardening WP1 (2.6.14 bump + fingerprint header tests)
- test(anthropic): align umans + tool-result tests with committed cx_ prefix
- test(codex-catalog): add golden oracle for the future build/discovery/persistence split (WP5)
- docs(devlog): record server.ts split progress (WP4 partial, 2/5 modules)
- refactor(server): extract adapter resolution to server/adapter-resolve (WP4.2)
- refactor(server): extract GUI static serving to server/gui-static (WP4.1)
- docs(devlog): close runtime-state-consolidation as verified no-op
- fix(openai-chat): fail closed on a truncated stream (no terminal signal)
- fix(anthropic): do not enable extended thinking for reasoning "none"
- docs(devlog): record GitHub topics + dev branch alignment (260701)

## 2.6.13 — 2026-07-01

- test(doctor): use privacy-scan-safe placeholders in doctor fixtures
- fix(codex-auth): allow pool accounts that match the main Codex login id
- feat(cli): add 'ocx doctor' for WSL/network diagnostics
- fix(codex-routing): re-evaluate quota for bound threads so long-lived sessions switch
- feat(codex-quota): prime pool-account quota at startup and lazily pre-route
- fix(codex-routing): rotate off over-threshold active when all pool quotas are unknown

## 2.6.12 — 2026-06-30

- fix(web-search): harden trailing Sources parser for header/url/prose variants
- docs(site): harden docs-site to current code (40+ providers, azure-openai, dev:proxy/dev:gui)
- docs: harden README + docs to current code (v2.6.11)

## 2.6.11 — 2026-06-30

- fix(antigravity): align CCA envelope with the real first-party client
- feat(fingerprint): match first-party client headers on OAuth paths
- feat(identity): neutralize proxy identity leak across all adapters

## 2.6.10 — 2026-06-30

- fix(web-search): extract sources from the sidecar's text Sources block
- feat(web-search): surface sources as url_citation annotations for the app
- feat(web-search): support native action.search.queries (batched queries)
- feat(web-search): stream live in_progress->completed search cell
- feat(web-search): nudge forced-answer pass to ground reply in gathered results
- feat(web-search): surface native web_search_call activity for routed models
- fix(web-search): raise sidecar timeout from 30s to 200s
- fix(kiro): normalize tool names to runtimeservice charset [a-zA-Z0-9_-]{1,64}

## 2.6.9 — 2026-06-30

- fix(antigravity): emit tool-call ids so Claude-on-CCA tool_use validates

## 2.6.8 — 2026-06-30

- fix(kiro): strip validation-only schema keywords rejected by runtimeservice (#50)
- test(google): replace hardcoded PII with allowed placeholders for privacy scan
- fix(history): non-destructive native restore to prevent session rollback
- feat(usage): 7d bar chart, locale token units, in-box table scroll
- feat(antigravity): bundle agy model list + google-family brevity steering
- test(models): cover global cap value and set-all toggles
- feat(models): cap value dropdown + single set-all toggle UI
- feat(models): global context cap value + set-all backend
- fix(google): per-source ADC in-flight dedup; non-stream fail-closed truncation
- fix(antigravity): recursive canonical key for replay args; observe signatures on non-stream responses
- fix(google): router backfills googleMode; replay keyed by functionCall identity; fail login w/o project; tighten signature denylist
- fix(google): never forward synthetic fc_ id as thoughtSignature; invalidate ADC cache on in-place file change
- fix(google): non-stream CCA unwrap, usage-only chunk, quota no-retry, ADC source-change, history thoughtSignature
- fix(antigravity): persist projectId, onboard transient-retry, wire clear-on-invalid replay + redaction polish
- docs(140): mark vertex+antigravity hardening specs implemented
- feat(antigravity): thoughtSignature reasoning-replay + Claude inline signature sanitization
- feat(antigravity): OAuth + project discovery + CCA envelope + response-unwrap + HTTP hardening
- feat(vertex): fail-closed truncation + reported usage + hardened ADC token exchange
- feat(vertex): HTTP hardening — retry/timeout + classified, redacted errors
- docs(140): copy-paste-ready vertex(11/12) + antigravity(21/22) hardening specs
- docs(140): pin CLIProxyAPI + secondary vertex/antigravity reference repos
- feat(provider): add google-vertex (Vertex AI) provider port
- docs(issue-43): record live locator and path-mismatch diagnostics
- feat(codex-plugins): locate live bundled marketplace and flag path mismatch
- docs(issue-43): record verification-gap fixes (secret-leak, malformed entry)
- fix(codex-plugins): close secret-leak and malformed-entry gaps
- docs(issue-43): plan + phase1 completion for bundled-plugin diagnostic
- test(codex-plugins): cover stale/healthy/non-Windows + CRLF and inline comments
- feat(status): surface codexPlugins diagnostic in ocx status
- feat(codex-plugins): read-only bundled-marketplace staleness diagnostic
- feat(redact): add redactUserPath to mask home-path usernames

## 2.6.7 — 2026-06-29

- docs(update): record independent verification result and findings
- docs(update): record update-notify prompt design, plan, and completion
- test(update): cover channel-aware isNewer, cache, dismiss, and cli wiring
- feat(update): interactive update-available prompt on ocx start
- refactor(update): export channel/version helpers and command builder

## 2.6.6 — 2026-06-29

- feat(providers): allow disabling providers
- fix(gui): name dashboard sidecar controls

## 2.6.5 — 2026-06-29

- fix(timeout): raise provider connect/stream timeout to 100s
- test(kiro): fail closed on cross-toolUseId input before stop
- revert(reasoning): remove unstable summary exposure patches
- fix(kiro): skip fake thinking in tool mode
- fix(catalog): default reasoning-capable routed models to auto summary
- feat(models): add provider context cap toggles
- fix(bridge): route chat reasoning_content to expandable summary channel
- docs(models): design provider context cap toggle

## 2.6.4 — 2026-06-29

- test(google): await async buildRequest in tool-result image assertions
- fix(kiro): preserve root schema fields when flattening composition
- fix(kiro): normalize jpg media type to CodeWhisperer jpeg format

## 2.6.3 — 2026-06-29

- fix(kiro): flatten root tool schema for Bedrock
- chore: ignore opencode local sessions
- fix(adapters): preserve tool result images

## 2.6.2 — 2026-06-29

- fix(ci): allow explicit privacy test fixtures
- fix(kiro): use context usage percentage for totals
- fix(logs): show numeric estimated Kiro tokens
- fix(kiro): show estimated log tokens for account labels
- docs(catalog): record catalog-sync hardening plan (gap A+B)
- fix(catalog): harden model-catalog sync against stale picker entries
- docs(kiro): record final parity audit
- fix(kiro): log full-context estimated usage
- docs(merge): record PR #46 cherry-pick into feat/kiro-on-dev
- fix(logs): finalize native passthrough SSE usage
- docs(kiro): plan final parity audit
- docs(kiro): record estimated usage evidence
- fix(kiro): mark heuristic usage as estimated
- docs(issue-45): trace reasoning render through codex-rs consumer
- docs(kiro): plan estimated usage diagnostics
- docs(kiro): record truncation recovery evidence
- fix(kiro): surface truncated tool-call streams
- docs(kiro): specify fail-closed truncation errors
- docs(kiro): revise truncation plan for bridge heartbeat
- docs(storage): expand #42 epic to jawdev granularity
- docs(kiro): plan truncation detection
- docs(kiro): record actionable error evidence
- fix(kiro): map upstream failures to actionable errors
- docs(storage): promote issue #42 to 500_ epic with phased plan
- docs(kiro): plan actionable error mapping
- docs(kiro): record model resolver evidence
- docs(openai-chat): note GLM-5.2 1M [1m] suffix handling for issue #41
- fix(openai-chat): strip bracketed [1m] suffix from wire model id
- docs(kiro): plan model catalog resolver
- docs(kiro): record tool fallback evidence
- docs(security): exclude Kiro from common hardening evidence
- fix(kiro): harden tool fallback payloads
- docs(kiro): record auth hardening reaudit
- fix(kiro): include safe error formatter
- fix(kiro): sanitize region and upstream error details
- docs(kiro): account for tool fallback file size
- docs(kiro): plan tool fallback hardening
- docs(kiro): record auth hardening evidence
- fix(oauth): broaden single-account Kiro credential inputs
- docs(kiro): plan auth input hardening
- fix(security): normalize OAuth credential store
- fix(security): validate provider URLs and headers
- fix(security): record OAuth credential source safely
- fix(security): allowlist usage log records
- docs(security): detail usage privacy slice
- docs(devlog): review open PRs and issues (#17,#41-45)
- fix(security): preserve origin rejection errors
- fix(kiro): route leading thinking blocks as reasoning
- docs(security): detail local boundary test slice
- fix(security): redact diagnostic sinks
- docs(security): detail diagnostic redaction slice
- feat(security): add shared secret redactor
- fix(gui): format dashboard uptime for readability
- fix(kiro): sanitize tool schemas before CodeWhisperer payload
- docs(security): detail redaction foundation slice
- fix(eventstream): bound frame and header parsing
- docs(security): map common hardening phases
- fix(kiro): preserve tool-use context for resumed tool results
- fix(oauth): singleflight refresh and reload Kiro CLI tokens
- feat(kiro): retry transient HTTP failures before stream parse
- fix(kiro): treat upstream exception frames as terminal
- fix(crash-guard): classify Bun abort-teardown rejection as benign noise
- feat(kiro): send images natively via userInputMessage.images (gateway parity)
- fix(web-search): cancel response body on abort to kill orphaned-read rejection
- fix(eventstream): cancel reader on early termination to stop orphaned-read crash
- diag(crash-guard): instrument global fetch to capture native-reject origins
- diag(crash-guard): add request-path activity breadcrumb (sidecar ruled out)
- fix(kiro): keep resumed payloads current-turn only
- diag(crash-guard): correlate native-frame rejections with sidecar activity
- diag(crash-guard): expose JSC throw site via hidden source fields + Bun.inspect
- diag(crash-guard): capture handler-stack + error shape for native-frame rejections
- fix(codex-catalog): allowlist native slugs so legacy models never advertise
- fix(codex-catalog): pin native Codex context metadata
- fix(kiro): report current-turn usage delta
- fix(codex-inject): restore stripRootContextWindowOverrides (gpt-5.5 1M regression)
- feat(kiro): add per-model context windows from official Kiro catalog
- docs(kiro): phase 6 — full Codex CLI E2E proven (codex exec -> ocx -> kiro)
- fix(shutdown): handle SIGHUP gracefully (was forwarded but default-killed)
- test(shutdown): assert Codex config is restored on Ctrl-C
- fix(shutdown): forward signals to Bun child so Ctrl-C never orphans the proxy
- feat(kiro): emit estimated usage so Codex usage + auto-compact work
- feat(kiro): add heuristic token-estimate sidecar (src/lib/token-estimate.ts)
- docs(kiro): devlog 60 — web_search parseResponse fix (kiro-only live failure RCA)
- fix(kiro): add parseResponse so web_search tool works (kiro-only 500)
- fix(kiro): ignore Codex-forced reasoning effort (CW has no reasoning field)
- docs(kiro): phase 5 live smoke PASSED (self-served E2E vs real CodeWhisperer)
- test(kiro): cover resolveKiroProfileArn + resolveKiroRegion (request-critical resolvers)
- feat(adapter): add kiro adapter (CodeWhisperer over AWS eventstream)
- docs(kiro): phase 3 adapter plan + Backend audit resolution (Q1-Q4, C1/C2)
- feat(oauth): add kiro import-first OAuth (SQLite + desktop refresh)
- docs(kiro): phase 2 oauth plan + Backend audit resolution (B1-B4)
- feat(lib): add AWS eventstream decoder (kiro/bedrock foundation)

## 2.6.1 — 2026-06-28

- fix(proxy): survive per-request stream errors instead of crashing
- fix(usage): collapse legacy <provider>-main rows in summary
- fix(usage): unify main Codex account under base provider name
- chore(devlog): archive implemented plans to _fin (commit cross-referenced)
- fix(usage): merge reported/unreported rows of same model, restore two-column layout
- fix(gui): show total/measured requests in single column
- chore(devlog): archive completed plans to _fin, keep open work in _plan
- test(codex-auth): cover main-account failover and cooldown rotation paths
- feat(codex-auth): treat main account as a first-class rotation member

## 2.6.0 — 2026-06-28

- fix(gui): remove unused isThirtyDayOnlyPlan import
- fix(test): skip file permission checks on Windows
- fix(test): extract normalizeQuotaForPlan to avoid React dependency in CI
- fix(gui): expand heatmap to full-year GitHub-style contribution grid
- fix(usage): detect SSE stream when upstream omits Content-Type header
- fix(quota): forward configuredPlan through pool quota fetch for Go/Free accounts
- docs(usage): Phase 7 plan + OPENCODEX_USAGE_DEBUG cue
- feat(usage): accept ChatCompletions-shape usage payloads
- feat(usage): add diagnostic capture for upstream response shape
- docs(usage): Phase 6 plan for provider pool merging
- feat(usage): merge codex pool log-label suffix in summary aggregation
- test(usage): add /api/usage HTTP integration coverage
- docs(usage): Phase 5 plan for HTTP integration test + visual smoke
- docs(structure): document usage.jsonl and /api/usage
- feat(gui): show 30d token totals and coverage on Dashboard
- docs(usage): Phase 4 plan for Dashboard card + structure docs
- feat(gui): add Usage tab with GitHub-style activity heatmap
- docs(usage): Phase 3 plan for Usage GUI tab with heatmap
- feat(gui): show token totals in Logs table
- feat(usage): add /api/usage aggregate endpoint
- docs(usage): Phase 2 plan for /api/usage and Logs Tokens column
- feat(usage): persist reported usage to ~/.opencodex/usage.jsonl
- docs(usage): plan persistent accounting
- fix(gui): show 30d-only quotas for go and free plans
- fix(pool): use 30d quota for go and free plans
- fix(gui): show fast service tier in logs
- fix(logs): evaluate requested tier support first
- fix(logs): record configured fast tier state
- feat(logs): capture service tier metadata
- fix(cli): report runtime fallback port in status
- docs(cli): clarify runtime port test seam
- docs(cli): plan runtime port status hardening
- fix(cli): keep status diagnostics read-only
- docs(cli): constrain status diagnostics errors
- docs(cli): plan read-only status diagnostics
- fix(cli): tighten parser diagnostics
- docs(cli): plan gpt pro hardening follow-up
- fix(ci): allow documented example home paths
- fix(ci): stabilize service lifecycle checks
- refactor(cli): split help and status helpers
- feat(cli): add json status diagnostics
- docs(cli): currentize help and version output
- docs: clarify source dashboard dev flow
- fix(windows): clean stale service pid files
- docs(cli): split help and diagnostics patch plans
- docs(cli): map help surface gaps
- fix(windows): expose bun runtime diagnostics
- fix(windows): set websocket idle policy
- docs(cli): refocus help work on research
- fix(windows): install scheduler task from xml
- docs(cli): tighten version plan
- docs(cli): plan human-friendly command ux
- fix(windows): keep passthrough sse body native
- docs: clarify source dashboard dev flow
- fix(cli): show pid path in status
- fix(cli): show runtime path in status
- fix(windows): harden scheduler task args
- fix(windows): expose service diagnostics
- fix(windows): log service wrapper startup
- fix(windows): record responses close reasons
- fix(windows): avoid passthrough stream rewrap
- fix(windows): disable responses request timeout
- fix cross-platform CI test paths
- fix(oauth): classify stale provider config
- harden opencodex release and runtime paths
- chore: update docs and dashboard tooling
- fix(windows): stop proxy before service cleanup

## 2.5.6 — 2026-06-27

- fix(codex-auth): scope duplicate checks by plan bucket
- fix(codex-auth): detect duplicate refresh grants
- fix(codex-auth): stop identity-based duplicate blocking
- fix(codex-auth): keep tickets beside next-session badge
- fix(codex-auth): preserve reset ticket badge styling
- fix(codex-auth): allow team reset credit tickets
- fix(cli): avoid persisting fallback port
- fix(server): explain missing dashboard root
- chore(bin): track dist command symlinks
- test: add crash-safe journal tests (subprocess pattern)
- feat: integrate config journal into inject/start/ensure lifecycle
- feat: add crash-safe config transaction journal
- [agent] docs: devlog 360 verification — PR #37 integrated + closed
- [agent] fix(router): review nits for PR #37 effort hydration (360)
- fix(router): hydrate registry reasoning effort defaults for stale persisted provider configs
- [agent] docs: devlog 360 — plan PR #37 router effort hydration → dev
- docs(devlog): 140 phased execution roadmap — all remaining provider ports
- ci: add macOS to CI matrix and service lifecycle tests
- fix: add windowsHide to detached proxy spawns
- fix: add process.on(exit) handler for Windows SIGTERM gap
- [agent] docs: register bundled-bun in structure SOT + 320 verification doc
- [agent] test: unit-test bun-runtime size gate + resolution (320)
- [agent] docs: finish Phase 4 — translated READMEs + docs-site (320)
- fix: use atomicWriteFile for Codex config/profile writes
- fix: use os.tmpdir() instead of hardcoded /tmp in auth context tests
- [agent] fix: detect bun placeholder stub by size, not just 0-byte (320)
- [agent] chore: sync bun.lock with bundled bun dependency (320)
- [agent] feat: update advisory + npm-global CI + docs for bundled bun (320 P3+P4)
- [agent] feat: bundle Bun so npm install works without separate Bun (320 P1+P2)
- [agent] docs: devlog 320 bundled-bun npm install plan + research

## 2.5.5 — 2026-06-25

- ci: support preview OIDC releases
- fix: harden Windows Codex integration
- fix: use healthHost() in checkProxyHealth for custom hostname bindings
- test: add fallback error code and combined filter coverage
- fix: allow release script to run from preview branch
- feat: expand ocx status diagnostics
- fix: guard stale proxy pid files
- feat: add request log metadata filters

## 2.5.4 — 2026-06-25

- fix: keep codex model cache wrapper during refresh
- [agent] docs: fix 10 audit issues in devlog 290 plan

## 2.5.3 — 2026-06-25

- fix: repair incomplete config by merging defaults instead of rejecting
- [agent] feat: individual credit details with FIFO expiry display
- [agent] fix: persist active page in URL hash across reload
- fix: default defaultProvider to openai in config schema
- [agent] test: rate-limit reset credits unit tests (devlog 290 phase 4)
- [agent] feat: rate-limit reset credits dashboard GUI (devlog 290 phase 3)
- [agent] feat: rate-limit reset credits backend (devlog 290 phase 1)
- feat: default syncResumeHistory to true
- [agent] docs: fix 11 Frontend audit issues in devlog 290 UI spec
- fix: map xhigh reasoning effort to max for Ollama providers
- [agent] docs: devlog 290 detailed UI spec for reset credits
- [agent] docs: devlog 290 rate-limit reset credits plan + API research

## 2.5.2 — 2026-06-25

- No user-facing changes recorded.

## 2.5.1 — 2026-06-25

- No user-facing changes recorded.

## 2.5.0 — 2026-06-25

- fix: graceful shutdown drain + passthrough tee relay (Bun#32111)
- docs: document OPENCODEX_API_AUTH_TOKEN and config recovery behavior

## 2.1.11 — 2026-06-25

- docs: highlight codex multi-account auth

## 2.1.10 — 2026-06-25

- No user-facing changes recorded.

## 2.1.9 — 2026-06-25

- fix: preserve invalid config before fallback
- docs: record codex phase 70 evidence
- fix: avoid privacy scan self-match
- fix: bound codex affinity and refresh grants
- docs: record codex privacy verification evidence
- fix: redact codex auth privacy surfaces
- fix: record codex terminal stream outcomes
- fix: cooldown rate-limited codex accounts
- fix: record codex sidecar auth outcomes
- fix: classify codex upstream outcomes
- fix: treat unknown codex quota conservatively
- fix: disable unverified codex manual import
- fix: guard non-loopback opencodex APIs
- fix: bind codex account lifecycle to generations
- fix: guard codex credential refresh generation
- fix: purge codex account lifecycle state
- fix: fail closed codex pool auth context
- docs: refine codex multi-auth security plan
- docs: plan codex multi-auth security fixes
- fix: contain codex auth quota rows
- docs: mark codex auth e2e verification complete
- docs: summarize codex auth verification results
- docs: record codex auth runtime verification
- docs: record codex auth build verification
- feat: fail over unhealthy codex pool accounts
- docs: refine codex auth verification plan
- docs: plan codex auth verification goal
- docs: record codex auth verification inventory
- refactor: split codex auth collision checks
- fix: allow team codex account members
- fix: align codex quota reset rows
- fix: sync codex oauth login runtime config
- fix: scale codex account pool refresh
- fix: copy codex oauth login link
- fix: cancel codex oauth login flow
- fix: sync codex auth runtime config
- fix: label codex pool accounts in request logs
- feat: add codex auth quota refresh
- fix: make codex account remove icon red
- fix: remove personal codex account examples
- fix: refresh codex pool quota on account load
- fix: recover codex auth login status
- fix: isolate opencodex auth state in tests
- fix: write expired cache wrapper to force CLI model refresh
- fix: clear model cache before catalog refresh on provider add/delete
- fix: sync models_cache.json on server startup for CLI model picker
- fix: auto-register chatgpt passthrough provider on startup
- fix: address all critical/high issues from ChatGPT code review
- fix: show OAuth error on pick step + clean unused constructor param
- fix: prevent OAuth token collision between pool accounts and Codex CLI
- fix: make btn-icon visible in dark mode
- fix: actively fetch quota for pool accounts via wham/usage API
- fix: use official Codex redirect URI (localhost:1455/auth/callback)
- test: add OAuth JWT extraction and session affinity tests (27 new)
- fix: correct OAuth to auth.openai.com with proper client_id and form-urlencoded
- feat: production OAuth flow — auto-register pool account + GUI polling
- test: add codex-auth API endpoint tests
- fix: add refresh lock, input validation, graceful token fallback
- feat: capture quota from passthrough headers + auto-switch at threshold
- feat: add ChatGPT OAuth login flow for multi-account
- fix: two-step Add Account modal — pick method then import
- feat: add account import modal + extend cache TTL to 5 minutes
- feat: show real Codex account info in Codex Auth tab
- fix: CodexAuth UI — always show main account, add missing CSS
- test: add multi-account auth tests for store CRUD and passthrough override
- feat: add Codex Auth dashboard tab with account pool management
- feat: add codex-auth management API endpoints
- feat: inject codex account override in passthrough + session affinity
- feat: add CodexAccount types and account credential store
- fix: use additive merge for Anthropic stream usage
- fix: preserve Anthropic stream input usage

## 2.1.8 — 2026-06-23

- docs: refine v2.1.8 release plan
- docs: plan v2.1.8 release
- docs: record pr16 pr22 integration evidence
- fix: honor static allowlists during catalog augmentation
- fix: repair anthropic tool result history
- feat: allow static provider model catalogs

## 2.1.7 — 2026-06-22

- feat: preserve provider catalog metadata caps
- chore: trim umans devlog whitespace

## 2.1.6 — 2026-06-22

- feat: add Umans provider preset
- fix: source dashboard badge version from runtime
- test: cover recover-history help guard
- guard subcommand help before side effects
- docs: note local omp reference clone
- docs: record oh-my-pi umans path
- docs: investigate umans wire protocol
- fix: eject opencodex history on native restore
- docs: document history sync in zh-cn
- fix: handle legacy history remap recovery
- fix: make Codex history sync reversible
- chore: guard release metadata preflight
- clarify resume history compatibility mode
- preserve Codex resume history by default

## 2.1.5 — 2026-06-22

- feat: add search/vision sidecar model settings to dashboard
- fix chat tool choice and stream timeouts
- fix passthrough stream idle disconnects (#10)
- fix passthrough stream idle disconnects (#10)
- Skip Unix shim execution test on Windows
- Guard Codex shim internal commands
- docs: devlog/210 — PR #8 apply plan
- fix: address PR #8 review — dynamic import, sync logging, toggle error
- feat: Codex autostart ensure fallback + port fallback + uninstall
- docs: devlog/210 — PR #8 autostart ensure fallback code review

## 2.1.4 — 2026-06-21

- fix: resolve GO-with-conditions — timeout, catalog, summary, tests

## 2.1.3 — 2026-06-21

- chore: bump version to 2.1.3
- fix: harden auth.json permissions at startup via loadConfig
- fix: round 3.1 — schema namespace, stall detection, ordered output, auth migration
- fix: round 3 security fixes — auth migration, tool output, reasoning, namespace, parallel
- [agent] docs: devlog/200 final merge record — main v2.1.2 patches + PR #7 history sync
- Sync Codex resume providers during injection
- Fix stale Codex shim repair
- fix: skip api-version query on Azure v1 Responses endpoint
- fix: force parallel_tool_calls=false unconditionally in catalog
- fix: use rundll32 on Windows and add URL scheme guard in openUrl
- fix: use atomicWriteFile for config.json to ensure 0o600 permissions
- fix: default parallel_tool_calls to false until parser supports it
- fix: set 0o600 mode on config and auth files, 0o700 on config dir
- fix: replace exec with spawn in openUrl to prevent shell injection
- fix: add Origin validation to WebSocket upgrade and data-plane POST
- fix: update Azure OpenAI baseUrl to match Responses API path
- fix: strip trailing /v1 from baseUrl before appending /v1/responses
- docs: add UAYOR disclaimer for proxy-based provider access

## 2.1.2 — 2026-06-21

- docs: v2.1.2 patch verification results
- test: add dedicated tests for v2.1.2 patch findings
- fix: repair Codex shim after ocx update on Windows
- feat: configurable stall timeout (default 90s, was hardcoded 5min)
- fix: block cross-origin mutating requests to management API
- fix: emit response.incomplete event type in WS JSON fallback
- fix: normalize anthropic adapter baseUrl to prevent /v1/v1/messages
- docs: v2.1.2 patch plan — 2nd round release gate remediation

## 2.1.1 — 2026-06-21

- fix(ci): install GUI dependencies before build step
- [agent] chore: remove devlog/210 — anthropic-sdk adapter plan cancelled
- [agent] revert: remove anthropic-sdk adapter — Agent SDK path not viable, raw fetch is correct
- [agent] feat: add anthropic-sdk adapter as separate adapter type
- [agent] feat: Anthropic SDK adapter — executeStream via @anthropic-ai/sdk
- ci: add GUI build, dev branch trigger, crash restart hard failure
- fix: detect Windows Codex updates that bypass .cmd shim via PATHEXT
- [agent] docs: devlog/210 plan — Anthropic SDK adapter port
- [agent] docs: devlog/210 plan — Anthropic SDK adapter port
- security: disable unsafe /api/config PUT endpoint
- fix: emit response.incomplete on adapter EOF and heartbeat stall
- feat: per-model wire protocol override for OpenCode Go MiniMax/Qwen
- security: bind to 127.0.0.1 by default + restrict CORS to localhost
- docs: add autostart shim documentation (service vs shim comparison)
- test: extend shim tests — marker detection, bypass env, round-trip write
- fix: preserve Codex updates during shim repair
- feat: detect and repair stale Codex autostart shim

## 2.0.2 — 2026-06-20

- fix(ci): reset exit code in windows schtasks uninstall step

## 2.0.1 — 2026-06-20

- feat: refresh Codex cache after provider changes (#3)
- Add Codex autostart shim (#4)
- [agent] feat: add setup guide dropdown in Add Provider modal for presets
- [agent] feat: simplify Add Provider modal for presets + rename ZAI/MiniMax labels

## 2.0.0 — 2026-06-20

- [agent] fix(gui): remove background radial gradient glow
- [agent] docs: sync structure/ and GitHub Pages with recent changes
- [agent] fix(gui): align brand logo, name, and version badge vertically
- [agent] feat: move Stop button to sidebar — power icon, red accent, confirm dialog
- [agent] feat: dashboard Stop button + /api/stop endpoint + clean-exit docs
- [agent] docs: add Codex App model picker screenshot to README and docs-site
- [agent] fix: center-align README tagline + fix Windows CI schtasks query exit code
- [agent] docs: add 4-line hero tagline above banner
- [agent] fix: ocx stop now disarms service manager before killing process
- docs: record dashboard i18n language router (160.14)
- [agent] docs: rewrite all READMEs — add provider guide, model routing, richer highlights
- feat(gui): add en/ko/zh language router + translate the dashboard
- [agent] test: add negative test — verify 'max' is stripped from Codex catalog efforts
- fix: report real npm version + restore logo visibility in light mode
- fix(gui): auto-refresh Models list for lazily-loaded providers
- [agent] docs: add ima2-generated brand assets and apply to README, docs-site, OG meta
- fix(gui): resolve mobile horizontal overflow + table scroll + accent checkboxes
- feat(gui): refine dashboard — drop Auth column, group models, lighten boxes, fix mobile tabs
- feat(gui): redesign dashboard with light/dark themes
- feat: hide image/video generation models from routed catalog
- docs: document ci and release workflows
- ci: add cross-platform release gate
- docs: scaffold 160 dashboard redesign + media models devlog
- Add Neuralwatt effort routing
- fix: move star prompt to start flow

## 1.9.5 — 2026-06-20

- fix: avoid missing codex catalog injection

## 1.9.4 — 2026-06-20

- docs: use scoped opencodex install spec
- docs: record opencode go official contract retry
- docs: flatten structure source of truth
- docs: refresh opencodex documentation

## 1.9.3 — 2026-06-20

- Fix native reasoning passthrough history

## 1.9.2 — 2026-06-20

- Disable websocket transport by default
- Fix orphan chat tool results
- Fix strict Codex catalog regeneration

## 1.9.1 — 2026-06-20

- fix: enable websocket transport by default

## 1.9.0 — 2026-06-20

- docs: record web-search loop abort verification
- fix: abort web-search loop provider fetches
- docs: record sidecar abort verification
- fix: propagate websocket aborts to sidecars
- docs: record websocket release review fixes
- fix: abort websocket turns before upstream headers
- docs: record websocket correctness verification
- fix: preserve websocket turn cancellation hooks
- fix: harden responses websocket protocol
- fix: gate websocket transport by explicit opt-in
- docs: record phase 131 pr ci
- fix: augment opencode go catalog rows
- fix: sync opencode go catalog metadata
- fix: remove stale Codex context overrides
- fix: cap claude sonnet catalog context
- test: harden provider registry parity guard
- docs: record phase 130 implementation
- feat: single-source provider registry
- [agent] fix: stabilize native responses websocket passthrough
- [agent] docs: plan remaining provider ports (devlog 140)
- [agent] docs: plan provider-catalog single-sourcing (devlog 130)
- [agent] fix: restore opencode-go CLI parity + backfill minimax metadata
- [agent] fix: advertise opencodex websocket transport by default
- [agent] docs: record 120.2/120.4 live E2E results (WS + flag PASS)
- [agent] feat: gate supports_websockets behind config.websockets (120.4)
- [agent] feat: Responses WebSocket endpoint (120.2 MVP)
- [agent] docs: record phase 110 F5 live E2E results (opencode-go bridge PASS)
- [agent] fix: stream fidelity — inline errors, usage retention, frame-drop visibility (F1/F2/F4)
- [agent] fix: map overload to server_is_overloaded, keep transient 429 retryable (F3)
- [agent] docs: address review gaps in 110/120 plans (anchors + WsData spec)
- [agent] docs: phase 120 implementation plans (120.2-120.5)
- [agent] docs: phase 120 websocket parity foundation (protocol + transport decision)
- [agent] docs: phase 110 closure implementation plans (F1-F5)
- [agent] docs: mark RC3 keep-alive implemented in phase 110
- [agent] feat: idle keep-alive heartbeat to prevent codex SSE idle-timeout (RC3)
- [agent] docs: record RC2 passthrough fix (RC2 complete on both paths)
- [agent] fix: abort upstream on client disconnect (passthrough path)
- [agent] docs: correct phase 110 RC3 keep-alive (real event not comment; idle_timeout 300s default/5s floor)
- [agent] docs: phase 110 P0 implementation record (RC1/RC2 fixed)
- [agent] fix: abort upstream fetch on client disconnect (routed stream path)
- [agent] fix: guarantee terminal Responses event + harden bridge stream lifecycle
- [agent] docs: phase 110 codex stream-error RCA, transport eval, patch direction
- [agent] test: add phase 100 parity smoke
- [agent] fix: align error and header fidelity
- [agent] docs: reconcile routed search policy
- feat: enrich catalog with jawcode metadata
- fix: preserve reasoning and usage details
- fix: advertise routed image search sidecar
- fix: normalize routed search metadata
- fix: normalize routed Codex catalog entries
- docs: settle phase 100 websocket policy
- docs: expand phase 100 Codex parity research
- docs: plan phase 100 Codex native parity
- docs: record Codex App catalog integration
- chore: make CLI entrypoint executable
- fix: keep fast tier native-only
- fix: require ChatGPT auth for Codex proxy
- docs: record phase 80 path hardening
- fix: align Codex fast service tier
- ci(release): make dry runs version-safe
- ci(release): create GitHub releases with commit logs

## 0.2.2 — 2026-06-20

- Fix Windows proxy stop verification
- Harden Windows service Codex home handling
- Document Codex path handling research
- Fix Codex home handling for services
- Avoid legacy profile table injection
- Fix Codex catalog injection on Windows
- fix(gui): label opencode-go preset correctly

## 0.2.1 — 2026-06-19

- ci(release): retry npm registry smoke

## 0.2.0 — 2026-06-19

- feat(70): platform compat patches, install scripts, README platform table
- feat(70): Windows/Linux use own OAuth storage, drop secret-tool detection
- feat(70): add Linux systemd user unit service support
- feat(70): extract cross-platform openUrl() utility — Windows + Linux browser open
- rename npm package to @bitkyc08/opencodex (scoped, npm similarity check exempt)
- chore: rename npm package opencodex → opencx
- chore: stop tracking devlog/ (internal planning docs)

## 0.1.0 — 2026-06-19

- ci(release): switch npm publish to Trusted Publishing (OIDC) — no NPM_TOKEN
- feat(cli): ocx update — self-update to the latest published version
- ci(release): adopt jawcode-style npm release (workflow_dispatch + dry-run + provenance)
- docs: dashboard screenshot hero + collapsible bun-install
- ci(npm): publish to npm on version tag (provenance) + release runbook
- feat(cli): `ocx init` exposes the full provider catalog (GUI parity)
- feat(cli): interactive [Y/n] GitHub-star prompt that stars via gh (agbrowse-style)
- feat(cli): one-time GitHub-star prompt on first interactive `ocx start`
- fix(tools): pass native/unknown tool types through instead of silently dropping them
- fix(sidecars): drop max_output_tokens — codex backend rejects it (breaks web search)
- fix(reasoning): drop unsupported "max" tier — Codex's catalog parser rejects it
- feat(gui): redesign dashboard to the brand theme (dark devtool)
- docs(readme): add logo + Korean/Chinese READMEs with language nav
- fix(reasoning): expose full low/medium/high/xhigh/max ladder for routed models
- feat(docs): brand logo + Korean & Chinese localization
- feat(providers): protocol-based import criterion — add Kilo, Copilot, GitLab Duo, CF Gateway
- docs(providers): list the newly imported catalog providers
- feat(providers): import the rest of jawcode's API providers into the catalog
- fix(ci): pin Node 22 for the Astro build (Astro 6 requires >=22.12.0)
- docs(readme): rewrite — accurate providers/adapters, OAuth, sidecars, docs link
- ci(pages): deploy docs-site to GitHub Pages via Astro action
- docs(site): Astro Starlight developer documentation site
- feat(providers): add Ollama Cloud with web-verified text/vision classification
- feat(types): tolerant no-vision model matching (Ollama ":size" tags)
- docs(web-search): hardening-pass devlog — web-ai gap review, fixes, verdict
- feat(web-search): verbalize image results when the routed model is text-only
- feat(web-search): JSON-mode guard — render tool result as JSON in structured output
- fix(web-search): cap sidecar search answer at 1500 output tokens
- fix(vision): bounded-concurrent describes, per-image clamp, data-URL validation
- fix(web-search): guard against re-running a query that already failed this turn
- fix(web-search): untrusted-data boundary + answer/source caps in tool result
- fix(web-search): tolerant SSE parser — capture streaming citations, surface errors
- fix(vision): describe view_image tool-output images too (situation B)
- feat(vision): vision sidecar — give text-only models eyes via gpt vision describe
- fix(vision): send images as image blocks, not inlined text (token-limit explosion)
- docs(web-search): implementation log — Phase 1+2 done, runtime findings, remaining work
- fix(web-search): loop hardening — cap answer, preserve real tool calls, total-search budget (Phase 2)
- feat(web-search): gpt-5.4-mini sidecar — real web search for non-OpenAI models (Phase 1)
- fix(tools): no-arg tool calls must serialize as "{}" not "" (session-poisoning 400)
- refactor(polish): name anthropic token constants + dedup model fetch
- docs(web-search): scaffold gpt-5.4-mini web-search sidecar plan (plan only)
- feat(subagents): default featured = native GPT models; native list always-latest
- feat(models): always-latest via Anthropic /v1/models + reconcile OAuth presets on start
- fix(codex-inject): write model_provider at TOML root so codex exec routes via proxy
- fix(anthropic): max_tokens > thinking.budget_tokens (extended-thinking 400)
- feat(xai): add grok-composer-2.5-fast + drop reasoning param for it & grok-build-0.1
- fix(bridge): emit Responses .done finalization events (opencode-go cutoff)
- fix(review): final-audit findings — Anthropic multi-turn tooling + robustness
- feat(models): enable/disable models, grouped + collapsible by provider (Cycle 8)
- feat(subagents): GUI picker for the 5 spawn_agent model overrides (Cycle 7)
- feat(cli): ocx service — run as a background service (Cycle 6)
- feat(gui): vLLM + LM Studio local provider presets (Cycle 5)
- feat(oauth): API-key login for 18 providers (Cycle 3)
- feat(oauth): Anthropic + Kimi true OAuth login (Cycle 2)
- fix(proxy): strip content-encoding/length on gpt passthrough (stream errors)
- fix(restore,gui): address final-review findings
- feat(cli): restore native Codex when the proxy stops
- feat(gui): real OAuth login button in Add Provider modal
- feat(oauth): xAI OAuth login end-to-end (Cycle 1)
- fix(parser): list exact wire names in tool_search result (so models call loaded tools)
- feat(openai-chat): forward tool_search + deferred tools (subagents) to go models
- feat(openai-chat): forward apply_patch to go models via custom_tool_call round-trip
- feat(openai-chat): forward MCP namespace tools to go models with round-trip namespace
- feat(gui): searchable Add Provider modal + /api/providers endpoint
- fix(codex-catalog): drop bare duplicates of routed models in catalog
- feat(server): record real model+provider in request log
- fix(openai-chat): clamp reasoning_effort and neutralize injected GPT-5 identity
- fix(openai-chat): drop empty assistant messages from history
- docs(devlog): phase-4 plan — OAuth passthrough + routing + model namespacing
- feat(proxy): OAuth passthrough for gpt-*, provider routing, namespaced models
- feat(codex-inject): route all models through opencodex by default
- fix: handle Codex reasoning:null and /v1/models format mismatch
- fix: use separate profile file per official Codex 0.134.0+ docs
- fix: stop overriding model_provider, use profile instead
- feat: Codex config.toml에 모델 자동 주입
- feat: 모델 자동 로딩 — /v1/models + /api/models 엔드포인트
- feat: GUI를 프록시 서버에서 직접 serve
- feat(p7): Polish — README, LICENSE, 최종 검증
- feat(p6): Enterprise Adapters — Google Generative AI + Azure OpenAI
- feat(p5): React GUI 대시보드 — Dashboard, Providers, Logs
- feat(p4): Model Router — 모델 ID → 프로바이더 자동 라우팅
- feat(p3): Config & Init — ocx init + Codex config.toml 자동 주입
- feat(p2): Multi-Adapter — Anthropic + OpenAI Responses 패스스루
- plan(p2): Multi-Adapter 계획 — Anthropic + OpenAI 패스스루
- fix(p1): 중복 done 이벤트 수정 — usage를 [DONE]에서만 emit
- feat(p1): Core Proxy 구현 — Responses API → Chat Completions 변환
- plan: Phase 1 Plan v2 — audit FAIL 6건 수정
- plan: 7-Phase 마스터 플랜 + Phase 1 상세 설계
- init: opencodex 프로젝트 스캐폴드 + jawcode 프로바이더 전수조사
