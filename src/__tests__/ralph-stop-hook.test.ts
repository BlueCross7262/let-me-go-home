import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { classifyPendingWork, formatWaitingReason } from '../../scripts/lib/background-wait.mjs';

const REPO_ROOT = resolve(__dirname, '..', '..');
const STOP_HOOK = join(REPO_ROOT, 'scripts', 'ralph-stop.mjs');
const SAFE_CONTINUE = { continue: true, suppressOutput: true };

interface HookOutput {
  continue?: boolean;
  suppressOutput?: boolean;
  decision?: string;
  reason?: string;
}

describe('classifyPendingWork', () => {
  const subagent = { id: 'a1', type: 'subagent', status: 'running', description: 'probe' };
  const shell = { id: 'b1', type: 'shell', status: 'running', description: 'npm test', command: 'npm test' };

  it('defers while a subagent, workflow or MCP task is running', () => {
    expect(classifyPendingWork({ background_tasks: [subagent] }).kind).toBe('defer');
    expect(classifyPendingWork({ background_tasks: [{ id: 'w1', type: 'workflow', status: 'running' }] }).kind).toBe('defer');
    expect(classifyPendingWork({ background_tasks: [{ id: 'm1', type: 'MCP task', status: 'running' }] }).kind).toBe('defer');
    expect(classifyPendingWork({ background_tasks: [shell, subagent] }).kind).toBe('defer');
  });

  it('nudges when only other running work is left', () => {
    const result = classifyPendingWork({ background_tasks: [shell, { id: 'n1', type: 'monitor' }] });
    expect(result.kind).toBe('nudge');
    expect(result.tasks).toHaveLength(2);
  });

  it('defers for a one-shot cron and ignores recurring crons', () => {
    expect(classifyPendingWork({ session_crons: [{ id: 'c1', recurring: false }] }).kind).toBe('defer');
    expect(classifyPendingWork({ session_crons: [{ id: 'c2', recurring: true }, { id: 'c3' }] }).kind).toBe('none');
  });

  it('ignores finished tasks and malformed input', () => {
    expect(classifyPendingWork({ background_tasks: [{ id: 'a2', type: 'subagent', status: 'completed' }] }).kind).toBe('none');
    expect(classifyPendingWork({ background_tasks: [{ id: 'b2', type: 'shell', status: 'Failed' }] }).kind).toBe('none');
    expect(classifyPendingWork({ background_tasks: 'running', session_crons: {} }).kind).toBe('none');
    expect(classifyPendingWork({ background_tasks: [null, 3] }).kind).toBe('none');
    expect(classifyPendingWork({}).kind).toBe('none');
  });
});

describe('formatWaitingReason', () => {
  it('names each task and tells the model to end the turn again', () => {
    const reason = formatWaitingReason([
      { id: 'b1', type: 'shell', description: 'npm test' },
      { type: 'monitor' },
    ]);
    const lines = reason.split('\n');
    expect(lines[0]).toBe('[RALPH LOOP - WAITING] Background work is still running: shell b1 "npm test", monitor.');
    expect(lines[1]).toBe('If this turn ended to wait for it, end the turn again now; do not poll or sleep. The loop resumes when it reports.');
    expect(lines[2]).toBe('If work that does not depend on it remains, continue that work.');
  });

  it('caps the list at five tasks and clips long descriptions', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, type: 'shell', description: 'd'.repeat(90) }));
    const first = formatWaitingReason(tasks).split('\n')[0];
    expect(first.match(/shell t\d/g)).toHaveLength(5);
    expect(first).toContain(`"${'d'.repeat(80)}…"`);
    expect(first).toContain('+2 more');
  });
});

describe('ralph-stop hook', () => {
  let tempDir: string;
  let repo: string;
  let sessionId: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    sessionId = `stop-test-${Math.random().toString(36).slice(2)}`;
    const sessionDir = join(repo, '.lmgh', 'state', 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    statePath = join(sessionDir, 'ralph-state.json');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  function writeState(overrides: Record<string, unknown> = {}): string {
    const checkedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(statePath, JSON.stringify({
      active: true,
      iteration: 1,
      max_iterations: 100,
      started_at: checkedAt,
      last_checked_at: checkedAt,
      prompt: 'short task',
      session_id: sessionId,
      project_path: repo,
      prd_mode: true,
      ...overrides,
    }));
    return checkedAt;
  }

  function readState(): Record<string, unknown> {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  }

  function runHook(extra: Record<string, unknown> = {}): HookOutput {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      LMGH_NOTIFY: '0',
      CLAUDE_PLUGIN_ROOT: undefined,
      LMGH_STATE_DIR: undefined,
      DISABLE_LMGH: undefined,
      LMGH_SKIP_HOOKS: undefined,
      LMGH_SECURITY: undefined,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete env[key];
    }
    const result = spawnSync(process.execPath, [STOP_HOOK], {
      cwd: repo,
      env: env as NodeJS.ProcessEnv,
      input: JSON.stringify({
        session_id: sessionId,
        cwd: repo,
        hook_event_name: 'Stop',
        stop_hook_active: false,
        ...extra,
      }),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]) as HookOutput;
  }

  it('blocks and advances the iteration when nothing is running', () => {
    writeState();
    const output = runHook();
    expect(output.decision).toBe('block');
    expect(output.reason?.startsWith('[RALPH LOOP - ITERATION 2/100]')).toBe(true);
    expect(output.reason).toContain('Task: short task');
    expect(readState().iteration).toBe(2);
  });

  it('treats empty background arrays like no background work', () => {
    writeState();
    const output = runHook({ background_tasks: [], session_crons: [] });
    expect(output.reason?.startsWith('[RALPH LOOP - ITERATION 2/100]')).toBe(true);
    expect(readState().iteration).toBe(2);
  });

  it('re-injects only an excerpt of a long task and points at the full text', () => {
    const promptFile = join(repo, '.lmgh', 'state', 'sessions', sessionId, 'ralph-prompt.md');
    writeState({ prompt: `${'p'.repeat(3000)} TAILMARK`, prompt_file: promptFile });
    const output = runHook();
    expect(output.reason).toContain('Task (first 1500 of 3009 chars): ');
    expect(output.reason).toContain(`Full task text: ${promptFile}`);
    expect(output.reason).not.toContain('TAILMARK');
  });

  it('lets the turn end without advancing when a subagent is running', () => {
    const checkedAt = writeState();
    const output = runHook({ background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'probe' }] });
    expect(output).toEqual(SAFE_CONTINUE);
    const state = readState();
    expect(state.iteration).toBe(1);
    expect(Date.parse(String(state.last_checked_at))).toBeGreaterThan(Date.parse(checkedAt));
  });

  it('lets the turn end without advancing for a one-shot cron', () => {
    writeState();
    const output = runHook({ session_crons: [{ id: 'c1', schedule: '5 * * * *', recurring: false, prompt: 'wake' }] });
    expect(output).toEqual(SAFE_CONTINUE);
    expect(readState().iteration).toBe(1);
  });

  it('nudges once without advancing when only a shell task is running', () => {
    const checkedAt = writeState();
    const output = runHook({ background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test', command: 'npm test' }] });
    expect(output.decision).toBe('block');
    expect(output.reason?.startsWith('[RALPH LOOP - WAITING] Background work is still running: shell b1 "npm test".')).toBe(true);
    expect(output.reason).not.toContain('Task:');
    const state = readState();
    expect(state.iteration).toBe(1);
    expect(Date.parse(String(state.last_checked_at))).toBeGreaterThan(Date.parse(checkedAt));
  });

  it('does not nudge again once Claude Code is already continuing from a stop hook', () => {
    writeState();
    const output = runHook({
      stop_hook_active: true,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }],
    });
    expect(output).toEqual(SAFE_CONTINUE);
    expect(readState().iteration).toBe(1);
  });

  it('keeps enforcing the loop when only recurring crons or finished tasks are present', () => {
    writeState();
    const output = runHook({
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'completed' }],
      session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check' }],
    });
    expect(output.reason?.startsWith('[RALPH LOOP - ITERATION 2/100]')).toBe(true);
    expect(readState().iteration).toBe(2);
  });

  it('marks the state as waiting on background work for both defer and nudge', () => {
    writeState();
    runHook({ background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] });
    expect(typeof readState().background_wait_at).toBe('string');

    writeState();
    runHook({ background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] });
    expect(typeof readState().background_wait_at).toBe('string');
  });

  describe('staleness', () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    it('stops enforcing a loop that has been quiet for more than two hours', () => {
      const at = hoursAgo(3);
      writeState({ started_at: at, last_checked_at: at });
      expect(runHook()).toEqual(SAFE_CONTINUE);
      expect(readState().iteration).toBe(1);
    });

    it('keeps enforcing after a background wait longer than two hours and clears the wait mark', () => {
      const at = hoursAgo(3);
      writeState({ started_at: at, last_checked_at: at, background_wait_at: at });
      const output = runHook({ background_tasks: [], session_crons: [] });
      expect(output.reason?.startsWith('[RALPH LOOP - ITERATION 2/100]')).toBe(true);
      const state = readState();
      expect(state.iteration).toBe(2);
      expect(state.background_wait_at).toBeUndefined();
    });

    it('stops enforcing after a background wait longer than a day', () => {
      const at = hoursAgo(25);
      writeState({ started_at: at, last_checked_at: at, background_wait_at: at });
      expect(runHook()).toEqual(SAFE_CONTINUE);
      expect(readState().iteration).toBe(1);
    });

    it('ignores an unparseable wait mark', () => {
      const at = hoursAgo(3);
      writeState({ started_at: at, last_checked_at: at, background_wait_at: 'not a date' });
      expect(runHook()).toEqual(SAFE_CONTINUE);
      expect(readState().iteration).toBe(1);
    });
  });
});
