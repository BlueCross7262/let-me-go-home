import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as engine from '../../../../scripts/lib/stop-control.mjs';
import { createRalphLoopHook, readRalphState } from '../index.js';
import { readStopControl, writeStopControl } from '../../../lib/stop-control.js';

const HOOK = resolve(__dirname, '..', '..', '..', '..', 'scripts', 'ralph-stop.mjs');

describe('startLoop and cancelLoop with the first-layer control record', () => {
  let testDir: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `ralph-stop-control-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = testDir;
    process.env.USERPROFILE = testDir;
    mkdirSync(join(testDir, '.lmgh', 'state'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  it('stamps the domain file and writes a valid control record', () => {
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);

    const domain = readRalphState(testDir, 'session-a');
    expect(domain!.stop_control).toBe('first');
    const control = readStopControl('first', 'session-a', testDir)!;
    expect(control.owner).toBe('ralph');
    expect(control.active).toBe(true);
    expect(control.iteration).toBe(1);
    expect(control.max_iterations).toBe(domain!.max_iterations);
    expect(control.started_at).toBe(domain!.started_at);
    expect(control.project_path).toBe(testDir);
    expect((control.messages as Record<string, unknown>).continue_literal).toEqual([`Full task text: ${domain!.prompt_file}`]);
    expect(engine.validateRecord(control)).toEqual({ valid: true });
  });

  it('merges caller overrides over the ralph profile', () => {
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A', { stopControl: { cap_step: 5, hard_max_applies: false } })).toBe(true);
    const control = readStopControl('first', 'session-a', testDir)!;
    expect(control.cap_step).toBe(5);
    expect(control.hard_max_applies).toBe(false);
    expect(control.on_cap).toBe('extend');
  });

  it('writes no control record without a session id', () => {
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop(undefined, 'implement feature A')).toBe(true);
    expect(readRalphState(testDir)!.stop_control).toBeUndefined();
    expect(existsSync(join(testDir, '.lmgh', 'state', 'sessions'))).toBe(false);
  });

  it('removes the domain file again when the first layer is held by another owner', () => {
    const held = writeStopControl(
      'first',
      { owner: 'demo', active: true, iteration: 0, max_iterations: 3 },
      { sessionId: 'session-a', directory: testDir },
    );
    expect(held.ok).toBe(true);
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(false);
    expect(readRalphState(testDir, 'session-a')).toBeNull();
    expect(readStopControl('first', 'session-a', testDir)?.owner).toBe('demo');
  });

  it('cancelLoop removes the control record and the domain file', () => {
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);
    expect(hook.cancelLoop('session-a')).toBe(true);
    expect(readStopControl('first', 'session-a', testDir)).toBeNull();
    expect(readRalphState(testDir, 'session-a')).toBeNull();
  });

  it('the stop hook blocks on the control record a fresh loop wrote and counts it', () => {
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);
    const payload = JSON.stringify({ cwd: testDir, session_id: 'session-a' });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: testDir, USERPROFILE: testDir };
    for (const key of ['CLAUDE_PLUGIN_ROOT', 'DISABLE_LMGH', 'LMGH_SKIP_HOOKS', 'LMGH_STATE_DIR', 'LMGH_SECURITY']) delete env[key];
    const run = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8', env, cwd: testDir, timeout: 30000 });
    const verdict = JSON.parse(run.stdout.trim());
    expect(verdict.decision).toBe('block');
    expect(verdict.reason.startsWith('[RALPH LOOP - ITERATION 2/')).toBe(true);
    expect(verdict.reason).toContain('Full task text:');
    expect(readStopControl('first', 'session-a', testDir)!.iteration).toBe(2);
    expect(readRalphState(testDir, 'session-a')!.iteration).toBe(1);
    expect(readFileSync(readRalphState(testDir, 'session-a')!.prompt_file!, 'utf-8')).toBe('implement feature A');
  });
});
