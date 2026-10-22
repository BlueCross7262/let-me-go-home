import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenarios } from './run-scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }),
);
const hook = path.resolve(args.hook || path.join(here, '..', '..', 'hooks', 'ralph-stop.mjs'));
const out = path.resolve(args.out || path.join(here, `golden.${process.platform}.json`));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lmgh-oracle-'));

try {
  const results = runScenarios({ hook, base, only: args.only || undefined });
  const golden = {
    platform: process.platform,
    scenarios: Object.fromEntries(results.map((result) => [result.id, result])),
  };
  fs.writeFileSync(out, JSON.stringify(golden, null, 2) + '\n');
  console.log(`golden written: ${out} (${results.length} scenarios)`);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
