---
name: req-interview
description: Run a seven-item requirements interview in one call - scope with the user in the main session, the other six auto-approved by one fork - and return the deep-interview spec paths to the caller
argument-hint: "[--slug <slug>] [--context <path>] [--no-fork] <goal text | spec file path>"
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

- 해석 규칙은 deep-interview 와 같다.
  플래그를 먼저 떼어 낸다.
  남은 텍스트 전체를 위치 인자로 삼는다.
- `--slug`·`--context` 의 값은 공백 없는 토큰 하나다.
- 위치 인자가 존재하는 파일 경로면 그 파일 내용이 출발점이다.
  그 밖에는 위치 인자 텍스트 자체가 출발점이다.

## 출력

- 마지막 메시지에 아래 줄을 낸다.
  호출자는 이 줄만 읽는다.

```
REQ_INTERVIEW_STATUS=COMPLETE|STOPPED(<item-key>:<reason>)
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
- `STOPPED` 면 그때까지 끝난 항목의 줄만 낸다.
  인자·준비 단계에서 멈추면 `<item-key>` 자리에 `args` 를 쓴다.
- 경로는 deep-interview 가 쓴 상대경로를 현재 작업 디렉토리 기준 절대경로로 바꿔
  낸다.
- spec 파일은 `.lmgh/specs/deep-interview-<slug>-<항목키>.md` 에 있다.
  이 스킬은 spec 을 옮기거나 합치지 않는다.
- fork 경로의 부산물은 `.lmgh/req-interview/` 아래 둘이다.
  결과 파일 `<slug>.result.md` 와 진행 로그 `<slug>.progress.log` 다.

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
| `slug` | Step 0 | `--slug`, 없으면 `goal` 에서 만든 슬러그 |
| `context_path` | Step 0 | `--context`, 없으면 `null` |
| `use_fork` | Step 0 | `--no-fork` 가 있으면 `false`, 없으면 `true` |
| `session_id` | Step 0 | 환경 변수 `CLAUDE_CODE_SESSION_ID`, 없으면 `LMGH_SESSION_ID` |
| `skill_file` | Step 0 | 【｜스킬 파일 위치 찾기】 |
| `work_dir` | Step 0 | 현재 작업 디렉토리 아래 `.lmgh/req-interview` 절대경로 |
| `result_path` | Step 0 | `<work_dir>/<slug>.result.md` |
| `progress_path` | Step 0 | `<work_dir>/<slug>.progress.log` |
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
- `권장안 자동 확정` — 나머지 여섯 항목이다.
  그 항목은 deep-interview 를 `--auto-approve` 플래그로 부른다.
  그 플래그가 근거 있는 질문을 권장안으로 확정한다.
  근거 없는 질문만 사용자에게 묻는다.
  Round 0 topology 확인 질문도 그 플래그의 대상이다.
- 판정 사다리·근거 출처·권장안 선택 기준은 deep-interview 의
  `Auto-Approve Mode (--auto-approve)` 절이 소유한다.
  항목을 돌리는 주체는 deep-interview 질문에 따로 답을 고르지 않는다.
  - 조사 요약과 앞 항목 확정값은 호출 인자로 넘기므로 그 절의 근거 출처 중 호출
    인자에 해당한다.
- Phase 5 실행 브리지 질문은 이 절의 대상이 아니다.
  【｜실행 브리지 억제】가 우선한다.

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

`권장안 자동 확정` 항목은 `args` 맨 앞에 `--auto-approve` 를 두고,
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
- 경계 지시 — 이 항목만 다루고 다른 항목의 결정은 닫힌 것으로 받으라는 명시다.
- 【｜실행 브리지 억제】 지시.
- 이 항목의 질의 모드 — 순서 표의 값과 【｜항목 순서와 질의 모드】의 해당 코드블록.
  `scope` 항목도 생략하지 않는다.
  `권장안 자동 확정` 항목은 `args` 맨 앞에 `--auto-approve` 를 둔다.
  `scope` 에는 그 플래그를 두지 않는다.
- slug 는 `<slug>-<항목키>` 로 지정한다.
  `scope` 재인터뷰 회차는 `<slug>-scope-2`·`<slug>-scope-3` 이다.
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
- `## Metadata` 절의 `Answer Mode` 가 `scope` 는 `user`, 나머지 여섯은
  `auto-approve` 인가.
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

- `skill_file` 을 【｜스킬 파일 위치 찾기】로 정한다.
- `work_dir` 디렉토리를 만든다.

```
node -e "require('fs').mkdirSync(process.argv[1], { recursive: true })" <work_dir>
```

# Step 1 — scope 인터뷰

- 메인이 `scope` 항목을 【｜항목당 4단계】로 돈다.
- 질의 모드는 `사용자 질의` 다.
- 끝나면 `spec_paths` 에 `scope` 행이 생긴다.

# Step 2 — 여섯 항목 인터뷰

`functional → data → ui → edge → techconstraint → nonfunctional` 순서로 돈다.
모두 `--auto-approve` 로 부른다.

## `use_fork` 가 `false` 일 때

- 메인이 여섯 항목을 한 번에 하나씩 【｜항목당 4단계】로 돈다.
- 항목 사이에는 【｜항목 사이 턴 규율】의 진행 줄 하나를 낸다.

## `use_fork` 가 `true` 일 때 — 스폰

이 절의 스폰·수신 검증·정지는 메인 몫이다.
fork 는 이 절을 따르지 않는다.

- 스폰 직전에 【｜항목 사이 턴 규율】의 대기 줄을 낸다.
- `Agent(subagent_type: "fork", name: "auto-interview-<slug>")` 를 1회 부른다.
  위임 프롬프트는 아래 【｜Step 2 — 여섯 항목 인터뷰｜`use_fork` 가 `true` 일 때 — 위임 프롬프트】의
  리터럴을 싣고 `<...>` 만 채운다.
- 스폰과 같은 턴에 `Monitor` 를 건다.
  - `description` 에 `auto-interview-<slug>` 를 싣는다.
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
항목마다 절차 파일의 「항목당 4단계」「항목 순서와 질의 모드」「실행 브리지 억제」
「항목 사이 턴 규율」을 그대로 따른다. 그 파일을 다시 읽고 따른다. 그 파일의
Step 절은 메인 몫이라 따르지 않는다.
- 모든 항목을 `--auto-approve` 로 부른다. 자동 확정은 그 플래그의 판정 사다리만 한다.
  네가 deep-interview 질문에 따로 답을 고르지 않는다. 근거 없는 질문은 그 플래그대로
  사용자에게 묻는다.
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
    if meta["Status"] != "PASSED": fail(key, "Status")
    if meta["Answer Mode"] != "auto-approve": fail(key, "Answer Mode")
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
- 통과하면 여섯 항목의 spec 경로를 `spec_paths` 에 더한다.

## `use_fork` 가 `true` 일 때 — 실패 처리

- 결과 파일이 없으면 `SendMessage(to: "auto-interview-<slug>")` 로 1회 재요청한다.
  그래도 없으면 멈추고 보고한다.
- `request_fill` 대상은 fork 에 채우기를 1회 요청한다.
  메인은 그 기록을 대신 채우지 않는다.
  메인 컨텍스트에 그 항목의 질문과 옵션이 없다.
  그래도 남으면 멈추고 보고한다.
- 그 밖의 검증 실패와 fork 의 fail-closed 중단은 멈추고 보고한다.
- 보고 뒤 사용자가 둘 중 하나를 고른다.
  - fork 재개 — `SendMessage(to: "auto-interview-<slug>")`.
    재개한 fork 의 완료 알림을 받으면 수신 검증을 처음부터 다시 돌린다.
  - 메인 인라인 — 멈춘 항목부터 `use_fork` 가 `false` 인 경로로 돈다.
- 멈춤 의심 — `Monitor` 만료 고지까지 새 진행 줄이 0 이면 메인이 사용자에게 보고한다.
  - 보고에 「답하지 않은 질문이 있으면 먼저 답하라」를 넣는다.
    사용자 답을 기다리는 fork 도 진행 줄을 내지 않는다.
  - 그 뒤 선택지는 위와 같다.

## `use_fork` 가 `true` 일 때 — 정지

- 결과를 회수하면 `TaskStop` 으로 `Monitor` 만 멈춘다.
- fork 는 턴이 끝나면 `completed` 상태가 된다.
  그 fork 에 대한 `TaskStop` 은 「is not running」 오류를 낸다.
  그 오류는 정상이다.

# Step 3 — scope 재인터뷰

- 여섯 항목이 끝난 뒤 「추가 목적 확인」이 필요하면 `scope-2` 부터 회차를 돈다.
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
- 출력 줄 앞에 항목별 결과를 짧게 보고하는 것을 허용한다.
  출력 줄 자체는 고치지 않는다.

# 자기 점검

- [ ] `scope` 를 메인이 사용자 질의로 돌렸는가.
- [ ] 여섯 항목을 순서 표 순서로, `--auto-approve` 로 돌렸는가.
- [ ] 항목마다 상태 두 경로와 spec 경로의 부재를 확인한 뒤 호출했는가.
- [ ] 모든 위임 프롬프트에 실행 브리지 억제 지시를 넣었는가.
- [ ] 항목 사이에 진행 보고만 내고 턴을 끝내지 않았는가.
- [ ] fork 결과를 수신 검증하고 `Monitor` 를 멈췄는가.
- [ ] spec 을 옮기지 않고 절대경로만 반환했는가.
- [ ] 마지막 메시지에 `REQ_INTERVIEW_STATUS` 줄과 경로 줄을 냈는가.
