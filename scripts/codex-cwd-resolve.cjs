#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const IS_WINDOWS = path.sep === '\\';
const USAGE = 'usage: codex-cwd-resolve.cjs [-h] [--input ABS_PATH] [--session-cwd ABS_PATH] [--include-session-cwd]';

function normalizePath(input) {
  return path.resolve(input).split(path.sep).join('/');
}

function splitDrive(value) {
  if (!IS_WINDOWS) return { drive: '', tail: value };
  const match = /^([A-Za-z]:|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.exec(value);
  const drive = match ? match[1] : '';
  return { drive, tail: value.slice(drive.length) };
}

function isDriveRoot(value) {
  const { tail } = splitDrive(value);
  return tail === '' || tail === '/' || tail === '\\';
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function comparable(text) {
  return IS_WINDOWS ? text.toLowerCase() : text;
}

function splitSegments(value) {
  const { drive, tail } = splitDrive(value);
  const segments = tail.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  return { drive, segments };
}

function commonAncestor(paths) {
  const parts = paths.map(splitSegments);
  const drives = new Set(parts.map((p) => comparable(p.drive)));
  if (drives.size !== 1) throw new Error("Paths don't have the same drive");
  const keyed = parts.map((p) => p.segments.map(comparable));
  let length = 0;
  while (
    length < keyed[0].length
    && keyed.every((segments) => segments.length > length && segments[length] === keyed[0][length])
  ) {
    length += 1;
  }
  return `${parts[0].drive}/${parts[0].segments.slice(0, length).join('/')}`;
}

function rejected(reason, inputs) {
  return { ok: false, cwd: null, reason, inputs };
}

function climbToDirectory(start) {
  let current = start;
  while (!isDriveRoot(current) && !isDirectory(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent.split(path.sep).join('/');
  }
  return current;
}

function resolve({ inputs, sessionCwd, includeSessionCwd }) {
  const paths = inputs.map(normalizePath);
  if (includeSessionCwd) {
    if (!sessionCwd) {
      return rejected('include-session-cwd 를 켰는데 --session-cwd 가 없다', paths);
    }
    paths.push(normalizePath(sessionCwd));
  }
  if (paths.length === 0) {
    return rejected('입력 경로가 하나도 없다', paths);
  }

  let common;
  try {
    common = commonAncestor(paths);
  } catch (err) {
    return rejected(`공통 조상 없음 — ${err.message}`, paths);
  }

  common = climbToDirectory(common);
  if (isDriveRoot(common)) {
    return rejected(`산출값이 드라이브 루트(${common})라 읽기 범위가 과도하다`, paths);
  }
  return { ok: true, cwd: common, reason: '', inputs: paths };
}

function valueOption(argv, index, name) {
  const token = argv[index];
  if (token === name) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`argument ${name}: expected one argument`);
    }
    return { value, next: index + 2 };
  }
  if (token.startsWith(`${name}=`)) {
    return { value: token.slice(name.length + 1), next: index + 1 };
  }
  return null;
}

function parseArgs(argv) {
  const options = { inputs: [], sessionCwd: undefined, includeSessionCwd: false, help: false };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    const input = valueOption(argv, index, '--input');
    const session = valueOption(argv, index, '--session-cwd');
    if (input) {
      options.inputs.push(input.value);
      index = input.next;
    } else if (session) {
      options.sessionCwd = session.value;
      index = session.next;
    } else if (token === '--include-session-cwd') {
      options.includeSessionCwd = true;
      index += 1;
    } else if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
    } else {
      throw new Error(`unrecognized arguments: ${token}`);
    }
  }
  return options;
}

function toAsciiJson(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${USAGE}\ncodex-cwd-resolve.cjs: error: ${err.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  process.stdout.write(`${toAsciiJson(resolve(options))}\n`);
  return 0;
}

module.exports = { resolve };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
