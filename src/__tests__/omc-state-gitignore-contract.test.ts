import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('.lmgh gitignore state contract', () => {
  it('ignores runtime .lmgh state while allowing project skills to be committed intentionally', () => {
    const gitignore = readFileSync(resolve(process.cwd(), '.gitignore'), 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(gitignore).toEqual(expect.arrayContaining([
      '!.lmgh/',
      '.lmgh/*',
      '!.lmgh/skills/',
      '!.lmgh/skills/**',
    ]));

    expect(gitignore.indexOf('!.lmgh/')).toBeLessThan(gitignore.indexOf('.lmgh/*'));
    expect(gitignore.indexOf('.lmgh/*')).toBeLessThan(gitignore.indexOf('!.lmgh/skills/'));
    expect(gitignore.indexOf('!.lmgh/skills/')).toBeLessThan(gitignore.indexOf('!.lmgh/skills/**'));
  });
});
