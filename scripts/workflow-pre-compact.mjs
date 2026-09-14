#!/usr/bin/env node
/**
 * PreCompact checkpoint for this fork.
 *
 * Upstream copied whole mode states here. This writes a pointer checkpoint only:
 * enough for SessionStart to tell the model what was in flight, and nothing that
 * duplicates state the real files already own.
 *
 * The checkpoint shape and its path live in scripts/lib/checkpoint.mjs, which
 * scripts/compact-checkpoint.mjs shares so a manual /compact handoff writes the
 * exact same record this hook writes.
 */

import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCheckpoint, writeCheckpoint } from "./lib/checkpoint.mjs";
import { hooksDisabled } from "./lib/kill-switch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SAFE_CONTINUE = { continue: true, suppressOutput: true };

async function main() {
  if (hooksDisabled(["pre-compact"])) {
    console.log(JSON.stringify(SAFE_CONTINUE));
    return;
  }

  let data = {};
  try {
    const { readStdin } = await import(pathToFileURL(join(__dirname, "lib", "stdin.mjs")).href);
    data = JSON.parse(await readStdin());
  } catch {
    console.log(JSON.stringify(SAFE_CONTINUE));
    return;
  }

  try {
    const sessionId = data.session_id || data.sessionId || "";
    const directory = data.cwd || data.directory || process.cwd();
    if (!sessionId) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    const { resolveLmghStateRoot } = await import(
      pathToFileURL(join(__dirname, "lib", "state-root.mjs")).href
    );
    const stateDir = join(await resolveLmghStateRoot(directory), "state");

    const checkpoint = buildCheckpoint(stateDir, sessionId);
    if (!checkpoint.ralph && !checkpoint.deep_interview) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    writeCheckpoint(stateDir, checkpoint);
  } catch (error) {
    try {
      process.stderr.write(`[workflow-pre-compact] ${error?.message || error}\n`);
    } catch {
      // A valid JSON response still has to go out.
    }
  }

  console.log(JSON.stringify(SAFE_CONTINUE));
}

main();
