import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, readdirSync, renameSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

import {
  takeSnapshot,
  changedFiles,
  // @ts-expect-error Script runtime source is intentionally JavaScript-only.
} from '../../scripts/lib/executor-opencode-snapshot.mjs';

const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;
const HASH = /^[0-9a-f]{40}$/;

let root = '';
let repo = '';
const reservedFiles: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function write(relative: string, text = 'x\n', base = repo) {
  const file = join(base, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

function initRepo(path: string, commit = true) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '.');
  if (commit) {
    write('a.txt', 'a\n', path);
    write('b.txt', 'b\n', path);
    git(path, 'add', 'a.txt', 'b.txt');
    git(path, 'commit', '-q', '-m', 'init');
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lmgh-eo-snapshot-test-'));
  repo = join(root, 'repo');
});

afterEach(() => {
  for (const file of reservedFiles.splice(0)) {
    try {
      unlinkSync(file);
    } catch {
      continue;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)('takeSnapshot', () => {
  it('returns a head hash and a tree hash for a clean repository', () => {
    initRepo(repo);
    const snapshot = takeSnapshot(repo);
    expect(snapshot.git).toBe('ok');
    expect(snapshot.head).toMatch(HASH);
    expect(snapshot.tree).toMatch(HASH);
    expect(snapshot.failure).toBeNull();
  });

  it('gives equal tree hashes for two snapshots without changes in between', () => {
    initRepo(repo);
    write('dirty.txt', 'one\n');
    const before = takeSnapshot(repo);
    const after = takeSnapshot(repo);
    expect(after.tree).toBe(before.tree);
    expect(changedFiles(repo, before.tree, after.tree)).toEqual([]);
  });

  it('shows an already modified tracked file that is modified again', () => {
    initRepo(repo);
    write('a.txt', 'first edit\n');
    const before = takeSnapshot(repo);
    write('a.txt', 'second edit\n');
    const after = takeSnapshot(repo);
    expect(after.tree).not.toBe(before.tree);
    expect(changedFiles(repo, before.tree, after.tree)).toEqual(['M\ta.txt']);
  });

  it('shows added, deleted and renamed files with their status letters', () => {
    initRepo(repo);
    const before = takeSnapshot(repo);
    write('new.txt', 'new\n');
    unlinkSync(join(repo, 'a.txt'));
    renameSync(join(repo, 'b.txt'), join(repo, 'c.txt'));
    const after = takeSnapshot(repo);
    const lines: string[] = changedFiles(repo, before.tree, after.tree);
    expect(lines).toContain('A\tnew.txt');
    expect(lines).toContain('D\ta.txt');
    expect(lines).toContain('R100\tb.txt\tc.txt');
    expect(lines).toHaveLength(3);
  });

  it('keeps the order of before and after in the status letters', () => {
    initRepo(repo);
    const before = takeSnapshot(repo);
    write('new.txt', 'new\n');
    const after = takeSnapshot(repo);
    expect(changedFiles(repo, before.tree, after.tree)).toEqual(['A\tnew.txt']);
    expect(changedFiles(repo, after.tree, before.tree)).toEqual(['D\tnew.txt']);
  });

  it('leaves files that .gitignore ignores out of the change list', () => {
    initRepo(repo);
    write('.gitignore', 'ignored.log\n');
    const before = takeSnapshot(repo);
    write('ignored.log', 'noise\n');
    const after = takeSnapshot(repo);
    expect(after.tree).toBe(before.tree);
    expect(changedFiles(repo, before.tree, after.tree)).toEqual([]);
  });

  it('reports a different head after a commit', () => {
    initRepo(repo);
    const before = takeSnapshot(repo);
    write('c.txt', 'c\n');
    git(repo, 'add', 'c.txt');
    git(repo, 'commit', '-q', '-m', 'second');
    const after = takeSnapshot(repo);
    expect(after.head).not.toBe(before.head);
    expect(after.head).toMatch(HASH);
    expect(changedFiles(repo, before.tree, after.tree)).toEqual(['A\tc.txt']);
  });

  it('reports head none for a repository without commits and still builds a tree', () => {
    initRepo(repo, false);
    write('first.txt', 'first\n');
    const snapshot = takeSnapshot(repo);
    expect(snapshot.git).toBe('ok');
    expect(snapshot.head).toBe('none');
    expect(snapshot.tree).toMatch(HASH);
  });

  it('does not change the real index bytes or the status output', () => {
    initRepo(repo);
    write('a.txt', 'unstaged change\n');
    write('staged.txt', 'staged\n');
    git(repo, 'add', 'staged.txt');
    write('untracked.txt', 'untracked\n');
    const indexFile = join(repo, '.git', 'index');
    const indexBefore = sha256(indexFile);
    const statusBefore = git(repo, 'status', '--porcelain=v2');
    takeSnapshot(repo);
    expect(sha256(indexFile)).toBe(indexBefore);
    expect(git(repo, 'status', '--porcelain=v2')).toBe(statusBefore);
  });

  it('snapshots the whole repository when the directory is a subfolder', () => {
    initRepo(repo);
    write('sub/deep/inner.txt', 'inner\n');
    write('top.txt', 'top\n');
    const indexFile = join(repo, '.git', 'index');
    const indexBefore = sha256(indexFile);
    const fromRoot = takeSnapshot(repo);
    const fromSub = takeSnapshot(join(repo, 'sub', 'deep'));
    expect(fromSub.git).toBe('ok');
    expect(fromSub.tree).toBe(fromRoot.tree);
    expect(sha256(indexFile)).toBe(indexBefore);
  });

  it('uses the index of a linked worktree and leaves it untouched', () => {
    initRepo(repo);
    const worktree = join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'linked-branch');
    write('only-in-linked.txt', 'linked\n', worktree);
    const worktreeIndex = git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const mainIndex = join(repo, '.git', 'index');
    const worktreeBefore = sha256(worktreeIndex);
    const mainBefore = sha256(mainIndex);
    const snapshot = takeSnapshot(worktree);
    expect(snapshot.git).toBe('ok');
    expect(snapshot.tree).toMatch(HASH);
    expect(sha256(worktreeIndex)).toBe(worktreeBefore);
    expect(sha256(mainIndex)).toBe(mainBefore);
    const mainSnapshot = takeSnapshot(repo);
    expect(mainSnapshot.tree).not.toBe(snapshot.tree);
  });

  it('snapshots the directory it is given, which can be a second repository', () => {
    initRepo(repo);
    const second = join(root, 'second');
    initRepo(second);
    const before = takeSnapshot(second);
    write('edited-in-second.txt', 'second\n', second);
    const after = takeSnapshot(second);
    expect(changedFiles(second, before.tree, after.tree)).toEqual(['A\tedited-in-second.txt']);
    expect(changedFiles(repo, takeSnapshot(repo).tree, takeSnapshot(repo).tree)).toEqual([]);
  });

  it('reports git unavailable for a directory that is not a repository', () => {
    mkdirSync(repo, { recursive: true });
    const snapshot = takeSnapshot(repo);
    expect(snapshot.git).toBe('unavailable');
    expect(snapshot.tree).toBeNull();
    expect(snapshot.head).toBeNull();
  });

  it('reports git unavailable for a directory that does not exist', () => {
    const snapshot = takeSnapshot(join(root, 'missing'));
    expect(snapshot.git).toBe('unavailable');
  });

  it('removes its temporary directory', () => {
    initRepo(repo);
    const privateTemp = join(root, 'private-temp');
    mkdirSync(privateTemp, { recursive: true });
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = privateTemp;
    process.env.TMP = privateTemp;
    process.env.TMPDIR = privateTemp;
    try {
      expect(takeSnapshot(repo).tree).toMatch(HASH);
      expect(readdirSync(privateTemp)).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'reports a failure and no tree when the work tree holds a reserved device name file',
    () => {
      initRepo(repo);
      const reserved = join(repo, 'nul');
      writeFileSync(`\\\\?\\${reserved}`, 'x\n');
      reservedFiles.push(reserved);
      const snapshot = takeSnapshot(repo);
      expect(snapshot.git).toBe('ok');
      expect(snapshot.tree).toBeNull();
      expect(typeof snapshot.failure).toBe('string');
      expect(snapshot.failure.length).toBeGreaterThan(0);
      expect(snapshot.head).toMatch(HASH);
    },
  );
});

describe('changedFiles', () => {
  it('returns null when a tree hash is missing', () => {
    expect(changedFiles(repo, null, 'a'.repeat(40))).toBeNull();
    expect(changedFiles(repo, 'a'.repeat(40), null)).toBeNull();
  });
});
