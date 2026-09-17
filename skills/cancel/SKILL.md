---
name: cancel
aliases: [cancel-ralph]
description: Cancel the active Ralph loop or Deep Interview and clean up this session's state
argument-hint: "[--force]"
---

# Cancel Skill

이 세션에서 활성인 모드를 취소하고 그 상태를 지운다.

Ralph 실행을 끝내는 표준 방법이다. `ralph-state.json` 이 루프를 활성이라고 말하는
동안 Stop 훅이 계속 차단하므로, 실행을 끝낸다는 것은 그 상태를 지운다는 뜻이다 —
작업이 끝났다고 선언하는 것만으로는 안 된다. 취소가 실패하거나 중단되면
`--force` 로 재시도하고, 최후 수단으로 2시간 staleness 타임아웃을 기다린다.

## What It Does

- Ralph — 지속 루프를 멈추고 그 세션의 루프 상태를 지운다.
- Deep Interview — 그 세션의 인터뷰 상태를 지운다. `.lmgh/specs/` 아래에 쓰인
  spec 은 보존한다.
- 공통 — `skill-active-state.json` 을 지워 Stop 훅이 낡은 상태를 근거로
  skill-protection 보강을 계속 쏘지 않게 한다.

## Usage

```
/let-me-go-home:cancel
```

또는 "cancel ralph", "stop ralph" 라고 말한다.

`--force` 는 현재 세션뿐 아니라 모든 세션의 상태와 레거시 프로젝트 수준 파일까지
지운다.

## Critical: Deferred Tool Handling

상태 관리 도구(`state_clear`, `state_read`, `state_write`, `state_list_active`,
`state_get_status`)는 Claude Code 에서 deferred tool 로 등록돼 있을 수 있다. 어떤
state 도구든 호출하기 전에 `ToolSearch` 로 전부 먼저 로드해야 한다:

```
ToolSearch(query="select:mcp__plugin_let-me-go-home_t__state_clear,mcp__plugin_let-me-go-home_t__state_read,mcp__plugin_let-me-go-home_t__state_write,mcp__plugin_let-me-go-home_t__state_list_active,mcp__plugin_let-me-go-home_t__state_get_status")
```

`state_clear` 를 쓸 수 없거나 실패하면 아래 bash 폴백을 Stop 훅 루프에서 빠져나오는
비상 탈출로 쓴다. 취소 흐름의 완전한 대체가 아니다 — 세션 차단을 풀려고 상태
파일을 지울 뿐이고 그 이상은 하지 않는다. 모드마다 한 번씩 실행한다.

```bash
# Fallback: direct file removal when the state_clear MCP tool is unavailable
SESSION_ID="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { d="$PWD"; while [ "$d" != "/" ] && [ ! -d "$d/.lmgh" ]; do d="$(dirname "$d")"; done; echo "$d"; })"

# Cross-platform SHA-256 (macOS: shasum, Linux: sha256sum)
sha256portable() { printf '%s' "$1" | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-16; }

# Resolve the state directory (supports LMGH_STATE_DIR centralized storage)
if [ -n "${LMGH_STATE_DIR:-}" ]; then
  SOURCE="$(git remote get-url origin 2>/dev/null || echo "$REPO_ROOT")"
  HASH="$(sha256portable "$SOURCE")"
  DIR_NAME="$(basename "$REPO_ROOT" | sed 's/[^a-zA-Z0-9_-]/_/g')"
  LMGH_STATE="$LMGH_STATE_DIR/${DIR_NAME}-${HASH}/state"
  [ ! -d "$LMGH_STATE" ] && { echo "ERROR: state dir not found at $LMGH_STATE" >&2; exit 1; }
elif [ "$REPO_ROOT" != "/" ] && [ -d "$REPO_ROOT/.lmgh" ]; then
  LMGH_STATE="$REPO_ROOT/.lmgh/state"
else
  echo "ERROR: could not locate the .lmgh state directory" >&2
  exit 1
fi
MODE="ralph"  # <-- ralph or deep-interview

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

루프를 멈추는 것은 상태 파일 제거다. Stop 훅은 취소가 stop 도중에 끼어들어도
스스로 되돌려지지 않도록 만들어져 있다:

- Stop 훅은 루프 상태를 읽고, 상태 파일이 아직 있을 때만 증가된 상태를 다시 쓴다.
  그 사이에 취소가 파일을 지웠으면 훅은 아무것도 쓰지 않고 루프는 취소된 채로
  남는다.
- 따라서: 상태 파일을 지운다. `active: false` 로 덮어쓰고 파일을 남겨두지 않는다.
  남아 있는 파일은 훅이 다시 쓸 수 있는 파일이다.
- 지운 뒤 `state_read(mode="ralph", session_id)` 로 상태가 안 돌아오는지 확인한다.
  돌아오면 취소가 안 먹은 것이다 — `--force` 로 재시도한다.

## Implementation Steps

### 1. 인자 파싱

`--force` 는 범위를 이 세션에서 모든 세션과 레거시 파일까지 넓힌다.

### 2. 무엇이 활성인지 확인

1. `state_list_active` 를 호출해 `.lmgh/state/sessions/{sessionId}/…` 를 열거하고
   활성 세션을 찾는다.
2. 세션 id 마다 `state_get_status` 를 호출해 어떤 모드가 돌고 있는지 확인한다.
3. 세션 id 를 알면 그 세션 경로 안에서만 작업한다. `.lmgh/state/*.json` 의 레거시
   프로젝트 수준 파일은 state 도구가 활성 세션이 없다고 보고할 때만 본다.

### 3. 지우기

기본 범위 — 현재 세션:

- Ralph 활성: `state_clear(mode="ralph", session_id)`. 루프의 stop-breaker 기록도
  함께 지워진다. `.lmgh/state/sessions/{sessionId}/prd.json` 의 세션 PRD 는 사후에
  실행을 살펴볼 수 있도록 일부러 남긴다. `--force` 는 세션의 나머지와 함께 이것도
  지운다.
- Deep Interview 활성: `state_clear(mode="deep-interview", session_id)`.
  `.lmgh/specs/deep-interview-{slug}.md` 의 spec 은 보존한다.
- 활성이 없음: 취소할 것이 없다고 보고하고 멈춘다.

`--force` 범위 — 활성 세션을 전부 돌며 세션마다 `state_clear` 를 호출하고, 마지막에
`session_id` 없이 `state_clear` 를 한 번 더 호출해 레거시 프로젝트 수준 파일을
떨군다.

### 4. skill-active 상태는 항상 마지막에 지운다

```
state_clear(mode="skill-active", session_id)
```

어떤 모드가 활성이었든, `--force` 여부와 무관하게 항상 한다. 낡은
`skill-active-state.json` 은 취소 후에도 Stop 훅이 skill-protection 보강을 계속
쏘게 만든다.

## Messages Reference

| Mode | Success message |
|------|-----------------|
| Ralph | "Ralph cancelled. Persistence loop deactivated." |
| Deep Interview | "Deep Interview cancelled. Spec file preserved." |
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

## Notes

- 로컬 전용: state 디렉토리 아래 파일만 지우고 그 밖은 건드리지 않는다.
- 세션 범위: `--force` 없이는 다른 세션의 상태를 절대 수정하지 않는다.
- 이 포크가 배포하지 않는 모드(autopilot, ultragoal, swarm, ultrapilot, pipeline,
  team)는 여기에 취소 경로가 없다.
