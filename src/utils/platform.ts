/**
 * platform.ts — Cross-platform utilities
 *
 * Centralizes platform detection and platform-aware command resolution.
 * Use these helpers instead of hardcoding OS-specific paths or command names.
 */

import { platform } from 'os';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';

export const IS_WINDOWS = platform() === 'win32';
export const IS_MACOS = platform() === 'darwin';
export const IS_LINUX = platform() === 'linux';

type ShellPlatform = NodeJS.Platform;
type KillFn = typeof process.kill;
type SpawnSyncFn = typeof spawnSync;

interface PlatformProbeOptions {
  platform?: ShellPlatform;
  env?: NodeJS.ProcessEnv;
  kill?: KillFn;
  spawnSync?: SpawnSyncFn;
}

interface ProcessSignalOptions extends PlatformProbeOptions {
  /**
   * When true, Unix sends to the process group (-pid) first and falls back to
   * the single pid. Windows maps this to taskkill /T.
   */
  tree?: boolean;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissingProcessError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ESRCH';
}

function isPermissionError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EPERM' || code === 'EACCES';
}

function assertValidPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid: ${pid}`);
  }
}

export function resolveShell(options?: { platform?: ShellPlatform; env?: NodeJS.ProcessEnv }): { executable: string; args: string[] } {
  const currentPlatform = options?.platform ?? platform();
  const env = options?.env ?? process.env;

  if (currentPlatform === 'win32') {
    const shellPref = (env.LINGXIAO_SHELL || '').toLowerCase().trim();
    if (shellPref === 'pwsh') {
      return { executable: 'pwsh.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] };
    }
    if (shellPref === 'powershell') {
      return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] };
    }
    return { executable: 'cmd.exe', args: ['/d', '/s', '/c'] };
  }

  const shell = env.SHELL || '/bin/sh';
  const base = shell === '/bin/sh' ? ['-c'] : ['-lc'];
  return { executable: shell, args: base };
}

export function hiddenSpawnOptsForPlatform(targetPlatform: ShellPlatform): { windowsHide?: boolean } {
  return targetPlatform === 'win32' ? { windowsHide: true } : {};
}

/**
 * Returns the appropriate shell executable and base args for the current platform.
 *
 * Windows shell selection (via LINGXIAO_SHELL env var):
 *   - LINGXIAO_SHELL=pwsh        → pwsh.exe (PowerShell 7+, cross-platform)
 *   - LINGXIAO_SHELL=powershell  → powershell.exe (Windows PowerShell 5.x)
 *   - default                    → cmd.exe /d /s /c
 *
 * Unix shell selection:
 *   - $SHELL env var if set, else /bin/sh (POSIX guaranteed everywhere)
 *
 * We use /bin/sh not /bin/bash on Unix because:
 *   - /bin/sh is guaranteed by POSIX on every Unix/Linux/macOS/WSL
 *   - /bin/bash may not exist on Alpine, Debian minimal, etc.
 *   - If the user's $SHELL is set, we respect their preference
 */
export function getShell(): { executable: string; args: string[] } {
  return resolveShell();
}

export function getShellCommand(command: string): { executable: string; args: string[] } {
  const shell = getShell();
  return { executable: shell.executable, args: [...shell.args, command] };
}

export function supportsProcessSuspendResume(): boolean {
  return !IS_WINDOWS;
}

/**
 * Returns the shell executable only (for pty/spawn use cases).
 */
export function getShellExecutable(): string {
  return getShell().executable;
}

/**
 * Returns the Python executable for the current platform.
 *
 * Resolution order:
 *   1. LINGXIAO_PYTHON env var (user override)
 *   2. `python3` if it exists on PATH
 *   3. `python` as fallback (Windows default, also works on Unix)
 */
export function getPythonExecutable(): string {
  if (process.env.LINGXIAO_PYTHON) return process.env.LINGXIAO_PYTHON;

  // Check python3 first (standard on Linux/macOS)
  const p3 = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 3000 });
  if (p3.status === 0) return 'python3';

  // Fallback: python (Windows default, also available on some Unix)
  return 'python';
}

/**
 * Checks whether a command exists on PATH.
 * Uses `where` on Windows, `command -v` via sh on Unix.
 */
export function commandExists(cmd: string, options?: PlatformProbeOptions): boolean {
  return resolveCommandPath(cmd, options) !== undefined;
}

export function resolveCommandPath(cmd: string, options?: PlatformProbeOptions): string | undefined {
  if (!/^[A-Za-z0-9._+/@:-]+$/.test(cmd)) return undefined;
  const currentPlatform = options?.platform ?? platform();
  const spawn = options?.spawnSync ?? spawnSync;
  if (currentPlatform === 'win32') {
    const r = spawn('where.exe', [cmd], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: options?.env,
    });
    if (r.status !== 0) return undefined;
    return (r.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  }
  const r = spawn('sh', ['-c', 'command -v "$1"', 'sh', cmd], {
    encoding: 'utf8',
    timeout: 5000,
    env: options?.env,
  });
  if (r.status !== 0) return undefined;
  return (r.stdout || '').trim() || undefined;
}

/**
 * Returns interactive shell args for the current platform.
 *
 * - cmd.exe → ['/d', '/s', '/c'] (no special interactive flag needed)
 * - pwsh.exe / powershell.exe → ['-NoLogo', '-NoExit']
 * - Unix shells (/bin/sh, /bin/bash, etc.) → ['--interactive']
 */
export function getInteractiveShellArgs(): string[] {
  return resolveInteractiveShell().args;
}

export function resolveInteractiveShell(options?: { platform?: ShellPlatform; env?: NodeJS.ProcessEnv }): { executable: string; args: string[] } {
  const shell = resolveShell(options);
  const { executable } = shell;
  const lower = executable.toLowerCase();
  if (lower.includes('cmd.exe')) {
    return { executable, args: ['/d'] };
  }
  if (lower.includes('pwsh') || lower.includes('powershell')) {
    return { executable, args: ['-NoLogo', '-NoExit'] };
  }
  return { executable, args: ['-i'] };
}

export function processExists(pid: number, options?: PlatformProbeOptions): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const currentPlatform = options?.platform ?? platform();
  const kill = options?.kill ?? process.kill;

  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (isPermissionError(error)) return true;
    if (isMissingProcessError(error)) return false;
    if (currentPlatform !== 'win32') return false;
  }

  // Windows fallback for environments where process.kill(pid, 0) is less
  // informative. tasklist is available on supported Windows hosts.
  const spawn = options?.spawnSync ?? spawnSync;
  const r = spawn('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: options?.env,
  });
  if (r.status !== 0) return false;
  return new RegExp(`,"${pid}",|,${pid},|^"[^"]+","${pid}",`).test(r.stdout || '');
}

export function sendProcessSignal(pid: number, signal: NodeJS.Signals | 0 = 'SIGTERM', options?: ProcessSignalOptions): boolean {
  assertValidPid(pid);
  if (signal === 0) {
    return processExists(pid, options);
  }
  const currentPlatform = options?.platform ?? platform();
  const kill = options?.kill ?? process.kill;

  if (currentPlatform === 'win32') {
    const signalName = String(signal);
    if (signalName === 'SIGTERM' || signalName === 'SIGKILL') {
      const args = ['/PID', String(pid)];
      if (options?.tree !== false) args.push('/T');
      if (signalName === 'SIGKILL') args.push('/F');
      const spawn = options?.spawnSync ?? spawnSync;
      const result = spawn('taskkill.exe', args, {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        env: options?.env,
      });
      if (result.status === 0) return true;
      try {
        kill(pid, signalName === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL');
        return true;
      } catch (error) {
        return isMissingProcessError(error);
      }
    }
  }

  const targets = options?.tree ? [-pid, pid] : [pid];
  let sawPermission = false;
  for (const target of targets) {
    try {
      kill(target, signal);
      return true;
    } catch (error) {
      if (isPermissionError(error)) sawPermission = true;
      if (!isMissingProcessError(error) && !isPermissionError(error)) throw error;
    }
  }
  return sawPermission;
}

/**
 * Cross-platform process termination.
 *
 * Windows: process.kill(pid, 'SIGKILL') maps to TerminateProcess in Node.js 22+.
 *          ESRCH errors (process already gone) are silently ignored.
 * Unix:    signal='SIGKILL' sends immediately.
 *          signal='SIGTERM' sends without waiting.
 *          Default (no signal): SIGTERM first, wait 3s grace, then SIGKILL.
 */
export function killProcess(pid: number, signal?: NodeJS.Signals, options?: { tree?: boolean; graceMs?: number }): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      assertValidPid(pid);
    } catch {/* swallowed: unhandled error */
      resolve();
      return;
    }

    if (signal) {
      sendProcessSignal(pid, signal, { tree: options?.tree });
      resolve();
      return;
    }

    sendProcessSignal(pid, 'SIGTERM', { tree: options?.tree });

    setTimeout(() => {
      try {
        sendProcessSignal(pid, 'SIGKILL', { tree: options?.tree });
      } catch { /* process may already be gone */ }
      resolve();
    }, options?.graceMs ?? 3000);
  });
}

/**
 * Reads the absolute start time of a live process as epoch milliseconds, or
 * `null` when it cannot be determined (process dead, platform lacks a probe,
 * parse failure). Callers compare this against a previously-recorded start time
 * to detect PID reuse: if the same PID now reports a different start time, a
 * different process has taken the PID over.
 *
 *   Linux:   `/proc/<pid>/stat` field 22 (starttime, jiffies since boot) + btime.
 *   macOS:   `ps -o lstart= -p <pid>` → parsed absolute timestamp.
 *   Windows: PowerShell `(Get-Process -Id <pid>).StartTime` → epoch seconds.
 *
 * Spawning `ps`/`powershell` is acceptable here: the only callers are
 * pid-registry pruning and orphan reaping, which fire a handful of times per
 * process lifetime — never on a hot path.
 */
export function readProcessStartMs(pid: number, options?: PlatformProbeOptions): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const currentPlatform = options?.platform ?? platform();
  const run = options?.spawnSync ?? spawnSync;
  if (currentPlatform === 'linux') return readLinuxProcStartMs(pid);
  if (currentPlatform === 'darwin') return readMacProcStartMs(pid, run);
  if (currentPlatform === 'win32') return readWindowsProcStartMs(pid, run, options?.env);
  return null;
}

// Linux boot time (seconds) read once from /proc/stat; constant for a boot.
let _linuxBtimeSec: number | null | undefined = undefined; // undefined = unread, null = read failed
function readLinuxBootTimeSec(): number | null {
  if (_linuxBtimeSec !== undefined) return _linuxBtimeSec;
  try {
    const stat = readFileSync('/proc/stat', 'utf-8');
    const m = stat.match(/^btime\s+(\d+)/m);
    _linuxBtimeSec = m ? Number(m[1]) : null;
  } catch {
    _linuxBtimeSec = null;
  }
  return _linuxBtimeSec;
}

// Linux CLK_TCK (jiffies/sec). Node has no sysconf binding; virtually every
// production kernel is 100 Hz, and the 5s comparison tolerance absorbs drift.
const LINUX_CLK_TCK = 100;

function readLinuxProcStartMs(pid: number): number | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // `comm` may contain spaces and parens — slice after the LAST ')' so field
    // counting is stable. starttime is field 22 → tail index 19.
    const rparen = raw.lastIndexOf(')');
    if (rparen < 0) return null;
    const tail = raw.slice(rparen + 2).split(' ');
    const starttimeJiffies = Number(tail[19]);
    if (!Number.isFinite(starttimeJiffies)) return null;
    const btimeSec = readLinuxBootTimeSec();
    if (btimeSec === null) return null;
    return (btimeSec + starttimeJiffies / LINUX_CLK_TCK) * 1000;
  } catch {
    return null;
  }
}

function readMacProcStartMs(pid: number, run: SpawnSyncFn): number | null {
  try {
    const r = run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const out = (r.stdout || '').trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function readWindowsProcStartMs(pid: number, run: SpawnSyncFn, env?: NodeJS.ProcessEnv): number | null {
  try {
    // Get-Date -UFormat %s emits unix epoch seconds (UTC) for the piped StartTime.
    // powershell.exe ships on every supported Windows; wmic was removed in Win11.
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime | Get-Date -UFormat %s`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, env });
    const out = (r.stdout || '').trim();
    if (!out) return null;
    const ms = Math.round(Number(out) * 1000);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Reset the internal boot-time cache. Tests only. */
export function _resetProcessStartTimeCacheForTest(): void {
  _linuxBtimeSec = undefined;
}

/**
 * Returns spawn options with windowsHide to prevent console window flash.
 * Merge with your existing spawn options.
 */
export function hiddenSpawnOpts(): { windowsHide?: boolean } {
  return hiddenSpawnOptsForPlatform(platform());
}
