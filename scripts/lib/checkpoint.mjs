/**
 * Pre-compact checkpoint contract, shared by every writer and reader of it.
 *
 * Path: <state root>/state/sessions/<sessionId>/precompact-checkpoint.json
 * Keys:
 *   session_id      string
 *   written_at      ISO-8601
 *   ralph           null | { active, prd_path, current_story_id, iteration, max_iterations, prompt, prompt_file }
 *   deep_interview  null | { active, round, spec_path }
 *   phase_chain     null | { active, phase_id, chain_state_path, skill_path }
 *   req_interview   null | { active, slug, current, spec_paths, completed_items, state_path, ... }
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
export const REQ_INTERVIEW_STATE_FILE = "req-interview-state.json";
export const REQ_INTERVIEW_BOOL_KEYS = ["use_fork", "unattended", "verbatim_blocks", "scope_only"];
export const REQ_INTERVIEW_STRING_KEYS = [
  "name_prefix",
  "goal_file",
  "context_path",
  "origin_path",
  "repo_root",
  "work_dir",
  "skill_file",
  "progress_path",
  "result_path",
  "fork_name_path",
  "blocks_path",
];
export const REQ_INTERVIEW_STATUSES = ["running", "stopped"];
export const REQ_INTERVIEW_ITEM_PATTERN = /^[a-z0-9-]+$/;
export const REQ_INTERVIEW_REASON_MAX = 200;
export const REQ_INTERVIEW_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function phaseChainPointer(stateDir, sessionId) {
  const native = readJson(sessionScoped(stateDir, sessionId, "third-stop-state.json"));
  const state =
    native?.owner === "phase-chain" ? native : readJson(sessionScoped(stateDir, sessionId, "phase-chain-state.json"));
  if (!state?.active) return null;
  if (state.session_id && state.session_id !== sessionId) return null;
  return {
    active: true,
    phase_id: typeof state.phase_id === "string" ? state.phase_id : null,
    chain_state_path: typeof state.chain_state_path === "string" ? state.chain_state_path : null,
    skill_path: typeof state.skill_path === "string" ? state.skill_path : null,
  };
}

export function formatReqInterviewCurrent(current) {
  return current.reason
    ? `${current.item} (${current.status}: ${current.reason})`
    : `${current.item} (${current.status})`;
}

export function reqInterviewStatePath(stateDir, sessionId) {
  return sessionScoped(stateDir, sessionId, REQ_INTERVIEW_STATE_FILE);
}

function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function reqInterviewCurrent(value) {
  if (!isPlainObject(value)) return null;
  if (typeof value.item !== "string" || !REQ_INTERVIEW_ITEM_PATTERN.test(value.item)) return null;
  if (!REQ_INTERVIEW_STATUSES.includes(value.status)) return null;
  return { item: value.item, status: value.status, reason: nonEmptyString(value.reason) };
}

export function reqInterviewPointer(stateDir, sessionId) {
  const statePath = reqInterviewStatePath(stateDir, sessionId);
  const state = readJson(statePath);
  if (!isPlainObject(state) || state.active !== true || state.session_id !== sessionId) return null;
  const slug = nonEmptyString(state.slug);
  if (!slug) return null;
  const specs = {};
  if (isPlainObject(state.specs)) {
    for (const [key, value] of Object.entries(state.specs)) {
      if (nonEmptyString(value)) specs[key] = value;
    }
  }
  const pointer = { active: true, slug };
  for (const key of REQ_INTERVIEW_BOOL_KEYS) pointer[key] = state[key] === true;
  for (const key of REQ_INTERVIEW_STRING_KEYS) pointer[key] = nonEmptyString(state[key]);
  pointer.started_at = nonEmptyString(state.started_at);
  pointer.updated_at = nonEmptyString(state.updated_at);
  pointer.current = reqInterviewCurrent(state.current);
  pointer.spec_paths = specs;
  pointer.completed_items = Object.keys(specs);
  pointer.state_path = statePath;
  return pointer;
}

/** Build the checkpoint for a session. Every pointer is null when nothing is in flight. */
export function buildCheckpoint(stateDir, sessionId) {
  return {
    session_id: sessionId,
    written_at: new Date().toISOString(),
    ralph: ralphPointer(stateDir, sessionId),
    deep_interview: deepInterviewPointer(stateDir, sessionId),
    phase_chain: phaseChainPointer(stateDir, sessionId),
    req_interview: reqInterviewPointer(stateDir, sessionId),
  };
}

/** Write the checkpoint next to the session's state files. Returns the path written. */
export function writeCheckpoint(stateDir, checkpoint) {
  const target = sessionScoped(stateDir, checkpoint.session_id, CHECKPOINT_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(checkpoint, null, 2), "utf8");
  return target;
}
