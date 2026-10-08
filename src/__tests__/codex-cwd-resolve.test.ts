import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join, parse } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { resolve } from '../../scripts/codex-cwd-resolve.cjs';

interface GoldenCase {
  name: string;
  platform?: string;
  inputs: string[];
  session_cwd?: string;
  include_session_cwd?: boolean;
  expect: { ok: boolean; cwd: string | null; reason: string; inputs: string[] };
}

const CLI = join(__dirname, '..', '..', 'scripts', 'codex-cwd-resolve.cjs');
const GOLDEN: GoldenCase[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'codex-cwd-resolve.golden.json'), 'utf8'),
);

let root = '';
let rootSlash = '';
let drive = '';
let otherDrive = '';

function fill(text: string): string {
  return text
    .replace(/<ROOT_UPPER>/g, rootSlash.toUpperCase())
    .replace(/<ROOT>/g, rootSlash)
    .replace(/<OTHER_DRIVE>/g, otherDrive)
    .replace(/<DRIVE>/g, drive);
}

function runCli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cwdgolden'));
  rootSlash = root.replace(/\\/g, '/');
  mkdirSync(join(root, 'a', 'rs', '.git', 'jira_works', 'T'), { recursive: true });
  mkdirSync(join(root, 'a', 'rs-wt', 'feature-T', '.lmgh', 'lite-run-inputs'), { recursive: true });
  drive = parse(root).root.replace(/[\\/]+$/, '');
  otherDrive = drive.toUpperCase() === 'Q:' ? 'R:' : 'Q:';
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolve against the golden cases', () => {
  for (const c of GOLDEN) {
    const run = c.platform && c.platform !== process.platform ? it.skip : it;
    run(c.name, () => {
      const result = resolve({
        inputs: c.inputs.map(fill),
        sessionCwd: c.session_cwd ? fill(c.session_cwd) : undefined,
        includeSessionCwd: c.include_session_cwd === true,
      });
      expect(result.ok).toBe(c.expect.ok);
      expect(result.cwd).toBe(c.expect.cwd === null ? null : fill(c.expect.cwd));
      expect(result.reason).toBe(fill(c.expect.reason));
      expect(result.inputs).toEqual(c.expect.inputs.map(fill));
    });
  }
});

describe('command line', () => {
  it('prints one JSON line and exits 0 for repeated --input', () => {
    const a = `${rootSlash}/a/rs/.git/jira_works/T/a.md`;
    const b = `${rootSlash}/a/rs/.git/jira_works/T/b.md`;
    const r = runCli(['--input', a, '--input', b]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const json = JSON.parse(r.stdout);
    expect(json.ok).toBe(true);
    expect(json.cwd).toBe(`${rootSlash}/a/rs/.git/jira_works/T`);
  });

  it('accepts the --input=value form', () => {
    const a = `${rootSlash}/a/rs/.git/jira_works/T/a.md`;
    const r = runCli([`--input=${a}`]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).cwd).toBe(`${rootSlash}/a/rs/.git/jira_works/T`);
  });

  it('accepts the session options', () => {
    const a = `${rootSlash}/a/rs/.git/jira_works/T/a.md`;
    const wt = `${rootSlash}/a/rs-wt/feature-T`;
    const r = runCli(['--input', a, '--session-cwd', wt, '--include-session-cwd']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).cwd).toBe(`${rootSlash}/a`);
  });

  it('exits 0 with ok false when the result is rejected', () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it('keeps stdout ASCII-only like the original', () => {
    const r = runCli([]);
    expect(r.stdout).toMatch(/^[\x20-\x7e\n]+$/);
    expect(JSON.parse(r.stdout).reason).toBe('입력 경로가 하나도 없다');
  });

  it('exits 2 for an unknown option', () => {
    const r = runCli(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('exits 2 when --input has no value', () => {
    const r = runCli(['--input']);
    expect(r.status).toBe(2);
  });

  it('exits 2 for a bare positional argument', () => {
    const r = runCli(['--input', `${rootSlash}/a/x.md`, `${rootSlash}/a/y.md`]);
    expect(r.status).toBe(2);
  });
});
