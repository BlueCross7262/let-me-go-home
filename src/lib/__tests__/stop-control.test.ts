import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as engine from '../../../scripts/lib/stop-control.mjs';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as ralphTask from '../../../scripts/lib/ralph-task.mjs';
import {
  STOP_LAYERS,
  STOP_LAYER_MODES,
  STOP_PROFILES,
  buildStopControlRecord,
  clearStopControlByOwner,
  deactivateStopControlByOwner,
  formatRalphTaskPointerLines,
  layerFromMode,
  pickFreeLayer,
  refreshStopControl,
  stopLayerStatuses,
  readStopControl,
  regenerateContinueLiteral,
  stopLayerFileName,
  stopLayerMode,
  writeStopControl,
  type StopControlInput,
} from '../stop-control.js';
import { resolveSessionStatePath } from '../worktree-paths.js';

const directories: string[] = [];
const previousStateDir = process.env.LMGH_STATE_DIR;

function freshProject(label: string): string {
  const directory = mkdtempSync(join(homedir(), `stop-control-${label}-`));
  directories.push(directory);
  process.env.LMGH_STATE_DIR = join(directory, 'state-root');
  return directory;
}

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LMGH_STATE_DIR;
  else process.env.LMGH_STATE_DIR = previousStateDir;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const NOW = '2026-10-18T00:00:00.000Z';
const ralphInput = (overrides: Record<string, unknown> = {}): StopControlInput =>
  ({ owner: 'ralph', profile: 'ralph', active: true, iteration: 1, max_iterations: 100, ...overrides }) as StopControlInput;

describe('stop-control: names and modes', () => {
  it('names the layers and their modes with literals', () => {
    expect(STOP_LAYERS).toEqual(['first', 'second', 'third']);
    expect(STOP_LAYER_MODES).toEqual(['first-stop', 'second-stop', 'third-stop']);
    expect(stopLayerMode('second')).toBe('second-stop');
    expect(stopLayerFileName('third')).toBe('third-stop-state.json');
    expect(layerFromMode('first-stop')).toBe('first');
    expect(layerFromMode('ralph')).toBeNull();
  });

  it('keeps the profile data equal to the JSON the hook reads', () => {
    const onDisk = JSON.parse(readFileSync(fileURLToPath(new URL('../../../scripts/lib/stop-profiles.json', import.meta.url)), 'utf8'));
    expect(STOP_PROFILES).toEqual(onDisk);
    expect(STOP_PROFILES.ralph).toEqual(engine.getProfile('ralph'));
  });
});

describe('stop-control: task pointer lines', () => {
  const samples: Array<[unknown, unknown, unknown]> = [
    ['x', undefined, '/state/ralph-state.json'],
    ['x', 'C:/tasks/p.md', '/state/ralph-state.json'],
    ['  ', 'C:/tasks/p.md', '/state/ralph-state.json'],
    [undefined, undefined, undefined],
    ['short task', undefined, undefined],
    ['short task', 'C:/tasks/p.md', undefined],
    ['y'.repeat(1600) + ' --refine-check --critic=architect tail', undefined, undefined],
    ['y'.repeat(1600) + ' --no-deslop', 'C:/tasks/p.md', undefined],
    ['z'.repeat(1700), 'C:/tasks/p.md', '/state/ralph-state.json'],
  ];

  it.each(samples)('matches ralph-task.mjs for %j %j %j', (prompt, promptFile, statePath) => {
    expect(formatRalphTaskPointerLines(prompt as string, promptFile as string | undefined, statePath as string | undefined)).toEqual(
      ralphTask.formatRalphTaskPointerLines(prompt, promptFile, statePath),
    );
  });
});

describe('stop-control: building records', () => {
  const ctx = { sessionId: 's1', directory: '/proj' };

  it('applies the ralph profile to a native input', () => {
    const built = buildStopControlRecord('first', ralphInput(), ctx, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rec = built.record;
    expect(rec.owner).toBe('ralph');
    expect(rec.session_id).toBe('s1');
    expect(rec.project_path).toBe('/proj');
    expect(rec.started_at).toBe(NOW);
    expect(rec.on_cap).toBe('extend');
    expect(rec.cap_step).toBe(10);
    expect(rec.hard_max_applies).toBe(true);
    expect(rec.tool_error_guidance).toBe(true);
    expect((rec._meta as Record<string, unknown>).mode).toBe('first-stop');
    expect((rec._meta as Record<string, unknown>).updatedAt).toBe(NOW);
    expect(engine.validateRecord(rec)).toEqual({ valid: true });
  });

  it('merges partial messages over the profile messages', () => {
    const built = buildStopControlRecord('second', { owner: 'demo', active: true, iteration: 0, max_iterations: 3, messages: { continue: 'go {next}/{max}' } } as StopControlInput, ctx, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const messages = built.record.messages as Record<string, string>;
    expect(messages.continue).toBe('go {next}/{max}');
    expect(messages.hard_limit).toBe(STOP_PROFILES.generic.messages.hard_limit);
    expect(messages.wait_tag).toBe(STOP_PROFILES.generic.messages.wait_tag);
  });

  it('keeps extra pointer fields and does not drop token fields', () => {
    const built = buildStopControlRecord('third', { owner: 'phase-chain', profile: 'phase-chain', active: true, iteration: 0, max_iterations: 5, chain_state_path: 'c', skill_path: 's', executor_skill_path: 'e', phase_id: 'p' } as StopControlInput, ctx, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.record.chain_state_path).toBe('c');
    expect(built.record.token_fields).toEqual(['chain_state_path', 'skill_path', 'executor_skill_path', 'phase_id']);
    expect(built.record.on_cap).toBe('disable');
  });

  it('accepts a token field the input does not carry', () => {
    const built = buildStopControlRecord('third', { owner: 'phase-chain', profile: 'phase-chain', active: true, iteration: 0, max_iterations: 5 } as StopControlInput, ctx, NOW);
    expect(built.ok).toBe(true);
  });

  it.each([
    ['missing owner for generic', { active: true, iteration: 0, max_iterations: 3 }],
    ['owner pattern', ralphInput({ owner: 'Ralph' })],
    ['non-boolean active', ralphInput({ active: 'true' })],
    ['missing iteration', ralphInput({ iteration: undefined })],
    ['fractional iteration', ralphInput({ iteration: 0.5 })],
    ['zero max_iterations', ralphInput({ max_iterations: 0 })],
    ['fractional max_iterations', ralphInput({ max_iterations: 3.5 })],
    ['non ISO started_at', ralphInput({ started_at: 'soon' })],
    ['session mismatch', ralphInput({ session_id: 'other' })],
    ['empty project_path', ralphInput({ project_path: '' })],
    ['messages not an object', ralphInput({ messages: 'x' })],
    ['literal not an array', ralphInput({ messages: { continue_literal: 'x' } })],
    ['literal too long', ralphInput({ messages: { continue_literal: Array(21).fill('a') } })],
    ['message too long', ralphInput({ messages: { continue: 'x'.repeat(4001) } })],
    ['too many token fields', ralphInput({ token_fields: Array.from({ length: 17 }, (_, i) => `f${i}`) })],
    ['token field value too long', ralphInput({ token_fields: ['big'], big: 'x'.repeat(2001) })],
    ['unknown profile', ralphInput({ profile: 'nope' })],
  ])('rejects %s', (_label, input) => {
    expect(buildStopControlRecord('first', input as StopControlInput, ctx, NOW).ok).toBe(false);
  });

  it('rejects a missing project_path when no directory is given', () => {
    expect(buildStopControlRecord('first', ralphInput(), { sessionId: 's1' }, NOW).ok).toBe(false);
  });

  it('rejects an invalid session id and an unknown layer', () => {
    expect(buildStopControlRecord('first', ralphInput(), { sessionId: '../x', directory: '/proj' }, NOW).ok).toBe(false);
    expect(buildStopControlRecord('fourth' as never, ralphInput(), ctx, NOW).ok).toBe(false);
  });
});

describe('stop-control: writing', () => {
  it('writes the layer file under the session directory and the hook-side validator accepts it', () => {
    const directory = freshProject('write');
    const written = writeStopControl('first', ralphInput(), { sessionId: 's1', directory });
    expect(written.ok).toBe(true);
    const path = resolveSessionStatePath('first-stop', 's1', directory);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.owner).toBe('ralph');
    expect(engine.validateRecord(onDisk)).toEqual({ valid: true });
    expect(readStopControl('first', 's1', directory)?.owner).toBe('ralph');
  });

  it('allows the same owner to rewrite a layer', () => {
    const directory = freshProject('rewrite');
    expect(writeStopControl('first', ralphInput(), { sessionId: 's1', directory }).ok).toBe(true);
    expect(writeStopControl('first', ralphInput({ iteration: 3 }), { sessionId: 's1', directory }).ok).toBe(true);
    expect(readStopControl('first', 's1', directory)?.iteration).toBe(3);
  });

  it('refuses another owner on a live layer and names the free layers', () => {
    const directory = freshProject('occupied');
    expect(writeStopControl('first', ralphInput(), { sessionId: 's1', directory }).ok).toBe(true);
    const refused = writeStopControl('first', { owner: 'demo', active: true, iteration: 0, max_iterations: 3 } as StopControlInput, { sessionId: 's1', directory });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain('layer occupied by ralph');
    expect(refused.error).toContain('free layers: second, third');
    expect(readStopControl('first', 's1', directory)?.owner).toBe('ralph');
  });

  it('lets another owner replace an inactive or stale layer', () => {
    const directory = freshProject('replace');
    expect(writeStopControl('first', ralphInput({ active: false }), { sessionId: 's1', directory }).ok).toBe(true);
    const inactive = writeStopControl('first', { owner: 'demo', active: true, iteration: 0, max_iterations: 3 } as StopControlInput, { sessionId: 's1', directory });
    expect(inactive.ok).toBe(true);
    const path = resolveSessionStatePath('first-stop', 's1', directory);
    const stale = JSON.parse(readFileSync(path, 'utf8'));
    const old = new Date(Date.now() - 3 * 3600e3).toISOString();
    writeFileSync(path, JSON.stringify({ ...stale, started_at: old, last_checked_at: old }));
    const replaced = writeStopControl('first', ralphInput(), { sessionId: 's1', directory });
    expect(replaced.ok).toBe(true);
    expect(readStopControl('first', 's1', directory)?.owner).toBe('ralph');
  });

  it('allows the same owner on two layers', () => {
    const directory = freshProject('two');
    expect(writeStopControl('first', ralphInput(), { sessionId: 's1', directory }).ok).toBe(true);
    expect(writeStopControl('third', ralphInput(), { sessionId: 's1', directory }).ok).toBe(true);
  });

  it('does not write when validation fails', () => {
    const directory = freshProject('invalid');
    expect(writeStopControl('first', ralphInput({ iteration: 1.5 }), { sessionId: 's1', directory }).ok).toBe(false);
    expect(existsSync(resolveSessionStatePath('first-stop', 's1', directory))).toBe(false);
  });
});

describe('stop-control: read-modify-write updates', () => {
  it('regenerates continue_literal without touching the counters the hook wrote', () => {
    const directory = freshProject('regen');
    expect(writeStopControl('first', ralphInput(), { sessionId: 's1', directory }).ok).toBe(true);
    const path = resolveSessionStatePath('first-stop', 's1', directory);
    const initial = JSON.parse(readFileSync(path, 'utf8'));
    const hookWritten = {
      ...initial,
      iteration: 7,
      last_checked_at: '2026-10-18T05:00:00.000Z',
      background_wait_at: '2026-10-18T05:00:00.000Z',
      _meta: { ...initial._meta, updatedAt: '2026-01-01T00:00:00.000Z' },
    };
    writeFileSync(path, JSON.stringify(hookWritten));
    expect(regenerateContinueLiteral('ralph', 's1', directory, ['Full task text: new'])).toBe('written');
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.iteration).toBe(7);
    expect(after.last_checked_at).toBe('2026-10-18T05:00:00.000Z');
    expect(after.background_wait_at).toBe('2026-10-18T05:00:00.000Z');
    expect(after.messages.continue_literal).toEqual(['Full task text: new']);
    expect(after._meta.updatedAt).not.toBe(hookWritten._meta.updatedAt);
  });

  it('refuses a regeneration that breaks the literal limits and leaves the file as it was', () => {
    const directory = freshProject('regen-invalid');
    expect(writeStopControl('first', ralphInput(), { sessionId: 's1', directory }).ok).toBe(true);
    const path = resolveSessionStatePath('first-stop', 's1', directory);
    const before = readFileSync(path, 'utf8');
    expect(regenerateContinueLiteral('ralph', 's1', directory, Array(21).fill('a'))).toBe('invalid');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('skips when no layer belongs to the owner', () => {
    const directory = freshProject('regen-none');
    expect(regenerateContinueLiteral('ralph', 's1', directory, [])).toBe('skipped');
  });

  it('deactivates by owner and changes only active and the metadata', () => {
    const directory = freshProject('deactivate');
    expect(writeStopControl('first', ralphInput({ iteration: 4 }), { sessionId: 's1', directory }).ok).toBe(true);
    expect(deactivateStopControlByOwner('ralph', 's1', directory)).toBe('written');
    const after = readStopControl('first', 's1', directory) as Record<string, unknown>;
    expect(after.active).toBe(false);
    expect(after.iteration).toBe(4);
  });
});

describe('stop-control: layers for generic owners', () => {
  const demoInput = (overrides: Record<string, unknown> = {}) =>
    ({ owner: 'demo', profile: 'generic', active: true, iteration: 0, max_iterations: 3, ...overrides }) as StopControlInput;

  it('picks second, then third, then first for new owners and null when all are held', () => {
    const directory = freshProject('pick');
    const ctx = { sessionId: 's1', directory };
    expect(pickFreeLayer('a', 's1', directory)).toBe('second');
    expect(writeStopControl('second', demoInput({ owner: 'a' }), ctx).ok).toBe(true);
    expect(pickFreeLayer('b', 's1', directory)).toBe('third');
    expect(writeStopControl('third', demoInput({ owner: 'b' }), ctx).ok).toBe(true);
    expect(pickFreeLayer('c', 's1', directory)).toBe('first');
    expect(writeStopControl('first', demoInput({ owner: 'c' }), ctx).ok).toBe(true);
    expect(pickFreeLayer('d', 's1', directory)).toBeNull();
  });

  it('keeps the layer the owner already holds and reuses a stale or inactive one', () => {
    const directory = freshProject('pick-owned');
    const ctx = { sessionId: 's1', directory };
    expect(writeStopControl('third', demoInput({ owner: 'a' }), ctx).ok).toBe(true);
    expect(pickFreeLayer('a', 's1', directory)).toBe('third');
    expect(deactivateStopControlByOwner('a', 's1', directory)).toBe('written');
    expect(pickFreeLayer('b', 's1', directory)).toBe('second');
    expect(writeStopControl('second', demoInput({ owner: 'b' }), ctx).ok).toBe(true);
    const path = resolveSessionStatePath('second-stop', 's1', directory);
    const old = new Date(Date.now() - 3 * 3600e3).toISOString();
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), started_at: old, last_checked_at: old }));
    expect(pickFreeLayer('c', 's1', directory)).toBe('second');
  });

  it('refreshes last_checked_at of the owner layers and leaves the counters alone', () => {
    const directory = freshProject('refresh');
    expect(writeStopControl('second', demoInput({ iteration: 2 }), { sessionId: 's1', directory }).ok).toBe(true);
    const path = resolveSessionStatePath('second-stop', 's1', directory);
    const old = new Date(Date.now() - 3600e3).toISOString();
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), last_checked_at: old }));
    expect(refreshStopControl('demo', 's1', directory)).toBe('written');
    const after = readStopControl('second', 's1', directory) as Record<string, unknown>;
    expect(Date.parse(String(after.last_checked_at))).toBeGreaterThan(Date.parse(old));
    expect(after.iteration).toBe(2);
    expect(after.active).toBe(true);
    expect(refreshStopControl('other', 's1', directory)).toBe('skipped');
  });

  it('reports each layer with its owner, activity and staleness', () => {
    const directory = freshProject('statuses');
    expect(writeStopControl('second', demoInput(), { sessionId: 's1', directory }).ok).toBe(true);
    const statuses = stopLayerStatuses('s1', directory);
    expect(statuses.map((status) => status.layer)).toEqual(['first', 'second', 'third']);
    expect(statuses[0]).toMatchObject({ present: false });
    expect(statuses[1]).toMatchObject({ present: true, owner: 'demo', active: true, stale: false, iteration: 0, max_iterations: 3 });
    expect(statuses[1].path).toBe(resolveSessionStatePath('second-stop', 's1', directory));
  });
});

describe('stop-control: clearing by owner', () => {
  it('removes only the layer files the owner holds', () => {
    const directory = freshProject('clear');
    expect(writeStopControl('first', ralphInput(), { sessionId: 's1', directory }).ok).toBe(true);
    expect(writeStopControl('second', { owner: 'demo', active: true, iteration: 0, max_iterations: 3 } as StopControlInput, { sessionId: 's1', directory }).ok).toBe(true);
    expect(clearStopControlByOwner('ralph', 's1', directory)).toEqual({ ok: true, cleared: 1 });
    expect(readStopControl('first', 's1', directory)).toBeNull();
    expect(readStopControl('second', 's1', directory)?.owner).toBe('demo');
  });

  it('reports nothing cleared when the owner holds no layer', () => {
    const directory = freshProject('clear-none');
    expect(clearStopControlByOwner('ralph', 's1', directory)).toEqual({ ok: true, cleared: 0 });
  });
});
