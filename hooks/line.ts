type Json = Record<string, unknown>

export type ProgressInput = {
  pointer: unknown
  chain: unknown
  prd: unknown
  ralph: unknown
}

const asRecord = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null

const asList = (value: unknown): Json[] =>
  Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Json => item !== null)
    : []

export const chainPathOf = (pointer: unknown): string | null => {
  const path = asRecord(pointer)?.chain_state_path

  return typeof path === 'string' && path !== '' ? path : null
}

const phasePart = (pointer: unknown, chain: unknown): string | null => {
  const phases = asList(asRecord(chain)?.phases)

  if (phases.length === 0) {
    return null
  }

  const running = phases.findIndex(phase => phase.status === 'running')
  const pointedId = asRecord(pointer)?.phase_id
  const index =
    running >= 0 ? running : phases.findIndex(phase => phase.id === pointedId)

  return index >= 0 ? `Phase ${index + 1}/${phases.length}` : null
}

const storyPart = (prd: unknown, ralph: unknown): string | null => {
  const state = asRecord(ralph)

  if (state?.active !== true) {
    return null
  }

  const stories = asList(asRecord(prd)?.userStories)

  if (stories.length === 0) {
    return null
  }

  const open = stories.findIndex(story => story.passes !== true)
  const index = open >= 0 ? open : stories.length - 1

  return `Story ${index + 1}/${stories.length}`
}

export const buildLine = ({
  pointer,
  chain,
  prd,
  ralph,
}: ProgressInput): string | undefined => {
  const parts = [phasePart(pointer, chain), storyPart(prd, ralph)].filter(
    (part): part is string => part !== null,
  )

  return parts.length > 0 ? parts.join(' · ') : undefined
}
