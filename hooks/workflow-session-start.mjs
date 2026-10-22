#!/usr/bin/env node
/**
 * SessionStart restore for this fork.
 *
 * Upstream's session-start hook also did version drift checks, npm update polling,
 * HUD detection, project memory loading and notifications. None of that belongs to a
 * Ralph + Deep Interview plugin, so this keeps three jobs only:
 *
 *   1. After a compaction (source === "compact"), replay the pointer checkpoint that
 *      the PreCompact hook wrote. See scripts/lib/checkpoint.mjs for the contract.
 *   2. When Ralph is active in this same session, inject the loop state and PRD pointer.
 *   3. When Deep Interview is active in this same session, inject the round and spec
 *      pointer. An unrelated new session never force-resumes either mode.
 *
 * It also carries the stale PRD warning that upstream emitted at SessionEnd, since this
 * fork ships no SessionEnd hook: the warning now surfaces at the next start or resume.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CHECKPOINT_FILE,
  formatReqInterviewCurrent,
  phaseChainPointer,
  readJson,
  reqInterviewPointer,
  sessionScoped,
} from "../scripts/lib/checkpoint.mjs";
import { hooksDisabled } from "../scripts/lib/kill-switch.mjs";
import { formatRalphTaskLines } from "../scripts/lib/ralph-task.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SAFE_CONTINUE = { continue: true, suppressOutput: true };
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function reqInterviewRestoreLines(saved, stateDir, sessionId) {
  if (!saved?.active) return [];
  const live = reqInterviewPointer(stateDir, sessionId);
  if (!live || live.slug !== saved.slug) return [];
  const lines = [`req-interview was active: slug ${saved.slug}`];
  const done = saved.completed_items ?? [];
  if (done.length > 0) lines.push(`Done: ${done.join(", ")} (${done.length})`);
  if (saved.current) lines.push(`Current: ${formatReqInterviewCurrent(saved.current)}`);
  for (const [key, path] of Object.entries(saved.spec_paths ?? {})) lines.push(`Spec ${key}: ${path}`);
  const flags = [
    saved.use_fork ? "fork" : null,
    saved.unattended ? "unattended" : null,
    saved.scope_only ? "scope-only" : null,
    saved.verbatim_blocks ? "verbatim-blocks" : null,
  ].filter(Boolean);
  if (flags.length > 0) lines.push(`Flags: ${flags.join(", ")}`);
  const facts = [
    ["Goal file", saved.goal_file],
    ["Context", saved.context_path],
    ["Origin", saved.origin_path],
    ["Repo root", saved.repo_root],
    ["Name prefix", saved.name_prefix],
    ["Work dir", saved.work_dir],
    ["Skill file", saved.skill_file],
  ];
  if (saved.use_fork) {
    facts.push(
      ["Fork progress log", saved.progress_path],
      ["Fork result file", saved.result_path],
      ["Fork name file", saved.fork_name_path],
    );
  }
  facts.push(["Blocks file", saved.blocks_path], ["Updated", saved.updated_at], ["State", saved.state_path]);
  for (const [label, value] of facts) {
    if (value) lines.push(`${label}: ${value}`);
  }
  return lines;
}

function compactRestoreBlock(checkpoint, stateDir, sessionId) {
  const lines = ["[PRE-COMPACT CHECKPOINT]", ""];
  if (checkpoint.ralph?.active) {
    lines.push(
      `Ralph was active: iteration ${checkpoint.ralph.iteration ?? "?"}/${checkpoint.ralph.max_iterations ?? "?"}` +
        (checkpoint.ralph.current_story_id ? `, story ${checkpoint.ralph.current_story_id}` : ""),
    );
    lines.push(...formatRalphTaskLines(checkpoint.ralph.prompt, checkpoint.ralph.prompt_file));
    if (checkpoint.ralph.prd_path) lines.push(`PRD: ${checkpoint.ralph.prd_path}`);
  }
  if (checkpoint.deep_interview?.active) {
    lines.push(
      `Deep Interview was active` +
        (checkpoint.deep_interview.round !== null ? ` at round ${checkpoint.deep_interview.round}` : ""),
    );
    if (checkpoint.deep_interview.spec_path) lines.push(`Spec: ${checkpoint.deep_interview.spec_path}`);
  }
  if (checkpoint.phase_chain?.active) {
    lines.push(`Phase chain was active at phase ${checkpoint.phase_chain.phase_id ?? "?"}`);
    if (checkpoint.phase_chain.chain_state_path) lines.push(`Chain state: ${checkpoint.phase_chain.chain_state_path}`);
  }
  lines.push(...reqInterviewRestoreLines(checkpoint.req_interview, stateDir, sessionId));
  if (lines.length === 2) return null;
  lines.push("", "Prior-session context only. The live state files above are authoritative.");
  return lines.join("\n");
}

function ralphBlock(state, stateDir, sessionId) {
  const prdPath = sessionScoped(stateDir, sessionId, "prd.json");
  const taskLines = formatRalphTaskLines(
    state.prompt,
    state.prompt_file,
    sessionScoped(stateDir, sessionId, "ralph-state.json"),
  );
  const lines = [
    "[RALPH LOOP ACTIVE]",
    "",
    ...(taskLines.length > 0 ? taskLines : ["Task: Task in progress"]),
    `Iteration: ${state.iteration ?? 1}/${state.max_iterations ?? 10}`,
  ];
  if (state.current_story_id) lines.push(`Current story: ${state.current_story_id}`);
  if (existsSync(prdPath)) lines.push(`PRD: ${prdPath}`);
  lines.push(
    "",
    "Prior-session context only. Prioritize the user's newest request, and resume the loop only if the user asks to continue it.",
  );
  return lines.join("\n");
}

function deepInterviewBlock(state) {
  const inner = state.state ?? {};
  const lines = ["[DEEP INTERVIEW ACTIVE]", ""];
  if (Array.isArray(inner.rounds)) lines.push(`Rounds so far: ${inner.rounds.length}`);
  if (typeof inner.current_ambiguity === "number") lines.push(`Current ambiguity: ${inner.current_ambiguity}`);
  if (typeof inner.threshold === "number") lines.push(`Threshold: ${inner.threshold}`);
  if (typeof state.spec_path === "string") lines.push(`Spec: ${state.spec_path}`);
  lines.push(
    "",
    "Prior-session context only. Do not force-resume the interview unless the user asks for it.",
  );
  return lines.join("\n");
}

function phaseChainBlock(pointer) {
  return [
    "[PHASE-CHAIN ACTIVE]",
    "",
    `Phase: ${pointer.phase_id ?? "?"}`,
    `Chain state: ${pointer.chain_state_path ?? "?"}`,
    `Re-entry rule: ${pointer.skill_path ?? "?"}`,
    "",
    "Read the chain state and follow the re-entry rule to continue. To stop the chain, run /let-me-go-home:cancel --chain.",
  ].join("\n");
}

async function stalePrdWarning(directory, sessionId) {
  try {
    const mod = await import(
      pathToFileURL(join(__dirname, "..", "dist", "hooks", "ralph", "stale-prd.js")).href
    );
    const result = mod.reconcileStalePrdForStartup(directory, sessionId);
    return typeof result?.warning === "string" && result.warning.length > 0 ? result.warning : null;
  } catch {
    return null;
  }
}

async function main() {
  if (hooksDisabled(["session-start"])) {
    console.log(JSON.stringify(SAFE_CONTINUE));
    return;
  }

  let data = {};
  try {
    const { readStdin } = await import(pathToFileURL(join(__dirname, "..", "scripts", "lib", "stdin.mjs")).href);
    data = JSON.parse(await readStdin());
  } catch {
    console.log(JSON.stringify(SAFE_CONTINUE));
    return;
  }

  try {
    const sessionId = data.session_id || data.sessionId || "";
    const directory = data.cwd || data.directory || process.cwd();
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    const { resolveLmghStateRoot } = await import(
      pathToFileURL(join(__dirname, "..", "scripts", "lib", "state-root.mjs")).href
    );
    const stateDir = join(await resolveLmghStateRoot(directory), "state");

    const blocks = [];

    if (data.source === "compact") {
      const checkpoint = readJson(sessionScoped(stateDir, sessionId, CHECKPOINT_FILE));
      if (checkpoint && checkpoint.session_id === sessionId) {
        const restore = compactRestoreBlock(checkpoint, stateDir, sessionId);
        if (restore) blocks.push(restore);
      }
    }

    const ralph = readJson(sessionScoped(stateDir, sessionId, "ralph-state.json"));
    if (ralph?.active && (!ralph.session_id || ralph.session_id === sessionId)) {
      blocks.push(ralphBlock(ralph, stateDir, sessionId));
      const warning = await stalePrdWarning(directory, sessionId);
      if (warning) blocks.push(warning);
    }

    const di =
      readJson(sessionScoped(stateDir, sessionId, "deep-interview-state.json")) ??
      readJson(join(stateDir, "deep-interview-state.json"));
    if (di?.active) {
      blocks.push(deepInterviewBlock(di));
    }

    const chain = phaseChainPointer(stateDir, sessionId);
    if (chain) {
      blocks.push(phaseChainBlock(chain));
    }

    if (blocks.length === 0) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    console.log(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `<session-restore>\n\n${blocks.join("\n\n---\n\n")}\n\n</session-restore>\n`,
        },
      }),
    );
  } catch (error) {
    try {
      process.stderr.write(`[workflow-session-start] ${error?.message || error}\n`);
    } catch {
      // A valid JSON response still has to go out.
    }
    console.log(JSON.stringify(SAFE_CONTINUE));
  }
}

main();
