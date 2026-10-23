import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as engine from '../../scripts/lib/stop-control.mjs';

const NOW_ISO = '2026-10-18T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const STATE_PATH = '/state/sessions/s1/ralph-state.json';

type Rec = Record<string, unknown>;

function nativeRecord(overrides: Rec = {}): Rec {
  const profile = engine.getProfile('ralph');
  return {
    owner: 'ralph',
    active: true,
    session_id: 's1',
    project_path: '/proj',
    started_at: NOW_ISO,
    last_checked_at: NOW_ISO,
    iteration: 1,
    max_iterations: 100,
    on_cap: profile.on_cap,
    cap_step: profile.cap_step,
    hard_max_applies: profile.hard_max_applies,
    tool_error_guidance: profile.tool_error_guidance,
    token_fields: profile.token_fields,
    messages: profile.messages,
    ...overrides,
  };
}

function chainRecord(overrides: Rec = {}): Rec {
  const profile = engine.getProfile('phase-chain');
  return nativeRecord({
    owner: 'phase-chain',
    on_cap: profile.on_cap,
    cap_step: undefined,
    hard_max_applies: false,
    tool_error_guidance: false,
    token_fields: profile.token_fields,
    messages: profile.messages,
    iteration: 0,
    phase_id: 'p1',
    chain_state_path: 'x',
    skill_path: 'y',
    executor_skill_path: 'z',
    ...overrides,
  });
}

const NO_PENDING = { kind: 'none', tasks: [] };
const ENV = { hardMax: () => 0, toolErrorGuidance: () => '' };

function layerOf(raw: Rec, layer = 'first', path = STATE_PATH) {
  return engine.buildLayer(layer, { state: raw, path, isGlobal: false });
}

describe('stop-control engine: names and profiles', () => {
  it('names layer files and modes', () => {
    expect(engine.STOP_LAYERS).toEqual(['first', 'second', 'third']);
    expect(engine.layerStateFile('first')).toBe('first-stop-state.json');
    expect(engine.layerStateFile('second')).toBe('second-stop-state.json');
    expect(engine.layerStateFile('third')).toBe('third-stop-state.json');
    expect(engine.layerModeName('third')).toBe('third-stop');
  });

  it('keeps the profile file readable through getProfile', () => {
    const onDisk = JSON.parse(readFileSync(fileURLToPath(new URL('../../scripts/lib/stop-profiles.json', import.meta.url)), 'utf8'));
    expect(engine.getProfile('ralph')).toEqual(onDisk.ralph);
    expect(engine.getProfile('phase-chain')).toEqual(onDisk['phase-chain']);
    expect(engine.getProfile('generic')).toEqual(onDisk.generic);
    expect(engine.getProfile('ralph')).not.toBe(engine.getProfile('ralph'));
  });
});

describe('stop-control engine: rendering', () => {
  it('substitutes known tokens in a single pass and leaves unknown braces', () => {
    const out = engine.renderTemplate('a {next} b {unknown} c {phase_id}', { next: 7 }, { phase_id: '{next}' }, ['phase_id']);
    expect(out).toBe('a 7 b {unknown} c {next}');
  });

  it('prints undefined for a token field the record lacks', () => {
    expect(engine.renderTemplate('{phase_id}', {}, {}, ['phase_id'])).toBe('undefined');
  });
});

describe('stop-control engine: record validation', () => {
  it('accepts a complete native record', () => {
    expect(engine.validateRecord(nativeRecord())).toEqual({ valid: true });
  });

  it.each([
    ['owner pattern', { owner: 'Ralph!' }],
    ['non-boolean active', { active: 'false' }],
    ['fractional iteration', { iteration: 1.5 }],
    ['negative iteration', { iteration: -1 }],
    ['zero max_iterations', { max_iterations: 0 }],
    ['fractional max_iterations', { max_iterations: 2.5 }],
    ['non ISO started_at', { started_at: 'yesterday' }],
    ['non ISO last_checked_at', { last_checked_at: '2026-10-18' }],
    ['empty project_path', { project_path: '' }],
    ['unknown on_cap', { on_cap: 'sometimes' }],
    ['missing messages', { messages: undefined }],
    ['missing continue', { messages: { hard_limit: 'h', wait_tag: 'w', extended: 'e' } }],
    ['extend without extended', { on_cap: 'extend', messages: { continue: 'c', hard_limit: 'h', wait_tag: 'w' } }],
    ['literal not an array', { messages: { ...engine.getProfile('ralph').messages, continue_literal: 'x' } }],
    ['literal with non-string', { messages: { ...engine.getProfile('ralph').messages, continue_literal: [1] } }],
    ['message too long', { messages: { ...engine.getProfile('ralph').messages, continue: 'x'.repeat(4001) } }],
    ['literal too many lines', { messages: { ...engine.getProfile('ralph').messages, continue_literal: Array(21).fill('a') } }],
    ['literal line too long', { messages: { ...engine.getProfile('ralph').messages, continue_literal: ['x'.repeat(2001)] } }],
    ['too many token fields', { token_fields: Array.from({ length: 17 }, (_, i) => `f${i}`) }],
    ['token field value too long', { token_fields: ['big'], big: 'x'.repeat(2001) }],
  ])('rejects %s', (_label, overrides) => {
    expect(engine.validateRecord(nativeRecord(overrides as Rec)).valid).toBe(false);
  });

  it('accepts a token field that the record does not carry', () => {
    expect(engine.validateRecord(nativeRecord({ token_fields: ['absent'] })).valid).toBe(true);
  });
});

describe('stop-control engine: reading layers', () => {
  it.each(['first', 'second', 'third'])('reads only the native file of the %s layer', (layer) => {
    const reads: string[] = [];
    const found = engine.readLayer(layer, {
      readState: (file: string) => {
        reads.push(file);
        return { state: null, path: '/none', isGlobal: false };
      },
    });
    expect(found).toBeNull();
    expect(reads).toEqual([`${layer}-stop-state.json`]);
  });

  it('returns the native record with its path', () => {
    const found = engine.readLayer('first', {
      readState: () => ({ state: nativeRecord(), path: '/native', isGlobal: false }),
    });
    expect(found.path).toBe('/native');
    expect(found.rec.owner).toBe('ralph');
  });
});

describe('stop-control engine: refresh and decide', () => {
  it('refreshes last_checked_at and the background wait marker', () => {
    const layer = layerOf(nativeRecord({ background_wait_at: NOW_ISO }));
    engine.refreshInMemory(layer, 'none', '2026-10-18T01:00:00.000Z');
    expect(layer.rec.last_checked_at).toBe('2026-10-18T01:00:00.000Z');
    expect('background_wait_at' in layer.rec).toBe(false);
    engine.refreshInMemory(layer, 'nudge', '2026-10-18T02:00:00.000Z');
    expect(layer.rec.background_wait_at).toBe('2026-10-18T02:00:00.000Z');
  });

  it('increments and blocks while under the cap', () => {
    const layer = layerOf(
      nativeRecord({ messages: { ...engine.getProfile('ralph').messages, continue_literal: ['Full task text: the prompt field of ' + STATE_PATH] } }),
    );
    const out = engine.decide(layer, NO_PENDING, ENV);
    expect(out.verdict.allow).toBe(false);
    expect(out.verdict.reason).toBe(
      '[RALPH LOOP - ITERATION 2/100] Work is NOT done. Continue working. After reviewer verification: /let-me-go-home:cancel\nFull task text: the prompt field of ' + STATE_PATH,
    );
    expect(layer.rec.iteration).toBe(2);
  });

  it('ends the reason with a newline when the literal is empty', () => {
    const layer = layerOf(nativeRecord());
    const out = engine.decide(layer, NO_PENDING, ENV);
    expect(out.verdict.reason.endsWith('/let-me-go-home:cancel\n')).toBe(true);
  });

  it('puts the tool error guidance before the reason when the record asks for it', () => {
    const layer = layerOf(nativeRecord());
    const out = engine.decide(layer, NO_PENDING, { ...ENV, toolErrorGuidance: () => 'GUIDE\n' });
    expect(out.verdict.reason.startsWith('GUIDE\n[RALPH LOOP - ITERATION 2/100]')).toBe(true);
    const plain = layerOf(nativeRecord({ tool_error_guidance: false }));
    expect(engine.decide(plain, NO_PENDING, { ...ENV, toolErrorGuidance: () => 'GUIDE\n' }).verdict.reason.startsWith('[RALPH LOOP')).toBe(true);
  });

  it('extends by cap_step at the cap for an extend profile', () => {
    const layer = layerOf(nativeRecord({ iteration: 100 }));
    const out = engine.decide(layer, NO_PENDING, ENV);
    expect(out.verdict.reason).toBe('[RALPH LOOP - EXTENDED] Max iterations reached; extending to 110 and continuing. When FULLY complete (after reviewer verification), run /let-me-go-home:cancel (or --force).');
    expect(layer.rec.max_iterations).toBe(110);
    expect(layer.rec.iteration).toBe(100);
  });

  it('disables at the hard max and blocks once', () => {
    const layer = layerOf(nativeRecord({ iteration: 50, max_iterations: 50 }));
    const out = engine.decide(layer, NO_PENDING, { ...ENV, hardMax: () => 50 });
    expect(out.verdict.reason).toBe('[RALPH LOOP - HARD LIMIT] Reached hard max iterations (50). Mode auto-disabled. Restart with /let-me-go-home:ralph if needed.');
    expect(layer.rec.active).toBe(false);
  });

  it('ignores the hard max when the record does not apply it', () => {
    const layer = layerOf(nativeRecord({ iteration: 50, max_iterations: 50, hard_max_applies: false }));
    engine.decide(layer, NO_PENDING, { ...ENV, hardMax: () => 50 });
    expect(layer.rec.max_iterations).toBe(60);
    expect(layer.rec.active).toBe(true);
  });

  it('disables a disable-profile chain at the cap and keeps the normalized iteration', () => {
    const layer = layerOf(chainRecord({ iteration: 100 }), 'third', '/state/third-stop-state.json');
    const out = engine.decide(layer, NO_PENDING, ENV);
    expect(out.verdict.reason).toBe(
      '[PHASE-CHAIN - HARD LIMIT] Chain disabled after 100 blocked stops in phase p1.\nMark the running phase in x as stopped with reason chain-hard-limit, then follow the 보고 step of y.',
    );
    expect(layer.rec.active).toBe(false);
    expect(layer.rec.iteration).toBe(100);
  });

  it('renders the chain reason from the record token fields', () => {
    const layer = layerOf(chainRecord(), 'third', '/state/third-stop-state.json');
    const out = engine.decide(layer, NO_PENDING, ENV);
    expect(out.verdict.reason).toBe(
      '[PHASE-CHAIN] A phase chain is in progress. Read x and follow the re-entry rule in y.\nThe executor skill is at z.\nTo stop the chain, run /let-me-go-home:cancel --chain.',
    );
    expect(layer.rec.iteration).toBe(1);
  });

  it('allows on defer and blocks with the profile wait tag on nudge without counting', () => {
    const defer = layerOf(nativeRecord());
    expect(engine.decide(defer, { kind: 'defer', tasks: [] }, ENV).verdict.allow).toBe(true);
    expect(defer.rec.iteration).toBe(1);
    const nudge = layerOf(chainRecord(), 'third', '/state/third-stop-state.json');
    const out = engine.decide(nudge, { kind: 'nudge', tasks: [{ type: 'bash', id: 'b' }] }, ENV);
    expect(out.verdict.allow).toBe(false);
    expect(out.verdict.reason.startsWith('[PHASE-CHAIN - WAITING] Background work is still running: bash b.')).toBe(true);
    expect(nudge.rec.iteration).toBe(0);
  });

  it('renders generic profile names from layer and owner', () => {
    const profile = engine.getProfile('generic');
    const raw = nativeRecord({ owner: 'demo', on_cap: 'disable', cap_step: undefined, hard_max_applies: false, tool_error_guidance: false, token_fields: [], messages: profile.messages });
    const layer = layerOf(raw, 'second');
    const out = engine.decide(layer, NO_PENDING, ENV);
    expect(out.verdict.reason).toBe('[STOP-LAYER second:demo - ITERATION 2/100] Work is NOT done. Continue the owning task. To stop it, run /let-me-go-home:cancel --layer second');
  });
});

describe('stop-control engine: comparison', () => {
  it('compares deeply and ignores key order', () => {
    expect(engine.deepEqualIgnoringKeyOrder({ a: 1, b: { c: [1, { d: 2 }], e: null } }, { b: { e: null, c: [1, { d: 2 }] }, a: 1 })).toBe(true);
    expect(engine.deepEqualIgnoringKeyOrder({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(engine.deepEqualIgnoringKeyOrder([1, 2], [2, 1])).toBe(false);
    expect(engine.deepEqualIgnoringKeyOrder({ a: 1 }, { a: '1' })).toBe(false);
  });
});

function memory(initial: Record<string, Rec>) {
  const files = new Map<string, Rec>(Object.entries(initial).map(([path, value]) => [path, structuredClone(value)]));
  const writes: Array<{ path: string; value: Rec }> = [];
  const logs: string[] = [];
  const state = { lockFails: false, writeFails: false, ms: NOW_MS, mutateBeforeRead: [] as Array<(files: Map<string, Rec>) => void> };
  const deps: Record<string, any> = {
    nowIso: () => new Date(state.ms).toISOString(),
    nowMs: () => state.ms,
    startMs: NOW_MS,
    acquireLock: (_path: string, attempts: number) => (state.lockFails ? null : { attempts }),
    releaseLock: () => undefined,
    readJson: (path: string) => {
      const mutate = state.mutateBeforeRead.shift();
      if (mutate) mutate(files);
      return files.has(path) ? structuredClone(files.get(path)) : null;
    },
    writeJson: (path: string, value: Rec) => {
      if (state.writeFails) throw new Error('disk');
      writes.push({ path, value: structuredClone(value) });
      files.set(path, structuredClone(value));
    },
    log: (entry: Record<string, unknown>) => logs.push(`${entry.fn} ${entry.reason} ${entry.layer} ${entry.owner}`),
    env: ENV,
    isLive: () => true,
  };
  return { files, writes, logs, state, deps };
}

describe('stop-control engine: commitDecision', () => {
  it('writes the record and returns the verdict', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    const layer = layerOf(nativeRecord());
    engine.refreshInMemory(layer, 'none', NOW_ISO);
    const out = engine.commitDecision(layer, NO_PENDING, mem.deps);
    expect(out.allow).toBe(false);
    expect(mem.writes).toHaveLength(1);
    expect(mem.writes[0].value.iteration).toBe(2);
    expect(mem.logs).toEqual([]);
  });

  it('deletes the background marker when nothing is pending', () => {
    const raw = nativeRecord({ background_wait_at: NOW_ISO });
    const mem = memory({ [STATE_PATH]: raw });
    const layer = layerOf(raw);
    engine.refreshInMemory(layer, 'none', NOW_ISO);
    engine.commitDecision(layer, NO_PENDING, mem.deps);
    expect('background_wait_at' in mem.writes[0].value).toBe(false);
  });

  it('allows and logs when the lock cannot be taken', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    mem.state.lockFails = true;
    const layer = layerOf(nativeRecord());
    expect(engine.commitDecision(layer, NO_PENDING, mem.deps).allow).toBe(true);
    expect(mem.logs).toEqual(['commitDecision lock-unavailable first ralph']);
    expect(mem.writes).toHaveLength(0);
  });

  it('allows and logs when the deadline passed before taking the lock', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    mem.state.ms = NOW_MS + 6001;
    const layer = layerOf(nativeRecord());
    expect(engine.commitDecision(layer, NO_PENDING, mem.deps).allow).toBe(true);
    expect(mem.logs).toEqual(['commitDecision deadline-before-lock first ralph']);
  });

  it('allows and logs when the deadline passed while taking the lock', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    const layer = layerOf(nativeRecord());
    mem.deps.acquireLock = () => {
      mem.state.ms = NOW_MS + 6001;
      return {};
    };
    expect(engine.commitDecision(layer, NO_PENDING, mem.deps).allow).toBe(true);
    expect(mem.logs).toEqual(['commitDecision deadline-after-lock first ralph']);
    expect(mem.writes).toHaveLength(0);
  });

  it('blocks when the lock is taken after 3 s but inside the 6 s deadline', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    const layer = layerOf(nativeRecord());
    mem.state.ms = NOW_MS + 4500;
    mem.deps.acquireLock = () => {
      mem.state.ms = NOW_MS + 4600;
      return {};
    };
    expect(engine.commitDecision(layer, NO_PENDING, mem.deps).allow).toBe(false);
    expect(mem.logs).toEqual([]);
    expect(mem.writes).toHaveLength(1);
  });

  it('passes the deadline time to acquireLock', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    const seen: unknown[] = [];
    mem.deps.acquireLock = (...args: unknown[]) => {
      seen.push(args[2]);
      return {};
    };
    engine.commitDecision(layerOf(nativeRecord()), NO_PENDING, mem.deps);
    expect(seen).toEqual([NOW_MS + 6000]);
  });

  it('logs the elapsed time and the attempt number', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    const entries: Array<Record<string, unknown>> = [];
    mem.deps.log = (entry: Record<string, unknown>) => entries.push(entry);
    mem.state.mutateBeforeRead.push((files) => {
      files.set(STATE_PATH, nativeRecord({ iteration: 9 }));
      mem.state.ms = NOW_MS + 6001;
    });
    expect(engine.commitDecision(layerOf(nativeRecord()), NO_PENDING, mem.deps).allow).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ fn: 'commitDecision', reason: 'deadline-before-lock', elapsed_ms: 6001, attempt: 2 });
  });

  it('allows and logs when the file vanished', () => {
    const mem = memory({});
    const layer = layerOf(nativeRecord());
    expect(engine.commitDecision(layer, NO_PENDING, mem.deps).allow).toBe(true);
    expect(mem.logs).toEqual(['commitDecision file-missing first ralph']);
  });

  it('recomputes the verdict from the changed file and writes that result', () => {
    const changed = nativeRecord({ iteration: 40 });
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    mem.state.mutateBeforeRead.push((files) => files.set(STATE_PATH, structuredClone(changed)));
    const layer = layerOf(nativeRecord());
    engine.refreshInMemory(layer, 'none', NOW_ISO);
    const out = engine.commitDecision(layer, NO_PENDING, mem.deps);
    expect(out.reason.startsWith('[RALPH LOOP - ITERATION 41/100]')).toBe(true);
    expect(mem.writes).toHaveLength(1);
    expect(mem.writes[0].value.iteration).toBe(41);
    expect(mem.logs).toEqual([]);
  });

  it('allows and logs when the file keeps changing', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    mem.state.mutateBeforeRead.push((files) => files.set(STATE_PATH, nativeRecord({ iteration: 5 })));
    mem.state.mutateBeforeRead.push((files) => files.set(STATE_PATH, nativeRecord({ iteration: 6 })));
    const layer = layerOf(nativeRecord());
    expect(engine.commitDecision(layer, NO_PENDING, mem.deps).allow).toBe(true);
    expect(mem.logs).toEqual(['commitDecision changed-after-retry first ralph']);
    expect(mem.writes).toHaveLength(0);
  });

  it('allows without rewriting when the changed file is no longer live', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    mem.state.mutateBeforeRead.push((files) => files.set(STATE_PATH, nativeRecord({ active: false })));
    mem.deps.isLive = (l: { rec: Rec }) => Boolean(l.rec.active);
    const layer = layerOf(nativeRecord());
    expect(engine.commitDecision(layer, NO_PENDING, mem.deps).allow).toBe(true);
    expect(mem.logs).toEqual(['commitDecision changed-after-retry first ralph']);
    expect(mem.writes).toHaveLength(0);
  });

  it('allows and logs write-failed', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    mem.state.writeFails = true;
    const layer = layerOf(nativeRecord());
    expect(engine.commitDecision(layer, NO_PENDING, mem.deps).allow).toBe(true);
    expect(mem.logs).toEqual(['commitDecision write-failed first ralph']);
  });

  it('allows on defer and still writes the background marker', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    const layer = layerOf(nativeRecord());
    engine.refreshInMemory(layer, 'defer', NOW_ISO);
    const out = engine.commitDecision(layer, { kind: 'defer', tasks: [] }, mem.deps);
    expect(out.allow).toBe(true);
    expect(mem.writes[0].value.background_wait_at).toBe(NOW_ISO);
  });
});

describe('stop-control engine: persistRefresh', () => {
  it('writes the refreshed record', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    const layer = layerOf(nativeRecord());
    engine.refreshInMemory(layer, 'none', '2026-10-18T03:00:00.000Z');
    engine.persistRefresh(layer, mem.deps);
    expect(mem.writes[0].value.last_checked_at).toBe('2026-10-18T03:00:00.000Z');
  });

  it('skips and logs when the file changed, the lock failed, or the file is gone', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    mem.state.mutateBeforeRead.push((files) => files.set(STATE_PATH, nativeRecord({ iteration: 9 })));
    engine.persistRefresh(layerOf(nativeRecord()), mem.deps);
    mem.state.lockFails = true;
    engine.persistRefresh(layerOf(nativeRecord()), mem.deps);
    mem.state.lockFails = false;
    mem.files.clear();
    engine.persistRefresh(layerOf(nativeRecord()), mem.deps);
    expect(mem.logs).toEqual([
      'persistRefresh refresh-skipped first ralph',
      'persistRefresh refresh-skipped first ralph',
      'persistRefresh refresh-skipped first ralph',
    ]);
    expect(mem.writes).toHaveLength(0);
  });

  it('logs write-failed without throwing', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    mem.state.writeFails = true;
    expect(() => engine.persistRefresh(layerOf(nativeRecord()), mem.deps)).not.toThrow();
    expect(mem.logs).toEqual(['persistRefresh write-failed first ralph']);
  });

  it('passes the deadline time to acquireLock', () => {
    const mem = memory({ [STATE_PATH]: nativeRecord() });
    const seen: unknown[] = [];
    mem.deps.acquireLock = (...args: unknown[]) => {
      seen.push(args[2]);
      return {};
    };
    engine.persistRefresh(layerOf(nativeRecord()), mem.deps);
    expect(seen).toEqual([NOW_MS + 6000]);
  });
});

describe('stop-control engine: evaluateLayers', () => {
  function evalDeps(files: Record<string, Rec>, extra: Record<string, unknown> = {}) {
    const mem = memory(files);
    const stateByFile: Record<string, string> = {
      'first-stop-state.json': '/state/first-stop-state.json',
      'third-stop-state.json': '/state/third-stop-state.json',
    };
    const deps = {
      ...mem.deps,
      readState: (file: string) => {
        const path = stateByFile[file] ?? `/state/${file}`;
        const state = mem.files.get(path);
        return { state: state ? structuredClone(state) : null, path, isGlobal: false };
      },
      liveChecks: () => true,
      pending: NO_PENDING,
      ...extra,
    };
    return { mem, deps };
  }

  it('allows when no layer is live', () => {
    const { deps } = evalDeps({});
    expect(engine.evaluateLayers(deps)).toEqual({ allow: true });
  });

  it('lets the first live layer decide and refreshes the next live layer', () => {
    const { mem, deps } = evalDeps({ '/state/first-stop-state.json': nativeRecord(), '/state/third-stop-state.json': chainRecord() });
    const out = engine.evaluateLayers(deps);
    expect(out.allow).toBe(false);
    expect(out.reason.startsWith('[RALPH LOOP - ITERATION 2/100]')).toBe(true);
    const chainWrite = mem.writes.find((w) => w.path === '/state/third-stop-state.json');
    expect(chainWrite?.value.iteration).toBe(0);
    expect(chainWrite?.value.last_checked_at).toBe(NOW_ISO);
  });

  it('falls to the next layer when the first is not live', () => {
    const { deps } = evalDeps({ '/state/first-stop-state.json': nativeRecord({ active: false }), '/state/third-stop-state.json': chainRecord() });
    const out = engine.evaluateLayers(deps);
    expect(out.reason.startsWith('[PHASE-CHAIN]')).toBe(true);
  });

  it('drops a native record that fails validation and logs record-invalid', () => {
    const { mem, deps } = evalDeps({ '/state/first-stop-state.json': nativeRecord({ iteration: 1.5 }) });
    expect(engine.evaluateLayers(deps)).toEqual({ allow: true });
    expect(mem.logs).toEqual(['isLive record-invalid first ralph']);
  });

  it('skips layers the live checks reject', () => {
    const { deps } = evalDeps({ '/state/first-stop-state.json': nativeRecord() }, { liveChecks: () => false });
    expect(engine.evaluateLayers(deps)).toEqual({ allow: true });
  });

  it('logs the entry delay and the caller marks', () => {
    const marks = { import_ms: 20, stdin_ms: 32, root_ms: 140 };
    const entries: Array<Record<string, unknown>> = [];
    const log = (entry: Record<string, unknown>) => entries.push(entry);
    const { mem, deps } = evalDeps({ '/state/first-stop-state.json': nativeRecord() }, { marks, log });
    mem.state.ms = NOW_MS + 150;
    mem.state.lockFails = true;
    expect(engine.evaluateLayers(deps)).toEqual({ allow: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reason: 'lock-unavailable', elapsed_ms: 150, pre_ms: 150, attempt: 1, marks });
  });

  describe('with the second layer', () => {
    const FIRST_PATH = '/state/first-stop-state.json';
    const SECOND_PATH = '/state/second-stop-state.json';
    const THIRD_PATH = '/state/third-stop-state.json';
    const EARLIER_ISO = '2026-10-17T23:00:00.000Z';

    function firstRecord(overrides: Rec = {}): Rec {
      return nativeRecord({ iteration: 0, last_checked_at: EARLIER_ISO, ...overrides });
    }

    function secondRecord(overrides: Rec = {}): Rec {
      const profile = engine.getProfile('generic');
      return nativeRecord({
        owner: 'demo',
        on_cap: profile.on_cap,
        cap_step: undefined,
        hard_max_applies: false,
        tool_error_guidance: false,
        token_fields: [],
        messages: profile.messages,
        iteration: 0,
        last_checked_at: EARLIER_ISO,
        ...overrides,
      });
    }

    function thirdRecord(overrides: Rec = {}): Rec {
      return chainRecord({ last_checked_at: EARLIER_ISO, ...overrides });
    }

    function writtenAt(mem: { writes: Array<{ path: string; value: Rec }> }, path: string) {
      return mem.writes.find((w) => w.path === path)?.value;
    }

    it('lets a lone second layer block', () => {
      const { mem, deps } = evalDeps({ [SECOND_PATH]: secondRecord() });
      const out = engine.evaluateLayers(deps);
      expect(out.allow).toBe(false);
      expect(out.reason.startsWith('[STOP-LAYER second:demo - ITERATION 1/100]')).toBe(true);
      expect(mem.writes.map((w) => w.path)).toEqual([SECOND_PATH]);
      expect(writtenAt(mem, SECOND_PATH)).toMatchObject({ iteration: 1, last_checked_at: NOW_ISO });
    });

    it('lets first decide and only refreshes second when both are live', () => {
      const { mem, deps } = evalDeps({ [FIRST_PATH]: firstRecord(), [SECOND_PATH]: secondRecord() });
      const out = engine.evaluateLayers(deps);
      expect(out.allow).toBe(false);
      expect(out.reason.startsWith('[RALPH LOOP - ITERATION 1/100]')).toBe(true);
      expect(writtenAt(mem, FIRST_PATH)).toMatchObject({ iteration: 1, last_checked_at: NOW_ISO });
      expect(writtenAt(mem, SECOND_PATH)).toMatchObject({ iteration: 0, last_checked_at: NOW_ISO });
    });

    it('lets second decide and only refreshes third when both are live', () => {
      const { mem, deps } = evalDeps({ [SECOND_PATH]: secondRecord(), [THIRD_PATH]: thirdRecord() });
      const out = engine.evaluateLayers(deps);
      expect(out.allow).toBe(false);
      expect(out.reason.startsWith('[STOP-LAYER second:demo - ITERATION 1/100]')).toBe(true);
      expect(writtenAt(mem, SECOND_PATH)).toMatchObject({ iteration: 1, last_checked_at: NOW_ISO });
      expect(writtenAt(mem, THIRD_PATH)).toMatchObject({ iteration: 0, last_checked_at: NOW_ISO });
    });

    it('lets first decide and only refreshes second and third when all three are live', () => {
      const { mem, deps } = evalDeps({
        [FIRST_PATH]: firstRecord(),
        [SECOND_PATH]: secondRecord(),
        [THIRD_PATH]: thirdRecord(),
      });
      const out = engine.evaluateLayers(deps);
      expect(out.allow).toBe(false);
      expect(out.reason.startsWith('[RALPH LOOP - ITERATION 1/100]')).toBe(true);
      expect(writtenAt(mem, FIRST_PATH)).toMatchObject({ iteration: 1, last_checked_at: NOW_ISO });
      expect(writtenAt(mem, SECOND_PATH)).toMatchObject({ iteration: 0, last_checked_at: NOW_ISO });
      expect(writtenAt(mem, THIRD_PATH)).toMatchObject({ iteration: 0, last_checked_at: NOW_ISO });
    });

    it('lets second decide over third when first is not live', () => {
      const { mem, deps } = evalDeps({
        [FIRST_PATH]: firstRecord({ active: false }),
        [SECOND_PATH]: secondRecord(),
        [THIRD_PATH]: thirdRecord(),
      });
      const out = engine.evaluateLayers(deps);
      expect(out.allow).toBe(false);
      expect(out.reason.startsWith('[STOP-LAYER second:demo - ITERATION 1/100]')).toBe(true);
      expect(writtenAt(mem, FIRST_PATH)).toBeUndefined();
      expect(writtenAt(mem, SECOND_PATH)).toMatchObject({ iteration: 1 });
      expect(writtenAt(mem, THIRD_PATH)).toMatchObject({ iteration: 0, last_checked_at: NOW_ISO });
    });

    it('skips a second layer that is not live and lets first decide over third', () => {
      const { mem, deps } = evalDeps({
        [FIRST_PATH]: firstRecord(),
        [SECOND_PATH]: secondRecord({ active: false }),
        [THIRD_PATH]: thirdRecord(),
      });
      const out = engine.evaluateLayers(deps);
      expect(out.allow).toBe(false);
      expect(out.reason.startsWith('[RALPH LOOP - ITERATION 1/100]')).toBe(true);
      expect(writtenAt(mem, SECOND_PATH)).toBeUndefined();
      expect(writtenAt(mem, THIRD_PATH)).toMatchObject({ iteration: 0, last_checked_at: NOW_ISO });
    });

    it('allows when the first live layer defers even though later layers are live', () => {
      const { mem, deps } = evalDeps(
        { [FIRST_PATH]: firstRecord(), [SECOND_PATH]: secondRecord(), [THIRD_PATH]: thirdRecord() },
        { pending: { kind: 'defer', tasks: [] } },
      );
      expect(engine.evaluateLayers(deps)).toEqual({ allow: true });
      expect(writtenAt(mem, FIRST_PATH)).toMatchObject({ iteration: 0 });
      expect(writtenAt(mem, SECOND_PATH)).toMatchObject({ iteration: 0 });
      expect(writtenAt(mem, THIRD_PATH)).toMatchObject({ iteration: 0 });
    });

    it('reads the layers in the order first, second, third', () => {
      const { deps } = evalDeps({
        [FIRST_PATH]: firstRecord(),
        [SECOND_PATH]: secondRecord(),
        [THIRD_PATH]: thirdRecord(),
      });
      const reads: string[] = [];
      const read = deps.readState;
      deps.readState = (file: string) => {
        reads.push(file);
        return read(file);
      };
      engine.evaluateLayers(deps);
      expect(reads).toEqual(['first-stop-state.json', 'second-stop-state.json', 'third-stop-state.json']);
    });
  });
});
