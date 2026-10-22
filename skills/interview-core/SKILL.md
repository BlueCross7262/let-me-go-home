---
name: interview-core
description: Reference for the deep-interview skill; holds the execution-bridge menu with its option actions. Load it when an interview spec is ready and the user must choose how to proceed.
user-invocable: false
---

이 스킬은 스킬 `let-me-go-home:deep-interview` 가 쓰는 실행 브리지 선택지 메뉴를 담는다.
호출한 스킬은 아래 실행 변수 값을 정하고 이 스킬의 절을 따른다.
사용자가 선택지를 고르기 전의 승인 게이트는 호출한 스킬 본문이 정한다.

# 목차

- 실행 변수
- 실행 브리지 선택지

# 실행 변수

| 이름 | 타입 | 확정 시점 | 원천 | 기본값 |
|---|---|---|---|---|
| `ready_text` | 문자열 | 이 스킬을 부르기 전 | 호출한 스킬 본문이 정한다 | 없음 |
| `loop_name` | 문자열 | 이 스킬을 부르기 전 | 호출한 스킬 본문이 정한다 | 없음 |

# 실행 브리지 선택지

제시할 질문과 선택지는 아래와 같다:

질문: "Your spec is ready ({ready_text}). How would you like to proceed?"

선택지:

## Option `Execute with Ralph (Recommended)`

- Description: "Persistence loop with reviewer verification — keeps working until every acceptance criterion passes"
- 동작: 사용자가 이 선택지를 고른 뒤에만, spec 파일 경로를 작업 정의로 삼아 `Skill("let-me-go-home:ralph")` 를 호출한다.

## Option `Continue Interview`

- Description: "Keep interviewing to improve clarity (current: {ready_text})"
- 동작: 인터뷰 루프(`{loop_name}`)로 돌아간다.
- 동작: 상태의 `spec_path` 를 null 로 되돌린다.

## Option `Save Spec and Stop`

- Description: "Keep the spec as written and take no further action"
- 동작: spec 경로를 보고한다.
  그리고 멈춘다.
  spec 은 `pending approval` 로 남는다.
