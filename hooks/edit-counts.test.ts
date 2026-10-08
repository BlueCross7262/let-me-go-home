import { expect, test } from 'claude-code/testing'

import { countOutput, displayPath, isEditTool, isUseEditSummary, verbOf } from './edit-counts'

const PATCH = [
  {
    lines: [' keep', '-old a', '-old b', '+new a', '+new b', '+new c', ' keep'],
  },
]

const CWD = 'D:\\Project\\let-me-go-home'

const flag = (value: unknown) => ({ lmgh: { mod: { 'use-edit-summary': value } } })

const settingsBySource = (bySource: Record<string, unknown>) => (_$: unknown, e: { source?: string }) => ({
  value: bySource[e.source ?? ''] ?? {},
})

const withSummary = (on: (event: 'settings.read', hook: never) => unknown) =>
  on('settings.read', settingsBySource({ user: flag(true) }) as never)

const ENGINE_ROW = { type: 'Text', props: {}, children: ['engine row'] }

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(item => item.text).join('')

test('counts added and removed lines from the patch', () => {
  expect(countOutput({ structuredPatch: PATCH })).toEqual({ added: 3, removed: 2 })
})

test('counts the content lines of a new file', () => {
  expect(countOutput({ type: 'create', content: 'a\nb\nc', structuredPatch: [] })).toEqual({
    added: 3,
    removed: 0,
  })
})

test('counts an empty new file as zero lines', () => {
  expect(countOutput({ type: 'create', content: '', structuredPatch: [] })).toEqual({
    added: 0,
    removed: 0,
  })
})

test('names a created Write file Write and every other edit Update', () => {
  expect(verbOf('Write', { type: 'create' })).toBe('Write')
  expect(verbOf('Write', { type: 'update' })).toBe('Update')
  expect(verbOf('Edit')).toBe('Update')
})

test('shortens a path inside the working directory and keeps one outside', () => {
  expect(displayPath(`${CWD}\\skills\\ralph\\SKILL.md`, CWD)).toBe('skills\\ralph\\SKILL.md')
  expect(displayPath('C:\\Users\\x\\a.md', CWD)).toBe('C:\\Users\\x\\a.md')
  expect(displayPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
})

test('is off when no source sets the flag', () => {
  expect(isUseEditSummary([])).toBe(false)
  expect(isUseEditSummary([{}, { lmgh: {} }, { lmgh: { mod: {} } }])).toBe(false)
})

test('is on only for a boolean true', () => {
  expect(isUseEditSummary([flag(true)])).toBe(true)
  expect(isUseEditSummary([flag('true')])).toBe(false)
  expect(isUseEditSummary([flag(1)])).toBe(false)
  expect(isUseEditSummary([flag(null)])).toBe(false)
})

test('takes the first source that holds a boolean, highest precedence first', () => {
  expect(isUseEditSummary([flag(false), flag(true)])).toBe(false)
  expect(isUseEditSummary([{}, flag(true), flag(false)])).toBe(true)
  expect(isUseEditSummary([flag('x'), flag(true)])).toBe(true)
})

test('ignores a malformed lmgh section', () => {
  expect(isUseEditSummary([{ lmgh: 'on' }, { lmgh: { mod: ['use-edit-summary'] } }, null])).toBe(false)
})

test('treats only Edit and Write as edit tools', () => {
  expect(isEditTool('Edit')).toBe(true)
  expect(isEditTool('Write')).toBe(true)
  expect(isEditTool('Read')).toBe(false)
})

test('Edit row stays the engine row while the flag is unset', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', settingsBySource({}) as never)
  on('ui.render', () => ENGINE_ROW as never)

  const ui = await $.ui.mount({
    plugin: 'let-me-go-home',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'u0',
    props: {
      tool_use_id: 'u0',
      tool: 'Edit',
      input: { file_path: `${CWD}\\a.txt` },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: { filePath: 'x', structuredPatch: PATCH },
    },
  })

  expect(await texts(ui)).toBe('engine row')
})

test('Edit row stays the engine row while a higher source sets the flag false', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', settingsBySource({ project: flag(false), user: flag(true) }) as never)
  on('ui.render', () => ENGINE_ROW as never)

  const ui = await $.ui.mount({
    plugin: 'let-me-go-home',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'u0b',
    props: {
      tool_use_id: 'u0b',
      tool: 'Edit',
      input: { file_path: `${CWD}\\a.txt` },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: { filePath: 'x', structuredPatch: PATCH },
    },
  })

  expect(await texts(ui)).toBe('engine row')
})

test('result row of Edit stays the engine row while the flag is unset', async ($, on) => {
  on('settings.read', settingsBySource({}) as never)
  on('ui.render', () => ENGINE_ROW as never)

  const ui = await $.ui.mount({
    plugin: 'let-me-go-home',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'u0c',
    props: { tool_use_id: 'u0c', tool: 'Edit', output: {}, isErrored: false },
  })

  expect(await texts(ui)).toBe('engine row')
})

test('Edit row draws the path and the counts', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  withSummary(on)

  const ui = await $.ui.mount({
    plugin: 'let-me-go-home',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'u1',
    props: {
      tool_use_id: 'u1',
      tool: 'Edit',
      input: { file_path: `${CWD}\\skills\\ralph\\SKILL.md` },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: { filePath: 'x', structuredPatch: PATCH },
    },
  })

  expect(await texts(ui)).toBe('Update(skills\\ralph\\SKILL.md) +3 -2')
})

test('Write row of a new file draws Write with its line count', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  withSummary(on)

  const ui = await $.ui.mount({
    plugin: 'let-me-go-home',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'u2',
    props: {
      tool_use_id: 'u2',
      tool: 'Write',
      input: { file_path: `${CWD}\\a.txt` },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: { type: 'create', filePath: 'x', content: 'a\nb\nc', structuredPatch: [], originalFile: null },
    },
  })

  expect(await texts(ui)).toBe('Write(a.txt) +3 -0')
})

test('running Edit row draws the head without counts', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  withSummary(on)

  const ui = await $.ui.mount({
    plugin: 'let-me-go-home',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'u3',
    props: {
      tool_use_id: 'u3',
      tool: 'Edit',
      input: { file_path: `${CWD}\\a.txt` },
      isRunning: true,
      isErrored: false,
      isInterrupted: false,
    },
  })

  expect(await texts(ui)).toBe('Update(a.txt)')
})

test('result row of Edit draws nothing', async ($, on) => {
  withSummary(on)

  const ui = await $.ui.mount({
    plugin: 'let-me-go-home',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'u1',
    props: { tool_use_id: 'u1', tool: 'Edit', output: {}, isErrored: false },
  })

  expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
})
