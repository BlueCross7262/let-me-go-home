import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as engine from '../../../scripts/lib/stop-control.mjs';
import { stateClearTool, stateListActiveTool, stateReadTool, stateWriteTool } from '../state-tools.js';

let TEST_DIR: string;

vi.mock('../../lib/worktree-paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/worktree-paths.js')>('../../lib/worktree-paths.js');
  return {
    ...actual,
    getLmghRoot: vi.fn((workingDirectory?: string) => join(workingDirectory || process.cwd(), '.lmgh')),
    validateWorkingDirectory: vi.fn((workingDirectory?: string) => workingDirectory || process.cwd()),
    resolveNonGitStateAnchor: vi.fn((workingDirectory?: string) => workingDirectory || process.cwd()),
    resolveStateWorkingDirectory: vi.fn((workingDirectory?: string) => workingDirectory || process.cwd()),
  };
});

const SESSION = 's1';

function sessionFile(name: string): string {
  return join(TEST_DIR, '.lmgh', 'state', 'sessions', SESSION, name);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

async function writeLayer(mode: string, extra: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  return stateWriteTool.handler({
    mode,
    active: true,
    iteration: 0,
    max_iterations: 5,
    state: { owner: 'demo', ...state },
    session_id: SESSION,
    workingDirectory: TEST_DIR,
    ...extra,
  } as never);
}

describe('stop layer state tools', () => {
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(homedir(), 'stop-layer-tools-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = TEST_DIR;
    process.env.USERPROFILE = TEST_DIR;
    mkdirSync(join(TEST_DIR, '.lmgh', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  it('writes a second-layer record the hook validator accepts', async () => {
    const response = await writeLayer('second-stop');
    expect(response.isError).toBeUndefined();
    const record = readJson(sessionFile('second-stop-state.json'));
    expect(record.owner).toBe('demo');
    expect(record.project_path).toBe(TEST_DIR);
    expect(engine.validateRecord(record)).toEqual({ valid: true });
  });

  it('refuses a stop layer write without a session id', async () => {
    const response = await stateWriteTool.handler({ mode: 'second-stop', active: true, iteration: 0, max_iterations: 3, state: { owner: 'demo' }, workingDirectory: TEST_DIR } as never);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('session_id is required');
  });

  it('reports an occupied layer and the free layers', async () => {
    expect((await writeLayer('first-stop')).isError).toBeUndefined();
    const refused = await writeLayer('first-stop', {}, { owner: 'other' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('layer occupied by demo');
    expect(refused.content[0].text).toContain('free layers: second, third');
  });

  it('rejects an invalid native input without writing', async () => {
    const response = await writeLayer('first-stop', { iteration: 1.5 });
    expect(response.isError).toBe(true);
    expect(existsSync(sessionFile('first-stop-state.json'))).toBe(false);
  });

  it('clears a stop layer record by its own mode name', async () => {
    await writeLayer('third-stop');
    const response = await stateClearTool.handler({ mode: 'third-stop', session_id: SESSION, workingDirectory: TEST_DIR } as never);
    expect(response.isError).toBeUndefined();
    expect(existsSync(sessionFile('third-stop-state.json'))).toBe(false);
    const after = await stateReadTool.handler({ mode: 'third-stop', session_id: SESSION, workingDirectory: TEST_DIR } as never);
    expect(after.content[0].text).toContain('No state found');
  });

  it('lists the written layer as an active mode', async () => {
    await writeLayer('second-stop');
    const response = await stateListActiveTool.handler({ workingDirectory: TEST_DIR, session_id: SESSION } as never);
    expect(response.content[0].text).toContain('second-stop');
  });
});

describe('ralph domain state next to its control record', () => {
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(homedir(), 'stop-ralph-tools-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = TEST_DIR;
    process.env.USERPROFILE = TEST_DIR;
    mkdirSync(join(TEST_DIR, '.lmgh', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  async function startWithControl(): Promise<void> {
    const profile = engine.getProfile('ralph');
    await stateWriteTool.handler({
      mode: 'first-stop',
      active: true,
      iteration: 1,
      max_iterations: 100,
      state: { owner: 'ralph', profile: 'ralph', messages: { continue_literal: ['Full task text: old'] } },
      session_id: SESSION,
      workingDirectory: TEST_DIR,
    } as never);
    writeJson(sessionFile('ralph-state.json'), { active: true, iteration: 1, max_iterations: 100, session_id: SESSION, project_path: TEST_DIR, prompt: 'first' });
    expect(profile.owner).toBe('ralph');
  }

  it('leaves the control record untouched when the model rewrites the domain state', async () => {
    await startWithControl();
    const control = readJson(sessionFile('first-stop-state.json'));
    writeJson(sessionFile('first-stop-state.json'), { ...control, iteration: 7, background_wait_at: '2026-10-18T05:00:00.000Z' });
    const response = await stateWriteTool.handler({
      mode: 'ralph',
      active: true,
      iteration: 2,
      max_iterations: 50,
      state: { session_id: SESSION, project_path: TEST_DIR, prompt: 'changed', prompt_file: 'C:/tasks/new.md' },
      session_id: SESSION,
      workingDirectory: TEST_DIR,
    } as never);
    expect(response.isError).toBeUndefined();
    const domain = readJson(sessionFile('ralph-state.json'));
    expect(domain.prompt).toBe('changed');
    const after = readJson(sessionFile('first-stop-state.json'));
    expect(after.iteration).toBe(7);
    expect(after.max_iterations).toBe(100);
    expect(after.background_wait_at).toBe('2026-10-18T05:00:00.000Z');
    expect((after.messages as Record<string, unknown>).continue_literal).toEqual(['Full task text: old']);
    expect(after).toEqual({ ...control, iteration: 7, background_wait_at: '2026-10-18T05:00:00.000Z' });
  });

  it('leaves the control record active when the model writes active=false to the domain state', async () => {
    await startWithControl();
    await stateWriteTool.handler({
      mode: 'ralph',
      active: false,
      iteration: 3,
      state: { session_id: SESSION, project_path: TEST_DIR, prompt: 'first' },
      session_id: SESSION,
      workingDirectory: TEST_DIR,
    } as never);
    const after = readJson(sessionFile('first-stop-state.json'));
    expect(after.active).toBe(true);
    expect(after.iteration).toBe(1);
    expect(readJson(sessionFile('ralph-state.json')).active).toBe(false);
  });

  it('clears the control record together with the domain state', async () => {
    await startWithControl();
    const response = await stateClearTool.handler({ mode: 'ralph', session_id: SESSION, workingDirectory: TEST_DIR } as never);
    expect(response.isError).toBeUndefined();
    expect(existsSync(sessionFile('first-stop-state.json'))).toBe(false);
    expect(existsSync(sessionFile('ralph-state.json'))).toBe(false);
  });

  it('clears the domain state alone when there is no control record', async () => {
    writeJson(sessionFile('ralph-state.json'), { active: true, iteration: 1, max_iterations: 10, session_id: SESSION, project_path: TEST_DIR, prompt: 'plain' });
    const response = await stateClearTool.handler({ mode: 'ralph', session_id: SESSION, workingDirectory: TEST_DIR } as never);
    expect(response.isError).toBeUndefined();
    expect(existsSync(sessionFile('ralph-state.json'))).toBe(false);
  });
});
