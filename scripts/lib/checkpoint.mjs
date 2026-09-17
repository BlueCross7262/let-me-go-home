/**
 * Pre-compact checkpoint contract, shared by every writer and reader of it.
 *
 * Path: <state root>/state/sessions/<sessionId>/precompact-checkpoint.json
 * Keys:
 *   session_id      string
 *   written_at      ISO-8601
 *   ralph           null | { active, prd_path, current_story_id, iteration, max_iterations, prompt, prompt_file }
 *   deep_interview  null | { active, round, spec_path }
 *
 * Writers: scripts/workflow-pre-compact.mjs (the PreCompact hook) and
 * scripts/compact-checkpoint.mjs (the compact skill, on demand).
 * Reader: scripts/workflow-session-start.mjs.
 *
 * These are pointers, not copies. The live state files stay authoritative; the
 * checkpoint only tells the next session what was in flight so it can look.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CHECKPOINT_FILE = "precompact-checkpoint.json";

export function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function sessionScoped(stateDir, sessionId, file) {
  return join(stateDir, "sessions", sessionId, file);
}

export function ralphPointer(stateDir, sessionId) {
  const state = readJson(sessionScoped(stateDir, sessionId, "ralph-state.json"));
  if (!state?.active) return null;
  const prdPath = sessionScoped(stateDir, sessionId, "prd.json");
  return {
    active: true,
    prd_path: existsSync(prdPath) ? prdPath : null,
    current_story_id: state.current_story_id ?? null,
    iteration: state.iteration ?? null,
    max_iterations: state.max_iterations ?? null,
    prompt: typeof state.prompt === "string" ? state.prompt : null,
    prompt_file: typeof state.prompt_file === "string" ? state.prompt_file : null,
  };
}

export function deepInterviewPointer(stateDir, sessionId) {
  const state =
    readJson(sessionScoped(stateDir, sessionId, "deep-interview-state.json")) ??
    readJson(join(stateDir, "deep-interview-state.json"));
  if (!state?.active) return null;
  const inner = state.state ?? {};
  return {
    active: true,
    round: Array.isArray(inner.rounds) ? inner.rounds.length : null,
    spec_path: typeof state.spec_path === "string" ? state.spec_path : null,
  };
}

/** Build the checkpoint for a session. Both pointers are null when nothing is in flight. */
export function buildCheckpoint(stateDir, sessionId) {
  return {
    session_id: sessionId,
    written_at: new Date().toISOString(),
    ralph: ralphPointer(stateDir, sessionId),
    deep_interview: deepInterviewPointer(stateDir, sessionId),
  };
}

/** Write the checkpoint next to the session's state files. Returns the path written. */
export function writeCheckpoint(stateDir, checkpoint) {
  const target = sessionScoped(stateDir, checkpoint.session_id, CHECKPOINT_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(checkpoint, null, 2), "utf8");
  return target;
}
