import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { LOCK_LOG_TAG } from './namespace.mjs';

const localLocks = new Map();
const recoveryLocks = new Map();
// The current process's own start identity is immutable for the process
// lifetime once successfully captured; caching it avoids a fresh
// subprocess spawn (ps on Darwin, powershell on Windows) on every lock
// acquisition. A transient probe failure is NOT cached, so the next call
// retries the real probe instead of permanently fail-closing every
// subsequent lock acquisition for the rest of the process lifetime.
let ownIdentityCache = null;
function ownProcessStartIdentity() {
  if (ownIdentityCache === null) ownIdentityCache = processStartIdentity(process.pid);
  return ownIdentityCache;
}

function writeAllSync(fd, content, label) {
  const bytes = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error(`${label} made no progress`);
    offset += written;
  }
  if (fstatSync(fd).size !== bytes.length) throw new Error(`${label} size verification failed`);
}

export function processStartIdentity(pid) {
  if (process.env.NODE_ENV === 'test' && process.env.LMGH_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const end = stat.lastIndexOf(')'); const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/); return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null; }
    catch (error) { return error?.code === 'ENOENT' ? 'absent' : null; }
  }
  if (process.platform === 'darwin') {
    try { const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }); if (result.status === 0 && result.stdout) { const time = new Date(result.stdout.trim()).getTime(); if (!Number.isNaN(time)) return String(time); } } catch {}
  }
  if (process.platform === 'win32') {
    try { const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().Ticks }`], { encoding: 'utf8', timeout: 3000, windowsHide: true }); const ticks = result.status === 0 ? result.stdout.trim().match(/^\d+$/)?.[0] : null; if (ticks) return `ticks:${ticks}`; } catch {}
  }
  try { process.kill(pid, 0); return null; } catch (error) { return error?.code === 'ESRCH' ? 'absent' : null; }
}

function canonicalKey(lockPath) { try { return resolve(realpathSync(dirname(lockPath)), basename(lockPath)); } catch { return resolve(lockPath); } }
function readOwner(path) { try { const value = JSON.parse(readFileSync(path, 'utf8')); const pid = value.pid; if (value.version !== 1 || !Number.isSafeInteger(pid) || pid <= 0 || typeof value.processStart !== 'string' || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null; return value; } catch (error) { return error?.code === 'ENOENT' ? 'absent' : null; } }
function ownerLive(owner) { const current = processStartIdentity(owner.pid); return current === null ? null : current === 'absent' ? false : current === owner.processStart; }
function sameOwner(left, right) { return left && left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce; }
function publishOwner(path, owner) { const tempPath = `${path}.${owner.pid}.${owner.nonce}.tmp`; let fd; try { mkdirSync(dirname(path), { recursive: true }); fd = openSync(tempPath, 'wx', 0o600); writeAllSync(fd, JSON.stringify(owner), 'lock owner publication'); fsyncSync(fd); closeSync(fd); fd = undefined; linkSync(tempPath, path); unlinkSync(tempPath); return true; } catch { try { if (fd !== undefined) closeSync(fd); } catch {} try { unlinkSync(tempPath); } catch {} return false; } }

function waitBriefly() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
function reclaimMutexPath(lockPath) { return `${lockPath}.reclaiming`; }
function acquireReclaimMutex(lockPath, processStart, attempts) {
  const mutexPath = reclaimMutexPath(lockPath);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    if (publishOwner(mutexPath, owner)) return owner;
    const held = readOwner(mutexPath);
    if (held === 'absent') { waitBriefly(); continue; }
    if (!held) { console.error(`${LOCK_LOG_TAG} state_mutation_lock_unverifiable: ${mutexPath}`); return null; }
    const live = ownerLive(held);
    if (live === null) return null;
    if (live) { waitBriefly(); continue; }
    try { unlinkSync(mutexPath); } catch (error) { if (error?.code !== 'ENOENT') waitBriefly(); }
  }
  return null;
}
function releaseReclaimMutex(lockPath, owner) {
  const mutexPath = reclaimMutexPath(lockPath);
  try { if (sameOwner(readOwner(mutexPath), owner)) unlinkSync(mutexPath); } catch {}
}
function reclaimDeadArtifact(lockPath, processStart, attempts) {
  const mutexOwner = acquireReclaimMutex(lockPath, processStart, attempts);
  if (!mutexOwner) return false;
  try {
    const artifact = readOwner(lockPath);
    if (artifact === 'absent') return true;
    if (!artifact) { console.error(`${LOCK_LOG_TAG} state_mutation_lock_unverifiable: ${lockPath}`); return false; }
    if (ownerLive(artifact) !== false) return false;
    try { unlinkSync(lockPath); } catch (error) { return error?.code === 'ENOENT'; }
    return true;
  } finally {
    releaseReclaimMutex(lockPath, mutexOwner);
  }
}

// LMGH_TEST_FLOCK_AVAILABLE='0' is a test-only simulation switch predating the
// SQLite-based rewrite (originally: is the external flock binary available).
// Locking is no longer flock-based, but tests still rely on this switch to
// simulate a "locking unsupported" fallback path; honor it here so that
// contract is preserved across the storage-backend change.
function stateFileLockingTestOverride() {
  return process.env.NODE_ENV === 'test' && process.env.LMGH_TEST_FLOCK_AVAILABLE === '0' ? false : null;
}
export function isStateFileLockingSupported() {
  const override = stateFileLockingTestOverride();
  return override !== null ? override : true;
}
export function acquireStateFileLockSync(filePath, attempts = 50, requireExclusive = false, bypassTestOverride = false) {
  const lockPath = `${filePath}.mutation.lock`;
  // LMGH_TEST_FLOCK_AVAILABLE='0' simulates the external flock binary being
  // absent. Historically flock-gated callers (an exclusive-required
  // `acquireLockAt` caller such as the cancel-signal-validation lock) failed
  // closed in that state; non-exclusive callers proceeded best-effort.
  // acquireRecoveryClaim's guard lock never went through that flock check at
  // all in the pre-SQLite implementation (it used a separate subprocess-
  // guarded mechanism unconditionally), so it opts out of the simulation via
  // bypassTestOverride and always takes the real file-backed lock.
  if (!bypassTestOverride && stateFileLockingTestOverride() === false) {
    if (requireExclusive) return null;
    const artifact = readOwner(lockPath);
    if (artifact !== 'absent') {
      if (!artifact) return null;
      if (ownerLive(artifact) !== false) return null;
      try { unlinkSync(lockPath); } catch { return null; }
    }
    return { unlocked: true };
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  const key = canonicalKey(lockPath); const held = localLocks.get(key); if (held) { held.depth += 1; return held; }
  const processStart = ownProcessStartIdentity(); if (!processStart || processStart === 'absent') return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    if (publishOwner(lockPath, owner)) { const lock = { lockPath, owner, key, depth: 1 }; localLocks.set(key, lock); return lock; }
    const artifact = readOwner(lockPath);
    if (artifact === 'absent') { waitBriefly(); continue; }
    if (!artifact) { console.error(`${LOCK_LOG_TAG} state_mutation_lock_unverifiable: ${lockPath}`); return null; }
    const live = ownerLive(artifact);
    if (live === null) return null;
    if (live) { waitBriefly(); continue; }
    if (!reclaimDeadArtifact(lockPath, processStart, attempts)) waitBriefly();
  }
  return null;
}
export function releaseStateFileLockSync(lock) { if (!lock || lock.unlocked) return; if (lock.depth > 1) { lock.depth -= 1; return; } localLocks.delete(lock.key); try { if (sameOwner(readOwner(lock.lockPath), lock.owner)) unlinkSync(lock.lockPath); } catch {} }
export function withStateFileLockSync(filePath, callback, requireExclusive = false) { const lock = acquireStateFileLockSync(filePath, 50, requireExclusive); if (!lock) return { acquired: false, value: undefined }; try { return { acquired: true, value: callback() }; } finally { releaseStateFileLockSync(lock); } }

export function acquireRecoveryClaim(path, attempts = 50) {
  const lock = acquireStateFileLockSync(path, attempts, true, true);
  if (!lock) return null;
  const existing = readOwner(path);
  if (existing !== 'absent') {
    if (!existing || ownerLive(existing) !== false) { releaseStateFileLockSync(lock); return null; }
    try { unlinkSync(path); } catch { releaseStateFileLockSync(lock); return null; }
  }
  const processStart = ownProcessStartIdentity();
  if (!processStart || processStart === 'absent') {
    releaseStateFileLockSync(lock);
    // Transient: the identity probe can fail under the same load that
    // causes SQLite lock contention. Retry within budget rather than
    // failing closed on the first transient probe failure.
    if (attempts <= 1) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    return acquireRecoveryClaim(path, attempts - 1);
  }
  const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
  if (!publishOwner(path, owner)) { releaseStateFileLockSync(lock); return null; }
  return owner;
}
export function readRecoveryClaim(path) { const owner = readOwner(path); return owner === 'absent' ? null : owner; }
export function releaseRecoveryClaim(path, owner) {
  const lock = localLocks.get(canonicalKey(`${path}.mutation.lock`));
  if (!lock) return;
  try {
    const current = readRecoveryClaim(path);
    if (sameOwner(current, owner)) unlinkSync(path);
  } finally {
    releaseStateFileLockSync(lock);
  }
}
export function sameRecoveryClaim(left, right) { return sameOwner(left, right); }
export function isEmergencyOwnerLive(owner) { return ownerLive(owner) !== false; }
