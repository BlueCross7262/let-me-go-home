import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { getLmghRoot } from '../lib/worktree-paths.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SKILL = join(REPO_ROOT, 'skills', 'cancel', 'SKILL.md');
const SESSION_ID = 'cancel-fallback-test';
const WINDOWS_BASH = 'C:/Program Files/Git/bin/bash.exe';
const BASH = process.platform === 'win32' ? WINDOWS_BASH : 'bash';
const hasBash = process.platform === 'win32'
  ? existsSync(WINDOWS_BASH)
  : spawnSync('bash', ['-c', 'true']).status === 0;

function fallbackBlock(): string {
  const match = readFileSync(SKILL, 'utf-8').match(/```bash\n(# Fallback: direct file removal[\s\S]*?)```/);
  if (!match) throw new Error('cancel fallback block not found in SKILL.md');
  return match[1];
}

const created: string[] = [];

function scratch(parent: string): string {
  const dir = realpathSync.native(mkdtempSync(join(parent, 'lmgh-cancel-')));
  created.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  git(dir, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init', '--quiet']);
  return realpathSync.native(dir);
}

function rootFor(dir: string, env: Record<string, string> = {}): string {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return getLmghRoot(dir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runFallback(cwd: string, expectedRoot: string, env: Record<string, string> = {}): boolean {
  const stateFile = join(expectedRoot, 'state', 'sessions', SESSION_ID, 'ralph-state.json');
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, '{"active":true}');
  const script = join(created[0], 'fallback.sh');
  writeFileSync(script, fallbackBlock());
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: SESSION_ID,
    CLAUDE_PLUGIN_ROOT: REPO_ROOT,
    LMGH_SESSION_ID: undefined,
    CLAUDE_SESSION_ID: undefined,
    LMGH_STATE_DIR: undefined,
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  const result = spawnSync(BASH, [script], { cwd, env: childEnv as NodeJS.ProcessEnv, encoding: 'utf-8', windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  return !existsSync(stateFile);
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasBash)('cancel skill bash fallback', () => {
  it('clears the session state of a git repository from a subdirectory', () => {
    const repo = initRepo(join(scratch(tmpdir()), 'repo'));
    mkdirSync(join(repo, 'sub'));
    expect(runFallback(join(repo, 'sub'), rootFor(repo))).toBe(true);
  });

  it('clears the session state the plugin keeps in a submodule superproject', () => {
    const base = scratch(tmpdir());
    const lib = initRepo(join(base, 'lib'));
    const superproject = initRepo(join(base, 'super'));
    git(superproject, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', lib.replace(/\\/g, '/'), 'mod']);
    const submodule = realpathSync.native(join(superproject, 'mod'));
    const root = rootFor(submodule);
    expect(root).toBe(join(superproject, '.lmgh'));
    expect(runFallback(submodule, root)).toBe(true);
  });

  it('clears the session state the plugin keeps at a workspace marker', () => {
    const workspace = scratch(homedir());
    writeFileSync(join(workspace, '.lmgh-workspace'), '{}');
    const repo = initRepo(join(workspace, 'repo'));
    const root = rootFor(repo);
    expect(root).toBe(join(workspace, '.lmgh'));
    expect(runFallback(repo, root)).toBe(true);
  });

  it('clears the session state the plugin keeps in the home directory for a non-git directory', () => {
    const base = scratch(tmpdir());
    const plain = join(base, 'plain');
    const home = join(base, 'home');
    mkdirSync(plain);
    mkdirSync(home);
    const homeEnv = { HOME: home, USERPROFILE: home };
    const root = rootFor(plain, homeEnv);
    expect(root).toBe(join(home, '.lmgh'));
    expect(runFallback(plain, root, homeEnv)).toBe(true);
  });

  it('falls back to the bash computation when the plugin directory is wrong', () => {
    const repo = initRepo(join(scratch(tmpdir()), 'repo'));
    expect(runFallback(repo, rootFor(repo), { CLAUDE_PLUGIN_ROOT: join(created[0], 'missing') })).toBe(true);
  });
});
