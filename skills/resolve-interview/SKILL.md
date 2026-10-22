---
name: resolve-interview
description: Interview the user until every open item in an idea or a document is resolved or deferred, write a spec, write the decisions back into the source document, and ask which next step to run; the interview ends on an empty open-item list, not on an ambiguity score
argument-hint: "[--repo-root <path>] [--name-prefix <label>] <idea | document path>"
user-invocable: true
disable-model-invocation: true
---

이 스킬은 막연한 아이디어나 문서를 미결 항목 목록으로 분해한다.
미결 항목이 모두 해소되거나 보류될 때까지 사용자에게 묻는다.
인터뷰는 모호성 점수가 아니라 미결 항목의 해소 여부로 끝난다.
산출물은 `pending approval` 로 멈추는 spec 이다.
입력이 문서면 그 문서에 결정을 반영한다.
마지막에 메인이 상황에 맞는 다음 행동을 추천하고 묻는다.

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
- Step 5 — 원천 문서 갱신
- Step 6 — 다음 행동 질문
- 자기 점검

# 입출력 계약

- 입력은 아이디어 텍스트나 문서 경로 하나다.
  선택 인자는 `--repo-root <path>` 와 `--name-prefix <label>` 이다.
- 출력은 spec 파일 하나와 갱신한 상태 파일 하나다.
  입력이 문서면 그 문서도 갱신한다.
- 반환은 사용자에게 보고하는 spec 경로와 `Status` 값이다.

# 실행 변수

| 이름 | 타입 | 확정 시점 | 원천 | 기본값 |
|---|---|---|---|---|
| `idea` | 문자열 | Step 0 | `source_doc` 이 있으면 그 파일 본문이다. 없으면 인자에서 두 선택 인자를 뗀 나머지 텍스트다. 프롬프트 예산을 넘으면 그 요약본이다 | 없음 |
| `source_doc` | 절대경로 | Step 0 | 인자 나머지가 공백 없는 토큰 하나이고 존재하는 파일이면 그 경로다. 재개면 상태의 `source_doc` 값이다 | `null` |
| `repo_root` | 절대경로 | Step 0 | `--repo-root` 값이다 | `null` |
| `name_prefix` | 문자열 | Step 0 | `--name-prefix` 값이다 | `null` |
| `session_id` | 문자열 | Step 0 | 환경 변수 `CLAUDE_CODE_SESSION_ID` 다 | 없음 |
| `slug` | 문자열 | Step 0 | `source_doc` 이 있으면 그 파일 이름에서, 없으면 `idea` 에서 만든 소문자 하이픈 슬러그다 | 없음 |
| `interview_id` | 문자열 | Step 1 | 새로 만든 UUID 다 | 없음 |
| `spec_path` | 상대경로 | Step 4 | `.lmgh/specs/resolve-interview-<slug>.md` 다 | 없음 |

외부 계약은 아래 이름이다.
이 이름들을 그대로 유지한다.

| 이름 | 쓰는 곳 | 비고 |
|---|---|---|
| `skill` | 상태 필드 | 값은 `resolve-interview` 다. 스킬 `let-me-go-home:deep-interview` 와 같은 필드로 상태 주인을 가른다 |
| `interview_id`, `spec_path`, `rounds` | 상태 필드 | 스킬 `let-me-go-home:deep-interview` 가 쓰는 이름 그대로다 |
| `open_items` | 상태 필드 | 이 스킬 전용이다 |
| `source_doc` | 상태 필드 | 이 스킬 전용이다. 재개가 이 값을 읽는다 |
| `source_ref` | `open_items` 항목 필드 | 이 스킬 전용이다 |
| `Status` | spec 의 `## Metadata` 줄 | 값은 `RESOLVED`, `RESOLVED_WITH_DEFERRALS`, `STOPPED` 셋이다 |

# 공통 설정

- 목표는 `open` 항목을 0건으로 만드는 것이다.
- 항목은 사용자의 답이나 사용자가 명시한 보류로만 닫는다.
  Step 5 의 원천 문서 편집은 항목 상태를 바꾸지 않는다.
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
- 다른 파일과의 관계는 다섯이다.
  - 스킬 `let-me-go-home:cancel` 이 `state_clear(mode="deep-interview", session_id)` 로 두 스킬의 상태를 모두 비운다.
  - 이 스킬은 스킬 `let-me-go-home:interview-core` 를 부르지 않는다.
  - 스킬 `let-me-go-home:req-interview` 는 이 스킬을 부르지 않는다.
  - spec 은 `.lmgh/specs/resolve-interview-<slug>.md` 에만 쓴다.
  - 원천 문서는 `source_doc` 하나만 고친다.
    그 편집은 Step 5 에서만 한다.

# 미결 항목 규칙

항목 구조는 아래와 같다.

```
item = { id, question, depends_on: [id], status: open|resolved|deferred,
         answer|null, deferral_reason|null, origin: idea|discovered,
         source_ref|null }
```

- `source_ref` 는 그 항목이 나온 문서 자리의 헤딩과 원문 인용 한 줄이다.
  - `source_doc` 이 `null` 이면 모든 항목의 값이 `null` 이다.
  - Step 1 의 분해 밖에서 생긴 항목의 값은 `null` 이다.
    `goal` 대체 항목, `add_item` 으로 더한 파생 항목, 사용자가 완전성 질문에서 더한 항목이 여기 해당한다.
  - 여러 항목이 같은 `source_ref` 를 가질 수 있다.
  - `defer`·`reopen` 은 `source_ref` 를 바꾸지 않는다.
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
  남은 텍스트를 인자 나머지라 부른다.
- `--auto-approve`, `--unattended`, `--frontier` 가 인자에 있으면 이 스킬이 받지 않는다고 알리고 멈춘다.
- `session_id` 를 확정한다.
- `state_read(mode="deep-interview", session_id)` 로 기존 상태를 읽는다.
  - `skill` 과 `spec_path` 는 최상위와 `state` 아래 두 자리를 모두 읽는다.
  - `skill` 필드가 없는 상태는 `deep-interview` 로 본다.
  - `skill` 이 `deep-interview` 이고 `active` 가 true 이고 `spec_path` 가 없거나 null 이면 시작하지 않는다.
    `/let-me-go-home:cancel` 을 안내하고 멈춘다.
  - `skill` 이 `resolve-interview` 이고 `active` 가 true 이고 `spec_path` 가 없거나 null 이면 재개한다.
  - 그 밖의 상태는 새로 시작한다.
    Step 1 이 상태를 새로 쓴다.
- 재개면 상태의 `source_doc`·`initial_idea`·`open_items`·`rounds` 를 읽는다.
  - `source_doc` 과 `idea` 는 상태 값으로 확정한다.
  - 인자 나머지는 판정에 쓰지 않고, 인자 나머지의 파일도 읽지 않는다.
  - 마지막으로 끝난 라운드부터 Step 2 로 재개한다.
- 새로 시작하면 인자 나머지를 아래 넷 중 하나로 판정한다.
  - 비었다: 호출법을 안내하고 멈춘다.
  - 공백 없는 토큰 하나이고 존재하는 파일이다: 그 경로를 `source_doc` 으로 확정하고, 파일 본문을 읽어 `idea` 로 확정한다.
  - 공백 없는 토큰 하나이고 `/`·`\` 를 포함하거나 `.md`·`.txt` 로 끝나는데 파일이 없다: 그 경로를 알리고 멈춘다.
  - 그 밖의 텍스트다: 그 텍스트를 `idea` 로 확정한다.
    `source_doc` 은 `null` 이다.
- `idea` 가 프롬프트 예산을 넘으면 의도·결정·제약·미지·non-goal 을 보존한 요약을 `idea` 로 확정한다.
- `idea` 를 확정한 뒤 `slug` 를 확정한다.
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
- `source_doc` 이 있으면 `idea` 가 요약본이어도 `source_doc` 원문 파일을 읽어 분해한다.
  - 문서의 미결 지점이 항목이다.
    TBD, 열린 질문, 비어 있는 결정, 서로 부딪히는 서술이 미결 지점이다.
  - 항목마다 원문에서 `source_ref` 를 적는다.
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
    "source_doc": "<path>|null",
    "rounds": [],
    "open_items": [
      { "id": "goal", "question": "<question>", "depends_on": [], "status": "open", "answer": null, "deferral_reason": null, "origin": "idea", "source_ref": null }
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
- Source Document: {path | none}
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

# Step 5 — 원천 문서 갱신

- 이 Step 은 세 `Status` 값 모두에서 돈다.
  `source_doc` 이 `null` 이면 건너뛴다.
- 사용자에게 묻지 않고 진행한다.
- 자리 판정 — 첫 편집 전에 `source_doc` 을 한 번 읽고 모든 항목의 자리를 줄 번호로 정한다.
  - `source_ref` 가 있으면 그 헤딩 아래에서 원문 인용 줄과 같은 줄을 센다.
    헤딩 아래는 다음 같은 단계 이상 헤딩 전까지다.
    정확히 하나면 그 줄이 자리다.
  - 그 밖의 모든 항목은 문서 끝 `## 추가 결정` 절이 자리다.
    `source_ref` 가 없는 항목, 헤딩을 찾지 못한 항목, 같은 줄이 0개거나 둘 이상인 항목이 여기 해당한다.
    그 절이 없으면 만든다.
  - 항목의 상태와 `origin` 은 자리 판정에 쓰지 않는다.
  - 두 항목의 자리 줄 번호가 같으면 같은 자리다.
- 줄 서식 — 항목 하나는 줄 하나로 쓴다.
  - 모든 줄 끝에 표식 `<!-- ri:<id> -->` 를 단다.
    표식은 렌더링에서 보이지 않고 항목마다 하나다.
  - `resolved` 는 `<answer> <!-- ri:<id> -->` 다.
  - `deferred` 는 `보류 — <deferral_reason> <!-- ri:<id> -->` 다.
  - `open` 은 `미결 — <question> <!-- ri:<id> -->` 다.
  - 인용 줄 자리와 `## 추가 결정` 절에 같은 서식을 쓴다.
  - 줄을 쓰기 전에 `answer`·`deferral_reason`·`question` 안의 `<!-- ri:` 를 `<!-- ri\:` 로 바꾼다.
    그래서 표식은 줄 끝의 하나뿐이다.
- 편집 — 자리마다 `Edit` 를 한 번 한다.
  - 인용 줄 자리는 그 인용 줄을 그 자리 항목들의 줄로 바꾼다.
  - `## 추가 결정` 절은 그 자리 항목들의 줄을 절 끝에 더한다.
  - 줄 순서는 `resolved`, `deferred`, `open` 이고, 같은 상태 안에서는 항목 id 순이다.
  - 편집은 줄 번호가 큰 자리부터 한다.
    한 편집은 그 자리 줄과 그 뒤 줄만 옮긴다.
    그래서 아직 고치지 않은 자리의 줄 번호와 내용은 그대로다.
    `## 추가 결정` 절은 문서 끝이라 가장 먼저 고친다.
- 확인 — 편집을 마치면 `source_doc` 을 다시 읽는다.
  - 항목마다 표식 `<!-- ri:<id> -->` 가 문서 전체에 정확히 한 번 있는지 본다.
  - 그 줄이 그 항목의 자리 블록 안에 있는지 본다.
    자리 블록은 인용 줄 자리면 그 인용 줄을 바꾼 줄들이고, `## 추가 결정` 이면 그 절이다.
  - 어긋난 항목은 표식으로 그 줄을 찾아 지우고, 그 항목의 자리 블록에 다시 쓴 뒤 다시 확인한다.
- 고친 자리 목록을 자리 헤딩과 항목 id 로 사용자에게 보고한다.
- 완료 기준은 확인에서 어긋난 항목 0건이다.

# Step 6 — 다음 행동 질문

- spec 을 `pending approval` 로 표시한다.
- 사용자가 선택지를 고르기 전에 하는 행동은 아래 여섯 가지다.
  - spec 파일 쓰기
  - 상태 기록
  - Step 5 의 `source_doc` 편집
  - 읽기 전용 조회
  - 사용자에게 묻기
  - 스킬 `let-me-go-home:explore` 의 에이전트 조회
- 그 밖의 행동은 사용자가 선택지를 고르기 전에는 하지 않는다.
  변경을 일으키는 셸 명령, `source_doc` 밖의 파일 수정, 커밋·푸시, PR 열기, 실행 스킬 호출, 구현 작업 위임이 여기 해당한다.
  승인 전 실행은 사용자가 요청하지 않은 일을 만든다.
- `Status` 가 `RESOLVED`·`RESOLVED_WITH_DEFERRALS`·`STOPPED` 중 무엇이든 `AskUserQuestion` 으로 다음 행동을 묻는다.
  - `STOPPED` 면 남은 `open` 항목을 질문에 함께 싣는다.
- 메인이 `Status`·`source_doc`·spec 내용을 보고 추천 선택지 1~3개를 만든다.
  - 추천할 스킬의 종류에 제한이 없다.
  - 추천 1순위를 맨 앞에 두고 라벨 끝에 `(Recommended)` 를 붙인다.
  - 선택지마다 description 에 부를 스킬, 넘길 경로, 추천 이유를 적는다.
- 마지막 선택지는 항상 `Save Spec and Stop` 이다.
- 사용자가 선택지를 고르기 전에는 어떤 스킬도 부르지 않는다.
- 사용자가 스킬 선택지를 고르면 그 스킬을 `Skill()` 로 부른다.
  직접 구현하지 않는다.
- 사용자가 고르지 않거나 `Save Spec and Stop` 을 고르면 spec 을 `pending approval` 로 둔 채 멈춘다.
- 완료 기준은 보고한 spec 경로와 `Status` 값이다.

# 자기 점검

- [ ] Step 0 이 `--auto-approve`, `--unattended`, `--frontier` 를 받지 않았다.
- [ ] 항목마다 사용자의 답이나 사용자가 명시한 보류가 있다.
- [ ] 라운드마다 파생 점검 행을 출력했다.
- [ ] 완전성 질문에 총 항목 수와 항목 표를 싣었다.
- [ ] `open` 이 남은 spec 의 `Status` 가 `STOPPED` 다.
- [ ] `Status` 에 `PASSED` 를 쓰지 않았다.
- [ ] spec 이 `.lmgh/specs/resolve-interview-<slug>.md` 에 있고 상태에 `spec_path` 가 있다.
- [ ] 원천 문서가 있으면 Step 5 확인에서 어긋난 항목이 0건이다.
- [ ] 세 `Status` 값 모두에서 다음 행동을 물었고 마지막 선택지가 `Save Spec and Stop` 이다.
- [ ] 사용자가 선택지를 고르기 전에 허용 목록 밖의 행동이 없다.
