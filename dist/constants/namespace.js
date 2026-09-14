/**
 * Namespace Constants
 *
 * Single source of truth for every name this plugin derives from its own
 * namespace — the state directory, the workspace marker, the config file
 * names. Nothing else in `src/**` or `scripts/**` spells these out; production
 * code imports from here so the namespace is changed in exactly one place.
 *
 * Tests keep their own literals on purpose. A test that asserts against the
 * constant it is testing proves nothing, so the literals in `__tests__` stay
 * an independent oracle.
 *
 * The standalone hook scripts cannot import this module — they must keep
 * running when `dist/` is absent. `scripts/build-namespace.mjs` generates
 * `scripts/lib/namespace.mjs` from the compiled output of this file instead,
 * so those scripts import a plain sibling file that carries the same values.
 *
 * Environment variable names (`LMGH_*`) are deliberately not here yet. They
 * are a user-facing interface read at ~180 sites, and routing them through a
 * computed lookup would cost grep-ability without removing any duplication.
 */
export const NAMESPACE = 'lmgh';
export const PLUGIN_NAME = 'let-me-go-home';
/** Project-local state root: everything the runtime writes lives under this. */
export const STATE_DIR = `.${NAMESPACE}`;
/** Marker file that anchors a multi-repo workspace to a shared state root. */
export const WORKSPACE_MARKER = `${STATE_DIR}-workspace`;
/** Notification config, resolved against the Claude config dir. */
export const NOTIFY_CONFIG_FILE = `${STATE_DIR}-config.json`;
/** Prefix for a directory moved aside after a failed install swap. */
export const ASIDE_SUFFIX = `${STATE_DIR}-stale-`;
/** Project config file, resolved against `.claude/`. */
export const PROJECT_CONFIG_FILE = `${NAMESPACE}.jsonc`;
/** User config directory, resolved against the platform config home. */
export const USER_CONFIG_DIR = `claude-${NAMESPACE}`;
/** Prefix on warnings this plugin writes to stderr. */
export const LOG_TAG = `[${NAMESPACE}]`;
/** Prefix on the state-mutation lock diagnostics this plugin writes to stderr. */
export const LOCK_LOG_TAG = `[${NAMESPACE}-lock]`;
/** Prefix on every environment variable this plugin reads. */
export const ENV_PREFIX = `${NAMESPACE.toUpperCase()}_`;
/**
 * Build a POSIX-style path under the state root.
 *
 * The separator is `/` rather than the platform separator because these are
 * relative constants that also appear in prompts, messages, and config
 * defaults. `join()` normalizes them when they are resolved against a root.
 */
export function statePath(...segments) {
    return segments.length > 0 ? `${STATE_DIR}/${segments.join('/')}` : STATE_DIR;
}
//# sourceMappingURL=namespace.js.map