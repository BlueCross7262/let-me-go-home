export type Patch = { lines: string[] }[]

export type EditOutput = {
  type?: 'create' | 'update'
  content?: string
  structuredPatch?: Patch
}

export type LineCounts = { added: number; removed: number }

const EDIT_TOOLS = ['Edit', 'Write']

export const SETTINGS_NAMESPACE = 'lmgh'
export const SETTINGS_GROUP = 'mod'
export const SETTINGS_KEY = 'use-edit-summary'
export const SETTINGS_SOURCES = ['policy', 'flag', 'local', 'project', 'user'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isUseEditSummary = (sources: readonly unknown[]): boolean => {
  for (const source of sources) {
    const namespace = isRecord(source) ? source[SETTINGS_NAMESPACE] : undefined
    const group = isRecord(namespace) ? namespace[SETTINGS_GROUP] : undefined
    const value = isRecord(group) ? group[SETTINGS_KEY] : undefined

    if (typeof value === 'boolean') return value
  }

  return false
}

export const isEditTool = (tool: string): boolean => EDIT_TOOLS.includes(tool)

export const countPatch = (patch: Patch): LineCounts => {
  let added = 0
  let removed = 0

  for (const hunk of patch) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }

  return { added, removed }
}

const countLines = (text: string): number => (text === '' ? 0 : text.split('\n').length)

export const countOutput = (output: EditOutput): LineCounts => {
  const counts = countPatch(output.structuredPatch ?? [])
  const isNewFile = output.type === 'create' && counts.added === 0

  return isNewFile ? { added: countLines(output.content ?? ''), removed: 0 } : counts
}

export const verbOf = (tool: string, output?: EditOutput): string =>
  tool === 'Write' && output?.type === 'create' ? 'Write' : 'Update'

export const displayPath = (filePath: string, cwd: string): string => {
  const normalize = (path: string): string => path.replace(/\\/g, '/')
  const file = normalize(filePath)
  const base = normalize(cwd).replace(/\/+$/, '') + '/'
  const isInside = file.toLowerCase().startsWith(base.toLowerCase())
  const relative = isInside ? file.slice(base.length) : file

  return cwd.includes('\\') ? relative.replace(/\//g, '\\') : relative
}
