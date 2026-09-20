---
name: upstream-pick
description: upstream oh-my-claudecode 가 이 포크의 대응 skill·agent 문서를 고친 부분을 찾아 기능 단위로 쪼개고, 사용자가 기능마다 승인하거나 무시한 뒤 승인분만 우리 문서에 다시 쓴다. 비교 기준점은 실행마다 전진해 다음 실행이 같은 기능을 다시 묻지 않는다. `--report-only` 는 비교 보고서만 만들고 아무것도 고치지 않는다. 다음 상황에서 사용하라 — "upstream 변경 가져와", "upstream 비교해", "포크 업데이트해", "upstream-pick". 영어 트리거 — "pick upstream changes", "compare against upstream", "update the fork from upstream". 이 저장소 유지보수용이며 플러그인이 배포하지 않는다.
argument-hint: "[--report-only] [--from-report <path>] [--scope skills|agents|all] [--branch <name>]"
user-invocable: true
disable-model-invocation: true
---

# upstream-pick

upstream `Yeachan-Heo/oh-my-claudecode` 가 이 포크의 대응 문서를 고친 부분을
가져온다.
패치를 적용하지 않는다.
우리 파일은 한국어 번역본이자 축소본이라 upstream 원문과 이미 갈라져 있다.
변경의 의도를 읽어 우리 문서에 다시 쓴다.

## 변수

| 이름 | 타입 | 확정 시점 | 원천 | 기본값 |
|---|---|---|---|---|
| `scope` | `skills`·`agents`·`all` | 인자 파싱 | `--scope` | `all` |
| `mode` | `report`·`apply` | 인자 파싱 | `--report-only` 가 있으면 `report` | `apply` |
| `from_report` | path·없음 | 인자 파싱 | `--from-report` | 없음 |
| `upstream_branch` | string | 인자 파싱 | `--branch` | `dev` |
| `base_sha` | string | Step 1 | 원장의 `last_ported_sha` | 없으면 `original_fork_pin` |
| `target_sha` | string | Step 2 | `now_dir` 의 `upstream_branch` HEAD | — |
| `compare_base` | string | Step 3 | `git merge-base` 결과 | — |
| `bulk_gate_threshold` | int | 상수 | 이 문서 | `8` |
| `excerpt_line_cap` | int | 상수 | 이 문서 | `60` |
| `fork_dir` | path | 상수 | 저장소 루트 기준 | `upstream_fork` |
| `now_dir` | path | 상수 | 저장소 루트 기준 | `upstream_now` |
| `ported_branch` | string | 상수 | `fork_dir` 의 로컬 브랜치 | `ported-base` |
| `report_dir` | path | Step 1 | `resolve_output_dir.py` 의 `dir` 값 | — |
| `upstream_url` | string | 상수 | clone 원본 | `https://github.com/Yeachan-Heo/oh-my-claudecode.git` |
| `original_fork_pin` | string | 외부 계약 | 원장 필드 | `5281b19e0` |

`mode` 가 `report` 면 Step 8·9·10·11 을 건너뛴다.
대신 Step 7 뒤에 Step 7R 로 보고서를 쓰고 끝낸다.
그 모드는 우리 파일을 안 고치고 원장도 기준점도 안 바꾼다.

## 질문 규칙

이 스킬의 승인 게이트는 `~/.claude/rules/rrr_advisor_before-question.md` 의
advisor 선상담을 면제받는다.
기능 단위마다 advisor 를 부르면 실행이 성립하지 않는다.
면제는 선상담만 덜어낸다.
권장안을 목록 첫 번째에 두고 `(Recommended)` 를 붙이는 규칙은 그대로 지킨다.

## Step 1 — 전제 확인

`fork_dir` 과 `now_dir` 이 있는지 본다.
없으면 `upstream_url` 에서 clone 한다.
`fork_dir` 을 새로 만들면 원장의 `last_ported_sha` 로 체크아웃한다.
원장이 없으면 `original_fork_pin` 으로 체크아웃한다.
그 커밋이 upstream 에 없으면 브랜치가 재작성된 것이다.
그 사실을 보고하고 끝낸다.

두 clone 의 `origin` push URL 이 `DISABLED_no_push_to_upstream` 인지 확인한다.
아니면 그렇게 고친다.

원장을 읽어 `base_sha` 를 확정한다.
원장이 없으면 `original_fork_pin` 을 쓴다.

`py -3 ~/.claude/scripts/resolve_output_dir.py --dir-name jira_works --key
ticket --skill upstream-pick` 를 돌려 `report_dir` 을 정한다.

## Step 2 — upstream 갱신

`now_dir` 에서 `git fetch origin <upstream_branch>` 를 돌린다.
그 브랜치를 체크아웃한다.
그 HEAD 를 `target_sha` 로 고정한다.
이 실행은 그 뒤 upstream 이 움직여도 `target_sha` 만 본다.

## Step 3 — 기준점 산출과 재개 판정

`compare_base` 를 `git merge-base <base_sha> <target_sha>` 로 구한다.

- `compare_base` 와 `target_sha` 가 같으면 upstream 이 안 움직였거나 뒤로 간
  것이다.
  그 사실을 보고하고 끝낸다.
  기준점을 건드리지 않는다.
- `base_sha` 가 `original_fork_pin` 과 다르면 단조성을 검사한다.
  `git merge-base --is-ancestor <base_sha> <target_sha>` 가 참이 아니면
  upstream 이 브랜치를 다시 쓴 것이다.
  그 사실을 보고하고 끝낸다.
  `base_sha` 가 `original_fork_pin` 과 같은 첫 실행은 이 검사를 건너뛴다.
  fork pin 은 릴리스 브랜치 커밋이라 개발 브랜치의 조상이 아니기 때문이다.
- `from_report` 가 있으면 그 파일의 `compare_base`·`target_sha` 를 지금 값과
  대조한다.
  같으면 Step 5~7 의 분해를 생략하고 그 파일의 단위 목록을 Step 7 의 선기록으로
  그대로 옮긴다.
  다르면 그 사실을 보고하고 그 파일을 버린 뒤 새로 분해한다.
- 원장의 마지막 실행이 `partial` 이고 그 실행의 `compare_base`·`target_sha` 가
  지금 값과 같으면 재개다.
  Step 5~7 을 다시 돌리지 않고 저장된 단위 목록을 읽어 Step 8 로 간다.
  `mode` 가 `report` 면 재개하지 않고 새로 분해한다.
  그 `partial` 실행의 단위별 `user` 상태는 보고서에 함께 싣는다.
- `target_sha` 가 다르면 재개가 아니라 새 실행이다.
  분해를 새로 한다.
  앞선 `partial` 실행의 결정 기록은 지우지 않고 원장에 남겨 둔다.

## Step 4 — 페어링

`references/name-map.md` 의 매핑표로 우리 파일과 upstream 경로를 잇는다.
`scope` 가 고른 대상만 남긴다.

매핑에 없는 우리 파일은 「우리 고유」로 보고만 한다.

매핑에 없는 upstream 파일은 둘로 가른다.

- `compare_base` 에 있고 우리에게 없는 파일은 우리 포크가 뺀 것이다.
  그 변경은 제시하지 않는다.
- `compare_base` 에 없고 `target_sha` 에만 있는 파일은 upstream 이 새로 만든
  것이다.
  그 파일은 `new-upstream-file` 단위 하나로 만들어 제시한다.
  승인하면 그 파일을 우리 포크에 새로 쓰고 `references/name-map.md` 에 행을
  더한다.
  그때도 `.claude-plugin/plugin.json` 은 건드리지 않는다.
  배포 등록은 별도 결정이라고 보고만 한다.

## Step 5 — 델타 추출

대상마다 `git -C <now_dir> diff <compare_base>..<target_sha> -- <upstream 경로>`
를 돌린다.
skill 은 디렉토리 전체, agent 는 파일 하나가 경로다.
같은 범위의 `git log --format='%h %s'` 로 커밋 의도를 함께 모은다.
델타가 0인 대상은 뺀다.

## Step 6 — 기능 단위 분해

hunk 가 아니라 의미 단위로 쪼갠다.
새 섹션, 새 규칙, 고친 규칙, 지운 규칙이 각각 한 단위다.
단위마다 라벨, upstream 커밋 sha, diff 의 hunk 위치를 붙인다.

분해와 판정은 `let-me-go-home:analyst` 레인에 위임한다.
Agent 호출에 `model` 을 `sonnet` 으로 명시한다.
그 에이전트는 Write 가 없으므로 Bash 리다이렉션으로 판정 파일을 쓰게 한다.
판정 파일 경로를 프롬프트에 싣는다.
메인이 그 파일을 읽어 파일·라인 근거로 검토한 뒤 채택한다.
반환 메시지의 요약을 그대로 사실로 쓰지 않는다.

## Step 7 — 판정과 선기록

단위마다 `port`·`adapt`·`reject`·`conflict` 중 하나를 매긴다.

- `port` 는 우리 문서에 그대로 옮길 수 있는 단위다.
- `adapt` 는 우리 네이밍·구조로 바꿔야 옮길 수 있는 단위다.
- `reject` 는 우리 포크의 불변식과 충돌하는 단위다.
  판정문에 충돌하는 `CLAUDE.md` 의 Invariants 항목을 그대로 인용한다.
- `conflict` 는 아래 둘 중 하나에 해당하는 단위다.
  - upstream 변경이 닿는 절에 대응하는 우리 절이 이미 갈라져 있다.
    판별을 행 단위 diff 로 하지 않는다.
    우리 파일은 한국어 번역본이라 행 diff 가 거의 전 행을 덮는다.
    그 판별은 모든 단위를 `conflict` 로 만든다.
    대신 절 단위로 의미를 비교한다.
    번역 때문에 다른 것은 갈라진 것이 아니다.
    규칙이 더해졌거나 빠졌거나 바뀐 것만 갈라진 것이다.
    비교 원본은 `fork_dir` 의 그 파일이다.
    판정문에 우리 절 위치와 갈라진 규칙을 적는다.
  - 그 단위가 `description`·트리거 문구 등 해석표면을 바꾼다.
    그 변경은 우리 스킬이 언제 발동하는지를 바꾼다.

`conflict` 단위를 자동으로 반영하지 않는다.
질문에 충돌 사실과 갈라진 우리 절을 함께 싣는다.

`mode` 가 `apply` 면 이 시점에 원장에 run 항목을 `status` `partial` 로 쓴다.
그 항목의 모든 단위는 `user` `pending`, `applied` `false` 로 시작한다.
그래야 Step 8 도중 세션이 끊겨도 재개가 읽을 목록이 남는다.

## Step 7R — 보고서

`mode` 가 `report` 일 때만 수행한다.

`report_dir` 아래 `upstream-pick.report.<target_sha>.md` 를 쓴다.
보고서에 아래를 담는다.

- 비교 범위 — `compare_base`..`target_sha`.
- 대상별 델타 요약.
- 기능 단위 목록.
- 단위별 판정과 근거.
- upstream hunk 위치.
- 우리 파일의 대응 위치.
- 권장 결정.

보고서 끝에 원장 `units` 와 같은 구조의 JSON 코드블록을 싣는다.
그 블록에 `compare_base` 와 `target_sha` 를 함께 적는다.
그래야 적용 실행이 `--from-report` 로 같은 단위 경계를 이어받는다.

보고서 경로를 사용자에게 보고하고 끝낸다.
이 모드는 원장을 안 고친다.

## Step 8 — 승인 게이트

`mode` 가 `apply` 일 때만 수행한다.

한 파일의 단위가 `bulk_gate_threshold` 이상이면 먼저 파일 단위 일괄 처리를
묻는다.
일괄 무시를 고르면 그 파일의 단위 전부를 개별 `ignored` 로 기록한다.
파일 수준 상태를 원장에 만들지 않는다.

그다음 단위마다 `승인`·`무시` 2택을 하나씩 묻는다.
질문에 판정, 근거, upstream 원문 발췌, 우리 파일의 대응 위치를 싣는다.
발췌가 `excerpt_line_cap` 을 넘으면 hunk 위치만 싣고 사용자가 파일을 열게 한다.

권장안은 판정을 따른다.

- `port`·`adapt` 는 `승인` 이다.
- `reject`·`conflict`·`new-upstream-file` 은 `무시` 다.

응답을 받을 때마다 그 단위의 `user` 를 원장에 갱신한다.

## Step 9 — 적용

`mode` 가 `apply` 일 때만 수행한다.

`user` 가 `approved` 이고 `applied` 가 거짓인 단위를 전부 처리한다.
한 단위를 반영할 때마다 그 단위의 `applied` 를 참으로 갱신한다.
그래야 재개 실행이 이미 반영한 단위를 두 번 쓰지 않는다.

패치를 그대로 적용하지 않는다.
본문은 한국어로 쓴다.
frontmatter, XML 태그, 코드블록, 출력 템플릿, 다른 모듈이 매칭하는 문자열은
영문 그대로 둔다.
그 규칙은 저장소 `CLAUDE.md` 의 Conventions 가 정한다.
편집 주체는 메인이다.

## Step 10 — 기준점 동기화

`mode` 가 `apply` 일 때만 수행한다.
모든 단위의 `user` 가 `pending` 이 아니고 승인 단위가 전부 `applied` 일 때만
수행한다.

`git -C <fork_dir> fetch <now_dir 절대경로> <upstream_branch>` 로 객체를
로컬에서 받는다.
그다음 `git -C <fork_dir> checkout -B <ported_branch> <target_sha>` 를
실행한다.
그러면 `fork_dir` 과 `now_dir` 이 같은 커밋을 가리킨다.

원장의 `last_ported_sha` 를 `target_sha` 로 바꾸고 그 실행을 `complete` 로
닫는다.

`SYNC-HISTORY.md` 에 행을 하나 덧붙인다.
기존 행을 고치지 않는다.
컬럼은 그 파일이 이미 쓰는 다섯 개를 그대로 쓴다.

- 「기준 tag」 칸은 `target_sha` 가 태그를 가리키면 그 태그를 적는다.
  아니면 `<브랜치>@<짧은 sha>` 를 적는다.
- 「대조 결과」 칸에 승인·무시 단위 수를 적는다.
- 「비고」 칸에 `conflict` 단위 수와 원장 파일 경로를 적는다.

조건을 못 채우면 기준점을 전진시키지 않는다.
그 실행은 `partial` 로 남고 `SYNC-HISTORY.md` 에도 행을 안 쓴다.

## Step 11 — 검증

`mode` 가 `apply` 이고 파일을 고쳤을 때만 수행한다.

`npm run build` 와 `npm run test:run` 을 돌린다.
판정을 종료 상태로 한다.
출력의 성공 문구로 판정하지 않는다.
이 저장소는 Windows 에서 전량 테스트가 원래 통과하지 않는다.
실패 테스트 이름 집합을 변경 전과 대조한다.
개수만 세지 않는다.

`claude --plugin-dir . plugin details let-me-go-home` 으로 배포 표면을
확인한다.
skill 수가 7 로 유지돼야 한다.

고친 파일이 `SKILL.md`·`agents/*.md` 이므로 트리거 해석표면은 메인이 실제
호출로 관측한다.
이 스킬이 그 관측을 자동 통과로 적지 않는다.

## 하지 않는 것

- 커밋하지 않는다.
  `.claude-plugin/plugin.json` 의 버전도 올리지 않는다.
  바꾼 파일 목록을 보고하고 끝낸다.
- `src/`·`scripts/`·`hooks/` 의 `.mjs` 등 로직 파일을 다루지 않는다.
  그 파일은 실행 코드라 의도 재서술이 아니라 패치 이식이고 검증 방식도 다르다.
- upstream 신규 파일을 자동으로 가져오지 않는다.
  단위로 제시만 하고 권장안은 `무시` 다.
- `omc_fork/` 를 건드리지 않는다.
  그 디렉토리는 fork 원점의 불변 기록이다.

## 참조

- `references/name-map.md` — 우리 파일과 upstream 경로의 매핑표.
- `references/pick-ledger.json` — 기준점과 단위별 판정 원장.
