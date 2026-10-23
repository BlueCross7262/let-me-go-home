#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, statSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADOPT_MODULE = join(HERE, "..", "dist", "lib", "session-adopt.js");
const COMMANDS = ["list", "take"];
const VALUE_OPTIONS = ["from", "project-dir", "session-id"];
const FLAG_OPTIONS = ["force"];

function fail(message) {
  console.error(`[ADOPT FAILED] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (FLAG_OPTIONS.includes(key)) {
      if (eq !== -1) fail(`--${key} takes no value`);
      options[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.includes(key)) fail(`unknown option: --${key}`);
    const value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
    if (value === undefined) fail(`--${key} needs a value`);
    options[key] = value;
  }
  return { command, options };
}

function resolveSessionId(explicit) {
  const candidates = [explicit, process.env.CLAUDE_CODE_SESSION_ID, process.env.LMGH_SESSION_ID];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return fail("no session id. Pass --session-id <id>, or run where CLAUDE_CODE_SESSION_ID is set.");
}

function resolveDirectory(raw, required) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    if (required) fail("--project-dir is required");
    return process.cwd();
  }
  if (!isAbsolute(value)) fail(`--project-dir must be an absolute path: ${value}`);
  if (!existsSync(value) || !statSync(value).isDirectory()) {
    fail(`--project-dir is not an existing directory: ${value}`);
  }
  return value;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!COMMANDS.includes(command)) fail(`usage: session-adopt.mjs <${COMMANDS.join("|")}> [options]`);
  if (!existsSync(ADOPT_MODULE)) {
    fail(`built module is missing at ${ADOPT_MODULE}. Run \`npm run build\` first.`);
  }
  let lib;
  try {
    lib = await import(pathToFileURL(ADOPT_MODULE).href);
  } catch (error) {
    fail(`could not load the adopt module: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (command === "list") {
    const projectDir = resolveDirectory(options["project-dir"], false);
    console.log(JSON.stringify({ ok: true, command: "list", project_dir: projectDir, sessions: lib.listAdoptable(projectDir) }, null, 2));
    return;
  }

  const from = typeof options.from === "string" ? options.from.trim() : "";
  if (from === "") fail("--from is required");
  const to = resolveSessionId(options["session-id"]);
  const projectDir = resolveDirectory(options["project-dir"], true);
  const result = lib.adoptSession({ from, to, projectDir, force: options.force === true });
  if (!result.ok) fail(result.error);
  console.log(JSON.stringify({ command: "take", project_dir: projectDir, ...result }, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
