#!/usr/bin/env node
/**
 * Write the pre-compact checkpoint now, outside the PreCompact hook.
 *
 * The hook in hooks/workflow-pre-compact.mjs already runs when Claude Code
 * compacts, so this is not what makes compaction safe. It exists for the manual
 * handoff: before a user types the native `/compact`, the compact skill runs
 * this to write a checkpoint stamped at that moment and to report what is
 * actually in flight, so the handoff message names real state instead of
 * guessing.
 *
 * Both writers share scripts/lib/checkpoint.mjs, so a manual checkpoint and a
 * hook checkpoint are the same record and SessionStart replays either one.
 *
 * Usage:
 *   node scripts/compact-checkpoint.mjs [--json] [--session-id <id>] [--directory <path>]
 *
 * Exit status:
 *   0  reported successfully, whether or not anything was in flight
 *   1  no session id, so the checkpoint cannot be scoped
 *   2  the checkpoint could not be written
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCheckpoint, formatReqInterviewCurrent, writeCheckpoint } from "./lib/checkpoint.mjs";
import { formatRalphTaskLines } from "./lib/ralph-task.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = resolve(HERE, "..");

function parseArgs(argv) {
  let json = false;
  let sessionId;
  let directory;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--session-id") {
      sessionId = argv[++i];
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      sessionId = arg.slice("--session-id=".length);
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
  return { json, sessionId, directory };
}

function render(checkpoint, path) {
  const lines = ["let-me-go-home compact checkpoint", ""];
  if (!checkpoint.ralph && !checkpoint.deep_interview && !checkpoint.req_interview) {
    lines.push("Nothing in flight: no Ralph loop, no Deep Interview and no req-interview in this session.");
    lines.push("No checkpoint written; there is nothing for the next session to resume.");
    return lines.join("\n");
  }

  if (checkpoint.ralph) {
    lines.push(
      `Ralph active: iteration ${checkpoint.ralph.iteration ?? "?"}/${checkpoint.ralph.max_iterations ?? "?"}` +
        (checkpoint.ralph.current_story_id ? `, story ${checkpoint.ralph.current_story_id}` : ""),
    );
    for (const line of formatRalphTaskLines(checkpoint.ralph.prompt, checkpoint.ralph.prompt_file)) {
      lines.push(`  ${line}`);
    }
    if (checkpoint.ralph.prd_path) lines.push(`  PRD: ${checkpoint.ralph.prd_path}`);
  }
  if (checkpoint.deep_interview) {
    lines.push(
      `Deep Interview active${checkpoint.deep_interview.round !== null ? ` at round ${checkpoint.deep_interview.round}` : ""}`,
    );
    if (checkpoint.deep_interview.spec_path) lines.push(`  Spec: ${checkpoint.deep_interview.spec_path}`);
  }
  if (checkpoint.req_interview) {
    const run = checkpoint.req_interview;
    lines.push(`req-interview active: slug ${run.slug}`);
    if (run.completed_items.length > 0) {
      lines.push(`  Done: ${run.completed_items.join(", ")} (${run.completed_items.length})`);
    }
    if (run.current) {
      lines.push(`  Current: ${formatReqInterviewCurrent(run.current)}`);
    }
    if (run.updated_at) lines.push(`  Updated: ${run.updated_at}`);
    lines.push(`  State: ${run.state_path}`);
  }
  lines.push("", `Checkpoint written: ${path}`);
  lines.push("SessionStart replays it after the next compaction.");
  return lines.join("\n");
}

async function main() {
  const { json, sessionId: explicitSessionId, directory } = parseArgs(process.argv.slice(2));

  const sessionId =
    explicitSessionId?.trim() ||
    process.env.CLAUDE_CODE_SESSION_ID?.trim() ||
    process.env.LMGH_SESSION_ID?.trim();
  if (!sessionId) {
    console.error(
      "[COMPACT CHECKPOINT FAILED] no session id. Pass --session-id <id>, or run where " +
        "CLAUDE_CODE_SESSION_ID is set. Without it the checkpoint cannot be scoped to this session.",
    );
    process.exit(1);
  }

  const target = resolve(directory || process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd());

  let stateDir;
  let checkpoint;
  let written = null;
  try {
    const { resolveLmghStateRoot } = await import(
      pathToFileURL(join(HERE, "lib", "state-root.mjs")).href
    );
    stateDir = join(await resolveLmghStateRoot(target), "state");
    checkpoint = buildCheckpoint(stateDir, sessionId);
    if (checkpoint.ralph || checkpoint.deep_interview || checkpoint.req_interview) {
      written = writeCheckpoint(stateDir, checkpoint);
    }
  } catch (error) {
    console.error(
      `[COMPACT CHECKPOINT FAILED] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }

  if (json) {
    console.log(JSON.stringify({ session_id: sessionId, directory: target, written, checkpoint }, null, 2));
  } else {
    console.log(render(checkpoint, written));
  }
}

main().catch((error) => {
  console.error(`[COMPACT CHECKPOINT FAILED] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
