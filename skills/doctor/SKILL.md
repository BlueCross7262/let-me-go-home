---
name: doctor
description: Diagnose a let-me-go-home install — hook registration, Ralph runtime files, the MCP server, the state root and the environment — report what is broken and how to fix it, and after approval add missing lmgh defaults to settings.json
argument-hint: "[--json]"
---

# Doctor Skill

이 스킬은 현재 프로젝트에서 이 플러그인이 Ralph 와 Deep Interview 를 실제로
돌릴 수 있는 상태인지 보고한다.
점검은 읽기 전용이다.
점검은 관찰하고 보고할 뿐이다.
점검은 아무것도 바꾸지 않는다.
사용자가 승인했을 때만 `settings.json` 의 `lmgh` 아래 비어 있는 기본값을 채운다.
그 절차는 아래 「Settings Defaults」 가 정한다.

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

한 번도 준비된 적 없는 프로젝트면 `/let-me-go-home:setup` 을 쓴다.
그 스킬은 state root 를 만든 뒤 여기와 같은 점검을 돌린다.

## Run the Diagnosis

진단 대상 프로젝트에서 실행한다:

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/doctor.mjs
```

`CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을
가리킨다.
그 플러그인이 항상 이 플러그인은 아니다.
명령이 파일이 없다고 하면 바로 그 상황이다.
그때는 `.claude-plugin/plugin.json` 의 `"name"` 이 `"let-me-go-home"` 인
디렉토리를 찾는다.
그리고 그 디렉토리에서 스크립트를 실행한다.
점검을 다시 구현해 우회하지 않는다.

`output_mode` 가 `json` 이면 `--json` 을 붙인다.
판정은 종료 상태로 한다.
`0` 은 실패한 점검이 없다는 뜻이다.
`1` 은 점검이 하나 이상 실패했다는 뜻이다.
`2` 는 진단 자체를 실행하지 못했다는 뜻이다.
텍스트에서 `FAIL` 을 찾지 않는다.
종료 상태로 판정한다.

어떤 점검도 대화 안에서 다시 구현하지 않는다.
무엇을 어떻게 점검하는지의 단일 소스는 스크립트다.
다른 도구로 두 번 돌리면 같은 질문에 답이 두 개 생길 뿐이다.

## What Each Check Means

| Check | `fail` means |
|---|---|
| `node-version` | Never fails; warns when the node running hooks is outside the supported range |
| `manifest` | The plugin root is not an installed copy of this plugin |
| `hooks` | Hook events are missing, or `hooks.json` points at scripts that are not installed |
| `ralph-modules` | A file the Ralph bootstrap or the Stop hook loads is absent |
| `mcp-server` | `.mcp.json` is missing, unparseable, or names an entry point that is not built |
| `runtime-deps` | A package declared in the plugin's `package.json` `dependencies` is not installed; warns when a package that runs an install script has no functional probe |
| `session-id` | Never fails; warns when `CLAUDE_CODE_SESSION_ID` is absent from the shell |
| `state-root` | The directory Ralph writes state into cannot be resolved or is read-only |
| `symlinks` | Never fails; warns when this account cannot create symlinks |
| `active-modes` | Never fails; warns when a loop is still live in some session |

`warn` 은 차단 사유가 아니다.
`session-id` 는 Claude Code 가 띄우지 않은 셸이면 경고한다.
`symlinks` 는 개발자 모드가 꺼진 Windows 에서 경고한다.
둘 다 플러그인을 멈추지 않는다.
다만 두 번째 경고는 테스트 스위트를 멈춘다.

## Report

스크립트가 낸 줄을 그대로 사용자에게 준다.
그리고 스크립트가 알 수 없는 것만 덧붙인다:

- 모든 점검이 통과하면 한 줄로 말한다.
  그리고 멈춘다.
  표를 다시 옮기지 않는다.
- 점검이 실패하면 실패한 점검 이름을 댄다.
  그 힌트를 그대로 인용한다.
  그리고 실행 가능한 둘 중 무엇이 막혔는지 말한다.
  둘은 Ralph 루프 시작과 루프 취소다.
- `active-modes` 가 경고하면 해당 세션을 짚는다.
  그리고 그 세션에서 `/let-me-go-home:cancel` 을 돌리는 것이 정리 방법이라고 말한다.
  여기서 루프를 치우지 않는다.
  남의 살아 있는 루프를 취소하는 것은 그쪽 결정이다.

스크립트를 돌리지 않고 점검이 통과했다고 주장하지 않는다.

## Settings Defaults

점검 보고를 마친 뒤 사용자 `settings.json` 의 `lmgh` 아래 비어 있는 기본값을 확인한다.
이 절차는 아래를 모두 만족할 때만 한다.
하나라도 어긋나면 묻지도 쓰지도 않는다:

- `output_mode` 가 `json` 이 아니다.
- 위 진단 스크립트의 종료 상태가 `0` 이다.
  `1` 이나 `2` 면 사용자가 먼저 그 문제를 고쳐야 한다.

이 절차의 실패, 질문 도구를 쓸 수 없음, 오류는 무응답으로 본다.
그때는 아무것도 쓰지 않는다.
진단의 판정은 위 종료 상태가 정한다.

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/lmgh-defaults.mjs
```

`CLAUDE_PLUGIN_ROOT` 를 찾는 방식은 위와 같다.
이 명령은 파일을 쓰지 않고 JSON 한 줄을 낸다.
`status` 가 `ok` 이고 `missing` 이 비어 있지 않을 때만 사용자에게 묻는다.
`missing` 이 비어 있으면 아무 말도 덧붙이지 않는다.
`status` 가 `unreadable` 이나 `conflict` 면 `reason` 만 한 줄로 알리고 묻지 않는다.

묻기 전에 파일 경로와 `missing` 의 키 경로와 기본값을 보여 준다.
기본값을 파일에 적으면 이후 플러그인의 기본값 변경이 이 사용자에게 적용되지 않는다는 점도 적는다.
`lmgh.executorOpencode.model` 과 `variant` 는 `executor-opencode` 가 opencode 에 넘기는 값이다.
러너가 `opencode run --model <model> --variant <variant>` 로 옮긴다.
`dir` 과 `file` 은 호출마다 만들어지므로 기본값에 없다.
이 둘을 `settings.json` 에 직접 적어도 러너가 읽지만 doctor 는 추가하지 않는다.
`AskUserQuestion` 으로 묻는다.
선택지는 「전부 추가」와 「추가하지 않음」 둘이다.
일부만 원하면 사용자가 직접 적는다.
이 질문은 진행과 중단 둘뿐이고 판단 근거가 스크립트 출력으로 이미 정해져 있다.
그래서 별도 상담 없이 바로 묻는다.

승인한 경로만 넘겨 쓴다:

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/lmgh-defaults.mjs --apply --paths <승인한 키 경로를 쉼표로 이은 것>
```

경로를 추측하지 않는다.
`missing` 에 없는 경로를 더하지 않는다.
결과의 `added` 와 `ignored` 를 보고한다.
거절하거나 응답이 없으면 쓰지 않는다.
이 스크립트 말고 다른 방법으로 `settings.json` 을 고치지 않는다.
