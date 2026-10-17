#!/usr/bin/env node

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  REQ_INTERVIEW_BOOL_KEYS,
  REQ_INTERVIEW_CONTROL_CHARS,
  REQ_INTERVIEW_ITEM_PATTERN,
  REQ_INTERVIEW_REASON_MAX,
  REQ_INTERVIEW_STATUSES,
  REQ_INTERVIEW_STRING_KEYS,
  isPlainObject,
  readJson,
  reqInterviewStatePath,
} from "./lib/checkpoint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const SPEC_KEY_PATTERN = /^[a-z0-9-]+$/;

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, sessionId: undefined, directory: undefined, slug: undefined, sets: [], specs: [], current: undefined };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const take = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= rest.length) throw new UsageError(`${name} needs a value`);
      return rest[i];
    };
    if (name === "--session-id") options.sessionId = take();
    else if (name === "--directory") options.directory = take();
    else if (name === "--slug") options.slug = take();
    else if (name === "--set") options.sets.push(take());
    else if (name === "--spec") options.specs.push(take());
    else if (name === "--current") options.current = take();
    else throw new UsageError(`unknown option ${arg}`);
  }
  return options;
}

function splitAssignment(text, label) {
  const index = text.indexOf("=");
  if (index <= 0) throw new UsageError(`${label} needs key=value: ${text}`);
  return [text.slice(0, index), text.slice(index + 1)];
}

function parseSets(sets) {
  const values = {};
  for (const text of sets) {
    const [key, raw] = splitAssignment(text, "--set");
    if (REQ_INTERVIEW_BOOL_KEYS.includes(key)) {
      if (raw !== "true" && raw !== "false") throw new UsageError(`--set ${key} needs true or false`);
      values[key] = raw === "true";
    } else if (REQ_INTERVIEW_STRING_KEYS.includes(key)) {
      values[key] = raw === "" || raw === "null" ? null : raw;
    } else {
      throw new UsageError(`unknown --set key ${key}`);
    }
  }
  return values;
}

function parseSpecs(specs) {
  const values = {};
  for (const text of specs) {
    const [key, path] = splitAssignment(text, "--spec");
    if (!SPEC_KEY_PATTERN.test(key)) throw new UsageError(`invalid --spec key ${key}`);
    if (path === "") throw new UsageError(`--spec ${key} needs a path`);
    values[key] = path;
  }
  return values;
}

function parseCurrent(text) {
  if (text === "none") return null;
  const first = text.indexOf(":");
  const item = first === -1 ? text : text.slice(0, first);
  const rest = first === -1 ? "" : text.slice(first + 1);
  const second = rest.indexOf(":");
  const status = first === -1 ? "running" : second === -1 ? rest : rest.slice(0, second);
  const rawReason = second === -1 ? "" : rest.slice(second + 1);
  if (!REQ_INTERVIEW_ITEM_PATTERN.test(item)) throw new UsageError(`invalid --current item ${item}`);
  if (!REQ_INTERVIEW_STATUSES.includes(status)) throw new UsageError(`invalid --current status ${status}`);
  if (rawReason.length > REQ_INTERVIEW_REASON_MAX) throw new UsageError("--current reason is too long");
  if (REQ_INTERVIEW_CONTROL_CHARS.test(rawReason)) throw new UsageError("--current reason has a control character");
  return { item, status, reason: rawReason === "" ? null : rawReason };
}

function resolveSessionId(options) {
  const sessionId =
    options.sessionId?.trim() ||
    process.env.CLAUDE_CODE_SESSION_ID?.trim() ||
    process.env.LMGH_SESSION_ID?.trim();
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new UsageError("no valid session id. Pass --session-id <id>, or run where CLAUDE_CODE_SESSION_ID is set");
  }
  return sessionId;
}

function requireSlug(options) {
  if (typeof options.slug !== "string" || options.slug.trim() === "") throw new UsageError("--slug <slug> is required");
  return options.slug;
}

function prepare(options) {
  if (options.command !== "begin" && options.command !== "write" && options.command !== "clear") {
    throw new UsageError("the first argument must be begin, write or clear");
  }
  const sessionId = resolveSessionId(options);
  if (options.command === "clear") return { sessionId };
  const slug = requireSlug(options);
  const sets = parseSets(options.sets);
  const specs = parseSpecs(options.specs);
  if (options.command === "begin" && Object.keys(specs).length > 0) throw new UsageError("begin does not take --spec");
  const hasCurrent = options.current !== undefined;
  const current = hasCurrent ? parseCurrent(options.current) : null;
  return { sessionId, slug, sets, specs, hasCurrent, current };
}

function buildBegin(plan, now) {
  const record = {
    active: true,
    session_id: plan.sessionId,
    slug: plan.slug,
    started_at: now,
    updated_at: now,
  };
  for (const key of REQ_INTERVIEW_BOOL_KEYS) record[key] = plan.sets[key] ?? false;
  for (const key of REQ_INTERVIEW_STRING_KEYS) record[key] = plan.sets[key] ?? null;
  record.specs = {};
  record.current = plan.current;
  return record;
}

function buildWrite(plan, previous, now) {
  const record = { ...previous, ...plan.sets, updated_at: now };
  record.specs = { ...(isPlainObject(previous.specs) ? previous.specs : {}), ...plan.specs };
  if (plan.hasCurrent) record.current = plan.current;
  return record;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = prepare(options);

  process.env.CLAUDE_PLUGIN_ROOT = resolve(HERE, "..");
  const target = resolve(options.directory || process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd());
  const { resolveLmghStateRoot } = await import(pathToFileURL(join(HERE, "lib", "state-root.mjs")).href);
  const stateDir = join(await resolveLmghStateRoot(target), "state");
  const path = reqInterviewStatePath(stateDir, plan.sessionId);

  if (options.command === "clear") {
    rmSync(path, { force: true });
    console.log(`req-interview state clear: ${path}`);
    return;
  }

  const now = new Date().toISOString();
  let record;
  if (options.command === "begin") {
    record = buildBegin(plan, now);
  } else {
    const previous = readJson(path);
    const matches =
      isPlainObject(previous) &&
      previous.active === true &&
      previous.session_id === plan.sessionId &&
      previous.slug === plan.slug;
    if (!matches) {
      console.error(`[REQ-INTERVIEW STATE] no active record for session ${plan.sessionId} and slug ${plan.slug}; nothing written`);
      process.exit(3);
    }
    record = buildWrite(plan, previous, now);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  console.log(`req-interview state ${options.command}: ${path}`);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`[REQ-INTERVIEW STATE FAILED] ${error.message}`);
    process.exit(1);
  }
  console.error(`[REQ-INTERVIEW STATE FAILED] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
