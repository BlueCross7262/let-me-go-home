import { describe, it, expect } from 'vitest';
import {
  formatRalphTaskLines,
  formatRalphTaskPointerLines,
  RALPH_PROMPT_FLAGS,
  TASK_LINE_LIMIT,
  // @ts-expect-error Hook runtime source is intentionally JavaScript-only.
} from '../../scripts/lib/ralph-task.mjs';

const PROMPT_FILE = '/state/sessions/s1/ralph-prompt.md';
const STATE_FILE = '/state/sessions/s1/ralph-state.json';

describe('formatRalphTaskLines', () => {
  it('uses a 1500 code point limit and the two ralph flags', () => {
    expect(TASK_LINE_LIMIT).toBe(1500);
    expect(RALPH_PROMPT_FLAGS).toEqual(['--refine-check', '--no-deslop']);
  });

  it('returns no lines for a missing or blank prompt', () => {
    expect(formatRalphTaskLines(undefined, PROMPT_FILE, STATE_FILE)).toEqual([]);
    expect(formatRalphTaskLines('   ', PROMPT_FILE, STATE_FILE)).toEqual([]);
    expect(formatRalphTaskLines(42, PROMPT_FILE, STATE_FILE)).toEqual([]);
  });

  it('keeps a prompt at the limit verbatim and still points at the prompt file', () => {
    const prompt = 'a'.repeat(1500);
    expect(formatRalphTaskLines(prompt, PROMPT_FILE, STATE_FILE)).toEqual([
      `Task: ${prompt}`,
      `Full task text: ${PROMPT_FILE}`,
    ]);
  });

  it('keeps a short prompt on one line when there is no prompt file', () => {
    expect(formatRalphTaskLines('short task', undefined, STATE_FILE)).toEqual(['Task: short task']);
    expect(formatRalphTaskLines('short task', '', STATE_FILE)).toEqual(['Task: short task']);
  });

  it('excerpts a longer prompt and points at the prompt file', () => {
    const prompt = `${'b'.repeat(1500)}TAIL-MARKER`;
    const lines = formatRalphTaskLines(prompt, PROMPT_FILE, STATE_FILE);
    expect(lines).toEqual([
      `Task (first 1500 of 1511 chars): ${'b'.repeat(1500)} …`,
      `Full task text: ${PROMPT_FILE}`,
    ]);
    expect(lines.join('\n')).not.toContain('TAIL-MARKER');
  });

  it('points at the state file when there is no prompt file', () => {
    const lines = formatRalphTaskLines('c'.repeat(1600), undefined, STATE_FILE);
    expect(lines[lines.length - 1]).toBe(`Full task text: the prompt field of ${STATE_FILE}`);
  });

  it('omits the pointer when neither path is known', () => {
    const lines = formatRalphTaskLines('c'.repeat(1600), '', undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('Task (first 1500 of 1600 chars): ')).toBe(true);
  });

  it('lists ralph flags found beyond the excerpt in list order', () => {
    const prompt = `${'x'.repeat(2000)} --no-deslop --project-dir /repo --refine-check`;
    const lines = formatRalphTaskLines(prompt, PROMPT_FILE, STATE_FILE);
    expect(lines).toContain('Task flags: --refine-check --no-deslop');
    expect(lines.join('\n')).not.toContain('--project-dir');
  });

  it('lists the critic mode flag found beyond the excerpt after the fixed flags', () => {
    const prompt = `${'x'.repeat(2000)} --critic=critic --refine-check`;
    const lines = formatRalphTaskLines(prompt, PROMPT_FILE, STATE_FILE);
    expect(lines).toContain('Task flags: --refine-check --critic=critic');
  });

  it('lists the critic mode flag alone when no fixed flag is present', () => {
    const prompt = `${'x'.repeat(2000)} --critic=architect`;
    const lines = formatRalphTaskLines(prompt, PROMPT_FILE, STATE_FILE);
    expect(lines).toContain('Task flags: --critic=architect');
  });

  it('does not treat a bare or empty critic token as the critic mode flag', () => {
    const prompt = `${'x'.repeat(2000)} --critic --critic= --criticism=critic`;
    const lines: string[] = formatRalphTaskLines(prompt, PROMPT_FILE, STATE_FILE);
    expect(lines.some((line) => line.startsWith('Task flags:'))).toBe(false);
  });

  it('does not treat a longer token as a ralph flag', () => {
    const prompt = `${'x'.repeat(2000)} --refine-checker --no-deslop=false`;
    const lines: string[] = formatRalphTaskLines(prompt, PROMPT_FILE, STATE_FILE);
    expect(lines.some((line) => line.startsWith('Task flags:'))).toBe(false);
  });

  it('counts code points so a surrogate pair is never split', () => {
    const prompt = '😀'.repeat(1501);
    const lines = formatRalphTaskLines(prompt, PROMPT_FILE, STATE_FILE);
    expect(lines[0]).toBe(`Task (first 1500 of 1501 chars): ${'😀'.repeat(1500)} …`);
  });
});

describe('formatRalphTaskPointerLines', () => {
  it('returns no lines for a missing or blank prompt', () => {
    expect(formatRalphTaskPointerLines(undefined, PROMPT_FILE, STATE_FILE)).toEqual([]);
    expect(formatRalphTaskPointerLines('   ', PROMPT_FILE, STATE_FILE)).toEqual([]);
  });

  it('gives only the prompt file pointer and no excerpt for a short prompt', () => {
    const lines = formatRalphTaskPointerLines('short task', PROMPT_FILE, STATE_FILE);
    expect(lines).toEqual([`Full task text: ${PROMPT_FILE}`]);
  });

  it('gives only the prompt file pointer for a long prompt with flags', () => {
    const prompt = `${'x'.repeat(2000)} --no-deslop --refine-check --critic=critic`;
    const lines = formatRalphTaskPointerLines(prompt, PROMPT_FILE, STATE_FILE);
    expect(lines).toEqual([`Full task text: ${PROMPT_FILE}`]);
  });

  it('points at the state file when there is no prompt file', () => {
    const lines = formatRalphTaskPointerLines('short task', undefined, STATE_FILE);
    expect(lines).toEqual([`Full task text: the prompt field of ${STATE_FILE}`]);
  });

  it('falls back to the excerpt when neither path is known', () => {
    expect(formatRalphTaskPointerLines('short task', '', undefined)).toEqual(['Task: short task']);
    const lines = formatRalphTaskPointerLines('c'.repeat(1600), '', undefined);
    expect(lines[0].startsWith('Task (first 1500 of 1600 chars): ')).toBe(true);
  });
});
