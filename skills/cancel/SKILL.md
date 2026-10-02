---
name: cancel
aliases: [cancel-ralph]
description: Cancel the active Ralph loop or Deep Interview and clean up this session's state; a phase chain is cleared only with --chain
argument-hint: "[--force] [--chain]"
---

# Cancel Skill

이 스킬은 이 세션에서 활성인 모드를 취소한다.
그리고 그 상태를 지운다.

이 스킬은 Ralph 실행을 끝내는 표준 방법이다.
Stop 훅은 `ralph-state.json` 이 루프를 활성이라고 말하는 동안 계속 차단한다.
그래서 실행을 끝낸다는 것은 그 상태를 지운다는 뜻이다.
작업이 끝났다고 선언하는 것만으로는 실행이 끝나지 않는다.
취소가 실패하거나 중단되면 `--force` 로 재시도한다.
최후 수단으로 2시간 staleness 타임아웃을 기다린다.

## What It Does

- Ralph — 지속 루프를 멈춘다.
  그리고 그 세션의 루프 상태를 지운다.
- Deep Interview — 그 세션의 인터뷰 상태를 지운다.
  `.lmgh/specs/` 아래에 쓰인 spec 은 보존한다.
- Phase chain — `phase-loop`(옛 `phase-run`)이 켠 `phase-chain` 상태를 지운다.
  `--chain` 이 있을 때만 지운다.
  인자 없는 취소는 체인을 지우지 않는다.
- 공통 — 세션의 `skill-active-state.json` 을 지운다.
  Stop 훅(`scripts/ralph-stop.mjs`)은 이 파일의 `active_skills[mode].completed_at` 을 그 모드를
  24시간 비활성으로 보는 표시로 읽는다.
  이 호출은 그 세션의 기록을 비운다.

## Usage

```
/let-me-go-home:cancel
```

또는 "cancel ralph", "stop ralph" 라고 말한다.

`--force` 는 현재 세션뿐 아니라 모든 세션의 상태와 프로젝트 수준의 레거시 파일까지
지운다.
`--force` 는 `phase-chain` 상태를 지우지 않는다.

`--chain` 은 `phase-chain` 상태도 지운다.
`phase-loop`(옛 `phase-run`) 체인을 멈출 때 쓴다.

## Critical: Deferred Tool Handling

Claude Code 는 상태 관리 도구(`state_clear`, `state_read`, `state_write`,
`state_list_active`, `state_get_status`)를 deferred tool 로 등록할 수 있다.
state 도구를 하나라도 호출하기 전에 `ToolSearch` 로 전부 먼저 로드한다:

```
ToolSearch(query="select:mcp__plugin_let-me-go-home_t__state_clear,mcp__plugin_let-me-go-home_t__state_read,mcp__plugin_let-me-go-home_t__state_write,mcp__plugin_let-me-go-home_t__state_list_active,mcp__plugin_let-me-go-home_t__state_get_status")
```

`state_clear` 를 쓸 수 없거나 실패하면 아래 bash 폴백을 비상 탈출로 쓴다.
이 폴백은 Stop 훅 루프에서 빠져나오는 수단이다.
이 폴백은 취소 흐름의 완전한 대체가 아니다.
이 폴백은 세션 차단을 풀려고 상태 파일을 지울 뿐이다.
그 이상은 하지 않는다.
모드마다 한 번씩 실행한다.

폴백은 상태 디렉토리를 먼저 플러그인의 `scripts/lib/state-root.mjs` 로 찾는다.
훅과 state 도구가 쓰는 해석과 같다.
`CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을 가리킨다.
그 플러그인이 항상 이 플러그인은 아니다.
`PLUGIN_DIR` 에 `scripts/lib/state-root.mjs` 가 없으면 바로 그 상황이다.
그때는 `.claude-plugin/plugin.json` 의 `"name"` 이 `"let-me-go-home"` 인 디렉토리를
찾아 `PLUGIN_DIR` 에 넣는다.
node 해석이 실패하면 순수 bash 계산으로 내려간다.
그 계산은 `.lmgh-workspace` 마커, 서브모듈의 superproject, `$HOME/.lmgh` 를 모른다.

```bash
# Fallback: direct file removal when the state_clear MCP tool is unavailable
SESSION_ID="${CLAUDE_CODE_SESSION_ID:-${LMGH_SESSION_ID:-${CLAUDE_SESSION_ID:-}}}"
PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-}"  # must be the let-me-go-home plugin directory
BASE="$(git rev-parse --show-toplevel 2>/dev/null || pwd -W 2>/dev/null || pwd)"

# Primary: the plugin's own resolver, the one the hooks and state tools use
LMGH_ROOT=""
if [ -n "$PLUGIN_DIR" ] && [ -f "$PLUGIN_DIR/scripts/lib/state-root.mjs" ]; then
  LMGH_ROOT="$(CLAUDE_PLUGIN_ROOT="$PLUGIN_DIR" node --input-type=module -e 'import { pathToFileURL } from "node:url"; const m = await import(pathToFileURL(process.argv[1]).href); console.log(await m.resolveLmghStateRoot(process.argv[2]));' "$PLUGIN_DIR/scripts/lib/state-root.mjs" "$BASE" 2>/dev/null | tr '\\' '/')"
fi

if [ -n "$LMGH_ROOT" ]; then
  LMGH_STATE="$LMGH_ROOT/state"
else
  # Secondary: pure bash, for when node or the plugin files are unavailable.
  # It does not know the .lmgh-workspace marker, submodule superprojects or $HOME/.lmgh.
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { d="$PWD"; while [ "$d" != "/" ] && [ ! -d "$d/.lmgh" ]; do d="$(dirname "$d")"; done; echo "$d"; })"

  # Cross-platform SHA-256 (macOS: shasum, Linux: sha256sum)
  sha256portable() { printf '%s' "$1" | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-16; }

  if [ -n "${LMGH_STATE_DIR:-}" ]; then
    SOURCE="$(git remote get-url origin 2>/dev/null || echo "$REPO_ROOT")"
    HASH="$(sha256portable "$SOURCE")"
    DIR_NAME="$(basename "$REPO_ROOT" | sed 's/[^a-zA-Z0-9_-]/_/g')"
    LMGH_STATE="$LMGH_STATE_DIR/${DIR_NAME}-${HASH}/state"
  elif [ "$REPO_ROOT" != "/" ] && [ -d "$REPO_ROOT/.lmgh" ]; then
    LMGH_STATE="$REPO_ROOT/.lmgh/state"
  else
    echo "ERROR: could not locate the .lmgh state directory" >&2
    exit 1
  fi
fi
[ -d "$LMGH_STATE" ] || { echo "ERROR: state dir not found at $LMGH_STATE" >&2; exit 1; }
MODE="ralph"  # <-- ralph, deep-interview or phase-chain

if [ -n "$SESSION_ID" ] && [ -d "$LMGH_STATE/sessions/$SESSION_ID" ]; then
  rm -f "$LMGH_STATE/sessions/$SESSION_ID/${MODE}-state.json"
  rm -f "$LMGH_STATE/sessions/$SESSION_ID/${MODE}-stop-breaker.json"
  rm -f "$LMGH_STATE/sessions/$SESSION_ID/skill-active-state.json"
fi

# Clear legacy project-level state only when there is no session id,
# so another session's state is never touched.
if [ -z "$SESSION_ID" ]; then
  rm -f "$LMGH_STATE/${MODE}-state.json"
fi
```

## Race Protection

루프를 멈추는 수단은 상태 파일 제거다.
Stop 훅은 취소가 stop 도중에 끼어들어도 그 취소를 되돌리지 않는다:

- Stop 훅은 루프 상태를 읽는다.
  그리고 상태 파일이 아직 있을 때만 증가된 상태를 다시 쓴다.
  그 사이에 취소가 파일을 지웠으면 훅은 아무것도 쓰지 않는다.
  그러면 루프는 취소된 채로 남는다.
- 따라서: 상태 파일을 지운다.
  파일을 `active: false` 로 덮어쓴 채 남겨두지 않는다.
  남아 있는 파일은 훅이 다시 쓸 수 있는 파일이다.
- 지운 뒤 `state_read(mode="ralph", session_id)` 로 상태가 안 돌아오는지 확인한다.
  상태가 돌아오면 취소가 안 먹은 것이다.
  그때는 `--force` 로 재시도한다.

## Implementation Steps

### 1. 인자 파싱

`--force` 는 범위를 이 세션에서 모든 세션과 레거시 파일까지 넓힌다.
`--chain` 은 지우는 모드에 `phase-chain` 을 더한다.
두 인자는 함께 쓸 수 있다.

### 2. 무엇이 활성인지 확인

1. `state_list_active` 를 호출해 `.lmgh/state/sessions/{sessionId}/…` 를 열거한다.
   그리고 활성 세션을 찾는다.
2. 세션 id 마다 `state_get_status` 를 호출해 어떤 모드가 돌고 있는지 확인한다.
3. 세션 id 를 알면 그 세션 경로 안에서만 작업한다.
   `.lmgh/state/*.json` 의 프로젝트 수준의 레거시 파일은 state 도구가 활성 세션이
   없다고 보고할 때만 본다.

### 3. 지우기

기본 범위 — 현재 세션:

- Ralph 활성: `state_clear(mode="ralph", session_id)`.
  이 호출은 루프의 stop-breaker 기록도 함께 지운다.
  `.lmgh/state/sessions/{sessionId}/prd.json` 의 세션 PRD 는 일부러 남긴다.
  사후에 실행을 살펴볼 수 있게 하기 위해서다.
  `--force` 는 세션의 나머지와 함께 이 PRD 도 지운다.
- Deep Interview 활성: `state_clear(mode="deep-interview", session_id)`.
  `.lmgh/specs/deep-interview-{slug}.md` 의 spec 은 보존한다.
- Phase chain 활성: `--chain` 이 있을 때만 `state_clear(mode="phase-chain", session_id)` 를
  호출한다.
  체인 도중 ralph Step 8 이 부르는 인자 없는 취소가 체인을 끄지 않게 하기 위해서다.
  ralph 가 하드 상한으로 이미 비활성이어도 같다.
- 인자 없는 취소인데 체인만 활성이면 체인을 지우지 않는다.
  「Phase chain is active. Run /let-me-go-home:cancel --chain to stop it.」 를 보고한다.
  「취소할 것이 없다」로 보고하지 않는다.
- 활성이 없음: 취소할 것이 없다고 보고한다.
  그리고 멈춘다.

`--force` 범위 — 활성 세션을 전부 돌며 세션마다 `state_clear` 를 호출한다.
마지막에 `session_id` 없이 `state_clear` 를 한 번 더 호출한다.
그 호출은 프로젝트 수준의 레거시 파일을 떨군다.
이 순회와 마지막 호출은 `phase-chain` 모드를 건너뛴다.
`--chain` 이 함께 있을 때만 `phase-chain` 도 지운다.
이 스킬과 Ralph Stop 훅 문구가 `--force` 재시도를 저절로 안내하므로, 그 재시도가
도는 체인을 끄지 않게 하기 위해서다.

### 4. skill-active 상태는 항상 마지막에 지운다

```
state_clear(mode="skill-active", session_id)
```

이 호출을 어떤 모드가 활성이었든 항상 실행한다.
`--force` 여부와도 무관하다.
이 파일은 Stop 훅이 모드의 완료 여부를 읽는 세션 기록이다.
취소 뒤 이전 실행의 기록을 다음 실행에 남기지 않는다.
이 호출이 실패하면 그 세션의 취소는 미해결이다.
그 세션을 취소 완료로 보고하지 않는다.

## Messages Reference

| Mode | Success message |
|------|-----------------|
| Ralph | "Ralph cancelled. Persistence loop deactivated." |
| Deep Interview | "Deep Interview cancelled. Spec file preserved." |
| Phase chain (`--chain`) | "Phase chain cancelled. The chain state file is preserved." |
| Phase chain only, no `--chain` | "Phase chain is active. Run /let-me-go-home:cancel --chain to stop it." |
| Force | "All state cleared. You are free to start fresh." |
| None | "No active mode detected." |

## What Gets Preserved

| Item | Preserved | Note |
|------|-----------|------|
| Ralph loop state | No | Clearing it is what ends the loop |
| Session PRD (`prd.json`) | Yes, unless `--force` | Kept for post-run inspection |
| Ralph task text (`ralph-prompt.md`) | Yes | Full task description the bootstrap copied beside the session state |
| `progress.txt` | Yes | Append-only run history |
| Deep Interview state | No | |
| Deep Interview spec | Yes | `.lmgh/specs/deep-interview-{slug}.md` |
| Phase chain mode state | Yes, unless `--chain` | `phase-chain-state.json`. Cleared only when `--chain` is given |
| Phase chain state file | Yes | `phase-loop.state.json`, or the older `phase-run.state.json`, under the chain's output folder |

## Notes

- 로컬 전용: state 디렉토리 아래 파일만 지운다.
  그 밖은 건드리지 않는다.
- 세션 범위: `--force` 없이는 다른 세션의 상태를 절대 수정하지 않는다.
- 보고 정확성: 취소 보고에 고른 범위, 발견한 모드, 성공한 호출과 실패한 호출,
  남긴 기록을 적는다.
  타임아웃, 세션 신원 누락, 잘못된 형식의 상태, state 도구 실패를 성공 메시지로
  바꾸지 않는다.
  현재 세션 취소 성공은 다른 세션이나 프로젝트 수준 레거시 파일을 건드렸다는 뜻이
  아니다.
- 이 포크가 배포하지 않는 모드(autopilot, ultragoal, swarm, ultrapilot, pipeline,
  team)는 여기에 취소 경로가 없다.
