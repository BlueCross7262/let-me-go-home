---
name: resolve-interview
description: Interview the user until every open item is resolved or deferred, then write a spec that waits for approval; the interview ends on an empty open-item list, not on an ambiguity score
argument-hint: "[--repo-root <path>] [--name-prefix <label>] <idea or vague description>"
user-invocable: true
disable-model-invocation: true
---

이 스킬은 막연한 아이디어를 미결 항목 목록으로 분해한다.
미결 항목이 모두 해소되거나 보류될 때까지 사용자에게 묻는다.
인터뷰는 모호성 점수가 아니라 미결 항목의 해소 여부로 끝난다.
산출물은 `pending approval` 로 멈추는 spec 이다.

# 목차

- 입출력 계약
- 실행 변수
- 공통 설정
- 미결 항목 규칙
- Step 0 — 인자 해석과 시작 점검
- Step 1 — 상태 초기화와 미결 목록 분해
- Step 2 — 질문 라운드
- Step 3 — 종료 판정
- Step 4 — spec 작성
- Step 5 — 실행 브리지
- 자기 점검

# 입출력 계약

- 입력은 아이디어 텍스트다.
  선택 인자는 `--repo-root <path>` 와 `--name-prefix <label>` 이다.
- 출력은 spec 파일 하나와 갱신한 상태 파일 하나다.
- 반환은 사용자에게 보고하는 spec 경로와 `Status` 값이다.

# 실행 변수

| 이름 | 타입 | 확정 시점 | 원천 | 기본값 |
|---|---|---|---|---|
| `idea` | 문자열 | Step 0 | 인자에서 두 선택 인자를 뗀 나머지 텍스트다. 프롬프트 예산을 넘으면 그 요약본이다 | 없음 |
| `repo_root` | 절대경로 | Step 0 | `--repo-root` 값이다 | `null` |
| `name_prefix` | 문자열 | Step 0 | `--name-prefix` 값이다 | `null` |
| `session_id` | 문자열 | Step 0 | 환경 변수 `CLAUDE_CODE_SESSION_ID` 다 | 없음 |
| `slug` | 문자열 | Step 0 | `idea` 에서 만든 소문자 하이픈 슬러그다 | 없음 |
| `interview_id` | 문자열 | Step 1 | 새로 만든 UUID 다 | 없음 |
| `spec_path` | 상대경로 | Step 4 | `.lmgh/specs/resolve-interview-<slug>.md` 다 | 없음 |

외부 계약은 아래 이름이다.
이 이름들을 그대로 유지한다.

| 이름 | 쓰는 곳 | 비고 |
|---|---|---|
| `skill` | 상태 필드 | 값은 `resolve-interview` 다. 스킬 `let-me-go-home:deep-interview` 와 같은 필드로 상태 주인을 가른다 |
| `interview_id`, `spec_path`, `rounds` | 상태 필드 | 스킬 `let-me-go-home:deep-interview` 가 쓰는 이름 그대로다 |
| `open_items` | 상태 필드 | 이 스킬 전용이다 |
| `Status` | spec 의 `## Metadata` 줄 | 값은 `RESOLVED`, `RESOLVED_WITH_DEFERRALS`, `STOPPED` 셋이다 |
| `ready_text`, `loop_name` | 스킬 `let-me-go-home:interview-core` 의 실행 변수 | Step 5 가 값을 정한다 |

# 공통 설정

- 목표는 `open` 항목을 0건으로 만드는 것이다.
- 항목은 사용자의 답이나 사용자가 명시한 보류로만 닫는다.
- 사실은 스킬 `let-me-go-home:explore` 의 에이전트로 조회한다.
  사용자에게는 결정만 묻는다.
- 이 스킬은 `--auto-approve`, `--unattended`, `--frontier` 를 받지 않는다.
  그 인자가 필요하면 스킬 `let-me-go-home:deep-interview` 를 쓴다.
- 받아들인 위험은 셋이다.
  - 모델이 항목을 빠뜨리거나 사용자가 표를 확인 없이 승인하는 경우를 지시문으로 닫지 못한다.
    총 항목 수 헤더와 상태에서 읽은 항목 표가 완화책이다.
  - 같은 세션에서 두 스킬은 차례로 돈다.
    `state_read` 와 `state_write` 사이의 경쟁은 받아들인다.
  - 상태 모드가 `deep-interview` 로 같아서 세션 시작 알림과 체크포인트가 이 스킬의 상태를 "Deep Interview" 로 표시한다.
- 다른 파일과의 관계는 넷이다.
  - 스킬 `let-me-go-home:cancel` 이 `state_clear(mode="deep-interview", session_id)` 로 두 스킬의 상태를 모두 비운다.
  - 스킬 `let-me-go-home:interview-core` 가 실행 브리지 선택지 메뉴를 담는다.
  - 스킬 `let-me-go-home:req-interview` 는 이 스킬을 부르지 않는다.
  - spec 은 `.lmgh/specs/resolve-interview-<slug>.md` 에만 쓴다.

# 미결 항목 규칙

항목 구조는 아래와 같다.

```
item = { id, question, depends_on: [id], status: open|resolved|deferred,
         answer|null, deferral_reason|null, origin: idea|discovered }
```

- `add_item(x)` 는 `x.depends_on` 에 이미 들어간 id 만 허용한다.
  중복 id 를 거부한다.
  선행 항목 중 `deferred` 가 있으면 `x` 를 사유 `prerequisite deferred` 로 `deferred` 에 넣는다.
- `init` 은 분해한 항목을 하나씩 `add_item` 으로 넣는다.
  앞 항목만 참조할 수 있어 순환이 없다.
  분해 결과가 0건이면 항목 `goal` 하나를 넣는다.
- `frontier` 는 `open` 이면서 `depends_on` 이 모두 `resolved` 인 항목이다.
- `defer(i)` 는 사용자가 명시한 경우에만 쓴다.
  `i` 와 `i` 에 전이적으로 기대는 `open` 항목을 모두 `deferred` 로 바꾼다.
  사유는 `i` 에 사용자가 밝힌 이유와 `prerequisite deferred` 다.
- `reopen(i)` 는 나중 답이 `resolved` 항목 `i` 와 모순될 때 쓴다.
  `i` 와 `i` 에 전이적으로 기대는 `resolved` 항목을 `open` 으로 되돌린다.
  `deferred` 후행 항목은 그대로 둔다.
  종료를 확정하기 전에만 `reopen` 한다.
- 파생 새 항목은 `origin: discovered` 로 `add_item` 에 넣고 `open` 에 포함한다.

# Step 0 — 인자 해석과 시작 점검

- 인자에서 `--repo-root <path>` 와 `--name-prefix <label>` 을 떼어 `repo_root` 와 `name_prefix` 로 확정한다.
  두 값은 공백 없는 토큰 하나다.
- 나머지 텍스트를 `idea` 로 확정한다.
  프롬프트 예산을 넘으면 의도·결정·제약·미지·non-goal 을 보존한 요약을 `idea` 로 확정한다.
- `--auto-approve`, `--unattended`, `--frontier` 가 인자에 있으면 이 스킬이 받지 않는다고 알리고 멈춘다.
- `idea` 가 비어 있으면 호출법을 안내하고 멈춘다.
- `session_id` 와 `slug` 를 확정한다.
- `state_read(mode="deep-interview", session_id)` 로 기존 상태를 읽는다.
  - `skill` 과 `spec_path` 는 최상위와 `state` 아래 두 자리를 모두 읽는다.
  - `skill` 필드가 없는 상태는 `deep-interview` 로 본다.
  - `skill` 이 `deep-interview` 이고 `active` 가 true 이고 `spec_path` 가 없거나 null 이면 시작하지 않는다.
    `/let-me-go-home:cancel` 을 안내하고 멈춘다.
  - `skill` 이 `resolve-interview` 이고 `active` 가 true 이고 `spec_path` 가 없거나 null 이면 상태의 `open_items` 와 `rounds` 를 읽는다.
    마지막으로 끝난 라운드부터 Step 2 로 재개한다.
  - 그 밖의 상태는 Step 1 이 새로 쓴다.
- 완료 기준은 변수 확정과 시작·재개·멈춤 중 하나의 결정이다.

# Step 1 — 상태 초기화와 미결 목록 분해

- 스킬 `let-me-go-home:explore` 의 에이전트로 저장소를 조회해 브라운필드 또는 그린필드를 정한다.
  - 모델은 `haiku` 이고 에이전트 `name` 은 `explore-<주제>` 다.
  - `name_prefix` 가 있으면 `name` 은 `<name_prefix>-explore-<hex4>` 다.
    `<hex4>` 는 스폰마다 새로 만든 4자리 소문자 hex 다.
  - `repo_root` 가 있으면 프롬프트에 "저장소 루트는 `<repo_root>` 다. 그 아래만 조회한다. 근거 경로는 절대경로로 적는다" 를 싣는다.
- `idea` 를 설계 트리로 분해한다.
  - 항목 하나는 사용자만 답할 수 있는 결정 하나다.
  - `depends_on` 은 그 결정이 기대는 앞 항목이다.
  - 저장소에서 조회할 수 있는 사실은 항목으로 만들지 않는다.
- 항목을 하나씩 `add_item` 으로 넣는다.
  분해 결과가 0건이면 `goal` 하나를 넣는다.
- `interview_id` 를 만들고 `state_write(mode="deep-interview", session_id)` 로 상태를 쓴다.

```json
{
  "active": true,
  "current_phase": "resolve-interview",
  "state": {
    "skill": "resolve-interview",
    "interview_id": "<uuid>",
    "type": "greenfield|brownfield",
    "initial_idea": "<idea>",
    "rounds": [],
    "open_items": [
      { "id": "goal", "question": "<question>", "depends_on": [], "status": "open", "answer": null, "deferral_reason": null, "origin": "idea" }
    ],
    "codebase_context": null
  }
}
```

- `state_write` 는 파일 전체를 바꾼다.
  쓸 때마다 모든 필드를 함께 넘긴다.
- 사용자에게 항목 수와 첫 라운드의 질문 수를 알린다.
- 완료 기준은 항목 1건 이상과 기록한 상태다.

# Step 2 — 질문 라운드

- `frontier` 를 계산한다.
  `open` 항목이 있으면 `frontier` 는 비지 않는다.
- `frontier` 전체를 `AskUserQuestion` 한 호출에 최대 4개씩 묻는다.
  `frontier` 가 4개를 넘으면 같은 라운드의 다음 호출로 묻는다.
- 질문마다 권장 답을 선택지 맨 앞에 두고 라벨 끝에 `(Recommended)` 를 붙인다.
  선택지에 `보류` 를 둔다.
  자유 입력도 받는다.
- 답을 받으면 항목을 갱신한다.
  - 답한 항목은 `resolved` 로 바꾸고 `answer` 를 적는다.
  - `보류` 를 고른 항목은 `defer` 한다.
- 답한 항목마다 파생 점검 행 한 줄을 출력한다.
  형식은 `<id>: 파생 <id>, <id>` 또는 `<id>: none` 이다.
  파생 새 항목은 `add_item` 으로 넣는다.
- 나중 답이 `resolved` 항목과 모순되면 `reopen` 한다.
- 질문 라운드를 끝내면 `rounds` 에 한 행을 더하고 `state_write` 로 모든 필드를 쓴다.
  라운드 번호는 질문 라운드를 끝낼 때마다 1 올린다.
  완전성 질문은 라운드 번호를 올리지 않는다.
- 사용자가 stop, cancel, abort 라고 하면 상태를 저장하고 spec 을 쓰지 않고 멈춘다.
- 완료 기준은 라운드마다 파생 점검 행 출력과 갱신한 상태다.

# Step 3 — 종료 판정

- 라운드 20 을 끝낼 때 `open` 이 남아 있으면 질문 없이 Step 4 로 간다.
  `Status` 는 `STOPPED` 다.
  라운드 20 에서 사용자가 "아니오" 로 더한 항목도 `open` 에 포함한다.
- `open` 이 0건이고 파생 새 항목이 0건이면 완전성 질문을 `AskUserQuestion` 으로 묻는다.
  - 질문 머리에 총 항목 수를 적는다.
  - `state_read` 로 읽은 `open_items` 전체를 id·질문·상태 표로 싣는다.
  - 답한 항목별 파생 점검 행 표를 싣는다.
  - 질문 문장은 "목록이 완전한가?" 다.
- 사용자가 완전하다고 답하면 Step 4 로 간다.
- 사용자가 "아니오" 로 답하면 빠진 항목의 id 를 하나 이상 말하도록 요청한다.
  - 말한 항목은 `add_item` 으로 `open` 에 더하고 Step 2 로 돌아간다.
  - 말하지 못하면 완전한 것으로 보고 Step 4 로 간다.
- `Status` 는 아래로 정한다.
  - `open` 이 남으면 `STOPPED` 다.
  - `open` 이 0건이고 `deferred` 가 있으면 `RESOLVED_WITH_DEFERRALS` 다.
  - `open` 이 0건이고 `deferred` 가 없으면 `RESOLVED` 다.
- 완료 기준은 `Status` 값 하나의 확정이다.

# Step 4 — spec 작성

- 경로는 `.lmgh/specs/resolve-interview-<slug>.md` 다.
  `Write` 도구로 쓴다.
  임시 산출물은 `.lmgh/state/` 나 `state_write` 에 둔다.
- 아래 서식으로 쓴다.

```markdown
# Resolve Interview Spec: {title}

## Metadata
- Interview ID: {uuid}
- Rounds: {count}
- Type: greenfield | brownfield
- Generated: {timestamp}
- Initial Context Summarized: {yes|no}
- Answer Mode: user
- Open Items: {resolved}/{deferred}/{open}
- Status: {RESOLVED | RESOLVED_WITH_DEFERRALS | STOPPED}

## Goal
{interview 가 확정한 목표 한 문단}

## Open Items
| ID | Question | Status | Answer or Reason |
|----|----------|--------|------------------|
| {id} | {question} | {resolved|deferred|open} | {answer or deferral reason} |

## Technical Context
{brownfield: explore 가 찾은 저장소 사실}
{greenfield: 기술 선택과 제약}

## Interview Transcript
<details>
<summary>Full Q&A ({n} rounds)</summary>

### Round 1
**Q:** {question}
**A:** {answer}

...
</details>
```

- 쓴 뒤 `state_write` 로 `spec_path` 를 `interview_id` 와 같은 자리에 쓴다.
  모든 필드를 함께 넘긴다.
- `STOPPED` spec 의 `## Open Items` 에 `open` 항목을 모두 적는다.
- 완료 기준은 파일 존재와 상태의 `spec_path` 다.

# Step 5 — 실행 브리지

- spec 을 `pending approval` 로 표시한다.
- 사용자가 실행 선택지를 고르기 전에 하는 행동은 아래 여섯 가지다.
  - spec 파일 쓰기
  - 상태 기록
  - 읽기 전용 조회
  - 사용자에게 묻기
  - 스킬 `let-me-go-home:explore` 의 에이전트 조회
  - 스킬 `let-me-go-home:interview-core` 의 메뉴 호출
- 그 밖의 행동은 사용자가 실행 선택지를 고르기 전에는 하지 않는다.
  변경을 일으키는 셸 명령, 소스 파일 수정, 커밋·푸시, PR 열기, 실행 스킬 호출, 구현 작업 위임이 여기 해당한다.
  승인 전 실행은 사용자가 요청하지 않은 일을 만든다.
- `Status` 가 `STOPPED` 면 선택지 메뉴를 제시하지 않는다.
  spec 경로와 `open` 목록을 보고하고 멈춘다.
- `Status` 가 `RESOLVED` 나 `RESOLVED_WITH_DEFERRALS` 면 스킬 `let-me-go-home:interview-core` 를 `Skill("let-me-go-home:interview-core")` 로 불러 그 스킬의 `실행 브리지 선택지` 절을 따른다.
  - `ready_text` 는 `open items: 0` 이다.
  - `loop_name` 은 `Step 2 — 질문 라운드` 다.
  - 그 스킬 결과가 보이지 않으면 질문을 던지지 않고 멈춘다.
    그리고 사용자에게 알린다.
- 사용자가 실행을 명시적으로 고르면 그 스킬을 `Skill()` 로 호출한다.
  직접 구현하지 않는다.
- 명시적 선택이 없으면 spec 을 `pending approval` 로 표시한 채 멈춘다.
- 완료 기준은 보고한 spec 경로와 `Status` 값이다.

# 자기 점검

- [ ] Step 0 이 `--auto-approve`, `--unattended`, `--frontier` 를 받지 않았다.
- [ ] 항목마다 사용자의 답이나 사용자가 명시한 보류가 있다.
- [ ] 라운드마다 파생 점검 행을 출력했다.
- [ ] 완전성 질문에 총 항목 수와 항목 표를 싣었다.
- [ ] `open` 이 남은 spec 의 `Status` 가 `STOPPED` 다.
- [ ] `Status` 에 `PASSED` 를 쓰지 않았다.
- [ ] spec 이 `.lmgh/specs/resolve-interview-<slug>.md` 에 있고 상태에 `spec_path` 가 있다.
- [ ] 사용자가 실행 선택지를 고르기 전에 허용 목록 밖의 행동이 없다.
