import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { STATE_DIR } from '../scripts/lib/namespace.mjs'
import { buildLine, chainPathOf } from './line'

const INTERVAL_MS = 2000

const lineAtom = atom({ plugin: 'let-me-go-home', key: 'line' } as const, null)

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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

    const tick = async (): Promise<void> => {
      let line: string | undefined
      let root = ''
      let sessionId = ''

      failures.length = 0

      try {
        root = textOf(options.projectRoot) || (await $.session.root())
        sessionId = textOf(options.sessionId) || (await $.session.id())
        const dir = `${root.replace(/\\/g, '/')}/${STATE_DIR}/state/sessions/${sessionId}`
        const pointer = await readJson(`${dir}/phase-chain-state.json`)
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
}
