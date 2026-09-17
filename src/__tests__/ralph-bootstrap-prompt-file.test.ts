import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'scripts', 'ralph-bootstrap.mjs');
const LOOP_MODULE = join(REPO_ROOT, 'dist', 'hooks', 'ralph', 'loop.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runBootstrap(args: string[], cwd: string): RunResult {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: undefined,
    LMGH_STATE_DIR: undefined,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  try {
    const stdout = execFileSync(process.execPath, [BOOTSTRAP, ...args], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 30000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

describe('ralph-bootstrap --prompt-file', () => {
  let tempDir: string;
  let repo: string;
  let sessionId: string;
  let sessionDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-prompt-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    sessionId = `prompt-file-test-${Math.random().toString(36).slice(2)}`;
    sessionDir = join(repo, '.lmgh', 'state', 'sessions', sessionId);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  function readState(): { prompt: string; prompt_file?: string } {
    return JSON.parse(readFileSync(join(sessionDir, 'ralph-state.json'), 'utf-8'));
  }

  it('reads the task description from a file and keeps the original text beside the state', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const text = 'Implement feature X\n\nUse "quotes", <angle> `ticks` and $HOME literally --refine-check\n';
    const file = join(tempDir, 'task.md');
    writeFileSync(file, text);

    const result = runBootstrap(['--session-id', sessionId, '--project-dir', repo, '--prompt-file', file], tempDir);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).prompt_source).toBe('file');
    const state = readState();
    expect(state.prompt).toBe('Implement feature X Use "quotes", <angle> `ticks` and $HOME literally --refine-check');
    expect(state.prompt_file).toBe(join(sessionDir, 'ralph-prompt.md'));
    expect(readFileSync(state.prompt_file!, 'utf-8')).toBe(text);
  });

  it('accepts the --prompt-file=<path> form and strips a leading BOM', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const file = join(tempDir, 'bom.md');
    writeFileSync(file, '﻿hello task');

    const result = runBootstrap(['--session-id', sessionId, '--project-dir', repo, `--prompt-file=${file}`], tempDir);

    expect(result.status).toBe(0);
    const state = readState();
    expect(state.prompt).toBe('hello task');
    expect(readFileSync(state.prompt_file!, 'utf-8')).toBe('hello task');
  });

  it('reports argv as the source and still writes the prompt file for a positional description', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = runBootstrap(['--session-id', sessionId, '--project-dir', repo, 'probe', 'task'], tempDir);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).prompt_source).toBe('argv');
    const state = readState();
    expect(state.prompt).toBe('probe task');
    expect(readFileSync(state.prompt_file!, 'utf-8')).toBe('probe task');
  });

  it('fails closed when a positional description is also given', () => {
    const file = join(tempDir, 'task.md');
    writeFileSync(file, 'from file');

    const result = runBootstrap(
      ['--session-id', sessionId, '--project-dir', repo, '--prompt-file', file, 'from argv'],
      tempDir,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--prompt-file');
    expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
  });

  it('fails closed for a missing file, a directory and a blank file', () => {
    const blank = join(tempDir, 'blank.md');
    writeFileSync(blank, ' \n\t\n');

    for (const target of [join(tempDir, 'missing.md'), tempDir, blank]) {
      const result = runBootstrap(['--session-id', sessionId, '--project-dir', repo, '--prompt-file', target], tempDir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--prompt-file');
    }
    expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
  });
});
