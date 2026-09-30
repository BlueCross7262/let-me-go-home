import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BLOCK_ORDER = ['§2', '§7 판단 기본값', '§7 Phase 컴포넌트', '§8'];

function toLines(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n');
}

function nonEmptyTrimmed(text) {
  return toLines(text).map((l) => l.trim()).filter((l) => l !== '');
}

function sliceUntil(lines, start, isStop) {
  let end = start + 1;
  while (end < lines.length && !isStop(lines[end])) end++;
  return lines.slice(start, end).join('\n').replace(/\s+$/, '');
}

export function extractBlocks(markdown) {
  const lines = toLines(markdown);
  const blocks = {};
  const isH2 = (l) => /^## /.test(l);
  const isH2or3 = (l) => /^#{2,3} /.test(l);

  const s2 = lines.findIndex((l) => /^## 2\./.test(l));
  if (s2 >= 0) blocks['§2'] = sliceUntil(lines, s2, isH2);

  const s7 = lines.findIndex((l) => /^## 7\./.test(l));
  if (s7 >= 0) {
    let s7end = s7 + 1;
    while (s7end < lines.length && !isH2(lines[s7end])) s7end++;
    for (const [name, re] of [['§7 판단 기본값', /^### 판단 기본값/], ['§7 Phase 컴포넌트', /^### Phase 컴포넌트/]]) {
      const i = lines.findIndex((l, idx) => idx > s7 && idx < s7end && re.test(l));
      if (i >= 0) blocks[name] = sliceUntil(lines, i, isH2or3);
    }
  }

  const s8 = lines.findIndex((l) => /^## 8\./.test(l));
  if (s8 >= 0) blocks['§8'] = sliceUntil(lines, s8, isH2);

  const ordered = {};
  for (const k of BLOCK_ORDER) if (k in blocks) ordered[k] = blocks[k];
  return ordered;
}

export function windowMatch(block, args) {
  const b = nonEmptyTrimmed(block);
  const a = nonEmptyTrimmed(args);
  if (b.length === 0) return true;
  for (let s = 0; s + b.length <= a.length; s++) {
    let k = 0;
    while (k < b.length && a[s + k] === b[k]) k++;
    if (k === b.length) return true;
  }
  return false;
}

function readJsonl(file) {
  const entries = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return entries;
}

function skillCalls(entries) {
  const calls = [];
  for (const e of entries) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== 'tool_use' || c.name !== 'Skill') continue;
      if (!/deep-interview/.test(c.input?.skill ?? '')) continue;
      calls.push({ args: String(c.input?.args ?? ''), ts: Date.parse(e.timestamp ?? '') || 0 });
    }
  }
  return calls;
}

function tokens(args) {
  return args.trim().split(/\s+/).filter(Boolean);
}

function slugToken(args) {
  const t = tokens(args);
  const i = t.indexOf('--slug');
  return i >= 0 && i + 1 < t.length ? t[i + 1] : null;
}

function findMainTranscript(projectsRoot, session) {
  if (!existsSync(projectsRoot)) return [];
  const hits = [];
  for (const d of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(projectsRoot, d.name, `${session}.jsonl`);
    if (existsSync(f)) hits.push(f);
  }
  return hits;
}

function forkTranscripts(sessionDir, forkName) {
  const sub = join(sessionDir, 'subagents');
  if (!existsSync(sub)) return [];
  const files = [];
  for (const f of readdirSync(sub)) {
    if (!/^agent-.*\.meta\.json$/.test(f)) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(sub, f), 'utf8'));
    } catch {
      continue;
    }
    if (meta?.name !== forkName) continue;
    const jsonl = join(sub, f.replace(/\.meta\.json$/, '.jsonl'));
    if (existsSync(jsonl)) files.push(jsonl);
  }
  return files.sort();
}

export function auditTranscripts({ projectsRoot, session, slug, itemFlag, keys = [], forkName, scopeSlug, goal, verbatim = false }) {
  const mains = findMainTranscript(projectsRoot, session);
  if (mains.length !== 1) return { verdict: 'audit-unavailable', reason: `main transcript count ${mains.length}`, fails: [], transcripts: [] };
  const main = mains[0];
  const sessionDir = main.replace(/\.jsonl$/, '');
  const transcripts = [];

  let itemCalls;
  if (forkName) {
    const files = forkTranscripts(sessionDir, forkName);
    if (files.length === 0) return { verdict: 'audit-unavailable', reason: `no transcript for fork ${forkName}`, fails: [], transcripts: [] };
    transcripts.push(...files);
    itemCalls = files.flatMap((f) => skillCalls(readJsonl(f))).sort((a, b) => a.ts - b.ts);
  }
  let mainCalls = null;
  const needMain = !forkName || scopeSlug;
  if (needMain) {
    transcripts.push(main);
    mainCalls = skillCalls(readJsonl(main));
  }
  if (!forkName) itemCalls = mainCalls;

  const blocks = verbatim && goal ? extractBlocks(readFileSync(goal, 'utf8')) : {};
  const fails = [];
  const judge = (key, want, calls, wantFlag) => {
    const mine = calls.filter((c) => slugToken(c.args) === want);
    if (mine.length === 0) {
      fails.push({ key, reason: 'no-skill-call' });
      return;
    }
    const last = mine[mine.length - 1];
    if (wantFlag && tokens(last.args)[0] !== wantFlag) fails.push({ key, reason: 'flag' });
    for (const [name, text] of Object.entries(blocks)) {
      if (!windowMatch(text, last.args)) fails.push({ key, reason: `verbatim:${name}` });
    }
  };

  if (scopeSlug) judge('scope', scopeSlug, mainCalls, itemFlag === '--unattended' ? '--unattended' : null);
  for (const key of keys) judge(key, `${slug}-${key}`, itemCalls, itemFlag);

  return { verdict: fails.length ? 'fail' : 'pass', fails, transcripts };
}
