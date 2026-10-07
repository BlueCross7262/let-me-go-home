# Upstream comparison clones


Three ignored clones of `Yeachan-Heo/oh-my-claudecode` sit beside the tree.
All three have their push URL disabled.

| Clone | What it points at |
|---|---|
| `upstream_fork/` | The last commit ported from upstream, on branch `ported-base`. It **moves** — `upstream-pick` advances it after every completed run. |
| `upstream_now/` | `dev`, checked out. |
| `omc_fork/` | The original clone of the fork point, `5281b19e0`. Kept as the immutable record of it. Its directory handle is held by something and cannot be renamed; leave it alone. |

Upstream develops on `dev`, not `main`. `main` has been parked at `v5.4.0`
(`5281b19e0`, the fork point) since 2026-09-11, so a comparison against `main`
or against the newest tag reports no delta while `dev` runs hundreds of commits
ahead. `main` is not an ancestor of `dev` either — derive the comparison point
with `git merge-base`.

`.claude/skills/upstream-pick/` drives the comparison. It splits an upstream
delta into features, asks per feature, and rewrites the approved ones into our
Korean documents rather than applying the patch. Its ledger
(`references/pick-ledger.json`) holds the moving base; `SYNC-HISTORY.md` holds
the human-readable row per run.
