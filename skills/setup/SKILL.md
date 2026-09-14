---
name: setup
description: Prepare a project for let-me-go-home — create the state root Ralph and Deep Interview write into, keep it out of git, and confirm the install is usable
argument-hint: "[--check-only] [--json]"
---

# Setup Skill

현재 프로젝트를 이 플러그인이 쓸 수 있게 준비하고, 쓸 수 있는 상태인지 확인한다.

플러그인 설치는 Claude Code 의 몫이다. `hooks/hooks.json`,
`.claude-plugin/plugin.json` 이 선언한 스킬, `.mcp.json` 의 MCP 서버를 알아서
등록한다. 이 포크는 `dist/` 와 `bridge/` 를 빌드된 상태로 배포하므로 빌드
단계도 없다. 남는 것은 하나다 — Ralph 와 Deep Interview 가 세션별 파일을 전부
쓰는 state root. 이 스킬이 그것을 만들고, 프로젝트 커밋에서 빼고,
`/let-me-go-home:doctor` 와 같은 점검 결과를 보고한다.

MCP 서버와 Ralph 루프는 둘 다 네이티브 모듈이라 번들할 수 없는
`better-sqlite3` 을 로드한다. 플러그인 디렉토리에 `node_modules` 가 없으면 state
툴 5종이 뜨지 않고 `/let-me-go-home:ralph` 도 시작하지 못한다. 훅 3종은 정상
응답하지만 작동할 루프가 없다. 이 스킬의 점검이 그 상황을 `native-deps` 와
`mcp-tools` 두 항목의 실패로 잡고 플러그인 루트에서
`npm install --omit=dev` 를 돌리라고 말한다. 이 스킬은 그 명령을 대신 실행하지
않는다 — 사용자 프로젝트가 아니라 플러그인 설치 위치를 바꾸는 일이라서다.

멱등이다. 이미 준비된 프로젝트에서 돌리면 아무것도 만들지 않고 보고만 한다.

## Variables

| Variable | Type | Fixed at | Source | Default |
|---|---|---|---|---|
| `run_mode` | `prepare` or `check-only` | argument parsing | `--check-only` in the invocation | `prepare` |
| `output_mode` | `text` or `json` | argument parsing | `--json` in the invocation | `text` |

## Best-Fit Use

- 이 플러그인을 한 번도 쓴 적 없는 프로젝트.
- 새로 clone 한 저장소, 새 worktree, 새 머신.
- `LMGH_STATE_DIR` 를 바꾼 뒤. state root 위치가 달라진다.

설치가 한 번 됐는데 이후에 뭔가 깨진 상황이면 `/let-me-go-home:doctor` 를
쓴다. 준비 단계만 뺀 같은 점검이다.

## What It Changes

두 가지, 둘 다 프로젝트 안이다:

- state root 와 그 하위 `state/sessions/` 를 만든다.
- state root 를 `.gitignore` 에 덧붙인다. 파일이 없으면 만든다. 같은 경로에
  대한 기존 ignore 규칙이 있으면 건드리지 않는다.

`LMGH_STATE_DIR` 때문에 state root 가 프로젝트 밖에 있으면 `.gitignore` 단계를
건너뛴다. 프로젝트 안에 ignore 할 것이 없다.

`CLAUDE.md` 를 고치지 않고, `settings.json` 을 고치지 않고, 아무것도 설치하지
않고, state root 밖에 쓰지 않는다.

## Run Setup

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/setup.mjs
```

`CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을
가리키며, 그것이 항상 이 플러그인은 아니다. 명령이 파일이 없다고 하면 바로 그
상황이다. `.claude-plugin/plugin.json` 의 `"name"` 이 `"let-me-go-home"` 인
디렉토리를 찾아 거기서 스크립트를 실행한다. state root 를 손으로 만들지
않는다 — 스크립트가 어디에 있어야 하는지 계산하며, 추측으로 만들면 훅이 보지
않는 자리에 생긴다.

`run_mode` 가 `check-only` 면 `--check-only` 를 붙인다. 위 두 변경을 건너뛰고
보고만 한다. `output_mode` 가 `json` 이면 `--json` 을 붙인다.

판정은 종료 상태다: `0` 은 준비 완료, `1` 은 아직 실패하는 점검이 있음, `2` 는
setup 자체가 실행되지 못함. 텍스트를 읽지 말고 종료 상태로 판정한다.

## Report

무엇이 바뀌었는지부터 말한다. 사용자가 볼 수 없는 부분이 그것이다:

- 어떤 디렉토리가 만들어졌는지, `.gitignore` 를 건드렸는지 말한다. 아무것도
  만들어지지 않았으면 이미 준비된 프로젝트였다고 말한다.
- 그다음 점검 결과를 낸다. 전부 통과면 한 줄이면 충분하다.
- 점검이 실패하면 그 이름을 대고, 힌트를 그대로 인용하고, 멈춘다. 실패한
  점검이 있으면 준비된 것이 아니고, 디렉토리를 만든 것으로 해결되지 않는다.

점검이 실패한 경우가 아니면 사용자에게 다른 것을 더 실행하라고 하지 않는다.
