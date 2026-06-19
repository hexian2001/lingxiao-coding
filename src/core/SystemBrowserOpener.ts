import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { commandExists, hiddenSpawnOptsForPlatform } from '../utils/platform.js';

export type SystemBrowserOpenStrategy =
  | 'windows-start'
  | 'macos-open'
  | 'linux-xdg-open'
  | 'wsl-wslview'
  | 'wsl-cmd-exe';

export interface SystemBrowserOpenPlan {
  available: boolean;
  platform: NodeJS.Platform;
  isWsl: boolean;
  strategy?: SystemBrowserOpenStrategy;
  command?: string;
  args: string[];
  diagnostics: string[];
}

export interface SystemBrowserOpenResult {
  launched: boolean;
  plan: SystemBrowserOpenPlan;
}

interface SystemBrowserOpenDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  commandExists?: (command: string) => boolean;
}

function detectWsl(deps: Required<Pick<SystemBrowserOpenDeps, 'env' | 'exists' | 'readFile'>>): boolean {
  if (deps.env.WSL_DISTRO_NAME || deps.env.WSL_INTEROP) return true;
  try {
    return deps.exists('/proc/version') && deps.readFile('/proc/version').toLowerCase().includes('microsoft');
  } catch {/* expected: operation may fail */
    return false;
  }
}

function windowsPathToWslPath(input: string): string | undefined {
  const match = /^([A-Za-z]):\\(.+)$/.exec(input);
  if (!match) return undefined;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

function findWslCmdExe(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, hasCommand: (command: string) => boolean): string | undefined {
  const windir = env.WINDIR || env.windir;
  if (windir) {
    const unixWindowsDir = windowsPathToWslPath(windir);
    const candidate = unixWindowsDir ? `${unixWindowsDir}/System32/cmd.exe` : undefined;
    if (candidate && exists(candidate)) return candidate;
  }

  for (const drive of ['c', 'd', 'e']) {
    const candidate = `/mnt/${drive}/Windows/System32/cmd.exe`;
    if (exists(candidate)) return candidate;
  }

  return hasCommand('cmd.exe') ? 'cmd.exe' : undefined;
}

export function planSystemBrowserOpen(url: string, deps: SystemBrowserOpenDeps = {}): SystemBrowserOpenPlan {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const hasCommand = deps.commandExists ?? commandExists;
  const diagnostics: string[] = [];
  const isWsl = platform === 'linux' && detectWsl({ env, exists, readFile });

  if (!url.trim()) {
    return { available: false, platform, isWsl, args: [], diagnostics: ['URL is empty.'] };
  }

  if (platform === 'win32') {
    const command = hasCommand('cmd.exe') ? 'cmd.exe' : hasCommand('cmd') ? 'cmd' : undefined;
    if (!command) {
      return { available: false, platform, isWsl, args: [], diagnostics: ['cmd.exe was not found on PATH.'] };
    }
    return {
      available: true,
      platform,
      isWsl,
      strategy: 'windows-start',
      command,
      args: ['/d', '/s', '/c', 'start', '', url],
      diagnostics,
    };
  }

  if (platform === 'darwin') {
    if (!hasCommand('open') && !exists('/usr/bin/open')) {
      return { available: false, platform, isWsl, args: [], diagnostics: ['macOS open command was not found.'] };
    }
    return {
      available: true,
      platform,
      isWsl,
      strategy: 'macos-open',
      command: 'open',
      args: [url],
      diagnostics,
    };
  }

  if (isWsl) {
    const wslview = ['/usr/bin/wslview', '/usr/local/bin/wslview'].find((path) => exists(path));
    if (wslview) {
      return {
        available: true,
        platform,
        isWsl,
        strategy: 'wsl-wslview',
        command: wslview,
        args: [url],
        diagnostics,
      };
    }

    const cmdExe = findWslCmdExe(env, exists, hasCommand);
    if (cmdExe) {
      return {
        available: true,
        platform,
        isWsl,
        strategy: 'wsl-cmd-exe',
        command: cmdExe,
        args: ['/c', 'start', '', url],
        diagnostics,
      };
    }

    return {
      available: false,
      platform,
      isWsl,
      args: [],
      diagnostics: ['WSL browser opener not found. Install wslu for wslview or ensure Windows cmd.exe is reachable.'],
    };
  }

  if (platform === 'linux') {
    if (!hasCommand('xdg-open') && !exists('/usr/bin/xdg-open') && !exists('/usr/local/bin/xdg-open')) {
      return {
        available: false,
        platform,
        isWsl,
        args: [],
        diagnostics: ['xdg-open was not found. Install xdg-utils or open the printed Web UI URL manually.'],
      };
    }
    return {
      available: true,
      platform,
      isWsl,
      strategy: 'linux-xdg-open',
      command: 'xdg-open',
      args: [url],
      diagnostics,
    };
  }

  return {
    available: false,
    platform,
    isWsl,
    args: [],
    diagnostics: [`No system browser opener is registered for platform ${platform}.`],
  };
}

export function openUrlInSystemBrowser(url: string): SystemBrowserOpenResult {
  const plan = planSystemBrowserOpen(url);
  if (!plan.available || !plan.command) return { launched: false, plan };

  try {
    const child = spawn(plan.command, plan.args, {
      detached: true,
      stdio: 'ignore',
      ...hiddenSpawnOptsForPlatform(plan.platform),
    });
    child.on('error', () => { /* Optional convenience open; the printed URL remains the source of truth. */ });
    child.unref();
    return { launched: true, plan };
  } catch {/* expected: fallback to default */
    return { launched: false, plan };
  }
}
