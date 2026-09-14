/**
 * Mode Names - Single source of truth for all execution mode name constants.
 *
 * Every module that references mode names by string should import from here
 * instead of hardcoding literals. This prevents drift when modes are added,
 * renamed, or removed.
 *
 * This fork ships Ralph and Deep Interview, and those are the only entries.
 * Upstream's autopilot, autoresearch, team, ralplan, self-improve and
 * merge-readiness names are gone with their runtimes — leaving them behind made
 * `state_get_status` advertise modes that cannot be started.
 */

/** All supported execution mode identifiers. */
export const MODE_NAMES = {
  RALPH: 'ralph',
  DEEP_INTERVIEW: 'deep-interview',
} as const;

/** Union type derived from the constant map. */
export type ModeName = typeof MODE_NAMES[keyof typeof MODE_NAMES];

/**
 * All mode names as an array (useful for iteration).
 * Order matches the canonical ExecutionMode union in mode-registry/types.ts.
 */
export const ALL_MODE_NAMES: readonly ModeName[] = [
  MODE_NAMES.RALPH,
  MODE_NAMES.DEEP_INTERVIEW,
] as const;

/**
 * Mode state file mapping — the canonical filename for each mode's state file
 * relative to `.lmgh/state/`.
 */
export const MODE_STATE_FILE_MAP: Readonly<Record<ModeName, string>> = {
  [MODE_NAMES.RALPH]: 'ralph-state.json',
  [MODE_NAMES.DEEP_INTERVIEW]: 'deep-interview-state.json',
};

/**
 * Mode state files used by session-end cleanup.
 * Includes marker files for modes that use them.
 */
export const SESSION_END_MODE_STATE_FILES: readonly { file: string; mode: string }[] = [
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.RALPH], mode: MODE_NAMES.RALPH },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.DEEP_INTERVIEW], mode: MODE_NAMES.DEEP_INTERVIEW },
  { file: 'skill-active-state.json', mode: 'skill-active' },
];

/**
 * Modes detected by session-end for metrics reporting.
 */
export const SESSION_METRICS_MODE_FILES: readonly { file: string; mode: string }[] = [
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.RALPH], mode: MODE_NAMES.RALPH },
  { file: MODE_STATE_FILE_MAP[MODE_NAMES.DEEP_INTERVIEW], mode: MODE_NAMES.DEEP_INTERVIEW },
];
