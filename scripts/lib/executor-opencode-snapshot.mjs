import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const TEMP_PREFIX = 'lmgh-eo-snap-';
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

function runGit(dir, args, extraEnv = {}) {
  const run = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: run.error ? -1 : run.status,
    stdout: (run.stdout ?? '').trim(),
    stderr: (run.stderr ?? '').trim(),
  };
}

function firstLine(text) {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  return line ? line.trim() : 'git failed without a message';
}

function isInsideWorkTree(dir) {
  if (!existsSync(dir)) return false;
  const inside = runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  return inside.status === 0 && inside.stdout === 'true';
}

function readHead(dir) {
  const head = runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  return head.status === 0 && /^[0-9a-f]{40,64}$/.test(head.stdout) ? head.stdout : 'none';
}

function realIndexPath(dir) {
  const absolutePath = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  if (absolutePath.status === 0 && absolutePath.stdout !== '') return absolutePath.stdout;
  const plain = runGit(dir, ['rev-parse', '--git-path', 'index']);
  if (plain.status !== 0 || plain.stdout === '') return null;
  return isAbsolute(plain.stdout) ? plain.stdout : resolve(dir, plain.stdout);
}

function buildTree(dir) {
  const scratch = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    const source = realIndexPath(dir);
    if (source && existsSync(source)) copyFileSync(source, join(scratch, 'index'));
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    const added = runGit(dir, ['add', '-A', '--', ':/'], env);
    if (added.status !== 0) return { tree: null, failure: firstLine(added.stderr) };
    const written = runGit(dir, ['write-tree'], env);
    if (written.status !== 0 || !/^[0-9a-f]{40,64}$/.test(written.stdout)) {
      return { tree: null, failure: firstLine(written.stderr) };
    }
    return { tree: written.stdout, failure: null };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function takeSnapshot(dir) {
  if (!isInsideWorkTree(dir)) return { git: 'unavailable', head: null, tree: null, failure: null };
  const head = readHead(dir);
  const built = buildTree(dir);
  return { git: 'ok', head, tree: built.tree, failure: built.failure };
}

export function changedFiles(dir, beforeTree, afterTree) {
  if (!beforeTree || !afterTree) return null;
  const diff = runGit(dir, ['diff', '--name-status', beforeTree, afterTree]);
  if (diff.status !== 0) return null;
  return diff.stdout === '' ? [] : diff.stdout.split(/\r?\n/);
}
