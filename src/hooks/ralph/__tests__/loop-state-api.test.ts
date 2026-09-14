/**
 * Coverage for the Ralph loop state API the Stop hook and skills drive.
 *
 * scripts/ralph-stop.mjs dynamic-imports dist/hooks/ralph/loop.js and advances
 * the loop through these functions, so an iteration that fails to increment or
 * a clear that leaves state behind is a loop that never ends. Ten of this
 * module's functions had no test reaching them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import {
  clearRalphState,
  enablePrdMode,
  hasPrd,
  incrementRalphIteration,
  readRalphState,
  recordPattern,
  recordStoryProgress,
  restoreRalphStateIfAbsent,
  setCurrentStory,
  writeRalphState,
  type RalphLoopState,
} from '../loop.js';

const directories: string[] = [];
const previousStateDir = process.env.LMGH_STATE_DIR;

/** Each fixture pins its own state root; see mode-state-io-public-api.test.ts. */
function freshProject(label: string): string {
  const directory = mkdtempSync(join(homedir(), `ralph-loop-${label}-`));
  directories.push(directory);
  process.env.LMGH_STATE_DIR = join(directory, 'state-root');
  return directory;
}

function activeState(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
  return {
    active: true,
    iteration: 1,
    max_iterations: 10,
    started_at: new Date().toISOString(),
    prompt: 'add a health endpoint',
    ...overrides,
  };
}

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LMGH_STATE_DIR;
  else process.env.LMGH_STATE_DIR = previousStateDir;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('iteration advance', () => {
  it('increments an active loop and persists the new count', () => {
    const directory = freshProject('increment');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');

    const advanced = incrementRalphIteration(directory, 's');

    expect(advanced).not.toBeNull();
    expect(advanced!.iteration).toBe(2);
    expect(readRalphState(directory, 's')!.iteration).toBe(2);
  });

  it('advances repeatedly', () => {
    const directory = freshProject('increment-twice');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');

    incrementRalphIteration(directory, 's');
    const third = incrementRalphIteration(directory, 's');

    expect(third!.iteration).toBe(3);
  });

  it('refuses to advance an inactive loop', () => {
    const directory = freshProject('increment-inactive');
    writeRalphState(directory, activeState({ active: false, session_id: 's' }), 's');

    expect(incrementRalphIteration(directory, 's')).toBeNull();
    expect(readRalphState(directory, 's')!.iteration).toBe(1);
  });

  it('refuses to advance when there is no loop', () => {
    const directory = freshProject('increment-absent');
    expect(incrementRalphIteration(directory, 's')).toBeNull();
  });
});

describe('restore if absent', () => {
  it('writes state for a session that has none', () => {
    const directory = freshProject('restore-absent');
    const state = activeState({ session_id: 's', prompt: 'restored' });

    expect(restoreRalphStateIfAbsent(directory, state, 's')).toBe(true);
    expect(readRalphState(directory, 's')!.prompt).toBe('restored');
  });

  it('leaves a live loop alone', () => {
    const directory = freshProject('restore-present');
    writeRalphState(directory, activeState({ session_id: 's', prompt: 'original' }), 's');

    restoreRalphStateIfAbsent(directory, activeState({ session_id: 's', prompt: 'replacement' }), 's');

    expect(readRalphState(directory, 's')!.prompt).toBe('original');
  });
});

describe('clearing the loop', () => {
  it('removes the state so the Stop hook stops blocking', () => {
    const directory = freshProject('clear');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');

    expect(clearRalphState(directory, 's')).toBe(true);
    expect(readRalphState(directory, 's')).toBeNull();
  });

  it('clears when the state still matches what the caller read', () => {
    const directory = freshProject('clear-expected');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');
    const observed = readRalphState(directory, 's')!;

    expect(clearRalphState(directory, 's', observed)).toBe(true);
    expect(readRalphState(directory, 's')).toBeNull();
  });

  it('refuses to clear a loop that advanced after the caller read it', () => {
    const directory = freshProject('clear-stale');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');
    const observed = readRalphState(directory, 's')!;
    incrementRalphIteration(directory, 's');

    expect(clearRalphState(directory, 's', observed)).toBe(false);
    expect(readRalphState(directory, 's')!.iteration).toBe(2);
  });

  it('reports success when there is nothing to clear', () => {
    const directory = freshProject('clear-empty');
    expect(clearRalphState(directory, 's')).toBe(true);
  });
});

describe('story and PRD bookkeeping', () => {
  it('records the current story on the live loop', () => {
    const directory = freshProject('story');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');

    expect(setCurrentStory(directory, 'US-004', 's')).toBe(true);
    expect(readRalphState(directory, 's')!.current_story_id).toBe('US-004');
  });

  it('refuses to set a story with no loop to set it on', () => {
    const directory = freshProject('story-absent');
    expect(setCurrentStory(directory, 'US-004', 's')).toBe(false);
  });

  it('turns PRD mode on and starts the progress log', () => {
    const directory = freshProject('prd-mode');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');

    expect(enablePrdMode(directory, 's')).toBe(true);
    expect(readRalphState(directory, 's')!.prd_mode).toBe(true);
    expect(existsSync(join(directory, 'state-root', 'non-git', 'progress.txt'))
      || existsSync(join(directory, '.lmgh', 'progress.txt'))).toBe(true);
  });

  it('refuses to enable PRD mode with no loop', () => {
    const directory = freshProject('prd-mode-absent');
    expect(enablePrdMode(directory, 's')).toBe(false);
  });

  it('reports no PRD when none was written', () => {
    const directory = freshProject('has-prd');
    expect(hasPrd(directory, 's')).toBe(false);
  });
});

describe('progress log', () => {
  it('appends a story entry', () => {
    const directory = freshProject('progress');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');
    enablePrdMode(directory, 's');

    expect(recordStoryProgress(
      directory,
      'US-001',
      ['added the route'],
      ['src/server.ts'],
      ['the router needs the handler registered before listen()'],
    )).toBe(true);
  });

  it('appends a discovered pattern', () => {
    const directory = freshProject('pattern');
    writeRalphState(directory, activeState({ session_id: 's' }), 's');
    enablePrdMode(directory, 's');

    expect(recordPattern(directory, 'handlers live under src/routes')).toBe(true);
  });
});

describe('session binding', () => {
  it('keeps two sessions' + "' loops apart", () => {
    const directory = freshProject('sessions');
    writeRalphState(directory, activeState({ session_id: 'a', prompt: 'task A' }), 'a');
    writeRalphState(directory, activeState({ session_id: 'b', prompt: 'task B' }), 'b');

    incrementRalphIteration(directory, 'a');

    expect(readRalphState(directory, 'a')!.iteration).toBe(2);
    expect(readRalphState(directory, 'b')!.iteration).toBe(1);
    expect(readRalphState(directory, 'b')!.prompt).toBe('task B');
  });

  it('clearing one session leaves the other running', () => {
    const directory = freshProject('sessions-clear');
    writeRalphState(directory, activeState({ session_id: 'a' }), 'a');
    writeRalphState(directory, activeState({ session_id: 'b' }), 'b');

    clearRalphState(directory, 'a');

    expect(readRalphState(directory, 'a')).toBeNull();
    expect(readRalphState(directory, 'b')).not.toBeNull();
  });
});
