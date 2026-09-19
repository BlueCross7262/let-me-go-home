---
name: setup
description: Prepare a project for let-me-go-home — create the state root Ralph and Deep Interview write into, keep it out of git, and confirm the install is usable
argument-hint: "[--check-only] [--json]"
---

# Setup Skill

이 스킬은 현재 프로젝트를 이 플러그인이 쓸 수 있게 준비한다.
그리고 쓸 수 있는 상태인지 확인한다.

플러그인 설치는 Claude Code 의 몫이다.
Claude Code 는 `hooks/hooks.json`, `.claude-plugin/plugin.json` 이 선언한 스킬,
`.mcp.json` 의 MCP 서버를 알아서 등록한다.
이 포크는 `dist/` 와 `bridge/` 를 빌드된 상태로 배포한다.
그래서 빌드 단계도 없다.
남는 것은 하나다.
그것은 Ralph 와 Deep Interview 가 세션별 파일을 전부 쓰는 state root 다.
이 스킬은 그 state root 를 만든다.
그리고 state root 를 프로젝트 커밋에서 뺀다.
그리고 `/let-me-go-home:doctor` 와 같은 점검 결과를 보고한다.

이 플러그인에는 네이티브 모듈이 없다.
남은 런타임 의존은 `zod` 하나다.
그 패키지는 순수 JavaScript 라 설치 script 를 건너뛴 설치에서도 정상 동작한다.
MCP 서버 번들은 `bridge/mcp-server.cjs` 하나로 자족한다.
그 번들은 Node 내장 모듈 밖으로 나가지 않는다.
플러그인 디렉토리에 `node_modules` 가 없으면 `mcp-tools` 점검이 그 상황을 실패로
잡는다.
그리고 플러그인 루트에서 `npm install --omit=dev` 를 돌리라고 말한다.
이 스킬은 그 명령을 대신 실행하지 않는다.
그 명령은 사용자 프로젝트가 아니라 플러그인 설치 위치를 바꾸기 때문이다.

상태 변경 잠금은 하드링크 기반 파일 잠금이다.
배타 생성은 임시 파일을 `wx` 로 연 뒤 `linkSync` 로 옮기는 방식이다.
그래서 빈 경로를 정확히 하나의 소유자만 가져간다.
죽은 소유자 회수는 `<lock>.reclaiming` 마커를 같은 방식으로 잡는다.
그리고 그 안에서 사망 판정을 다시 읽는다.
받아들인 위험이 하나 있다.
reclaimer 가 그 마커를 쥔 채 죽으면 이후 두 reclaimer 가 그 stale 마커를 각각
지운다.
그다음 두 reclaimer 는 서로의 새 마커를 지워 동시에 회수 구간에 들어갈 수 있다.
그 창은 콜백을 품지 않는다.
그 창의 길이는 마이크로초 단위다.

이 스킬은 멱등이다.
이미 준비된 프로젝트에서 돌리면 아무것도 만들지 않는다.
그때는 보고만 한다.

## Variables

| Variable | Type | Fixed at | Source | Default |
|---|---|---|---|---|
| `run_mode` | `prepare` or `check-only` | argument parsing | `--check-only` in the invocation | `prepare` |
| `output_mode` | `text` or `json` | argument parsing | `--json` in the invocation | `text` |

## Best-Fit Use

- 이 플러그인을 한 번도 쓴 적 없는 프로젝트.
- 새로 clone 한 저장소, 새 worktree, 새 머신.
- `LMGH_STATE_DIR` 를 바꾼 뒤. state root 위치가 달라진다.

설치가 한 번 됐는데 이후에 뭔가 깨진 상황이면 `/let-me-go-home:doctor` 를 쓴다.
그 스킬은 준비 단계만 뺀 같은 점검이다.

## What It Changes

이 스킬은 두 가지를 바꾼다.
둘 다 프로젝트 안이다:

- state root 와 그 하위 `state/sessions/` 를 만든다.
- state root 를 `.gitignore` 에 덧붙인다.
  파일이 없으면 만든다.
  같은 경로에 대한 기존 ignore 규칙이 있으면 건드리지 않는다.

`LMGH_STATE_DIR` 때문에 state root 가 프로젝트 밖에 있으면 `.gitignore` 단계를
건너뛴다.
그때는 프로젝트 안에 ignore 할 것이 없다.

이 스킬은 `CLAUDE.md` 를 고치지 않는다.
`settings.json` 을 고치지 않는다.
아무것도 설치하지 않는다.
state root 밖에 쓰지 않는다.

## Run Setup

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/setup.mjs
```

`CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을
가리킨다.
그 플러그인이 항상 이 플러그인은 아니다.
명령이 파일이 없다고 하면 바로 그 상황이다.
그때는 `.claude-plugin/plugin.json` 의 `"name"` 이 `"let-me-go-home"` 인
디렉토리를 찾는다.
그리고 그 디렉토리에서 스크립트를 실행한다.
state root 를 손으로 만들지 않는다.
state root 가 어디에 있어야 하는지는 스크립트가 계산한다.
추측으로 만들면 state root 가 훅이 보지 않는 자리에 생긴다.

`run_mode` 가 `check-only` 면 `--check-only` 를 붙인다.
그러면 스크립트는 위 두 변경을 건너뛰고 보고만 한다.
`output_mode` 가 `json` 이면 `--json` 을 붙인다.

판정은 종료 상태로 한다.
`0` 은 준비가 끝났다는 뜻이다.
`1` 은 아직 실패하는 점검이 있다는 뜻이다.
`2` 는 setup 자체를 실행하지 못했다는 뜻이다.
판정할 때 텍스트를 읽지 않는다.
종료 상태로 판정한다.

## Report

무엇이 바뀌었는지부터 말한다.
사용자가 볼 수 없는 부분이 그것이다:

- 스크립트가 어떤 디렉토리를 만들었는지 말한다.
  `.gitignore` 를 건드렸는지 말한다.
  스크립트가 아무것도 만들지 않았으면 이미 준비된 프로젝트였다고 말한다.
- 그다음 점검 결과를 낸다.
  전부 통과면 한 줄로 쓴다.
- 점검이 실패하면 그 이름을 댄다.
  그 힌트를 그대로 인용한다.
  그리고 멈춘다.
  실패한 점검이 있으면 준비된 것이 아니다.
  디렉토리를 만든 것으로는 그 실패를 해결하지 못한다.

점검이 실패한 경우가 아니면 사용자에게 다른 것을 더 실행하라고 하지 않는다.
