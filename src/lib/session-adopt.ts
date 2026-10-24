import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs';
import { dirname, join, normalize, resolve } from 'path';
import { findProgressPath } from '../hooks/ralph/progress.js';
import { clearStateFileLocked, resolveStateRoot, writeModeState, writeStateFileLockedIf } from './mode-state-io.js';
import {
  findOwnerLayers,
  formatRalphTaskPointerLines,
  pickInnerFreeLayer,
  readStopControl,
  stopLayerMode,
  stopLayerStatuses,
  writeStopControl,
  type StopControlInput,
  type StopLayer,
} from './stop-control.js';
import { getSessionStateDir, listSessionIds, resolveSessionStatePath, validateSessionId } from './worktree-paths.js';

type Rec = Record<string, unknown>;

export const FRESH_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const OWNER = 'ralph';
const RALPH_STATE_FILE = 'ralph-state.json';
const PRD_FILE = 'prd.json';
const PROMPT_FILE = 'ralph-prompt.md';
const LEDGER_FILE = 'skill-active-state.json';

export interface AdoptCandidate {
  session_id: string;
  active: boolean;
  iteration: unknown;
  max_iterations: unknown;
  project_path: unknown;
  last_activity: string | null;
  fresh: boolean;
  holds: boolean | null;
  has_prd: boolean;
}

export type AdoptResult =
  | {
      ok: true;
      from: string;
      to: string;
      layer: StopLayer;
      written: string[];
      removed: string[];
      leftover: string[];
      progress_file: string | null;
      progress_lines: string[];
      cleared_tombstones: string[];
    }
  | { ok: false; error: string };

export interface AdoptOptions {
  from: string;
  to: string;
  projectDir: string;
  force?: boolean;
  nowMs?: number;
}

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonRecord(path: string): Rec | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeProjectPath(path: unknown): string {
  if (typeof path !== 'string' || path === '') return '';
  let normalized = normalize(resolve(path)).replace(/[\/\\]+$/, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function normalizeForContainment(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function latestStamp(values: unknown[]): number {
  let latest = 0;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return latest;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function lastActivityMs(state: Rec | null, control: Rec | null, paths: string[]): number {
  const meta = (record: Rec | null) => (record && isRecord(record._meta) ? record._meta : {});
  const stamps = latestStamp([
    state?.last_checked_at,
    state?.started_at,
    meta(state).updatedAt,
    meta(state).written_at,
    control?.last_checked_at,
    control?.started_at,
    meta(control).updatedAt,
    meta(control).written_at,
  ]);
  return Math.max(stamps, ...paths.map(mtimeOf));
}

function sessionPaths(sessionId: string, root: string) {
  const dir = getSessionStateDir(sessionId, root);
  return {
    dir,
    ralphState: join(dir, RALPH_STATE_FILE),
    prd: join(dir, PRD_FILE),
    prompt: join(dir, PROMPT_FILE),
    ledger: join(dir, LEDGER_FILE),
  };
}

function controlPath(layer: StopLayer, sessionId: string, root: string): string {
  return resolveSessionStatePath(stopLayerMode(layer), sessionId, root);
}

export function listAdoptable(projectDir: string, nowMs: number = Date.now()): AdoptCandidate[] {
  const root = resolveStateRoot(projectDir);
  const candidates: AdoptCandidate[] = [];
  for (const sessionId of listSessionIds(root)) {
    const paths = sessionPaths(sessionId, root);
    const state = readJsonRecord(paths.ralphState);
    if (state === null) continue;
    const layer = findOwnerLayers(OWNER, sessionId, projectDir)[0];
    const control = layer === undefined ? null : readStopControl(layer, sessionId, projectDir);
    const activity = lastActivityMs(
      state,
      control,
      layer === undefined ? [paths.ralphState] : [paths.ralphState, controlPath(layer, sessionId, root)],
    );
    const status = stopLayerStatuses(sessionId, projectDir).find((entry) => entry.layer === layer);
    const holds =
      control !== null &&
      status !== undefined &&
      control.owner === OWNER &&
      status.active === true &&
      status.stale === false &&
      normalizeProjectPath(control.project_path) === normalizeProjectPath(projectDir);
    candidates.push({
      session_id: sessionId,
      active: state.active === true,
      iteration: state.iteration,
      max_iterations: state.max_iterations,
      project_path: state.project_path,
      last_activity: activity > 0 ? new Date(activity).toISOString() : null,
      fresh: activity > 0 && nowMs - activity < FRESH_THRESHOLD_MS,
      holds,
      has_prd: existsSync(paths.prd),
    });
  }
  return candidates;
}

function refuse(error: string): AdoptResult {
  return { ok: false, error };
}

function remapPromptFile(promptFile: unknown, fromDir: string, toDir: string): { value: unknown; relative: string | null } {
  if (typeof promptFile !== 'string' || promptFile === '') return { value: promptFile, relative: null };
  const sourceRoot = normalizeForContainment(fromDir);
  const candidate = normalizeForContainment(promptFile);
  if (!candidate.startsWith(`${sourceRoot}/`)) return { value: promptFile, relative: null };
  const relative = promptFile.replace(/\\/g, '/').slice(fromDir.replace(/\\/g, '/').replace(/\/+$/, '').length + 1);
  return { value: join(toDir, ...relative.split('/')), relative };
}

function copyAtomic(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.adopt-${process.pid}`;
  copyFileSync(source, temp);
  renameSync(temp, target);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function progressMarkerLines(content: string, from: string, to: string): string[] {
  const token = `session=${from}`;
  const lines = content.split(/\r?\n/);
  const refine = new RegExp(`^refine-check: pass ${escapeRegExp(token)}\\s*$`);
  const execute = new RegExp(`^execute-type: .* ${escapeRegExp(token)}(?: fallback=\\S+)?\\s*$`);
  const copies: string[] = [];
  const lastRefine = [...lines].reverse().find((line) => refine.test(line));
  const lastExecute = [...lines].reverse().find((line) => execute.test(line));
  for (const line of [lastExecute, lastRefine]) {
    if (line !== undefined) copies.push(line.trimEnd().replace(token, `session=${to}`));
  }
  return copies;
}

function clearTombstones(ledgerPath: string, layer: StopLayer): { ok: boolean; cleared: string[] } {
  if (!existsSync(ledgerPath)) return { ok: true, cleared: [] };
  const slots = [OWNER, stopLayerMode(layer)];
  const present = (current: Rec) => {
    const skills = current.active_skills;
    return isRecord(skills) ? slots.filter((slot) => slot in skills) : [];
  };
  const before = readJsonRecord(ledgerPath);
  if (before === null) return { ok: false, cleared: [] };
  const cleared = present(before);
  if (cleared.length === 0) return { ok: true, cleared: [] };
  const result = writeStateFileLockedIf(
    ledgerPath,
    (current) => present(current).length > 0,
    (current) => {
      const skills = { ...(current.active_skills as Rec) };
      for (const slot of slots) delete skills[slot];
      return { ...current, active_skills: skills };
    },
  );
  return { ok: result === 'written' || result === 'skipped', cleared };
}

export function adoptSession(options: AdoptOptions): AdoptResult {
  const { from, to, projectDir } = options;
  const nowMs = options.nowMs ?? Date.now();
  try {
    validateSessionId(from);
    validateSessionId(to);
  } catch (error) {
    return refuse((error as Error).message);
  }
  if (from === to) return refuse('the source and the destination are the same session');

  let root: string;
  try {
    root = resolveStateRoot(projectDir);
  } catch (error) {
    return refuse(`could not resolve the state root: ${(error as Error).message}`);
  }
  const source = sessionPaths(from, root);
  const dest = sessionPaths(to, root);

  const state = readJsonRecord(source.ralphState);
  if (state === null) return refuse(`session ${from} has no readable ralph-state.json`);
  const sourceLayer = findOwnerLayers(OWNER, from, projectDir)[0];
  const control = sourceLayer === undefined ? null : readStopControl(sourceLayer, from, projectDir);
  if (sourceLayer === undefined || control === null) {
    return refuse(`session ${from} has no ralph control record`);
  }
  const sourceControl = controlPath(sourceLayer, from, root);
  if (state.active !== true || control.active !== true) {
    return refuse(`session ${from} is not an active ralph loop`);
  }

  const cwd = normalizeProjectPath(projectDir);
  if (cwd !== normalizeProjectPath(state.project_path) || cwd !== normalizeProjectPath(control.project_path)) {
    return refuse(
      `the source loop belongs to ${String(state.project_path)}, not to ${projectDir}; the Stop hook compares project_path with the session cwd and would not hold this session`,
    );
  }

  const activity = lastActivityMs(state, control, [source.ralphState, sourceControl]);
  if (activity > 0 && nowMs - activity < FRESH_THRESHOLD_MS && options.force !== true) {
    return refuse(`session ${from} was active within the last two hours; pass --force to take it anyway`);
  }

  const existing = [dest.ralphState, dest.prd, dest.prompt].filter((path) => existsSync(path));
  if (existing.length > 0) {
    return refuse(`session ${to} already has ${existing.join(', ')}; cancel that session's ralph state first`);
  }
  for (const layer of findOwnerLayers(OWNER, to, projectDir)) {
    if (readStopControl(layer, to, projectDir)?.active === true) {
      return refuse(`session ${to} already holds an active ralph control record on the ${layer} layer`);
    }
  }
  const destLayer = pickInnerFreeLayer(OWNER, to, projectDir);
  if (destLayer === null) {
    return refuse(`every layer of session ${to} is held by another owner`);
  }
  const destControl = controlPath(destLayer, to, root);

  const remapped = remapPromptFile(state.prompt_file, source.dir, dest.dir);
  const copies: Array<{ from: string; to: string }> = [];
  if (existsSync(source.prd)) copies.push({ from: source.prd, to: dest.prd });
  if (existsSync(source.prompt)) copies.push({ from: source.prompt, to: dest.prompt });
  if (remapped.relative !== null) {
    const referenced = join(source.dir, ...remapped.relative.split('/'));
    if (referenced !== source.prompt && existsSync(referenced)) {
      copies.push({ from: referenced, to: join(dest.dir, ...remapped.relative.split('/')) });
    }
  }

  const nextState: Rec = { ...state };
  delete nextState._meta;
  delete nextState.owner_pid;
  nextState.session_id = to;
  if (remapped.relative !== null) nextState.prompt_file = remapped.value;

  const nowIso = new Date(nowMs).toISOString();
  const input: StopControlInput = { ...control, profile: OWNER, last_checked_at: nowIso };
  delete input.session_id;
  delete input._meta;
  input.messages = {
    ...(isRecord(control.messages) ? control.messages : {}),
    continue_literal: formatRalphTaskPointerLines(nextState.prompt, nextState.prompt_file, dest.ralphState),
  };

  const written: string[] = [];
  const rollback = (error: string): AdoptResult => {
    for (const path of written.splice(0).reverse()) {
      if (path === destControl) clearStateFileLocked(path);
      else rmSync(path, { force: true });
    }
    return refuse(error);
  };

  try {
    for (const copy of copies) {
      copyAtomic(copy.from, copy.to);
      written.push(copy.to);
    }
    if (!writeModeState('ralph', nextState, projectDir, to)) return rollback(`could not write ${dest.ralphState}`);
    written.push(dest.ralphState);
    const control_result = writeStopControl(destLayer, input, { sessionId: to, directory: projectDir });
    if (!control_result.ok) return rollback(control_result.error);
    written.push(destControl);
  } catch (error) {
    return rollback(`could not write the destination files: ${(error as Error).message}`);
  }

  const progressFile = findProgressPath(root);
  let progressLines: string[] = [];
  if (progressFile !== null) {
    try {
      progressLines = progressMarkerLines(readFileSync(progressFile, 'utf8'), from, to);
      if (progressLines.length > 0) appendFileSync(progressFile, progressLines.map((line) => `\n${line}\n`).join(''));
    } catch (error) {
      return rollback(`could not append to ${progressFile}: ${(error as Error).message}`);
    }
  }

  const tombstones = clearTombstones(dest.ledger, destLayer);
  if (!tombstones.ok) return rollback(`could not clear the tombstones in ${dest.ledger}`);

  const removed: string[] = [];
  const leftover: string[] = [];
  const doomed = [sourceControl, source.ralphState, ...copies.map((copy) => copy.from)];
  for (const path of doomed) {
    if (path === sourceControl) clearStateFileLocked(path);
    else rmSync(path, { force: true });
    (existsSync(path) ? leftover : removed).push(path);
  }

  return {
    ok: true,
    from,
    to,
    layer: destLayer,
    written: [...written],
    removed,
    leftover,
    progress_file: progressFile,
    progress_lines: progressLines,
    cleared_tombstones: tombstones.cleared,
  };
}
