import { expect, test } from 'claude-code/testing'

import { acceptPointer, buildLine, chainPathOf } from './line'

const phases = (running: number | null) =>
  Array.from({ length: 15 }, (_, index) => ({
    id: `p${String(index + 1).padStart(2, '0')}`,
    title: `phase ${index + 1} work`,
    status: index === running ? 'running' : 'pending',
  }))

const stories = [
  { id: 'US-001', title: 'first work', titleKo: '첫째 작업', passes: true },
  { id: 'US-002', title: 'second work', titleKo: '둘째 작업', passes: true },
  { id: 'US-003', title: 'third work', titleKo: '셋째 작업', passes: false },
  { id: 'US-004', title: 'fourth work', titleKo: '넷째 작업', passes: false },
  { id: 'US-005', title: 'fifth work', titleKo: '다섯째 작업', passes: false },
  { id: 'USREVIEW', title: 'review work', titleKo: '검토 작업', passes: false },
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
  ).toBe('Phase 1/15 · Story 3/6 · 셋째 작업')
})

test('counts the running phase by its position', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(6) },
      prd: null,
      ralph: null,
    }),
  ).toBe('Phase 7/15 · phase 7 work')
})

test('falls back to the pointer phase when none is running', () => {
  expect(
    buildLine({
      pointer: { phase_id: 'p04' },
      chain: { phases: phases(null) },
      prd: null,
      ralph: null,
    }),
  ).toBe('Phase 4/15 · phase 4 work')
})

test('hides the story while ralph is not active', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories },
      ralph: { active: false, current_story_id: 'US-003' },
    }),
  ).toBe('Phase 1/15 · phase 1 work')
})

test('uses the first open story when the current id is missing', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories },
      ralph: { active: true },
    }),
  ).toBe('Phase 1/15 · Story 3/6 · 셋째 작업')
})

test('ignores a stale current story id that already passed', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories },
      ralph: { active: true, current_story_id: 'US-001' },
    }),
  ).toBe('Phase 1/15 · Story 3/6 · 셋째 작업')
})

test('stays on the last story when every story passes', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: stories.map(story => ({ ...story, passes: true })) },
      ralph: { active: true },
    }),
  ).toBe('Phase 1/15 · Story 6/6 · 검토 작업')
})

test('never shows the English story title', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: phases(0) },
      prd: { userStories: [{ id: 'US-001', title: 'english only', passes: false }] },
      ralph: { active: true },
    }),
  ).toBe('Phase 1/15 · Story 1/1')
})

test('leaves the summary out when the title is missing or blank', () => {
  expect(
    buildLine({
      pointer,
      chain: { phases: [{ id: 'p01', status: 'running' }, { id: 'p02', title: '  ' }] },
      prd: { userStories: [{ id: 'US-001', titleKo: '  ', passes: false }] },
      ralph: { active: true },
    }),
  ).toBe('Phase 1/2 · Story 1/1')
  expect(
    buildLine({
      pointer,
      chain: { phases: [{ id: 'p01', status: 'running' }] },
      prd: null,
      ralph: null,
    }),
  ).toBe('Phase 1/1')
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

const own = { active: true, session_id: 's1', chain_state_path: 'D:/repo/phase-loop.state.json' }

test('accepts the pointer of the given session when it is active and names a chain file', () => {
  expect(acceptPointer(own, 's1')).toEqual(own)
})

test('rejects a pointer of another session, an inactive one and one without a chain path', () => {
  expect(acceptPointer(own, 's2')).toBe(null)
  expect(acceptPointer({ ...own, active: false }, 's1')).toBe(null)
  expect(acceptPointer({ ...own, chain_state_path: '' }, 's1')).toBe(null)
  expect(acceptPointer({ ...own, session_id: undefined }, 's1')).toBe(null)
  expect(acceptPointer({ ...own, session_id: 1 }, 's1')).toBe(null)
})

test('rejects everything when the session id is empty or the input is not an object', () => {
  expect(acceptPointer(own, '')).toBe(null)
  expect(acceptPointer(null, 's1')).toBe(null)
  expect(acceptPointer('text', 's1')).toBe(null)
  expect(acceptPointer([own], 's1')).toBe(null)
})
