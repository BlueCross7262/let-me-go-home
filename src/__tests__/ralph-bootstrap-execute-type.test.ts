import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'scripts', 'ralph-bootstrap.mjs');
const RECOVERY = join(REPO_ROOT, 'scripts', 'ralph-execute-type.mjs');
const LOOP_MODULE = join(REPO_ROOT, 'dist', 'hooks', 'ralph', 'loop.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[], cwd: string, configDir: string): RunResult {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: undefined,
    LMGH_STATE_DIR: undefined,
    CLAUDE_CONFIG_DIR: configDir,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
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

describe('ralph-bootstrap --execute-type', () => {
  let tempDir: string;
  let repo: string;
  let configDir: string;
  let sessionId: string;
  let stateFile: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-execute-type-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    configDir = join(tempDir, 'config');
    mkdirSync(repo, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    sessionId = `execute-type-test-${Math.random().toString(36).slice(2)}`;
    stateFile = join(repo, '.lmgh', 'state', 'sessions', sessionId, 'ralph-state.json');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  function bootstrap(args: string[]): RunResult {
    return run(BOOTSTRAP, ['--session-id', sessionId, '--project-dir', repo, ...args], repo, configDir);
  }

  function projectSettings(body: unknown) {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(body));
  }

  it('defaults to main and records the effective type in the progress file', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = bootstrap(['Implement feature X']);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.execute_type).toBe('main');
    expect(summary.execute_type_effective).toBe('main');
    expect(summary.execute_type_reason).toBeNull();
    expect(summary.settings_warnings).toEqual([]);
    expect(typeof summary.progress_file).toBe('string');
    const lines = readFileSync(summary.progress_file, 'utf-8').split('\n');
    expect(lines).toContain(`execute-type: main session=${sessionId}`);
  });

  it('replaces executor-opencode with executor when no setting exists', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = bootstrap(['--execute-type=executor-opencode', 'Implement feature X']);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.execute_type).toBe('executor-opencode');
    expect(summary.execute_type_effective).toBe('executor');
    expect(summary.execute_type_reason).toContain('(default)');
  });

  it('keeps executor-opencode when the project setting is true', () => {
    if (!existsSync(LOOP_MODULE)) return;
    projectSettings({ lmgh: { ralph: { 'use-executor-opencode': true } } });
    const result = bootstrap(['--execute-type=executor-opencode', 'Implement feature X']);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.execute_type).toBe('executor-opencode');
    expect(summary.execute_type_effective).toBe('executor-opencode');
    const lines = readFileSync(summary.progress_file, 'utf-8').split('\n');
    expect(lines).toContain(`execute-type: executor-opencode session=${sessionId}`);
  });

  it('replaces executor-opencode with executor when the project setting is false', () => {
    if (!existsSync(LOOP_MODULE)) return;
    projectSettings({ lmgh: { ralph: { 'use-executor-opencode': false } } });
    const result = bootstrap(['--execute-type=executor-opencode', 'Implement feature X']);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.execute_type).toBe('executor-opencode');
    expect(summary.execute_type_effective).toBe('executor');
    expect(summary.execute_type_reason).toContain('use-executor-opencode=false');
    const lines = readFileSync(summary.progress_file, 'utf-8').split('\n');
    expect(lines).toContain(`execute-type: executor session=${sessionId}`);
  });

  it('keeps the flag in the stored prompt', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = bootstrap(['--execute-type=executor', 'Implement feature X']);
    expect(result.status).toBe(0);
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as { prompt: string };
    expect(state.prompt).toContain('--execute-type=executor');
  });

  it('fails closed on an invalid value without writing loop state', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = bootstrap(['--execute-type=fork', 'Implement feature X']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RALPH BOOTSTRAP FAILED');
    expect(result.stderr).toContain('fork');
    expect(existsSync(stateFile)).toBe(false);
  });

  it('fails closed when the flag follows the task description', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = bootstrap(['Implement feature X', '--execute-type=executor']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must precede');
    expect(existsSync(stateFile)).toBe(false);
  });

  it('reads the flag from the first line of a prompt file', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const file = join(tempDir, 'task.md');
    writeFileSync(file, '--execute-type=executor\nImplement feature X\n');
    const result = bootstrap(['--prompt-file', file]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).execute_type_effective).toBe('executor');
  });

  it('ignores a flag mentioned in the body of a prompt file', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const file = join(tempDir, 'task.md');
    writeFileSync(file, 'Implement feature X\n- --execute-type=executor is documented here\n');
    const result = bootstrap(['--prompt-file', file]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).execute_type_effective).toBe('main');
  });

  it('surfaces settings warnings in the summary', () => {
    if (!existsSync(LOOP_MODULE)) return;
    projectSettings({ lmgh: { ralph: { 'use-executor-opencode': 'false' } } });
    const result = bootstrap(['Implement feature X']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).settings_warnings).toEqual(['project: invalid use-executor-opencode']);
  });
});

describe('ralph-execute-type recovery script', () => {
  let tempDir: string;
  let configDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-execute-type-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    configDir = join(tempDir, 'config');
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  it('resolves the same fields from a stored prompt file', () => {
    const file = join(tempDir, 'ralph-prompt.md');
    writeFileSync(file, '--execute-type=executor-opencode\nImplement feature X\n');
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(join(tempDir, '.claude', 'settings.json'), JSON.stringify({ lmgh: { ralph: { 'use-executor-opencode': false } } }));
    const result = run(RECOVERY, ['--project-dir', tempDir, '--prompt-file', file], tempDir, configDir);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.execute_type).toBe('executor-opencode');
    expect(report.execute_type_effective).toBe('executor');
  });

  it('exits non-zero on an invalid flag', () => {
    const file = join(tempDir, 'ralph-prompt.md');
    writeFileSync(file, '--execute-type=fork\nImplement feature X\n');
    const result = run(RECOVERY, ['--project-dir', tempDir, '--prompt-file', file], tempDir, configDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fork');
  });

  it('exits non-zero without a prompt file', () => {
    const result = run(RECOVERY, ['--project-dir', tempDir], tempDir, configDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--prompt-file is required');
  });
});
