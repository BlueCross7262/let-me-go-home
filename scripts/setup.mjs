#!/usr/bin/env node
/**
 * One-time preparation for this plugin in a project.
 *
 * Installing the plugin is Claude Code's job: it registers hooks/hooks.json,
 * the skills declared in .claude-plugin/plugin.json and the MCP server in
 * .mcp.json without help. So this script does the one thing that is left over
 * — creating the state root Ralph and Deep Interview write into — and then
 * reports the same checks scripts/doctor.mjs reports, so a fresh install can be
 * confirmed in one step instead of two.
 *
 * It is idempotent: running it on a prepared project creates nothing and only
 * re-reports. It never writes outside the state root, never edits CLAUDE.md and
 * never touches settings.json.
 *
 * Usage:
 *   node scripts/setup.mjs [--json] [--directory <path>] [--check-only]
 *
 * Exit status:
 *   0  the project is ready (warnings are allowed)
 *   1  at least one check still fails
 *   2  setup itself could not run
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runHealthChecks } from "./lib/health-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// See the note in scripts/doctor.mjs: CLAUDE_PLUGIN_ROOT names whichever
// plugin's hook is running, so this file's own location is the reliable root.
const PLUGIN_ROOT = join(HERE, "..");

const STATUS_MARK = { ok: "PASS", warn: "WARN", fail: "FAIL" };

function parseArgs(argv) {
  let json = false;
  let checkOnly = false;
  let directory;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--check-only") {
      checkOnly = true;
      continue;
    }
    if (arg === "--directory") {
      directory = argv[++i];
      continue;
    }
    if (arg.startsWith("--directory=")) {
      directory = arg.slice("--directory=".length);
      continue;
    }
  }
  return { json, checkOnly, directory };
}

async function resolveStateRoot(directory) {
  const { resolveLmghStateRoot } = await import(
    pathToFileURL(join(PLUGIN_ROOT, "scripts", "lib", "state-root.mjs")).href
  );
  return resolveLmghStateRoot(directory);
}

/** Create the directories the hooks write into. Returns what was actually created. */
function prepareStateRoot(stateRoot) {
  const wanted = [stateRoot, join(stateRoot, "state"), join(stateRoot, "state", "sessions")];
  const created = [];
  for (const path of wanted) {
    if (existsSync(path)) continue;
    mkdirSync(path, { recursive: true });
    created.push(path);
  }
  return created;
}

/**
 * Keep the state root out of the project's commits.
 *
 * Only acts when the state root actually lives inside the project — it does not
 * when LMGH_STATE_DIR centralizes it elsewhere — and it appends at most one line.
 *
 * Two guards, because appending is not always safe. Ignore rules are ordered and
 * a later line wins, so appending `x/` after an earlier `!x/keep/**` would
 * silently kill that re-include. So: ask git whether the path is already
 * ignored, and separately refuse to append when .gitignore mentions the path at
 * all, however it is spelled. A project that has written its own rules for this
 * directory gets to keep them.
 */
function ignoreStateRoot(directory, stateRoot) {
  const relativePath = relative(directory, stateRoot).split("\\").join("/");
  if (relativePath.startsWith("..") || relativePath === "") {
    return { changed: null, reason: "state root is outside the project" };
  }

  if (isIgnoredByGit(directory, stateRoot)) {
    return { changed: null, reason: "git already ignores it" };
  }

  const gitignore = join(directory, ".gitignore");
  const entry = `${relativePath}/`;
  if (existsSync(gitignore)) {
    const current = readFileSync(gitignore, "utf8");
    if (current.split(/\r?\n/).some((line) => line.includes(relativePath))) {
      return {
        changed: null,
        reason: `.gitignore already has rules mentioning ${relativePath}; left untouched`,
      };
    }
    const separator = current.endsWith("\n") || current === "" ? "" : "\n";
    writeFileSync(gitignore, `${current}${separator}${entry}\n`, "utf8");
    return { changed: entry, reason: null };
  }
  writeFileSync(gitignore, `${entry}\n`, "utf8");
  return { changed: entry, reason: null };
}

/** Ask git itself, so every pattern form and every negation is honoured. */
function isIgnoredByGit(directory, path) {
  const result = spawnSync("git", ["check-ignore", "-q", "--", path], {
    cwd: directory,
    windowsHide: true,
    timeout: 5000,
  });
  // 0 ignored, 1 not ignored, anything else (128: not a git repository, or git
  // is absent) means git cannot answer and the .gitignore check below decides.
  return result.status === 0;
}

function render(result, actions, notes) {
  const lines = ["let-me-go-home setup", ""];
  if (actions.length === 0) {
    lines.push("Nothing to prepare; this project was already set up.");
  } else {
    for (const action of actions) lines.push(`DONE  ${action}`);
  }
  for (const note of notes) lines.push(`NOTE  ${note}`);
  lines.push("");
  for (const check of result.checks) {
    lines.push(`${STATUS_MARK[check.status]}  ${check.label}: ${check.detail}`);
    if (check.hint) lines.push(`      ${check.hint}`);
  }

  const failed = result.checks.filter((check) => check.status === "fail");
  lines.push("");
  lines.push(
    failed.length > 0
      ? `${failed.length} check(s) still failing. Run /let-me-go-home:doctor after fixing them.`
      : "Ready. Start a run with /let-me-go-home:ralph or /let-me-go-home:deep-interview.",
  );
  return lines.join("\n");
}

async function main() {
  const { json, checkOnly, directory } = parseArgs(process.argv.slice(2));
  const target = resolve(directory || process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd());

  const actions = [];
  const notes = [];
  try {
    if (!checkOnly) {
      const stateRoot = await resolveStateRoot(target);
      for (const path of prepareStateRoot(stateRoot)) {
        actions.push(`created ${path}`);
      }
      const ignored = ignoreStateRoot(target, stateRoot);
      if (ignored.changed) {
        actions.push(`added ${ignored.changed} to .gitignore`);
      } else if (ignored.reason) {
        notes.push(`.gitignore not modified: ${ignored.reason}`);
      }
    }
  } catch (error) {
    console.error(`[SETUP FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  let result;
  try {
    result = await runHealthChecks({ pluginRoot: PLUGIN_ROOT, directory: target });
  } catch (error) {
    console.error(`[SETUP FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  if (json) {
    console.log(
      JSON.stringify({ plugin_root: PLUGIN_ROOT, directory: target, actions, notes, ...result }, null, 2),
    );
  } else {
    console.log(render(result, actions, notes));
  }

  process.exit(result.checks.some((check) => check.status === "fail") ? 1 : 0);
}

main().catch((error) => {
  console.error(`[SETUP FAILED] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
