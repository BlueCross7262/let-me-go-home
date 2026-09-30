---
name: req-interview
description: Run a seven-item requirements interview in one call - scope with the user in the main session, the other six auto-approved by one fork - and return the deep-interview spec paths to the caller; --scope-only runs the scope item alone, --verbatim-blocks passes named draft blocks verbatim in unattended runs
argument-hint: "[--slug <slug>] [--context <path>] [--no-fork] [--unattended [--verbatim-blocks]] [--scope-only] [--name-prefix <label>] <goal text | spec file path>"
user-invocable: true
---

이 스킬은 `let-me-go-home:deep-interview` 를 일곱 항목으로 순서대로 돌린다.
`scope` 항목은 메인 세션이 사용자에게 묻는다.
나머지 여섯 항목은 fork 하나가 `--auto-approve` 로 돌린다.
spec 은 deep-interview 가 정한 위치에 그대로 남는다.
이 스킬은 그 경로만 호출자에게 돌려준다.

# 목차

- 입출력 계약
- 실행 변수
- 항목 순서와 질의 모드
- 항목당 4단계
- 실행 브리지 억제
- 항목 사이 턴 규율
- 스킬 파일 위치 찾기
- Step 0 — 인자 해석과 준비
- Step 1 — scope 인터뷰
- Step 2 — 여섯 항목 인터뷰
- Step 3 — scope 재인터뷰
- Step 4 — 반환
- 자기 점검

# 입출력 계약

## 입력

| 인자 | 형식 | 부재 시 |
|---|---|---|
| 위치 인자 | 목표 텍스트 또는 spec 파일 경로 | 멈추고 호출법을 안내한다 |
| `--slug <slug>` | deep-interview slug 의 앞자리 | 목표에서 소문자 하이픈 슬러그를 만든다 |
| `--context <절대경로>` | 코드 조사 요약 파일 | 조사 요약 없이 돈다 |
| `--no-fork` | 여섯 항목을 메인이 돈다 | fork 하나가 돈다 |
| `--unattended` | 일곱 항목 모두 사용자에게 묻지 않고 근거로만 확정하거나 정지한다 | 지금과 같은 경로로 돈다 |
| `--verbatim-blocks` | `goal` 의 이름 붙은 블록을 요약하지 않고 원문으로 일곱 항목에 싣는다. `--unattended` 와 함께만 받는다 | `goal` 본문 요약만 싣는다 |
| `--scope-only` | `scope` 항목과 그 재인터뷰만 돈다. 여섯 항목은 돌지 않는다 | 일곱 항목을 돈다 |
| `--name-prefix <label>` | fork 이름과 deep-interview 탐색 에이전트 이름의 접두 | 지금 이름을 쓴다 |

- 해석 규칙은 deep-interview 와 같다.
  플래그를 먼저 떼어 낸다.
  남은 텍스트 전체를 위치 인자로 삼는다.
- `--slug`·`--context`·`--name-prefix` 의 값은 공백 없는 토큰 하나다.
- 위치 인자가 존재하는 파일 경로면 그 파일 내용이 출발점이다.
  그 밖에는 위치 인자 텍스트 자체가 출발점이다.
- 플래그 짝 규칙.
  - `--verbatim-blocks` 가 `--unattended` 없이 오면 멈춘다.
    사유는 `args:verbatim-without-unattended` 다.
  - `--scope-only` 가 `--unattended` 와 함께 오면 멈춘다.
    사유는 `args:scope-only-unattended` 다.
    `--scope-only` 는 사용자에게 `scope` 를 묻는 사전 세션용이기 때문이다.

## 출력

- 마지막 메시지에 아래 줄을 낸다.
  호출자는 이 줄만 읽는다.

```
REQ_INTERVIEW_STATUS=COMPLETE|STOPPED(<item-key>:<reason>)
REQ_INTERVIEW_STOP_EVIDENCE=<spec absolute path or none>
REQ_INTERVIEW_SPEC_scope=<absolute path>
REQ_INTERVIEW_SPEC_functional=<absolute path>
REQ_INTERVIEW_SPEC_data=<absolute path>
REQ_INTERVIEW_SPEC_ui=<absolute path>
REQ_INTERVIEW_SPEC_edge=<absolute path>
REQ_INTERVIEW_SPEC_techconstraint=<absolute path>
REQ_INTERVIEW_SPEC_nonfunctional=<absolute path>
REQ_INTERVIEW_SPEC_scope-2=<absolute path>
```

- `scope-N` 줄은 `scope` 재인터뷰가 돈 회차만큼 낸다.
- `scope_only` 면 `REQ_INTERVIEW_STATUS`·`REQ_INTERVIEW_SPEC_scope`·`scope-N` 줄만 낸다.
  여섯 항목의 경로 줄을 내지 않는다.
- `STOPPED` 면 그때까지 끝난 항목의 줄만 낸다.
  인자·준비 단계에서 멈추면 `<item-key>` 자리에 `args` 를 쓴다.
  `--name-prefix` 실행에서 fork 이름 파일이 없어 멈추면 `<item-key>` 자리에 `fork` 를 쓴다.
  `--name-prefix` 실행에서 감사가 transcript 를 찾지 못해 멈추면
  `STOPPED(fork:fork-audit-unavailable)` 다.
  감사 fail 로 멈추면 `STOPPED(<item-key>:fork-audit)` 다.
  항목별 실패 사유는 `<slug>.fork-audit.r<n>.json` 에 있다.
- `REQ_INTERVIEW_STOP_EVIDENCE` 줄은 `--unattended` 실행에서만 낸다.
  `--unattended` 가 아닌 실행은 이 줄을 내지 않는다 — 기존 출력 그대로다.
  `--unattended` 실행이 `STOPPED` 로 끝나면 그 항목 spec 의 절대경로를,
  `COMPLETE` 로 끝나거나 spec 의 `Status` 가 `STOPPED` 가 아닌 사유로 멈추면
  `none` 을 낸다.
- 경로는 deep-interview 가 쓴 상대경로를 현재 작업 디렉토리 기준 절대경로로 바꿔
  낸다.
- spec 파일은 `.lmgh/specs/deep-interview-<slug>-<항목키>.md` 에 있다.
  이 스킬은 spec 을 옮기거나 합치지 않는다.
- fork 경로의 부산물은 `.lmgh/req-interview/` 아래 둘이다.
  결과 파일 `<slug>.result.md` 와 진행 로그 `<slug>.progress.log` 다.
- `--name-prefix` 가 있으면 메인은 fork 이름 파일 `<slug>.fork-name` 도 같은 곳에 쓴다.
  감사 결과 `<slug>.fork-audit.r<n>.json` 과, `--verbatim-blocks` 면 블록 파일
  `<slug>.verbatim-blocks.md` 도 같은 곳에 쓴다.

## 호출자 계약

- 이 스킬은 요구 문서를 쓰지 않는다.
  spec 을 합쳐 문서로 만드는 일은 호출자 몫이다.
- 이 스킬은 코드 조사를 하지 않는다.
  조사 결과가 있으면 호출자가 `--context` 로 넘긴다.
- 같은 `slug` 로 다시 부르면 앞 실행의 spec 은 `.bak` 으로 밀려난다.
  실행마다 고유한 `slug` 를 넘긴다.

# 실행 변수

| 이름 | 확정 시점 | 원천 |
|---|---|---|
| `goal` | Step 0 | 위치 인자 텍스트, 또는 그 경로 파일의 내용 |
| `goal_path` | Step 0 | 위치 인자가 존재하는 파일 경로면 그 절대경로, 아니면 `null` |
| `slug` | Step 0 | `--slug`, 없으면 `goal` 에서 만든 슬러그 |
| `context_path` | Step 0 | `--context`, 없으면 `null` |
| `use_fork` | Step 0 | `--no-fork` 가 있으면 `false`, 없으면 `true` |
| `unattended` | Step 0 | `--unattended` 토큰의 유무 |
| `verbatim_blocks` | Step 0 | `--verbatim-blocks` 토큰의 유무 |
| `scope_only` | Step 0 | `--scope-only` 토큰의 유무 |
| `session_id` | Step 0 | 환경 변수 `CLAUDE_CODE_SESSION_ID`, 없으면 `LMGH_SESSION_ID` |
| `skill_file` | Step 0 | 【｜스킬 파일 위치 찾기】 |
| `work_dir` | Step 0 | 현재 작업 디렉토리 아래 `.lmgh/req-interview` 절대경로 |
| `result_path` | Step 0 | `<work_dir>/<slug>.result.md` |
| `progress_path` | Step 0 | `<work_dir>/<slug>.progress.log` |
| `name_prefix` | Step 0 | `--name-prefix` 값, 없으면 `null` |
| `fork_hex4` | Step 0 | `name_prefix` 가 있으면 새로 만든 4자리 소문자 hex, 없으면 `null` |
| `fork_name` | Step 0 | `name_prefix` 가 있으면 `<name_prefix>-auto-interview-<fork_hex4>`, 없으면 `auto-interview-<slug>` |
| `fork_name_path` | Step 0 | `name_prefix` 가 있으면 `<work_dir>/<slug>.fork-name`, 없으면 `null` |
| `audit_script` | Step 0 | `name_prefix` 가 있으면 `skill_file` 의 세 단계 위 폴더(플러그인 루트) 아래 `scripts/req-interview-fork-audit.mjs`, 없으면 `null` |
| `blocks_path` | Step 0 | `name_prefix` 가 있고 `verbatim_blocks` 면 `<work_dir>/<slug>.verbatim-blocks.md`, 아니면 `null` |
| `spec_paths` | 항목마다 | 항목키에서 spec 절대경로로 가는 표 |

- 변수는 확정 시점 뒤에만 읽는다.
  확정 뒤에는 바꾸지 않는다.
  `spec_paths` 는 항목이 끝날 때마다 한 행씩 더한다.
- `interview_id`·`spec_path`·`Status` 는 deep-interview 소유 이름이다.
  원문 그대로 쓴다.

# 항목 순서와 질의 모드

순서를 고정한다.
항목을 돌리는 주체는 앞 항목의 확정 결과를 뒤 항목에 기결정으로 주입한다.

| 순서 | 섹션 | 항목키 | 질의 모드 |
|---|---|---|---|
| 1 | §2 목적 및 범위 | `scope` | 사용자 질의 |
| 2 | §3 기능 요구사항 | `functional` | 권장안 자동 확정 |
| 3 | §4 데이터 요구사항 | `data` | 권장안 자동 확정 |
| 4 | §5 UI/UX 및 사용자 동작 | `ui` | 권장안 자동 확정 |
| 5 | §6 예외 및 경계조건 | `edge` | 권장안 자동 확정 |
| 6 | §7 기술 제약 및 구현 조건 | `techconstraint` | 권장안 자동 확정 |
| 7 | §10 비기능 요구사항 및 변경 영향 | `nonfunctional` | 권장안 자동 확정 |

- `scope` 만 여섯 항목 뒤 「추가 목적 확인」으로 N회 반복할 수 있다.
  회차 상한을 두지 않는다.
  나머지 여섯은 항목당 정확히 1회다.
- 어느 경로든 병렬은 성립하지 않는다.
  한 에이전트가 deep-interview 를 동시에 두 번 실행할 수 없다.
  뒤 항목이 앞 항목 확정값을 받는다.

## 질의 모드의 뜻

위 표의 `질의 모드` 컬럼이 단일 소스다.

- `사용자 질의` — `scope` 항목뿐이다.
  그 항목이 던지는 질문은 전부 사용자에게 묻는다.
  재인터뷰 회차(`scope-2`·`scope-3` …)도 같다.
  `unattended` 면 `scope` 도 이 표를 벗어나 `--unattended` 로 돈다 —
  아래 【｜`--unattended` 일 때】 참조.
- `권장안 자동 확정` — 나머지 여섯 항목이다.
  그 항목은 deep-interview 를 `--auto-approve` 플래그로 부른다.
  그 플래그가 근거 있는 질문을 권장안으로 확정한다.
  근거 없는 질문만 사용자에게 묻는다.
  Round 0 topology 확인 질문도 그 플래그의 대상이다.
  `unattended` 면 `--auto-approve` 대신 `--unattended` 로 부른다.
- 판정 사다리·근거 출처·권장안 선택 기준은 deep-interview 의
  `Auto-Approve Mode (--auto-approve)` 절이 소유한다.
  항목을 돌리는 주체는 deep-interview 질문에 따로 답을 고르지 않는다.
  `unattended` 면 근거 없는 질문에서 deep-interview 가 묻지 않고 정지하는 규칙은
  그 절의 `Unattended Mode (--unattended)` 절이 소유한다.
  - 조사 요약과 앞 항목 확정값은 호출 인자로 넘기므로 그 절의 근거 출처 중 호출
    인자에 해당한다.

## `--unattended` 일 때

- `scope` 를 포함한 일곱 항목 전부 `--unattended` 로 deep-interview 를 부른다.
  `scope` 도 사용자에게 묻지 않는다.
- 위임 프롬프트는 일곱 항목 모두 【｜질의 기록】의 `권장안 자동 확정` 항목 리터럴을
  쓴다.
  `scope` 도 이 리터럴을 쓰고 `사용자 질의` 항목 리터럴은 쓰지 않는다.
- 위치 인자 spec 파일(`goal`)의 본문 요약을 일곱 항목의 호출 인자에 모두 싣는다.
  deep-interview 자동 확정의 첫 근거 출처가 호출 인자이기 때문이다.
- Step 3 `scope` 재인터뷰는 돌지 않는다.
- Phase 5 실행 브리지 질문은 이 절의 대상이 아니다.
  【｜실행 브리지 억제】가 우선한다.

## `--verbatim-blocks` 일 때

- `unattended` 이고 `goal` 이 spec 파일일 때만 쓴다.
- 아래 블록은 요약하지 않고 원문 그대로 일곱 항목 호출 인자에 싣는다.
  - `## 2.` 절 전체.
  - `## 7.` 절 안의 `### 판단 기본값` 소제목부터 다음 `### ` 또는 `## ` 직전까지.
  - `## 7.` 절 안의 `### Phase 컴포넌트` 소제목부터 다음 `### ` 또는 `## ` 직전까지.
  - `## 8.` 절 전체.
- 블록 원문은 대화 기억이 아니라 `goal_path` 파일에서 그 자리에서 복사한다.
  auto-compaction 이 대화 속 `goal` 을 요약해도 원문이 바뀌지 않게 하기 위해서다.
  fork 도 같은 파일에서 복사한다(【｜`use_fork` 가 `true` 일 때 — 위임 프롬프트】).
- (`name_prefix` 일 때) 블록 원문은 `goal_path` 가 아니라 `blocks_path` 파일에서 가져온다.
  그 파일 내용 전체를 호출 인자에 한 글자도 바꾸지 않고 넣는다.
  요약·참조 문장으로 바꾸지 않는다.
  【｜감사 — 호출 인자 대조】가 호출 인자와 그 파일을 대조한다.
- 블록 헤딩이 `goal` 에 없으면 그 블록을 빼고 진행한다.
- 원문으로 실은 블록을 뺀 나머지 본문은 지금처럼 요약해서 싣는다.
- 항목 spec 마다 `## Metadata` 절에 `Verbatim Blocks: <실은 블록 목록>` 한 줄을 남긴다.
  목록에는 그 항목의 deep-interview 호출 인자에 원문을 실제로 복사해 넣은 블록만 적는다.
  싣지 않은 블록을 적지 않는다.
  목록 표기는 `§2`·`§7 판단 기본값`·`§7 Phase 컴포넌트`·`§8` 이고 `, ` 로 잇는다.
  실은 블록이 없으면 `Verbatim Blocks: none` 이다.
  호출자가 이 줄로 어느 블록이 근거로 쓰였는지 확인한다.

## `--scope-only` 일 때

- Step 1 과 Step 3 만 돈다.
  Step 2 를 돌지 않는다.
- `scope` 의 질의 모드는 `사용자 질의` 다.
- 사후 검증의 `Answer Mode` 기대값은 `scope` 와 재인터뷰 회차 모두 `user` 다.
- Step 4 는 【｜입출력 계약】의 `scope_only` 출력 줄만 낸다.
- 호출자가 여러 Phase 의 `scope` 를 한 세션에서 차례로 묻는 용도다.
  상태 격리·실행 브리지 억제·질의 기록 규칙은 그대로 적용한다.
  호출마다 고유한 `--slug` 를 넘긴다.

## 질의 기록

- 항목이 던진 질문은 전부 spec 에 `## 질의 기록` 절로 남긴다.
  질문·후보·확정값·근거 4열 표를 한 행씩 채운다.
- 절 이름은 질의 모드와 무관하게 `## 질의 기록` 하나다.
  두 모드의 차이는 근거 열 값으로만 드러난다.
- 후보 열에는 그 질문에서 제시한 옵션 라벨을 전부 `/` 로 나열한다.
  free-text 도 하나로 센다.
  옵션 없이 던진 질문은 `후보 없음` 으로 적는다.
  - deep-interview 는 옵션을 만들지만 spec 에 남기지 않는다.
    그래서 이 기록이 선택되지 않은 안을 보존하는 유일한 자리다.
- 확정값은 선택된 라벨과 같은 문자열로 적는다.
- 사용자에게 물은 질문은 근거 열에 `사용자 질의 — 근거 부재` 를 적는다.

`권장안 자동 확정` 항목은 `args` 맨 앞에 `--auto-approve` 를 두고
(`unattended` 면 `--unattended` 를 둔다),
위임 프롬프트에 아래를 그대로 넣는다.

```
이 항목은 자동 확정 플래그로 호출됐다. 질문을 확정하는 규칙은 그 플래그의 정의를 따르라.
이 항목이 던진 질문은 전부 spec 에 `## 질의 기록` 절로 질문·후보·확정값·근거 4열 표로
남겨라. 후보 열에는 그 질문에서 제시한 옵션 라벨을 전부 `/` 로 나열하고(free-text 포함),
확정값에는 그중 선택한 라벨을 같은 문자열로 적어라. 옵션 없이 던진 질문은 `후보 없음`
이라고 적어라. 사용자에게 물은 질문은 근거 열에 `사용자 질의 — 근거 부재` 라고 적어라.
「바꾸지 않는다」를 권장안으로 낼 때는 그것이 요구를 충족하는 근거를 함께 적어라 —
변경 회피 자체는 근거가 아니다.
```

`사용자 질의` 항목(`scope`)의 위임 프롬프트에 아래를 그대로 넣는다.

```
이 항목의 질문은 전부 사용자에게 물어라. 권장안이 있어도 자동으로 선택하지 마라.
이 항목이 던진 질문도 전부 spec 에 `## 질의 기록` 절로 질문·후보·확정값·근거 4열 표로
남겨라. 후보 열에는 그 질문에서 제시한 옵션 라벨을 전부 `/` 로 나열하고(free-text 포함),
확정값에는 사용자가 고른 라벨을 같은 문자열로 적어라. 옵션 없이 던진 질문은 `후보 없음`
이라고 적어라. 근거 열에는 `사용자 질의 — 근거 부재` 라고 적어라.
```

# 항목당 4단계

어느 단계든 실패하면 다음 항목으로 진행하지 않고 멈춘다(fail-closed).
멈춘 항목키와 사유는 【｜Step 4 — 반환】의 `STOPPED(<item-key>:<reason>)` 로 낸다.

## 사전 — 상태 격리

- 격리 대상은 두 경로다.
  - 세션 경로 — `state_read(mode="deep-interview", session_id=<session_id>)` 가
    돌려주는 `Path` 또는 `Expected path` 값이다.
    기본값은 `.lmgh/state/sessions/<session_id>/deep-interview-state.json` 이다.
  - 레거시 경로 — 세션 경로의 `state` 디렉토리 바로 아래
    `deep-interview-state.json` 이다.
    기본값은 `.lmgh/state/deep-interview-state.json` 이다.
  - 경로는 도구 출력에서 정한다.
    상태 디렉토리 산식을 손으로 조립하지 않는다.
- 파일이 있는 경로마다 그 파일을 같은 디렉토리의 `<slug>-<항목키>.bak` 로 옮긴다.
  남기면 다음 호출이 앞 인터뷰를 이어받는다.
- 이번 항목의 spec 경로 `.lmgh/specs/deep-interview-<slug>-<항목키>.md` 에 파일이
  이미 있으면 같은 이름 뒤에 `.bak` 을 붙여 옮긴다.
  앞 실행이 남긴 spec 을 이번 결과로 오인하지 않기 위해서다.
- 옮긴 뒤 세 경로 모두 파일이 없는지 아래 명령으로 확인한다.
  `state_read` 는 세션 경로만 읽으므로 이 확인을 대신하지 못한다.

```
node -e "for (const p of process.argv.slice(1)) console.log(require('fs').existsSync(p) + ' ' + p)" <세션 경로> <레거시 경로> <spec 경로>
```

- 이동 실패는 fail-closed 다.
  세 경로 중 하나라도 파일이 남아 있으면 진행하지 않는다.

## 호출

`Skill("let-me-go-home:deep-interview", args: "...")` 에 아래를 넣는다.

- 이 항목의 스코프 정의 — 무엇을 묻고 무엇을 묻지 않는지를 정한다.
  위 순서 표의 섹션으로 쓴다.
- 앞 항목들의 확정 결과.
  주체 자신의 대화에 이미 있어도 명시로 넣는다.
  긴 실행 중 auto-compaction 이 앞 항목 대화를 요약할 수 있다.
  그래서 명시 주입이 compaction 내성을 갖는 주 경로다.
  `context_path` 가 있으면 그 파일 요약도 이 자리에 넣는다.
  `techconstraint` 항목에서 비중이 가장 크다.
  `unattended` 면 `goal` 의 본문 요약도 일곱 항목 전부의 이 자리에 넣는다.
  `verbatim_blocks` 면 【｜`--verbatim-blocks` 일 때】의 블록은 요약하지 않고 원문으로 넣는다.
- 경계 지시 — 이 항목만 다루고 다른 항목의 결정은 닫힌 것으로 받으라는 명시다.
- 【｜실행 브리지 억제】 지시.
- 이 항목의 질의 모드 — 순서 표의 값과 【｜항목 순서와 질의 모드】의 해당 코드블록.
  `scope` 항목도 생략하지 않는다.
  `권장안 자동 확정` 항목은 `args` 맨 앞에 `--auto-approve` 를 둔다.
  `scope` 에는 그 플래그를 두지 않는다.
  `unattended` 면 일곱 항목 모두 `args` 맨 앞에 `--auto-approve` 대신
  `--unattended` 를 둔다.
- `name_prefix` 가 있으면 `args` 에 `--name-prefix <name_prefix>` 를 둔다.
- slug 는 `<slug>-<항목키>` 로 지정한다.
  `scope` 재인터뷰 회차는 `<slug>-scope-2`·`<slug>-scope-3` 이다.
  - (`name_prefix` 일 때) `args` 첫 줄에 `--slug <slug>-<항목키>` 토큰으로 넣는다.
    【｜감사 — 호출 인자 대조】가 첫 줄에서 slug 를 읽는다.
    감사는 `--slug=X`·`slug=X` 도 받지만, 첫 줄 밖에 쓴 slug 는 읽지 않는다.
- deep-interview 가 `state_write` 로 상태를 쓸 때 두 가지를 지킨다.
  - `session_id` 를 매번 넘긴다.
    빼면 도구가 레거시 공유 경로에 쓴다.
  - 유지할 필드 전부를 매번 함께 넘긴다.
    `state_write` 는 병합하지 않고 상태 파일을 통째로 바꾼다.

## 사후 — 검증

- spec 의 `## Metadata` 절에서 읽은 `interview_id` 가 직전 항목 spec 과 다른가.
  같으면 상태 격리가 실패해 앞 인터뷰를 이어받은 것이다.
- `spec_path` 가 이번 slug 의 경로를 가리키는가.
- Round 0 이 잠근 topology 가 이 항목 범위 안인가.
  벗어났으면 `경계 확장 필요` 사유로 멈춘다.
- `Status` 가 `PASSED` 인가.
  `unattended` 면 `STOPPED` 도 있을 수 있다 — 아래 【｜Step 4 — 반환】의
  `unattended` 처리를 따른다.
- `## Metadata` 절의 `Answer Mode` 가 `scope` 는 `user`, 나머지 여섯은
  `auto-approve` 인가.
  `unattended` 면 일곱 항목 모두 `unattended` 를 기대한다.
  이 값을 읽는 곳이 req-interview 뿐이라 다른 파일은 고치지 않는다.
- `## Metadata` 절에 `Auto-Approved Questions` 줄이 `<정수>/<정수>` 형식으로 있는가.
- spec 에 `## 질의 기록` 절이 있고, 던진 질문이 전부 행으로 있고, 각 행의 후보
  열이 채워졌는가.
  - 없거나 비었으면 그 항목을 돌린 주체가 그 자리에서 채운 뒤 진행한다.
    기록 누락이지 인터뷰 실패가 아니다.
  - 인터뷰를 직접 본 쪽만 후보 열을 채울 수 있다.
    spec transcript 에는 옵션이 없다.
- 앞 항목 spec 이 `.lmgh/specs/` 에 남아 있으므로 deep-interview 의 브라운필드 탐색이
  그 spec 을 맥락으로 읽을 수 있다.
  앞 항목 확정값을 어차피 주입하므로 막지 않는다.
  위 topology 확인이 범위 이탈을 잡는다.

## 사후 — 경로 기록

- spec 경로를 현재 작업 디렉토리 기준 절대경로로 바꿔 `spec_paths` 에 한 행 더한다.
- spec 을 옮기지 않는다.

# 실행 브리지 억제

deep-interview 는 spec 작성 직후 Phase 5 에서 실행 경로 선택(`Execute with Ralph` ·
`Continue Interview` · `Save Spec and Stop`)을 `AskUserQuestion` 으로 묻는다.
`--auto-approve` 는 그 질문을 던지지 않지만 `scope` 는 플래그 없이 돈다.
위임 프롬프트에 아래를 항상 넣는다.

```
인터뷰가 끝나 spec 이 pending approval 로 표시되면 Phase 5(실행 브리지)
AskUserQuestion 을 던지지 마라 — spec 파일 작성과 상태 기록까지만 하고 멈춰라.
```

- 빠뜨리면 `scope` 에서 그 질문이 떠서 순차 진행이 막힌다.
- 사용자가 잘못 고르면 미완성 단일 항목 spec 만으로 별도 파이프라인이 기동된다.
- 권장안 자동 확정은 이 질문에 적용되지 않는다 — 이 절이 우선한다.
  첫 옵션이 `Execute with Ralph (Recommended)` 라 자동 확정하면 ralph 가 기동된다.

# 항목 사이 턴 규율

항목과 항목 사이에 진행 보고만 내고 턴을 끝내지 않는다.
진행 표·남은 단계 예고·전체 로드맵 재확인은 그 자체로 완결된 사용자 보고다.
그래서 그 자리에서 턴이 끝나고 다음 항목이 사용자 입력을 기다리게 된다.

- 이 규율은 항목을 돌리는 주체에 걸린다.
  `use_fork` 가 `true` 면 fork, `false` 면 메인이다.
- fork 는 여섯 항목을 끝내거나 fail-closed 로 멈출 때만 턴을 끝낸다.
  fork 는 이음새 줄을 내지 않는다.
  진행은 진행 로그로 알린다.
- `use_fork` 가 `false` 인 메인은 항목 사이에 아래 한 줄만 낸다.
  그 줄과 다음 항목의 deep-interview 호출을 같은 턴에 둔다.

```
req-interview 진행 — §<n> 완료 (<k>/7), §<m> 로 이어간다
```

- `use_fork` 가 `true` 인 메인은 fork 스폰 직전에 아래 한 줄만 낸다.

```
req-interview 대기 — 자동 확정 인터뷰
```

- 진행 상황을 종합해 보고하는 자리는 【｜Step 4 — 반환】 하나다.
- 이 규율은 fail-closed 중단에는 적용하지 않는다.
  그 중단은 보고하고 멈추는 것이 정상 동작이다.

# 스킬 파일 위치 찾기

fork 는 이 파일을 다시 읽는다.
그래서 메인은 이 파일의 절대경로를 Step 0 에서 `skill_file` 로 정한다.

- 이 스킬을 불러올 때 알려진 기준 디렉토리가 있으면 그 아래 `SKILL.md` 다.
- 없으면 `$CLAUDE_PLUGIN_ROOT/skills/req-interview/SKILL.md` 를 확인한다.
- `CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을
  가리킨다.
  그 플러그인이 항상 이 플러그인은 아니다.
  그 경로에 파일이 없으면 `.claude-plugin/plugin.json` 의 `"name"` 이
  `"let-me-go-home"` 인 디렉토리를 찾는다.
  그 아래 `skills/req-interview/SKILL.md` 를 쓴다.
- 그 디렉토리로 `cd` 하지 않는다.
  cwd 가 바뀌면 spec 과 상태 파일이 엉뚱한 저장소에 쓰인다.

# Step 0 — 인자 해석과 준비

- 【｜입출력 계약】의 해석 규칙으로 인자를 나눈다.
- 위치 인자가 비었으면 멈춘다.
  호출법 한 줄과 `REQ_INTERVIEW_STATUS=STOPPED(args:no-goal)` 를 낸다.
- `goal` 을 정한다.
  위치 인자가 존재하는 파일 경로면 그 파일 내용이다.
- `slug` 를 정한다.
  `--slug` 가 없으면 `goal` 을 한 줄로 가리키는 소문자 하이픈 슬러그를 만든다.
- `context_path` 가 주어졌는데 파일이 없으면 멈춘다.
  사유는 `args:context-missing` 이다.
- `session_id` 를 아래 명령으로 읽는다.
  빈 값이면 멈춘다.
  사유는 `args:no-session-id` 다.
  상태 격리가 세션 경로를 전제하기 때문이다.

```
node -e "console.log(process.env.CLAUDE_CODE_SESSION_ID || process.env.LMGH_SESSION_ID || '')"
```

- `name_prefix`·`fork_hex4`·`fork_name` 을 정한다.
  `fork_hex4` 는 이 호출에서 한 번만 만든다.
- `skill_file` 을 【｜스킬 파일 위치 찾기】로 정한다.
- `work_dir` 디렉토리를 만든다.

```
node -e "require('fs').mkdirSync(process.argv[1], { recursive: true })" <work_dir>
```

- (`name_prefix` 일 때) `audit_script` 를 정한다.
  `skill_file` 은 `<플러그인 루트>/skills/req-interview/SKILL.md` 다.
  그 파일이 없으면 멈춘다.
  사유는 `args:audit-script-missing` 이다.
- (`name_prefix` 이고 `verbatim_blocks` 일 때) Step 1 전에 블록 파일을 만든다.
  `scope` 호출이 이 파일을 먼저 쓰기 때문이다.

```
node <audit_script> --goal <goal_path> --emit-blocks <blocks_path>
```

# Step 1 — scope 인터뷰

- 메인이 `scope` 항목을 【｜항목당 4단계】로 돈다.
- 질의 모드는 `사용자 질의` 다.
  `unattended` 면 `--unattended` 로 돈다 — 【｜`--unattended` 일 때】 참조.
- 끝나면 `spec_paths` 에 `scope` 행이 생긴다.
- (`name_prefix` 이고 `verbatim_blocks` 일 때) Step 2 로 가기 전에 scope 호출만 감사한다.
  - 명령은 【｜감사 — 호출 인자 대조】와 같다.
    `--keys` 를 비우고 `--fork-name` 을 주지 않고 `--scope-slug <slug>-scope` 를 준다.
  - stdout 한 줄을 `<work_dir>/<slug>.fork-audit.scope-pre.r<n>.json` 에 쓴다.
    `n` 은 1 부터 센다.
    이 파일은 최종 감사의 `fork-audit.r<n>.json` 과 따로 센다.
  - 종료 상태 0 이면 Step 2 로 간다.
  - 종료 상태 1 이면 `blocks_path` 에서 블록을 다시 옮겨 scope 를 1회 다시 부른다.
    다시 부를 때 slug 는 같은 `<slug>-scope` 다.
    재인터뷰 회차(`scope-2`)가 아니다.
    【｜항목당 4단계】의 상태 격리가 앞 spec 을 `.bak` 으로 옮긴다.
    그 뒤 이 감사를 한 번 더 돈다.
  - 두 번째도 종료 상태 1 이면 `REQ_INTERVIEW_STATUS=STOPPED(scope:fork-audit)` 로 멈춘다.
    `REQ_INTERVIEW_STOP_EVIDENCE` 는 마지막 `scope-pre` 파일이다.
  - 종료 상태 3 이면 【｜감사 — 호출 인자 대조】의 exit 3 규칙을 따른다.
  - 근거 — scope 는 메인 호출이라 최종 감사의 재요청 대상이 아니다.
    fork 를 띄우기 전에 scope 의 복사 오류를 잡으면 fork 여섯 항목을 헛돌리지 않는다.

# Step 2 — 여섯 항목 인터뷰

`scope_only` 면 이 Step 을 돌지 않고 Step 3 으로 간다.

`functional → data → ui → edge → techconstraint → nonfunctional` 순서로 돈다.
모두 `--auto-approve` 로 부른다.
`unattended` 면 모두 `--unattended` 로 부른다.

## `use_fork` 가 `false` 일 때

- 메인이 여섯 항목을 한 번에 하나씩 【｜항목당 4단계】로 돈다.
- 항목 사이에는 【｜항목 사이 턴 규율】의 진행 줄 하나를 낸다.
- (`name_prefix` 일 때) 여섯 항목을 끝내거나 어느 항목에서 멈춘 직후 【｜감사 — 호출 인자 대조】를 돈다.
  `--fork-name` 을 주지 않아 main transcript 를 본다.
  재요청 대상이 없으므로 감사 fail 은 곧바로 그 항목의 `fail` 이다.

## `use_fork` 가 `true` 일 때 — 스폰

이 절의 스폰·수신 검증·정지는 메인 몫이다.
fork 는 이 절을 따르지 않는다.

- 스폰 직전에 【｜항목 사이 턴 규율】의 대기 줄을 낸다.
- `name_prefix` 가 있으면 스폰 직전에 `fork_name` 한 줄을 `fork_name_path` 에 통째로 새로 쓴다.
  `name_prefix` 가 없으면 이 파일을 쓰지 않는다.
  진행 로그에는 쓰지 않는다.
  진행 로그는 fork 가 쓰고 `Monitor` 가 읽는다.
  auto-compaction 이 `fork_name` 을 대화에서 지워도 뒤의 재요청·재개·정지가 이 파일에서 이름을 되찾는다.

```
node -e "require('fs').writeFileSync(process.argv[1], process.argv[2] + '\n')" <fork_name_path> <fork_name>
```

- `Agent(subagent_type: "fork", name: "<fork_name>")` 를 1회 부른다.
  위임 프롬프트는 아래 【｜Step 2 — 여섯 항목 인터뷰｜`use_fork` 가 `true` 일 때 — 위임 프롬프트】의
  리터럴을 싣고 `<...>` 만 채운다.
  `<verbatim_blocks 실행일 때만 …>` 로 시작하는 줄은 지시 줄이다.
  그 줄 자체는 싣지 않고, `verbatim_blocks` 가 참일 때만 그 아래 세 줄을 싣는다.
  그래서 `--verbatim-blocks` 가 없는 호출의 위임 프롬프트는 지금과 같다.
  `<name_prefix 가 …>` 로 시작하는 줄도 지시 줄이다.
  그 줄 자체는 싣지 않고, `name_prefix` 가 있을 때만 그 지시를 따른다.
  그래서 `name_prefix` 가 없는 호출의 위임 프롬프트는 0.0.32 와 같다.
- 스폰과 같은 턴에 `Monitor` 를 건다.
  - `description` 에 `<fork_name>` 을 싣는다.
  - `timeout_ms` 는 `1800000` 이다.
  - 명령은 아래다.
    `<진행 로그>` 세 자리를 모두 `progress_path` 로 채운다.

```
n=0
while true; do
  total=$(wc -l < "<진행 로그>" 2> /dev/null || echo 0)
  if [ "$total" -gt "$n" ]; then
    sed -n "$((n+1)),${total}p" "<진행 로그>"
    if sed -n "$((n+1)),${total}p" "<진행 로그>" | grep -q -F "AUTO-INTERVIEW-END"; then break; fi
    n=$total
  fi
  sleep 2
done
```

- 방출을 변수에 담지 않는다.
  command substitution 이 후행 개행을 지워 줄 수가 모자라게 된다.
- 만료 고지를 받고 종료 줄이 아직 없으면 `Monitor` 를 다시 건다.
  다시 걸 때는 시작값 `n` 을 그 시점 진행 로그 줄 수로 둔다.
- 메인은 `Monitor` 알림 줄을 다시 내지 않는다.
- 스폰과 `Monitor` 를 건 뒤 메인 턴이 끝나는 것은 정상이다.
  메인은 fork 의 완료 알림이나 메시지를 받은 턴에서 이어간다.

## `use_fork` 가 `true` 일 때 — 위임 프롬프트

```
너는 req-interview 의 자동 확정 인터뷰 fork 다. 아래 여섯 항목만 이 순서로 돌린다.
functional → data → ui → edge → techconstraint → nonfunctional
고정값(메인 대화에 있어도 이 값을 쓴다):
- slug = <slug>
- session_id = <session_id>
- scope spec = <spec_paths 의 scope 절대경로>
- context = <context_path, 없으면 none>
- 진행 로그 = <progress_path>
- 결과 파일 = <result_path>
- 절차 파일 = <skill_file>
- item_flag = <--unattended 실행이면 --unattended, 아니면 --auto-approve>
<verbatim_blocks 실행일 때만 아래 세 줄을 싣는다. 아니면 세 줄 모두 싣지 않는다>
<name_prefix 가 있으면 둘째 줄을 「- 블록 파일 = <blocks_path>」 로, 셋째 줄을 「- 항목마다 절차 파일의 「`--verbatim-blocks` 일 때」도 따른다. 블록 파일 내용 전체를 호출 인자에 한 글자도 바꾸지 않고 넣는다. 요약하거나 참조 문장으로 바꾸지 않는다.」 로 바꿔 싣는다>
- verbatim_blocks = true
- 원천 draft = <goal_path>
- 항목마다 절차 파일의 「`--verbatim-blocks` 일 때」도 따른다. 블록 원문은 원천 draft 에서 그 자리에서 복사한다.
항목마다 절차 파일의 「항목당 4단계」「항목 순서와 질의 모드」「실행 브리지 억제」
「항목 사이 턴 규율」을 그대로 따른다. 그 파일을 다시 읽고 따른다. 그 파일의
Step 절은 메인 몫이라 따르지 않는다.
<name_prefix 가 있으면 아래 bullet 의 「`<item_flag>` 가 `--auto-approve` 면 … 정지한다.」 두 문장 대신 unattended 실행이면 「근거 없는 질문에서 묻지 않고 정지한다.」, 아니면 「근거 없는 질문은 사용자에게 묻는다.」 한 문장만 싣는다>
- 모든 항목을 `<item_flag>` 로 부른다. 자동 확정은 그 플래그의 판정 사다리만 한다.
  네가 deep-interview 질문에 따로 답을 고르지 않는다. `<item_flag>` 가 `--auto-approve`
  면 근거 없는 질문은 사용자에게 묻는다. `<item_flag>` 가 `--unattended` 면 근거 없는
  질문에서 묻지 않고 정지한다. 그 항목에서 멈추면 뒤 항목을 돌리지 않는다.
<name_prefix 가 있을 때만 아래 한 줄을 싣는다>
- 항목마다 deep-interview 를 `Skill` 로 부른다. spec 파일을 직접 쓰지 않는다. 메인이 네 transcript 의 `Skill` 호출 인자를 대조한다.
- deep-interview 가 explore 위임을 요구하면 서브에이전트를 띄우지 말고 네가 저장소를
  직접 조회한다. 조회한 경로·심볼을 spec 의 근거에 적는다.
- 앞 항목 확정값 주입의 원천은 scope spec, context, 그리고 네가 앞서 끝낸 spec 들이다.
- 여섯 항목을 끝내거나 fail-closed 로 멈출 때만 턴을 끝낸다. 항목 사이에 진행 보고
  텍스트만 내고 턴을 끝내지 않는다.
- 쓰는 파일은 진행 로그, 결과 파일, deep-interview 가 쓰는 `.lmgh/` 아래뿐이다. 그 밖의
  저장소 파일을 편집하지 않는다. 커밋하지 않는다.
진행 로그: 항목 시작·Skill 반환·검증 완료·멈춤마다 진행 로그에 한 줄씩 append 한다.
마지막 줄은 `AUTO-INTERVIEW-END status=<ok|stopped>` 다.
결과 파일: 항목마다 한 행(항목키 · Status · Answer Mode · interview_id · spec 절대경로 ·
사용자 질의 수 · 중단 사유)을 쓴다.
끝나면 SendMessage(to: "team-lead") 로 한 줄 요약과 결과 파일 경로를 보낸다. 턴을 텍스트로만
끝내는 것은 전달로 치지 않는다.
```

## `use_fork` 가 `true` 일 때 — 수신 검증

완료 알림을 받으면 아래 의사코드를 스크립트로 돌린다.

```
AUTO_KEYS = ["functional", "data", "ui", "edge", "techconstraint", "nonfunctional"]
UUID_RE = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"   # 대소문자 무시
spec(key) = <cwd>/.lmgh/specs/deep-interview-<slug>-<key>.md
if not exists(<result_path>): return "result-missing"
seen = {}                                   # Interview ID -> 항목키
for key, p in spec_paths:                   # 지금까지 끝난 scope 회차
    meta = metadata_section(p)              # "## Metadata" 절의 "- 키: 값" 줄만 읽는다
    add_id(seen, meta["Interview ID"], key)
for key in AUTO_KEYS:
    p = spec(key)
    if not exists(p): fail(key, "spec 없음"); continue
    meta = metadata_section(p)
    if unattended and meta["Status"] == "STOPPED": stop(key, "unattended", p); continue
    if meta["Status"] != "PASSED": fail(key, "Status")
    expected_mode = "unattended" if unattended else "auto-approve"
    if meta["Answer Mode"] != expected_mode: fail(key, "Answer Mode")
    if not match(r"^\d+/\d+$", meta["Auto-Approved Questions"]): fail(key, "Auto-Approved Questions")
    if "## 질의 기록" not in text(p) or has_empty_candidate(p): request_fill(key)
    add_id(seen, meta["Interview ID"], key)

add_id(seen, id, key):
    if id is empty: fail(key, "Interview ID 없음"); return
    if not match(UUID_RE, id): fail(key, "Interview ID 형식")
    if id in seen: fail(key, "Interview ID 중복 — " + seen[id]); return
    seen[id] = key
```

- `Status` 는 `## Metadata` 절에서만 읽는다.
  spec 끝의 `Status: pending approval` 줄과 섞지 않는다.
- 형식이 틀린 id 도 중복 대조에는 넣는다.
- 첫 `fail` 에서 멈추지 않는다.
  전 항목을 판정해 목록으로 보고한다.
- `stop` 은 `fail` 과 다르다.
  `stop` 을 만나면 그 즉시 나머지 항목 판정을 그치고
  【｜`use_fork` 가 `true` 일 때 — 실패 처리】의 `unattended` 정지 처리로 간다.
- 통과하면 여섯 항목의 spec 경로를 `spec_paths` 에 더한다.
- (`name_prefix` 일 때) 위 판정을 끝낸 직후, 정지 처리·통과 처리·실패 보고 어느 쪽보다
  먼저 【｜감사 — 호출 인자 대조】를 돈다.
  감사 결과가 그 뒤 경로를 바꿀 수 있다.

## 감사 — 호출 인자 대조

이 절은 `name_prefix` 가 있을 때만 돈다.
`name_prefix` 가 없으면 이 절을 돌지 않는다.
spec 메타데이터는 deep-interview 를 부르지 않아도 쓸 수 있다.
그래서 호출 사실과 인자를 transcript 에서 따로 대조한다.

- 입력을 정한다.
  - `keys` — 수신 검증이 판정한 항목이다.
    `stop` 이 났으면 그 항목까지다.
    재요청 뒤 회차면 `redo_from` 부터 끝 항목까지다.
  - `--fork-name` — `use_fork` 이고 fork 경로 회차면 `fork_name_path` 에서 읽은 이름이다.
    메인이 돈 항목의 회차면 주지 않는다.
  - `--scope-slug` — 이번 호출이 마지막으로 돈 `scope` 회차 slug 다.
    재요청 뒤 회차에는 주지 않는다.
  - `--item-flag` — `unattended` 면 `--unattended`, 아니면 `--auto-approve` 다.
  - `verbatim_blocks` 면 `--goal <goal_path> --verbatim` 을 더한다.
- 아래 명령을 돌린다.
  stdout 한 줄을 `<work_dir>/<slug>.fork-audit.r<n>.json` 에 쓴다.
  `n` 은 이 호출 안의 감사 회차이고 1 부터 센다.

```
node <audit_script> --session <session_id> --slug <slug> --item-flag <flag> --keys <쉼표 목록> [--fork-name <name>] [--scope-slug <slug>] [--goal <goal_path> --verbatim]
```

- 종료 상태로 판정한다.
  출력 문구로 판정하지 않는다.
  - 0 — 수신 검증 결과대로 간다.
  - 3 — transcript 를 찾지 못했다.
    `unattended` 면 fork 와 `Monitor` 를 멈추고
    `REQ_INTERVIEW_STATUS=STOPPED(fork:fork-audit-unavailable)` 를 낸다.
    `unattended` 가 아니면 보고에 경고 한 줄을 남기고 수신 검증 결과대로 간다.
  - 1 — JSON 의 `fails` 로 아래를 판정한다.
- `fails` 에 `scope` 가 있으면 재요청하지 않는다.
  `fail(scope, "fork-audit:<reason>")` 로 기록한다.
  메인이 부른 호출이라 fork 재요청 대상이 아니다.
- fork 항목만 fail 이면 `redo_from` 을 정한다.
  fail 항목 가운데 순서 표에서 가장 앞 항목이다.
  수신 검증이 `stop` 을 낸 항목이 fail 이면 그 정지를 믿지 않고 같은 규칙을 탄다.
  spec 을 호출 없이 썼을 수 있기 때문이다.
- 첫 회차면 fork 에 `SendMessage(to: "<fork 이름>")` 를 1회 보낸다.
  - 내용은 `redo_from` 부터 마지막 항목까지 순서대로 다시 돌리라는 지시다.
    항목별 실패 사유와, `blocks_path` 가 있으면 그 경로를 함께 싣는다.
  - `redo_from` 앞 항목의 spec 은 감사를 통과했으므로 그대로 쓴다.
    `redo_from` 부터는 순서대로 새 spec 을 쓰므로 뒤 항목은 새 앞 spec 을 받는다.
    【｜항목당 4단계】의 상태 격리가 앞 회차 상태와 spec 을 `.bak` 으로 옮긴다.
  - `Monitor` 를 다시 건다.
    시작값 `n` 은 그 시점 진행 로그 줄 수다.
  - 완료 알림을 받으면 수신 검증과 이 절을 처음부터 다시 돈다.
  - `SendMessage` 가 오류를 내거나 `Monitor` 만료까지 새 진행 줄이 0 이면 fork 가
    응답하지 않은 것이다.
    메인이 `redo_from` 부터 `use_fork` 가 `false` 인 경로로 직접 돈다.
    그 뒤 감사는 `--fork-name` 없이 그 항목들을 main transcript 에서 본다.
- 두 번째 회차도 fail 이면 fail 항목마다 `fail(key, "fork-audit:<reason>")` 이다.
- 이 절이 낸 `fail` 은 【｜`use_fork` 가 `true` 일 때 — 실패 처리】의 「그 밖의 검증 실패」로 간다.
  `unattended` 면 그 절의 정지 처리로 가되, 출력 줄은
  `REQ_INTERVIEW_STATUS=STOPPED(<첫 fail 항목키>:fork-audit)` 다.
  사유 자리에 `:`·`§` 를 넣지 않는다 — 호출자가 사유를 `[a-z0-9-]+` 로 받는다.
- 받아들인 위험.
  - 감사는 harness 의 transcript 저장 형식에 기댄다.
    형식이 바뀌면 `unattended` 실행이 `fork-audit-unavailable` 로 멈춘다.
  - 감사는 호출 인자만 본다.
    deep-interview 가 그 인자를 근거로 실제 판정했는지는 보지 않는다.

## `use_fork` 가 `true` 일 때 — 실패 처리

- `name_prefix` 가 있으면 아래 재요청·재개·정지는 그 직전에 `fork_name_path` 의 한 줄을 읽어 fork 이름으로 쓴다.
  `name_prefix` 가 없으면 이 되읽기와 아래 두 규칙을 돌지 않고 `fork_name` 을 그대로 쓴다.
  - 재요청·재개 직전에 그 파일이 없으면 보내지 않는다.
    `REQ_INTERVIEW_STATUS=STOPPED(fork:fork-name-missing)` 로 멈춘다.
    `unattended` 여부와 무관하게 같은 줄을 낸다.
  - 정지 직전에 그 파일이 없으면 fork `TaskStop` 을 건너뛰고 `Monitor` 만 멈춘다.
    그 뒤 순서는 그대로다.
    `unattended` 면 건너뛴 사실을 보고에 한 줄로 남긴다.
- 결과 파일이 없으면 `SendMessage(to: "<fork_name>")` 로 1회 재요청한다.
  그래도 없으면 멈추고 보고한다.
- `request_fill` 대상은 fork 에 채우기를 1회 요청한다.
  메인은 그 기록을 대신 채우지 않는다.
  메인 컨텍스트에 그 항목의 질문과 옵션이 없다.
  그래도 남으면 멈추고 보고한다.
- 그 밖의 검증 실패와 fork 의 fail-closed 중단은 멈추고 보고한다.
- `unattended` 가 아니면 보고 뒤 사용자가 둘 중 하나를 고른다.
  - fork 재개 — `SendMessage(to: "<fork_name>")`.
    재개한 fork 의 완료 알림을 받으면 수신 검증을 처음부터 다시 돌린다.
  - 메인 인라인 — 멈춘 항목부터 `use_fork` 가 `false` 인 경로로 돈다.
- `unattended` 면 이 「fork 재개와 메인 인라인 중 선택」 보고를 하지 않는다.
  그 자리에서 `Monitor` 와 fork(`task_id` 는 `<fork_name>`)를 `TaskStop` 으로 멈추고, deep-interview 상태를
  `state_clear(mode="deep-interview", session_id)` 로 비운 뒤 `REQ_INTERVIEW_STATUS=STOPPED(<item-key>:unattended)` 를 낸다.
- 멈춤 의심 — `Monitor` 만료 고지까지 새 진행 줄이 0 이면 메인이 사용자에게 보고한다.
  - 보고에 「답하지 않은 질문이 있으면 먼저 답하라」를 넣는다.
    사용자 답을 기다리는 fork 도 진행 줄을 내지 않는다.
  - `unattended` 가 아니면 그 뒤 선택지는 위와 같다.
    `unattended` 면 같은 정지 처리를 한다.

## `use_fork` 가 `true` 일 때 — 정지

- 결과를 회수하면 `TaskStop` 으로 `Monitor` 만 멈춘다.
- fork 는 턴이 끝나면 `completed` 상태가 된다.
  그 fork 에 대한 `TaskStop` 은 「is not running」 오류를 낸다.
  그 오류는 정상이다.

# Step 3 — scope 재인터뷰

- `unattended` 면 이 Step 을 돌지 않고 Step 4 로 간다.
- 여섯 항목이 끝난 뒤 「추가 목적 확인」이 필요하면 `scope-2` 부터 회차를 돈다.
  `scope_only` 면 Step 1 이 끝난 뒤 같은 기준으로 돈다.
- 메인이 【｜항목당 4단계】로 돈다.
  질의 모드는 `사용자 질의` 다.
- 수신 검증 결과 보고와 재인터뷰 호출을 같은 턴에 둔다.
  fork 경로에는 진행 줄이 없어서, 보고만 내고 턴을 끝내면 재인터뷰가 사용자 입력을
  기다린다.

# Step 4 — 반환

- 【｜입출력 계약】의 출력 줄을 마지막 메시지에 낸다.
- 전 항목이 끝났으면 `REQ_INTERVIEW_STATUS=COMPLETE` 다.
- 어느 항목이 멈췄으면 `REQ_INTERVIEW_STATUS=STOPPED(<item-key>:<reason>)` 다.
  그때까지 끝난 항목의 경로 줄만 낸다.
- `unattended` 면 `REQ_INTERVIEW_STOP_EVIDENCE` 줄도 낸다.
  멈춘 항목의 spec 이 `Status: STOPPED` 면 사유를 `unattended` 로 쓰고,
  `REQ_INTERVIEW_STOP_EVIDENCE` 에 그 spec 절대경로를 낸다.
  감사로 멈췄으면(`fork-audit`·`fork-audit-unavailable`) 마지막
  `<slug>.fork-audit.r<n>.json` 절대경로를 낸다.
  scope 사전 감사로 멈췄으면 마지막 `<slug>.fork-audit.scope-pre.r<n>.json` 이다.
  `fork-audit-unavailable` 로 파일을 쓰지 못했으면 `none` 이다.
  `COMPLETE` 로 끝났거나 그 밖의 사유로 멈췄으면 `REQ_INTERVIEW_STOP_EVIDENCE=none`
  이다.
  `unattended` 가 아니면 이 줄을 내지 않는다.
- 출력 줄 앞에 항목별 결과를 짧게 보고하는 것을 허용한다.
  출력 줄 자체는 고치지 않는다.
- (`name_prefix` 일 때) 출력 줄 바로 뒤에 아래 한 줄을 낸다.
  이 경로에서 「마지막 메시지」는 이 호출의 마지막 출력이라는 뜻이다.
  호출자의 턴은 이 줄 뒤에도 이어진다.

```
호출자 절차로 돌아가 같은 턴에서 잇는다. 이 줄 뒤에 턴을 끝내지 않는다.
```

  - 근거 — 호출자는 이 스킬을 자기 턴 안에서 부른다.
    출력 줄을 낸 자리에서 턴이 끝나면 phase-chain 재진입이 호출자의 단계를 처음부터 다시 돌린다.
    닻은 피호출자 출력에 있어야 compaction 뒤에도 남는다.
  - `REQ_INTERVIEW_*` 줄의 형식과 출력 조건은 바꾸지 않는다.
    `name_prefix` 가 없으면 이 줄을 내지 않는다.

# 자기 점검

- [ ] `scope` 를 메인이 사용자 질의로 돌렸는가.
- [ ] 여섯 항목을 순서 표 순서로, `--auto-approve` 로 돌렸는가.
- [ ] 항목마다 상태 두 경로와 spec 경로의 부재를 확인한 뒤 호출했는가.
- [ ] 모든 위임 프롬프트에 실행 브리지 억제 지시를 넣었는가.
- [ ] 항목 사이에 진행 보고만 내고 턴을 끝내지 않았는가.
- [ ] fork 결과를 수신 검증하고 `Monitor` 를 멈췄는가.
- [ ] `name_prefix` 가 있으면 스폰 직전에 `fork_name_path` 를 썼고, 재요청·재개·정지 직전에 그 파일에서 fork 이름을 읽었는가.
- [ ] `name_prefix` 가 있으면 deep-interview 에 `--name-prefix` 를 넘겼는가.
- [ ] spec 을 옮기지 않고 절대경로만 반환했는가.
- [ ] 마지막 메시지에 `REQ_INTERVIEW_STATUS` 줄과 경로 줄을 냈는가.
- [ ] `unattended` 면 일곱 항목 모두 `--unattended` 로 돌리고, `scope` 재인터뷰를
  생략했는가.
- [ ] `verbatim_blocks` 면 블록을 원문으로 싣고 spec 마다 `Verbatim Blocks` 줄을 남겼는가.
- [ ] `name_prefix` 가 있으면 정지·통과 처리 전에 감사를 돌리고 `fork-audit.r<n>.json` 을 남겼는가.
- [ ] `name_prefix` 이고 `verbatim_blocks` 면 fork 스폰 전에 scope 사전 감사를 돌리고
  `fork-audit.scope-pre.r<n>.json` 을 남겼는가.
- [ ] `name_prefix` 가 있으면 출력 줄 뒤에 호출자 복귀 줄을 내고 턴을 끝내지 않았는가.
- [ ] `scope_only` 면 Step 2 를 건너뛰고 `scope` 경로 줄만 냈는가.
- [ ] `unattended` 정지에서 「fork 재개와 메인 인라인 중 선택」 보고 대신
  `Monitor`·fork 를 `TaskStop` 으로 멈추고 deep-interview 상태를 `state_clear` 로
  비운 뒤 `REQ_INTERVIEW_STOP_EVIDENCE` 를 함께 냈는가.
