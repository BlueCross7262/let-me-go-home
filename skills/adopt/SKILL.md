---
name: adopt
description: Take over a Ralph loop that another session started — move its state, prd and control record to the current session, then continue the loop from the next story
argument-hint: "[--from <session-id>] [--force]"
---

# Adopt Skill

다른 세션이 시작한 Ralph 루프를 지금 세션이 이어받는 스킬이다.
세션 id 가 바뀌면 Stop 훅은 옛 세션의 루프를 새 세션에 적용하지 않는다.
그래서 루프 상태와 제어 레코드를 새 세션 id 로 옮겨야 한다.
이 스킬은 그 이관과 이관 뒤 재진입을 맡는다.

대상은 Ralph 하나다.
세션을 시작할 때 이 스킬을 자동으로 안내하지 않는다.
사용자가 불렀을 때만 쓴다.

## 스크립트 위치

스크립트는 이 스킬 폴더 기준 `../../scripts/session-adopt.mjs` 다.
이 스킬을 부르면 붙는 `Base directory for this skill` 경로를 기준으로 절대경로를 만든다.
`CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을 가리킨다.
그 플러그인이 항상 이 플러그인은 아니므로 쓰지 않는다.

```bash
node "<Base directory>/../../scripts/session-adopt.mjs" <list|take> [options]
```

현재 세션 id 는 `CLAUDE_CODE_SESSION_ID` 에서 온다.
그 값이 없을 때만 `--session-id <id>` 를 넘긴다.

`--project-dir` 에는 세션의 작업 디렉토리를 환경 설명의 `Primary working directory` 에 적힌 그대로 넣는다.
git 루트로 바꾸지 않는다.
셸의 `$PWD` 를 쓰지 않는다.
Stop 훅은 루프 레코드의 `project_path` 를 훅 입력의 `cwd` 와 정확히 비교한다.
Windows 의 Git Bash 에서 `$PWD` 는 `/e/...` 형태라 그 비교가 어긋난다.

## Step 1 — 후보를 본다

```bash
node "<script>" list --project-dir "<작업 디렉토리>"
```

출력의 `sessions` 는 이 저장소에서 `ralph-state.json` 이 있는 세션이다.
세션마다 아래를 낸다.

- `active` — 루프 상태의 `active` 값이다.
- `iteration`, `max_iterations` — 루프 진행이다.
- `project_path` — 루프가 묶인 디렉토리다.
- `last_activity` — 상태와 제어 레코드의 마지막 갱신 시각이다.
- `fresh` — 마지막 갱신이 2시간 안이면 `true` 다. 그 세션이 아직 돌고 있을 수 있다.
- `holds` — Stop 훅이 지금 그 세션을 붙잡는지다. 제어 레코드가 살아 있고 `project_path` 가 `--project-dir` 와 같으면 `true` 다.
- `has_prd` — 세션 PRD 가 있는지다.

`--from` 이 인자로 오면 그 세션을 대상으로 한다.
없으면 `active` 가 `true` 인 후보를 표로 보여 주고 `AskUserQuestion` 으로 고르게 한다.
후보가 없으면 「이어받을 루프가 없다」 로 보고하고 멈춘다.
`fresh` 가 `true` 인 후보는 사용자에게 그 사실을 함께 알린다.

## Step 2 — 이관한다

```bash
node "<script>" take --from <session-id> --project-dir "<작업 디렉토리>" [--force]
```

스크립트가 하는 일은 아래 순서다.

- 원본의 `ralph-state.json` 과 첫째 계층 제어 레코드를 읽는다.
- 아래 중 하나라도 걸리면 아무것도 쓰지 않고 거부한다.
  - 원본이 활성 루프가 아니다.
  - 작업 디렉토리가 원본 `project_path` 와 다르다. `--force` 로도 풀리지 않는다.
  - 원본이 2시간 안에 활성이었다. `--force` 로 푼다.
  - 목적지에 `ralph-state.json`, `prd.json`, `ralph-prompt.md` 가 이미 있다.
  - 목적지에 활성 Ralph 제어 레코드가 있다.
  - 목적지 첫째 계층을 다른 owner 가 가졌다.
- 목적지에 `prd.json`, 태스크 전문 파일, `ralph-state.json`, 제어 레코드 순으로 쓴다.
  쓰기가 하나라도 실패하면 쓴 파일을 지우고 원본을 그대로 둔다.
- `progress.txt` 에 원본 세션의 마지막 `execute-type` 줄과 `refine-check: pass` 줄의 복사본을 `session=<현재 세션>` 으로 덧붙인다.
  기존 줄은 고치지 않는다.
- 목적지의 `ralph` 와 `first-stop` tombstone 슬롯을 지운다.
  24시간 안에 끝난 Ralph 가 있으면 훅이 새 세션을 붙잡지 않기 때문이다.
- 마지막에 원본 제어 레코드를 먼저 지우고 나머지 원본 파일을 지운다.
  지우지 못한 파일은 `leftover` 로 보고한다.

종료 상태가 `0` 이 아니면 거기서 멈추고 스크립트가 낸 사유를 보고한다.
이관은 일어나지 않았고 원본은 그대로다.

## Step 3 — 루프를 이어간다

이관이 성공하면 `Skill("let-me-go-home:ralph")` 를 부르지 않는다.
그 스킬의 Startup_Gate 가 `ralph-bootstrap.mjs` 를 실행해 이터레이션을 1 로 되돌리고 새 루프를 쓴다.

대신 아래 순서를 따른다.

- `../ralph/SKILL.md` 를 읽는다.
- 원래 작업 설명은 이관된 `ralph-state.json` 의 `prompt_file` 이 가리키는 파일에서 읽는다.
- `Startup_Gate` 와 `Steps` 의 1 번(PRD Setup)은 하지 않는다.
  PRD 와 루프 상태는 이관돼 있다.
- `Steps` 의 2 번(다음 story 선택)부터 이어간다.
  `Execution_Policy` 와 `Escalation_And_Stop_Conditions` 는 그대로 따른다.
- 보고에 이관 결과(원본 세션, 목적지 세션, `leftover`, 덧붙인 `progress.txt` 줄)를 한 번 싣는다.
