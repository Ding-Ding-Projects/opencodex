# 040 — wp4: access / api-key CLI 명령

work-phase: `wp4` · 선행: `010` · 후속: 050

## 왜 별도 단계인가

`access`는 다른 래퍼와 달리 **관리 평면과 데이터 평면을 함께** 부른다. 또한 평문 API 키를
한 번만 반환하는 경로가 있어 출력 규약을 잘못 옮기면 자격증명이 사라지거나 로그에 남는다.

## 오라클

`src/cli/access.ts`. 기본 서브명령은 `key`.

| 서브명령(별칭) | 요청 |
| --- | --- |
| `key`/`keys` `list`(기본) | `GET /api/keys` |
| `key create [name=default]` | `POST /api/keys` 본문 `{name}` |
| `key remove`/`delete <id> --yes` | `DELETE /api/keys` 본문 `{id}` |
| `endpoints` | `GET /api/keys` 후 키 필터링 |
| `models` | `GET /v1/models` (데이터 평면) |
| `test <model> --protocol` | 프로토콜별 데이터 평면 POST |

`ocx api-key ...`는 `ocx access key ...`의 별칭이다.

### 출력 규약 (정확히 옮길 것)

- `key list` 텍스트 줄: `<id>  <name>  <prefix>`; 비면 `No API access keys configured.`
- `key create` 텍스트 두 줄:
  - `Created API key <name> (<id>).`
  - `Key (shown once): <key>` — **평문 키는 이 한 번만 노출된다.** 이 줄을 로그·디버그
    출력에 재사용하지 말 것.
- `endpoints`는 `GET /api/keys` 응답에서 키 이름이 `Endpoint`로 끝나거나 `baseUrl`,
  `endpoint`인 항목만 남긴다.
- `models` 텍스트 줄: `<id>  <owned_by>`를 우측 트림

### `test` 프로토콜 사상

| `--protocol` | 경로 | 본문 |
| --- | --- | --- |
| `chat`(기본) | `/v1/chat/completions` | `{model, messages:[{role:"user",content:"Reply with OK."}], max_tokens:16, stream:false}` |
| `responses` | `/v1/responses` | `{model, input:"Reply with OK.", max_output_tokens:16}` |
| `messages` | `/v1/messages` | `{model, messages:[...], max_tokens:16}` |

그 외 값은 `--protocol must be chat, responses, or messages`.

## Go 백엔드

전부 존재한다: `/api/keys`(`management/api_keys.go:15`), 데이터 평면 4종
(`server/server.go:376`). 서버 변경 없음.

## 변경 지도

| 파일 | 동작 |
| --- | --- |
| `go/internal/cli/access.go` (신규) | `runAccess` + 4개 서브명령 |
| `go/internal/cli/cli.go` | `access` 등록, `api-key` 별칭 |
| `go/internal/cli/help.go` | 루트 도움말 줄 |

## 수용 기준

| # | 기준 | 활성화 시나리오 | 증거 |
| --- | --- | --- | --- |
| 1 | `key create`가 평문 키를 정확한 문구로 1회 출력 | 스텁이 `{"id":"k1","name":"n","key":"SECRET"}` 반환 | stdout에 `Key (shown once): SECRET` 정확히 1회 |
| 2 | `key remove`가 `--yes` 없이 거부 | `access key remove k1` | `remove requires --yes`, DELETE 미전송 |
| 3 | `key remove`가 id 없이 거부 | `access key remove --yes` | `key id is required` |
| 4 | `endpoints` 필터가 정확 | 스텁이 `{"baseUrl":"u","chatEndpoint":"c","keys":[]}` 반환 | 출력에 `keys` 부재, `baseUrl`·`chatEndpoint` 존재 |
| 5 | 프로토콜별 본문·경로가 표와 일치 | 세 프로토콜 각각 실행 | 기록된 (경로, 본문) 일치 |
| 6 | 잘못된 프로토콜 거부 | `--protocol grpc` | 정확한 오류 문자열, 요청 미전송 |
| 7 | `api-key` 별칭이 `access key`로 사상 | `ocx api-key list` | `GET /api/keys` 1회 |

## 프라이버시 경계

`bun run privacy:scan`은 자격증명 로깅을 금지한다. Go 구현도 동일 규칙을 따른다:
평문 키는 stdout에만 쓰고, 오류 경로·디버그 로그·요청 로그에 절대 넣지 않는다.
테스트는 stderr에 `SECRET`이 나타나지 않음을 단언한다.

## 스코프 경계

IN: `go/internal/cli/access.go` 및 등록. OUT: 관리·데이터 평면 서버 변경, `src/**`.
