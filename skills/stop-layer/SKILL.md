---
name: stop-layer
description: Hold the session with a Stop hook layer owned by another skill — turn a layer on, refresh it while the work runs, turn it off when the work ends, and show the three layers
argument-hint: "<on|refresh|off|status> --owner <name> [--layer auto|first|second|third] [--max-iterations N]"
---

# Stop Layer Skill

다른 스킬이 작업 중에 세션을 붙잡고 싶을 때 쓰는 스킬이다.
Stop 훅(`hooks/ralph-stop.mjs`)은 세션 디렉토리의 세 계층 레코드를 읽는다.
`first-stop-state.json`, `second-stop-state.json`, `third-stop-state.json` 이다.
훅은 first, second, third 순으로 보고 살아 있는 첫 계층만 결정한다.
이 스킬은 그 레코드를 쓰고 갱신하고 끈다.
스킬이 레코드 JSON 을 손으로 쓰지 않게 하기 위한 스킬이다.

## 스크립트 위치

스크립트는 이 스킬 폴더 기준 `../../scripts/stop-layer.mjs` 다.
이 스킬을 부르면 붙는 `Base directory for this skill` 경로를 기준으로 절대경로를 만든다.
`CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을 가리킨다.
그 플러그인이 항상 이 플러그인은 아니므로 쓰지 않는다.

```bash
node "<Base directory>/../../scripts/stop-layer.mjs" <command> [options]
```

## 공통 규칙

- 세션 id 는 `--session-id`, `CLAUDE_CODE_SESSION_ID`, `LMGH_SESSION_ID` 순으로 찾는다.
  셋 다 없으면 실패한다.
- `--project-dir` 는 `on` 에서 필수다.
  값은 레코드의 `project_path` 에 그대로 들어간다.
- Stop 훅은 `project_path` 를 훅 입력의 `cwd` 와 정확히 비교한다.
  그래서 세션의 작업 디렉토리를 환경 설명의 `Primary working directory` 에 적힌 그대로 넣는다.
  git 루트로 바꾸지 않는다.
  셸의 `$PWD` 를 쓰지 않는다.
  Windows 의 Git Bash 에서 `$PWD` 는 `/e/...` 형태라 훅의 `cwd` 와 어긋난다.
- `--project-dir` 는 절대경로이고 존재하는 디렉토리여야 한다.
- 출력은 JSON 한 개다.
- 종료 상태는 아래와 같다.
  - `0` — 성공.
  - `1` — 입력 오류나 쓰기 실패.
  - `4` — 할 일이 없다. `refresh`·`off` 에서 그 owner 의 계층이 없을 때다.

## on

계층 레코드를 쓴다.

```bash
node "<script>" on --owner <name> --project-dir "<작업 디렉토리>" [--layer auto|first|second|third] [--max-iterations 100]
```

- `--owner` 는 `[a-z0-9-]+` 이름이다. 이 이름이 레코드의 소유자다.
- `--layer` 의 기본값은 `auto` 다.
  - 이미 그 owner 가 가진 계층이 있으면 그 계층을 쓴다.
  - 없으면 `second`, `third`, `first` 순으로 비었거나 비활성이거나 stale 인 첫 계층을 쓴다.
  - Ralph 는 `first`, phase chain 은 `third` 를 쓰므로 그 둘과 부딪히지 않게 `second` 를 먼저 본다.
  - 세 계층이 모두 다른 owner 에게 잡혀 있으면 실패한다.
- 계층을 명시했는데 다른 owner 가 살아 있는 레코드를 가졌으면 `layer occupied by <owner>; free layers: <목록>` 으로 실패한다.
- 레코드는 `generic` 프로파일이다.
  `iteration` 은 0, `max_iterations` 는 `--max-iterations`(기본 100)다.
  훅은 상한까지 `[STOP-LAYER <layer>:<owner> - ITERATION n/max]` 로 막고, 상한에서 비활성으로 바꾼다.

## refresh

그 owner 계층의 `last_checked_at` 을 지금으로 당긴다.

```bash
node "<script>" refresh --owner <name> [--project-dir "<작업 디렉토리>"]
```

- 훅은 2시간 동안 갱신이 없는 레코드를 stale 로 보고 놓는다.
  오래 걸리는 단계 사이에서 이 명령을 불러 레코드를 살려 둔다.
- `iteration` 과 `active` 는 건드리지 않는다.
- owner 의 계층이 없으면 종료 상태 `4` 다.

## off

그 owner 계층을 비활성으로 바꾼다.

```bash
node "<script>" off --owner <name> [--project-dir "<작업 디렉토리>"]
```

- 레코드 파일은 남고 `active` 만 `false` 가 된다.
- 작업이 끝나거나 취소될 때 부른다.
- owner 의 계층이 없으면 종료 상태 `4` 다.

## status

세 계층의 상태를 낸다.

```bash
node "<script>" status [--project-dir "<작업 디렉토리>"]
```

- 계층마다 `present`, `owner`, `active`, `stale`, `iteration`, `max_iterations`, `last_checked_at`, `path` 를 낸다.

## 호출하는 스킬이 지킬 일

- 작업을 시작할 때 `on` 을 부르고 종료 상태가 `0` 이 아니면 작업을 시작하지 않는다.
- 작업이 끝나거나 중단될 때 `off` 를 부른다.
- 사용자가 `/let-me-go-home:cancel --layer <layer>` 로 지우면 레코드가 사라진다.
  그때 `refresh` 는 종료 상태 `4` 를 낸다.
  호출하는 스킬은 이를 취소로 보고 작업을 멈춘다.
