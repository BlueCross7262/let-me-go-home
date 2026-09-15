---
name: doctor
description: Diagnose a let-me-go-home install — hook registration, Ralph runtime files, the MCP server, the state root and the environment — and report what is broken and how to fix it
argument-hint: "[--json]"
---

# Doctor Skill

현재 프로젝트에서 이 플러그인이 Ralph 와 Deep Interview 를 실제로 돌릴 수 있는
상태인지 보고한다. 읽기 전용이다 — 관찰하고 보고할 뿐 아무것도 바꾸지 않는다.

## Variables

| Variable | Type | Fixed at | Source | Default |
|---|---|---|---|---|
| `output_mode` | `text` or `json` | argument parsing | `--json` in the invocation | `text` |

## Best-Fit Use

플러그인이 설치돼 있는데 동작이 이상할 때 돌린다:

- Ralph 가 시작했다가 한 턴 만에 멈춘다.
- `/let-me-go-home:cancel` 이 state 도구를 쓸 수 없다고 보고한다.
- compaction 이후 세션이 Ralph 맥락을 복원하지 않는다.
- 새로 clone 했거나 새 머신이라, 설치를 믿기 전에 확인하려는 경우.

한 번도 준비된 적 없는 프로젝트면 `/let-me-go-home:setup` 을 쓴다. state root
를 만든 뒤 여기와 같은 점검을 돌린다.

## Run the Diagnosis

진단 대상 프로젝트에서 실행한다:

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/doctor.mjs
```

`CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을
가리키며, 그것이 항상 이 플러그인은 아니다. 명령이 파일이 없다고 하면 바로 그
상황이다. `.claude-plugin/plugin.json` 의 `"name"` 이 `"let-me-go-home"` 인
디렉토리를 찾아 거기서 스크립트를 실행한다. 점검을 다시 구현해 우회하지
않는다.

`output_mode` 가 `json` 이면 `--json` 을 붙인다. 판정은 종료 상태다: `0` 은
실패한 점검 없음, `1` 은 하나 이상 실패, `2` 는 진단 자체가 실행되지 못함.
텍스트에서 `FAIL` 을 찾지 말고 종료 상태로 판정한다.

어떤 점검도 대화 안에서 다시 구현하지 않는다. 무엇을 어떻게 점검하는지의 단일
소스는 스크립트다. 다른 도구로 두 번 돌리면 같은 질문에 답이 두 개 생길
뿐이다.

## What Each Check Means

| Check | `fail` means |
|---|---|
| `node-version` | Never fails; warns when the node running hooks is outside the supported range |
| `manifest` | The plugin root is not an installed copy of this plugin |
| `hooks` | Hook events are missing, or `hooks.json` points at scripts that are not installed |
| `ralph-modules` | A file the Ralph bootstrap or the Stop hook loads is absent |
| `mcp-server` | `.mcp.json` is missing, unparseable, or names an entry point that is not built |
| `native-deps` | `better-sqlite3` does not resolve, or resolves but cannot open a database because its compiled binding was never built |
| `runtime-deps` | A package declared in the plugin's `package.json` `dependencies` is not installed; warns when a package that runs an install script has no functional probe |
| `session-id` | Never fails; warns when `CLAUDE_CODE_SESSION_ID` is absent from the shell |
| `state-root` | The directory Ralph writes state into cannot be resolved or is read-only |
| `symlinks` | Never fails; warns when this account cannot create symlinks |
| `active-modes` | Never fails; warns when a loop is still live in some session |

`warn` 은 차단 사유가 아니다. `session-id` 는 Claude Code 가 띄우지 않은 셸이면
경고하고, `symlinks` 는 개발자 모드가 꺼진 Windows 에서 경고한다. 둘 다
플러그인을 멈추지 않는다. 다만 두 번째는 테스트 스위트를 멈춘다.

## Report

스크립트가 낸 줄을 그대로 사용자에게 주고, 스크립트가 알 수 없는 것만 덧붙인다:

- 모든 점검이 통과하면 한 줄로 말하고 멈춘다. 표를 다시 옮기지 않는다.
- 점검이 실패하면 실패한 점검 이름을 대고, 힌트를 그대로 인용하고, 실행 가능한
  둘 중 무엇이 막혔는지 말한다 — Ralph 루프 시작인지, 루프 취소인지.
- `active-modes` 가 경고하면 해당 세션을 짚고, 그 세션에서
  `/let-me-go-home:cancel` 을 돌리는 것이 정리 방법이라고 말한다. 여기서
  치우지 않는다 — 남의 살아 있는 루프를 취소하는 것은 그쪽 결정이다.

스크립트를 돌리지 않고 점검이 통과했다고 주장하지 않는다.
