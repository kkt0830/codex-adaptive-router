# Codex Adaptive Model Router

Codex 환경 조사에 기반한 Adaptive Router v0.2입니다. **한 요청을 분류해 `codex exec`로 실행하고, 관측된 검증 결과와 실패 원인에 따라 제한적인 재시도 또는 모델 승격을 결정**합니다. 현재 열려 있는 Codex Desktop 대화의 모델을 변경하지 않습니다.

## 바로 사용하기

Node.js 20 이상과 설치된 `codex` CLI가 필요합니다. 추가 npm 패키지는 없습니다.

```powershell
node src/cli.js dry-run "README의 오타 하나 수정해줘."
node src/cli.js dry-run --json "사용자 프로필 API endpoint를 추가하고 테스트를 작성해줘."
node src/cli.js dry-run --simulate-failure "syntax error" "README의 오타 하나 수정해줘."
node src/cli.js explain "간헐적인 concurrency bug 원인을 찾아줘."
node src/cli.js dry-run --tier advanced "이 작업을 분석해줘."
node src/cli.js run --cwd C:\path\to\repository "README의 오타 하나 수정해줘."
node src/cli.js run --interactive --cwd C:\path\to\repository "로그인 문제의 원인을 찾아 수정해줘."
```

`run`은 새 Codex 세션을 시작하며 기본 sandbox는 `workspace-write`입니다. 읽기만 시킬 때는 `--sandbox read-only`를 지정합니다. 실행 결과는 `logs/runs.jsonl`에 JSONL로 기록합니다. `--model`과 `--reasoning`은 직접 지정할 수 있고, 모델 ID와 effort는 로컬 Codex 모델 캐시가 있을 때 검사합니다. 캐시 부재나 서버 측 권한 변경은 실행 시 Codex가 최종 판단합니다. `dry-run`은 모델을 호출하지 않으며 `--simulate-failure TEXT`로 실패 분류·복구 정책만 미리 볼 수 있습니다.

Windows에서 npm으로 설치한 Codex는 `codex.ps1`/`codex.cmd`를 제공할 수 있습니다. Router는 PATH의 npm `.cmd` 진입점을 찾아 Node.js로 직접 실행하며, `.exe`도 그대로 실행합니다. 셸을 거치지 않으므로 요청·모델 설정이 명령 문자열로 해석되지 않습니다. PATH에 여러 Codex 설치본이 있거나 자동 탐색이 실패하면 `run --codex "C:\path\to\codex.cmd"` 또는 `.exe` 경로를 지정할 수 있습니다. PowerShell에서는 `cd /d` 대신 `Set-Location -LiteralPath '저장소 경로'`를 사용합니다. `spawn codex ENOENT`가 나왔다면 이 버전으로 업데이트한 뒤 다시 실행하세요.

터미널에서 `run --interactive`를 쓰면 작업 중 `/switch light`, `/switch standard`, `/switch advanced`를 입력할 수 있습니다. Router가 실행을 중단하고 제안 모델·effort를 보여주며 `y` 승인을 요청합니다. **수동 전환**을 승인하면 기존 세션 ID로 `codex exec resume`합니다. 거절하면 기존 모델로 재개합니다. **실패에 따른 자동 승격 제안**은 승인 후 새 Codex 세션을 시작하고 압축된 진단 정보를 넘깁니다. 거절하면 미완료로 종료합니다. `s`는 중단 상태로 남기며 `/stop`은 즉시 종료합니다. 이는 **터미널 승인 UI**이며 Codex Desktop 내부 팝업은 아닙니다. 비대화형 `run`은 동일 모델 재시도까지 자동 수행하지만, 모델 승격이 필요하면 제안만 기록하고 멈춥니다. 중단은 실행 상태를 메모리에서 정지했다가 복원하는 기능이 아닙니다.

## 조사 결과

최초 환경 조사(2026-09-26)에서 `codex --version`은 **codex-cli 0.155.0-alpha.16.4**였고, 로컬 모델 캐시의 client version은 `0.155.0`, 수집 시각은 2026-09-26T04:05:29Z였습니다. v0.2 작업 시 설치 CLI는 **0.158.0-alpha.2.1**이었습니다. 아래 지원 범위는 최초 조사 결과와 v0.2 실행 경로를 구분해 읽어야 합니다.

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

Node.js를 선택한 이유는 현재 설치된 Node 24를 그대로 사용할 수 있고, 프로세스 실행과 JSONL 이벤트 파싱을 표준 라이브러리만으로 처리할 수 있기 때문입니다. 정책값은 `config.json`에 있고, 분류 규칙은 `src/router.js`에 있습니다. 이유와 0~4 차원 평가는 사람이 검토할 수 있는 **휴리스틱 신호**이며, 정확한 난이도 측정이나 성공 확률이 아닙니다. 단순 합산 대신 규칙을 사용합니다. 문구·오타 변경만 LIGHT, 파일을 읽고 요약하는 요청과 일반 구현은 STANDARD, 고위험·불명확 원인·설계 신호가 함께 있으면 ADVANCED로 보냅니다. 파일 수만 많아서는 ADVANCED를 선택하지 않습니다. 애매한 경우 STANDARD가 기본값입니다.

현재 구성은 LIGHT=`gpt-6-luna/low`, STANDARD=`gpt-6-sol/medium`, ADVANCED=`gpt-6-astra/high`입니다. [공식 모델 가이드](https://developers.openai.com/api/docs/guides/latest-model)는 같은 세 모델을 작업의 추론 요구량, 지연, 비용에 따라 고르도록 안내합니다. 이 계층은 API의 토큰 단가와 Codex 구독 사용량이 동일하다는 뜻이 아닙니다. 계정별 가용성과 실제 사용량은 실행 이벤트로 확인해야 합니다.

## v0.2: Validation, Failure Classification, Recovery

`src/recovery.js`가 결과를 `SUCCESS`, `FAILURE`, `UNCERTAIN`으로 분류합니다. Codex turn 또는 프로세스 오류와 실패한 명령을 우선 반영합니다. 마지막으로 실행된 test/build/lint 명령이 성공하면 해당 검증 항목의 이전 실패는 수정된 것으로 봅니다. 기록된 검증 명령 없이 Codex가 0으로 종료하면 `UNCERTAIN`이며 성공으로 단정하지 않습니다. 검증 명령의 통과도 작업 전체의 의미상 정확성을 증명하지는 않습니다.

실패는 `CODE_ERROR`, `CONTEXT_INSUFFICIENT`, `REASONING_INSUFFICIENT`, `ENVIRONMENT_ERROR`, `DEPENDENCY_ERROR`, `PERMISSION_ERROR`, `TEST_FAILURE`, `ARCHITECTURE_PROBLEM`, `UNKNOWN`으로 분류합니다. 명령 결과·오류 문구에 대한 설명 가능한 규칙을 사용하며 신뢰도는 보정된 확률이 아니라 규칙의 보수적인 표기입니다. 권한·환경·의존성 문제는 승격하지 않습니다. 코드·테스트 오류는 동일 모델에서 한 번 재시도하고, 컨텍스트 부족은 관련 interface·인접 모듈·설정·테스트를 좁게 확인하도록 지시한 후 같은 모델로 재시도합니다. 추론·아키텍처 문제는 신뢰도 기준을 충족할 때 다음 계층으로만 승격을 제안합니다. 원인 불명은 한 번만 재시도하며 맹목적으로 승격하지 않습니다.

`config.json`의 `recovery`에서 전략과 한도를 조정합니다. 기본값은 계층별 재시도 **1회**, 승격 **2회**, 전체 시도 **4회**, 직접 승격 신뢰도 기준 **0.75**입니다. 한도에 닿거나 ADVANCED가 실패하면 멈춥니다. 승격은 `run --interactive`에서 사용자 승인이 필요합니다. 승인 시 이전 대화 전체를 다시 전달하지 않도록 **새 세션**을 시작하며, 원래 요청·이전 계층·관측된 파일·실행 명령·오류·검증 결과·남은 문제를 짧게 인계합니다. 관측하지 못한 변경 사항은 추측하지 않고 새 세션에 `git diff`를 확인하도록 지시합니다. 동일 모델 재시도와 수동 모델 전환은 기존 세션을 이어받습니다.

로그는 `taskId` 아래 시도별 번호, 모델·effort, 검증 상태, 실패 분류·신뢰도, 복구 결정, 실제 승격 전후 계층, 소요 시간과 Codex가 제공한 실제 usage를 기록합니다. usage가 없으면 추정하지 않습니다. 로그에는 요청과 진단 내용이 들어갈 수 있으므로 `logs/`는 Git에서 제외합니다.

### 현재 제한

결과 판정은 관측된 CLI 이벤트에 의존합니다. 모델의 자연어 주장만으로 성공을 인정하지 않고, 단순한 문구 탐지로 모든 실패를 정확하게 분류할 수는 없습니다. 이 버전은 필요한 파일을 Router가 자동 수집해 전달하지 않으며, 컨텍스트 확장은 **동일 모델에 범위를 좁혀 탐색하도록 지시**하는 방식입니다. 비대화형 실행에서는 승격 승인을 받을 수 없어 제안 후 멈춥니다. Codex Desktop의 현재 채팅 모델을 바꾸지 않으며, 본격적인 작업 분해·병렬 오케스트레이션은 v0.3 범위입니다.

## 검증

`npm test`는 분류·선택, 수동 전환, v0.2의 실패 사례 A–G, 동일 모델 재시도, 새 세션 handoff, 성공·실패·불확실 판정 및 시도 한도를 검사합니다. 실제 Codex CLI 실행에서는 read-only sandbox의 임시 로그 쓰기 실패를 `PERMISSION_ERROR`로 분류하고 승격 없이 중단했으며, workspace-write sandbox에서 실행한 `npm test`는 32개 모두 통과하여 Validator가 `SUCCESS`를 기록했습니다. v0.2의 새 세션 handoff 자체는 모의 실행 테스트로 검증했습니다.
