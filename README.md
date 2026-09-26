# Codex Adaptive Model Router

2026-09-26 기준 Phase 1 조사와 Phase 2 MVP입니다. **한 요청을 분류하고, 현재 Codex CLI에서 확인한 모델 ID와 reasoning effort로 새 `codex exec` 작업을 시작**합니다. 현재 열려 있는 Codex Desktop 대화의 모델을 자동 변경하지 않습니다.

## 바로 사용하기

Node.js 20 이상과 설치된 `codex` CLI가 필요합니다. 추가 npm 패키지는 없습니다.

```powershell
node src/cli.js dry-run "README의 오타 하나 수정해줘."
node src/cli.js dry-run --json "사용자 프로필 API endpoint를 추가하고 테스트를 작성해줘."
node src/cli.js explain "간헐적인 concurrency bug 원인을 찾아줘."
node src/cli.js dry-run --tier advanced "이 작업을 분석해줘."
node src/cli.js run --cwd C:\path\to\repository "README의 오타 하나 수정해줘."
node src/cli.js run --interactive --cwd C:\path\to\repository "로그인 문제의 원인을 찾아 수정해줘."
```

`run`은 새 Codex 세션을 시작하며 기본 sandbox는 `workspace-write`입니다. 읽기만 시킬 때는 `--sandbox read-only`를 지정합니다. 실행 결과는 `logs/runs.jsonl`에 JSONL로 기록합니다. `--model`과 `--reasoning`은 직접 지정할 수 있고, 모델 ID와 effort는 로컬 Codex 모델 캐시가 있을 때 검사합니다. 캐시 부재나 서버 측 권한 변경은 실행 시 Codex가 최종 판단합니다. `dry-run`은 모델을 호출하지 않습니다.

터미널에서 `run --interactive`를 쓰면 작업 중 `/switch light`, `/switch standard`, `/switch advanced`를 입력할 수 있습니다. Router가 현재 Codex 실행을 중단하고 제안 모델·effort를 보여주며 `y` 승인을 요청합니다. 승인하면 같은 세션 ID를 새 모델로 `codex exec resume`하고, 거절하면 기존 모델로 재개합니다. `s`는 중단 상태로 남기며 `/stop`은 즉시 종료합니다. 이것은 **터미널 승인 UI**이며 Codex Desktop 내부의 팝업은 아닙니다. 중단은 정확한 실행 상태를 메모리에서 정지했다가 복원하는 기능이 아니므로, 재개 turn에 원래 작업과 현재 파일 상태를 확인하도록 지시합니다. 전환 시 기존 세션의 대화 이력이 함께 전달될 수 있어 토큰 절감량은 보장되지 않습니다.

## 조사 결과

이 컴퓨터의 `codex --version`은 **codex-cli 0.155.0-alpha.16.4**였고, 로컬 모델 캐시의 client version은 `0.155.0`, 수집 시각은 2026-09-26T04:05:29Z였습니다. 버전 접미부는 설치 바이너리 출력값을 우선합니다.

| 질문 | 확인 결과 |
| --- | --- |
| CLI/명령 단위 모델 지정 | `codex exec -m/--model` 지원. 설치 CLI 도움말과 [공식 비대화형 문서](https://developers.openai.com/codex/noninteractive) 확인. |
| reasoning effort | `-c model_reasoning_effort="medium"` 형태의 설정 override 가능. [공식 설정 문서](https://developers.openai.com/codex/config-basic) 확인. |
| 세션 내부 모델 변경 | App Server `turn/start`에서 turn마다 `model`, `effort` override 가능. `turn/steer`는 해당 override를 받지 않음. 따라서 진행 중인 단일 turn의 임의 교체는 현재 구현 대상이 아님. [App Server 문서](https://developers.openai.com/codex/app-server) 확인. |
| subagent의 다른 모델 | 명시적 spawn 설정이나 custom agent TOML의 `model`, `model_reasoning_effort`로 가능. [Subagents 문서](https://developers.openai.com/codex/subagents) 확인. |
| Skill 자체의 모델 변경 | `SKILL.md`는 선택 시 읽는 지침 및 선택적 스크립트의 진입점. 자동 모델 전환 API가 아님. 모델 선택은 CLI/App Server/SDK 또는 agent 설정에서 처리해야 함. [Skills 문서](https://developers.openai.com/codex/skills) 확인. |
| CLI/SDK/API 별도 실행 | CLI 비대화형 실행 가능. TypeScript/Python [Codex SDK](https://developers.openai.com/codex/sdk)와 [App Server](https://developers.openai.com/codex/app-server)도 공식 경로. Responses API는 별도 제품 경로이므로 계정 권한·과금 체계를 혼동하지 말아야 함. |
| 비대화형 및 사용량 | `codex exec --json`의 `turn.completed.usage`에 실제 입력/캐시/출력 토큰이 제공될 수 있음. 값이 없으면 이 도구는 `null`을 기록하며 추정하지 않음. [공식 예시](https://developers.openai.com/codex/noninteractive) 확인. App Server도 `thread/tokenUsage/updated` 제공. |
| 모델 ID 확인 | 로컬 모델 캐시에서 `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra` 및 각각의 effort를 확인. [공식 모델 목록](https://developers.openai.com/api/docs/models)에도 같은 ID가 명시됨. 캐시는 실시간 서버 권한 보증이 아님. |

캐시에 함께 보인 ID는 `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-reserve`, `codex-auto-review`입니다. 마지막 두 개는 일반 작업용 3계층에 배정하지 않았습니다. 정확한 계정별 목록은 [App Server `model/list`](https://developers.openai.com/codex/app-server) 응답이 공식적인 조회 경로이며, 이 MVP는 로컬 캐시를 검증 힌트로만 사용합니다. 로컬 캐시에서 3개 GPT-6 모델의 지원 effort는 Astra/Sol이 `low, medium, high, xhigh, max, ultra`, Luna가 `low, medium, high, xhigh, max`였습니다.

완전 구현 가능한 범위는 **새 Codex 실행의 사전 분류·모델 선택·effort 지정·dry run·선택 근거·CLI JSON 이벤트의 실제 usage 기록**입니다. 간접 구현 범위는 별도 Codex 세션 또는 App Server turn을 사용한 작업별 모델 전환과 subagent 배정입니다. 제한되는 범위는 Desktop의 이미 진행 중인 turn을 Skill이 강제로 바꾸는 것, Codex 내부 서비스가 실제 사용한 다른 모델을 외부 Router가 항상 보증하는 것, 모든 실패를 자동으로 정확히 판정하는 것입니다. App Server에는 `model/rerouted` 이벤트가 있어 후자는 향후 별도 관측 대상으로 삼을 수 있습니다.

## 구조와 정책

```text
사용자 요청 → 로컬 규칙 분석 → 최소 충분 계층 선택 → dry-run 또는 새 Codex exec
                                          ↓
                           CLI 이벤트에서 사용량·성공 기록
```

Node.js를 선택한 이유는 현재 설치된 Node 24를 그대로 사용할 수 있고, 프로세스 실행과 JSONL 이벤트 파싱을 표준 라이브러리만으로 처리할 수 있기 때문입니다. 정책값은 `config.json`에 있고, 분류 규칙은 `src/router.js`에 있습니다. 이유와 0~4 차원 평가는 사람이 검토할 수 있는 **휴리스틱 신호**이며, 정확한 난이도 측정이나 성공 확률이 아닙니다. 단순 합산 대신 규칙을 사용합니다. 문구·오타 변경만 LIGHT, 일반 구현은 STANDARD, 고위험·불명확 원인·설계 신호가 함께 있으면 ADVANCED로 보냅니다. 파일 수만 많아서는 ADVANCED를 선택하지 않습니다. 애매한 경우 STANDARD가 기본값입니다.

현재 구성은 LIGHT=`gpt-6-luna/low`, STANDARD=`gpt-6-sol/medium`, ADVANCED=`gpt-6-astra/high`입니다. [공식 모델 가이드](https://developers.openai.com/api/docs/guides/latest-model)는 같은 세 모델을 작업의 추론 요구량, 지연, 비용에 따라 고르도록 안내합니다. 이 계층은 API의 토큰 단가와 Codex 구독 사용량이 동일하다는 뜻이 아닙니다. 계정별 가용성과 실제 사용량은 실행 이벤트로 확인해야 합니다.

## 다음 단계의 경계

Phase 3의 **단일 작업 실행**과 사용자 주도 **중단·승인·모델 변경**은 구현했습니다. 완료 코드와 `turn.completed` 이벤트를 기록하지만, 작업 결과의 의미상 정확성까지 판정하지 않습니다. Phase 4의 자동 실패 감지·escalation과 Phase 5의 decomposition은 꺼져 있습니다. 다음 단계에서는 테스트 명령이나 결과 스키마를 작업별로 지정하고, 환경 오류와 추론 부족을 구분한 뒤 압축된 진단 정보를 다음 모델에 전달해야 합니다. decomposition은 의존성과 충돌을 다루는 작업 계획이 필요하여 단순 텍스트 분할로 구현하지 않았습니다.

## 검증

`npm test`는 요청문에 제시된 5개 사례의 분류·선택·이유와 override, 파일 범위 규칙, 승인·거절 후 같은 세션 재개를 검사합니다. 총 11개 테스트가 통과했습니다. `dry-run`에서 LIGHT, `gpt-6-luna`, `low`, 모든 차원 0을 확인했습니다. 실제 CLI에서도 Luna의 `run`이 성공했습니다. 이어 `run --interactive`에서 진행 중 `/switch standard`로 중단하고 `y`로 승인한 뒤 **동일한 세션 ID로 Sol을 실행해 작업을 완료**했습니다. 중단된 첫 시도와 성공한 재개 시도가 각각 로그에 기록되고, 제공된 실제 토큰 사용량만 기록되는 것도 확인했습니다.
