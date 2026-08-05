---
title: Quickstart
description: 기존 ChatGPT/Codex 로그인으로 opencodex를 시작합니다. 로컬 사용에는 프로바이더 API 키가 필요 없습니다.
---

새 로컬 구성은 기존 ChatGPT/Codex 로그인을 전달하는 내장 `openai` 프로바이더를 사용합니다.
첫 시작 전에 프로바이더 API 키를 준비하거나 `ocx init`을 실행할 필요가 **없습니다**.

## 1. 프록시 시작

```bash
ocx start            # 기본 포트 10100
ocx start --port 8080
```

이 터미널은 계속 열어 두세요. 시작 시 opencodex는:

- 구성 파일이 없으면 키가 필요 없는 ChatGPT 포워드 프로바이더를 불러오고,
- PID를 `~/.opencodex/ocx.pid`에 기록해 중복 실행을 막고,
- 사용 가능한 모델을 Codex 모델 카탈로그에 동기화하고,
- 로컬 프록시를 Codex 구성에 되돌릴 수 있는 방식으로 추가하고,
- `http://localhost:<port>/v1`에서 수신 대기합니다.

요청한 포트가 사용 중이면 빈 포트를 `runtime-port.json`에 기록하고 Codex가 실제 리스너를
사용하도록 갱신합니다. 다른 터미널에서 상태를 확인하거나 대시보드를 열 수 있습니다:

```bash
ocx status
ocx gui
```

## 2. ChatGPT/Codex 로그인 사용

Codex가 이미 ChatGPT에 로그인되어 있다면 추가 설정은 없습니다. 로그인되어 있지 않을 때만
Codex의 일반 로그인 절차를 한 번 실행하세요:

```bash
codex login
```

그다음 실행 중인 프록시에 연결된 Codex를 시작합니다:

```bash
ocx codex
```

`gpt-5.6-sol` 같은 네임스페이스 없는 모델 ID는 내장 ChatGPT 포워드 경로를 사용합니다.
카탈로그 항목만으로 권한이 생기지는 않으므로 계정에도 해당 모델 접근 권한이 있어야 합니다.

## 어떤 자격 증명을 요구하나요?

| 자격 증명 | 필요한 경우 | 의미 |
| --- | --- | --- |
| **ChatGPT/Codex 로그인** | 기본 로컬 `openai` 경로 | `codex login` 또는 Codex 앱이 만든 계정 세션입니다. API 키가 아닙니다. |
| **업스트림 프로바이더 자격 증명** | 다른 프로바이더를 직접 추가한 경우에만 | 해당 프로바이더의 API 키 또는 OAuth/계정 로그인입니다. 로컬 프로바이더는 보통 둘 다 필요 없습니다. |
| **OpenCodex 접근 키** | 비루프백/LAN 바인드에 연결하는 데이터 플레인 클라이언트 | `ocx host enable --new-key --yes`가 생성하며 `/v1/*`를 보호합니다. 프로바이더 결제 키가 아니며 `localhost`에서는 필요 없습니다. |

클라이언트에 **`opencodex API key required`**가 표시되면 비루프백 리스너에 OpenCodex 접근 키
없이 연결한 것입니다. `localhost`를 사용하거나 생성된 접근 키를 해당 클라이언트에 설정하세요.
프로바이더 API 키를 구매하거나 붙여넣어도 이 메시지는 해결되지 않습니다.

## 3. 다른 프로바이더 추가(선택 사항)

가장 간단한 방법은 `ocx gui`의 **Add provider**입니다. 계정 로그인, API 키, 로컬 서버 또는
사용자 지정 엔드포인트를 선택할 수 있습니다. 새 구성을 터미널에서 바꾸려는 경우에만 실행하세요:

```bash
ocx init
```

**Select default provider**에서 <kbd>Enter</kbd>를 누르면 프로바이더 **1**인
**OpenAI — ChatGPT login (no key)**가 선택됩니다. 선택한 경로에 실제로 필요한 정보만 묻습니다:

1. **ChatGPT 포워드** — API 키가 필요 없으며 Codex 로그인을 사용합니다.
2. **계정 로그인(OAuth)** — 저장 후 표시된 `ocx login <provider>`를 실행합니다.
3. **API 키 프로바이더** — 해당 업스트림 프로바이더의 키 또는 `${ANTHROPIC_API_KEY}` 같은
   환경 변수 참조를 입력합니다.
4. **로컬 프로바이더** — 보통 키를 비워 둡니다.
5. **프록시와 Codex 연동** — 포트, 주입, 선택적 자동 시작 shim을 고릅니다.

결과는 `$OPENCODEX_HOME/config.json`(기본값 `~/.opencodex/config.json`)에 저장됩니다.

:::note[GPT-5.6 배포 준비 항목]
안정화 버전 v2.7.1은 ChatGPT 패스스루, OpenAI API 키, OpenRouter, 실험 단계의 Cursor
adapter에 GPT-5.6 Sol/Terra/Luna 항목을 제공합니다. 실제 호출에는 해당 업스트림 계정의
사용 권한이 필요합니다.
:::

특정 라우팅 모델은 Codex 모델 선택기에 표시되는 `provider/model` 형식으로 지정합니다:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## Sub-agent 모델 선택(선택 사항)

새 구성에는 `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini`가
Codex의 sub-agent 선택기에 표시됩니다. `ocx gui`에서 네이티브 또는 라우팅 모델을 최대 다섯 개까지
바꾸거나 순서를 조정할 수 있습니다.

## 선택적 프로바이더 계정 로그인

일부 프로바이더는 OAuth 계정 로그인을 지원합니다:

```bash
ocx login xai          # 또는 anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

기본 OpenAI 경로는 **프로바이더 키가 필요 없으며** 기존 `codex login` 자격 증명을 전달합니다.
자세한 내용은 [프로바이더](/ko/guides/providers/)를 참고하세요.

## 중지 및 복원

```bash
ocx stop          # 프록시를 중지하고 네이티브 Codex 복원
ocx restore       # 프록시는 둔 채 네이티브 Codex 복원(별칭: ocx eject)
ocx restore back  # 실행 중인 프록시로 Codex를 다시 연결
```

## 다음

- [작동 방식](/ko/getting-started/how-it-works/) — 각 요청에 무슨 일이 일어나는지.
- [프로바이더](/ko/guides/providers/) — 인증하는 모든 방법.
- [구성](/ko/reference/configuration/) — 전체 `config.json` 레퍼런스.
