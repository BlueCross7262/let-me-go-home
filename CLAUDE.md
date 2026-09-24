# let-me-go-home — repository instructions

This file is for Claude Code sessions working **on this repository**. It is not
shipped as plugin context; Claude Code does not load a plugin's root
`CLAUDE.md` into consuming projects.

## What this repository is

A Claude Code plugin that ships Ralph and Deep Interview, the skills that
support them, and the role agents a consuming environment's routing table
names.

The fork exists to remove global per-tool hooks. It registers four hook
events — `SessionStart`, `PreToolUse`, `PreCompact`, `Stop` — with one command
each, and no `PostToolUse`. The one per-tool matcher is `Agent|Task` on
`PreToolUse`: `scripts/agent-model-gate.mjs` blocks a `let-me-go-home:` agent
spawned on any model but sonnet. Any change that would add another per-tool
hook, or widen that matcher, defeats the purpose of the repository.

## Layout

| Path | What lives there |
|---|---|
| `src/**` | TypeScript. Compiled to `dist/` by `tsc`. |
| `scripts/*.mjs` | Hook entry points and the scripts skills invoke. Standalone — they must run when `dist/` is absent. |
| `scripts/lib/*.mjs` | Shared helpers for those scripts. |
| `skills/<name>/SKILL.md` | The eight shipped skills. |
| `agents/*.md` | The eleven shipped agents, auto-discovered. No `agents` key in the manifest. |
| `hooks/hooks.json` | The four hook registrations. |
| `dist/`, `bridge/` | Built artifacts. **Committed** — the plugin installs without a build step. |
| `.claude/skills/<name>/` | Repository-maintenance skills. Committed, **not shipped** — the manifest's `skills` array does not list them. |
| `upstream_fork/`, `upstream_now/`, `omc_fork/` | Clones of upstream, ignored. See below. |

## Invariants

- **Namespace lives in one place.** `src/constants/namespace.ts` declares every
  name derived from the plugin's namespace — `.lmgh`, `.lmgh-workspace`,
  `lmgh.jsonc`, `claude-lmgh`, `.lmgh-config.json`, the log tag, the plugin
  name. Production code imports it; do not retype these as literals.
  `scripts/lib/namespace.mjs` is generated from it by
  `scripts/build-namespace.mjs` and must not be hand-edited.
- **Tests keep their literals.** A test that asserts against the constant it is
  testing proves nothing. `__tests__` spells values out on purpose.
- **`dist/` and `bridge/` are tracked.** They are deliberately not ignored: an
  ignore rule silently drops newly generated files from commits. When you add a
  module, its compiled output belongs in the same commit.
- **The `.mjs` scripts cannot import from `dist/`** at module load. They must
  work when the build output is missing. Dynamic `import()` behind an
  `existsSync` check is the established pattern.

## Comparing against upstream

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

## Build and test

```
npm run build      # tsc -> generate scripts/lib/namespace.mjs -> bundle bridge/mcp-server.cjs
npm run test:run   # vitest, single pass
npm run typecheck  # tsc --noEmit, type check alone
```

The release skill turns its type-check gate on from `scripts.typecheck`, so that
script is the gate, not a convenience alias.

Judge build and test results by exit status, not by matching output text.

The suite does not pass clean on Windows and has not since before the fork.
The failures are path separator assumptions, `EPERM` on temp directories, file
mode 438 vs 384, an absent `tmux`, and lock timing. Before claiming a change is
clean, compare the **set of failing test names** against the set from before
your change — the count alone is not enough.

## Measuring the shipped surface

```
claude --plugin-dir . plugin details let-me-go-home
claude plugin validate .claude-plugin/plugin.json
```

The first prints the component inventory and the token cost, always-on and
on-invoke. That is the authority for how many skills and agents are exposed,
not a file count.

## Conventions

- Skill and agent bodies are written in Korean. Frontmatter, XML tags, fenced
  blocks, output templates, and any string another module matches on stay in
  English and byte-identical.
- `CLAUDE_PLUGIN_ROOT` names the plugin whose hook Claude Code ran last, which
  is not necessarily this one. Every `SKILL.md` that uses it says so and tells
  the reader how to find the right directory.
- `CLAUDE_CODE_SESSION_ID` is the harness-provided session id. `LMGH_SESSION_ID`
  is only an override.
