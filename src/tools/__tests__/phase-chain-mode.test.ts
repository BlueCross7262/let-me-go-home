import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { stateReadTool, stateWriteTool, stateClearTool } from '../state-tools.js';
import { ALL_MODE_NAMES, MODE_STATE_FILE_MAP, SESSION_END_MODE_STATE_FILES } from '../../lib/mode-names.js';
import { MODE_CONFIGS } from '../../hooks/mode-registry/index.js';

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

describe('phase-chain mode registration', () => {
  it('is a registered mode with its own state file', () => {
    expect(ALL_MODE_NAMES).toContain('phase-chain');
    expect(MODE_STATE_FILE_MAP['phase-chain']).toBe('phase-chain-state.json');
    expect(SESSION_END_MODE_STATE_FILES.some((entry) => entry.mode === 'phase-chain' && entry.file === 'phase-chain-state.json')).toBe(true);
    expect(MODE_CONFIGS['phase-chain'].stateFile).toBe('phase-chain-state.json');
    expect(MODE_CONFIGS['phase-chain'].activeProperty).toBe('active');
  });
});

describe('phase-chain state tools', () => {
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(homedir(), 'phase-chain-test-'));
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

  it('writes, reads and clears a session-scoped chain state that keeps a top-level session_id', async () => {
    const sessionId = 'chain-session';
    const path = join(TEST_DIR, '.lmgh', 'state', 'sessions', sessionId, 'phase-chain-state.json');

    await stateWriteTool.handler({
      mode: 'phase-chain',
      active: true,
      max_iterations: 100,
      iteration: 0,
      state: { session_id: sessionId, project_path: TEST_DIR, phase_id: 'p01' },
      session_id: sessionId,
      workingDirectory: TEST_DIR,
    });

    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.active).toBe(true);
    expect(written.session_id).toBe(sessionId);
    expect(written.phase_id).toBe('p01');

    const read = await stateReadTool.handler({ mode: 'phase-chain', session_id: sessionId, workingDirectory: TEST_DIR });
    expect(read.content[0].text).toContain('p01');

    await stateClearTool.handler({ mode: 'phase-chain', session_id: sessionId, workingDirectory: TEST_DIR });
    expect(existsSync(path)).toBe(false);
  });
});
