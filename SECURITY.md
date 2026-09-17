# Security

## Reporting

Open a private security advisory on this repository. Do not open a public issue
for a vulnerability.

## What this plugin can do

Judge a report against what the plugin actually has access to.

- **It runs code in your session.** Four hooks — `SessionStart`, `PreToolUse`,
  `PreCompact`, `Stop` — run `node scripts/run.cjs <script>` on those events.
  Skills run the scripts their `SKILL.md` names. The one per-tool hook is
  `PreToolUse` with matcher `Agent|Task`: it runs when an agent is spawned and
  blocks a `let-me-go-home:` agent whose `model` is not sonnet. Every other tool
  call runs nothing.
- **It writes to one directory.** Everything the runtime persists goes under the
  state root — `.lmgh/` at the worktree root, or `$LMGH_STATE_DIR/<project-id>/`
  when that is set. A write outside it is a bug worth reporting.
- **It reads config you control.** `.claude/lmgh.jsonc` in the project,
  `~/.config/claude-lmgh/config.jsonc` for the user, and `.lmgh-config.json`
  under the Claude config dir.
- **It makes no network calls of its own.** Notification dispatch to Discord,
  Telegram, Slack or a webhook is off unless you configure it with your own
  credentials.

## Turning it off

`DISABLE_LMGH=1` disables all four hooks. `LMGH_SKIP_HOOKS` takes a
comma-separated list and disables only those — `session-start`, `agent-model`,
`pre-compact`, `stop`. A disabled hook still answers the harness with a plain
continue.

## Ralph and the Stop hook

Ralph works by having the `Stop` hook block the session while its state file
says the loop is active. That is the intended behaviour, not a denial of
service — but it means a stale state file keeps a session from ending. The exits
are `/let-me-go-home:cancel`, then `--force`, then a two-hour staleness timeout.
`cancel` documents a direct file-removal fallback for the case where the MCP
tools are unavailable.

A hard iteration cap can be set with `security.hardMaxIterations` in the config
files above, or by setting `LMGH_SECURITY=strict`, which defaults that cap
to 200.
