import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { buildCheckpoint, phaseChainPointer } from '../../scripts/lib/checkpoint.mjs';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SESSION_START = join(REPO_ROOT, 'scripts', 'workflow-session-start.mjs');
const PRE_COMPACT = join(REPO_ROOT, 'scripts', 'workflow-pre-compact.mjs');

describe('phase-chain pointer across session start and compaction', () => {
  let tempDir: string;
  let repo: string;
  let sessionId: string;
  let stateDir: string;
  let sessionDir: string;
  let chainStatePath: string;
  let skillPath: string;

  function cleanEnv(): NodeJS.ProcessEnv {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      CLAUDE_PLUGIN_ROOT: undefined,
      CLAUDE_PROJECT_DIR: undefined,
      LMGH_STATE_DIR: undefined,
      DISABLE_LMGH: undefined,
      LMGH_SKIP_HOOKS: undefined,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete env[key];
    }
    return env as NodeJS.ProcessEnv;
  }

  function writeChain(overrides: Record<string, unknown> = {}): void {
    writeFileSync(join(sessionDir, 'phase-chain-state.json'), JSON.stringify({
      active: true,
      iteration: 0,
      max_iterations: 100,
      session_id: sessionId,
      project_path: repo,
      chain_state_path: chainStatePath,
      skill_path: skillPath,
      executor_skill_path: join(tempDir, 'phase-exec', 'SKILL.md'),
      phase_id: 'p02',
      last_checked_at: new Date().toISOString(),
      ...overrides,
    }));
  }

  function run(script: string, input: Record<string, unknown>) {
    return spawnSync(process.execPath, [script], {
      cwd: repo,
      env: cleanEnv(),
      input: JSON.stringify(input),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
  }

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    sessionId = `chain-test-${Math.random().toString(36).slice(2)}`;
    stateDir = join(repo, '.lmgh', 'state');
    sessionDir = join(stateDir, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    chainStatePath = join(repo, 'phase-loop.state.json');
    skillPath = join(tempDir, 'phase-loop', 'SKILL.md');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  it('points at the chain files for an active chain in this session', () => {
    writeChain();
    expect(phaseChainPointer(stateDir, sessionId)).toEqual({
      active: true,
      phase_id: 'p02',
      chain_state_path: chainStatePath,
      skill_path: skillPath,
    });
  });

  it('returns no pointer for an inactive chain or one owned by another session', () => {
    writeChain({ active: false });
    expect(phaseChainPointer(stateDir, sessionId)).toBeNull();
    writeChain({ session_id: 'someone-else' });
    expect(phaseChainPointer(stateDir, sessionId)).toBeNull();
  });

  it('carries the chain pointer in the checkpoint', () => {
    writeChain();
    expect(buildCheckpoint(stateDir, sessionId).phase_chain.chain_state_path).toBe(chainStatePath);
  });

  it('injects an active-chain block with the re-entry files and the exit command', () => {
    writeChain();
    const result = run(SESSION_START, { session_id: sessionId, cwd: repo, source: 'resume' });
    expect(result.status).toBe(0);
    const context: string = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext;
    expect(context).toContain('[PHASE-CHAIN ACTIVE]');
    expect(context).toContain(chainStatePath);
    expect(context).toContain(skillPath);
    expect(context).toContain('/let-me-go-home:cancel --chain');
  });

  it('writes a checkpoint when only the chain is in flight and replays it after compaction', () => {
    writeChain();
    const pre = run(PRE_COMPACT, { session_id: sessionId, cwd: repo });
    expect(pre.status).toBe(0);
    const checkpointPath = join(sessionDir, 'precompact-checkpoint.json');
    expect(existsSync(checkpointPath)).toBe(true);
    expect(JSON.parse(readFileSync(checkpointPath, 'utf-8')).phase_chain.phase_id).toBe('p02');

    const start = run(SESSION_START, { session_id: sessionId, cwd: repo, source: 'compact' });
    const context: string = JSON.parse(start.stdout.trim()).hookSpecificOutput.additionalContext;
    expect(context).toContain('Phase chain was active at phase p02');
  });
});
