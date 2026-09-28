import { describe, it, expect } from 'vitest';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { CHAIN_DEFAULT_MAX, CHAIN_STATE_FILE, refreshChainState, decideChain } from '../../scripts/lib/phase-chain.mjs';

const NOW = '2026-09-29T00:00:00.000Z';

function chainState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    iteration: 0,
    max_iterations: 5,
    session_id: 's1',
    project_path: '/repo',
    chain_state_path: '/repo/.git/jira_works/main/phase-run.state.json',
    skill_path: '/home/.claude/skills/phase-run/SKILL.md',
    lite_run_skill_path: '/home/.claude/skills/lite-run/SKILL.md',
    phase_id: 'p01',
    last_checked_at: '2026-09-28T23:00:00.000Z',
    ...overrides,
  };
}

describe('phase-chain constants', () => {
  it('names the state file and the default cap', () => {
    expect(CHAIN_STATE_FILE).toBe('phase-chain-state.json');
    expect(CHAIN_DEFAULT_MAX).toBe(100);
  });
});

describe('refreshChainState', () => {
  it('stamps last_checked_at and keeps every other field', () => {
    const next = refreshChainState(chainState(), 'none', NOW);
    expect(next.last_checked_at).toBe(NOW);
    expect(next.chain_state_path).toBe('/repo/.git/jira_works/main/phase-run.state.json');
    expect(next.session_id).toBe('s1');
    expect(next.active).toBe(true);
  });

  it('marks a background wait while work is pending and clears it otherwise', () => {
    expect(refreshChainState(chainState(), 'defer', NOW).background_wait_at).toBe(NOW);
    expect(refreshChainState(chainState(), 'nudge', NOW).background_wait_at).toBe(NOW);
    expect(refreshChainState(chainState({ background_wait_at: NOW }), 'none', NOW).background_wait_at).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const input = chainState();
    refreshChainState(input, 'defer', NOW);
    expect(input.background_wait_at).toBeUndefined();
    expect(input.last_checked_at).toBe('2026-09-28T23:00:00.000Z');
  });
});

describe('decideChain', () => {
  it('blocks, advances the iteration and points at the chain files', () => {
    const { state, output } = decideChain(chainState(), { kind: 'none', tasks: [] }, NOW);
    expect(output.decision).toBe('block');
    expect(output.reason.startsWith('[PHASE-CHAIN] ')).toBe(true);
    expect(output.reason).toContain('/repo/.git/jira_works/main/phase-run.state.json');
    expect(output.reason).toContain('/home/.claude/skills/phase-run/SKILL.md');
    expect(output.reason).toContain('/home/.claude/skills/lite-run/SKILL.md');
    expect(output.reason).toContain('/let-me-go-home:cancel --chain');
    expect(state.iteration).toBe(1);
    expect(state.active).toBe(true);
  });

  it('lets the turn end for deferred work and marks the wait', () => {
    const { state, output } = decideChain(chainState(), { kind: 'defer', tasks: [{ type: 'subagent', id: 'a1' }] }, NOW);
    expect(output.decision).toBeUndefined();
    expect(output.allow).toBe(true);
    expect(state.background_wait_at).toBe(NOW);
    expect(state.iteration).toBe(0);
  });

  it('nudges with the chain waiting tag for other running work', () => {
    const { state, output } = decideChain(chainState(), { kind: 'nudge', tasks: [{ type: 'shell', id: 'b1' }] }, NOW);
    expect(output.decision).toBe('block');
    expect(output.reason.startsWith('[PHASE-CHAIN - WAITING] Background work is still running: shell b1.')).toBe(true);
    expect(state.background_wait_at).toBe(NOW);
    expect(state.iteration).toBe(0);
  });

  it('clears the wait mark once nothing is pending', () => {
    const { state } = decideChain(chainState({ background_wait_at: NOW }), { kind: 'none', tasks: [] }, NOW);
    expect(state.background_wait_at).toBeUndefined();
  });

  it('disables the chain and blocks once with the hard-limit reason at the cap', () => {
    const { state, output } = decideChain(chainState({ iteration: 5, max_iterations: 5 }), { kind: 'none', tasks: [] }, NOW);
    expect(output.decision).toBe('block');
    expect(output.reason.startsWith('[PHASE-CHAIN - HARD LIMIT] ')).toBe(true);
    expect(output.reason).toContain('chain-hard-limit');
    expect(state.active).toBe(false);
    expect(state.iteration).toBe(5);
  });

  it('falls back to the default cap for a missing or non-positive max_iterations', () => {
    const missing = decideChain(chainState({ iteration: 99, max_iterations: undefined }), { kind: 'none', tasks: [] }, NOW);
    expect(missing.output.reason.startsWith('[PHASE-CHAIN] ')).toBe(true);
    const zero = decideChain(chainState({ iteration: 100, max_iterations: 0 }), { kind: 'none', tasks: [] }, NOW);
    expect(zero.output.reason.startsWith('[PHASE-CHAIN - HARD LIMIT] ')).toBe(true);
  });

  it('treats a non-numeric iteration as zero', () => {
    const { state } = decideChain(chainState({ iteration: 'x' }), { kind: 'none', tasks: [] }, NOW);
    expect(state.iteration).toBe(1);
  });
});
