# 045 — wp4b: `config` 명령 파리티

work-phase: `wp4b` · 선행: `010` · 감사 블로커 B1에서 생성 · 순서 정본: `006`

## 왜 이 문서가 뒤늦게 생겼나

`002`는 `config`를 "Go에 등록되어 있으므로 루트 도움말 한 줄만 빠졌다"로 분류했다.
감사에서 **틀린 분류**로 밝혀졌다. 등록되어 있다는 것과 파리티는 다르다.

## 오라클 표면

```
ocx config [show] [--json] [--source]
ocx config get <dot.path> [--json]
ocx config set <dot.path> <json-or-string> [--json]
ocx config unset <dot.path> [--json]
ocx config validate [path|-] [--json]
ocx config export <path|->
ocx config import <path|-> --yes [--json]
```

### Go에 없는 것

| 기능 | TS | Go |
| --- | --- | --- |
| 임의 점 경로 `get`/`set`/`unset` | 지원 | 고정 키 몇 개만 |
| `--source` 진단 | 지원 | 없음 |
| `validate <path\|->` | 파일·stdin 검증 | 인자 없는 형태만 |
| `export <path\|->` | 지원 | **없음** |
| `import <path\|-> --yes` | 지원 | **없음** |

### 보안 규칙 (반드시 이식)

1. **비밀 마스킹.** `SECRET_KEYS = /^(apiKey|key|accessToken|refreshToken|idToken|token|
   password|clientSecret)$/i`에 매칭되는 키의 문자열 값은 `********`로 대체한다. 단
   **빈 문자열은 그대로 둔다**(빈 값을 마스킹하면 "설정됨"으로 오인된다).
   재귀적으로 배열·객체 전체에 적용된다.
2. **프로토타입 오염 차단.** `BLOCKED_SEGMENTS = {__proto__, prototype, constructor}`.
   점 경로에 이 세그먼트가 있으면 거부한다. Go에는 프로토타입 개념이 없지만, 같은
   세그먼트를 거부해 오라클과 동작을 맞추고 설정 파일에 이상한 키가 생기지 않게 한다.
3. **`export`는 마스킹하지 않는다.** 백업 용도이므로 원본을 쓴다. 파일로 쓸 때 모드는
   **`0600`**이다. 이 권한을 놓치면 자격증명이 world-readable로 남는다.
4. **`import`는 `--yes` 없이는 거부**하고, 저장 전에 `validateConfigCandidate`를 통과해야 한다.
5. **`set`은 부모 경로를 만들지 않는다 (감사 2라운드 B1-new).** `setPath`
   (`src/cli/config-command.ts:42`)는 중간 세그먼트가 없거나 객체가 아니거나 배열이면
   `config parent path not found: <segment>`로 **거부**한다. 초기 초안은 "중첩 생성"이라고
   적었는데 이는 오라클과 정반대이며, Go가 TS CLI가 거부하는 설정을 만들어내는 새 파리티
   회귀가 된다.
   `unset`도 마찬가지로 리프가 없으면 `config path not found: <path>`로 거부한다.

### `show` vs `export`의 비대칭

`show`는 마스킹하고 `export`는 하지 않는다. 이는 의도된 설계다 — 화면 출력과 백업 파일의
목적이 다르다. Go에서 이 둘을 같은 직렬화 함수로 묶으면 안 된다.

## 변경 지도

| 파일 | 동작 |
| --- | --- |
| `go/internal/cli/config_command.go` | 점 경로 엔진, `--source`, `validate <path\|->`, `export`, `import` |
| `go/internal/cli/config_redact.go` (신규) | 재귀 마스킹, 차단 세그먼트 |
| `go/internal/cli/help.go` | `config` 서브토픽 도움말을 TS 사용법 문자열과 일치 |

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | `config get providers.foo.apiKey` | `********` 반환, 원문 미노출 |
| 2 | 빈 문자열 비밀 값 | 마스킹 없이 빈 문자열 |
| 3 | `config get providers.foo.__proto__.x` | 거부 |
| 4 | `a.b`가 **이미 객체로 존재**하는 상태에서 `config set a.b.c '{"d":1}'` | 값 갱신, 검증 통과 후 저장 |
| 4a | `a`가 없는 상태에서 `config set a.b.c 1` | `config parent path not found: a`, 파일 불변 |
| 4b | `a.b`가 배열 또는 스칼라인 상태 | 동일하게 거부 |
| 4c | 없는 리프에 `config unset a.b.zzz` | `config path not found: a.b.zzz` |
| 5 | 검증 실패하는 `set` | 저장 안 됨, 파일 불변 |
| 6 | `config validate -` (stdin JSON) | 유효/무효 판정, 무효 시 종료 코드 1 |
| 7 | `config export /tmp/x.json` | 파일 모드 **0600**, 내용 **마스킹 없음** |
| 8 | `config export -` | stdout으로 출력 |
| 9 | `config import x.json` (`--yes` 없이) | `import requires --yes`, 저장 안 됨 |
| 10 | `config import x.json --yes` (무효 JSON) | 거부, 기존 설정 불변 |
| 10a | `config import x.json --yes` (유효 JSON) | 설정이 **실제로 교체·저장**되고, 이어지는 `config show`가 새 값 반환 |
| 11 | `config show --source` | 소스 경로·오류·경고 포함 |

7번이 핵심이다: export가 마스킹하면 백업이 쓸모없어지고, 모드가 0600이 아니면 자격증명이
샌다. 두 가지를 **동시에** 단언한다.

## 스코프 경계

IN: 위 파일. OUT: 설정 스키마 자체(각 런타임 work-phase 소관), `src/**`.
