import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execFileSync, execSync, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as engine from '../../scripts/lib/stop-control.mjs';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'stop-layer.mjs');
const STOP_HOOK = join(REPO_ROOT, 'hooks', 'ralph-stop.mjs');
const MODULE = join(REPO_ROOT, 'dist', 'lib', 'stop-control.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!existsSync(MODULE))('stop-layer script', () => {
  let tempDir: string;
  let repo: string;
  let sessionDir: string;
  const sessionId = 'stop-layer-test';

  beforeEach(() => {
    tempDir = join(tmpdir(), `lmgh-test-stop-layer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    tempDir = realpathSync.native(tempDir);
    repo = join(tempDir, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init --quiet', { cwd: repo, windowsHide: true });
    repo = realpathSync.native(repo);
    sessionDir = join(repo, '.lmgh', 'state', 'sessions', sessionId);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      return;
    }
  });

  function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const merged: Record<string, string | undefined> = {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      CLAUDE_CODE_SESSION_ID: undefined,
      LMGH_SESSION_ID: undefined,
      LMGH_STATE_DIR: undefined,
      CLAUDE_PLUGIN_ROOT: undefined,
      DISABLE_LMGH: undefined,
      LMGH_SKIP_HOOKS: undefined,
      LMGH_SECURITY: undefined,
      ...extra,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) delete merged[key];
    }
    return merged as NodeJS.ProcessEnv;
  }

  function run(args: string[], extra: Record<string, string | undefined> = {}): RunResult {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: repo,
        env: env(extra),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 30000,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      return { status: typeof err.status === 'number' ? err.status : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  const on = (owner: string, ...more: string[]) =>
    run(['on', '--owner', owner, '--project-dir', repo, '--session-id', sessionId, ...more]);

  const layerFile = (layer: string) => join(sessionDir, `${layer}-stop-state.json`);
  const readLayer = (layer: string): Record<string, unknown> => JSON.parse(readFileSync(layerFile(layer), 'utf-8'));

  function runHook(session: string | null = sessionId): { decision?: string; reason?: string } {
    const result = spawnSync(process.execPath, [STOP_HOOK], {
      cwd: repo,
      env: env(),
      input: JSON.stringify({
        ...(session === null ? {} : { session_id: session }),
        cwd: repo,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  it('turns on the second layer first and writes a record the hook validator accepts', () => {
    const result = on('demo');
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out).toMatchObject({ ok: true, owner: 'demo', layer: 'second', project_path: repo, max_iterations: 100 });
    const record = readLayer('second');
    expect(record.owner).toBe('demo');
    expect(record.active).toBe(true);
    expect(record.iteration).toBe(0);
    expect(record.session_id).toBe(sessionId);
    expect(record.project_path).toBe(repo);
    expect(engine.validateRecord(record)).toEqual({ valid: true });
  });

  it('makes the Stop hook hold the session', () => {
    expect(on('demo').status).toBe(0);
    const output = runHook();
    expect(output.decision).toBe('block');
    expect(output.reason?.startsWith('[STOP-LAYER second:demo - ITERATION 1/100]')).toBe(true);
    expect(readLayer('second').iteration).toBe(1);
  });

  it('keeps the layer the owner already holds and moves other owners to the next free layer', () => {
    expect(JSON.parse(on('demo').stdout).layer).toBe('second');
    expect(JSON.parse(on('demo').stdout).layer).toBe('second');
    expect(JSON.parse(on('other').stdout).layer).toBe('third');
    expect(JSON.parse(on('third-owner').stdout).layer).toBe('first');
    const full = on('fourth');
    expect(full.status).toBe(1);
    expect(full.stderr).toContain('no free layer');
  });

  it('refuses an explicit layer that another owner holds', () => {
    expect(on('demo', '--layer', 'first').status).toBe(0);
    const taken = on('other', '--layer', 'first');
    expect(taken.status).toBe(1);
    expect(taken.stderr).toContain('layer occupied by demo');
    expect(readLayer('first').owner).toBe('demo');
  });

  it('takes a layer back from an inactive owner', () => {
    expect(on('demo', '--layer', 'first').status).toBe(0);
    expect(run(['off', '--owner', 'demo', '--project-dir', repo, '--session-id', sessionId]).status).toBe(0);
    expect(on('other', '--layer', 'first').status).toBe(0);
    expect(readLayer('first').owner).toBe('other');
  });

  it('refresh moves last_checked_at forward and nothing else the hook counts', () => {
    expect(on('demo').status).toBe(0);
    const record = readLayer('second');
    const old = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    writeFileSync(layerFile('second'), JSON.stringify({ ...record, last_checked_at: old, iteration: 7 }));
    const result = run(['refresh', '--owner', 'demo', '--session-id', sessionId]);
    expect(result.status).toBe(0);
    const after = readLayer('second');
    expect(Date.parse(String(after.last_checked_at))).toBeGreaterThan(Date.parse(old));
    expect(after.iteration).toBe(7);
    expect(after.active).toBe(true);
  });

  it('refresh and off exit 4 when the owner holds no layer', () => {
    expect(run(['refresh', '--owner', 'demo', '--session-id', sessionId]).status).toBe(4);
    expect(run(['off', '--owner', 'demo', '--session-id', sessionId]).status).toBe(4);
    expect(on('demo').status).toBe(0);
    expect(run(['refresh', '--owner', 'someone-else', '--session-id', sessionId]).status).toBe(4);
  });

  it('off makes the record inactive and lets the turn end', () => {
    expect(on('demo').status).toBe(0);
    expect(run(['off', '--owner', 'demo', '--session-id', sessionId]).status).toBe(0);
    expect(readLayer('second').active).toBe(false);
    expect(runHook().decision).toBeUndefined();
  });

  it('status lists the three layers', () => {
    expect(on('demo').status).toBe(0);
    const out = JSON.parse(run(['status', '--session-id', sessionId]).stdout);
    expect(out.layers.map((l: { layer: string }) => l.layer)).toEqual(['first', 'second', 'third']);
    const second = out.layers[1];
    expect(second).toMatchObject({ present: true, owner: 'demo', active: true, stale: false, iteration: 0, max_iterations: 100 });
    expect(out.layers[0].present).toBe(false);
  });

  it('fails closed on bad input', () => {
    expect(run(['on', '--owner', 'demo', '--session-id', sessionId]).stderr).toContain('--project-dir is required');
    expect(run(['on', '--owner', 'demo', '--project-dir', 'relative/dir', '--session-id', sessionId]).stderr).toContain('absolute path');
    expect(run(['on', '--owner', 'demo', '--project-dir', join(tempDir, 'missing'), '--session-id', sessionId]).stderr).toContain('not an existing directory');
    expect(run(['on', '--project-dir', repo, '--session-id', sessionId]).stderr).toContain('--owner is required');
    expect(on('Bad Owner').status).toBe(1);
    expect(on('demo', '--layer', 'fourth').stderr).toContain('--layer must be one of');
    expect(on('demo', '--max-iterations', '0').stderr).toContain('--max-iterations must be a positive integer');
    expect(run(['on', '--owner', 'demo', '--project-dir', repo]).stderr).toContain('no session id');
    expect(run(['nope']).stderr).toContain('usage');
    expect(run(['status', '--bogus', 'x', '--session-id', sessionId]).stderr).toContain('unknown option');
  });

  it('reads the session id from CLAUDE_CODE_SESSION_ID', () => {
    const result = run(['on', '--owner', 'demo', '--project-dir', repo], { CLAUDE_CODE_SESSION_ID: sessionId });
    expect(result.status).toBe(0);
    expect(existsSync(layerFile('second'))).toBe(true);
  });

  it('prefers --session-id over CLAUDE_CODE_SESSION_ID', () => {
    const result = run(
      ['on', '--owner', 'demo', '--project-dir', repo, '--session-id', sessionId],
      { CLAUDE_CODE_SESSION_ID: 'env-session' },
    );
    expect(result.status).toBe(0);
    expect(existsSync(layerFile('second'))).toBe(true);
    expect(existsSync(join(repo, '.lmgh', 'state', 'sessions', 'env-session'))).toBe(false);
  });

  describe('--input-file', () => {
    const chainFields = {
      chain_state_path: 'C:/out/phase-loop.state.json',
      skill_path: 'C:/skills/phase-loop/SKILL.md',
      executor_skill_path: 'C:/skills/phase-exec/SKILL.md',
      phase_id: 'p1',
    };

    function writeInput(content: unknown, name = 'input.json'): string {
      const file = join(tempDir, name);
      writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
      return file;
    }

    const onWithInput = (file: string, ...more: string[]) => on('phase-chain', '--input-file', file, ...more);

    it('writes a phase-chain record the hook renders', () => {
      const file = writeInput({ profile: 'phase-chain', fields: chainFields });
      const result = onWithInput(file, '--layer', 'second');
      expect(result.status).toBe(0);
      const record = readLayer('second');
      expect(record).toMatchObject({ owner: 'phase-chain', active: true, iteration: 0, ...chainFields });
      expect(engine.validateRecord(record)).toEqual({ valid: true });
      const output = runHook();
      expect(output.decision).toBe('block');
      expect(output.reason).toContain('[PHASE-CHAIN] A phase chain is in progress.');
      expect(output.reason).toContain(chainFields.chain_state_path);
    });

    it('merges custom messages over the profile messages', () => {
      const file = writeInput({ messages: { continue: 'HOLD {owner} {next}/{max}' } });
      expect(on('demo', '--input-file', file).status).toBe(0);
      expect(runHook().reason).toContain('HOLD demo 1/100');
    });

    it('ignores reserved keys inside fields', () => {
      const file = writeInput({ profile: 'phase-chain', fields: { ...chainFields, owner: 'evil', active: false } });
      expect(onWithInput(file).status).toBe(0);
      const record = readLayer('second');
      expect(record.owner).toBe('phase-chain');
      expect(record.active).toBe(true);
    });

    it('fails closed on a bad input file and writes nothing', () => {
      const cases: Array<[string, string, string]> = [
        ['relative path', 'input.json', 'absolute path'],
        ['missing file', join(tempDir, 'missing.json'), 'input file'],
        ['not json', writeInput('{nope', 'bad.json'), 'JSON'],
        ['not an object', writeInput('[1]', 'array.json'), 'JSON object'],
        ['unknown key', writeInput({ owner: 'x' }, 'key.json'), 'unknown key'],
        ['too large', writeInput({ messages: { continue: 'x'.repeat(70 * 1024) } }, 'big.json'), 'too large'],
        ['unknown profile', writeInput({ profile: 'nope' }, 'profile.json'), ''],
      ];
      for (const [label, file, expected] of cases) {
        const result = on('demo', '--input-file', file);
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toContain(expected);
      }
      expect(existsSync(layerFile('second'))).toBe(false);
    });

    it('keeps the generic record without --input-file', () => {
      expect(on('demo').status).toBe(0);
      expect(readLayer('second').token_fields).toEqual([]);
    });
  });

  describe('on again', () => {
    it('resets iteration to 0 when the same owner calls on again', () => {
      expect(on('demo').status).toBe(0);
      expect(runHook().decision).toBe('block');
      expect(readLayer('second').iteration).toBe(1);
      expect(on('demo').status).toBe(0);
      expect(readLayer('second').iteration).toBe(0);
    });
  });

  describe('clear', () => {
    const clear = (...args: string[]) => run(['clear', '--project-dir', repo, '--session-id', sessionId, ...args]);

    it('--owner removes only that owner layer and exits 0', () => {
      expect(on('demo').status).toBe(0);
      expect(on('other').status).toBe(0);
      const result = clear('--owner', 'demo');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: 'clear', owner: 'demo', cleared: 1 });
      expect(existsSync(layerFile('second'))).toBe(false);
      expect(readLayer('third').owner).toBe('other');
    });

    it('--owner exits 4 when the owner holds no layer', () => {
      expect(on('demo').status).toBe(0);
      expect(clear('--owner', 'someone-else').status).toBe(4);
      expect(clear('--owner', 'demo').status).toBe(0);
      expect(clear('--owner', 'demo').status).toBe(4);
    });

    it('--all removes every layer record whatever the owner', () => {
      expect(on('demo').status).toBe(0);
      expect(on('other').status).toBe(0);
      expect(on('third-owner').status).toBe(0);
      const result = clear('--all');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: 'clear', cleared: 3 });
      for (const layer of ['first', 'second', 'third']) expect(existsSync(layerFile(layer))).toBe(false);
      expect(runHook().decision).toBeUndefined();
    });

    it('--all exits 4 when there is nothing to clear', () => {
      expect(clear('--all').status).toBe(4);
    });

    it('requires exactly one of --owner and --all', () => {
      expect(clear().stderr).toContain('--owner or --all');
      expect(clear('--owner', 'demo', '--all').stderr).toContain('only one of');
    });
  });

  describe('session isolation', () => {
    const other = 'other-session';
    const asOther = (...args: string[]) => run([...args, '--session-id', other]);

    it('holds the owning session and lets other sessions end the turn', () => {
      expect(on('demo').status).toBe(0);
      expect(runHook(sessionId).decision).toBe('block');
      expect(runHook(other).decision).toBeUndefined();
      expect(runHook(null).decision).toBeUndefined();
    });

    it('refresh, off and clear from another session leave the record alone and exit 4', () => {
      expect(on('demo').status).toBe(0);
      const before = readFileSync(layerFile('second'), 'utf-8');
      expect(asOther('refresh', '--owner', 'demo').status).toBe(4);
      expect(asOther('off', '--owner', 'demo').status).toBe(4);
      expect(asOther('clear', '--owner', 'demo', '--project-dir', repo).status).toBe(4);
      expect(asOther('clear', '--all', '--project-dir', repo).status).toBe(4);
      expect(readFileSync(layerFile('second'), 'utf-8')).toBe(before);
    });

    it('auto picks from the calling session only', () => {
      expect(on('demo').status).toBe(0);
      const result = run(['on', '--owner', 'other-owner', '--project-dir', repo, '--session-id', other]);
      expect(JSON.parse(result.stdout).layer).toBe('second');
    });
  });
});
