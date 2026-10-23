import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'fs';
import { execFileSync, execSync, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createRalphLoopHook } from '../hooks/ralph/index.js';
import { getSessionStateDir } from '../lib/worktree-paths.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'session-adopt.mjs');
const STOP_HOOK = join(REPO_ROOT, 'hooks', 'ralph-stop.mjs');
const MODULE = join(REPO_ROOT, 'dist', 'lib', 'session-adopt.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!existsSync(MODULE))('session-adopt script', () => {
  let tempDir: string;
  let repo: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-adopt-script-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const merged: Record<string, string | undefined> = {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      CLAUDE_CODE_SESSION_ID: undefined,
      LMGH_SESSION_ID: undefined,
      LMGH_STATE_DIR: undefined,
      CLAUDE_PLUGIN_ROOT: undefined,
      DISABLE_LMGH: undefined,
      LMGH_SKIP_HOOKS: undefined,
      LMGH_SECURITY: undefined,
      ...extra,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) delete merged[key];
    }
    return merged as NodeJS.ProcessEnv;
  }

  function run(args: string[], extra: Record<string, string | undefined> = {}): RunResult {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: repo,
        env: env(extra),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 30000,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      return { status: typeof err.status === 'number' ? err.status : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  function runHook(sessionId: string): { decision?: string; reason?: string } {
    const result = spawnSync(process.execPath, [STOP_HOOK], {
      cwd: repo,
      env: env(),
      input: JSON.stringify({ session_id: sessionId, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  const startSource = () => expect(createRalphLoopHook(repo).startLoop('src', 'adopt me', { promptText: 'adopt me' })).toBe(true);
  const take = (...more: string[]) => run(['take', '--from', 'src', '--project-dir', repo, '--session-id', 'dst', ...more]);

  it('lists the loop of the other session', () => {
    startSource();
    const result = run(['list', '--project-dir', repo]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({ session_id: 'src', active: true, fresh: true, holds: true, project_path: repo });
  });

  it('refuses a fresh source and then takes it with --force', () => {
    startSource();
    const refused = take();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--force');
    const taken = take('--force');
    expect(taken.status).toBe(0);
    const out = JSON.parse(taken.stdout);
    expect(out).toMatchObject({ ok: true, command: 'take', from: 'src', to: 'dst', layer: 'first' });
    expect(out.leftover).toEqual([]);
    expect(existsSync(join(getSessionStateDir('dst', repo), 'first-stop-state.json'))).toBe(true);
    expect(existsSync(join(getSessionStateDir('src', repo), 'first-stop-state.json'))).toBe(false);
  });

  it('makes the Stop hook hold the new session', () => {
    startSource();
    expect(take('--force').status).toBe(0);
    const held = runHook('dst');
    expect(held.decision).toBe('block');
    expect(held.reason?.startsWith('[RALPH LOOP - ITERATION 2/')).toBe(true);
    expect(runHook('src').decision).toBeUndefined();
    const prompt = readFileSync(join(getSessionStateDir('dst', repo), 'ralph-prompt.md'), 'utf8');
    expect(prompt).toBe('adopt me');
  });

  it('reads the destination session id from CLAUDE_CODE_SESSION_ID', () => {
    startSource();
    const result = run(['take', '--from', 'src', '--project-dir', repo, '--force'], { CLAUDE_CODE_SESSION_ID: 'dst' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).to).toBe('dst');
  });

  it('fails closed on bad input and keeps the source', () => {
    startSource();
    expect(run(['take', '--project-dir', repo, '--session-id', 'dst']).stderr).toContain('--from is required');
    expect(run(['take', '--from', 'src', '--session-id', 'dst']).stderr).toContain('--project-dir is required');
    expect(run(['take', '--from', 'src', '--project-dir', 'rel/dir', '--session-id', 'dst']).stderr).toContain('absolute path');
    expect(run(['take', '--from', 'src', '--project-dir', repo]).stderr).toContain('no session id');
    expect(run(['take', '--from', 'src', '--project-dir', join(tempDir, 'missing'), '--session-id', 'dst']).stderr).toContain('not an existing directory');
    expect(run(['take', '--from', 'src', '--project-dir', repo, '--session-id', 'src', '--force']).status).toBe(1);
    expect(run(['take', '--force=yes', '--from', 'src']).stderr).toContain('takes no value');
    expect(run(['bogus']).stderr).toContain('usage');
    expect(run(['list', '--bogus', 'x']).stderr).toContain('unknown option');
    expect(existsSync(join(getSessionStateDir('src', repo), 'first-stop-state.json'))).toBe(true);
  });
});
