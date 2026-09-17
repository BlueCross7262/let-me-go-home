/**
 * Tests for the project directory resolution in scripts/ralph-bootstrap.mjs.
 *
 * The resolved directory becomes the ralph loop state's `project_path`, and
 * scripts/ralph-stop.mjs compares that value against the session cwd with an
 * exact string match. A wrong directory silently disables the Stop hook loop
 * and points the PRD at the wrong repository, so the precedence order and the
 * repository-root normalisation are pinned here.
 *
 * Precedence: --project-dir > CLAUDE_PROJECT_DIR > process.cwd()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync, existsSync } from 'fs';
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

function runBootstrap(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): RunResult {
  const env = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  try {
    const stdout = execFileSync(process.execPath, [BOOTSTRAP, ...args], {
      cwd: options.cwd,
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

function parseDirectory(result: RunResult): { directory: string; source: string } {
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout) as { directory: string; directory_source: string };
  return { directory: parsed.directory, source: parsed.directory_source };
}

function makeRepo(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  execSync('git init --quiet', { cwd: dir, windowsHide: true });
  return realpathSync.native(dir);
}

describe('ralph-bootstrap project directory resolution', () => {
  let tempDir: string;
  let repoA: string;
  let repoB: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repoA = makeRepo(tempDir, 'repo-a');
    repoB = makeRepo(tempDir, 'repo-b');
    sessionId = `bootstrap-test-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('prefers --project-dir over CLAUDE_PROJECT_DIR and cwd', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = runBootstrap(
      ['--session-id', sessionId, '--project-dir', repoA, 'probe task'],
      { cwd: repoB, env: { CLAUDE_PROJECT_DIR: repoB } },
    );
    const { directory, source } = parseDirectory(result);
    expect(directory).toBe(repoA);
    expect(source).toBe('--project-dir');
  });

  it('prefers CLAUDE_PROJECT_DIR over cwd when --project-dir is absent', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = runBootstrap(
      ['--session-id', sessionId, 'probe task'],
      { cwd: repoB, env: { CLAUDE_PROJECT_DIR: repoA } },
    );
    const { directory, source } = parseDirectory(result);
    expect(directory).toBe(repoA);
    expect(source).toBe('CLAUDE_PROJECT_DIR');
  });

  it('falls back to cwd when neither the flag nor the env var is set', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const result = runBootstrap(
      ['--session-id', sessionId, 'probe task'],
      { cwd: repoA, env: { CLAUDE_PROJECT_DIR: undefined } },
    );
    const { directory, source } = parseDirectory(result);
    expect(directory).toBe(repoA);
    expect(source).toBe('cwd');
  });

  it('normalises a subdirectory to the repository root', () => {
    if (!existsSync(LOOP_MODULE)) return;
    const nested = join(repoA, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    const result = runBootstrap(
      ['--session-id', sessionId, '--project-dir', nested, 'probe task'],
      { cwd: repoB, env: { CLAUDE_PROJECT_DIR: repoB } },
    );
    const { directory } = parseDirectory(result);
    expect(directory).toBe(repoA);
  });

  it('fails closed for a missing directory and for a non-git directory', () => {
    const missing = runBootstrap(
      ['--session-id', sessionId, '--project-dir', join(tempDir, 'no-such-dir'), 'probe task'],
      { cwd: repoA },
    );
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('not an existing directory');

    const nonGit = join(tempDir, 'plain');
    mkdirSync(nonGit, { recursive: true });
    const notARepo = runBootstrap(
      ['--session-id', sessionId, '--project-dir', nonGit, 'probe task'],
      { cwd: repoA },
    );
    expect(notARepo.status).not.toBe(0);
    expect(notARepo.stderr).toContain('not inside a git repository');
  });
});
