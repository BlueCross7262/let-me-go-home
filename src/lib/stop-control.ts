import { existsSync, readFileSync } from 'fs';
import {
  clearModeStateFile,
  resolveStateRoot,
  writeStateFileLockedCreateIf,
  writeStateFileLockedIf,
} from './mode-state-io.js';
import { ensureSessionStateDir, resolveSessionStatePath } from './worktree-paths.js';

type Rec = Record<string, unknown>;

export const STOP_LAYERS = ['first', 'second', 'third'] as const;
export type StopLayer = (typeof STOP_LAYERS)[number];

export const STOP_LAYER_MODES = ['first-stop', 'second-stop', 'third-stop'] as const;
export type StopLayerMode = (typeof STOP_LAYER_MODES)[number];

export type StopProfileName = 'ralph' | 'phase-chain' | 'generic';

export interface StopProfile {
  owner?: string;
  on_cap: 'extend' | 'disable';
  cap_step?: number;
  hard_max_applies: boolean;
  tool_error_guidance: boolean;
  token_fields: string[];
  messages: Record<string, string | string[]>;
}

export const STOP_PROFILES: Record<StopProfileName, StopProfile> = {
  ralph: {
    owner: 'ralph',
    on_cap: 'extend',
    cap_step: 10,
    hard_max_applies: true,
    tool_error_guidance: true,
    token_fields: [],
    messages: {
      continue:
        '[RALPH LOOP - ITERATION {next}/{max}] Work is NOT done. Continue working. After reviewer verification: /let-me-go-home:cancel',
      continue_literal: [],
      extended:
        '[RALPH LOOP - EXTENDED] Max iterations reached; extending to {max} and continuing. When FULLY complete (after reviewer verification), run /let-me-go-home:cancel (or --force).',
      hard_limit:
        '[RALPH LOOP - HARD LIMIT] Reached hard max iterations ({hard_max}). Mode auto-disabled. Restart with /let-me-go-home:ralph if needed.',
      wait_tag: '[RALPH LOOP - WAITING]',
    },
  },
  'phase-chain': {
    owner: 'phase-chain',
    on_cap: 'disable',
    hard_max_applies: false,
    tool_error_guidance: false,
    token_fields: ['chain_state_path', 'skill_path', 'executor_skill_path', 'phase_id'],
    messages: {
      continue:
        '[PHASE-CHAIN] A phase chain is in progress. Read {chain_state_path} and follow the re-entry rule in {skill_path}.\nThe executor skill is at {executor_skill_path}.\nTo stop the chain, run /let-me-go-home:cancel --chain.',
      hard_limit:
        '[PHASE-CHAIN - HARD LIMIT] Chain disabled after {max} blocked stops in phase {phase_id}.\nMark the running phase in {chain_state_path} as stopped with reason chain-hard-limit, then follow the 보고 step of {skill_path}.',
      wait_tag: '[PHASE-CHAIN - WAITING]',
    },
  },
  generic: {
    on_cap: 'disable',
    hard_max_applies: false,
    tool_error_guidance: false,
    token_fields: [],
    messages: {
      continue:
        '[STOP-LAYER {layer}:{owner} - ITERATION {next}/{max}] Work is NOT done. Continue the owning task. To stop it, run /let-me-go-home:cancel --layer {layer}',
      extended: '[STOP-LAYER {layer}:{owner} - EXTENDED] Max iterations reached; extending to {max} and continuing.',
      hard_limit: '[STOP-LAYER {layer}:{owner} - HARD LIMIT] Disabled after {max} blocked stops.',
      wait_tag: '[STOP-LAYER {layer}:{owner} - WAITING]',
    },
  },
};

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const OWNER_PATTERN = /^[a-z0-9-]+$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_MESSAGE_CHARS = 4000;
const MAX_LITERAL_LINES = 20;
const MAX_LITERAL_LINE_CHARS = 2000;
const MAX_TOKEN_FIELDS = 16;
const MAX_TOKEN_VALUE_CHARS = 2000;
const CHAIN_DEFAULT_MAX = 100;
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const BACKGROUND_WAIT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const RESERVED_KEYS = new Set([
  'owner',
  'profile',
  'active',
  'session_id',
  'project_path',
  'started_at',
  'last_checked_at',
  'iteration',
  'max_iterations',
  'on_cap',
  'cap_step',
  'hard_max_applies',
  'tool_error_guidance',
  'token_fields',
  'messages',
  '_meta',
]);

export interface StopControlInput {
  owner?: string;
  profile?: string;
  active?: unknown;
  iteration?: unknown;
  max_iterations?: unknown;
  [key: string]: unknown;
}

export interface StopControlContext {
  sessionId: string;
  directory?: string;
  legacyAlias?: boolean;
}

export type BuildResult = { ok: true; record: Rec } | { ok: false; error: string };
export type WriteResult = { ok: true; record: Rec; path: string } | { ok: false; error: string };
export type UpdateStatus = 'written' | 'skipped' | 'failed' | 'invalid';

export function stopLayerMode(layer: StopLayer): StopLayerMode {
  return `${layer}-stop` as StopLayerMode;
}

export function stopLayerFileName(layer: StopLayer): string {
  return `${layer}-stop-state.json`;
}

export function layerFromMode(mode: string): StopLayer | null {
  const index = (STOP_LAYER_MODES as readonly string[]).indexOf(mode);
  return index === -1 ? null : STOP_LAYERS[index];
}

export function normalizeLegacyMode(mode: string): {
  mode: string;
  legacyAlias: boolean;
  owner?: string;
  profile?: StopProfileName;
} {
  if (mode === 'phase-chain') {
    return { mode: 'third-stop', legacyAlias: true, owner: 'phase-chain', profile: 'phase-chain' };
  }
  return { mode, legacyAlias: false };
}

function isPlainObject(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function invalid(reason: string): { valid: false; reason: string } {
  return { valid: false, reason };
}

function validateMessages(rec: Rec): { valid: true } | { valid: false; reason: string } {
  const messages = rec.messages;
  if (!isPlainObject(messages)) return invalid('messages');
  const required = ['continue', 'hard_limit', 'wait_tag'];
  if (rec.on_cap === 'extend') required.push('extended');
  for (const key of required) {
    if (typeof messages[key] !== 'string') return invalid(`messages.${key}`);
  }
  for (const [key, value] of Object.entries(messages)) {
    if (key.endsWith('_literal')) {
      if (!Array.isArray(value) || value.length > MAX_LITERAL_LINES) return invalid(`messages.${key}`);
      for (const line of value) {
        if (typeof line !== 'string' || line.length > MAX_LITERAL_LINE_CHARS) return invalid(`messages.${key}`);
      }
    } else if (typeof value === 'string' && value.length > MAX_MESSAGE_CHARS) {
      return invalid(`messages.${key}`);
    }
  }
  return { valid: true };
}

function validateTokenFields(rec: Rec): { valid: true } | { valid: false; reason: string } {
  const fields = rec.token_fields;
  if (fields === undefined) return { valid: true };
  if (!Array.isArray(fields) || fields.length > MAX_TOKEN_FIELDS) return invalid('token_fields');
  for (const name of fields) {
    if (typeof name !== 'string') return invalid('token_fields');
    const value = rec[name];
    if (value === undefined) continue;
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof text !== 'string' || text.length > MAX_TOKEN_VALUE_CHARS) return invalid(`token_fields.${name}`);
  }
  return { valid: true };
}

export function validateStopRecord(rec: unknown): { valid: true } | { valid: false; reason: string } {
  if (!isPlainObject(rec)) return invalid('record');
  if (typeof rec.owner !== 'string' || !OWNER_PATTERN.test(rec.owner)) return invalid('owner');
  if (typeof rec.active !== 'boolean') return invalid('active');
  if (typeof rec.session_id !== 'string' || rec.session_id === '') return invalid('session_id');
  if (typeof rec.project_path !== 'string' || rec.project_path === '') return invalid('project_path');
  if (!isIsoTime(rec.started_at)) return invalid('started_at');
  if (!isIsoTime(rec.last_checked_at)) return invalid('last_checked_at');
  if (!Number.isInteger(rec.iteration) || (rec.iteration as number) < 0) return invalid('iteration');
  if (!Number.isInteger(rec.max_iterations) || (rec.max_iterations as number) < 1) return invalid('max_iterations');
  if (rec.on_cap !== undefined && rec.on_cap !== 'extend' && rec.on_cap !== 'disable') return invalid('on_cap');
  if (rec.cap_step !== undefined && (!Number.isInteger(rec.cap_step) || (rec.cap_step as number) < 1)) {
    return invalid('cap_step');
  }
  for (const key of ['hard_max_applies', 'tool_error_guidance']) {
    if (rec[key] !== undefined && typeof rec[key] !== 'boolean') return invalid(key);
  }
  const tokens = validateTokenFields(rec);
  if (!tokens.valid) return tokens;
  return validateMessages(rec);
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function capOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : CHAIN_DEFAULT_MAX;
}

function aliasTime(value: unknown, fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function buildStopControlRecord(
  layer: StopLayer,
  input: StopControlInput,
  ctx: StopControlContext,
  nowIso: string,
): BuildResult {
  if (!STOP_LAYERS.includes(layer)) return fail(`unknown layer: ${String(layer)}`);
  if (typeof ctx.sessionId !== 'string' || !SESSION_ID_PATTERN.test(ctx.sessionId)) return fail('invalid session id');
  if (input.session_id !== undefined && input.session_id !== ctx.sessionId) {
    return fail('session_id does not match the session');
  }
  const profileName = input.profile ?? (ctx.legacyAlias ? 'phase-chain' : 'generic');
  const profile = Object.prototype.hasOwnProperty.call(STOP_PROFILES, profileName)
    ? STOP_PROFILES[profileName as StopProfileName]
    : undefined;
  if (!profile) return fail(`unknown profile: ${profileName}`);
  const owner = input.owner ?? profile.owner;
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) {
    return fail('owner is required and must match [a-z0-9-]+');
  }
  if (typeof input.active !== 'boolean') return fail('active must be a boolean');
  const projectPath = input.project_path ?? ctx.directory;
  if (typeof projectPath !== 'string' || projectPath === '') return fail('project_path is required');
  if (input.messages !== undefined && !isPlainObject(input.messages)) return fail('messages must be an object');

  let startedAt: string | null;
  let lastCheckedAt: string | null;
  let iteration: number;
  let maxIterations: number;
  if (ctx.legacyAlias) {
    startedAt = aliasTime(input.started_at, nowIso);
    lastCheckedAt = aliasTime(input.last_checked_at, nowIso);
    iteration = safeCount(input.iteration);
    maxIterations = Math.max(1, capOf(input.max_iterations));
  } else {
    startedAt = input.started_at === undefined ? nowIso : isIsoTime(input.started_at) ? input.started_at : null;
    lastCheckedAt =
      input.last_checked_at === undefined ? nowIso : isIsoTime(input.last_checked_at) ? input.last_checked_at : null;
    if (input.iteration === undefined) return fail('iteration is required');
    if (input.max_iterations === undefined) return fail('max_iterations is required');
    iteration = input.iteration as number;
    maxIterations = input.max_iterations as number;
  }
  if (startedAt === null) return fail('started_at must be a readable ISO 8601 time');
  if (lastCheckedAt === null) return fail('last_checked_at must be a readable ISO 8601 time');

  const extras = Object.fromEntries(Object.entries(input).filter(([key]) => !RESERVED_KEYS.has(key)));
  const capStep = input.cap_step ?? profile.cap_step;
  const record: Rec = {
    owner,
    active: input.active,
    session_id: ctx.sessionId,
    project_path: projectPath,
    started_at: startedAt,
    last_checked_at: lastCheckedAt,
    iteration,
    max_iterations: maxIterations,
    on_cap: input.on_cap ?? profile.on_cap,
    ...(capStep !== undefined ? { cap_step: capStep } : {}),
    hard_max_applies: input.hard_max_applies ?? profile.hard_max_applies,
    tool_error_guidance: input.tool_error_guidance ?? profile.tool_error_guidance,
    token_fields: input.token_fields ?? structuredClone(profile.token_fields),
    messages: { ...structuredClone(profile.messages), ...((input.messages as Rec | undefined) ?? {}) },
    ...extras,
    _meta: { mode: stopLayerMode(layer), sessionId: ctx.sessionId, updatedAt: nowIso, written_at: nowIso },
  };
  const verdict = validateStopRecord(record);
  if (!verdict.valid) return fail(`invalid stop control record: ${verdict.reason}`);
  return { ok: true, record };
}

function layerPath(layer: StopLayer, sessionId: string, directory?: string): string {
  const baseDir = resolveStateRoot(directory);
  return resolveSessionStatePath(stopLayerMode(layer), sessionId, baseDir);
}

export function readStopControl(layer: StopLayer, sessionId: string, directory?: string): Rec | null {
  try {
    const path = layerPath(layer, sessionId, directory);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStaleRecord(rec: Rec): boolean {
  const stamps = [rec.last_checked_at, rec.updated_at, rec.started_at].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const latest = stamps.reduce((max, value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, 0);
  if (latest === 0) return true;
  const waiting = typeof rec.background_wait_at === 'string' && Number.isFinite(Date.parse(rec.background_wait_at));
  return Date.now() - latest > (waiting ? BACKGROUND_WAIT_STALE_THRESHOLD_MS : STALE_THRESHOLD_MS);
}

function canReplace(current: Rec | null, owner: string): boolean {
  if (current === null) return true;
  if (!current.active) return true;
  if (current.owner === owner) return true;
  return isStaleRecord(current);
}

function freeLayers(exclude: StopLayer, owner: string, sessionId: string, directory?: string): StopLayer[] {
  return STOP_LAYERS.filter(
    (layer) => layer !== exclude && canReplace(readStopControl(layer, sessionId, directory), owner),
  );
}

export function writeStopControl(layer: StopLayer, input: StopControlInput, ctx: StopControlContext): WriteResult {
  const built = buildStopControlRecord(layer, input, ctx, new Date().toISOString());
  if (!built.ok) return built;
  const owner = built.record.owner as string;
  try {
    const baseDir = resolveStateRoot(ctx.directory);
    ensureSessionStateDir(ctx.sessionId, baseDir);
    const path = resolveSessionStatePath(stopLayerMode(layer), ctx.sessionId, baseDir);
    const result = writeStateFileLockedCreateIf(
      path,
      (current) => canReplace(current, owner),
      () => built.record,
    );
    if (result === 'written') return { ok: true, record: built.record, path };
    if (result === 'skipped') {
      const holder = readStopControl(layer, ctx.sessionId, ctx.directory)?.owner;
      const free = freeLayers(layer, owner, ctx.sessionId, ctx.directory).join(', ') || 'none';
      return fail(`layer occupied by ${String(holder)}; free layers: ${free}`);
    }
    return fail('failed to write the stop control record');
  } catch (error) {
    return fail(`failed to write the stop control record: ${(error as Error).message}`);
  }
}

export function findOwnerLayers(owner: string, sessionId: string, directory?: string): StopLayer[] {
  return STOP_LAYERS.filter((layer) => readStopControl(layer, sessionId, directory)?.owner === owner);
}

function updateLayer(
  layer: StopLayer,
  owner: string,
  sessionId: string,
  directory: string | undefined,
  mutate: (rec: Rec) => Rec,
): UpdateStatus {
  let rejected = false;
  try {
    const path = layerPath(layer, sessionId, directory);
    const result = writeStateFileLockedIf(
      path,
      (current) => {
        if (current.owner !== owner) return false;
        const verdict = validateStopRecord(mutate(structuredClone(current)));
        if (!verdict.valid) {
          rejected = true;
          return false;
        }
        return true;
      },
      (current) => mutate(structuredClone(current)),
    );
    if (rejected) return 'invalid';
    return result;
  } catch {
    return 'failed';
  }
}

function updateByOwner(
  owner: string,
  sessionId: string,
  directory: string | undefined,
  mutate: (rec: Rec) => Rec,
): UpdateStatus {
  const statuses = findOwnerLayers(owner, sessionId, directory).map((layer) =>
    updateLayer(layer, owner, sessionId, directory, mutate),
  );
  for (const status of ['invalid', 'failed', 'written'] as const) {
    if (statuses.includes(status)) return status;
  }
  return 'skipped';
}

function touch(rec: Rec): Rec {
  const now = new Date().toISOString();
  return { ...rec, _meta: { ...(isPlainObject(rec._meta) ? rec._meta : {}), updatedAt: now, written_at: now } };
}

export function regenerateContinueLiteral(
  owner: string,
  sessionId: string,
  directory: string | undefined,
  lines: string[],
): UpdateStatus {
  return updateByOwner(owner, sessionId, directory, (rec) =>
    touch({
      ...rec,
      messages: { ...(isPlainObject(rec.messages) ? rec.messages : {}), continue_literal: lines },
    }),
  );
}

export function deactivateStopControlByOwner(owner: string, sessionId: string, directory?: string): UpdateStatus {
  return updateByOwner(owner, sessionId, directory, (rec) => touch({ ...rec, active: false }));
}

export function clearStopControlByOwner(
  owner: string,
  sessionId: string,
  directory?: string,
): { ok: boolean; cleared: number } {
  let ok = true;
  let cleared = 0;
  for (const layer of findOwnerLayers(owner, sessionId, directory)) {
    if (clearModeStateFile(stopLayerMode(layer), directory, sessionId)) {
      cleared += 1;
    } else {
      ok = false;
    }
  }
  return { ok, cleared };
}

const TASK_LINE_LIMIT = 1500;
const RALPH_PROMPT_FLAGS = ['--refine-check', '--no-deslop'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectPromptFlags(prompt: string): string[] {
  const flags = RALPH_PROMPT_FLAGS.filter((flag) =>
    new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?=\\s|$)`).test(prompt),
  );
  const critic = prompt.match(/(?:^|\s)(--critic=\S+)(?=\s|$)/);
  if (critic) flags.push(critic[1]);
  return flags;
}

function fullTextPointer(promptFile: unknown, statePath: unknown): string | null {
  if (typeof promptFile === 'string' && promptFile !== '') return `Full task text: ${promptFile}`;
  if (typeof statePath === 'string' && statePath !== '') return `Full task text: the prompt field of ${statePath}`;
  return null;
}

function formatRalphTaskLines(prompt: unknown, promptFile: unknown, statePath: unknown): string[] {
  if (typeof prompt !== 'string' || prompt.trim() === '') return [];
  const hasPromptFile = typeof promptFile === 'string' && promptFile !== '';
  const chars = Array.from(prompt);
  if (chars.length <= TASK_LINE_LIMIT) {
    return hasPromptFile ? [`Task: ${prompt}`, `Full task text: ${promptFile as string}`] : [`Task: ${prompt}`];
  }
  const lines = [`Task (first ${TASK_LINE_LIMIT} of ${chars.length} chars): ${chars.slice(0, TASK_LINE_LIMIT).join('')} …`];
  const flags = collectPromptFlags(prompt);
  if (flags.length > 0) lines.push(`Task flags: ${flags.join(' ')}`);
  const pointer = fullTextPointer(promptFile, statePath);
  if (pointer !== null) lines.push(pointer);
  return lines;
}

export function formatRalphTaskPointerLines(prompt: unknown, promptFile?: unknown, statePath?: unknown): string[] {
  if (typeof prompt !== 'string' || prompt.trim() === '') return [];
  const pointer = fullTextPointer(promptFile, statePath);
  if (pointer === null) return formatRalphTaskLines(prompt, promptFile, statePath);
  return [pointer];
}
