# 000 — Go 포팅 파리티 완성 유닛 계획

세션: `019fa828-b1e3-7403-9a39-87f476f4b890`
goalplan: `opencodex-go-go-typescript-src-codex-260728-go-p`
브랜치: `codex/260728-go-port-rebase`
기준: `origin/dev` = `7710185c0`, 리베이스 후 HEAD = `a3f99afaa`
작성: 2026-07-28

## 목표

`go/**`를 TypeScript 오라클 `src/**` 대비 실제 파리티까지 끌어올린다. "실제"의 정의는
기억이나 이전 스코어카드가 아니라 이 브랜치에서 새로 실행한 명령 출력이다.

## 이 유닛이 존재하는 이유

이전 라운드(`260726_260726-go-port-r10`)는 `origin/dev@1eb7269f` 시점에 파리티를 선언했다.
그 선언 자체는 당시 측정으로 유효했지만, 그 뒤 `dev`가 크게 전진했다.

- `git log --oneline 1eb7269f..origin/dev -- src/` → 113 커밋(비머지 101)
- `git diff --stat 1eb7269f..origin/dev -- src/` → 129 파일, `+18,687 / -991`

즉 "30/30 S3, 파리티 100%"는 **과거 기준선에 대한 참**이고 현재 기준선에 대해서는 거짓이다.
이 유닛은 그 드리프트를 닫는다.

## 실행 형태

`cxc-loop` docs-first 다중 work-phase PABCD 루프. 첫 사이클(wp0)은 docs-only 로드맵
사이클이고, 이후 각 사이클이 십진 문서 하나를 소비한다(LOOP-DOCS-FIRST-01,
DIFFLEVEL-ROADMAP-01, LEXICO-SPLIT-01, PHASE-SPLIT-01).

## 문서 배치

| 번호 | 성격 | 내용 |
| --- | --- | --- |
| 000 | 리서치 | 이 계획 |
| 001 | 리서치 | 리베이스 실측 상태와 게이트 결과 |
| 002 | 리서치 | CLI 표면 격차 인벤토리 |
| 003 | 리서치 | `src/**` 업스트림 델타 인벤토리 |
| 004 | 리서치 | 스코프 경계와 오라클 읽기 전용 계약 |
| 010~120 | 구현 | work-phase별 diff 수준 구현 문서 |

## 종료 조건

`004_scope_and_contract.md`의 완료 게이트를 모두 신선한 출력으로 통과할 때. 부분 통과는
`BLOCKED`/`NEEDS_HUMAN`으로 정직하게 보고하고 `DONE`으로 부르지 않는다.
