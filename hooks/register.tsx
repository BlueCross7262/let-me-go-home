import { atom, read, update } from 'claude-code'
import type { Register, SettingsSource } from 'claude-code'

import { STATE_DIR } from '../scripts/lib/namespace.mjs'
import {
  countOutput,
  displayPath,
  isEditTool,
  isUseEditSummary,
  SETTINGS_SOURCES,
  verbOf,
  type EditOutput,
} from './edit-counts'
import { buildLine, chainPathOf, pickPointer } from './line'

const INTERVAL_MS = 2000
const SCAN_EVERY_TICKS = 15
const POINTER_FILE = 'phase-chain-state.json'

const lineAtom = atom({ plugin: 'let-me-go-home', key: 'line' } as const, null)

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

type SettingsReader = {
  settings: { read: (args: { source: SettingsSource }) => Promise<unknown> }
}

const isEditSummaryOn = async ($: SettingsReader): Promise<boolean> =>
  isUseEditSummary(
    await Promise.all(SETTINGS_SOURCES.map(source => $.settings.read({ source }))),
  )

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const debugFile = textOf(options.debugFile)
    const failures: string[] = []
    let shown: string | undefined
    let written = ''

    const readJson = async (path: string): Promise<unknown> => {
      try {
        return JSON.parse(await $.fs.read(path))
      } catch (error) {
        failures.push(`${path}: ${messageOf(error)}`)

        return null
      }
    }

    let cachedName = ''
    let ticks = 0

    const quietJson = async (path: string): Promise<unknown> => {
      try {
        return JSON.parse(await $.fs.read(path))
      } catch {
        return null
      }
    }

    const findPointer = async (sessionsDir: string, root: string): Promise<unknown> => {
      if (cachedName !== '') {
        const cached = await quietJson(`${sessionsDir}/${cachedName}/${POINTER_FILE}`)

        if (pickPointer([cached], root) !== null) {
          return cached
        }

        cachedName = ''
      }

      const isScanTick = ticks % SCAN_EVERY_TICKS === 0

      ticks += 1

      if (!isScanTick) {
        return null
      }

      let names: string[] = []

      try {
        const entries = await $.fs.list(sessionsDir)

        names = entries.filter(entry => entry.kind === 'dir').map(entry => entry.name)
      } catch {
        return null
      }

      const pointers = await Promise.all(
        names.map(name => quietJson(`${sessionsDir}/${name}/${POINTER_FILE}`)),
      )
      const picked = pickPointer(pointers, root)
      const index = pointers.indexOf(picked)

      cachedName = index >= 0 ? names[index] : ''

      return picked
    }

    const tick = async (): Promise<void> => {
      let line: string | undefined
      let root = ''
      let sessionId = ''

      failures.length = 0

      try {
        root = textOf(options.projectRoot) || (await $.session.root())
        sessionId = textOf(options.sessionId) || (await $.session.id())
        const sessionsDir = `${root.replace(/\\/g, '/')}/${STATE_DIR}/state/sessions`
        const dir = `${sessionsDir}/${sessionId}`
        let pointer = await readJson(`${dir}/${POINTER_FILE}`)

        if (chainPathOf(pointer) === null) {
          pointer = await findPointer(sessionsDir, root)
        }
        const chainPath = chainPathOf(pointer)
        const chain = chainPath === null ? null : await readJson(chainPath)
        const prd = await readJson(`${dir}/prd.json`)
        const ralph = await readJson(`${dir}/ralph-state.json`)

        line = buildLine({ pointer, chain, prd, ralph })
      } catch (error) {
        failures.push(messageOf(error))
        line = undefined
      }

      if (line !== shown) {
        shown = line
        await update($, lineAtom, () => line ?? null)
      }

      if (debugFile !== '') {
        const snapshot = JSON.stringify({
          line: line ?? null,
          root,
          sessionId,
          failures,
        })

        if (snapshot !== written) {
          written = snapshot

          try {
            await $.fs.write(debugFile, snapshot)
          } catch {
            written = ''
          }
        }
      }
    }

    $.clock.every(INTERVAL_MS, tick)
    void tick()

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, lineAtom)

    if (e.props.hasSurvey || text === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>{'❯❯ '}</Text>
        <Text bold color="cyan">
          {text}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output, isRunning, isErrored, isInterrupted } = e.props

    if (!isEditTool(tool) || isErrored || isInterrupted || !(await isEditSummaryOn($))) {
      return next(e)
    }

    const filePath = (input as { file_path?: string } | null)?.file_path

    if (filePath === undefined) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const path = displayPath(filePath, await $.session.cwd())
    const result = output as EditOutput | undefined
    const head = `${verbOf(tool, result)}(${path})`

    if (isRunning || result === undefined) {
      return (
        <Box>
          <Text bold>{head}</Text>
        </Box>
      )
    }

    const { added, removed } = countOutput(result)

    return (
      <Box>
        <Text bold>{head}</Text>
        <Text color="green"> +{added}</Text>
        <Text color="red"> -{removed}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!isEditTool(e.props.tool) || e.props.isErrored || !(await isEditSummaryOn($))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}
