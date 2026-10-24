import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenarios } from './run-scenarios.mjs';
import { getProfile } from '../../scripts/lib/stop-control.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const hook = resolve(here, '..', '..', 'hooks', 'ralph-stop.mjs');
const H = 3600e3;
const SESSION = 'sessions/s1';
const FIRST = `${SESSION}/first-stop-state.json`;
const SECOND = `${SESSION}/second-stop-state.json`;
const THIRD = `${SESSION}/third-stop-state.json`;
const LEDGER = `${SESSION}/skill-active-state.json`;
const LEGACY_RALPH = `${SESSION}/ralph-state.json`;

type Rec = Record<string, unknown>;

const iso = (ms = 0) => new Date(Date.now() - ms).toISOString();

function nativeRecord(base: string, profileName: string, overrides: Rec = {}): Rec {
  const profile = getProfile(profileName);
  return {
    owner: profile.owner ?? 'demo',
    active: true,
    session_id: 's1',
    project_path: base,
    started_at: iso(),
    last_checked_at: iso(),
    iteration: profileName === 'phase-chain' ? 0 : 1,
    max_iterations: 100,
    on_cap: profile.on_cap,
    ...(profile.cap_step !== undefined ? { cap_step: profile.cap_step } : {}),
    hard_max_applies: profile.hard_max_applies,
    tool_error_guidance: profile.tool_error_guidance,
    token_fields: profile.token_fields,
    messages: profile.messages,
    ...(profileName === 'phase-chain' ? { phase_id: 'p1', chain_state_path: 'x', skill_path: 'y', executor_skill_path: 'z' } : {}),
    ...overrides,
  };
}

function legacyRalph(base: string, overrides: Rec = {}): Rec {
  return { active: true, iteration: 1, max_iterations: 100, session_id: 's1', project_path: base, started_at: iso(), last_checked_at: iso(), prompt: 'x', ...overrides };
}

function buildScenarios(base: string) {
  const native = (name: string, overrides: Rec = {}) => nativeRecord(base, name, overrides);
  return [
    { id: 'n01', note: 'native first layer live', files: { [FIRST]: () => native('ralph') } },
    { id: 'n02', note: 'stamped domain file only', files: { [LEGACY_RALPH]: () => legacyRalph(base, { stop_control: 'first' }) } },
    { id: 'n03', note: 'control record only, no domain file', files: { [FIRST]: () => native('ralph') } },
    { id: 'n04', note: 'native and legacy file on the same layer', files: { [FIRST]: () => native('ralph'), [LEGACY_RALPH]: () => legacyRalph(base) } },
    { id: 'n05', note: 'native chain in first and ralph in third both live', files: { [FIRST]: () => native('phase-chain'), [THIRD]: () => native('ralph') } },
    { id: 'n06', note: 'second layer generic profile', files: { [SECOND]: () => native('generic', { owner: 'demo' }) } },
    { id: 'n07', note: 'native record that fails validation', files: { [FIRST]: () => native('ralph', { iteration: 1.5 }) } },
    { id: 'n08', note: 'native chain awaiting confirmation', files: { [THIRD]: () => native('phase-chain', { awaiting_confirmation: true, awaiting_confirmation_set_at: iso(10e3) }) } },
    { id: 'n09', note: 'tombstone under the layer key', files: { [FIRST]: () => native('ralph'), [LEDGER]: () => ({ active_skills: { 'first-stop': { completed_at: iso() } } }) } },
    { id: 'n10', note: 'second layer with a running bash task', files: { [SECOND]: () => native('generic', { owner: 'demo' }) }, payload: { background_tasks: [{ id: 'b1', type: 'bash', status: 'running' }] } },
    { id: 'n11', note: 'native chain profile at the cap', files: { [THIRD]: () => native('phase-chain', { iteration: 100 }) } },
    { id: 'n12', note: 'native record stale by 3h', files: { [FIRST]: () => native('ralph', { started_at: iso(3 * H), last_checked_at: iso(3 * H) }) } },
    { id: 'n13', note: 'native ralph profile at the hard max', files: { [FIRST]: () => native('ralph', { iteration: 100 }) }, hardMax: 50 },
    { id: 'n14', note: 'stray ralph file and native third both live', files: { [LEGACY_RALPH]: () => legacyRalph(base), [THIRD]: () => native('phase-chain') } },
    { id: 'n15', note: 'tombstone under the owner key', files: { [FIRST]: () => native('ralph'), [LEDGER]: () => ({ active_skills: { ralph: { completed_at: iso() } } }) } },
    { id: 'n16', note: 'native chain profile with an unset phase_id', files: { [THIRD]: () => native('phase-chain', { phase_id: undefined }) } },
  ];
}

describe('oracle: scenarios that exist only with the control records', () => {
  let base = '';
  let results: Record<string, { verdict: { kind: string; reason?: string }; files: Record<string, Rec>; stderr: boolean }> = {};

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'lmgh-oracle-layers-'));
    results = Object.fromEntries(runScenarios({ hook, base, scenarios: buildScenarios(base) }).map((r: { id: string }) => [r.id, r]));
  }, 120000);

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('n01 blocks, counts, and keeps the profile data in the file', () => {
    const r = results.n01;
    expect(r.verdict.kind).toBe('block');
    expect(r.verdict.reason?.startsWith('[RALPH LOOP - ITERATION 2/100]')).toBe(true);
    expect(r.verdict.reason?.endsWith('/let-me-go-home:cancel\n')).toBe(true);
    expect(r.files[FIRST].iteration).toBe(2);
    expect(r.files[FIRST].owner).toBe('ralph');
    expect(r.files[FIRST].messages).toEqual(getProfile('ralph').messages);
    expect(r.stderr).toBe(false);
  });

  it('n02 allows when only a stamped domain file is live', () => {
    expect(results.n02.verdict.kind).toBe('allow');
    expect(results.n02.files[LEGACY_RALPH].iteration).toBe(1);
  });

  it('n03 blocks when only the control record is live', () => {
    expect(results.n03.verdict.kind).toBe('block');
  });

  it('n04 lets the native file win and leaves the legacy file alone', () => {
    expect(results.n04.files[FIRST].iteration).toBe(2);
    expect(results.n04.files[LEGACY_RALPH].iteration).toBe(1);
  });

  it('n05 lets the third layer decide and only refreshes the first', () => {
    const r = results.n05;
    expect(r.verdict.reason?.startsWith('[RALPH LOOP - ITERATION 2/100]')).toBe(true);
    expect(r.files[THIRD].iteration).toBe(2);
    expect(r.files[FIRST].iteration).toBe(0);
    expect(r.files[FIRST].last_checked_at).toBe('<ISO>');
  });

  it('n06 renders the generic profile with layer and owner', () => {
    expect(results.n06.verdict.reason).toBe(
      '[STOP-LAYER second:demo - ITERATION 2/100] Work is NOT done. Continue the owning task. To stop it, run /let-me-go-home:cancel --layer second',
    );
  });

  it('n07 drops an invalid native record, allows, and logs record-invalid', () => {
    expect(results.n07.verdict.kind).toBe('allow');
    expect(results.n07.stderr).toBe(true);
    expect(results.n07.files[FIRST].iteration).toBe(1.5);
  });

  it('n08 applies awaiting_confirmation to a chain record', () => {
    expect(results.n08.verdict.kind).toBe('allow');
  });

  it('n09 honours a tombstone under the layer key', () => {
    expect(results.n09.verdict.kind).toBe('allow');
  });

  it('n10 uses the generic wait tag for a nudge', () => {
    expect(results.n10.verdict.reason?.startsWith('[STOP-LAYER second:demo - WAITING] Background work is still running: bash b1.')).toBe(true);
    expect(results.n10.files[SECOND].iteration).toBe(1);
  });

  it('n11 disables a chain-profile record at the cap and keeps its messages', () => {
    const r = results.n11;
    expect(r.verdict.reason?.startsWith('[PHASE-CHAIN - HARD LIMIT] Chain disabled after 100 blocked stops in phase p1.')).toBe(true);
    expect(r.files[THIRD].active).toBe(false);
    expect(r.files[THIRD].messages).toEqual(getProfile('phase-chain').messages);
  });

  it('n12 treats a stale native record as not live', () => {
    expect(results.n12.verdict.kind).toBe('allow');
  });

  it('n13 applies the configured hard max to a native ralph-profile record', () => {
    const r = results.n13;
    expect(r.verdict.reason).toBe('[RALPH LOOP - HARD LIMIT] Reached hard max iterations (50). Mode auto-disabled. Restart with /let-me-go-home:ralph if needed.');
    expect(r.files[FIRST].active).toBe(false);
  });

  it('n14 ignores a stray ralph file and lets the native third layer decide', () => {
    const r = results.n14;
    expect(r.verdict.reason?.startsWith('[PHASE-CHAIN]')).toBe(true);
    expect(r.files[THIRD].iteration).toBe(1);
    expect(r.files[LEGACY_RALPH].iteration).toBe(1);
  });

  it('n15 honours a tombstone under the owner key', () => {
    expect(results.n15.verdict.kind).toBe('allow');
  });

  it('n16 still renders a chain-profile record whose phase_id is unset', () => {
    expect(results.n16.verdict.reason?.startsWith('[PHASE-CHAIN] A phase chain is in progress. Read x and follow the re-entry rule in y.')).toBe(true);
    expect(results.n16.verdict.kind).toBe('block');
  });
});
