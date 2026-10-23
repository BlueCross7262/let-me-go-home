import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { createRalphLoopHook, readRalphState } from '../../hooks/ralph/index.js';
import { adoptSession, listAdoptable } from '../session-adopt.js';
import { readStopControl, writeStopControl } from '../stop-control.js';
import { getSessionStateDir } from '../worktree-paths.js';

const HOOK = resolve(__dirname, '..', '..', '..', 'hooks', 'ralph-stop.mjs');
const LATER = () => Date.now() + 3 * 60 * 60 * 1000;

describe('session adopt', () => {
  let repo: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    const parent = join(tmpdir(), `lmgh-adopt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(parent, { recursive: true });
    repo = join(realpathSync.native(parent), 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = dirname(repo);
    process.env.USERPROFILE = dirname(repo);
  });

  afterEach(() => {
    rmSync(dirname(repo), { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  const sessionDir = (id: string) => getSessionStateDir(id, repo);
  const file = (id: string, name: string) => join(sessionDir(id), name);
  const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

  function startSource(id = 'src', prompt = 'implement the adopt feature') {
    expect(createRalphLoopHook(repo).startLoop(id, prompt, { promptText: prompt })).toBe(true);
  }

  function runHook(id: string): { decision?: string; reason?: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dirname(repo), USERPROFILE: dirname(repo) };
    for (const key of ['CLAUDE_PLUGIN_ROOT', 'DISABLE_LMGH', 'LMGH_SKIP_HOOKS', 'LMGH_STATE_DIR', 'LMGH_SECURITY']) delete env[key];
    const run = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: repo, session_id: id, hook_event_name: 'Stop', stop_hook_active: false }),
      encoding: 'utf8',
      env,
      cwd: repo,
      timeout: 30000,
    });
    const lines = run.stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  const take = (overrides: Partial<Parameters<typeof adoptSession>[0]> = {}) =>
    adoptSession({ from: 'src', to: 'dst', projectDir: repo, nowMs: LATER(), ...overrides });

  it('moves the loop to the new session and rewrites the session ids', () => {
    startSource();
    const before = readJson(file('src', 'first-stop-state.json'));
    const result = take();
    expect(result.ok).toBe(true);

    const state = readRalphState(repo, 'dst')!;
    expect(state.session_id).toBe('dst');
    expect(state.prompt).toBe('implement the adopt feature');
    expect(state.prompt_file).toBe(file('dst', 'ralph-prompt.md'));
    expect((readJson(file('dst', 'ralph-state.json'))._meta as Record<string, unknown>).sessionId).toBe('dst');
    expect(readFileSync(file('dst', 'ralph-prompt.md'), 'utf8')).toBe('implement the adopt feature');

    const control = readStopControl('first', 'dst', repo)!;
    expect(control.owner).toBe('ralph');
    expect(control.active).toBe(true);
    expect(control.session_id).toBe('dst');
    expect((control._meta as Record<string, unknown>).sessionId).toBe('dst');
    expect(control.iteration).toBe(before.iteration);
    expect(control.started_at).toBe(before.started_at);
    expect(control.project_path).toBe(repo);
    expect((control.messages as Record<string, unknown>).continue_literal).toEqual([`Full task text: ${file('dst', 'ralph-prompt.md')}`]);
    expect(Date.parse(String(control.last_checked_at))).toBeGreaterThanOrEqual(Date.parse(String(before.last_checked_at)));

    for (const name of ['ralph-state.json', 'first-stop-state.json', 'ralph-prompt.md']) {
      expect(existsSync(file('src', name))).toBe(false);
    }
  });

  it('copies the prd and keeps the source prd out of the source session', () => {
    startSource();
    const prdBefore = existsSync(file('src', 'prd.json')) ? readFileSync(file('src', 'prd.json'), 'utf8') : null;
    expect(take().ok).toBe(true);
    if (prdBefore !== null) {
      expect(readFileSync(file('dst', 'prd.json'), 'utf8')).toBe(prdBefore);
      expect(existsSync(file('src', 'prd.json'))).toBe(false);
    }
  });

  it('makes the Stop hook hold the new session and release the old one', () => {
    startSource();
    expect(take().ok).toBe(true);
    const held = runHook('dst');
    expect(held.decision).toBe('block');
    expect(held.reason?.startsWith('[RALPH LOOP - ITERATION 2/')).toBe(true);
    expect(held.reason).toContain(`Full task text: ${file('dst', 'ralph-prompt.md')}`);
    expect(runHook('src').decision).toBeUndefined();
  });

  it('clears a young tombstone of the destination so the hook still holds', () => {
    startSource();
    mkdirSync(sessionDir('dst'), { recursive: true });
    const recent = new Date().toISOString();
    writeFileSync(
      file('dst', 'skill-active-state.json'),
      JSON.stringify({ active_skills: { ralph: { completed_at: recent }, 'first-stop': { completed_at: recent }, other: { completed_at: recent } } }),
    );
    expect(runHook('dst').decision).toBeUndefined();
    const result = take();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cleared_tombstones.sort()).toEqual(['first-stop', 'ralph']);
    const ledger = readJson(file('dst', 'skill-active-state.json')).active_skills as Record<string, unknown>;
    expect(Object.keys(ledger)).toEqual(['other']);
    expect(runHook('dst').decision).toBe('block');
  });

  it('refuses a source that was active within two hours unless forced', () => {
    startSource();
    const refused = adoptSession({ from: 'src', to: 'dst', projectDir: repo });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('--force');
    expect(existsSync(file('src', 'first-stop-state.json'))).toBe(true);
    expect(existsSync(file('dst', 'first-stop-state.json'))).toBe(false);
    expect(adoptSession({ from: 'src', to: 'dst', projectDir: repo, force: true }).ok).toBe(true);
  });

  it('refuses a session cwd that differs from the loop project_path, even when forced', () => {
    startSource();
    const sub = join(repo, 'sub');
    mkdirSync(sub, { recursive: true });
    const refused = take({ projectDir: sub, force: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('project_path');
    expect(existsSync(file('src', 'first-stop-state.json'))).toBe(true);
    expect(existsSync(file('dst', 'ralph-state.json'))).toBe(false);
  });

  it('refuses bad ids, a missing source and an inactive source', () => {
    expect(take().ok).toBe(false);
    startSource();
    expect(take({ to: 'src' }).ok).toBe(false);
    expect(take({ to: '../x' }).ok).toBe(false);
    expect(take({ from: 'nope' }).ok).toBe(false);
    const state = readJson(file('src', 'ralph-state.json'));
    writeFileSync(file('src', 'ralph-state.json'), JSON.stringify({ ...state, active: false }));
    const inactive = take();
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.error).toContain('not an active ralph loop');
  });

  it('refuses a destination that already has ralph files or an active ralph record', () => {
    startSource();
    mkdirSync(sessionDir('dst'), { recursive: true });
    writeFileSync(file('dst', 'prd.json'), '{}');
    const occupied = take();
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) expect(occupied.error).toContain('already has');
    rmSync(file('dst', 'prd.json'));

    startSource('active-dst', 'other task');
    const active = take({ to: 'active-dst' });
    expect(active.ok).toBe(false);
    expect(existsSync(file('src', 'first-stop-state.json'))).toBe(true);
  });

  it('refuses a destination whose first layer another owner holds', () => {
    startSource();
    const held = writeStopControl(
      'first',
      { owner: 'demo', profile: 'generic', active: true, iteration: 0, max_iterations: 5 },
      { sessionId: 'dst', directory: repo },
    );
    expect(held.ok).toBe(true);
    const refused = take();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('held by demo');
    expect(readStopControl('first', 'dst', repo)!.owner).toBe('demo');
    expect(existsSync(file('src', 'first-stop-state.json'))).toBe(true);
  });

  it('rolls back the destination and keeps the source when a late step fails', () => {
    startSource();
    mkdirSync(sessionDir('dst'), { recursive: true });
    writeFileSync(file('dst', 'skill-active-state.json'), '{ not json');
    const failed = take();
    expect(failed.ok).toBe(false);
    for (const name of ['ralph-state.json', 'first-stop-state.json', 'ralph-prompt.md', 'prd.json']) {
      expect(existsSync(file('dst', name))).toBe(false);
    }
    for (const name of ['ralph-state.json', 'first-stop-state.json', 'ralph-prompt.md']) {
      expect(existsSync(file('src', name))).toBe(true);
    }
    expect(runHook('src').decision).toBe('block');
  });

  describe('progress markers', () => {
    const progress = () => join(repo, 'progress.txt');

    it('appends copies of the source markers and leaves every existing line alone', () => {
      startSource();
      const original = [
        '# progress',
        'execute-type: executor session=src',
        'refine-check: pass session=other',
        'execute-type: executor session=src fallback=task-error',
        'refine-check: pass session=src',
        'execute-type: executor session=other',
      ].join('\n');
      writeFileSync(progress(), original);
      const result = take();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.progress_file).toBe(progress());
      expect(result.progress_lines).toEqual([
        'execute-type: executor session=dst fallback=task-error',
        'refine-check: pass session=dst',
      ]);
      const after = readFileSync(progress(), 'utf8');
      expect(after.startsWith(original)).toBe(true);
      expect(after.slice(original.length)).toBe('\nexecute-type: executor session=dst fallback=task-error\n\nrefine-check: pass session=dst\n');
    });

    it('copies only the markers the source has and writes nothing without them', () => {
      startSource();
      const original = 'execute-type: executor session=src\n';
      writeFileSync(progress(), original);
      const result = take();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.progress_lines).toEqual(['execute-type: executor session=dst']);
      expect(readFileSync(progress(), 'utf8')).toBe(`${original}\nexecute-type: executor session=dst\n`);
    });

    it('leaves progress.txt alone when no marker matches', () => {
      startSource();
      writeFileSync(progress(), 'refine-check: pass session=other\n');
      const result = take();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.progress_lines).toEqual([]);
      expect(readFileSync(progress(), 'utf8')).toBe('refine-check: pass session=other\n');
    });

    it('does not touch progress.txt when the adoption is refused', () => {
      startSource();
      writeFileSync(progress(), 'execute-type: executor session=src\n');
      appendFileSync(progress(), '');
      expect(adoptSession({ from: 'src', to: 'dst', projectDir: repo }).ok).toBe(false);
      expect(readFileSync(progress(), 'utf8')).toBe('execute-type: executor session=src\n');
    });
  });

  describe('list', () => {
    it('shows the loop with activity, hold and prd columns, and moves it after a take', () => {
      startSource();
      const before = listAdoptable(repo);
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ session_id: 'src', active: true, fresh: true, holds: true, project_path: repo });
      expect(before[0].has_prd).toBe(existsSync(file('src', 'prd.json')));
      expect(listAdoptable(repo, LATER())[0].fresh).toBe(false);

      expect(take().ok).toBe(true);
      const after = listAdoptable(repo);
      expect(after.map((candidate) => candidate.session_id)).toEqual(['dst']);
      expect(after[0].holds).toBe(true);
    });

    it('reports holds=false for a different cwd', () => {
      startSource();
      const sub = join(repo, 'sub');
      mkdirSync(sub, { recursive: true });
      expect(listAdoptable(sub)[0].holds).toBe(false);
    });
  });
});
