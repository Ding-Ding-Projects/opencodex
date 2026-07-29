# 020 — WP2: 업데이트 알림 배선

선행: WP1 (독립적이지만 같은 "배선 누락" 계열이고, WP1이 관리 API 층을 먼저 정리한다).
상태: 계획.

## 무엇이 깨져 있나

go 런타임으로 `ocx start`를 하는 사용자는 새 버전이 나와도 영원히 모른다. 오라클은
대화형 시작마다 업그레이드 프롬프트를 띄우는데, go는 그 경로가 통째로 없다.

`go/internal/update/notify.go`의 5개 export는 전 트리에서 자기 선언과 테스트 말고
호출자가 없다:

```
ReadVersionCache  WriteVersionCache  CacheStale  UpgradeVersion  DismissVersion
```

즉 캐시 원시요소는 이식됐고, 그것을 부르는 진입점만 없다.

## 오라클의 계약

`src/cli/index.ts:183`이 `maybeShowUpdatePrompt()`를 부르는데, **위치가 계약의 일부**다.
`src/update/notify.ts:219-224` 주석이 명시한다 — 포트 바인드/PID 기록 **전에** 불러야
한다. "지금 업데이트"를 고르면 전역 설치 후 프로세스가 종료되므로, 살아 있는 데몬이
자기 바이너리를 덮어쓰는 동안 포트를 쥐고 있으면 안 된다.

게이트는 `shouldConsider()` (`notify.ts:130`):

| 조건 | 의미 |
| --- | --- |
| `detectInstall() === "source"` → 중단 | 소스 체크아웃은 대상 아님 |
| 버전이 `?` 또는 소스빌드 → 중단 | 버전을 모르면 비교 불가 |
| `interactiveGuardOk()` 실패 → 중단 | 서비스/데몬/비TTY는 프롬프트 금지 |
| `hasStarPromptRun()` 거짓 → 중단 | 최초 실행에는 양보 |

### P 재검증에서 찾은 두 가지 부재 (2026-07-29)

구현 직전 트리를 다시 보고 계획을 두 군데 고쳤다.

**1. `hasStarPromptRun()`에 해당하는 것이 go에 없다.** 오라클은
`src/cli/star-prompt.ts:17`에서 설정 디렉터리의 마커 파일 존재로 판정한다. go에는 star
프롬프트 자체가 없으므로 마커도 없다. 이 게이트의 목적은 "설치 첫 실행에 프롬프트 두 개가
겹치지 않게 양보"인데, go에 겹칠 상대가 없다.

결정: 이 게이트를 **마커 부재로 대체하지 않는다**. go에 star 프롬프트가 없으므로 마커를
새로 만들면 아무도 쓰지 않는 파일이 생긴다. 대신 오라클의 의도(첫 실행 양보)를 유지하기
위해 **버전 캐시가 없으면 조용히 반환**하는 기존 동작에 기댄다 — 첫 실행에는 캐시가
없으므로 자연히 프롬프트가 뜨지 않는다. 이 대체를 D에 기록한다.

**2. 버전 캐시 경로 헬퍼가 go에 없다.** `notify.go`의 함수들은 전부 `path string`을
인자로 받고, 그 경로를 만들어주는 쪽이 없다(그래서 호출자가 0인 것이기도 하다).
오라클은 `versionFilePath()`(`notify.ts:29`) = `getConfigDir()/version.json`이다.

go에는 `configDir()`가 `go/internal/cli/serve.go:677`(`runtimePaths`)에서 이미 쓰인다.
그러므로 경로 조립은 **cli 패키지 쪽**에서 하고 `update` 패키지에는 완성된 경로를
넘긴다 — 기존 시그니처를 바꾸지 않는 방향이다.

**게이트 최종형** (go):

| 조건 | 판정 근거 |
| --- | --- |
| `OCX_SERVICE=1` | `os.Getenv` — `service/winsw.go:85`, `cli/system_restart.go:196`이 쓰는 그 값 |
| `--service` 플래그 | `runServe`가 이미 파싱해 같은 env를 설정(:61-63) |
| stdin/stdout이 TTY 아님 | 오라클 `interactiveGuardOk`(`notify.ts:121`)와 동일하게 **양쪽** 확인 |
| 버전이 개발 빌드 | `cli.Version`이 `0.1.0-dev`(`cli.go:16`) 형태면 중단 |
| 캐시 없음 | 첫 실행 양보를 겸한다(위 1번) |

표시할 버전은 `getUpgradeVersionForPopup()` (`notify.ts:140`): 캐시가 없거나, 최신이
현재보다 새롭지 않거나, 사용자가 그 버전을 이미 물렀으면 표시하지 않는다.

선택지는 3개다 — 1 지금 업데이트(설치 후 `process.exit(0)`), 2 건너뛰기(이번 실행만),
3 이 버전 다시 안 보기(`dismissVersion`). 빈 입력은 1로 간주한다.

## 변경 지도

### NEW `go/internal/update/prompt.go`

`MaybeShowUpdatePrompt(streams IO) ` — 오라클 `maybeShowUpdatePrompt`의 대응물.
**절대 에러를 반환하지 않는다**: 오라클이 전체를 try/catch로 감싸고 "never let the update
prompt disrupt startup"이라고 적은 것과 같은 계약이다. 모든 실패는 조용한 no-op이다.

구성:

1. `shouldConsider()` 대응 — 게이트 4개. TTY 판정은 `streams.In`이 터미널인지로 하고,
   설치 형태/버전 판정은 기존 `update.DefaultChannel`/`buildinfo` 경로를 재사용한다.
2. `ReadVersionCache(path, channel)` 호출.
3. `CacheStale(...)`이면 백그라운드 갱신을 띄운다. **프롬프트를 위해 기다리지 않는다** —
   오라클도 `triggerBackgroundRefreshIfStale`로 비동기다. 시작 지연은 회귀다.
4. `UpgradeVersion(cache, current, channel)`이 빈 문자열이면 조용히 반환.
5. 프롬프트 렌더 + 1줄 입력. 선택 3이면 `DismissVersion` 후 `WriteVersionCache`.
   선택 1이면 기존 설치 경로(`update.InstallCommand`, `job.go:75`)를 태우고 종료.

### MODIFY `go/internal/cli/serve.go`

**삽입 지점을 계획 중 정정했다.** 처음에는 `writeRuntimeFiles(actualPort)`(:184)
바로 앞으로 잡았다. `runServe`를 읽어보니 틀렸다 — go는 그보다 훨씬 앞인 **:159**에서
이미 `net.Listen`으로 포트를 잡는다:

```
:152-158  server.FindAvailablePortWithOptions  (포트 선택)
:159      net.Listen                            ← 여기서 이미 바인드된다
:184      writeRuntimeFiles(actualPort)         (PID 기록)
```

오라클의 계약은 "PID 전"이 아니라 "**바인드 전**"이다(`src/cli/index.ts:183`이
`chooseListenPort`보다 앞에 있다). :184에 넣으면 업데이트가 설치되는 동안 리스너가
포트를 쥐고 있게 되어, 정확히 오라클 주석이 막으려던 상태가 된다.

따라서 삽입 지점은 **포트 선택 앞, 즉 :152 이전**이다. B 단계에서 `preferredPort`
계산 직전 지점을 확정한다.

```go
+	// Interactive-only update prompt. Must run BEFORE we select a port and bind
+	// a listener: choosing "Update now" installs globally and exits, so a live
+	// process must never hold the port while it overwrites its own binary
+	// (oracle: src/cli/index.ts:183, src/update/notify.ts:219).
+	update.MaybeShowUpdatePrompt(streams)
+
 	preferredPort := cfg.Port
```

한 가지 더: `*serviceMode`가 `runServe` 안에서 이미 파싱되어 `OCX_SERVICE=1`을
설정한다(:61-63). 게이트는 이 플래그를 **직접** 봐야 한다 — TTY 판정만으로는 서비스
매니저가 터미널을 붙여준 경우를 거를 수 없다.

### NEW `go/internal/update/prompt_test.go`

게이트별 no-op과 발화 경로를 모두 덮는다. 비TTY에서 프롬프트가 뜨지 않는 것, 물린 버전이
표시되지 않는 것, 선택 3이 캐시에 기록되는 것.

## 수용 기준

1. 비TTY/서비스 실행에서 프롬프트가 뜨지 않고 시작이 지연되지 않는다.
2. 캐시에 새 버전이 있고 TTY면 프롬프트가 뜬다.
3. 선택 3 후 같은 버전으로 재실행하면 뜨지 않는다.
4. 업데이트 경로 실패가 `ocx start`를 죽이지 않는다.
5. 프롬프트는 **포트 바인드(`net.Listen`, :159) 전**에 발생한다. PID 기록 전만으로는
   부족하다.

### 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

이 유닛은 조건 분기 덩어리라 "테스트 통과"로는 부족하다. 각 게이트를 실제로 발화시킨다:
임시 홈에 `latest_version`이 현재보다 높은 캐시 픽스처를 심고 의사 TTY로 `serve`를 태워
프롬프트 문자열이 출력에 나오는 것을 **읽는다**. 이어서 같은 픽스처에 `dismissed_version`을
채우고 프롬프트가 사라지는 것을 확인한다. 두 관측은 서로의 대조군이다.

순서는 별도 증거가 필요하다: 프롬프트가 뜬 시점에 해당 포트가 아직 **열려 있지 않음**을
확인한다(PID 파일 부재만으로는 바인드 여부를 알 수 없다).

## 검증

```
cd go && go build ./... && go vet ./... && go test ./internal/update/ ./internal/cli/ -count=1
```

## 위험

시작 경로를 건드리므로 회귀 범위가 넓다. 프롬프트가 실수로 비대화형에서 발화하면
서비스 실행이 stdin을 기다리며 멈춘다 — 이것이 이 유닛의 최악 시나리오다. 그래서
게이트 테스트를 발화 테스트보다 먼저 쓴다.
