#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auditTranscripts, extractBlocks } from './lib/fork-audit.mjs';

function parseArgs(argv) {
  const out = { verbatim: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbatim') {
      out.verbatim = true;
      continue;
    }
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[i + 1] ?? '';
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args['emit-blocks'] !== undefined) {
  if (!args.goal) {
    process.stderr.write('--emit-blocks 에는 --goal 이 필요하다\n');
    process.exit(2);
  }
  const blocks = extractBlocks(readFileSync(args.goal, 'utf8'));
  const body = Object.values(blocks).join('\n\n');
  writeFileSync(args['emit-blocks'], body ? `${body}\n` : '');
  process.stdout.write(JSON.stringify({ written: args['emit-blocks'], blocks: Object.keys(blocks) }) + '\n');
  process.exit(0);
}

for (const k of ['session', 'slug', 'item-flag']) {
  if (!args[k]) {
    process.stderr.write(`--${k} 가 필요하다\n`);
    process.exit(2);
  }
}

const result = auditTranscripts({
  projectsRoot: args['projects-root'] || join(homedir(), '.claude', 'projects'),
  session: args.session,
  slug: args.slug,
  itemFlag: args['item-flag'],
  keys: (args.keys ?? '').split(',').map((k) => k.trim()).filter(Boolean),
  forkName: args['fork-name'] || undefined,
  scopeSlug: args['scope-slug'] || undefined,
  goal: args.goal || undefined,
  verbatim: args.verbatim,
});

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(result.verdict === 'pass' ? 0 : result.verdict === 'fail' ? 1 : 3);
