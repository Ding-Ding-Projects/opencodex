# 000_plan — dev2-go dev delta Go port continuation

Date: 2026-07-25
Session: 019f9971-f974-7391-bb3b-4e7dde40dccf
Branch: `dev2-go` @ rebased onto `dev` (a5ec15e3), 52 commits ahead
Merge-base: dev is ancestor of HEAD (verified)
Work class: C4
Loop archetype: spec-satisfaction continuation

## Loop specification

- Trigger: HOTL `cxc-loop` + Sol medium subagents; port dev delta TS features to Go.
- Goal: dev delta 새 TS 기능 중 Go 포팅 가능 항목 구현 + 테스트; 의존성 미해결 항목은 증거 기반 defer.
- Non-goals: merge into dev/preview/main; npm/release; GUI; push without approval; routing/account/pool/compaction 인프라 구축 (별도 트랙).
- Verifier: `go build ./... && go vet ./... && go test ./... -count=1 -timeout 120s`
- Stop: DONE when all implementable ports green + deferred items evidenced; BUDGET_EXHAUSTED at 4h.
- Memory: this unit; goalplan `dev2-go-go-dev-delta-ts-6-go-types-config-probe`.
- Escalation: product depth for live/voice; force-with-lease only on dev2-go after local gates.

## HOTL resource bounds

- Write: `go/**`, `devlog/_plan/260725_dev2_go_dev_delta/`, goalplan.
- Tools: git, go, Sol medium subagents; no secrets.
- Wall-clock: 4h.

## Dev delta summary (22e45f88..a5ec15e3, 150 commits)

| TS change | Files | Go status | Disposition |
|---|---|---|---|
| #404 per-model wire override | types.ts, config.ts, adapter-resolve.ts, openai-tiers.ts | No equivalent | **IMPLEMENT** (wp1) |
| #433 probe lease + cooldown | routing.ts, auth-context.ts, core.ts, compact.ts | No routing/account infra | **DEFER** (no Go routing) |
| Terminal guard | terminal-guard.ts (NEW 230L), core.ts | No equivalent | **IMPLEMENT** (wp3) |
| #422 compaction gate | core.ts, compact.ts, openai-tiers.ts | No compaction handling | **DEFER** (no Go compaction) |
| #432 Task Scheduler XML | service.ts (143L) | Stub taskManager, no XML validation | **IMPLEMENT** (wp5) |
| #373 Cursor context estimation | cursor/protobuf-request.ts, tool-definitions.ts, protobuf-events.ts, etc. (416L) | Cursor adapter exists | **IMPLEMENT** (wp6) |
| GUI redesign (WP2-WP7) | gui/ | N/A | Out of scope |
| docs-site, README | docs-site/, readme/ | N/A | Out of scope |
| Pricing (claude-opus-5) | expected-prices.ts | N/A | Out of scope |

## Dependency-ordered work-phase map (locked target)

| workPhaseId | Decade doc | Purpose |
|---|---|---|
| wp0_docs | 000–003 | Docs-only inventory + A-gate + lock |
| wp1_types_config | 010 | Types/config + OpenAI tiers (#404, tier predicates) |
| wp2_probe_lease | — | DEFERRED: Go routing/account/pool 부재 |
| wp3_terminal_guard | 030 | Terminal guard (plan-only 감지 + nudge) |
| wp4_compaction_gate | — | DEFERRED: Go compaction 부재 |
| wp5_task_scheduler_xml | 050 | Windows Task Scheduler XML hardening (#432) |
| wp6_cursor_adapter | 060 | Cursor adapter 강화 (#373 + protobuf/tools) |
| wp7_final_proof | 070 | Final gates + archive |

## Acceptance

1. `git merge-base --is-ancestor dev HEAD` (already met)
2. Local Go gates green on tip
3. Each implementable phase ported with activation tests
4. Deferred phases have evidence anchors
5. Criteria capturedEvidence non-empty

## Previously deferred (260724 loop, still deferred)

- wp3 Cursor continuity: no production wiring change in dev delta
- wp4 Shim auto-restore: no TS change
- wp5 GPT-Live relay: live.ts unchanged, no Go live routes
