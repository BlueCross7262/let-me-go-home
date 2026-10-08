import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import {
  DEFAULT_TIMEOUT_SEC,
  // @ts-expect-error Script runtime source is intentionally JavaScript-only.
} from '../../scripts/lib/executor-opencode-runner.mjs';

const ROOT = join(__dirname, '..', '..');
const AGENT = readFileSync(join(ROOT, 'agents', 'executor-opencode.md'), 'utf8').replace(/\r\n/g, '\n');
const EXECUTOR = readFileSync(join(ROOT, 'agents', 'executor.md'), 'utf8').replace(/\r\n/g, '\n');
const CODEX_REVIEWER = readFileSync(join(ROOT, 'agents', 'codex-reviewer.md'), 'utf8').replace(/\r\n/g, '\n');
const RULES = readFileSync(join(ROOT, 'scripts', 'executor-opencode-rules.md'), 'utf8').replace(/\r\n/g, '\n');
const RUNNER_LIB = readFileSync(join(ROOT, 'scripts', 'lib', 'executor-opencode-runner.mjs'), 'utf8');
const SCRIPTS_DIR = join(ROOT, 'scripts').replace(/\\/g, '/');

const CTX_EXECUTE_ID = 'mcp__plugin_context-mode_context-mode__ctx_execute';
const BLOCKED_FIRST_LINE = 'BLOCKED: design decision required';
const SENTINEL_PREFIX = 'executor-opencode(backend=unavailable):';
const BASH_AVAILABLE = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;

function frontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  const end = lines.indexOf('---', 1);
  const result: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator > 0) result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function codeBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (current) {
        blocks.push(current);
        current = null;
      } else {
        current = [];
      }
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

describe('agent frontmatter', () => {
  const meta = frontmatter(AGENT);

  it('names the agent executor-opencode on the haiku tier', () => {
    expect(meta.name).toBe('executor-opencode');
    expect(meta.model).toBe('haiku');
    expect(meta.effort).toBe('medium');
  });

  it('ends the description with the tier tag and keeps it short', () => {
    expect(meta.description.endsWith('(Haiku)')).toBe(true);
    expect(meta.description.length).toBeLessThan(200);
  });

  it('allows exactly ToolSearch, ctx_execute and Read', () => {
    const tools = meta.tools.split(',').map((tool) => tool.trim());
    expect(tools).toEqual(['ToolSearch', CTX_EXECUTE_ID, 'Read']);
    expect(tools).not.toContain('SendMessage');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
  });
});

describe('agent body', () => {
  it('carries the BLOCKED block byte-identical to executor.md', () => {
    const fromExecutor = codeBlocks(EXECUTOR).filter((block) => block[0] === BLOCKED_FIRST_LINE);
    const fromAgent = codeBlocks(AGENT).filter((block) => block[0] === BLOCKED_FIRST_LINE);
    expect(fromExecutor).toHaveLength(1);
    expect(fromAgent).toEqual(fromExecutor);
  });

  it('shares the sentinel prefix, the BLOCKED first line and the ctx_execute id across files', () => {
    expect(AGENT).toContain(SENTINEL_PREFIX);
    expect(RUNNER_LIB).toContain(`'${SENTINEL_PREFIX} '`);
    expect(RULES).toContain(BLOCKED_FIRST_LINE);
    expect(EXECUTOR).toContain(BLOCKED_FIRST_LINE);
    expect(frontmatter(CODEX_REVIEWER).tools).toContain(CTX_EXECUTE_ID);
    expect(AGENT).toContain(CTX_EXECUTE_ID);
  });

  it('sets a ctx_execute timeout larger than the runner default', () => {
    const match = /timeout: (\d+)/.exec(AGENT);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(DEFAULT_TIMEOUT_SEC * 1000 + 60000);
  });

  it('does not set a cwd argument on the ctx_execute call and passes --project-dir', () => {
    expect(AGENT).toContain('`cwd` 인자는 쓰지 않는다');
    expect(AGENT).toContain('--project-dir');
  });

  it('tells the wrapper to return the runner output verbatim and never to edit or fall back itself', () => {
    expect(AGENT).toContain('러너 출력 전문을 한 글자도 바꾸지 않고 최종 응답 텍스트로 반환한다');
    expect(AGENT).toContain('직접 편집하지 않는다');
    expect(AGENT).toContain('폴백은 호출부가 한다');
  });
});

describe.skipIf(!BASH_AVAILABLE || !GIT_AVAILABLE)('call template', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lmgh-eo-agent-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith('lmgh-eo-fake-agent-')) rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
  });

  function template(): string {
    const matches = codeBlocks(AGENT).filter((block) => block.join('\n').includes('executor-opencode-run.mjs'));
    expect(matches).toHaveLength(1);
    return matches[0].join('\n');
  }

  it('runs with spaces and Hangul in the project and spec paths and hands them to opencode unchanged', () => {
    const base = join(root, '한글 폴더').replace(/\\/g, '/');
    const project = `${base}/repo space`;
    const spec = `${base}/spec file.md`;
    mkdirSync(project, { recursive: true });
    writeFileSync(spec, 'edit_kind=code\n');
    for (const args of [['init', '-q', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
      expect(spawnSync('git', args, { cwd: project }).status).toBe(0);
    }
    const fakeDir = mkdtempSync(join(tmpdir(), 'lmgh-eo-fake-agent-'));
    const fake = join(fakeDir, 'fake.js').replace(/\\/g, '/');
    const argvFile = join(fakeDir, 'argv.json').replace(/\\/g, '/');
    writeFileSync(
      fake,
      `require('fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('## Changes Made\\n- ok\\n');\n`,
    );
    const command = template().replace('<spec_file>', spec).replace('<project_dir>', project);
    const run = spawnSync('bash', ['-c', command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LMGH_SCRIPTS_DIR: SCRIPTS_DIR,
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        LMGH_OPENCODE_TEST: '1',
        LMGH_OPENCODE_BIN: process.execPath,
        LMGH_OPENCODE_BIN_ARGS: JSON.stringify([fake]),
        ARGV_FILE: argvFile,
      },
    });
    const report = /^report_file=(.*)$/m.exec(run.stdout ?? '');
    if (report) rmSync(dirname(report[1]), { recursive: true, force: true });
    expect(run.stdout.split('\n')[0]).toBe('executor-opencode: exit=0');
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    expect(argv).toContain(spec);
    expect(run.stdout).toContain(`effective_dir=${project}`);
  });

  it('prints the path-resolution sentinel when the scripts directory cannot be found', () => {
    const command = template().replace('<spec_file>', 'x.md').replace('<project_dir>', root.replace(/\\/g, '/'));
    const run = spawnSync('bash', ['-c', command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LMGH_SCRIPTS_DIR: join(root, 'nowhere'),
        CLAUDE_CONFIG_DIR: join(root, 'no-config'),
        CLAUDE_PLUGIN_ROOT: '',
      },
    });
    expect(run.stdout.split('\n')[0]).toBe(`${SENTINEL_PREFIX} path-resolution plugin scripts directory not found`);
  });
});
