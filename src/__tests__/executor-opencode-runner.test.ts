import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  utimesSync,
  unlinkSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_USAGE_WAIT_SEC,
  REPORT_LINE_LIMIT,
  shouldSkipRules,
  // @ts-expect-error Script runtime source is intentionally JavaScript-only.
} from '../../scripts/lib/executor-opencode-runner.mjs';
import {
  FIXED_MESSAGE,
  MESSAGE_WITHOUT_RULES,
  // @ts-expect-error Script runtime source is intentionally JavaScript-only.
} from '../../scripts/lib/executor-opencode-argv.mjs';

const ROOT = join(__dirname, '..', '..');
const CLI = join(ROOT, 'scripts', 'executor-opencode-run.mjs');
const RULES = join(ROOT, 'scripts', 'executor-opencode-rules.md').replace(/\\/g, '/');
const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;
const SENTINEL = 'executor-opencode(backend=unavailable): ';
const USAGE_ERROR_LINE =
  'timestamp=2026-10-08T00:00:00.000Z level=ERROR run=x message="stream error" providerID=opencode modelID=m '
  + 'error.error="AI_APICallError: Free usage exceeded"\n';
const USAGE_INFO_LINE =
  'timestamp=2026-10-08T00:00:00.000Z level=INFO run=x message="prompt mentions Free usage exceeded" directory="d"\n';

const FAKE_SOURCE = String.raw`
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const env = process.env;
if (env.FAKE_ARGV_FILE) fs.writeFileSync(env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (env.FAKE_CWD_FILE) fs.writeFileSync(env.FAKE_CWD_FILE, process.cwd());
if (env.FAKE_PWD_FILE) fs.writeFileSync(env.FAKE_PWD_FILE, String(env.PWD));
function out(text) { fs.writeSync(1, text); }
function err(text) { fs.writeSync(2, text); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const edits = JSON.parse(env.FAKE_EDITS || '[]');
for (const edit of edits) {
  const target = path.resolve(process.cwd(), edit.path || '.');
  if (edit.op === 'write') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, edit.text); }
  if (edit.op === 'delete') fs.unlinkSync(target);
  if (edit.op === 'rename') fs.renameSync(target, path.resolve(process.cwd(), edit.to));
  if (edit.op === 'commit') {
    cp.spawnSync('git', ['add', '-A'], { cwd: process.cwd() });
    cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'fake'], { cwd: process.cwd() });
  }
}
const mode = env.FAKE_MODE || 'ok';
const code = Number(env.FAKE_EXIT || 0);
if (env.FAKE_STDERR) err(env.FAKE_STDERR);
if (mode === 'ok') {
  out('\u001b[0m\n> build · fake\n\u001b[0m\n');
  out(env.FAKE_TEXT !== undefined ? env.FAKE_TEXT : '## Changes Made\n- done\n');
}
if (mode === 'lines') {
  const eol = env.FAKE_EOL || '\n';
  const lines = [];
  if (env.FAKE_ANCHOR) lines.push(env.FAKE_ANCHOR);
  for (let i = 1; i <= Number(env.FAKE_N || 0); i += 1) lines.push('L' + i);
  out('\u001b[1mheader noise\u001b[0m' + eol);
  out(lines.join(eol) + (lines.length > 0 && !env.FAKE_NO_TRAILING ? eol : ''));
}
if (mode === 'big') {
  const chunk = 'x'.repeat(1023) + '\n';
  for (let i = 0; i < 8192; i += 1) out(chunk);
  out('## Changes Made\n- big\n');
}
if (mode === 'sleep') {
  if (env.FAKE_GRANDCHILD_PIDFILE) {
    const grand = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' });
    fs.writeFileSync(env.FAKE_GRANDCHILD_PIDFILE, String(grand.pid));
  }
  sleep(Number(env.FAKE_SLEEP_MS || 1000));
  out('## Changes Made\n- slept\n');
}
process.exit(code);
`;

let root = '';
let repo = '';
let configDir = '';
let fakePath = '';
let specFile = '';
const reservedFiles: string[] = [];
const scratchDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

function initRepo(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '.');
  writeFileSync(join(path, 'a.txt'), 'a\n');
  writeFileSync(join(path, 'b.txt'), 'b\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'init');
}

function projectSettings(section: unknown) {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ lmgh: { executorOpencode: section } }));
}

interface RunResult {
  stdout: string;
  status: number | null;
  elapsedMs: number;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}, testMode = true): RunResult {
  const testDefaults: Record<string, string> = testMode
    ? {
        LMGH_OPENCODE_TEST: '1',
        LMGH_OPENCODE_BIN: process.execPath,
        LMGH_OPENCODE_BIN_ARGS: JSON.stringify([fakePath]),
      }
    : {};
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CONFIG_DIR: configDir,
    ...testDefaults,
    ...extraEnv,
  };
  const started = Date.now();
  const run = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const report = /^report_file=(.*)$/m.exec(run.stdout ?? '');
  if (report) scratchDirs.push(dirname(report[1]));
  return { stdout: run.stdout, status: run.status, elapsedMs: Date.now() - started };
}

function runDefault(extraEnv: Record<string, string> = {}, extraArgs: string[] = []): RunResult {
  return runCli(['--spec-file', specFile, '--project-dir', repo, ...extraArgs], extraEnv);
}

function field(output: string, name: string): string | null {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(output);
  return match ? match[1] : null;
}

function outputSection(output: string): string[] {
  const marker = output.indexOf('===OUTPUT===\n');
  return marker === -1 ? [] : output.slice(marker + '===OUTPUT===\n'.length).split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
}

function firstLine(output: string): string {
  return output.split('\n')[0];
}

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'lmgh-eo-fake-'));
  fakePath = join(base, 'fake-opencode.js');
  writeFileSync(fakePath, FAKE_SOURCE);
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lmgh-eo-runner-test-'));
  repo = join(root, 'repo');
  configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  initRepo(repo);
  specFile = join(root, 'spec.md');
  writeFileSync(specFile, 'edit_kind=code\n');
});

afterEach(() => {
  for (const file of reservedFiles.splice(0)) {
    try {
      unlinkSync(file);
    } catch {
      continue;
    }
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)('constants', () => {
  it('exports the default timeout of 1800 seconds and the report line limit of 300', () => {
    expect(DEFAULT_TIMEOUT_SEC).toBe(1800);
    expect(REPORT_LINE_LIMIT).toBe(300);
  });
});

describe.skipIf(!GIT_AVAILABLE)('success path', () => {
  it('starts with the success line and reports git facts, files and the report body', () => {
    const result = runDefault();
    expect(result.status).toBe(0);
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
    expect(field(result.stdout, 'head_before')).toMatch(/^[0-9a-f]{40}$/);
    expect(field(result.stdout, 'head_after')).toBe(field(result.stdout, 'head_before'));
    expect(field(result.stdout, 'tree_before')).toMatch(/^[0-9a-f]{40}$/);
    expect(field(result.stdout, 'tree_after')).toBe(field(result.stdout, 'tree_before'));
    expect(field(result.stdout, 'changed_count')).toBe('0');
    expect(result.stdout).not.toContain('\nchanged:\n');
    expect(field(result.stdout, 'report_anchor')).toBe('found');
    expect(field(result.stdout, 'truncated')).toBe('false');
    expect(existsSync(field(result.stdout, 'output_file')!)).toBe(true);
    expect(existsSync(field(result.stdout, 'stderr_file')!)).toBe(true);
    expect(outputSection(result.stdout)).toEqual(['## Changes Made', '- done']);
  });

  it('passes exactly the expected argv to opencode', () => {
    const argvFile = join(root, 'argv.json');
    runDefault({ FAKE_ARGV_FILE: argvFile });
    const specAbsolute = specFile.replace(/\\/g, '/');
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual([
      'run',
      '--auto',
      '--dir',
      repo.replace(/\\/g, '/'),
      '--print-logs',
      '--log-level',
      'ERROR',
      '--file',
      RULES,
      '--file',
      specAbsolute,
      '--',
      FIXED_MESSAGE,
    ]);
  });

  it('runs opencode with the project directory as its working directory', () => {
    const cwdFile = join(root, 'cwd.txt');
    runDefault({ FAKE_CWD_FILE: cwdFile });
    expect(readFileSync(cwdFile, 'utf8').replace(/\\/g, '/').toLowerCase()).toBe(repo.replace(/\\/g, '/').toLowerCase());
  });

  it('overrides an inherited PWD with the effective directory because opencode follows PWD over the cwd', () => {
    const pwdFile = join(root, 'pwd.txt');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    runDefault({ FAKE_PWD_FILE: pwdFile, PWD: elsewhere });
    expect(readFileSync(pwdFile, 'utf8').replace(/\\/g, '/').toLowerCase()).toBe(repo.replace(/\\/g, '/').toLowerCase());
  });

  it('sets PWD to the settings dir when the settings name one', () => {
    const second = join(root, 'second');
    initRepo(second);
    projectSettings({ dir: second });
    const pwdFile = join(root, 'pwd.txt');
    runDefault({ FAKE_PWD_FILE: pwdFile, PWD: repo });
    expect(readFileSync(pwdFile, 'utf8').replace(/\\/g, '/').toLowerCase()).toBe(second.replace(/\\/g, '/').toLowerCase());
  });

  it('strips ANSI escape sequences from the report body', () => {
    const result = runDefault({ FAKE_MODE: 'lines', FAKE_N: '2', FAKE_ANCHOR: '## Changes Made' });
    expect(result.stdout).not.toContain('\u001b');
    expect(outputSection(result.stdout)).toEqual(['## Changes Made', 'L1', 'L2']);
  });

  it('copies stderr bytes into the stderr file on success', () => {
    const result = runDefault({ FAKE_STDERR: 'warning from fake\n' });
    expect(readFileSync(field(result.stdout, 'stderr_file')!, 'utf8')).toBe('warning from fake\n');
  });

  it('writes the full runner output to the report file byte for byte', () => {
    const result = runDefault();
    expect(readFileSync(field(result.stdout, 'report_file')!, 'utf8')).toBe(result.stdout);
  });

  it('reports a change count of zero without a changed list for a run that edits nothing', () => {
    const result = runDefault({ FAKE_TEXT: '## Changes Made\n- nothing\n' });
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
    expect(field(result.stdout, 'changed_count')).toBe('0');
  });

  it('shows an edit of an already modified file', () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty already\n');
    const result = runDefault({ FAKE_EDITS: JSON.stringify([{ op: 'write', path: 'a.txt', text: 'edited again\n' }]) });
    expect(field(result.stdout, 'changed_count')).toBe('1');
    expect(result.stdout).toContain('changed:\nM\ta.txt\n');
  });

  it('shows added, deleted and renamed files and a changed head after a commit', () => {
    const edits = [
      { op: 'write', path: 'new.txt', text: 'n\n' },
      { op: 'delete', path: 'a.txt' },
      { op: 'rename', path: 'b.txt', to: 'c.txt' },
      { op: 'commit' },
    ];
    const result = runDefault({ FAKE_EDITS: JSON.stringify(edits) });
    expect(field(result.stdout, 'head_after')).not.toBe(field(result.stdout, 'head_before'));
    expect(field(result.stdout, 'changed_count')).toBe('3');
    expect(result.stdout).toContain('A\tnew.txt');
    expect(result.stdout).toContain('D\ta.txt');
    expect(result.stdout).toContain('R100\tb.txt\tc.txt');
  });

  it('keeps the success line and lists a file that opencode added', () => {
    const result = runDefault({ FAKE_EDITS: JSON.stringify([{ op: 'write', path: 'z.txt', text: 'z\n' }]) });
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
    expect(result.stdout).toContain('A\tz.txt');
  });
});

describe.skipIf(!GIT_AVAILABLE)('failure sentinels', () => {
  it('reports exit=1 with the changes made before the failure and both output tails', () => {
    const result = runDefault({
      FAKE_EXIT: '1',
      FAKE_STDERR: 'boom from stderr\n',
      FAKE_TEXT: 'partial stdout line\n',
      FAKE_EDITS: JSON.stringify([{ op: 'write', path: 'partial.txt', text: 'p\n' }]),
    });
    expect(result.status).toBe(0);
    expect(firstLine(result.stdout)).toBe(`${SENTINEL}exit=1 opencode exited with status 1`);
    expect(field(result.stdout, 'changed_count')).toBe('1');
    expect(result.stdout).toContain('A\tpartial.txt');
    expect(result.stdout).toContain('===STDERR_TAIL===\nboom from stderr');
    expect(result.stdout).toContain('===STDOUT_TAIL===');
    expect(result.stdout).toContain('partial stdout line');
  });

  it('reports exec-not-found when opencode is not on PATH', () => {
    const result = runCli(['--spec-file', specFile, '--project-dir', repo], { PATH: '', Path: '' }, false);
    expect(firstLine(result.stdout)).toBe(`${SENTINEL}exec-not-found opencode was not found on PATH`);
  });

  it('reports path-resolution when the spec file does not exist', () => {
    const result = runCli(['--spec-file', join(root, 'missing.md'), '--project-dir', repo]);
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}path-resolution `)).toBe(true);
  });

  it('reports path-resolution when the project directory does not exist', () => {
    const result = runCli(['--spec-file', specFile, '--project-dir', join(root, 'nowhere')]);
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}path-resolution `)).toBe(true);
  });

  it('reports path-resolution when the settings dir does not exist', () => {
    projectSettings({ dir: join(root, 'no-such-dir') });
    const result = runDefault();
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}path-resolution `)).toBe(true);
  });

  it.each([['0'], ['-5'], ['abc'], ['1.5'], ['']])('reports arg-invalid for --timeout-sec %j', (value) => {
    const result = runCli(['--spec-file', specFile, '--project-dir', repo, '--timeout-sec', value]);
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}arg-invalid `)).toBe(true);
  });

  it('reports arg-invalid when --spec-file is missing', () => {
    const result = runCli(['--project-dir', repo]);
    expect(firstLine(result.stdout)).toBe(`${SENTINEL}arg-invalid --spec-file is required`);
  });

  it('reports arg-invalid when --project-dir is missing', () => {
    const result = runCli(['--spec-file', specFile]);
    expect(firstLine(result.stdout)).toBe(`${SENTINEL}arg-invalid --project-dir is required`);
  });

  it('reports arg-invalid for a malformed argument prefix of the injected binary', () => {
    const result = runDefault({ LMGH_OPENCODE_BIN_ARGS: 'not json' });
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}arg-invalid `)).toBe(true);
  });

  it('reports spawn-error when the executable cannot be started', () => {
    const result = runDefault({ LMGH_OPENCODE_BIN: join(root, 'does-not-exist.exe') });
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}spawn-error `)).toBe(true);
  });

  it('keeps the seven sentinel classes distinct', () => {
    const classes = new Set<string>();
    const cases: RunResult[] = [
      runDefault({ FAKE_EXIT: '1' }),
      runCli(['--spec-file', specFile, '--project-dir', repo], { PATH: '', Path: '' }, false),
      runCli(['--spec-file', join(root, 'missing.md'), '--project-dir', repo]),
      runCli(['--project-dir', repo]),
      runDefault({ LMGH_OPENCODE_BIN: join(root, 'does-not-exist.exe') }),
      runDefault({ FAKE_MODE: 'sleep', FAKE_SLEEP_MS: '30000' }, ['--timeout-sec', '1']),
      runDefault({ FAKE_EXIT: '1', FAKE_STDERR: USAGE_ERROR_LINE }),
    ];
    for (const result of cases) {
      const match = /^executor-opencode\(backend=unavailable\): (\S+) /.exec(firstLine(result.stdout));
      expect(match).not.toBeNull();
      classes.add(match![1].replace(/=\d+$/, '=<n>'));
    }
    expect([...classes].sort()).toEqual([
      'arg-invalid',
      'exec-not-found',
      'exit=<n>',
      'path-resolution',
      'spawn-error',
      'timeout',
      'usage-exceeded',
    ]);
  });
});

describe.skipIf(!GIT_AVAILABLE)('time limit', () => {
  it('lets a fast run finish under a generous limit', () => {
    const result = runDefault({ FAKE_MODE: 'sleep', FAKE_SLEEP_MS: '1000' }, ['--timeout-sec', '20']);
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
  });

  it('ends a slow run with the timeout class between the limit and a margin, and kills a grandchild holding the output', () => {
    const pidFile = join(root, 'grand.pid');
    const result = runDefault(
      { FAKE_MODE: 'sleep', FAKE_SLEEP_MS: '60000', FAKE_GRANDCHILD_PIDFILE: pidFile },
      ['--timeout-sec', '2'],
    );
    expect(firstLine(result.stdout)).toBe(`${SENTINEL}timeout opencode did not finish within 2 seconds`);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(result.elapsedMs).toBeLessThanOrEqual(8000);
    const grandPid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(grandPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('writes the child pid file next to the output files', () => {
    const result = runDefault();
    const outputFile = field(result.stdout, 'output_file')!;
    expect(existsSync(join(outputFile, '..', 'child.pid'))).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('usage limit', () => {
  it('kills a run that stays unfinished after the first usage error line and reports usage-exceeded', () => {
    const pidFile = join(root, 'grand.pid');
    const result = runDefault(
      { FAKE_MODE: 'sleep', FAKE_SLEEP_MS: '60000', FAKE_STDERR: USAGE_ERROR_LINE, FAKE_GRANDCHILD_PIDFILE: pidFile },
      ['--usage-wait-sec', '1'],
    );
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}usage-exceeded `)).toBe(true);
    expect(firstLine(result.stdout)).toContain('within 1 seconds');
    expect(field(result.stdout, 'head_before')).not.toBeNull();
    expect(field(result.stdout, 'changed_count')).toBe('0');
    expect(result.stdout).toContain('===STDERR_TAIL===');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(result.elapsedMs).toBeLessThanOrEqual(9000);
    const grandPid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(grandPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('lists files the killed run changed', () => {
    const result = runDefault(
      {
        FAKE_MODE: 'sleep',
        FAKE_SLEEP_MS: '60000',
        FAKE_STDERR: USAGE_ERROR_LINE,
        FAKE_EDITS: JSON.stringify([{ op: 'write', path: 'new.txt', text: 'n\n' }]),
      },
      ['--usage-wait-sec', '1'],
    );
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}usage-exceeded `)).toBe(true);
    expect(field(result.stdout, 'changed_count')).toBe('1');
    expect(result.stdout).toContain('A\tnew.txt');
  });

  it('reports usage-exceeded when the run ends by itself with a non-zero code and a usage error line', () => {
    const result = runDefault({ FAKE_EXIT: '1', FAKE_STDERR: USAGE_ERROR_LINE });
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}usage-exceeded `)).toBe(true);
    expect(result.elapsedMs).toBeLessThanOrEqual(9000);
  });

  it('keeps exit=N for a failure whose error log has no usage phrase', () => {
    const line = USAGE_ERROR_LINE.replace('Free usage exceeded', 'Unexpected server error');
    const result = runDefault({ FAKE_EXIT: '1', FAKE_STDERR: line });
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}exit=1 `)).toBe(true);
  });

  it('does not treat the phrase on a non-error log line as a usage error', () => {
    const result = runDefault(
      { FAKE_MODE: 'sleep', FAKE_SLEEP_MS: '3000', FAKE_STDERR: USAGE_INFO_LINE },
      ['--usage-wait-sec', '1'],
    );
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
  });

  it('does not treat the phrase on a non-error log line as a usage error after a non-zero exit', () => {
    const result = runDefault({ FAKE_EXIT: '1', FAKE_STDERR: USAGE_INFO_LINE });
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}exit=1 `)).toBe(true);
  });

  it('lets a run finish when it ends inside the wait', () => {
    const result = runDefault(
      { FAKE_MODE: 'sleep', FAKE_SLEEP_MS: '1000', FAKE_STDERR: USAGE_ERROR_LINE },
      ['--usage-wait-sec', '30'],
    );
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
  });

  it('does not stop a run with no usage error line however long it takes', () => {
    const result = runDefault({ FAKE_MODE: 'sleep', FAKE_SLEEP_MS: '2500' }, ['--usage-wait-sec', '1']);
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
  });

  it.each([['0'], ['-5'], ['abc'], ['1.5'], ['']])('reports arg-invalid for --usage-wait-sec %j', (value) => {
    const result = runCli(['--spec-file', specFile, '--project-dir', repo, '--usage-wait-sec', value]);
    expect(firstLine(result.stdout).startsWith(`${SENTINEL}arg-invalid `)).toBe(true);
  });

  it('waits 60 seconds by default', () => {
    expect(DEFAULT_USAGE_WAIT_SEC).toBe(60);
  });
});

describe.skipIf(!GIT_AVAILABLE)('report extraction', () => {
  it.each([0, 1, 299, 300, 301, 1000])('keeps the last 300 lines of %i lines when there is no anchor', (count) => {
    const result = runDefault({ FAKE_MODE: 'lines', FAKE_N: String(count) });
    const section = outputSection(result.stdout);
    const noise = 1;
    const total = count + noise;
    const expectedCount = Math.min(total, 300);
    expect(section).toHaveLength(expectedCount);
    expect(field(result.stdout, 'report_anchor')).toBe('missing');
    expect(field(result.stdout, 'truncated')).toBe(total > 300 ? 'true' : 'false');
    if (count > 0) expect(section[section.length - 1]).toBe(`L${count}`);
  });

  it.each([298, 299, 300, 1000])('keeps the first 300 lines from the anchor for %i lines after it', (count) => {
    const result = runDefault({ FAKE_MODE: 'lines', FAKE_N: String(count), FAKE_ANCHOR: '## Changes Made' });
    const section = outputSection(result.stdout);
    const total = count + 1;
    expect(section).toHaveLength(Math.min(total, 300));
    expect(section[0]).toBe('## Changes Made');
    expect(field(result.stdout, 'report_anchor')).toBe('found');
    expect(field(result.stdout, 'truncated')).toBe(total > 300 ? 'true' : 'false');
    if (total > 300) expect(section[299]).toBe('L299');
  });

  it('finds a BLOCKED anchor and drops what precedes it', () => {
    const result = runDefault({
      FAKE_MODE: 'ok',
      FAKE_TEXT: 'thinking aloud\nBLOCKED: design decision required\nCause:\n- x\n',
    });
    expect(outputSection(result.stdout)).toEqual(['BLOCKED: design decision required', 'Cause:', '- x']);
  });

  it('handles CRLF line ends and a missing trailing newline', () => {
    const crlf = runDefault({ FAKE_MODE: 'lines', FAKE_N: '3', FAKE_ANCHOR: '## Changes Made', FAKE_EOL: '\r\n' });
    expect(outputSection(crlf.stdout)).toEqual(['## Changes Made', 'L1', 'L2', 'L3']);
    const bare = runDefault({ FAKE_MODE: 'lines', FAKE_N: '3', FAKE_ANCHOR: '## Changes Made', FAKE_NO_TRAILING: '1' });
    expect(outputSection(bare.stdout)).toEqual(['## Changes Made', 'L1', 'L2', 'L3']);
  });

  it('survives an 8 MB output and keeps the whole text in the output file', () => {
    const result = runDefault({ FAKE_MODE: 'big' });
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
    expect(statSync(field(result.stdout, 'output_file')!).size).toBeGreaterThan(8 * 1024 * 1024);
    expect(outputSection(result.stdout)).toEqual(['## Changes Made', '- big']);
  });
});

describe.skipIf(!GIT_AVAILABLE)('settings integration', () => {
  it('passes model, variant and a single file string from the project settings', () => {
    projectSettings({ model: 'opencode/big-pickle', variant: 'high', file: 'docs/extra.md' });
    const argvFile = join(root, 'argv.json');
    const result = runDefault({ FAKE_ARGV_FILE: argvFile });
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
    const specAbsolute = specFile.replace(/\\/g, '/');
    const repoAbsolute = repo.replace(/\\/g, '/');
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual([
      'run',
      '--auto',
      '--dir',
      repoAbsolute,
      '--print-logs',
      '--log-level',
      'ERROR',
      '--model',
      'opencode/big-pickle',
      '--variant',
      'high',
      '--file',
      RULES,
      '--file',
      specAbsolute,
      '--file',
      `${repoAbsolute}/docs/extra.md`,
      '--',
      FIXED_MESSAGE,
    ]);
  });

  it('prints settings warnings', () => {
    projectSettings({ model: 'no-slash', bogus: 1 });
    const result = runDefault();
    expect(result.stdout).toContain('settings_warning=project: invalid model');
    expect(result.stdout).toContain('settings_warning=project: unknown key bogus');
  });

  it('runs in the dir from the settings and snapshots that directory, not the project directory', () => {
    const second = join(root, 'second');
    initRepo(second);
    projectSettings({ dir: second });
    const cwdFile = join(root, 'cwd.txt');
    const argvFile = join(root, 'argv.json');
    const result = runDefault({
      FAKE_CWD_FILE: cwdFile,
      FAKE_ARGV_FILE: argvFile,
      FAKE_EDITS: JSON.stringify([{ op: 'write', path: 'edited-in-second.txt', text: 's\n' }]),
    });
    expect(readFileSync(cwdFile, 'utf8').replace(/\\/g, '/').toLowerCase()).toBe(second.replace(/\\/g, '/').toLowerCase());
    expect(field(result.stdout, 'effective_dir')?.toLowerCase()).toBe(second.replace(/\\/g, '/').toLowerCase());
    expect(field(result.stdout, 'changed_count')).toBe('1');
    expect(result.stdout).toContain('A\tedited-in-second.txt');
    expect(existsSync(join(repo, 'edited-in-second.txt'))).toBe(false);
    expect(JSON.parse(readFileSync(argvFile, 'utf8')).slice(0, 4)).toEqual(['run', '--auto', '--dir', second.replace(/\\/g, '/')]);
  });

  it('omits the rules file only when both test variables are set', () => {
    const argvFile = join(root, 'argv.json');
    runDefault({ FAKE_ARGV_FILE: argvFile, LMGH_OPENCODE_SKIP_RULES: '1' });
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual([
      'run',
      '--auto',
      '--dir',
      repo.replace(/\\/g, '/'),
      '--print-logs',
      '--log-level',
      'ERROR',
      '--file',
      specFile.replace(/\\/g, '/'),
      '--',
      MESSAGE_WITHOUT_RULES,
    ]);
  });

  it('honors the skip variable only when the test flag is 1', () => {
    expect(shouldSkipRules({ LMGH_OPENCODE_TEST: '1', LMGH_OPENCODE_SKIP_RULES: '1' })).toBe(true);
    expect(shouldSkipRules({ LMGH_OPENCODE_SKIP_RULES: '1' })).toBe(false);
    expect(shouldSkipRules({ LMGH_OPENCODE_TEST: '0', LMGH_OPENCODE_SKIP_RULES: '1' })).toBe(false);
    expect(shouldSkipRules({ LMGH_OPENCODE_TEST: '1' })).toBe(false);
    expect(shouldSkipRules({})).toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)('snapshot failures', () => {
  it('reports git unavailable for a project directory that is not a repository and still returns the run', () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    const result = runCli(['--spec-file', specFile, '--project-dir', plain]);
    expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
    expect(result.stdout).toContain('git=unavailable');
    expect(field(result.stdout, 'changed_count')).toBe('unknown');
    expect(result.stdout).toContain('changed: unavailable');
    expect(outputSection(result.stdout)).toEqual(['## Changes Made', '- done']);
  });

  it.skipIf(process.platform !== 'win32')(
    'reports snapshot=failed for a reserved device name file and keeps the run result',
    () => {
      const reserved = join(repo, 'nul');
      writeFileSync(`\\\\?\\${reserved}`, 'x\n');
      reservedFiles.push(reserved);
      const result = runDefault();
      expect(firstLine(result.stdout)).toBe('executor-opencode: exit=0');
      expect(result.stdout).toMatch(/^snapshot=failed\(.+\)$/m);
      expect(field(result.stdout, 'changed_count')).toBe('unknown');
      expect(result.stdout).toContain('changed: unavailable');
      expect(result.stdout).not.toMatch(/^tree_before=/m);
      expect(outputSection(result.stdout)).toEqual(['## Changes Made', '- done']);
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('scratch directory hygiene', () => {
  it('removes scratch directories older than seven days and keeps recent ones', () => {
    const old = mkdtempSync(join(tmpdir(), 'lmgh-eo-run-'));
    const recent = mkdtempSync(join(tmpdir(), 'lmgh-eo-run-'));
    const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(old, eightDays, eightDays);
    try {
      runDefault();
      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
    } finally {
      rmSync(old, { recursive: true, force: true });
      rmSync(recent, { recursive: true, force: true });
    }
  });
});
