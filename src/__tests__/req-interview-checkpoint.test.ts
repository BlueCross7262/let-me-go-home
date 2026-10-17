import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { buildCheckpoint, reqInterviewPointer } from '../../scripts/lib/checkpoint.mjs';

const REPO_ROOT = resolve(__dirname, '..', '..');
const STATE_SCRIPT = join(REPO_ROOT, 'scripts', 'req-interview-state.mjs');
const COMPACT_CHECKPOINT = join(REPO_ROOT, 'scripts', 'compact-checkpoint.mjs');
const SESSION_START = join(REPO_ROOT, 'scripts', 'workflow-session-start.mjs');
const PRE_COMPACT = join(REPO_ROOT, 'scripts', 'workflow-pre-compact.mjs');
const REQ_SKILL = join(REPO_ROOT, 'skills', 'req-interview', 'SKILL.md');
const CANCEL_SKILL = join(REPO_ROOT, 'skills', 'cancel', 'SKILL.md');
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false'];

describe('req-interview progress record in the compact checkpoint', () => {
  let tempDir: string;
  let repo: string;
  let sessionId: string;
  let stateDir: string;
  let statePath: string;

  function env(pluginRoot?: string): NodeJS.ProcessEnv {
    const base: Record<string, string | undefined> = {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PROJECT_DIR: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      LMGH_SESSION_ID: undefined,
      LMGH_STATE_DIR: undefined,
      DISABLE_LMGH: undefined,
      LMGH_SKIP_HOOKS: undefined,
    };
    for (const [key, value] of Object.entries(base)) {
      if (value === undefined) delete base[key];
    }
    return base as NodeJS.ProcessEnv;
  }

  function node(script: string, args: string[], options: { cwd?: string; pluginRoot?: string; input?: unknown } = {}) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: options.cwd ?? repo,
      env: env(options.pluginRoot),
      input: options.input === undefined ? undefined : JSON.stringify(options.input),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
  }

  function beginArgs(slug = 'demo', overrides: Record<string, string> = {}, current = 'scope:running'): string[] {
    const sets: Record<string, string> = {
      use_fork: 'false',
      unattended: 'false',
      verbatim_blocks: 'false',
      scope_only: 'false',
      name_prefix: 'null',
      goal_file: join(tempDir, 'goal.md'),
      context_path: 'null',
      origin_path: 'null',
      repo_root: 'null',
      work_dir: join(tempDir, 'work'),
      skill_file: join(tempDir, 'skill', 'SKILL.md'),
      progress_path: join(tempDir, 'work', `${slug}.progress.log`),
      result_path: join(tempDir, 'work', `${slug}.result.md`),
      fork_name_path: 'null',
      blocks_path: 'null',
      ...overrides,
    };
    const args = ['begin', '--session-id', sessionId, '--slug', slug];
    for (const [key, value] of Object.entries(sets)) args.push('--set', `${key}=${value}`);
    args.push('--current', current);
    return args;
  }

  function begin(slug = 'demo', overrides: Record<string, string> = {}, current = 'scope:running') {
    return node(STATE_SCRIPT, beginArgs(slug, overrides, current));
  }

  function write(slug: string, extra: string[]) {
    return node(STATE_SCRIPT, ['write', '--session-id', sessionId, '--slug', slug, ...extra]);
  }

  function readState(): Record<string, any> {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  }

  function runHook(script: string, source: string, pluginRoot = REPO_ROOT) {
    return node(script, [], { pluginRoot, input: { session_id: sessionId, cwd: repo, source } });
  }

  function restoreContext(pluginRoot = REPO_ROOT): string {
    const result = runHook(SESSION_START, 'compact', pluginRoot);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    return output.hookSpecificOutput?.additionalContext ?? '';
  }

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-reqint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    sessionId = `reqint-${Math.random().toString(36).slice(2)}`;
    stateDir = join(repo, '.lmgh', 'state');
    statePath = join(stateDir, 'sessions', sessionId, 'req-interview-state.json');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  describe('state script', () => {
    it('begin writes every run variable and the first current item', () => {
      const result = begin();
      expect(result.status).toBe(0);
      const state = readState();
      expect(state).toEqual({
        active: true,
        session_id: sessionId,
        slug: 'demo',
        started_at: expect.any(String),
        updated_at: expect.any(String),
        use_fork: false,
        unattended: false,
        verbatim_blocks: false,
        scope_only: false,
        name_prefix: null,
        goal_file: join(tempDir, 'goal.md'),
        context_path: null,
        origin_path: null,
        repo_root: null,
        work_dir: join(tempDir, 'work'),
        skill_file: join(tempDir, 'skill', 'SKILL.md'),
        progress_path: join(tempDir, 'work', 'demo.progress.log'),
        result_path: join(tempDir, 'work', 'demo.result.md'),
        fork_name_path: null,
        blocks_path: null,
        specs: {},
        current: { item: 'scope', status: 'running', reason: null },
      });
    });

    it('begin replaces everything a previous run left, for a new slug and for the same slug', () => {
      begin('old');
      write('old', ['--spec', 'scope=/a/scope.md', '--current', 'edge:stopped:fork-audit']);
      expect(begin('new').status).toBe(0);
      let state = readState();
      expect(state.slug).toBe('new');
      expect(state.specs).toEqual({});
      expect(state.current).toEqual({ item: 'scope', status: 'running', reason: null });
      write('new', ['--spec', 'scope=/b/scope.md']);
      expect(begin('new').status).toBe(0);
      state = readState();
      expect(state.specs).toEqual({});
      expect(state.current).toEqual({ item: 'scope', status: 'running', reason: null });
    });

    it('write keeps earlier spec keys and overwrites the same key', () => {
      begin();
      expect(write('demo', ['--spec', 'scope=/a/scope.md', '--current', 'functional:running']).status).toBe(0);
      expect(write('demo', ['--spec', 'functional=/a/functional.md']).status).toBe(0);
      expect(write('demo', ['--spec', 'scope=/b/scope.md', '--spec', 'scope-2=/b/scope-2.md']).status).toBe(0);
      const state = readState();
      expect(state.specs).toEqual({
        scope: '/b/scope.md',
        functional: '/a/functional.md',
        'scope-2': '/b/scope-2.md',
      });
      expect(Object.keys(state.specs)).toEqual(['scope', 'functional', 'scope-2']);
      expect(state.current).toEqual({ item: 'functional', status: 'running', reason: null });
    });

    it('write exits 3 and writes nothing when no matching active run exists', () => {
      expect(write('demo', ['--spec', 'scope=/a.md']).status).toBe(3);
      expect(existsSync(statePath)).toBe(false);

      begin('demo');
      const before = readFileSync(statePath, 'utf-8');
      expect(write('other', ['--spec', 'scope=/a.md']).status).toBe(3);
      expect(readFileSync(statePath, 'utf-8')).toBe(before);

      writeFileSync(statePath, JSON.stringify({ ...JSON.parse(before), active: false }));
      const inactive = readFileSync(statePath, 'utf-8');
      expect(write('demo', ['--spec', 'scope=/a.md']).status).toBe(3);
      expect(readFileSync(statePath, 'utf-8')).toBe(inactive);

      writeFileSync(statePath, JSON.stringify({ ...JSON.parse(before), session_id: 'someone-else' }));
      const foreign = readFileSync(statePath, 'utf-8');
      expect(write('demo', ['--spec', 'scope=/a.md']).status).toBe(3);
      expect(readFileSync(statePath, 'utf-8')).toBe(foreign);

      writeFileSync(statePath, '{ not json');
      expect(write('demo', ['--spec', 'scope=/a.md']).status).toBe(3);
      expect(readFileSync(statePath, 'utf-8')).toBe('{ not json');
    });

    it('rejects invalid input with exit 1 before touching the file', () => {
      begin();
      const before = readFileSync(statePath, 'utf-8');
      const bad: string[][] = [
        ['--spec', 'Scope=/a.md'],
        ['--spec', 'scope='],
        ['--spec', 'scope'],
        ['--set', 'nope=1'],
        ['--set', 'slug=other'],
        ['--set', 'use_fork=maybe'],
        ['--current', 'scope:paused'],
        ['--current', 'Scope:running'],
        ['--current', 'edge:stopped:bad\u0007reason'],
        ['--current', `edge:stopped:${'x'.repeat(201)}`],
      ];
      for (const extra of bad) {
        const result = write('demo', ['--spec', 'functional=/ok.md', ...extra]);
        expect(result.status, extra.join(' ')).toBe(1);
        expect(readFileSync(statePath, 'utf-8'), extra.join(' ')).toBe(before);
      }
      expect(node(STATE_SCRIPT, ['write', '--session-id', sessionId, '--spec', 'scope=/a.md']).status).toBe(1);
      expect(node(STATE_SCRIPT, ['write', '--session-id', '../escape', '--slug', 'demo']).status).toBe(1);
      expect(node(STATE_SCRIPT, ['write', '--slug', 'demo']).status).toBe(1);
      expect(node(STATE_SCRIPT, ['begin', '--session-id', sessionId]).status).toBe(1);
      expect(node(STATE_SCRIPT, ['begin', '--session-id', sessionId, '--slug', '']).status).toBe(1);
      expect(node(STATE_SCRIPT, ['unknown', '--session-id', sessionId]).status).toBe(1);
      expect(readFileSync(statePath, 'utf-8')).toBe(before);
    });

    it('accepts a free-text reason and splits key=value at the first equals sign', () => {
      begin('demo', { goal_file: 'C:/a=b/goal.md' });
      expect(readState().goal_file).toBe('C:/a=b/goal.md');
      const reason = 'fork-audit:scope 경계 확장 필요';
      expect(write('demo', ['--current', `edge:stopped:${reason}`, '--spec', 'scope=/p/q=r.md']).status).toBe(0);
      let state = readState();
      expect(state.current).toEqual({ item: 'edge', status: 'stopped', reason });
      expect(state.specs.scope).toBe('/p/q=r.md');
      expect(write('demo', ['--current', 'functional']).status).toBe(0);
      expect(readState().current).toEqual({ item: 'functional', status: 'running', reason: null });
      expect(write('demo', ['--current', 'none']).status).toBe(0);
      state = readState();
      expect(state.current).toBeNull();
    });

    it('clear removes the file, succeeds when it is absent, and blocks later writes', () => {
      begin();
      expect(node(STATE_SCRIPT, ['clear', '--session-id', sessionId]).status).toBe(0);
      expect(existsSync(statePath)).toBe(false);
      expect(node(STATE_SCRIPT, ['clear', '--session-id', sessionId]).status).toBe(0);
      expect(write('demo', ['--spec', 'scope=/a.md']).status).toBe(3);
      expect(existsSync(statePath)).toBe(false);
    });

    it('resolves the state root from its own plugin root, not from a foreign CLAUDE_PLUGIN_ROOT', () => {
      const foreign = join(tempDir, 'foreign-plugin');
      mkdirSync(foreign, { recursive: true });
      const result = node(STATE_SCRIPT, beginArgs(), { pluginRoot: foreign });
      expect(result.status).toBe(0);
      expect(existsSync(statePath)).toBe(true);
    });
  });

  describe('pointer', () => {
    it('describes the run with its done items in write order', () => {
      begin('demo', { use_fork: 'true', name_prefix: 'p1', fork_name_path: join(tempDir, 'work', 'demo.fork-name') });
      write('demo', ['--spec', 'scope=/a/scope.md', '--spec', 'functional=/a/functional.md', '--current', 'edge:stopped:no-progress']);
      expect(reqInterviewPointer(stateDir, sessionId)).toEqual({
        active: true,
        slug: 'demo',
        scope_only: false,
        unattended: false,
        use_fork: true,
        verbatim_blocks: false,
        name_prefix: 'p1',
        goal_file: join(tempDir, 'goal.md'),
        context_path: null,
        origin_path: null,
        repo_root: null,
        work_dir: join(tempDir, 'work'),
        skill_file: join(tempDir, 'skill', 'SKILL.md'),
        progress_path: join(tempDir, 'work', 'demo.progress.log'),
        result_path: join(tempDir, 'work', 'demo.result.md'),
        fork_name_path: join(tempDir, 'work', 'demo.fork-name'),
        blocks_path: null,
        started_at: expect.any(String),
        updated_at: expect.any(String),
        current: { item: 'edge', status: 'stopped', reason: 'no-progress' },
        spec_paths: { scope: '/a/scope.md', functional: '/a/functional.md' },
        completed_items: ['scope', 'functional'],
        state_path: statePath,
      });
    });

    it('returns null for an inactive, foreign, slugless, corrupt or missing record', () => {
      expect(reqInterviewPointer(stateDir, sessionId)).toBeNull();
      begin();
      const valid = JSON.parse(readFileSync(statePath, 'utf-8'));
      const variants: unknown[] = [
        { ...valid, active: false },
        { ...valid, active: 'true' },
        { ...valid, session_id: 'someone-else' },
        { ...valid, slug: '' },
        { ...valid, slug: 7 },
      ];
      for (const variant of variants) {
        writeFileSync(statePath, JSON.stringify(variant));
        expect(reqInterviewPointer(stateDir, sessionId)).toBeNull();
      }
      writeFileSync(statePath, '{ not json');
      expect(reqInterviewPointer(stateDir, sessionId)).toBeNull();
    });

    it('ignores spec entries that are not non-empty strings and a malformed current', () => {
      begin();
      const valid = JSON.parse(readFileSync(statePath, 'utf-8'));
      writeFileSync(statePath, JSON.stringify({
        ...valid,
        specs: { scope: '/a.md', functional: '', data: 5, ui: null },
        current: { item: 'edge', status: 'paused', reason: null },
      }));
      const pointer = reqInterviewPointer(stateDir, sessionId);
      expect(pointer.spec_paths).toEqual({ scope: '/a.md' });
      expect(pointer.completed_items).toEqual(['scope']);
      expect(pointer.current).toBeNull();
    });

    it('is carried by buildCheckpoint next to the other pointers', () => {
      expect(buildCheckpoint(stateDir, sessionId).req_interview).toBeNull();
      begin();
      write('demo', ['--spec', 'scope=/a/scope.md']);
      const checkpoint = buildCheckpoint(stateDir, sessionId);
      expect(checkpoint.req_interview.slug).toBe('demo');
      expect(checkpoint.req_interview.completed_items).toEqual(['scope']);
      expect(checkpoint.ralph).toBeNull();
      expect(checkpoint.deep_interview).toBeNull();
      expect(checkpoint.phase_chain).toBeNull();
    });
  });

  describe('manual compact checkpoint script', () => {
    it('reports and writes a checkpoint when only req-interview is in flight', () => {
      begin();
      write('demo', ['--spec', 'scope=/a/scope.md', '--spec', 'functional=/a/functional.md', '--current', 'data:running']);
      const result = node(COMPACT_CHECKPOINT, ['--session-id', sessionId, '--directory', repo]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('req-interview active: slug demo');
      expect(result.stdout).toContain('  Done: scope, functional (2)');
      expect(result.stdout).toContain('  Current: data (running)');
      expect(result.stdout).toContain(`  State: ${statePath}`);
      expect(result.stdout).not.toContain('Nothing in flight');
      const checkpointPath = join(stateDir, 'sessions', sessionId, 'precompact-checkpoint.json');
      expect(existsSync(checkpointPath)).toBe(true);

      const json = node(COMPACT_CHECKPOINT, ['--session-id', sessionId, '--directory', repo, '--json']);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.written).not.toBeNull();
      expect(parsed.checkpoint.req_interview.completed_items).toEqual(['scope', 'functional']);
    });

    it('says nothing is in flight when no run, loop or interview is active', () => {
      const result = node(COMPACT_CHECKPOINT, ['--session-id', sessionId, '--directory', repo]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Nothing in flight: no Ralph loop, no Deep Interview and no req-interview in this session.');
      expect(existsSync(join(stateDir, 'sessions', sessionId, 'precompact-checkpoint.json'))).toBe(false);
    });

    it('shows a stopped current item with its reason', () => {
      begin();
      write('demo', ['--current', 'edge:stopped:fork-audit:scope 경계 확장 필요']);
      const result = node(COMPACT_CHECKPOINT, ['--session-id', sessionId, '--directory', repo]);
      expect(result.stdout).toContain('  Current: edge (stopped: fork-audit:scope 경계 확장 필요)');
    });
  });

  describe('PreCompact and SessionStart', () => {
    it('records the run at PreCompact and replays its facts after compaction', () => {
      begin('demo', { use_fork: 'true', unattended: 'true', context_path: join(tempDir, 'ctx.md') });
      write('demo', ['--spec', 'scope=/a/scope.md', '--current', 'fork:running']);
      expect(runHook(PRE_COMPACT, 'compact').status).toBe(0);
      const checkpointPath = join(stateDir, 'sessions', sessionId, 'precompact-checkpoint.json');
      expect(JSON.parse(readFileSync(checkpointPath, 'utf-8')).req_interview.slug).toBe('demo');

      const context = restoreContext();
      expect(context).toContain('[PRE-COMPACT CHECKPOINT]');
      expect(context).toContain('req-interview was active: slug demo');
      expect(context).toContain('Done: scope (1)');
      expect(context).toContain('Current: fork (running)');
      expect(context).toContain('Spec scope: /a/scope.md');
      expect(context).toContain('Flags: fork, unattended');
      expect(context).toContain(`Context: ${join(tempDir, 'ctx.md')}`);
      expect(context).toContain(`Skill file: ${join(tempDir, 'skill', 'SKILL.md')}`);
      expect(context).toContain(`Fork progress log: ${join(tempDir, 'work', 'demo.progress.log')}`);
      expect(context).toContain(`State: ${statePath}`);
      expect(context).toContain('The live state files above are authoritative.');
    });

    it('does not replay a finished run from an older checkpoint', () => {
      begin();
      expect(runHook(PRE_COMPACT, 'compact').status).toBe(0);
      node(STATE_SCRIPT, ['clear', '--session-id', sessionId]);
      expect(restoreContext()).not.toContain('req-interview was active');
    });

    it('does not replay a run whose slug changed after the checkpoint', () => {
      begin('first');
      expect(runHook(PRE_COMPACT, 'compact').status).toBe(0);
      begin('second');
      const context = restoreContext();
      expect(context).not.toContain('req-interview was active');
      expect(context).not.toContain('slug first');
    });

    it('replays a phase chain and a req-interview run together', () => {
      const sessionDir = join(stateDir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'phase-chain-state.json'), JSON.stringify({
        active: true,
        session_id: sessionId,
        phase_id: 'p02',
        chain_state_path: join(repo, 'phase-loop.state.json'),
        skill_path: join(tempDir, 'phase-loop', 'SKILL.md'),
      }));
      begin();
      write('demo', ['--spec', 'scope=/a/scope.md']);
      expect(runHook(PRE_COMPACT, 'compact').status).toBe(0);
      const context = restoreContext();
      expect(context).toContain('Phase chain was active at phase p02');
      expect(context).toContain('req-interview was active: slug demo');
    });

    it('still restores a checkpoint written before the req_interview key existed', () => {
      const sessionDir = join(stateDir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'precompact-checkpoint.json'), JSON.stringify({
        session_id: sessionId,
        written_at: new Date().toISOString(),
        ralph: { active: true, iteration: 2, max_iterations: 10, prompt: 'task' },
        deep_interview: null,
      }));
      writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: false }));
      const context = restoreContext();
      expect(context).toContain('Ralph was active: iteration 2/10');
      expect(context).not.toContain('req-interview');
    });

    it('lets the state script, the manual script and the hooks agree on one file even with a foreign plugin root', () => {
      const foreign = join(tempDir, 'foreign-plugin');
      mkdirSync(foreign, { recursive: true });
      expect(node(STATE_SCRIPT, beginArgs(), { pluginRoot: foreign }).status).toBe(0);
      expect(node(STATE_SCRIPT, ['write', '--session-id', sessionId, '--slug', 'demo', '--spec', 'scope=/a/scope.md'], { pluginRoot: foreign }).status).toBe(0);

      const manual = node(COMPACT_CHECKPOINT, ['--session-id', sessionId, '--directory', repo], { pluginRoot: foreign });
      expect(manual.stdout).toContain('req-interview active: slug demo');
      expect(manual.stdout).toContain(`State: ${statePath}`);

      expect(runHook(PRE_COMPACT, 'compact', REPO_ROOT).status).toBe(0);
      expect(restoreContext(REPO_ROOT)).toContain('req-interview was active: slug demo');
    });

    it('keeps the superproject state root when run from inside a submodule', () => {
      const inner = join(tempDir, 'inner');
      mkdirSync(inner, { recursive: true });
      execSync('git init --quiet', { cwd: inner, windowsHide: true });
      writeFileSync(join(inner, 'a.txt'), 'a');
      execSync(`git ${GIT.join(' ')} add a.txt`, { cwd: inner, windowsHide: true });
      execSync(`git ${GIT.join(' ')} commit --quiet -m init`, { cwd: inner, windowsHide: true });
      writeFileSync(join(repo, 'b.txt'), 'b');
      execSync(`git ${GIT.join(' ')} add b.txt`, { cwd: repo, windowsHide: true });
      execSync(`git ${GIT.join(' ')} commit --quiet -m init`, { cwd: repo, windowsHide: true });
      execSync(`git ${GIT.join(' ')} -c protocol.file.allow=always submodule add --quiet "${inner.replace(/\\/g, '/')}" sub`, { cwd: repo, windowsHide: true });
      const sub = join(repo, 'sub');

      const foreign = join(tempDir, 'foreign-plugin');
      mkdirSync(foreign, { recursive: true });
      const result = node(STATE_SCRIPT, beginArgs(), { cwd: sub, pluginRoot: foreign });
      expect(result.status).toBe(0);
      expect(existsSync(statePath)).toBe(true);
      expect(existsSync(join(sub, '.lmgh'))).toBe(false);
    });
  });

  describe('commands written in the skill files', () => {
    function tokenize(line: string): string[] {
      const out: string[] = [];
      let current = '';
      let quoted = false;
      let started = false;
      for (const ch of line) {
        if (ch === '"') {
          quoted = !quoted;
          started = true;
          continue;
        }
        if (!quoted && /\s/.test(ch)) {
          if (started) out.push(current);
          current = '';
          started = false;
          continue;
        }
        current += ch;
        started = true;
      }
      if (started) out.push(current);
      return out;
    }

    function section(text: string, heading: string): string {
      const lines = text.split(/\r?\n/);
      const out: string[] = [];
      let inside = false;
      let fenced = false;
      for (const line of lines) {
        if (line.startsWith('```')) fenced = !fenced;
        if (!fenced && /^# /.test(line)) {
          if (inside) break;
          inside = line === heading;
        }
        if (inside) out.push(line);
      }
      return out.join('\n');
    }

    function commandsIn(text: string): string[] {
      const out: string[] = [];
      const fence = /```[a-z]*\r?\n([\s\S]*?)```/g;
      let match: RegExpExecArray | null;
      while ((match = fence.exec(text)) !== null) {
        const body = match[1].trim();
        if (body.includes('<state_script>')) out.push(body);
      }
      return out;
    }

    function substitute(command: string): string[] {
      const values: Record<string, string> = {
        state_script: STATE_SCRIPT,
        session_id: sessionId,
        slug: 'demo',
        goal_file: join(tempDir, 'goal dir', 'goal.md'),
        context_path: 'null',
        origin_path: 'null',
        repo_root: 'null',
        use_fork: 'false',
        unattended: 'false',
        verbatim_blocks: 'false',
        scope_only: 'false',
        name_prefix: 'null',
        work_dir: join(tempDir, 'work dir'),
        skill_file: join(tempDir, 'skill dir', 'SKILL.md'),
        progress_path: join(tempDir, 'work dir', 'demo.progress.log'),
        result_path: join(tempDir, 'work dir', 'demo.result.md'),
        fork_name_path: 'null',
        blocks_path: 'null',
        key: 'scope',
        spec_path: join(tempDir, 'specs dir', 'spec.md'),
        item: 'edge',
        next_item: 'functional',
        reason: 'fork-audit:scope 경계 확장 필요',
      };
      const filled = command.replace(/<([a-z_]+)>/g, (_whole, name: string) => {
        if (name in values) return values[name];
        if (name.endsWith('_spec')) return join(tempDir, 'specs dir', `${name}.md`);
        throw new Error(`unknown placeholder <${name}>`);
      });
      return tokenize(filled);
    }

    function runCommand(command: string) {
      const tokens = substitute(command);
      expect(tokens[0]).toBe('node');
      return spawnSync(process.execPath, tokens.slice(1), {
        cwd: repo,
        env: env(),
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 30000,
      });
    }

    function kindOf(command: string): string {
      return substitute(command)[2];
    }

    it('runs every command of the req-interview progress record section against the script', () => {
      const text = readFileSync(REQ_SKILL, 'utf-8');
      const commands = commandsIn(section(text, '# 진행 기록'));
      const kinds = commands.map(kindOf);
      expect(kinds.filter((kind) => kind === 'begin')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'clear')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'write').length).toBeGreaterThanOrEqual(4);
      expect(kinds.every((kind) => ['begin', 'write', 'clear'].includes(kind))).toBe(true);

      for (const command of commands) {
        const kind = kindOf(command);
        rmSync(join(stateDir, 'sessions', sessionId), { recursive: true, force: true });
        if (kind !== 'begin') expect(begin().status).toBe(0);
        const result = runCommand(command);
        expect(result.status, `${command}\n${result.stderr}`).toBe(0);
        if (kind === 'clear') {
          expect(existsSync(statePath)).toBe(false);
          continue;
        }
        const state = readState();
        expect(state.slug).toBe('demo');
        expect(state.active).toBe(true);
        const tokens = substitute(command);
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === '--spec') {
            const [key, ...rest] = tokens[i + 1].split('=');
            expect(state.specs[key]).toBe(rest.join('='));
          }
          if (tokens[i] === '--current') {
            const value = tokens[i + 1];
            if (value === 'none') expect(state.current).toBeNull();
            else expect(state.current.item).toBe(value.split(':')[0]);
          }
        }
        if (kind === 'begin') {
          expect(state.specs).toEqual({});
          expect(state.skill_file).toBe(join(tempDir, 'skill dir', 'SKILL.md'));
          expect(state.work_dir).toBe(join(tempDir, 'work dir'));
          expect(state.goal_file).toBe(join(tempDir, 'goal dir', 'goal.md'));
        }
      }
    });

    it('runs the cancel skill command that removes the progress record', () => {
      const text = readFileSync(CANCEL_SKILL, 'utf-8');
      const commands = commandsIn(text);
      expect(commands.length).toBeGreaterThanOrEqual(1);
      for (const command of commands) {
        expect(kindOf(command)).toBe('clear');
        expect(begin().status).toBe(0);
        const result = runCommand(command);
        expect(result.status, `${command}\n${result.stderr}`).toBe(0);
        expect(existsSync(statePath)).toBe(false);
      }
    });
  });
});
