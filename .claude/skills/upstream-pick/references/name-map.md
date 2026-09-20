# 우리 파일과 upstream 경로의 매핑

`upstream-pick` 의 Step 4 가 이 표를 읽는다.
경로는 각 저장소의 루트 기준이다.
upstream 저장소는 `upstream_fork` 와 `upstream_now` 다.

## skills

| 우리 경로 | upstream 경로 | 근거 |
|---|---|---|
| `skills/ai-slop-cleaner/` | `skills/ai-slop-cleaner/` | 디렉토리 이름이 같다 |
| `skills/cancel/` | `skills/cancel/` | 디렉토리 이름이 같다 |
| `skills/deep-interview/` | `skills/deep-interview/` | 디렉토리 이름이 같다 |
| `skills/ralph/` | `skills/ralph/` | 디렉토리 이름이 같다 |
| `skills/doctor/` | `skills/omc-doctor/` | 이름이 다르다. 사용자가 대응을 인정했다 |
| `skills/setup/` | `skills/omc-setup/` | 이름이 다르다. 사용자가 대응을 인정했다 |

`skills/compact/` 는 대응이 없다.
upstream 에 그 이름의 스킬이 없다.
우리 포크가 만든 것이다.

`doctor`·`setup` 두 쌍은 이름만 다른 같은 파일이 아니다.
`description` 도 내용도 독립이다.
우리 `doctor` 는 let-me-go-home 설치를 진단하고 upstream `omc-doctor` 는
oh-my-claudecode 설치를 진단한다.
저장소가 이 대응을 기록한 곳은 없다.
사용자가 내린 결정이고 이 표가 그 결정의 기록이다.

## agents

| 우리 경로 | upstream 경로 |
|---|---|
| `agents/analyst.md` | `agents/analyst.md` |
| `agents/architect.md` | `agents/architect.md` |
| `agents/code-reviewer.md` | `agents/code-reviewer.md` |
| `agents/critic.md` | `agents/critic.md` |
| `agents/debugger.md` | `agents/debugger.md` |
| `agents/document-specialist.md` | `agents/document-specialist.md` |
| `agents/executor.md` | `agents/executor.md` |
| `agents/explore.md` | `agents/explore.md` |
| `agents/planner.md` | `agents/planner.md` |
| `agents/tracer.md` | `agents/tracer.md` |
| `agents/verifier.md` | `agents/verifier.md` |

11개 모두 파일 이름이 같다.

upstream 에는 이 11개 말고 `code-simplifier`·`designer`·`git-master`·
`qa-tester`·`scientist`·`security-reviewer`·`test-engineer`·`writer` 도 있다.
우리 포크는 그 8개를 갖지 않는다.
`upstream-pick` 은 우리에게 없는 파일의 변경을 제시하지 않는다.

## 이 표를 고칠 때

`new-upstream-file` 단위를 승인하면 그 파일의 행을 더한다.
행을 지울 때는 우리 포크가 그 파일을 뺐다는 뜻이다.
그러면 그 파일의 upstream 변경이 다음 실행부터 제시되지 않는다.
