---
name: compact
description: Prepare a manual Claude Code /compact handoff — stamp the pre-compact checkpoint now and report what Ralph or Deep Interview work is in flight
argument-hint: "[note to carry into /compact]"
---

# Compact Skill

Claude Code 네이티브 `/compact` 로 넘기기 전 인계를 준비한다.

이 스킬은 아무것도 compact 하지 않는다.
이 스킬은 compact 를 할 수도 없다.
`/compact` 는 네이티브 명령이라 플러그인이 호출할 수 없다.
이 스킬은 대화를 요약하지도 않는다.
이 스킬이 하는 일은 인계를 정직하게 만드는 것이다.
이 스킬은 지금 시점의 pre-compact 체크포인트를 찍는다.
그리고 실제로 진행 중인 작업을 보고한다.
그래서 사용자는 무엇이 복원될지 알고 compact 한다.

`scripts/workflow-pre-compact.mjs` 의 `PreCompact` 훅은 compaction 이 돌 때마다
이미 그 체크포인트를 쓴다.
두 작성자는 `scripts/lib/checkpoint.mjs` 의 같은 계약을 공유한다.
그래서 이 스킬 없이도 compaction 은 안전하다.
이 스킬은 체크포인트를 찍는 시점을 앞당긴다.
그리고 그 내용을 사용자에게 보여준다.
이 스킬이 하는 일은 이 둘뿐이다.

## Variables

| Variable | Type | Fixed at | Source | Default |
|---|---|---|---|---|
| `compact_note` | string | argument parsing | the invocation's free text | empty |

## Best-Fit Use

- 긴 Ralph 실행 중 컨텍스트 윈도가 차오르고, 사용자가 자동 패스를 기다리지 않고
  의도적으로 compact 하려는 경우.
- 사용자가 compaction 에서 무엇이 살아남는지 물은 경우.
- 긴 세션을 다른 사람에게 넘기기 전.

## Stamp the Checkpoint

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/compact-checkpoint.mjs
```

`CLAUDE_PLUGIN_ROOT` 는 Claude Code 가 마지막으로 실행한 훅의 플러그인을
가리킨다.
그 플러그인이 항상 이 플러그인은 아니다.
명령이 파일이 없다고 하면 바로 그 상황이다.
그때는 `.claude-plugin/plugin.json` 의 `"name"` 이 `"let-me-go-home"` 인
디렉토리를 찾는다.
그리고 그 디렉토리에서 스크립트를 실행한다.

스크립트는 `CLAUDE_CODE_SESSION_ID` 로 세션을 확인한다.
그 값이 없을 때만 `--session-id <id>` 를 넘긴다.
종료 상태 `0` 은 보고에 성공했다는 뜻이다.
이 뜻은 진행 중인 작업이 있든 없든 같다.
`1` 은 세션 id 가 없다는 뜻이다.
`2` 는 체크포인트를 쓰지 못했다는 뜻이다.

진행 중인 작업이 없는 것은 오류가 아니라 정상 결과다.
이때 체크포인트는 빈다.
그래서 스크립트는 아무것도 쓰지 않는다.
그 결과는 다음 세션이 복원할 것도 없다는 뜻이다.

## Hand Off

스크립트의 결과를 먼저 보고한다.
그다음 사용자에게 아래 블록을 준다.
`compact_note` 가 비어 있지 않으면 그 값을 명령 뒤에 덧붙인다:

```text
Checkpoint stamped. Plugin commands cannot trigger Claude Code's native
compaction, so run this yourself now:

/compact
```

그리고 멈춘다.
`/compact` 를 직접 실행하지 않는다.
사용자를 대신해 `compact` 라는 이름의 명령을 부르지 않는다.
compaction 을 대화 요약으로 대체하지 않는다.
SessionStart 는 손으로 쓴 요약을 재생하지 않는다.
그래서 그 요약은 같은 세션에 대해 서로 어긋나는 두 번째 기록을 만든다.

## After Compaction

`SessionStart` 훅은 세션이 `source === "compact"` 로 재개될 때 체크포인트를
읽는다.
그리고 거기 담긴 Ralph·Deep Interview 포인터를 주입한다.
권위는 여전히 실제 상태 파일에 있다.
체크포인트는 무엇이 진행 중이었는지만 말한다.
재개된 세션은 그 정보로 어디를 봐야 할지 안다.
