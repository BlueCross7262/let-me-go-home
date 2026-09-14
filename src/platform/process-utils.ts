/**
 * Process start identity.
 *
 * The state lock uses this to tell a live owner from a recycled pid: a pid on
 * its own proves nothing once the OS reuses it, but pid plus start time does.
 * Everything else this module held — process-group capture, tree termination,
 * graceful kill escalation — served upstream tmux worker management, which
 * this fork does not ship, and had no caller left.
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';

/**
 * Synchronous process start identity capture for use immediately after spawn,
 * before the event loop turns. Closes the PID-reuse window that an async
 * getProcessStartIdentity call would leave open.
 *
 * - Linux: reads /proc/<pid>/stat synchronously (microseconds).
 * - macOS: spawnSync('ps', ...) to get the process start time.
 * - Windows: spawnSync('powershell', ...) to get StartTime ticks.
 *
 * Returns null if the identity cannot be captured synchronously. The caller
 * must fail closed (no signal) when this returns null.
 */
export function getProcessStartIdentitySync(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen === -1) return null;
      const fields = stat.substring(closeParen + 2).split(' ');
      const startTime = parseInt(fields[19] ?? '', 10);
      return Number.isNaN(startTime) ? null : String(startTime);
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf8', timeout: 2000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
      if (result.status !== 0 || !result.stdout) return null;
      const time = new Date(result.stdout.trim()).getTime();
      return Number.isNaN(time) ? null : String(time);
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    try {
      const cmd = `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().Ticks }`;
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { encoding: 'utf8', timeout: 3000, windowsHide: true });
      if (result.status !== 0 || !result.stdout) return null;
      const ticks = result.stdout.trim().match(/^\d+$/)?.[0];
      return ticks ? `ticks:${ticks}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function dmtfCreationDateToTicks(dmtf: string): string | null {
  // DMTF: yyyyMMddHHmmss.ffffff+UUU (offset minutes; six fractional digits = microseconds)
  const m = dmtf.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/);
  if (!m) return null;
  const [, ys, mo, ds, hs, mins, ss, us, sign, off] = m;
  const year = Number(ys), month = Number(mo), day = Number(ds);
  const hour = Number(hs), minute = Number(mins), second = Number(ss);
  const micros = Number(us);
  const offsetMin = Number(off) * (sign === '-' ? -1 : 1);
  if (![year, month, day, hour, minute, second, micros, offsetMin].every(Number.isFinite)) return null;
  // Strict ranges — do not let JS Date normalize invalid calendar fields.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  if (offsetMin < -840 || offsetMin > 840) return null; // valid civil TZ offsets only
  // Whole-second UTC ms (no ms truncation of the fractional field).
  const wholeUtcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60_000;
  if (!Number.isFinite(wholeUtcMs)) return null;
  // Reject JS calendar normalization (e.g. Feb 30 → Mar 1/2).
  // Reconstruct the wall-clock components we intended in the offset zone:
  const localMs = wholeUtcMs + offsetMin * 60_000;
  const local = new Date(localMs);
  if (
    local.getUTCFullYear() !== year
    || local.getUTCMonth() + 1 !== month
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second
  ) return null;
  // .NET ticks: 100ns since 0001-01-01. 1 us = 10 ticks. Preserve all 6 fractional digits.
  const ticks = BigInt(wholeUtcMs) * 10000n + BigInt(micros) * 10n + 621355968000000000n;
  return `ticks:${ticks.toString()}`;
}
