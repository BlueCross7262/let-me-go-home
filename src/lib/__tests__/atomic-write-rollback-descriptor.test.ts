/**
 * Regression guard: the published descriptor must be closed before rollback.
 *
 * rollbackPriorTarget renames the backup hard link over the target. POSIX
 * permits that while a descriptor for the target inode is still open; Windows
 * refuses it with EPERM, and the rename sits inside a catch that swallows the
 * failure — so a publication hook that threw left the failed generation in
 * place instead of restoring the prior file.
 *
 * A test that only checks the restored bytes cannot catch a return of this bug
 * on Linux, where the rename succeeds either way. These tests instead observe
 * the property that actually matters and holds on every platform: at the moment
 * the rollback rename runs, no descriptor opened by the publisher is still
 * open. fstatSync throws EBADF on a closed descriptor, which is the probe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const fsControl = vi.hoisted(() => ({
  openFds: [] as number[],
  /** Descriptors still open when a `.rollback.` rename was attempted. */
  liveAtRollback: [] as number[],
  rollbackRenames: 0,
}));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      fsControl.openFds.push(fd);
      return fd;
    }) as typeof actual.openSync,
    renameSync: ((from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (typeof from === 'string' && from.includes('.rollback.')) {
        fsControl.rollbackRenames += 1;
        for (const fd of fsControl.openFds) {
          try {
            actual.fstatSync(fd);
            fsControl.liveAtRollback.push(fd);
          } catch {
            // EBADF — already closed, which is what this guard wants.
          }
        }
      }
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

import { atomicWriteBatchSync, atomicWriteFileSync, atomicWriteJson } from '../atomic-write.js';

const directories: string[] = [];

function freshTarget(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `rollback-fd-${label}-`));
  directories.push(directory);
  const filePath = join(directory, 'state.json');
  writeFileSync(filePath, 'old', 'utf8');
  return filePath;
}

afterEach(() => {
  fsControl.openFds = [];
  fsControl.liveAtRollback = [];
  fsControl.rollbackRenames = 0;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('rollback descriptor boundary', () => {
  it('closes the published descriptor before atomicWriteFileSync rolls back', () => {
    const filePath = freshTarget('sync');
    const hooks = { afterRename: () => { throw new Error('publication fenced'); } };

    expect(() => atomicWriteFileSync(filePath, 'new', hooks)).toThrow('publication fenced');

    expect(fsControl.rollbackRenames).toBe(1);
    expect(fsControl.liveAtRollback).toEqual([]);
    expect(readFileSync(filePath, 'utf8')).toBe('old');
    expect(readdirSync(join(filePath, '..'))).toEqual(['state.json']);
  });

  it('closes the published descriptor before atomicWriteBatchSync rolls back', () => {
    const filePath = freshTarget('batch');
    const hooks = { afterRename: () => { throw new Error('publication fenced'); } };

    expect(() => atomicWriteBatchSync([{ path: filePath, content: 'new' }], hooks)).toThrow(
      'publication fenced',
    );

    expect(fsControl.rollbackRenames).toBe(1);
    expect(fsControl.liveAtRollback).toEqual([]);
    expect(readFileSync(filePath, 'utf8')).toBe('old');
  });

  it('closes the published descriptor before atomicWriteJson rolls back', async () => {
    const filePath = freshTarget('json');
    const hooks = { afterRename: () => { throw new Error('publication fenced'); } };

    await expect(atomicWriteJson(filePath, { status: 'new' }, hooks)).rejects.toThrow(
      'publication fenced',
    );

    expect(fsControl.rollbackRenames).toBe(1);
    expect(fsControl.liveAtRollback).toEqual([]);
    expect(readFileSync(filePath, 'utf8')).toBe('old');
  });

  it('leaves no rollback artifact behind on a successful publication', () => {
    const filePath = freshTarget('clean');

    atomicWriteFileSync(filePath, 'new');

    expect(fsControl.rollbackRenames).toBe(0);
    expect(readFileSync(filePath, 'utf8')).toBe('new');
    expect(readdirSync(join(filePath, '..'))).toEqual(['state.json']);
  });
});
