import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const ROOT = 'D:/repo'
const SESSION = 's1'
const DIR = `${ROOT}/.lmgh/state/sessions/${SESSION}`
const CHAIN = `${ROOT}/phase-loop.state.json`

const FILES: Record<string, unknown> = {
  [`${DIR}/first-stop-state.json`]: { active: true, session_id: SESSION, chain_state_path: CHAIN, phase_id: 'p01' },
  [CHAIN]: { phases: [{ id: 'p01', title: 'one', status: 'running' }, { id: 'p02', title: 'two', status: 'pending' }] },
  [`${DIR}/prd.json`]: { userStories: [{ id: 'US-001', title: 'a', titleKo: '첫째 작업', passes: false }] },
  [`${DIR}/ralph-state.json`]: { active: true, current_story_id: 'US-001' },
}

const world = (on: On, withChain: boolean) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on, {})
  on('session.root', () => ({ value: ROOT }) as never)
  on('session.id', () => ({ value: SESSION }) as never)
  on('fs.read', (_$, e) => {
    const path = (e as { path: string }).path.replace(/\\/g, '/')

    if (!withChain || !(path in FILES)) throw new Error(`ENOENT ${path}`)

    return { value: JSON.stringify(FILES[path]) } as never
  })
  on('session.start', () => ({ cwd: ROOT }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['BASE'] }) as never)

  return clock
}

const start = async ($: Engine, clock: ReturnType<typeof mock.clock>) => {
  await ($.session as unknown as { start: (e: unknown) => Promise<unknown> }).start({ cwd: ROOT, surface: 'terminal' })
  await clock.advance(2000)
}

const draw = async ($: Engine, hasSurvey = false): Promise<string[]> => {
  const ui = await $.ui.mount({
    plugin: 'let-me-go-home',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'line',
    props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 90 } as never,
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return texts.map(item => item.text)
}

test('the line row stacks under what the hooks beneath drew', async ($, on) => {
  await start($, world(on, true))

  const texts = await draw($)

  expect(texts[0]).toBe('BASE')
  expect(texts.slice(1).join('')).toContain('Phase 1/2')
})

test('with no line only what the hooks beneath drew shows', async ($, on) => {
  await start($, world(on, false))

  expect(await draw($)).toEqual(['BASE'])
})

test('a survey leaves only what the hooks beneath drew', async ($, on) => {
  await start($, world(on, true))

  expect(await draw($, true)).toEqual(['BASE'])
})
