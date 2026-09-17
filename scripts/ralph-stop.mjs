#!/usr/bin/env node

/**
 * Ralph Stop hook.
 *
 * Derived from the upstream persistent-mode hook with every non-Ralph branch removed
 * from main(). Ralph behaviour is unchanged: block while the loop is active, inject the
 * iteration banner, extend the ceiling when it is reached, auto-disable at the hard max.
 * PRD, story and reviewer gating are not hook concerns — they live in
 * skills/ralph/SKILL.md, exactly as upstream shipped them.
 *
 * Helpers are kept verbatim from upstream so protocol handling (safety timeout, safe-exit
 * paths, state reads, stop-reason classification) behaves identically. Helpers that only
 * served removed modes are pruned in the hard-prune phase, on import-graph evidence.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
  statSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { spawn } from "child_process";
import { join, dirname, resolve, normalize } from "path";
import { homedir } from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { PROJECT_CONFIG_FILE, STATE_DIR, USER_CONFIG_DIR } from "./lib/namespace.mjs";
import { hooksDisabled } from "./lib/kill-switch.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SAFE_CONTINUE = { continue: true, suppressOutput: true };
const DEFAULT_SAFETY_TIMEOUT_MS = 8500;
const SAFE_EXIT_FLUSH_TIMEOUT_MS = 100;


function getSafetyTimeoutMs() {
  const parsed = Number.parseInt(process.env.LMGH_PERSISTENT_MODE_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAFETY_TIMEOUT_MS;
}

function writeSafeContinue(onFlushed) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (onFlushed) onFlushed();
  };

  try {
    const ok = process.stdout.write(JSON.stringify(SAFE_CONTINUE) + "\n", finish);
    if (!ok) {
      process.stdout.once("drain", finish);
    }
    const timeout = setTimeout(finish, SAFE_EXIT_FLUSH_TIMEOUT_MS);
    if (!onFlushed) timeout.unref?.();
  } catch {
    // If stdout is unavailable, exiting still prevents a wedged Stop hook.
    finish();
  }
}

function shouldSkipPersistentModeHook() {
  return hooksDisabled(["stop", "persistent-mode", "stop-continuation"]);
}

function forceSafeExit(message) {
  try {
    if (message) process.stderr.write(message + "\n");
  } catch {
    // Ignore stderr failures; the JSON decision is what matters.
  }
  writeSafeContinue(() => process.exit(0));
}


const safetyTimeout = setTimeout(() => {
  forceSafeExit("[persistent-mode] Safety timeout reached, forcing exit");
}, getSafetyTimeoutMs());

process.on("uncaughtException", (error) => {
  forceSafeExit(`[persistent-mode] Uncaught exception: ${error?.message || error}`);
});

process.on("unhandledRejection", (error) => {
  forceSafeExit(`[persistent-mode] Unhandled rejection: ${error?.message || error}`);
});
const { atomicWriteFileSync, withStateFileLockSync } = await import(pathToFileURL(join(__dirname, "lib", "atomic-write.mjs")).href);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, "lib", "stdin.mjs")).href
);
const { resolveLmghStateRoot } = await import(pathToFileURL(join(__dirname, "lib", "state-root.mjs")).href);
const { classifyPendingWork, formatWaitingReason } = await import(
  pathToFileURL(join(__dirname, "lib", "background-wait.mjs")).href
);
const { formatRalphTaskLines } = await import(pathToFileURL(join(__dirname, "lib", "ralph-task.mjs")).href);

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Get hard max iterations from LMGH_SECURITY / config file.
 * Returns 0 if unlimited (default).
 */
function getHardMaxIterations() {
  // LMGH_SECURITY=strict → default hard max 200
  if (process.env.LMGH_SECURITY === "strict") {
    // Check config file for override
    const configOverride = readSecurityConfigValue("hardMaxIterations");
    return typeof configOverride === "number" ? configOverride : 200;
  }
  // Check config file only
  const configValue = readSecurityConfigValue("hardMaxIterations");
  return typeof configValue === "number" ? configValue : 0;
}

/**
 * Read a single value from the security section of lmgh config files.
 */
function readSecurityConfigValue(key) {
  const paths = [
    join(process.cwd(), ".claude", PROJECT_CONFIG_FILE),
    join(homedir(), ".config", USER_CONFIG_DIR, "config.jsonc"),
  ];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf-8");
      // Strip JSONC comments (// and /* */)
      const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const parsed = JSON.parse(json);
      if (parsed?.security && parsed.security[key] !== undefined) {
        return parsed.security[key];
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function writeJsonFile(path, data) {
  try {
    atomicWriteFileSync(path, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function getIdleCooldownSeconds() {
  const configPath = join(homedir(), STATE_DIR, "config.json");
  const config = readJsonFile(configPath);
  const val = config?.notificationCooldown?.sessionIdleSeconds;
  return typeof val === "number" ? val : 60;
}

function shouldSendIdleNotification(stateDir) {
  const cooldownSecs = getIdleCooldownSeconds();
  const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
  const data = readJsonFile(cooldownPath);

  if (cooldownSecs === 0) return true;

  if (data?.lastSentAt) {
    const elapsed = (Date.now() - new Date(data.lastSentAt).getTime()) / 1000;
    if (Number.isFinite(elapsed) && elapsed < cooldownSecs) return false;
  }
  return true;
}

function recordIdleNotificationSent(stateDir) {
  const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
  writeJsonFile(cooldownPath, { lastSentAt: new Date().toISOString() });
}

function dispatchIdleNotificationInBackground(sessionId, directory) {
  if (process.env.LMGH_NOTIFY === "0") return false;

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return false;

  const notificationsModuleUrl = pathToFileURL(join(pluginRoot, "dist", "notifications", "index.js")).href;
  const payload = {
    sessionId,
    projectPath: directory,
    profileName: process.env.LMGH_NOTIFY_PROFILE,
  };
  const childSource = `import(${JSON.stringify(notificationsModuleUrl)})\n` +
    `  .then(({ notify }) => notify("session-idle", ${JSON.stringify(payload)}))\n` +
    `  .catch(() => {});`;

  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        LMGH_HOOK_BACKGROUND_CHILD: "1",
      },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read last tool error from state directory.
 * Returns null if file doesn't exist or error is stale (>60 seconds old).
 */
function readLastToolError(stateDir) {
  const errorPath = join(stateDir, "last-tool-error.json");
  const toolError = readJsonFile(errorPath);

  if (!toolError || !toolError.timestamp) return null;

  // Check staleness - errors older than 60 seconds are ignored
  const parsedTime = new Date(toolError.timestamp).getTime();
  if (!Number.isFinite(parsedTime)) {
    return null; // Invalid timestamp = stale
  }
  const age = Date.now() - parsedTime;
  if (age > 60000) return null;

  return toolError;
}

/**
 * Clear tool error state file atomically.
 */
function clearToolErrorState(stateDir) {
  const errorPath = join(stateDir, "last-tool-error.json");
  try {
    if (existsSync(errorPath)) {
      unlinkSync(errorPath);
    }
  } catch {
    // Ignore errors - file may have been removed already
  }
}

/**
 * Generate retry guidance message for tool errors.
 * After 5+ retries, suggests alternative approaches.
 */
function getToolErrorRetryGuidance(toolError) {
  if (!toolError) return "";

  const retryCount = toolError.retry_count || 1;
  const toolName = toolError.tool_name || "unknown";
  const error = toolError.error || "Unknown error";

  if (retryCount >= 5) {
    return `[TOOL ERROR - ALTERNATIVE APPROACH NEEDED]
The "${toolName}" operation has failed ${retryCount} times.

STOP RETRYING THE SAME APPROACH. Instead:
1. Try a completely different command or approach
2. Check if the environment/dependencies are correct
3. Consider breaking down the task differently
4. If stuck, ask the user for guidance

`;
  }

  return `[TOOL ERROR - RETRY REQUIRED]
The previous "${toolName}" operation failed.

Error: ${error}

REQUIRED ACTIONS:
1. Analyze why the command failed
2. Fix the issue (wrong path? permission? syntax? missing dependency?)
3. RETRY the operation with corrected parameters
4. Continue with your original task after success

Do NOT skip this step. Do NOT move on without fixing the error.

`;
}

/**
 * Staleness threshold for mode states (2 hours in milliseconds).
 * States older than this are treated as inactive to prevent stale state
 * from causing the stop hook to malfunction in new sessions.
 */
const STALE_STATE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const TEAM_TERMINAL_PHASES = new Set([
  "completed",
  "complete",
  "failed",
  "cancelled",
  "canceled",
  "aborted",
  "terminated",
  "done",
]);
const TEAM_ACTIVE_PHASES = new Set([
  "team-plan",
  "team-prd",
  "team-exec",
  "team-verify",
  "team-fix",
  "planning",
  "executing",
  "verify",
  "verification",
  "fix",
  "fixing",
]);

/**
 * Check if a state is stale based on its timestamps.
 * A state is considered stale if it hasn't been updated recently.
 * We check `last_checked_at`, `updated_at`, and `started_at` - using whichever is more recent.
 */
function isStaleState(state) {
  if (!state) return true;

  const timestamps = [state.last_checked_at, state.updated_at, state.started_at].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  const mostRecent = timestamps.reduce((max, value) => {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, 0);

  if (mostRecent === 0) return true; // No valid timestamps

  const age = Date.now() - mostRecent;
  return age > STALE_STATE_THRESHOLD_MS;
}

function normalizeTeamPhase(state) {
  if (!state || typeof state !== "object") return null;

  const rawPhase = state.current_phase ?? state.phase ?? state.stage;
  if (typeof rawPhase !== "string") return null;

  const phase = rawPhase.trim().toLowerCase();
  if (!phase || TEAM_TERMINAL_PHASES.has(phase)) return null;
  return TEAM_ACTIVE_PHASES.has(phase) ? phase : null;
}

function getSafeReinforcementCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

const AWAITING_CONFIRMATION_TTL_MS = 2 * 60 * 1000;

function isAwaitingConfirmation(state) {
  if (!state || state.awaiting_confirmation !== true) {
    return false;
  }

  const preferred = state.awaiting_confirmation_set_at;
  const timestamp = typeof preferred === "string" && preferred.trim()
    ? preferred
    : typeof state.started_at === "string" && state.started_at.trim()
      ? state.started_at
      : null;
  if (!timestamp) {
    return false;
  }

  const timestampMs = new Date(timestamp).getTime();
  const ageMs = Date.now() - timestampMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < AWAITING_CONFIRMATION_TTL_MS;
}

function clearLoadedStateFile(loaded) {
  const statePath = loaded?.path;
  const expectedSnapshot = loaded?.state ? JSON.stringify(loaded.state) : null;
  if (!statePath || !expectedSnapshot || !existsSync(statePath)) return false;

  let cleared = false;
  try {
    withStateFileLockSync(statePath, () => {
      const current = readJsonFile(statePath);
      if (current && JSON.stringify(current) === expectedSnapshot && existsSync(statePath)) {
        unlinkSync(statePath);
        cleared = true;
      }
    });
  } catch {
    // Best effort: failing to clean an orphan should not re-arm stop blocking.
  }
  return cleared;
}

/**
 * Normalize a path for comparison.
 */
function normalizePath(p) {
  if (!p) return "";
  let normalized = resolve(p);
  normalized = normalize(normalized);
  normalized = normalized.replace(/[\/\\]+$/, "");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Check if a state belongs to the current project.
 */
function isStateForCurrentProject(
  state,
  currentDirectory,
  isGlobalState = false,
) {
  if (!state) return true;

  if (!state.project_path) {
    if (isGlobalState) {
      return false;
    }
    return true;
  }

  return normalizePath(state.project_path) === normalizePath(currentDirectory);
}

/**
 * Read state file from local or global location, tracking the source.
 * Returns { state, path, isGlobal } to track where the state was loaded from.
 */
function readStateFile(stateDir, globalStateDir, filename) {
  const localPath = join(stateDir, filename);
  const globalPath = join(globalStateDir, filename);

  let state = readJsonFile(localPath);
  if (state) return { state, path: localPath, isGlobal: false };

  state = readJsonFile(globalPath);
  if (state) return { state, path: globalPath, isGlobal: true };

  return { state: null, path: localPath, isGlobal: false }; // Default to local for new writes
}

const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function sanitizeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return "";
  return SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : "";
}

/**
 * Read state file with session-scoped path support.
 * If sessionId is provided, prefers the session-scoped path, then scans other
 * session directories and legacy state for matching ownership.
 */
function readStateFileWithSession(stateDir, globalStateDir, filename, sessionId) {
  const safeSessionId = sanitizeSessionId(sessionId);
  if (safeSessionId) {
    const sessionsDir = join(stateDir, "sessions", safeSessionId);
    const sessionPath = join(sessionsDir, filename);
    const state = readJsonFile(sessionPath);
    if (state) {
      return { state, path: sessionPath, isGlobal: false };
    }

    try {
      const allSessionsDir = join(stateDir, "sessions");
      if (existsSync(allSessionsDir)) {
        const dirs = readdirSync(allSessionsDir).filter((dir) => SESSION_ID_ALLOWLIST.test(dir));
        for (const dir of dirs) {
          const candidatePath = join(allSessionsDir, dir, filename);
          const candidateState = readJsonFile(candidatePath);
          if (candidateState && candidateState.session_id === safeSessionId) {
            return { state: candidateState, path: candidatePath, isGlobal: false };
          }
        }
      }
    } catch {
      // ignore scan failures
    }

    const legacyResult = readStateFile(stateDir, globalStateDir, filename);
    if (legacyResult.state && legacyResult.state.session_id === safeSessionId) {
      return legacyResult;
    }

    return { state: null, path: sessionPath, isGlobal: false };
  }

  return readStateFile(stateDir, globalStateDir, filename);
}

const MODE_SLOT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

function isModeSlotTombstoned(stateDir, mode, sessionId) {
  const safeSessionId = sanitizeSessionId(sessionId);
  const ledgerPath = safeSessionId
    ? join(stateDir, "sessions", safeSessionId, "skill-active-state.json")
    : join(stateDir, "skill-active-state.json");
  const ledger = readJsonFile(ledgerPath);
  const slot = ledger?.active_skills?.[mode];
  if (!slot || typeof slot !== "object") return false;
  if (typeof slot.completed_at !== "string" || !slot.completed_at) return false;
  const completedAt = new Date(slot.completed_at).getTime();
  if (!Number.isFinite(completedAt)) return true;
  return Date.now() - completedAt < MODE_SLOT_TOMBSTONE_TTL_MS;
}

function isAuthoritativeModeActive(stateDir, mode, loaded, sessionId) {
  const state = loaded?.state;
  if (!state?.active) return false;
  if (isModeSlotTombstoned(stateDir, mode, sessionId)) return false;
  const safeSessionId = sanitizeSessionId(sessionId);
  if (safeSessionId && state.session_id && state.session_id !== safeSessionId) return false;
  return true;
}

function normalizePhaseValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : "";
}


function shouldWriteStateBack(path) {
  return Boolean(path && existsSync(path));
}

function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_ALLOWLIST.test(sessionId);
}

function isContextLimitStop(data) {
  const reasons = [
    data.stop_reason,
    data.stopReason,
    data.end_turn_reason,
    data.endTurnReason,
    data.reason,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"));

  const contextPatterns = [
    "context_limit",
    "context_window",
    "context_exceeded",
    "context_full",
    "max_context",
    "token_limit",
    "max_tokens",
    "conversation_too_long",
    "input_too_long",
  ];

  return reasons.some((reason) => contextPatterns.some((p) => reason.includes(p)));
}

const CRITICAL_CONTEXT_STOP_PERCENT = 95;

function estimateContextPercent(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  let fd = -1;
  try {
    const size = statSync(transcriptPath).size;
    if (size === 0) return 0;

    // Read only the last 4KB to avoid OOM on large transcripts (10-100MB)
    const readSize = Math.min(4096, size);
    const buf = Buffer.alloc(readSize);
    fd = openSync(transcriptPath, "r");
    readSync(fd, buf, 0, readSize, size - readSize);
    closeSync(fd);
    fd = -1;

    const content = buf.toString("utf-8");
    const windowMatch = content.match(/"context_window"\s{0,5}:\s{0,5}(\d+)/g);
    const inputMatch = content.match(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g);
    if (!windowMatch || !inputMatch) return 0;

    const lastWindow = parseInt(windowMatch[windowMatch.length - 1].match(/(\d+)/)[1], 10);
    const lastInput = parseInt(inputMatch[inputMatch.length - 1].match(/(\d+)/)[1], 10);
    if (!Number.isFinite(lastWindow) || lastWindow <= 0 || !Number.isFinite(lastInput)) return 0;
    return Math.round((lastInput / lastWindow) * 100);
  } catch {
    if (fd !== -1) try { closeSync(fd); } catch { /* best-effort */ }
    return 0;
  }
}

/**
 * Detect if stop was triggered by user abort (Ctrl+C, cancel button, etc.)
 */
function isUserAbort(data) {
  if (data.user_requested || data.userRequested) return true;

  const reason = (data.stop_reason || data.stopReason || "").toLowerCase();
  // Exact-match patterns: short generic words that cause false positives with .includes()
  const exactPatterns = ["aborted", "abort", "cancel", "interrupt"];
  // Substring patterns: compound words safe for .includes() matching
  const substringPatterns = [
    "user_cancel",
    "user_interrupt",
    "ctrl_c",
    "manual_stop",
  ];

  return (
    exactPatterns.some((p) => reason === p) ||
    substringPatterns.some((p) => reason.includes(p))
  );
}

const AUTHENTICATION_ERROR_PATTERNS = [
  "authentication_error",
  "authentication_failed",
  "auth_error",
  "unauthorized",
  "unauthorised",
  "401",
  "403",
  "forbidden",
  "invalid_token",
  "token_invalid",
  "token_expired",
  "expired_token",
  "oauth_expired",
  "oauth_token_expired",
  "invalid_grant",
  "insufficient_scope",
];

function isAuthenticationError(data) {
  const reason = (data.stop_reason || data.stopReason || "").toLowerCase();
  const endTurnReason = (
    data.end_turn_reason ||
    data.endTurnReason ||
    ""
  ).toLowerCase();

  return AUTHENTICATION_ERROR_PATTERNS.some(
    (pattern) => reason.includes(pattern) || endTurnReason.includes(pattern),
  );
}

function isScheduledWakeupStop(data) {
  const stopPatterns = [
    "schedulewakeup",
    "schedule_wakeup",
    "scheduled_wakeup",
    "scheduled_task",
    "scheduled_resume",
    "loop_resume",
    "loop_wakeup",
  ];

  const toolName = String(data.tool_name || data.toolName || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (stopPatterns.some((pattern) => toolName.includes(pattern))) {
    return true;
  }

  const reasons = [
    data.stop_reason,
    data.stopReason,
    data.end_turn_reason,
    data.endTurnReason,
    data.reason,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"));

  return reasons.some((reason) => stopPatterns.some((pattern) => reason.includes(pattern)));
}

async function main() {
  try {
    if (shouldSkipPersistentModeHook()) {
      writeSafeContinue();
      return;
    }

    const input = await readStdin();
    let data = {};
    try {
      data = JSON.parse(input);
    } catch {
      writeSafeContinue();
      return;
    }

    // Claude Code sets stop_hook_active when a Stop hook is already running. Never
    // emit another decision:block in that re-entrant path: it trips Claude Code's
    // safety override for repeatedly blocked Stop hooks.
    if (data.stop_hook_active === true) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    const directory = data.cwd || data.directory || process.cwd();
    const sessionIdRaw = data.sessionId || data.session_id || data.sessionid || "";
    const sessionId = sanitizeSessionId(sessionIdRaw);
    const hasValidSessionId = isValidSessionId(sessionIdRaw);
    const lmghRoot = await resolveLmghStateRoot(directory);
    const stateDir = join(lmghRoot, "state");
    const globalStateDir = join(homedir(), STATE_DIR, "state");

    // Never block a context-limit stop: blocking deadlocks compaction.
    if (isContextLimitStop(data)) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    const criticalTranscriptPath = data.transcript_path || data.transcriptPath || "";
    if (estimateContextPercent(criticalTranscriptPath) >= CRITICAL_CONTEXT_STOP_PERCENT) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    if (isUserAbort(data)) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    // Never block auth failures (401/403/expired OAuth): allow the re-auth flow.
    if (isAuthenticationError(data)) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    if (isScheduledWakeupStop(data)) {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    const pending = classifyPendingWork(data);

    const ralph = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "ralph-state.json",
      sessionId,
    );

    if (
      isAuthoritativeModeActive(stateDir, "ralph", ralph, sessionId) &&
      !isAwaitingConfirmation(ralph.state) &&
      !isStaleState(ralph.state) &&
      isStateForCurrentProject(ralph.state, directory, ralph.isGlobal)
    ) {
      const sessionMatches = hasValidSessionId
        ? ralph.state.session_id === sessionId
        : !ralph.state.session_id || ralph.state.session_id === sessionId;
      if (sessionMatches) {
        if (pending.kind !== "none") {
          ralph.state.last_checked_at = new Date().toISOString();
          if (!shouldWriteStateBack(ralph.path)) {
            console.log(JSON.stringify(SAFE_CONTINUE));
            return;
          }
          writeJsonFile(ralph.path, ralph.state);
          if (pending.kind === "defer") {
            console.log(JSON.stringify(SAFE_CONTINUE));
          } else {
            console.log(JSON.stringify({ decision: "block", reason: formatWaitingReason(pending.tasks) }));
          }
          return;
        }

        const iteration = ralph.state.iteration || 1;
        const maxIter = ralph.state.max_iterations || 100;

        if (iteration < maxIter) {
          const toolError = readLastToolError(stateDir);
          const errorGuidance = getToolErrorRetryGuidance(toolError);

          ralph.state.iteration = iteration + 1;
          ralph.state.last_checked_at = new Date().toISOString();
          if (!shouldWriteStateBack(ralph.path)) {
            console.log(JSON.stringify(SAFE_CONTINUE));
            return;
          }
          writeJsonFile(ralph.path, ralph.state);

          let reason = `[RALPH LOOP - ITERATION ${iteration + 1}/${maxIter}] Work is NOT done. Continue working.\nWhen FULLY complete (after reviewer verification), run /let-me-go-home:cancel to cleanly exit ralph mode and clean up all state files. If cancel fails, retry with /let-me-go-home:cancel --force.\n${formatRalphTaskLines(ralph.state.prompt, ralph.state.prompt_file, ralph.path).join("\n")}`;
          if (errorGuidance) {
            reason = errorGuidance + reason;
          }

          console.log(JSON.stringify({ decision: "block", reason }));
          return;
        }

        // Check the hard max before extending.
        const hardMax = getHardMaxIterations();
        if (hardMax > 0 && maxIter >= hardMax) {
          ralph.state.active = false;
          ralph.state.last_checked_at = new Date().toISOString();
          if (!shouldWriteStateBack(ralph.path)) {
            console.log(JSON.stringify(SAFE_CONTINUE));
            return;
          }
          writeJsonFile(ralph.path, ralph.state);

          console.log(
            JSON.stringify({
              decision: "block",
              reason: `[RALPH LOOP - HARD LIMIT] Reached hard max iterations (${hardMax}). Mode auto-disabled. Restart with /let-me-go-home:ralph if needed.`,
            }),
          );
          return;
        }

        // Extend and keep going.
        ralph.state.max_iterations = maxIter + 10;
        ralph.state.last_checked_at = new Date().toISOString();
        if (!shouldWriteStateBack(ralph.path)) {
          console.log(JSON.stringify(SAFE_CONTINUE));
          return;
        }
        writeJsonFile(ralph.path, ralph.state);

        console.log(
          JSON.stringify({
            decision: "block",
            reason: `[RALPH LOOP - EXTENDED] Max iterations reached; extending to ${ralph.state.max_iterations} and continuing. When FULLY complete (after reviewer verification), run /let-me-go-home:cancel (or --force).`,
          }),
        );
        return;
      }
    }

    if (pending.kind !== "none") {
      console.log(JSON.stringify(SAFE_CONTINUE));
      return;
    }

    // Nothing to block.
    if (sessionId && shouldSendIdleNotification(stateDir)) {
      if (dispatchIdleNotificationInBackground(sessionId, directory)) {
        recordIdleNotificationSent(stateDir);
      }
    }
    console.log(JSON.stringify(SAFE_CONTINUE));
  } catch (error) {
    try {
      process.stderr.write(`[ralph-stop] Error: ${error?.message || error}\n`);
    } catch {
      // Ignore stderr failures; a valid JSON response still has to go out.
    }
    writeSafeContinue();
  }
}

main().finally(() => {
  clearTimeout(safetyTimeout);
});
