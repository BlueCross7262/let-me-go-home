import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

// @ts-expect-error Script runtime source is intentionally JavaScript-only.
import { extractBlocks, windowMatch, auditTranscripts } from '../../scripts/lib/fork-audit.mjs';

const CLI = join(__dirname, '..', '..', 'scripts', 'req-interview-fork-audit.mjs');
const FIX = join(__dirname, 'fixtures', 'fork-audit');
const REAL_ROOT = join(FIX, 'projects');
const REAL_SESSION = '9c7f573b-9049-4c68-ae0e-af770876d13a';
const KEYS = ['functional', 'data', 'ui', 'edge', 'techconstraint', 'nonfunctional'];

function runCli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return { status: r.status, json: line ? JSON.parse(line) : null, stderr: r.stderr };
}

function reasons(json: { fails: { key: string; reason: string }[] }) {
  return json.fails.map((f) => `${f.key}:${f.reason}`);
}

describe('extractBlocks', () => {
  it('extracts the four named blocks and skips missing headings', () => {
    const md = [
      '# t',
      '## 2. 목적 및 범위',
      '',
      'goal line',
      '### In-scope',
      '- a',
      '## 3. 기능',
      '- FR-01',
      '## 7. 기술 제약',
      '### 판단 기본값',
      '- default one',
      '### Phase 컴포넌트',
      '- comp',
      '### 빌드·테스트 명령',
      '- npm test',
      '## 8. 수용 기준',
      '- (FR-01) (AC-01) x',
      '## 10. 비기능',
      '- none',
    ].join('\r\n');
    const b = extractBlocks(md);
    expect(Object.keys(b)).toEqual(['§2', '§7 판단 기본값', '§7 Phase 컴포넌트', '§8']);
    expect(b['§2']).toBe('## 2. 목적 및 범위\n\ngoal line\n### In-scope\n- a');
    expect(b['§7 판단 기본값']).toBe('### 판단 기본값\n- default one');
    expect(b['§7 Phase 컴포넌트']).toBe('### Phase 컴포넌트\n- comp');
    expect(b['§8']).toBe('## 8. 수용 기준\n- (FR-01) (AC-01) x');
  });

  it('returns no block for a goal without the headings', () => {
    expect(extractBlocks('# only a title\n\nplain text\n')).toEqual({});
  });

  it('ignores a 판단 기본값 heading outside §7', () => {
    const md = '## 2. 목적\n- g\n### 판단 기본값\n- wrong\n## 7. 기술\n- none\n';
    const b = extractBlocks(md);
    expect(Object.keys(b)).toEqual(['§2']);
  });
});

describe('windowMatch', () => {
  it('matches a block whose non-empty lines appear contiguously', () => {
    expect(windowMatch('## 2. x\n\n- a\n- b', 'pre\n## 2. x\n- a\n\n  - b  \npost')).toBe(true);
  });

  it('rejects a block whose lines are split by another line', () => {
    expect(windowMatch('- a\n- b', '- a\n- other\n- b')).toBe(false);
  });

  it('rejects a partial block', () => {
    expect(windowMatch('- a\n- b\n- c', '- a\n- b')).toBe(false);
  });
});

describe('real sandbox2 transcripts', () => {
  const goal01 = join(FIX, 'goals', 'p01.req-draft.md');
  const goal02 = join(FIX, 'goals', 'p02.req-draft.md');
  const goal02old = join(FIX, 'goals', 'p02-7a6bab2d.req-draft.md');

  it('passes the 7a6b fork that carried the blocks verbatim', () => {
    const r = runCli(['--session', REAL_SESSION, '--slug', 'p02-7a6bab2d', '--item-flag', '--unattended',
      '--keys', KEYS.join(','), '--fork-name', 'p02-auto-interview-63a3', '--goal', goal02old, '--verbatim',
      '--projects-root', REAL_ROOT]);
    expect(r.status).toBe(0);
    expect(r.json.verdict).toBe('pass');
    expect(r.json.fails).toEqual([]);
  });

  it('fails every item of the p01 fork that never called deep-interview', () => {
    const r = runCli(['--session', REAL_SESSION, '--slug', 'p01-004a779c', '--item-flag', '--unattended',
      '--keys', KEYS.join(','), '--fork-name', 'p01-auto-interview-8895', '--goal', goal01, '--verbatim',
      '--projects-root', REAL_ROOT]);
    expect(r.status).toBe(1);
    expect(r.json.verdict).toBe('fail');
    expect(reasons(r.json)).toEqual(KEYS.map((k) => `${k}:no-skill-call`));
  });

  it('fails every block of the f549 fork that summarized the blocks', () => {
    const r = runCli(['--session', REAL_SESSION, '--slug', 'p02-f549f25c', '--item-flag', '--unattended',
      '--keys', KEYS.join(','), '--fork-name', 'p02-auto-interview-28f6', '--goal', goal02, '--verbatim',
      '--projects-root', REAL_ROOT]);
    expect(r.status).toBe(1);
    const blocks = ['§2', '§7 판단 기본값', '§7 Phase 컴포넌트', '§8'];
    expect(reasons(r.json)).toEqual(KEYS.flatMap((k) => blocks.map((b) => `${k}:verbatim:${b}`)));
  });

  it('passes the main scope calls of p01 and f549', () => {
    const p01 = runCli(['--session', REAL_SESSION, '--slug', 'p01-004a779c', '--item-flag', '--unattended',
      '--keys', '', '--scope-slug', 'p01-004a779c-scope', '--goal', goal01, '--verbatim', '--projects-root', REAL_ROOT]);
    expect(p01.status).toBe(0);
    const f549 = runCli(['--session', REAL_SESSION, '--slug', 'p02-f549f25c', '--item-flag', '--unattended',
      '--keys', '', '--scope-slug', 'p02-f549f25c-scope', '--goal', goal02, '--verbatim', '--projects-root', REAL_ROOT]);
    expect(f549.status).toBe(0);
  });
});

describe('real sandbox2 run 3 transcripts', () => {
  const SESSION3 = '6e1fbf9c-fa02-4106-a4ca-1151b0d93648';

  it('reads the slug=X form the p02 fork and main scope call used, and passes their verbatim blocks', () => {
    const r = runCli(['--session', SESSION3, '--slug', 'p02-34f5cd3a', '--item-flag', '--unattended',
      '--keys', KEYS.join(','), '--fork-name', 'p02-auto-interview-546c', '--scope-slug', 'p02-34f5cd3a-scope',
      '--goal', join(FIX, 'goals', 'p02-34f5cd3a.req-draft.md'), '--verbatim', '--projects-root', REAL_ROOT]);
    expect(r.json.fails).toEqual([]);
    expect(r.status).toBe(0);
  });
});

describe('synthetic transcripts', () => {
  let root: string;
  const SID = 'sess-1';
  const main = () => join(root, 'D--repo', `${SID}.jsonl`);
  const subdir = () => join(root, 'D--repo', SID, 'subagents');

  const skill = (args: string, ts: string) => JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Skill', input: { skill: 'let-me-go-home:deep-interview', args } }] },
  });
  const writeFork = (id: string, name: string, lines: string[]) => {
    mkdirSync(subdir(), { recursive: true });
    writeFileSync(join(subdir(), `agent-${id}.jsonl`), lines.join('\n') + '\n');
    writeFileSync(join(subdir(), `agent-${id}.meta.json`), JSON.stringify({ agentType: 'fork', name }));
  };
  const audit = (opts: Record<string, unknown>) => auditTranscripts({ projectsRoot: root, session: SID, slug: 's', ...opts });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fork-audit-'));
    mkdirSync(join(root, 'D--repo'), { recursive: true });
    writeFileSync(main(), '');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports audit-unavailable when the main transcript is missing', () => {
    rmSync(main());
    expect(audit({ itemFlag: '--unattended', keys: ['data'] }).verdict).toBe('audit-unavailable');
  });

  it('reports audit-unavailable when no meta carries the fork name', () => {
    writeFork('a1', 'other-fork', [skill('--unattended --slug s-data', '2026-01-01T00:00:01Z')]);
    expect(audit({ itemFlag: '--unattended', keys: ['data'], forkName: 'p01-auto-interview-0000' }).verdict).toBe('audit-unavailable');
  });

  it('audits main alone when there is no subagents folder and no fork name', () => {
    writeFileSync(main(), skill('--unattended --slug s-data', '2026-01-01T00:00:01Z') + '\n');
    const r = audit({ itemFlag: '--unattended', keys: ['data'] });
    expect(existsSync(subdir())).toBe(false);
    expect(r.verdict).toBe('pass');
  });

  it('merges two transcripts of the same fork name in time order and judges the last call', () => {
    writeFork('a1', 'p01-auto-interview-0000', [skill('--auto-approve --slug s-data', '2026-01-01T00:00:01Z')]);
    writeFork('a2', 'p01-auto-interview-0000', [skill('--unattended --slug s-data', '2026-01-01T00:00:09Z')]);
    const r = audit({ itemFlag: '--unattended', keys: ['data'], forkName: 'p01-auto-interview-0000' });
    expect(r.verdict).toBe('pass');
    expect(r.transcripts.length).toBe(2);
  });

  it('audits only the keys given, so a stopped run is not blamed for later items', () => {
    writeFork('a1', 'f', ['functional', 'data', 'ui'].map((k, i) => skill(`--unattended --slug s-${k}`, `2026-01-01T00:00:0${i}Z`)));
    const r = audit({ itemFlag: '--unattended', keys: ['functional', 'data', 'ui'], forkName: 'f' });
    expect(r.verdict).toBe('pass');
  });

  it('does not mistake a slug with a shared prefix for the item', () => {
    writeFork('a1', 'f', [skill('--unattended --slug s-uix', '2026-01-01T00:00:01Z')]);
    const r = audit({ itemFlag: '--unattended', keys: ['ui'], forkName: 'f' });
    expect(r.fails).toEqual([{ key: 'ui', reason: 'no-skill-call' }]);
  });

  it('judges scope by the exact round slug only', () => {
    writeFileSync(main(), [
      skill('--unattended --slug s-scope', '2026-01-01T00:00:01Z'),
      skill('--auto-approve --slug s-scope-2', '2026-01-01T00:00:02Z'),
    ].join('\n') + '\n');
    expect(audit({ itemFlag: '--unattended', keys: [], scopeSlug: 's-scope' }).verdict).toBe('pass');
    expect(audit({ itemFlag: '--unattended', keys: [], scopeSlug: 's-scope-2' }).fails).toEqual([{ key: 'scope', reason: 'flag' }]);
  });

  it('does not check the flag of an interactive scope call', () => {
    writeFileSync(main(), skill('--name-prefix p01 --slug s-scope', '2026-01-01T00:00:01Z') + '\n');
    expect(audit({ itemFlag: '--auto-approve', keys: [], scopeSlug: 's-scope' }).verdict).toBe('pass');
  });

  it('fails an item called with the wrong flag', () => {
    writeFork('a1', 'f', [skill('--auto-approve --slug s-edge', '2026-01-01T00:00:01Z')]);
    expect(audit({ itemFlag: '--unattended', keys: ['edge'], forkName: 'f' }).fails).toEqual([{ key: 'edge', reason: 'flag' }]);
  });

  it('lists scope failures before item failures', () => {
    writeFork('a1', 'f', []);
    const r = audit({ itemFlag: '--unattended', keys: ['data'], forkName: 'f', scopeSlug: 's-scope' });
    expect(r.fails).toEqual([{ key: 'scope', reason: 'no-skill-call' }, { key: 'data', reason: 'no-skill-call' }]);
  });

  it('skips block checks when the goal has none of the headings', () => {
    const goal = join(root, 'goal.md');
    writeFileSync(goal, '# plain\n\ntext\n');
    writeFork('a1', 'f', [skill('--unattended --slug s-data', '2026-01-01T00:00:01Z')]);
    expect(audit({ itemFlag: '--unattended', keys: ['data'], forkName: 'f', goal, verbatim: true }).verdict).toBe('pass');
  });

  it('accepts --slug X, --slug=X and slug=X on the first line of args', () => {
    writeFork('a1', 'f', [
      skill('--unattended --slug s-functional', '2026-01-01T00:00:01Z'),
      skill('--unattended --slug=s-data', '2026-01-01T00:00:02Z'),
      skill('--unattended --name-prefix p01 slug=s-ui', '2026-01-01T00:00:03Z'),
    ]);
    expect(audit({ itemFlag: '--unattended', keys: ['functional', 'data', 'ui'], forkName: 'f' }).verdict).toBe('pass');
  });

  it('does not take a slug quoted in the body below the first line', () => {
    writeFork('a1', 'f', [skill('--unattended --slug s-data\n\n앞 항목: --slug s-functional 의 spec 을 따른다', '2026-01-01T00:00:01Z')]);
    expect(audit({ itemFlag: '--unattended', keys: ['functional'], forkName: 'f' }).fails).toEqual([{ key: 'functional', reason: 'no-skill-call' }]);
  });

  it('writes the blocks file with --emit-blocks', () => {
    const goal = join(root, 'goal.md');
    writeFileSync(goal, '## 2. 목적\n- g\n## 8. 수용 기준\n- ac\n');
    const out = join(root, 'blocks.md');
    const r = spawnSync(process.execPath, [CLI, '--goal', goal, '--emit-blocks', out], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('## 2. 목적\n- g\n\n## 8. 수용 기준\n- ac\n');
  });
});
