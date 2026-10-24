import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as engine from '../../../../scripts/lib/stop-control.mjs';
import { createRalphLoopHook, readRalphState } from '../index.js';
import { readStopControl, writeStopControl } from '../../../lib/stop-control.js';

const HOOK = resolve(__dirname, '..', '..', '..', '..', 'hooks', 'ralph-stop.mjs');

describe('startLoop and cancelLoop with the control record', () => {
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

  it('writes a valid control record', () => {
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);

    const domain = readRalphState(testDir, 'session-a');
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
    expect(existsSync(join(testDir, '.lmgh', 'state', 'sessions'))).toBe(false);
  });

  const hold = (layer: 'first' | 'second' | 'third', owner: string, sessionId = 'session-a') =>
    expect(
      writeStopControl(layer, { owner, active: true, iteration: 0, max_iterations: 3 }, { sessionId, directory: testDir }).ok,
    ).toBe(true);

  it('removes the domain file again when every layer is held by another owner', () => {
    hold('first', 'demo');
    hold('second', 'other');
    hold('third', 'third-owner');
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(false);
    expect(readRalphState(testDir, 'session-a')).toBeNull();
    expect(readStopControl('first', 'session-a', testDir)?.owner).toBe('demo');
    expect(readStopControl('second', 'session-a', testDir)?.owner).toBe('other');
    expect(readStopControl('third', 'session-a', testDir)?.owner).toBe('third-owner');
  });

  it('starts on a layer inside the live holder when the first layer is held', () => {
    hold('first', 'demo');
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);
    expect(readStopControl('first', 'session-a', testDir)?.owner).toBe('demo');
    expect(readStopControl('second', 'session-a', testDir)?.owner).toBe('ralph');
    expect(readStopControl('third', 'session-a', testDir)).toBeNull();
  });

  it('starts above a live chain that sits in the second layer', () => {
    hold('second', 'phase-chain');
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);
    expect(readStopControl('first', 'session-a', testDir)).toBeNull();
    expect(readStopControl('third', 'session-a', testDir)?.owner).toBe('ralph');
  });

  it('falls back to the lowest free layer and warns when the live holder sits in the last layer', () => {
    hold('third', 'phase-chain');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const hook = createRalphLoopHook(testDir);
      expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);
      expect(readStopControl('first', 'session-a', testDir)?.owner).toBe('ralph');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the layer a restarted loop already holds', () => {
    hold('first', 'demo');
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);
    expect(hook.startLoop('session-a', 'implement feature A again')).toBe(true);
    expect(readStopControl('second', 'session-a', testDir)?.owner).toBe('ralph');
    expect(readStopControl('third', 'session-a', testDir)).toBeNull();
  });

  it('does not read the layers of another session', () => {
    hold('first', 'demo', 'session-b');
    const hook = createRalphLoopHook(testDir);
    expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);
    expect(readStopControl('first', 'session-a', testDir)?.owner).toBe('ralph');
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
