/**
 * State Management MCP Tools
 *
 * Provides tools for reading, writing, and managing mode state files.
 * All paths are validated to stay within the worktree boundary.
 */

import { z } from 'zod';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import {
  resolveStatePath,
  ensureLmghDir,
  resolveStateWorkingDirectory,
  probeGitTopLevel,
  resolveSessionStatePath,
  ensureSessionStateDir,
  listSessionIds,
  validateSessionId,
  getLmghRoot,
  LmghPaths,
} from '../lib/worktree-paths.js';
import { resolveSessionId } from '../lib/session-id.js';
import { validatePayload } from '../lib/payload-limits.js';
import {
  canClearStateForSession,
  findCompletedSessionStateFiles,
  findCompletedSessionStateCandidates,
  findSessionOwnedStateCandidates,
  type StateFileDiscovery,
  getStateSessionOwner,
  writeStateFileLocked,
  writeStateFileLockedCreateIf,
  clearStateFileLockedIf,
} from '../lib/mode-state-io.js';
import {
  isModeActive,
  getActiveModes,
  getAllModeStatuses,
  clearModeState,
  getStateFilePath,
  MODE_CONFIGS,
  getActiveSessionsForMode,
  type ExecutionMode
} from '../hooks/mode-registry/index.js';
import { ToolDefinition } from './types.js';



// These are `as const` on purpose. Annotating them `[string, ...string[]]`
// widened StateToolMode to plain `string`, so every `mode === '<retired mode>'`
// comparison in this file typechecked and the compiler could not point at a
// branch that no accepted mode can reach.
// The execution modes this fork ships. Both have dedicated MODE_CONFIGS entries.
const EXECUTION_MODES = [
  'ralph', 'deep-interview'
] as const;

const STATE_TOOL_MODES = [
  ...EXECUTION_MODES,
  'skill-active',
] as const;
const STATE_WRITE_MODES = [
  ...EXECUTION_MODES,
  'skill-active'
] as const;
const EXTRA_STATE_ONLY_MODES = ['skill-active'] as const;
type StateToolMode = typeof STATE_TOOL_MODES[number];
type StateWriteMode = typeof STATE_WRITE_MODES[number];
// zod's ZodEnum type parameter wants a mutable tuple, so the readonly arrays
// above get mutable copies here. The literal element types survive the copy,
// which is the point — StateToolMode stays a union, not `string`.
const STATE_TOOL_MODE_VALUES = [...STATE_TOOL_MODES] as [StateToolMode, ...StateToolMode[]];
const STATE_WRITE_MODE_VALUES = [...STATE_WRITE_MODES] as [StateWriteMode, ...StateWriteMode[]];
const CANCEL_SIGNAL_TTL_MS = 30_000;
const OWNER_SESSION_FALLBACK_MODES = new Set<StateToolMode>(['ralph']);
const CONVERGED_STATE_PATH_MODES = new Set<StateToolMode>(['ralph']);
// Empty here: ultrawork was the only member and it is no longer an accepted
// mode, so the boundary rejects it before any handler sees it. The set and its
// predicate stay because a future retirement needs somewhere to land.
const RETIRED_WORKFLOW_MODES = new Set<StateToolMode>([]);

function isRetiredWorkflowMode(mode: string): boolean {
  return RETIRED_WORKFLOW_MODES.has(mode as StateToolMode);
}

function getStateFileName(mode: StateToolMode): string {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  return `${normalizedName}.json`;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}



/** Any own named-workflow marker, including a falsy value, makes the record runtime-owned. */
/** The portable emergency path may only pause or clear an exact discovered run. */
/** A named pause request is an exact capability, not a state replay payload. */

function listSessionIdsUnderLmghRoot(lmghRoot: string): string[] {
  const sessionsDir = join(lmghRoot, 'state', 'sessions');
  if (!existsSync(sessionsDir)) {
    return [];
  }

  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(name));
  } catch {
    return [];
  }
}

function getConvergedLmghRoots(root: string): string[] {
  const canonicalRoot = getLmghRoot(root);
  if (process.env.LMGH_STATE_DIR) return [canonicalRoot];
  if (probeGitTopLevel(root).status !== 'ok') return [canonicalRoot];

  const roots = new Set<string>([canonicalRoot]);
  roots.add(join(root, LmghPaths.ROOT));
  roots.add(join(homedir(), LmghPaths.ROOT));
  return [...roots];
}

function getConvergedStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): string[] {
  if (!CONVERGED_STATE_PATH_MODES.has(mode)) {
    return [];
  }

  const filename = getStateFileName(mode);
  const paths = new Set<string>();

  for (const lmghRoot of getConvergedLmghRoots(root)) {
    const stateDir = join(lmghRoot, 'state');
    if (sessionId) {
      paths.add(join(stateDir, 'sessions', sessionId, filename));
      for (const sid of listSessionIdsUnderLmghRoot(lmghRoot)) {
        const candidatePath = join(stateDir, 'sessions', sid, filename);
        const raw = readJsonRecord(candidatePath);
        if (raw && getStateSessionOwner(raw) === sessionId) {
          paths.add(candidatePath);
        }
      }
    } else {
      for (const sid of listSessionIdsUnderLmghRoot(lmghRoot)) {
        paths.add(join(stateDir, 'sessions', sid, filename));
      }
    }

    paths.add(join(stateDir, filename));
    paths.add(join(lmghRoot, filename));
  }

  return [...paths];
}

function isConvergedCandidateActiveForSession(statePath: string, sessionId?: string): boolean {
  const raw = readJsonRecord(statePath);
  if (!raw || raw.active !== true) {
    return false;
  }
  if (!sessionId) {
    return true;
  }
  return canClearStateForSession(raw, sessionId);
}


function clearDiscoveredStateCandidate(
  candidate: StateFileDiscovery,
  predicate: (state: Record<string, unknown>) => boolean,
  recoveryOptions?: { authorizeState: (state: Record<string, unknown>) => boolean },
): 'cleared' | 'skipped' | 'failed' {
  const sessionPathMatch = candidate.path.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)\/[^/]+$/);
  const pathSessionId = sessionPathMatch?.[1];
  const ownerSessionId = candidate.completedSessionId ?? candidate.ownerSessionId;
  const ownerRecovery = ownerSessionId && ownerSessionId !== pathSessionId
    ? { authorizeState: (state: Record<string, unknown>) => getStateSessionOwner(state) === ownerSessionId }
    : undefined;
  const effectiveRecovery = ownerRecovery && recoveryOptions
    ? { authorizeState: (state: Record<string, unknown>) => ownerRecovery.authorizeState(state) && recoveryOptions.authorizeState(state) }
    : ownerRecovery ?? recoveryOptions;
  return clearStateFileLockedIf(
    candidate.path,
    (current) => predicate(current) && JSON.stringify(current) === candidate.snapshot,
    effectiveRecovery,
  );
}

function discoverStatePaths(paths: string[]): StateFileDiscovery[] {
  const discovered: StateFileDiscovery[] = [];
  for (const path of paths) {
    const state = readJsonRecord(path);
    if (!state) continue;
    discovered.push({
      path,
      state,
      snapshot: JSON.stringify(state),
      ownerSessionId: getStateSessionOwner(state),
      workflowRunId: typeof state.workflowRunId === 'string' ? state.workflowRunId : undefined,
    });
  }
  return discovered;
}

function clearConvergedStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
  discovered = discoverStatePaths(getConvergedStateCandidates(mode, root, sessionId)),
): { cleared: number; hadFailure: boolean; paths: string[] } {
  let cleared = 0;
  let hadFailure = false;
  for (const candidate of discovered) {
    const result = clearDiscoveredStateCandidate(
      candidate,
      (current) => !sessionId || canClearStateForSession(current, sessionId),
    );
    if (result === 'cleared') cleared++;
    else if (result === 'failed') hadFailure = true;
  }
  return { cleared, hadFailure, paths: discovered.map((candidate) => candidate.path) };
}

function hasActiveConvergedState(mode: StateToolMode, root: string, sessionId?: string): boolean {
  return getConvergedStateCandidates(mode, root, sessionId)
    .some((statePath) => isConvergedCandidateActiveForSession(statePath, sessionId));
}

/**
 * Get the state file path for any mode.
 *
 * - For registry modes (8 modes): uses getStateFilePath from mode-registry
 * - For modes not in the registry: uses resolveStatePath from worktree-paths
 *
 * This handles swarm's SQLite (.db) file transparently.
 */
function getStatePath(mode: StateToolMode, root: string): string {
  if (MODE_CONFIGS[mode as ExecutionMode]) {
    return getStateFilePath(root, mode as ExecutionMode);
  }
  // Fallback for modes not in the registry
  return resolveStatePath(mode, root);
}

function getLegacyStateFileCandidates(mode: StateToolMode, root: string): string[] {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  const candidates = [
    getStatePath(mode, root),
    join(getLmghRoot(root), `${normalizedName}.json`),
  ];

  return [...new Set(candidates)];
}

function getWorkingDirectoryLocalLmghRoot(root: string): string {
  return join(root, LmghPaths.ROOT);
}

function shouldCheckWorkingDirectoryLocalState(root: string): boolean {
  // Non-git state uses a canonical user/central root. Do not probe or mutate
  // `{workingDirectory}/.lmgh` implicitly; legacy recovery requires an explicit
  // migration path so unrelated directories cannot be swept together.
  if (probeGitTopLevel(root).status !== 'ok') return false;
  return getWorkingDirectoryLocalLmghRoot(root) !== getLmghRoot(root);
}

function getWorkingDirectoryLocalSessionStatePath(mode: StateToolMode, root: string, sessionId: string): string {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  return join(getWorkingDirectoryLocalLmghRoot(root), 'state', 'sessions', sessionId, `${normalizedName}.json`);
}

function getWorkingDirectoryLocalLegacyStateFileCandidates(mode: StateToolMode, root: string): string[] {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  return [
    join(getWorkingDirectoryLocalLmghRoot(root), 'state', `${normalizedName}.json`),
    join(getWorkingDirectoryLocalLmghRoot(root), `${normalizedName}.json`),
  ];
}

function getWorkingDirectoryLocalStateClearCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): string[] {
  if (!shouldCheckWorkingDirectoryLocalState(root)) {
    return [];
  }

  const paths = new Set<string>();
  if (sessionId) {
    paths.add(getWorkingDirectoryLocalSessionStatePath(mode, root, sessionId));
  }

  for (const legacyPath of getWorkingDirectoryLocalLegacyStateFileCandidates(mode, root)) {
    paths.add(legacyPath);
  }

  return [...paths];
}

function clearWorkingDirectoryLocalStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
  discovered = discoverStatePaths(getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId)),
): { cleared: number; hadFailure: boolean; paths: string[] } {
  let cleared = 0;
  let hadFailure = false;
  const localLegacyPaths = new Set(getWorkingDirectoryLocalLegacyStateFileCandidates(mode, root));
  for (const candidate of discovered) {
    const result = clearDiscoveredStateCandidate(
      candidate,
      (current) => !sessionId || !localLegacyPaths.has(candidate.path) || canClearStateForSession(current, sessionId),
    );
    if (result === 'cleared') cleared++;
    else if (result === 'failed') hadFailure = true;
  }
  return { cleared, hadFailure, paths: discovered.map((candidate) => candidate.path) };
}

function clearLegacyStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
  discovered = discoverStatePaths(getLegacyStateFileCandidates(mode, root)),
): { cleared: number; hadFailure: boolean } {
  let cleared = 0;
  let hadFailure = false;
  for (const candidate of discovered) {
    const result = clearDiscoveredStateCandidate(
      candidate,
      (current) => !sessionId || canClearStateForSession(current, sessionId),
    );
    if (result === 'cleared') cleared++;
    else if (result === 'failed') hadFailure = true;
  }
  return { cleared, hadFailure };
}

function clearSessionOwnedStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId: string,
  discovered = findSessionOwnedStateCandidates(mode, sessionId, root),
): { cleared: number; hadFailure: boolean; paths: string[] } {
  let cleared = 0;
  let hadFailure = false;
  for (const candidate of discovered) {
    const result = clearDiscoveredStateCandidate(
      candidate,
      (current) => canClearStateForSession(current, sessionId),
    );
    if (result === 'cleared') cleared++;
    else if (result === 'failed') hadFailure = true;
  }
  return { cleared, hadFailure, paths: discovered.map((candidate) => candidate.path) };
}

function clearCompletedSessionStateCandidates(
  mode: StateToolMode,
  root: string,
  requesterSessionId?: string,
  discovered = findCompletedSessionStateCandidates(mode, root, requesterSessionId),
): { cleared: number; hadFailure: boolean; paths: string[] } {
  let cleared = 0;
  let hadFailure = false;
  for (const candidate of discovered) {
    const result = clearDiscoveredStateCandidate(
      candidate,
      (current) => current.active === true
        && candidate.ownerSessionId === candidate.completedSessionId
        && getStateSessionOwner(current) === candidate.completedSessionId
        && Boolean(candidate.completionEvidencePath && existsSync(candidate.completionEvidencePath)),
    );
    if (result === 'cleared') cleared++;
    else if (result === 'failed') hadFailure = true;
  }
  return { cleared, hadFailure, paths: discovered.map((candidate) => candidate.path) };
}


function getStateClearCheckedPaths(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): string[] {
  const paths = new Set<string>();

  if (sessionId) {
    paths.add(MODE_CONFIGS[mode as ExecutionMode]
      ? getStateFilePath(root, mode as ExecutionMode, sessionId)
      : resolveSessionStatePath(mode, sessionId, root));
  } else {
    paths.add(getStatePath(mode, root));
  }

  for (const legacyPath of getLegacyStateFileCandidates(mode, root)) {
    paths.add(legacyPath);
  }

  for (const localPath of getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId)) {
    paths.add(localPath);
  }

  const sessionIds = sessionId ? [sessionId, ...listSessionIds(root)] : listSessionIds(root);
  for (const sid of new Set(sessionIds)) {
    paths.add(MODE_CONFIGS[mode as ExecutionMode]
      ? getStateFilePath(root, mode as ExecutionMode, sid)
      : resolveSessionStatePath(mode, sid, root));
  }

  return [...paths];
}

function formatStateClearNoopMessage(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): string {
  const scope = sessionId ? ` in session: ${sessionId}` : '';
  const checkedPaths = getStateClearCheckedPaths(mode, root, sessionId);
  const checked = checkedPaths.length > 0
    ? `\n- Checked paths:\n${checkedPaths.map((statePath) => `  - ${statePath}`).join('\n')}`
    : '';

  return `No state found to clear for mode: ${mode}${scope}${checked}`;
}

function getModeRuntimeArtifactNames(mode: StateToolMode): string[] {
  return [
    `${mode}-stop-breaker.json`,
    `${mode}-last-steer-at`,
    `${mode}-continue-steer.lock`,
  ];
}

function clearModeRuntimeArtifacts(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): { cleared: number; hadFailure: boolean } {
  let cleared = 0;
  let hadFailure = false;
  const stateRoot = join(getLmghRoot(root), 'state');
  const candidateDirs = new Set<string>([stateRoot]);

  if (sessionId) {
    candidateDirs.add(join(stateRoot, 'sessions', sessionId));
  } else {
    for (const sid of listSessionIds(root)) {
      candidateDirs.add(join(stateRoot, 'sessions', sid));
    }
  }

  for (const dir of candidateDirs) {
    for (const artifactName of getModeRuntimeArtifactNames(mode)) {
      const artifactPath = join(dir, artifactName);
      if (!existsSync(artifactPath)) {
        continue;
      }

      try {
        unlinkSync(artifactPath);
        cleared++;
      } catch {
        hadFailure = true;
      }
    }
  }

  return { cleared, hadFailure };
}

function writeSessionCancelSignal(
  root: string,
  sessionId: string,
  mode: StateToolMode,
  candidate?: StateFileDiscovery,
): void {
  ensureSessionStateDir(sessionId, root);
  const now = Date.now();
  const cancelSignalPath = resolveSessionStatePath('cancel-signal', sessionId, root);
  const payload = {
    active: true,
    requested_at: new Date(now).toISOString(),
    expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
    mode,
    source: 'state_clear',
    ...(candidate?.workflowRunId ? { target_workflow_run_id: candidate.workflowRunId } : {}),
    ...(candidate ? { target_state_sha256: createHash('sha256').update(candidate.snapshot).digest('hex') } : {}),
  };
  if (!writeStateFileLocked(cancelSignalPath, payload)) {
    throw new Error(`state mutation lock unavailable for cancel signal: ${cancelSignalPath}`);
  }
}

function isSessionModeActive(
  mode: StateToolMode,
  root: string,
  sessionId: string,
): boolean {
  if (MODE_CONFIGS[mode as ExecutionMode]) {
    return isModeActive(mode as ExecutionMode, root, sessionId);
  }

  const statePath = resolveSessionStatePath(mode, sessionId, root);
  if (!existsSync(statePath)) {
    return false;
  }

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    return state.active === true;
  } catch {
    return false;
  }
}

function findSingleOwningSessionForMode(
  mode: StateToolMode,
  root: string,
  requesterSessionId: string,
): string | undefined {
  const owningSessions = listSessionIds(root).filter((sid) => (
    sid !== requesterSessionId && isSessionModeActive(mode, root, sid)
  ));

  return owningSessions.length === 1 ? owningSessions[0] : undefined;
}

function publicStateForMode(_mode: StateToolMode, state: unknown): unknown {
  return state;
}

// ============================================================================
// state_read - Read state for a mode
// ============================================================================

export const stateReadTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODE_VALUES>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_read',
  description: 'Read the current state for a specific mode (ralph, deep-interview, etc.). Returns the JSON state data or indicates if no state exists.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODE_VALUES).describe('The mode to read state for'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      // If session_id provided, read from session-scoped path
      if (sessionId) {
        validateSessionId(sessionId);
        const statePath = MODE_CONFIGS[mode as ExecutionMode]
          ? getStateFilePath(root, mode as ExecutionMode, sessionId)
          : resolveSessionStatePath(mode, sessionId, root);

        if (!existsSync(statePath)) {
          const completedSessionPaths = findCompletedSessionStateFiles(mode, root, sessionId);
          if (completedSessionPaths.length > 0) {
            const orphanList = completedSessionPaths
              .map((orphanPath) => {
                const sessionMarker = `${join('state', 'sessions')}/`;
                const markerIndex = orphanPath.indexOf(sessionMarker);
                if (markerIndex === -1) return `- ${orphanPath}`;
                const rest = orphanPath.slice(markerIndex + sessionMarker.length);
                const orphanSessionId = rest.split(/[\\/]/)[0] || 'unknown';
                return `- session: ${orphanSessionId}\n  path: ${orphanPath}`;
              })
              .join('\n');
            return {
              content: [{
                type: 'text' as const,
                text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}\n\nDiscovered ${completedSessionPaths.length} completed-session orphan state file${completedSessionPaths.length === 1 ? '' : 's'} for this mode:\n${orphanList}\n\nRun state_clear(mode="${mode}", session_id="${sessionId}") to clear the current session plus these completed-session orphan files.`
              }]
            };
          }

          return {
            content: [{
              type: 'text' as const,
              text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}`
            }]
          };
        }

        const content = readFileSync(statePath, 'utf-8');
        const state = JSON.parse(content);
        const ownerSessionId = getStateSessionOwner(state);
        if (ownerSessionId && ownerSessionId !== sessionId) {
          return {
            content: [{
              type: 'text' as const,
              text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}`
            }]
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `## State for ${mode} (session: ${sessionId})\n\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\``
          }]
        };
      }

      // No session_id: scan all sessions and legacy path
      const statePath = getStatePath(mode, root);
      const legacyExists = existsSync(statePath);
      const sessionIds = listSessionIds(root);
      const activeSessions: string[] = [];

      for (const sid of sessionIds) {
        const sessionStatePath = MODE_CONFIGS[mode as ExecutionMode]
          ? getStateFilePath(root, mode as ExecutionMode, sid)
          : resolveSessionStatePath(mode, sid, root);

        if (existsSync(sessionStatePath)) {
          activeSessions.push(sid);
        }
      }

      if (!legacyExists && activeSessions.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No state found for mode: ${mode}\nExpected legacy path: ${statePath}\nNo active sessions found.\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.`
          }]
        };
      }

      let output = `## State for ${mode}\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.\n\n`;

      // Show legacy state if exists
      if (legacyExists) {
        try {
          const content = readFileSync(statePath, 'utf-8');
          const state = JSON.parse(content);
          output += `### Legacy Path (shared)\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\`\n\n`;
        } catch {
          output += `### Legacy Path (shared)\nPath: ${statePath}\n*Error reading state file*\n\n`;
        }
      }

      // Show active sessions
      if (activeSessions.length > 0) {
        output += `### Active Sessions (${activeSessions.length})\n\n`;
        for (const sid of activeSessions) {
          const sessionStatePath = MODE_CONFIGS[mode as ExecutionMode]
            ? getStateFilePath(root, mode as ExecutionMode, sid)
            : resolveSessionStatePath(mode, sid, root);

          try {
            const content = readFileSync(sessionStatePath, 'utf-8');
            const state = JSON.parse(content);
            output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\`\n\n`;
          } catch {
            output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n*Error reading state file*\n\n`;
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: output
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_write - Write state for a mode
// ============================================================================

export const stateWriteTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_WRITE_MODE_VALUES>;
  active: z.ZodOptional<z.ZodBoolean>;
  iteration: z.ZodOptional<z.ZodNumber>;
  max_iterations: z.ZodOptional<z.ZodNumber>;
  current_phase: z.ZodOptional<z.ZodString>;
  task_description: z.ZodOptional<z.ZodString>;
  plan_path: z.ZodOptional<z.ZodString>;
  started_at: z.ZodOptional<z.ZodString>;
  completed_at: z.ZodOptional<z.ZodString>;
  error: z.ZodOptional<z.ZodString>;
  state: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_write',
  description: 'Write/update state for a specific mode. Creates the state file and directories if they do not exist. Common fields (active, iteration, phase, etc.) can be set directly as parameters. Additional custom fields can be passed via the optional `state` parameter. Note: swarm uses SQLite and cannot be written via this tool.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_WRITE_MODE_VALUES).describe('The mode to write state for'),
    active: z.boolean().optional().describe('Whether the mode is currently active'),
    iteration: z.number().optional().describe('Current iteration number'),
    max_iterations: z.number().optional().describe('Maximum iterations allowed'),
    current_phase: z.string().max(200).optional().describe('Current execution phase'),
    task_description: z.string().max(2000).optional().describe('Description of the task being executed'),
    plan_path: z.string().max(500).optional().describe('Path to the plan file'),
    started_at: z.string().max(100).optional().describe('ISO timestamp when the mode started'),
    completed_at: z.string().max(100).optional().describe('ISO timestamp when the mode completed'),
    error: z.string().max(2000).optional().describe('Error message if the mode failed'),
    state: z.record(z.string(), z.unknown()).optional().describe('Additional custom state fields (merged with explicit parameters)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const {
      mode,
      active,
      iteration,
      max_iterations,
      current_phase,
      task_description,
      plan_path,
      started_at,
      completed_at,
      error,
      state,
      workingDirectory,
      session_id
    } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      // Validate custom state payload size if provided
      if (state) {
        const validation = validatePayload(state);
        if (!validation.valid) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: state payload rejected — ${validation.error}`
            }],
            isError: true
          };
        }
      }

      // Determine state path based on session_id
      let statePath: string;
      if (sessionId) {
        validateSessionId(sessionId);
        ensureSessionStateDir(sessionId, root);
        statePath = MODE_CONFIGS[mode as ExecutionMode]
          ? getStateFilePath(root, mode as ExecutionMode, sessionId)
          : resolveSessionStatePath(mode, sessionId, root);
      } else {
        ensureLmghDir('state', root);
        statePath = getStatePath(mode, root);
      }

      if (sessionId && existsSync(statePath)) {
        const existingState = readJsonRecord(statePath);
        const ownerSessionId = existingState ? getStateSessionOwner(existingState) : undefined;
        if (ownerSessionId && ownerSessionId !== sessionId) {
          throw new Error(`state is owned by session '${ownerSessionId}' and cannot be modified by session '${sessionId}'`);
        }
      }

      // Build state from explicit params + custom state
      const builtState: Record<string, unknown> = {};

      // Add explicit params (only if provided)
      if (active !== undefined) builtState.active = active;
      if (iteration !== undefined) builtState.iteration = iteration;
      if (max_iterations !== undefined) builtState.max_iterations = max_iterations;
      if (current_phase !== undefined) builtState.current_phase = current_phase;
      if (task_description !== undefined) builtState.task_description = task_description;
      if (plan_path !== undefined) builtState.plan_path = plan_path;
      if (started_at !== undefined) builtState.started_at = started_at;
      if (completed_at !== undefined) builtState.completed_at = completed_at;
      if (error !== undefined) builtState.error = error;

      // Merge custom state fields (explicit params take precedence)
      if (state) {
        for (const [key, value] of Object.entries(state)) {
          if (!(key in builtState)) {
            builtState[key] = value;
          }
        }
      }

      if (isRetiredWorkflowMode(mode) && builtState.active === true) {
        throw new Error('ultrawork is retired and cannot be activated via state_write; use state_clear to remove legacy state');
      }

      // Add metadata
      const stateWithMeta = {
        ...builtState,
        _meta: {
          mode,
          sessionId: sessionId || null,
          updatedAt: new Date().toISOString(),
          updatedBy: 'state_write_tool'
        }
      };
      const writtenState: Record<string, unknown> = stateWithMeta;
      const result = writeStateFileLockedCreateIf(
        statePath,
        (current) => !sessionId || !current || canClearStateForSession(current, sessionId),
        () => stateWithMeta,
      );
      if (result !== 'written') {
        throw new Error(result === 'failed'
          ? 'state mutation lock unavailable'
          : `state is owned by another session and cannot be modified by session '${sessionId ?? 'legacy'}'`);
      }


      const sessionInfo = sessionId ? ` (session: ${sessionId})` : ' (legacy path)';
      const warningMessage = sessionId ? '' : '\n\nWARNING: No session_id provided. State written to legacy shared path which may leak across parallel sessions. Pass session_id for session-scoped isolation.';
      return {
        content: [{
          type: 'text' as const,
          text: `Successfully wrote state for ${mode}${sessionInfo}\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(writtenState, null, 2)}\n\`\`\`${warningMessage}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error writing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_clear - Clear state for a mode
// ============================================================================

function discoverAllRootSessionStateCandidates(mode: StateToolMode, root: string): StateFileDiscovery[] {
  const paths = new Set<string>();
  const roots = new Set(getConvergedLmghRoots(root));
  if (shouldCheckWorkingDirectoryLocalState(root)) roots.add(getWorkingDirectoryLocalLmghRoot(root));
  roots.add(getLmghRoot(root));
  for (const lmghRoot of roots) {
    for (const sid of listSessionIdsUnderLmghRoot(lmghRoot)) {
      paths.add(join(lmghRoot, 'state', 'sessions', sid, getStateFileName(mode)));
    }
  }
  return discoverStatePaths([...paths]);
}

export const stateClearTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODE_VALUES>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_clear',
  description: 'Clear/delete state for a specific mode. Removes the state file and any associated marker files.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODE_VALUES).describe('The mode to clear state for'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;
      // Upstream collected team names here so team runtime roots and HUD
      // mission entries could be pruned alongside the state file. `team` is not
      // an accepted mode in this fork, so none of that is reachable.

      // If session_id provided, clear only session-specific state
      if (sessionId) {
        validateSessionId(sessionId);
        const requestedSessionCandidates = findSessionOwnedStateCandidates(mode, sessionId, root)
          .filter((candidate) => canClearStateForSession(candidate.state, sessionId));
        const requestedSessionOwnedPaths = requestedSessionCandidates.map((candidate) => candidate.path);
        const completedCandidates = findCompletedSessionStateCandidates(mode, root, sessionId);
        const legacyCandidates = discoverStatePaths(getLegacyStateFileCandidates(mode, root));
        const localCandidates = discoverStatePaths(getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId));
        const convergedCandidates = discoverStatePaths(getConvergedStateCandidates(mode, root, sessionId));
        const operationCandidates = [...new Map([
          ...requestedSessionCandidates,
          ...completedCandidates,
          ...legacyCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
          ...localCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
          ...convergedCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
        ].map((candidate) => [candidate.path, candidate])).values()];
        const directCandidate = requestedSessionCandidates.find((candidate) => candidate.path === resolveSessionStatePath(mode, sessionId, root)) ?? requestedSessionCandidates[0];
        const namedPrimaryPaths = new Set<string>();
        let directCleared = 0;
        const completedSessionCleanup = clearCompletedSessionStateCandidates(mode, root, sessionId, completedCandidates.filter((candidate) => !namedPrimaryPaths.has(candidate.path)));
        const runtimeCleanup = clearModeRuntimeArtifacts(mode, root, sessionId);
        let convergedCleanup = { cleared: 0, hadFailure: false, paths: [] as string[] };
        const sessionSignalCandidates = operationCandidates;
        const signaledCandidateDirs = new Set<string>();
        for (const candidate of sessionSignalCandidates) {
          const signalDir = dirname(candidate.path);
          if (signaledCandidateDirs.has(signalDir)) continue;
          signaledCandidateDirs.add(signalDir);
          const now = Date.now();
          const signalPath = join(signalDir, 'cancel-signal-state.json');
          const payload = {
            active: true,
            requested_at: new Date(now).toISOString(),
            expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
            mode,
            source: 'state_clear' as const,
            ...(candidate.workflowRunId ? { target_workflow_run_id: candidate.workflowRunId } : {}),
            target_state_sha256: createHash('sha256').update(candidate.snapshot).digest('hex'),
          };
          try { writeStateFileLocked(signalPath, payload); } catch { /* best-effort */ }
        }
        if (sessionSignalCandidates.length === 0) writeSessionCancelSignal(root, sessionId, mode, directCandidate);

        if (MODE_CONFIGS[mode as ExecutionMode]) {
          const expectedDirectState = directCandidate?.state;
          const success = clearModeState(mode as ExecutionMode, root, sessionId, expectedDirectState);
          if (directCandidate && !existsSync(directCandidate.path)) directCleared = 1;
          const sessionCleanup = clearSessionOwnedStateCandidates(mode, root, sessionId, requestedSessionCandidates);
          const legacyCleanup = clearLegacyStateCandidates(mode, root, sessionId, legacyCandidates);
          const shouldUseLocalFallback = requestedSessionOwnedPaths.length === 0 &&
            completedSessionCleanup.cleared === 0 &&
            sessionCleanup.cleared === 0 &&
            legacyCleanup.cleared === 0;
          const workingDirectoryLocalCleanup = shouldUseLocalFallback
            ? clearWorkingDirectoryLocalStateCandidates(mode, root, sessionId, localCandidates)
            : { cleared: 0, hadFailure: false, paths: [] as string[] };
          convergedCleanup = clearConvergedStateCandidates(mode, root, sessionId, convergedCandidates);
          let ownerSessionId: string | undefined;
          let ownerSessionCleanup = { cleared: 0, hadFailure: false, paths: [] as string[] };
          let ownerLegacyCleanup = { cleared: 0, hadFailure: false };

          if (
            OWNER_SESSION_FALLBACK_MODES.has(mode) &&
            requestedSessionOwnedPaths.length === 0 &&
            completedCandidates.length === 0 &&
            legacyCandidates.length === 0 &&
            completedSessionCleanup.cleared === 0 &&
            sessionCleanup.cleared === 0 &&
            legacyCleanup.cleared === 0 &&
            convergedCleanup.cleared === 0 &&
            workingDirectoryLocalCleanup.cleared === 0
          ) {
            ownerSessionId = findSingleOwningSessionForMode(mode, root, sessionId);
            if (ownerSessionId !== sessionId) ownerSessionId = undefined;
            if (ownerSessionId) {
              const ownerCandidates = findSessionOwnedStateCandidates(mode, ownerSessionId, root);
              const ownerDirectCandidate = ownerCandidates.find((candidate) => candidate.path === resolveSessionStatePath(mode, ownerSessionId!, root)) ?? ownerCandidates[0];
              writeSessionCancelSignal(root, ownerSessionId, mode, ownerDirectCandidate);
              clearModeState(mode as ExecutionMode, root, ownerSessionId, ownerDirectCandidate?.state);
              const ownerRuntimeCleanup = clearModeRuntimeArtifacts(mode, root, ownerSessionId);
              runtimeCleanup.cleared += ownerRuntimeCleanup.cleared;
              runtimeCleanup.hadFailure ||= ownerRuntimeCleanup.hadFailure;
              ownerSessionCleanup = clearSessionOwnedStateCandidates(mode, root, ownerSessionId, ownerCandidates);
              ownerLegacyCleanup = clearLegacyStateCandidates(mode, root, ownerSessionId);
            }
          }

          const ghostNoteParts: string[] = [];
          if (legacyCleanup.cleared > 0) {
            ghostNoteParts.push('ghost legacy file also removed');
          }
          if (completedSessionCleanup.cleared > 0) {
            ghostNoteParts.push(`removed ${completedSessionCleanup.cleared} completed-session orphan file${completedSessionCleanup.cleared === 1 ? '' : 's'}`);
          }
          if (sessionCleanup.cleared > 0) {
            ghostNoteParts.push(`removed ${sessionCleanup.cleared} recovered session file${sessionCleanup.cleared === 1 ? '' : 's'}`);
          }
          if (workingDirectoryLocalCleanup.cleared > 0) {
            ghostNoteParts.push(`removed ${workingDirectoryLocalCleanup.cleared} workingDirectory-local state file${workingDirectoryLocalCleanup.cleared === 1 ? '' : 's'}`);
          }
          if (convergedCleanup.cleared > 0) {
            ghostNoteParts.push(`removed ${convergedCleanup.cleared} converged state file${convergedCleanup.cleared === 1 ? '' : 's'}`);
          }
          if (runtimeCleanup.cleared > 0) {
            ghostNoteParts.push(`removed ${runtimeCleanup.cleared} runtime artifact${runtimeCleanup.cleared === 1 ? '' : 's'}`);
          }
          if (ownerSessionId) {
            ghostNoteParts.push(`cleared owning session: ${ownerSessionId}`);
          }
          const ghostNote = ghostNoteParts.length > 0 ? ` (${ghostNoteParts.join(', ')})` : '';
          const runtimeCleanupNote = '';
          const clearedStateOrArtifacts = directCleared + completedSessionCleanup.cleared +
            sessionCleanup.cleared +
            legacyCleanup.cleared +
            convergedCleanup.cleared +
            workingDirectoryLocalCleanup.cleared +
            ownerSessionCleanup.cleared +
            ownerLegacyCleanup.cleared +
            runtimeCleanup.cleared;
          const capturedCleanupIncomplete = operationCandidates.some((candidate) => existsSync(candidate.path));
          if (!ownerSessionId && clearedStateOrArtifacts === 0 && success &&
            !capturedCleanupIncomplete &&
            !legacyCleanup.hadFailure &&
            !sessionCleanup.hadFailure &&
            !workingDirectoryLocalCleanup.hadFailure &&
            !convergedCleanup.hadFailure &&
            !completedSessionCleanup.hadFailure &&
            !ownerSessionCleanup.hadFailure &&
            !ownerLegacyCleanup.hadFailure &&
            !runtimeCleanup.hadFailure
          ) {
            return {
              content: [{
                type: 'text' as const,
                text: formatStateClearNoopMessage(mode, root, sessionId)
              }]
            };
          }
          if (
            !capturedCleanupIncomplete &&
            success &&
            !legacyCleanup.hadFailure &&
            !sessionCleanup.hadFailure &&
            !workingDirectoryLocalCleanup.hadFailure &&
            !convergedCleanup.hadFailure &&
            !completedSessionCleanup.hadFailure &&
            !ownerSessionCleanup.hadFailure &&
            !ownerLegacyCleanup.hadFailure &&
            !runtimeCleanup.hadFailure
          ) {
            return {
              content: [{
                type: 'text' as const,
                text: `Successfully cleared state for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
              }]
            };
          } else {
            return {
              content: [{
                type: 'text' as const,
                text: `Warning: Some files could not be removed for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
              }],
              isError: true,
            };
          }
        }

        // Fallback for modes not in the registry
        const sessionCleanup = clearSessionOwnedStateCandidates(mode, root, sessionId, requestedSessionCandidates);
        const legacyCleanup = clearLegacyStateCandidates(mode, root, sessionId, legacyCandidates);
        const shouldUseLocalFallback = requestedSessionOwnedPaths.length === 0 &&
          completedSessionCleanup.cleared === 0 &&
          sessionCleanup.cleared === 0 &&
          legacyCleanup.cleared === 0;
        const workingDirectoryLocalCleanup = shouldUseLocalFallback
          ? clearWorkingDirectoryLocalStateCandidates(mode, root, sessionId, localCandidates)
          : { cleared: 0, hadFailure: false, paths: [] as string[] };
        convergedCleanup = clearConvergedStateCandidates(mode, root, sessionId, convergedCandidates);
        let ownerSessionId: string | undefined;
        let ownerSessionCleanup = { cleared: 0, hadFailure: false, paths: [] as string[] };
        let ownerLegacyCleanup = { cleared: 0, hadFailure: false };

        if (
          OWNER_SESSION_FALLBACK_MODES.has(mode) &&
          requestedSessionOwnedPaths.length === 0 &&
          completedCandidates.length === 0 &&
          legacyCandidates.length === 0 &&
          completedSessionCleanup.cleared === 0 &&
          sessionCleanup.cleared === 0 &&
          legacyCleanup.cleared === 0 &&
          convergedCleanup.cleared === 0 &&
          workingDirectoryLocalCleanup.cleared === 0
        ) {
          ownerSessionId = findSingleOwningSessionForMode(mode, root, sessionId);
          if (ownerSessionId !== sessionId) ownerSessionId = undefined;
          if (ownerSessionId) {
            const ownerCandidates = findSessionOwnedStateCandidates(mode, ownerSessionId, root);
            const ownerDirectCandidate = ownerCandidates.find((candidate) => candidate.path === resolveSessionStatePath(mode, ownerSessionId!, root)) ?? ownerCandidates[0];
            writeSessionCancelSignal(root, ownerSessionId, mode, ownerDirectCandidate);
            const ownerRuntimeCleanup = clearModeRuntimeArtifacts(mode, root, ownerSessionId);
            runtimeCleanup.cleared += ownerRuntimeCleanup.cleared;
            runtimeCleanup.hadFailure ||= ownerRuntimeCleanup.hadFailure;
            ownerSessionCleanup = clearSessionOwnedStateCandidates(mode, root, ownerSessionId, ownerCandidates);
            ownerLegacyCleanup = clearLegacyStateCandidates(mode, root, ownerSessionId);
          }
        }

        const ghostNoteParts: string[] = [];
        if (legacyCleanup.cleared > 0) {
          ghostNoteParts.push('ghost legacy file also removed');
        }
        if (completedSessionCleanup.cleared > 0) {
          ghostNoteParts.push(`removed ${completedSessionCleanup.cleared} completed-session orphan file${completedSessionCleanup.cleared === 1 ? '' : 's'}`);
        }
        if (sessionCleanup.cleared > 0) {
          ghostNoteParts.push(`removed ${sessionCleanup.cleared} recovered session file${sessionCleanup.cleared === 1 ? '' : 's'}`);
        }
        if (workingDirectoryLocalCleanup.cleared > 0) {
          ghostNoteParts.push(`removed ${workingDirectoryLocalCleanup.cleared} workingDirectory-local state file${workingDirectoryLocalCleanup.cleared === 1 ? '' : 's'}`);
        }
        if (convergedCleanup.cleared > 0) {
          ghostNoteParts.push(`removed ${convergedCleanup.cleared} converged state file${convergedCleanup.cleared === 1 ? '' : 's'}`);
        }
        if (runtimeCleanup.cleared > 0) {
          ghostNoteParts.push(`removed ${runtimeCleanup.cleared} runtime artifact${runtimeCleanup.cleared === 1 ? '' : 's'}`);
        }
        if (ownerSessionId) {
          ghostNoteParts.push(`cleared owning session: ${ownerSessionId}`);
        }
        const ghostNote = ghostNoteParts.length > 0 ? ` (${ghostNoteParts.join(', ')})` : '';
        const runtimeCleanupNote = '';
        const clearedStateOrArtifacts = completedSessionCleanup.cleared +
          sessionCleanup.cleared +
          legacyCleanup.cleared +
          convergedCleanup.cleared +
          workingDirectoryLocalCleanup.cleared +
          ownerSessionCleanup.cleared +
          ownerLegacyCleanup.cleared +
          runtimeCleanup.cleared;
        const capturedCleanupIncomplete = operationCandidates.some((candidate) => existsSync(candidate.path));
        const hadFailure = capturedCleanupIncomplete || legacyCleanup.hadFailure || sessionCleanup.hadFailure ||
          workingDirectoryLocalCleanup.hadFailure || convergedCleanup.hadFailure ||
          completedSessionCleanup.hadFailure || ownerSessionCleanup.hadFailure ||
          ownerLegacyCleanup.hadFailure || runtimeCleanup.hadFailure;
        if (!ownerSessionId && clearedStateOrArtifacts === 0 && !hadFailure) {
          return {
            content: [{
              type: 'text' as const,
              text: formatStateClearNoopMessage(mode, root, sessionId)
            }]
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `${hadFailure ? 'Warning: Some files could not be removed' : 'Successfully cleared state'} for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
          }],
          ...(hadFailure ? { isError: true } : {}),
        };
      }

      // No session_id: clear from all locations (legacy + all sessions)
      // Write cancel signals FIRST (before deleting files) so the stop hook's
      // isSessionCancelInProgress check sees the signal during the deletion window.
      // Mirrors the session_id path at line ~403. (patch: fix missing cancel signal)
      const broadLegacyCandidates = discoverStatePaths(getLegacyStateFileCandidates(mode, root));
      const broadSessionCandidates = [...new Map([
        ...listSessionIds(root).flatMap((sid) => findSessionOwnedStateCandidates(mode, sid, root)),
        ...discoverAllRootSessionStateCandidates(mode, root),
      ].map((candidate) => [candidate.path, candidate])).values()];
      const broadConvergedCandidates = discoverStatePaths(getConvergedStateCandidates(mode, root));
      const _broadOperationCandidates = [...new Map([
        ...broadLegacyCandidates,
        ...broadSessionCandidates,
        ...broadConvergedCandidates,
      ].map((candidate) => [candidate.path, candidate])).values()];
      const broadLegacySignalCandidates = broadLegacyCandidates;
      const broadSessionSignalCandidates = broadSessionCandidates;
      if (broadLegacySignalCandidates.length > 0 || broadSessionSignalCandidates.length > 0) {
        const now = Date.now();
        const cancelSignalPayload = {
          active: true,
          requested_at: new Date(now).toISOString(),
          expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
          mode,
          source: 'state_clear' as const,
        };
        const signaledLegacyDirs = new Set<string>();
        for (const legacyCandidate of broadLegacySignalCandidates) {
          const signalDir = dirname(legacyCandidate.path);
          if (signaledLegacyDirs.has(signalDir)) continue;
          signaledLegacyDirs.add(signalDir);
          const legacySignalPath = join(signalDir, 'cancel-signal-state.json');
          const legacyPayload = {
            ...cancelSignalPayload,
            ...(legacyCandidate.workflowRunId ? { target_workflow_run_id: legacyCandidate.workflowRunId } : {}),
            target_state_sha256: createHash('sha256').update(legacyCandidate.snapshot).digest('hex'),
          };
          try { writeStateFileLocked(legacySignalPath, legacyPayload); } catch { /* best-effort */ }
        }
        const signaledOwners = new Set<string>();
        for (const candidate of broadSessionSignalCandidates) {
          const owner = candidate.ownerSessionId;
          if (!owner || signaledOwners.has(owner)) continue;
          signaledOwners.add(owner);
          try { writeSessionCancelSignal(root, owner, mode, candidate); } catch { /* best-effort */ }
        }
      }
      const runtimeCleanup = clearModeRuntimeArtifacts(mode, root);
      let clearedCount = 0;
      const errors: string[] = [];
      // Upstream cleared team state here. `team` is not a StateToolMode in this
      // fork, so the branch was already unreachable before its ExecutionMode
      // member went away.

      // Clear legacy path
      if (MODE_CONFIGS[mode as ExecutionMode]) {
        const primaryLegacyStatePath = getStateFilePath(root, mode as ExecutionMode);
        const primaryCandidate = broadLegacyCandidates.find((candidate) => candidate.path === primaryLegacyStatePath);
        if (primaryCandidate) {
          const success = clearModeState(mode as ExecutionMode, root, undefined, primaryCandidate.state);
          if (success && !existsSync(primaryCandidate.path)) {
            clearedCount++;
          } else if (existsSync(primaryCandidate.path)) {
            errors.push('legacy path skipped');
          } else if (!success) {
            errors.push('legacy path');
          }
        }
      }

      const extraLegacyCleanup = clearLegacyStateCandidates(mode, root, undefined, broadLegacyCandidates);
      clearedCount += extraLegacyCleanup.cleared;
      if (extraLegacyCleanup.hadFailure) {
        errors.push('legacy path');
      }
      const convergedCleanup = clearConvergedStateCandidates(mode, root, undefined, broadConvergedCandidates);
      clearedCount += convergedCleanup.cleared;
      if (convergedCleanup.hadFailure) {
        errors.push('converged paths');
      }
      clearedCount += runtimeCleanup.cleared;
      if (runtimeCleanup.hadFailure) {
        errors.push('runtime artifacts');
      }
      const processedBroadPaths = new Set([
        ...broadLegacyCandidates.map((candidate) => candidate.path),
        ...broadConvergedCandidates.map((candidate) => candidate.path),
      ]);

      // Clear each captured session candidate by its exact discovered path.
      for (const candidate of broadSessionCandidates) {
        if (processedBroadPaths.has(candidate.path)) continue;
        processedBroadPaths.add(candidate.path);
        const result = clearDiscoveredStateCandidate(candidate, () => true);
        if (result === 'cleared') {
          clearedCount++;
        } else if (result === 'failed' || existsSync(candidate.path)) {
          errors.push(`session candidate: ${candidate.path}`);
        }
      }
      const broadCapturedCandidates = [...new Map([
        ...broadLegacyCandidates,
        ...broadConvergedCandidates,
        ...broadSessionCandidates,
      ].map((candidate) => [candidate.path, candidate])).values()];
      for (const candidate of broadCapturedCandidates) {
        if (existsSync(candidate.path) && !errors.some((error) => error.includes(candidate.path))) {
          errors.push(`captured candidate survived: ${candidate.path}`);
        }
      }
      clearedCount = broadCapturedCandidates.filter((candidate) => !existsSync(candidate.path)).length + runtimeCleanup.cleared;

      if (clearedCount === 0 && errors.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: formatStateClearNoopMessage(mode, root)
          }]
        };
      }

      let message = `Cleared state for mode: ${mode}\n- Locations cleared: ${clearedCount}`;
      if (errors.length > 0) {
        message += `\n- Errors: ${errors.join(', ')}`;
      }
      message += '\nWARNING: No session_id provided. Cleared legacy plus all session-scoped state; this is a broad operation that may affect other sessions.';

      return {
        content: [{
          type: 'text' as const,
          text: message
        }],
        ...(errors.length > 0 ? { isError: true } : {})
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error clearing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_list_active - List all active modes
// ============================================================================

export const stateListActiveTool: ToolDefinition<{
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
  all: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'state_list_active',
  description: 'List all currently active modes. By default, scopes to the current session (LMGH_SESSION_ID). Pass all:true to list active modes across all sessions.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Explicit session ID to scope the listing. Overrides LMGH_SESSION_ID when provided.'),
    all: z.boolean().optional().describe('When true, list active modes across all sessions (legacy + every session-scoped dir). Overrides the default current-session scope.'),
  },
  handler: async (args) => {
    const { workingDirectory, session_id, all } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);

      // Resolve the effective session ID:
      //   1. Explicit session_id arg wins (back-compat for callers that pass it directly).
      //   2. all:true opts out of session scoping entirely → show everything.
      //   3. Otherwise default to the current session via resolveSessionId({context:'cli'}).
      const explicitSessionId = session_id as string | undefined;
      const showAll = all === true;
      const sessionId: string | undefined = explicitSessionId
        ?? (showAll ? undefined : resolveSessionId({ context: 'cli' }));

      // If session_id resolved (explicit or current session), show modes for that session
      if (sessionId) {
        validateSessionId(sessionId);

        // Get active modes from registry for this session
        const activeModes: string[] = [...getActiveModes(root, sessionId)]
          .filter((activeMode) => !isRetiredWorkflowMode(activeMode));

        for (const mode of EXTRA_STATE_ONLY_MODES) {
          try {
            const statePath = resolveSessionStatePath(mode, sessionId, root);
            if (existsSync(statePath)) {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              if (state.active && canClearStateForSession(state, sessionId)) {
                activeModes.push(mode);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        for (const mode of CONVERGED_STATE_PATH_MODES) {
          if (isRetiredWorkflowMode(mode)) continue;
          if (!activeModes.includes(mode) && hasActiveConvergedState(mode, root, sessionId)) {
            activeModes.push(mode);
          }
        }

        if (activeModes.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `## Active Modes (session: ${sessionId})\n\nNo modes are currently active in this session.`
            }]
          };
        }

        const modeList = activeModes.map(mode => `- **${mode}**`).join('\n');

        return {
          content: [{
            type: 'text' as const,
            text: `## Active Modes (session: ${sessionId}, ${activeModes.length})\n\n${modeList}`
          }]
        };
      }

      // No session_id: show all active modes across all sessions
      const modeSessionMap = new Map<string, string[]>();

      // Check legacy paths
      const legacyActiveModes: string[] = [...getActiveModes(root)]
        .filter((activeMode) => !isRetiredWorkflowMode(activeMode));
      for (const mode of EXTRA_STATE_ONLY_MODES) {
        const statePath = getStatePath(mode, root);
        if (existsSync(statePath)) {
          try {
            const content = readFileSync(statePath, 'utf-8');
            const state = JSON.parse(content);
            if (state.active) {
              legacyActiveModes.push(mode);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      for (const mode of CONVERGED_STATE_PATH_MODES) {
        if (isRetiredWorkflowMode(mode)) continue;
        if (!legacyActiveModes.includes(mode) && hasActiveConvergedState(mode, root)) {
          legacyActiveModes.push(mode);
        }
      }

      for (const mode of legacyActiveModes) {
        if (!modeSessionMap.has(mode)) {
          modeSessionMap.set(mode, []);
        }
        modeSessionMap.get(mode)!.push('legacy');
      }

      // Check all sessions
      const sessionIds = listSessionIds(root);
      for (const sid of sessionIds) {
        const sessionActiveModes: string[] = [...getActiveModes(root, sid)]
          .filter((activeMode) => !isRetiredWorkflowMode(activeMode));

        for (const mode of EXTRA_STATE_ONLY_MODES) {
          try {
            const statePath = resolveSessionStatePath(mode, sid, root);
            if (existsSync(statePath)) {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              if (state.active && canClearStateForSession(state, sid)) {
                sessionActiveModes.push(mode);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        for (const mode of sessionActiveModes) {
          if (!modeSessionMap.has(mode)) {
            modeSessionMap.set(mode, []);
          }
          modeSessionMap.get(mode)!.push(sid);
        }
      }

      if (modeSessionMap.size === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Active Modes\n\nNo modes are currently active.'
          }]
        };
      }

      const lines: string[] = [`## Active Modes (${modeSessionMap.size})\n`];
      for (const [mode, sessions] of Array.from(modeSessionMap.entries())) {
        lines.push(`- **${mode}** (${sessions.join(', ')})`);
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error listing active modes: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_get_status - Get detailed status for a mode
// ============================================================================

export const stateGetStatusTool: ToolDefinition<{
  mode: z.ZodOptional<z.ZodEnum<typeof STATE_TOOL_MODE_VALUES>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_get_status',
  description: 'Get detailed status for a specific mode or all modes. Shows active status, file paths, and state contents.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODE_VALUES).optional().describe('Specific mode to check (omit for all modes)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      if (mode) {
        // Single mode status
        const lines: string[] = [`## Status: ${mode}\n`];

        if (sessionId) {
          // Session-specific status
          validateSessionId(sessionId);
          const statePath = MODE_CONFIGS[mode as ExecutionMode]
            ? getStateFilePath(root, mode as ExecutionMode, sessionId)
            : resolveSessionStatePath(mode, sessionId, root);

          const active = !isRetiredWorkflowMode(mode) && (MODE_CONFIGS[mode as ExecutionMode]
            ? isModeActive(mode as ExecutionMode, root, sessionId)
            : existsSync(statePath) && (() => {
                try {
                  const content = readFileSync(statePath, 'utf-8');
                  const state = JSON.parse(content);
                  return state.active === true && canClearStateForSession(state, sessionId);
                } catch { return false; }
              })());

          let statePreview = 'No state file';
          if (existsSync(statePath)) {
            try {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              const owner = getStateSessionOwner(state);
              if (!owner || owner === sessionId) {
                statePreview = JSON.stringify(publicStateForMode(mode, state), null, 2).slice(0, 500);
              }
              if (statePreview.length >= 500) statePreview += '\n...(truncated)';
            } catch {
              statePreview = 'Error reading state file';
            }
          }

          lines.push(`### Session: ${sessionId}`);
          const visible = !existsSync(statePath) || statePreview !== 'No state file' && !statePreview.includes('Error reading state file');
          lines.push(`- **Active:** ${visible && active ? 'Yes' : 'No'}`);
          lines.push(`- **State Path:** ${statePath}`);
          lines.push(`- **Exists:** ${visible && existsSync(statePath) ? 'Yes' : 'No'}`);
          lines.push(`\n### State Preview\n\`\`\`json\n${statePreview}\n\`\`\``);

          return {
            content: [{
              type: 'text' as const,
              text: lines.join('\n')
            }]
          };
        }

        // No session_id: show all sessions + legacy
        const legacyPath = getStatePath(mode, root);
        const legacyActive = !isRetiredWorkflowMode(mode) && (MODE_CONFIGS[mode as ExecutionMode]
          ? isModeActive(mode as ExecutionMode, root)
          : existsSync(legacyPath) && (() => {
              try {
                const content = readFileSync(legacyPath, 'utf-8');
                const state = JSON.parse(content);
                return state.active === true;
              } catch { return false; }
            })());

        lines.push(`### Legacy Path`);
        lines.push(`- **Active:** ${legacyActive ? 'Yes' : 'No'}`);
        lines.push(`- **State Path:** ${legacyPath}`);
        lines.push(`- **Exists:** ${existsSync(legacyPath) ? 'Yes' : 'No'}\n`);

        // Show active sessions for this mode
        const activeSessions = isRetiredWorkflowMode(mode) ? [] : MODE_CONFIGS[mode as ExecutionMode]
          ? getActiveSessionsForMode(mode as ExecutionMode, root)
          : listSessionIds(root).filter(sid => {
              try {
                const sessionPath = resolveSessionStatePath(mode, sid, root);
                if (existsSync(sessionPath)) {
                  const content = readFileSync(sessionPath, 'utf-8');
                  const state = JSON.parse(content);
                  return state.active === true && canClearStateForSession(state, sid);
                }
                return false;
              } catch {
                return false;
              }
            });

        if (activeSessions.length > 0) {
          lines.push(`### Active Sessions (${activeSessions.length})`);
          for (const sid of activeSessions) {
            lines.push(`- ${sid}`);
          }
        } else {
          lines.push(`### Active Sessions\nNo active sessions for this mode.`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n')
          }]
        };
      }

      // All modes status
      const statuses = getAllModeStatuses(root, sessionId).map((status) =>
        isRetiredWorkflowMode(status.mode) ? { ...status, active: false } : status,
      );
      const lines = sessionId
        ? [`## All Mode Statuses (session: ${sessionId})\n`]
        : ['## All Mode Statuses\n'];

      for (const status of statuses) {
        const icon = status.active ? '[ACTIVE]' : '[INACTIVE]';
        lines.push(`${icon} **${status.mode}**: ${status.active ? 'Active' : 'Inactive'}`);
        lines.push(`   Path: \`${status.stateFilePath}\``);

        // Show active sessions if no specific session_id
        if (!sessionId && !isRetiredWorkflowMode(status.mode) && MODE_CONFIGS[status.mode]) {
          const activeSessions = getActiveSessionsForMode(status.mode, root);
          if (activeSessions.length > 0) {
            lines.push(`   Active sessions: ${activeSessions.join(', ')}`);
          }
        }
      }

      // Also check extra state-only modes (not in MODE_CONFIGS)
      for (const mode of EXTRA_STATE_ONLY_MODES) {
        const statePath = sessionId
          ? resolveSessionStatePath(mode, sessionId, root)
          : getStatePath(mode, root);
        let active = false;
        if (existsSync(statePath)) {
          try {
            const content = readFileSync(statePath, 'utf-8');
            const state = JSON.parse(content);
            active = state.active === true && (!sessionId || canClearStateForSession(state, sessionId));
          } catch {
            // Ignore parse errors
          }
        }
        const icon = active ? '[ACTIVE]' : '[INACTIVE]';
        lines.push(`${icon} **${mode}**: ${active ? 'Active' : 'Inactive'}`);
        lines.push(`   Path: \`${statePath}\``);
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};


/**
 * All state tools for registration
 */
export const stateTools = [
  stateReadTool,
  stateWriteTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
];
