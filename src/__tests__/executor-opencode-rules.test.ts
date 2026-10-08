import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const EXECUTOR = readFileSync(join(ROOT, 'agents', 'executor.md'), 'utf8').replace(/\r\n/g, '\n');
const RULES = readFileSync(join(ROOT, 'scripts', 'executor-opencode-rules.md'), 'utf8').replace(/\r\n/g, '\n');

const BLOCKED_FIRST_LINE = 'BLOCKED: design decision required';
const TEMPLATE_FIRST_LINE = '## Changes Made';
const FORBIDDEN_STRINGS = ['Serena', 'SendMessage', 'ctx_', 'context-mode', 'ToolSearch', 'hookify'];

const COPIED_VERBATIM: Array<{ heading: string; level: number }> = [
  { heading: '슬롯 줄 규칙', level: 3 },
  { heading: '슬롯 키', level: 3 },
  { heading: '미결 표기', level: 3 },
  { heading: '받을 때 BLOCKED', level: 3 },
  { heading: '편집 전 결정 목록', level: 3 },
  { heading: 'Success_Criteria', level: 2 },
  { heading: 'Investigation_Protocol', level: 2 },
  { heading: 'Failure_Modes_To_Avoid', level: 2 },
  { heading: 'Final_Checklist', level: 2 },
];

function sectionBody(text: string, heading: string, level: number): string | null {
  const lines = text.split('\n');
  const marker = `${'#'.repeat(level)} ${heading}`;
  let inFence = false;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (start === -1) {
      if (line === marker) start = index + 1;
      continue;
    }
    const match = /^(#{1,6}) /.exec(line);
    if (match && match[1].length <= level) return lines.slice(start, index).join('\n');
  }
  return start === -1 ? null : lines.slice(start).join('\n');
}

function codeBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (current) {
        blocks.push(current);
        current = null;
      } else {
        current = [];
      }
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

function blockStartingWith(text: string, firstLine: string): string[][] {
  return codeBlocks(text).filter((block) => block[0] === firstLine);
}

function slotKeys(text: string): string[] {
  const body = sectionBody(text, '슬롯 키', 3) ?? '';
  return body
    .split('\n')
    .map((line) => /^\| `([a-z_]+=)` \|/.exec(line)?.[1])
    .filter((key): key is string => Boolean(key));
}

function slotTableMatches(executorText: string, rulesText: string): boolean {
  const keys = slotKeys(executorText);
  if (keys.length === 0) return false;
  const rulesKeys = slotKeys(rulesText);
  return keys.length === rulesKeys.length && keys.every((key, index) => rulesKeys[index] === key);
}

describe('executor.md source anchors', () => {
  it('has exactly one BLOCKED block and one report template as code blocks', () => {
    expect(blockStartingWith(EXECUTOR, BLOCKED_FIRST_LINE)).toHaveLength(1);
    expect(blockStartingWith(EXECUTOR, TEMPLATE_FIRST_LINE)).toHaveLength(1);
  });

  it('lists the eighteen input contract slot keys', () => {
    expect(slotKeys(EXECUTOR)).toEqual([
      'edit_kind=',
      'owned_files=',
      'design=',
      'responsibilities=',
      'signatures=',
      'behavior=',
      'call_relations=',
      'keep=',
      'forbidden=',
      'contract=',
      'allowed_packages=',
      'tool_routing=',
      'build_cmd=',
      'test_cmd=',
      'baseline_failed=',
      'attempts=',
      'test_requirements=',
      'done_criteria=',
    ]);
  });
});

describe('executor-opencode-rules.md', () => {
  it('carries the BLOCKED block byte-identical to executor.md', () => {
    const fromExecutor = blockStartingWith(EXECUTOR, BLOCKED_FIRST_LINE);
    const fromRules = blockStartingWith(RULES, BLOCKED_FIRST_LINE);
    expect(fromExecutor).toHaveLength(1);
    expect(fromRules).toEqual(fromExecutor);
  });

  it('carries the report template byte-identical to executor.md', () => {
    const fromExecutor = blockStartingWith(EXECUTOR, TEMPLATE_FIRST_LINE);
    const fromRules = blockStartingWith(RULES, TEMPLATE_FIRST_LINE);
    expect(fromExecutor).toHaveLength(1);
    expect(fromRules).toEqual(fromExecutor);
  });

  it.each(FORBIDDEN_STRINGS)('does not mention %s', (needle) => {
    expect(RULES.includes(needle)).toBe(false);
  });

  it('keeps the slot key table in the same order as executor.md', () => {
    expect(slotTableMatches(EXECUTOR, RULES)).toBe(true);
  });

  it.each(COPIED_VERBATIM)('copies section "$heading" verbatim', ({ heading, level }) => {
    const fromExecutor = sectionBody(EXECUTOR, heading, level);
    const fromRules = sectionBody(RULES, heading, level);
    expect(fromExecutor).not.toBeNull();
    expect(fromExecutor!.trim()).not.toBe('');
    expect(fromRules).toBe(fromExecutor);
  });

  it('keeps every Constraints line of executor.md except the one that names SendMessage', () => {
    const fromExecutor = (sectionBody(EXECUTOR, 'Constraints', 2) ?? '').split('\n');
    const fromRules = new Set((sectionBody(RULES, 'Constraints', 2) ?? '').split('\n'));
    const missing = fromExecutor.filter((line) => !line.includes('SendMessage') && !fromRules.has(line));
    expect(fromExecutor.length).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });

  it('rewrites the three executor lines that named SendMessage', () => {
    expect(RULES).toContain('호출부의 지시는 첫 메시지와 첨부된 명세 파일이다.');
    expect(RULES).toContain('첫 메시지와 첨부된 명세 파일이 여기 해당한다.');
    expect(RULES).toContain('결과는 최종 응답 텍스트로 낸다.');
  });

  it('states that commands run only when the caller supplies them and that tool_routing is ignored', () => {
    expect(RULES).toContain('build_cmd·test_cmd 를 호출부가 주지 않았으면 빌드·테스트를 실행하지 않는다.');
    expect(RULES).toContain('`tool_routing=` 슬롯은 opencode 에서 무시한다.');
  });

  it('tells the model to write the report without code fences', () => {
    expect(RULES).toContain('보고는 코드 펜스 없이 쓴다.');
  });
});

describe('drift detection', () => {
  it('fails when a slot row is removed from the executor copy', () => {
    const mutated = EXECUTOR.split('\n')
      .filter((line) => !line.startsWith('| `done_criteria=`'))
      .join('\n');
    expect(slotTableMatches(mutated, RULES)).toBe(false);
  });

  it('fails when the executor copy has no slot table at all', () => {
    expect(slotTableMatches('no table here', RULES)).toBe(false);
  });

  it('fails the BLOCKED block comparison when one line of the block changes', () => {
    const mutated = EXECUTOR.replace('Impact:', 'Impacts:');
    expect(blockStartingWith(mutated, BLOCKED_FIRST_LINE)).not.toEqual(blockStartingWith(RULES, BLOCKED_FIRST_LINE));
  });
});
