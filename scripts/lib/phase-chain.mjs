import { formatWaitingReason } from "./background-wait.mjs";

export const CHAIN_STATE_FILE = "phase-chain-state.json";
export const CHAIN_DEFAULT_MAX = 100;
export const CHAIN_WAIT_TAG = "[PHASE-CHAIN - WAITING]";

function safeCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function capOf(state) {
  const cap = state?.max_iterations;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : CHAIN_DEFAULT_MAX;
}

export function refreshChainState(state, pendingKind, nowIso) {
  const next = { ...state, last_checked_at: nowIso };
  if (pendingKind !== "none") {
    next.background_wait_at = nowIso;
  } else {
    delete next.background_wait_at;
  }
  return next;
}

export function formatChainReason(state) {
  return [
    `[PHASE-CHAIN] A phase chain is in progress. Read ${state?.chain_state_path} and follow the re-entry rule in ${state?.skill_path}.`,
    `The executor skill is at ${state?.executor_skill_path}.`,
    "To stop the chain, run /let-me-go-home:cancel --chain.",
  ].join("\n");
}

export function formatChainHardLimitReason(state) {
  return [
    `[PHASE-CHAIN - HARD LIMIT] Chain disabled after ${capOf(state)} blocked stops in phase ${state?.phase_id}.`,
    `Mark the running phase in ${state?.chain_state_path} as stopped with reason chain-hard-limit, then follow the 보고 step of ${state?.skill_path}.`,
  ].join("\n");
}

export function decideChain(state, pending, nowIso) {
  const next = { ...state };
  if (pending.kind !== "none") {
    next.background_wait_at = nowIso;
    if (pending.kind === "defer") {
      return { state: next, output: { allow: true } };
    }
    return { state: next, output: { decision: "block", reason: formatWaitingReason(pending.tasks, CHAIN_WAIT_TAG) } };
  }
  delete next.background_wait_at;
  const iteration = safeCount(next.iteration);
  if (iteration >= capOf(next)) {
    next.active = false;
    next.iteration = iteration;
    return { state: next, output: { decision: "block", reason: formatChainHardLimitReason(next) } };
  }
  next.iteration = iteration + 1;
  return { state: next, output: { decision: "block", reason: formatChainReason(next) } };
}
