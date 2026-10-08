export const DEFAULT_USAGE_WAIT_SEC = 60;
export const USAGE_POLL_MS = 500;

const ERROR_LEVEL = /\blevel=ERROR\b/;
const USAGE_PHRASES = /Free usage exceeded|FreeUsageLimitError|GoUsageLimitError|Rate limit exceeded/i;

export function findUsageErrorLine(text) {
  for (const line of text.split(/\r?\n/)) {
    if (ERROR_LEVEL.test(line) && USAGE_PHRASES.test(line)) return line;
  }
  return null;
}

export function parseUsageWaitSec(raw) {
  if (raw === undefined) return { ok: true, value: DEFAULT_USAGE_WAIT_SEC };
  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw)) return { ok: true, value: Number(raw) };
  return { ok: false };
}
