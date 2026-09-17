import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { ralphPointer } from '../../scripts/lib/checkpoint.mjs';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SESSION_START = join(REPO_ROOT, 'scripts', 'workflow-session-start.mjs');
const COMPACT_CHECKPOINT = join(REPO_ROOT, 'scripts', 'compact-checkpoint.mjs');
const LONG_PROMPT = `${'p'.repeat(3000)} TAILMARK`;

describe('long task re-injection outside the Stop hook', () => {
  let tempDir: string;
  let repo: string;
  let sessionId: string;
  let stateDir: string;
  let sessionDir: string;
  let promptFile: string;

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

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-reinject-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    sessionId = `reinject-test-${Math.random().toString(36).slice(2)}`;
    stateDir = join(repo, '.lmgh', 'state');
    sessionDir = join(stateDir, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    promptFile = join(sessionDir, 'ralph-prompt.md');
    writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({
      active: true,
      iteration: 3,
      max_iterations: 100,
      started_at: new Date().toISOString(),
      prompt: LONG_PROMPT,
      prompt_file: promptFile,
      session_id: sessionId,
      project_path: repo,
    }));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  it('carries the prompt file path in the checkpoint pointer', () => {
    const pointer = ralphPointer(stateDir, sessionId);
    expect(pointer.prompt).toBe(LONG_PROMPT);
    expect(pointer.prompt_file).toBe(promptFile);
  });

  it('injects only an excerpt when a Ralph session starts again', () => {
    const result = spawnSync(process.execPath, [SESSION_START], {
      cwd: repo,
      env: cleanEnv(),
      input: JSON.stringify({ session_id: sessionId, cwd: repo, source: 'resume' }),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    const context: string = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext;
    expect(context).toContain('Task (first 1500 of 3009 chars): ');
    expect(context).toContain(`Full task text: ${promptFile}`);
    expect(context).not.toContain('TAILMARK');
  });

  it('injects only an excerpt when replaying a compaction checkpoint', () => {
    writeFileSync(join(sessionDir, 'precompact-checkpoint.json'), JSON.stringify({
      session_id: sessionId,
      written_at: new Date().toISOString(),
      ralph: { active: true, iteration: 3, max_iterations: 100, prompt: LONG_PROMPT, prompt_file: promptFile },
      deep_interview: null,
    }));
    writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: false }));
    const result = spawnSync(process.execPath, [SESSION_START], {
      cwd: repo,
      env: cleanEnv(),
      input: JSON.stringify({ session_id: sessionId, cwd: repo, source: 'compact' }),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    const context: string = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext;
    expect(context).toContain('[PRE-COMPACT CHECKPOINT]');
    expect(context).toContain(`Full task text: ${promptFile}`);
    expect(context).not.toContain('TAILMARK');
  });

  it('reports only an excerpt from the manual compact checkpoint', () => {
    const result = spawnSync(process.execPath, [COMPACT_CHECKPOINT, '--session-id', sessionId, '--directory', repo], {
      cwd: repo,
      env: cleanEnv(),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('  Task (first 1500 of 3009 chars): ');
    expect(result.stdout).toContain(`  Full task text: ${promptFile}`);
    expect(result.stdout).not.toContain('TAILMARK');
  });
});
