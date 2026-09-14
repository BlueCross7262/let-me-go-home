import { homedir } from 'node:os';
import { join, normalize, parse, sep } from 'node:path';
import { STATE_DIR } from './namespace.mjs';

function stripTrailingSep(p) {
  if (!p.endsWith(sep)) {
    return p;
  }

  return p === parse(p).root ? p : p.slice(0, -1);
}

export function getClaudeConfigDir() {
  const home = homedir();
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();

  if (!configured) {
    return stripTrailingSep(normalize(join(home, '.claude')));
  }

  if (configured === '~') {
    return stripTrailingSep(normalize(home));
  }

  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return stripTrailingSep(normalize(join(home, configured.slice(2))));
  }

  return stripTrailingSep(normalize(configured));
}

export function getLmghConfigDir() {
  return join(getClaudeConfigDir(), STATE_DIR);
}

export function getUpdateCheckCachePath() {
  return join(getLmghConfigDir(), 'update-check.json');
}
