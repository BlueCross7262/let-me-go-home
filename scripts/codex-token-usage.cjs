#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_SESSIONS_DIR = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, 'sessions')
  : path.join(os.homedir(), '.codex', 'sessions');

function parseThreadIdArg() {
  const arg = process.argv.find((a) => a.startsWith('--thread-id='));
  if (arg) return arg.slice('--thread-id='.length).trim();
  const idx = process.argv.indexOf('--thread-id');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1].trim();
  return null;
}

function findRolloutFile(dir, threadId) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findRolloutFile(full, threadId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) {
      return full;
    }
  }
  return null;
}

function extractLastTokenCount(rolloutFile) {
  const lines = fs.readFileSync(rolloutFile, 'utf8').split('\n').filter(Boolean);
  let last = null;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count') {
      const usage = obj.payload.info && obj.payload.info.total_token_usage;
      if (usage) last = usage;
    }
  }
  return last;
}

function main() {
  const threadId = parseThreadIdArg();
  if (!threadId) {
    console.log(JSON.stringify({ tokenAvailable: false, reason: 'missing --thread-id' }));
    return;
  }

  try {
    const rolloutFile = findRolloutFile(CODEX_SESSIONS_DIR, threadId);
    if (!rolloutFile) {
      console.log(JSON.stringify({ tokenAvailable: false, threadId, reason: 'rollout file not found' }));
      return;
    }

    const usage = extractLastTokenCount(rolloutFile);
    if (!usage) {
      console.log(JSON.stringify({ tokenAvailable: false, threadId, rolloutFile, reason: 'no token_count event in rollout file' }));
      return;
    }

    console.log(JSON.stringify({
      tokenAvailable: true,
      threadId,
      rolloutFile,
      tokens: {
        input_tokens: usage.input_tokens ?? null,
        cached_input_tokens: usage.cached_input_tokens ?? null,
        cache_write_input_tokens: usage.cache_write_input_tokens ?? null,
        output_tokens: usage.output_tokens ?? null,
        reasoning_output_tokens: usage.reasoning_output_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
      },
    }));
  } catch (err) {
    console.log(JSON.stringify({
      tokenAvailable: false,
      threadId,
      reason: String((err && err.message) || err),
    }));
  }
}

main();
