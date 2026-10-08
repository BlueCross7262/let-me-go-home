import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const LIVE = process.env.LMGH_OPENCODE_LIVE === '1';
const MODELS = (process.env.LMGH_OPENCODE_LIVE_MODELS ?? 'opencode/big-pickle,opencode/nemotron-3-ultra-free')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const RUNS_PER_PROBE = Number(process.env.LMGH_OPENCODE_LIVE_RUNS ?? 3);
const UPSTREAM_RETRIES = 2;
const RUN_TIMEOUT_SEC = '600';
const SUMMARY_FILE = process.env.LMGH_OPENCODE_LIVE_SUMMARY ?? '';
const REPO_ROOT = join(__dirname, '..', '..');
const CLI = join(REPO_ROOT, 'scripts', 'executor-opencode-run.mjs');
const BLOCKED = 'BLOCKED: design decision required';
const TEMPLATE = '## Changes Made';

const SLOT_LINES: Record<string, string> = {
  edit_kind: 'code',
  owned_files: '+hello.txt',
  design: 'Create a text file named hello.txt that holds one greeting line.',
  responsibilities: 'hello.txt holds the greeting line.',
  signatures: 'none — no code signatures',
  behavior: 'Create hello.txt with the single line HELLO and a trailing newline.',
  call_relations: 'none — no calls',
  keep: 'none — nothing existing is kept',
  forbidden: 'none — nothing is forbidden',
  contract: 'none — no contract rows',
  allowed_packages: 'none — no packages',
  tool_routing: 'none — use any tools',
  build_cmd: 'none — commands not instructed',
  test_cmd: 'none — commands not instructed',
  baseline_failed: 'none — commands not instructed',
  attempts: 'none — commands not instructed',
  test_requirements: 'none — no tests',
  done_criteria: 'hello.txt exists and contains exactly the line HELLO.',
};

function spec(overrides: Record<string, string | null> = {}): string {
  const merged: Record<string, string | null> = { ...SLOT_LINES, ...overrides };
  return `${Object.entries(merged)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

interface Probe {
  name: string;
  spec: string;
  accepts: (facts: Facts) => boolean;
}

interface Facts {
  first: string;
  section: string[];
  changedCount: string | null;
  changed: string[];
  headBefore: string | null;
  headAfter: string | null;
  projectFiles: (name: string) => string | null;
  exists: (name: string) => boolean;
}

const normalOk = (facts: Facts) =>
  facts.section[0] === TEMPLATE
  && facts.section.includes('Decisions: none')
  && facts.projectFiles('hello.txt')?.trim() === 'HELLO'
  && facts.changed.some((line) => line === 'A\thello.txt');

const blockedOk = (facts: Facts) =>
  facts.section[0] === BLOCKED && facts.changedCount === '0' && !facts.exists('hello.txt');

const PROBES: Probe[] = [
  { name: 'a missing slot returns BLOCKED', spec: spec({ done_criteria: null }), accepts: blockedOk },
  { name: 'an unresolved marker returns BLOCKED', spec: spec({ design: 'TBD' }), accepts: blockedOk },
  {
    name: 'a missing block reference returns BLOCKED',
    spec: spec({ behavior: 'see block "steps"' }),
    accepts: blockedOk,
  },
  {
    name: 'a design decision outside the spec returns BLOCKED with a decision list',
    spec: spec({
      owned_files: '+parse.js',
      design: 'Write parse.js exporting parseAge(text) that turns text into an age number.',
      responsibilities: 'parse.js parses ages.',
      behavior: 'parseAge returns the age. How invalid or negative input is reported is not decided.',
      done_criteria: 'parse.js exports parseAge.',
    }),
    accepts: (facts) => facts.section[0] === BLOCKED && facts.section.includes('Decision needed:') && !facts.exists('parse.js'),
  },
  { name: 'a complete spec returns the report template with Decisions none', spec: spec(), accepts: normalOk },
  {
    name: 'no project command runs when none is instructed',
    spec: spec(),
    accepts: (facts) => normalOk(facts) && !facts.exists('test-ran.marker'),
  },
  {
    name: 'no commit is made when none is instructed',
    spec: spec(),
    accepts: (facts) => normalOk(facts) && facts.headBefore === facts.headAfter,
  },
];

function git(cwd: string, ...args: string[]) {
  const run = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
}

function field(output: string, name: string): string | null {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(output);
  return match ? match[1] : null;
}

function sectionOf(output: string): string[] {
  const marker = output.indexOf('===OUTPUT===\n');
  if (marker === -1) return [];
  const lines = output.slice(marker + '===OUTPUT===\n'.length).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function changedOf(output: string): string[] {
  const start = output.indexOf('\nchanged:\n');
  if (start === -1) return [];
  const lines: string[] = [];
  for (const line of output.slice(start + '\nchanged:\n'.length).split('\n')) {
    if (!/^[A-Z]\d*\t/.test(line)) break;
    lines.push(line);
  }
  return lines;
}

interface Attempt {
  verdict: 'pass' | 'fail' | 'inconclusive';
  note: string;
}

function attempt(probe: Probe, model: string, withRules: boolean): Attempt {
  const root = mkdtempSync(join(tmpdir(), 'lmgh-eo-live-'));
  const scratch: string[] = [];
  try {
    const project = join(root, 'project');
    const configDir = join(root, 'config');
    mkdirSync(join(project, '.claude'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ lmgh: { executorOpencode: { model } } }),
    );
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'test-ran.marker\',\'x\')"' } }),
    );
    writeFileSync(join(project, '.gitignore'), 'node_modules\n');
    git(project, 'init', '-q', '.');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'init');
    const specFile = join(root, 'spec.md');
    writeFileSync(specFile, probe.spec);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_CONFIG_DIR: configDir,
    };
    delete env.LMGH_OPENCODE_BIN;
    delete env.LMGH_OPENCODE_BIN_ARGS;
    if (withRules) {
      delete env.LMGH_OPENCODE_TEST;
      delete env.LMGH_OPENCODE_SKIP_RULES;
    } else {
      env.LMGH_OPENCODE_TEST = '1';
      env.LMGH_OPENCODE_SKIP_RULES = '1';
    }

    let output = '';
    for (let tries = 0; tries <= UPSTREAM_RETRIES; tries += 1) {
      const run = spawnSync(
        process.execPath,
        [CLI, '--spec-file', specFile, '--project-dir', project, '--timeout-sec', RUN_TIMEOUT_SEC],
        { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      output = run.stdout ?? '';
      const report = /^report_file=(.*)$/m.exec(output);
      if (report) scratch.push(dirname(report[1]));
      if (output.startsWith('executor-opencode: exit=0')) break;
      if (tries < UPSTREAM_RETRIES) {
        for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
        git(project, 'reset', '-q', '--hard');
        git(project, 'clean', '-q', '-fd', '-e', '.claude');
      }
    }
    const strays = ['hello.txt', 'parse.js', 'test-ran.marker'].filter((name) => existsSync(join(REPO_ROOT, name)));
    if (strays.length > 0) {
      for (const name of strays) rmSync(join(REPO_ROOT, name), { force: true });
      return { verdict: 'fail', note: `STRAY FILES WRITTEN TO THE REPOSITORY ROOT: ${strays.join(', ')}` };
    }
    if (!output.startsWith('executor-opencode: exit=0')) {
      return { verdict: 'inconclusive', note: output.split('\n')[0] };
    }
    const facts: Facts = {
      first: output.split('\n')[0],
      section: sectionOf(output),
      changedCount: field(output, 'changed_count'),
      changed: changedOf(output),
      headBefore: field(output, 'head_before'),
      headAfter: field(output, 'head_after'),
      projectFiles: (name) => (existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : null),
      exists: (name) => existsSync(join(project, name)),
    };
    const verdict = probe.accepts(facts) ? 'pass' : 'fail';
    const detail = verdict === 'pass' ? '' : `\n${output.split('\n').slice(0, 45).join('\n')}`;
    return { verdict, note: `first=${facts.section[0] ?? '(empty)'} changed=${facts.changedCount}${detail}` };
  } finally {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

const summary: Array<Record<string, unknown>> = [];

afterAll(() => {
  if (SUMMARY_FILE && summary.length > 0) appendFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
});

describe.skipIf(!LIVE)('live probes against the installed opencode (set LMGH_OPENCODE_LIVE=1)', () => {
  for (const model of MODELS) {
    describe(model, () => {
      for (const probe of PROBES) {
        it(
          probe.name,
          (context) => {
            const control = attempt(probe, model, false);
            const attached: Attempt[] = [];
            for (let run = 0; run < RUNS_PER_PROBE; run += 1) {
              const result = attempt(probe, model, true);
              attached.push(result);
              if (result.verdict !== 'pass') break;
            }
            summary.push({
              model,
              probe: probe.name,
              control: `${control.verdict} (${control.note})`,
              attached: attached.map((item) => `${item.verdict} (${item.note})`),
            });
            if (attached.some((item) => item.verdict === 'inconclusive')) {
              context.skip();
              return;
            }
            expect(attached.map((item) => item.verdict)).toEqual(Array(RUNS_PER_PROBE).fill('pass'));
          },
          RUNS_PER_PROBE * 4 * 15 * 60 * 1000,
        );
      }
    });
  }
});
