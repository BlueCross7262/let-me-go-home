import { expect, test } from 'claude-code/testing'

import { buildLine, chainPathOf } from './line'

const phases = (running: number | null) =>
  Array.from({ length: 15 }, (_, index) => ({
    id: `p${String(index + 1).padStart(2, '0')}`,
    status: index === running ? 'running' : 'pending',
  }))

const stories = [
  { id: 'US-001', passes: true },
  { id: 'US-002', passes: true },
  { id: 'US-003', passes: false },
  { id: 'US-004', passes: false },
  { id: 'US-005', passes: false },
  { id: 'USREVIEW', passes: false },
]

const pointer = { chain_state_path: 'D:/repo/phase-loop.state.json', phase_id: 'p01' }

test('shows phase and story from the live chain files', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories },
      ralph: { active: true, current_story_id: 'US-003' },
    }),
  ).toBe('Phase 1/15 · Story 3/6')
})

test('counts the running phase by its position', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(6) },
      prd: null,
      ralph: null,
    }),
  ).toBe('Phase 7/15')
})

test('falls back to the pointer phase when none is running', () => {
  expect(
    buildLine({
      pointer: { phase_id: 'p04' },
      chain: { phases: phases(null) },
      prd: null,
      ralph: null,
    }),
  ).toBe('Phase 4/15')
})

test('hides the story while ralph is not active', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories },
      ralph: { active: false, current_story_id: 'US-003' },
    }),
  ).toBe('Phase 1/15')
})

test('uses the first open story when the current id is missing', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories },
      ralph: { active: true },
    }),
  ).toBe('Phase 1/15 · Story 3/6')
})

test('ignores a stale current story id that already passed', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories },
      ralph: { active: true, current_story_id: 'US-001' },
    }),
  ).toBe('Phase 1/15 · Story 3/6')
})

test('stays on the last story when every story passes', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories.map(story => ({ ...story, passes: true })) },
      ralph: { active: true },
    }),
  ).toBe('Phase 1/15 · Story 6/6')
})

test('clears the line when the files are missing or malformed', () => {
  expect(buildLine({ pointer: null, chain: null, prd: null, ralph: null })).toBe(undefined)
  expect(
    buildLine({ pointer: 'x', chain: { phases: 3 }, prd: [], ralph: { active: true } }),
  ).toBe(undefined)
})

test('reads the chain path from the pointer only when it is a non-empty string', () => {
  expect(chainPathOf(pointer)).toBe('D:/repo/phase-loop.state.json')
  expect(chainPathOf({ chain_state_path: '' })).toBe(null)
  expect(chainPathOf(null)).toBe(null)
})
