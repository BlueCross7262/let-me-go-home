/**
 * Hook kill switches, shared by all three hook entry points.
 *
 * `DISABLE_LMGH=1` (or `true`) turns every hook off. `LMGH_SKIP_HOOKS` takes a
 * comma-separated list of hook names and turns off only those. A hook that is
 * switched off still has to answer the harness, so callers emit their normal
 * safe-continue response rather than exiting silently.
 */

export function hooksDisabled(hookNames = []) {
  const disable = process.env.DISABLE_LMGH;
  if (disable === '1' || disable === 'true') return true;

  const skip = (process.env.LMGH_SKIP_HOOKS || '')
    .split(',')
    .map((hook) => hook.trim())
    .filter(Boolean);

  return hookNames.some((name) => skip.includes(name));
}
