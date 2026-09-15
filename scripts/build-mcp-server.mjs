#!/usr/bin/env node
/**
 * Build script for standalone MCP server bundle
 * Bundles the MCP server into a standalone JS file for plugin distribution
 */

import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

// Output to bridge/ directory (not gitignored) for plugin distribution
const outfile = 'bridge/mcp-server.cjs';

// Ensure output directory exists
await mkdir('bridge', { recursive: true });

const watchMode = process.argv.includes('--watch');

const buildConfig = {
  entryPoints: ['src/mcp/standalone-server.ts'],
  bundle: true,
  preserveSymlinks: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
  // Prefer ESM entry points so UMD packages (e.g. jsonc-parser) get properly bundled
  mainFields: ['module', 'main'],
  // Externalize Node.js built-ins
  external: [
    'fs', 'path', 'os', 'util', 'stream', 'events',
    'buffer', 'crypto', 'http', 'https', 'url',
    'child_process', 'assert', 'module', 'net', 'tls',
    'dns', 'readline', 'tty', 'worker_threads',
  ],
};

if (watchMode) {
  const ctx = await esbuild.context(buildConfig);
  await ctx.watch();
  console.error(`Watching ${outfile}...`);
} else {
  await esbuild.build(buildConfig);
  console.error(`Built ${outfile}`);
}
