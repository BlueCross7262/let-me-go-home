/**
 * The mutation lock is file-based and has no native dependency. These tests pin
 * that path, which both the compiled module and the hook runtime take.
 *
 * What the file path guarantees: publication is a `wx` temp plus linkSync, so
 * exactly one publisher wins an empty path. A dead owner's artifact is only
 * ever removed while holding `<lock>.reclaiming`, taken the same way, and the
 * death verdict is re-read under it — a live owner's artifact can never be
 * taken.
 *
 * What it does not guarantee: if a reclaimer dies holding `.reclaiming`, two
 * later reclaimers can both clear that stale marker and one can delete the
 * other's fresh marker, which lets both enter the reclaim section. The window
 * holds no callback and is microseconds wide. Closing it needs the marker
 * deletion and the owner comparison to be one atomic step, which this
 * implementation does not do; it is a known, accepted gap.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withStateFileMutationLock, writeStateFileLocked } from '../mode-state-io.js';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { acquireStateFileLockSync, isStateFileLockingSupported, releaseStateFileLockSync } from '../../../scripts/lib/state-lock.mjs';

type HookLock = { unlocked?: true } | null;

const HOOK_LOCK_MODULE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'lib', 'state-lock.mjs'),
).href;

const DEAD_OWNER = {
  version: 1,
  pid: 999999,
  processStart: 'ticks:1',
  createdAt: '2020-01-01T00:00:00.000Z',
  nonce: '00000000-0000-4000-8000-000000000000',
};

const directories: string[] = [];

function statePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `lmgh-filelock-${label}-`));
  directories.push(directory);
  mkdirSync(join(directory, 'state'), { recursive: true });
  return join(directory, 'state', 'ralph-state.json');
}

function acquireInChild(target: string): string {
  const source = `
import { acquireStateFileLockSync, releaseStateFileLockSync } from ${JSON.stringify(HOOK_LOCK_MODULE)};
const lock = acquireStateFileLockSync(${JSON.stringify(target)}, 3);
if (lock) releaseStateFileLockSync(lock);
console.log(lock ? 'ACQUIRED' : 'BLOCKED');
`;
  const env = { ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 60000,
    env,
  }).trim();
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('file-based mutation lock', () => {
  it('reports locking as supported because the file path needs no native binding', () => {
    expect(isStateFileLockingSupported()).toBe(true);
  });

  it('persists state instead of failing the write closed', () => {
    const target = statePath('write');

    expect(writeStateFileLocked(target, { mode: 'ralph', session: 'alpha' })).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ mode: 'ralph', session: 'alpha' });
  });

  it('holds the artifact across the critical section and removes it on release', () => {
    const target = statePath('artifact');
    const lockPath = `${target}.mutation.lock`;
    let heldDuringCallback = false;

    const result = withStateFileMutationLock(target, () => {
      heldDuringCallback = existsSync(lockPath);
      return 'done';
    });

    expect(result).toEqual({ acquired: true, value: 'done' });
    expect(heldDuringCallback).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reclaims an artifact whose owner is gone', () => {
    const target = statePath('dead');
    writeFileSync(`${target}.mutation.lock`, JSON.stringify(DEAD_OWNER));

    expect(writeStateFileLocked(target, { mode: 'ralph' })).toBe(true);
    expect(existsSync(`${target}.mutation.lock`)).toBe(false);
  });

  it('reclaims through a reclaim mutex abandoned by a dead process', () => {
    const target = statePath('stale-mutex');
    const lockPath = `${target}.mutation.lock`;
    writeFileSync(lockPath, JSON.stringify(DEAD_OWNER));
    writeFileSync(`${lockPath}.reclaiming`, JSON.stringify(DEAD_OWNER));

    expect(writeStateFileLocked(target, { mode: 'ralph' })).toBe(true);
    expect(existsSync(`${lockPath}.reclaiming`)).toBe(false);
  });

  it('fails closed on an artifact it cannot verify', () => {
    const target = statePath('corrupt');
    writeFileSync(`${target}.mutation.lock`, '{ not json');

    expect(writeStateFileLocked(target, { mode: 'ralph' })).toBe(false);
  });

  it('blocks the hook runtime while the compiled module holds the lock', () => {
    const target = statePath('cross-ts-holds');

    const result = withStateFileMutationLock(target, () => acquireStateFileLockSync(target, 3) as HookLock);

    expect(result.acquired).toBe(true);
    expect(result.value).toBeNull();
  });

  it('blocks the compiled module while the hook runtime holds the lock', () => {
    const target = statePath('cross-mjs-holds');
    const held = acquireStateFileLockSync(target, 3) as HookLock;
    expect(held).not.toBeNull();

    try {
      expect(writeStateFileLocked(target, { mode: 'ralph' })).toBe(false);
    } finally {
      releaseStateFileLockSync(held);
    }
    // Spends the full default retry budget, and each liveness probe spawns a
    // process on Windows, so this one needs more than the suite-wide timeout.
  }, 120000);

  it('excludes a file-path holder in another process', () => {
    const target = statePath('cross-process');

    const blocked = withStateFileMutationLock(target, () => acquireInChild(target));
    expect(blocked).toEqual({ acquired: true, value: 'BLOCKED' });

    expect(acquireInChild(target)).toBe('ACQUIRED');
  });
});
