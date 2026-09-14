/**
 * Coverage for the mode-state API that Ralph and the state tools call.
 *
 * writeModeState / writeModeStateIfAbsent / readModeState / clearModeStateFile
 * are what dist/hooks/ralph/loop.js and state-tools reach for, and
 * clearModeStateFile alone held the largest block of uncovered statements in
 * this module. The conditional clear is the interesting half: it must refuse to
 * delete state that changed under it, and refuse to delete another session's.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import {
  clearModeStateFile,
  getStateSessionOwner,
  readModeState,
  writeModeState,
  writeModeStateIfAbsent,
} from '../mode-state-io.js';
import { resolveSessionStatePath } from '../worktree-paths.js';

const directories: string[] = [];
const previousStateDir = process.env.LMGH_STATE_DIR;

/**
 * Each fixture pins its own LMGH_STATE_DIR. Without it getLmghRoot declines to
 * anchor state in a scratch directory and falls back to the real ~/.lmgh, so
 * the tests would share one root and clear each other's files.
 */
function freshProject(label: string): string {
  const directory = mkdtempSync(join(homedir(), `mode-state-${label}-`));
  directories.push(directory);
  process.env.LMGH_STATE_DIR = join(directory, 'state-root');
  return directory;
}

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LMGH_STATE_DIR;
  else process.env.LMGH_STATE_DIR = previousStateDir;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('mode state round trip', () => {
  it('writes and reads back session-scoped state', () => {
    const directory = freshProject('roundtrip');

    expect(writeModeState('ralph', { active: true, iteration: 2 }, directory, 'session-a')).toBe(true);

    const read = readModeState<Record<string, unknown>>('ralph', directory, 'session-a');
    expect(read).not.toBeNull();
    expect(read!.active).toBe(true);
    expect(read!.iteration).toBe(2);
  });

  it('returns the caller\'s own fields without the ownership metadata', () => {
    const directory = freshProject('owner');
    writeModeState('ralph', { active: true }, directory, 'session-a');

    // The owner is stamped on the file, not handed back through readModeState —
    // see the "session ownership" block below, which reads the file directly.
    const read = readModeState<Record<string, unknown>>('ralph', directory, 'session-a')!;
    expect(read.active).toBe(true);
    expect(getStateSessionOwner(read)).toBeFalsy();
  });

  it('keeps one session out of another', () => {
    const directory = freshProject('isolation');
    writeModeState('ralph', { active: true, marker: 'a' }, directory, 'session-a');
    writeModeState('ralph', { active: true, marker: 'b' }, directory, 'session-b');

    expect(readModeState<Record<string, unknown>>('ralph', directory, 'session-a')!.marker).toBe('a');
    expect(readModeState<Record<string, unknown>>('ralph', directory, 'session-b')!.marker).toBe('b');
  });

  it('reports no state for a session that never wrote any', () => {
    const directory = freshProject('absent');
    expect(readModeState('ralph', directory, 'session-a')).toBeNull();
  });

  it('returns null rather than throwing on unreadable state', () => {
    const directory = freshProject('corrupt');
    writeModeState('ralph', { active: true }, directory, 'session-a');
    writeFileSync(resolveSessionStatePath('ralph', 'session-a', directory), 'not json', 'utf8');

    expect(readModeState('ralph', directory, 'session-a')).toBeNull();
  });
});

describe('write-if-absent', () => {
  it('creates state when the session has none', () => {
    const directory = freshProject('absent-create');

    expect(writeModeStateIfAbsent('ralph', { active: true, origin: 'first' }, directory, 'session-a')).toBe(true);
    expect(readModeState<Record<string, unknown>>('ralph', directory, 'session-a')!.origin).toBe('first');
  });

  it('leaves existing state untouched', () => {
    const directory = freshProject('absent-keep');
    writeModeState('ralph', { active: true, origin: 'first' }, directory, 'session-a');

    writeModeStateIfAbsent('ralph', { active: true, origin: 'second' }, directory, 'session-a');

    expect(readModeState<Record<string, unknown>>('ralph', directory, 'session-a')!.origin).toBe('first');
  });
});

describe('clearing mode state', () => {
  it('removes the session state file unconditionally', () => {
    const directory = freshProject('clear-plain');
    writeModeState('ralph', { active: true }, directory, 'session-a');
    const statePath = resolveSessionStatePath('ralph', 'session-a', directory);

    expect(clearModeStateFile('ralph', directory, 'session-a')).toBe(true);
    expect(existsSync(statePath)).toBe(false);
    expect(readModeState('ralph', directory, 'session-a')).toBeNull();
  });

  it('clears when the state still matches what the caller observed', () => {
    const directory = freshProject('clear-expected');
    writeModeState('ralph', { active: true, iteration: 1 }, directory, 'session-a');
    const observed = readModeState<Record<string, unknown>>('ralph', directory, 'session-a')!;

    expect(clearModeStateFile('ralph', directory, 'session-a', observed)).toBe(true);
    expect(readModeState('ralph', directory, 'session-a')).toBeNull();
  });

  it('refuses to clear state that changed after the caller read it', () => {
    const directory = freshProject('clear-stale');
    writeModeState('ralph', { active: true, iteration: 1 }, directory, 'session-a');
    const observed = readModeState<Record<string, unknown>>('ralph', directory, 'session-a')!;

    // Another turn advanced the loop between the read and the clear.
    writeModeState('ralph', { active: true, iteration: 2 }, directory, 'session-a');

    expect(clearModeStateFile('ralph', directory, 'session-a', observed)).toBe(false);
    const survivor = readModeState<Record<string, unknown>>('ralph', directory, 'session-a');
    expect(survivor).not.toBeNull();
    expect(survivor!.iteration).toBe(2);
  });

  it('refuses to clear another session\'s state', () => {
    const directory = freshProject('clear-foreign');
    writeModeState('ralph', { active: true }, directory, 'session-a');
    const foreign = readModeState<Record<string, unknown>>('ralph', directory, 'session-a')!;

    // session-b asks to clear, presenting session-a's state as what it saw.
    expect(clearModeStateFile('ralph', directory, 'session-b', foreign)).toBe(false);
    expect(readModeState('ralph', directory, 'session-a')).not.toBeNull();
  });

  it('reports success when there is nothing to clear', () => {
    const directory = freshProject('clear-empty');
    expect(clearModeStateFile('ralph', directory, 'session-a')).toBe(true);
  });

  it('leaves a sibling session untouched', () => {
    const directory = freshProject('clear-sibling');
    writeModeState('ralph', { active: true }, directory, 'session-a');
    writeModeState('ralph', { active: true }, directory, 'session-b');

    clearModeStateFile('ralph', directory, 'session-a');

    expect(readModeState('ralph', directory, 'session-a')).toBeNull();
    expect(readModeState('ralph', directory, 'session-b')).not.toBeNull();
  });

  it('clears legacy state when no session is named', () => {
    const directory = freshProject('clear-legacy');
    writeModeState('ralph', { active: true }, directory);
    expect(readModeState('ralph', directory)).not.toBeNull();

    expect(clearModeStateFile('ralph', directory)).toBe(true);
    expect(readModeState('ralph', directory)).toBeNull();
  });
});

describe('session ownership', () => {
  it('reads the owner a write stamped', () => {
    const directory = freshProject('owner-read');
    writeModeState('ralph', { active: true }, directory, 'session-a');

    const raw = JSON.parse(
      readFileSync(resolveSessionStatePath('ralph', 'session-a', directory), 'utf8'),
    ) as Record<string, unknown>;
    expect(getStateSessionOwner(raw)).toBe('session-a');
  });

  it('reports no owner for state that carries none', () => {
    expect(getStateSessionOwner({ active: true })).toBeFalsy();
  });

  it('reports no owner for a non-object', () => {
    expect(getStateSessionOwner(null as unknown as Record<string, unknown>)).toBeFalsy();
    expect(getStateSessionOwner('not state' as unknown as Record<string, unknown>)).toBeFalsy();
  });
});

describe('state directories', () => {
  it('creates the session directory tree on first write', () => {
    const directory = freshProject('mkdir');
    const statePath = resolveSessionStatePath('ralph', 'session-new', directory);
    expect(existsSync(statePath)).toBe(false);

    writeModeState('ralph', { active: true }, directory, 'session-new');

    expect(existsSync(statePath)).toBe(true);
  });

  it('writes into a session directory that already exists', () => {
    const directory = freshProject('mkdir-existing');
    const statePath = resolveSessionStatePath('ralph', 'session-pre', directory);
    mkdirSync(join(statePath, '..'), { recursive: true });

    expect(writeModeState('ralph', { active: true }, directory, 'session-pre')).toBe(true);
    expect(existsSync(statePath)).toBe(true);
  });
});
