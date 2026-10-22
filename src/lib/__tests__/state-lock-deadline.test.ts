import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { acquireStateFileLockSync, releaseStateFileLockSync } from '../../../scripts/lib/state-lock.mjs';

const DEAD_OWNER = {
  version: 1,
  pid: 999999,
  processStart: 'ticks:1',
  createdAt: '2020-01-01T00:00:00.000Z',
  nonce: '00000000-0000-4000-8000-000000000000',
};

const directories: string[] = [];
const savedFlock = process.env.LMGH_TEST_FLOCK_AVAILABLE;

function statePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `lmgh-deadline-${label}-`));
  directories.push(directory);
  mkdirSync(join(directory, 'state'), { recursive: true });
  return join(directory, 'state', 'ralph-state.json');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (savedFlock === undefined) delete process.env.LMGH_TEST_FLOCK_AVAILABLE;
  else process.env.LMGH_TEST_FLOCK_AVAILABLE = savedFlock;
});

describe('state lock deadline', () => {
  it('returns null without creating a lock file when the deadline has passed', () => {
    delete process.env.LMGH_TEST_FLOCK_AVAILABLE;
    const target = statePath('past');
    const lock = acquireStateFileLockSync(target, 2, false, false, { deadlineAtMs: Date.now() - 1 });
    expect(lock).toBeNull();
    expect(existsSync(`${target}.mutation.lock`)).toBe(false);
  });

  it('takes the lock as before when no options are given', () => {
    delete process.env.LMGH_TEST_FLOCK_AVAILABLE;
    const target = statePath('plain');
    const lock = acquireStateFileLockSync(target, 2);
    expect(lock).not.toBeNull();
    expect(existsSync(`${target}.mutation.lock`)).toBe(true);
    releaseStateFileLockSync(lock);
    expect(existsSync(`${target}.mutation.lock`)).toBe(false);
  });

  it('reclaims a dead owner lock when the probe budget is below the minimum', () => {
    delete process.env.LMGH_TEST_FLOCK_AVAILABLE;
    const primer = statePath('primer');
    const primed = acquireStateFileLockSync(primer, 2);
    expect(primed).not.toBeNull();
    releaseStateFileLockSync(primed);

    const target = statePath('dead');
    writeFileSync(`${target}.mutation.lock`, JSON.stringify(DEAD_OWNER), 'utf8');
    const lock = acquireStateFileLockSync(target, 2, false, false, { deadlineAtMs: Date.now() + 100 });
    expect(lock).not.toBeNull();
    const owner = JSON.parse(readFileSync(`${target}.mutation.lock`, 'utf8'));
    expect(owner.pid).toBe(process.pid);
    releaseStateFileLockSync(lock);
  });
});
