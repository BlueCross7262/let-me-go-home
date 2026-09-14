#!/usr/bin/env node
/**
 * Read-only install and environment diagnosis for this plugin.
 *
 * Every check lives in scripts/lib/health-checks.mjs and is shared with
 * scripts/setup.mjs. This CLI only decides how to print them and what to exit
 * with, so a failing check reads the same way in both skills.
 *
 * Usage:
 *   node scripts/doctor.mjs [--json] [--directory <path>]
 *
 * Exit status:
 *   0  no check failed (warnings are allowed)
 *   1  at least one check failed
 *   2  the diagnosis itself could not run
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runHealthChecks } from "./lib/health-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// This file ships inside the plugin, so its own location is the plugin root.
// CLAUDE_PLUGIN_ROOT is deliberately ignored: Claude Code sets it per running
// hook, so in any other context it names whichever plugin happened to set it.
const PLUGIN_ROOT = join(HERE, "..");

const STATUS_MARK = { ok: "PASS", warn: "WARN", fail: "FAIL" };

function parseArgs(argv) {
  let json = false;
  let directory;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--directory") {
      directory = argv[++i];
      continue;
    }
    if (arg.startsWith("--directory=")) {
      directory = arg.slice("--directory=".length);
      continue;
    }
  }
  return { json, directory };
}

function render(result) {
  const lines = ["let-me-go-home doctor", ""];
  for (const check of result.checks) {
    lines.push(`${STATUS_MARK[check.status]}  ${check.label}: ${check.detail}`);
    if (check.hint) lines.push(`      ${check.hint}`);
  }

  const failed = result.checks.filter((check) => check.status === "fail");
  const warned = result.checks.filter((check) => check.status === "warn");
  lines.push("");
  lines.push(
    failed.length > 0
      ? `${failed.length} failed, ${warned.length} warned. Ralph cannot run until the failures are fixed.`
      : warned.length > 0
        ? `No failures, ${warned.length} warned.`
        : "All checks passed.",
  );
  return lines.join("\n");
}

async function main() {
  const { json, directory } = parseArgs(process.argv.slice(2));
  const target = resolve(directory || process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd());

  let result;
  try {
    result = await runHealthChecks({ pluginRoot: PLUGIN_ROOT, directory: target });
  } catch (error) {
    console.error(`[DOCTOR FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  if (json) {
    console.log(JSON.stringify({ plugin_root: PLUGIN_ROOT, directory: target, ...result }, null, 2));
  } else {
    console.log(render(result));
  }

  process.exit(result.checks.some((check) => check.status === "fail") ? 1 : 0);
}

main().catch((error) => {
  console.error(`[DOCTOR FAILED] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
