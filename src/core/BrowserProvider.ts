import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { IS_WINDOWS, IS_MACOS, IS_LINUX, resolveCommandPath } from '../utils/platform.js';
import { getScopedProxyFetch, resolveToolBrowserProxy, withToolProxyEnv } from './ProxyConfig.js';

export interface BrowserProxyConfig {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

export interface BrowserHealth {
  platform: NodeJS.Platform;
  playwrightVersion?: string;
  expectedExecutablePath?: string;
  resolvedExecutablePath?: string;
  resolvedExecutableSource?: BrowserExecutableSource;
  playwrightCliExists: boolean;
  executableExists: boolean;
  canLaunch?: boolean;
  installCommand: string;
  installDepsCommand?: string;
  detectedCandidates: BrowserExecutableCandidate[];
  diagnostics: string[];
}

export interface BrowserLaunchResult {
  browser: Browser;
  proxy?: BrowserProxyConfig;
  executablePath?: string;
  executableSource?: BrowserExecutableSource;
}

export type BrowserExecutableSource =
  | 'settings.paths.chrome_path'
  | `env.${string}`
  | 'playwright'
  | 'system.path'
  | 'system.command';

export interface BrowserExecutableCandidate {
  source: BrowserExecutableSource;
  path: string;
  exists: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '../..');
const PLAYWRIGHT_CLI = join(PACKAGE_ROOT, 'node_modules', 'playwright', 'cli.js');

/**
 * Chromium 启动参数。
 * 保留项均为稳定性必需(root/容器无 sandbox 环境必须 --no-sandbox 系)或无害。
 * 已删除的是「真人浏览器不会有」的强爬虫信号:--disable-web-security(绝不开启)、
 * --disable-features=IsolateOrigins,site-per-process(关站点隔离)、--disable-background-networking
 * (关后台网络)、--metrics-recording-only(关 UMA 上报)、--disable-software-rasterizer
 * (与 --disable-gpu 的软件渲染路径自相矛盾)。真正的自动化指纹(navigator.webdriver 等)
 * 由 BrowserStealth.addInitScript 在页面层擦除,不依赖启动 flag。
 */
const DEFAULT_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--mute-audio',
  '--no-first-run',
];

let cachedChromePath: string | undefined | null = null;
let cachedChromeSource: BrowserExecutableSource | undefined;
let installPromise: Promise<void> | null = null;

export function isBrowserSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LINGXIAO_SKIP_BROWSER === '1' || env.LINGXIAO_SKIP_BROWSER?.toLowerCase() === 'true';
}

export function buildPlaywrightInstallCommands(options?: {
  nodeExecPath?: string;
  playwrightCli?: string;
  platform?: NodeJS.Platform;
}): { installCommand: string; installDepsCommand?: string } {
  const nodeExecPath = options?.nodeExecPath ?? process.execPath;
  const playwrightCli = options?.playwrightCli ?? PLAYWRIGHT_CLI;
  const targetPlatform = options?.platform ?? process.platform;
  const nodeCommand = shellQuote(nodeExecPath);
  const playwrightCommand = shellQuote(playwrightCli);
  return {
    installCommand: `${nodeCommand} ${playwrightCommand} install chromium`,
    installDepsCommand: targetPlatform === 'linux' ? `${nodeCommand} ${playwrightCommand} install-deps chromium` : undefined,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function createBrowserMissingDiagnostics(executableExists: boolean, playwrightCliExists = true): string[] {
  const diagnostics: string[] = [];
  if (!executableExists) diagnostics.push('No Chromium-family browser executable was detected.');
  if (!playwrightCliExists) diagnostics.push(`Local Playwright CLI is missing: ${PLAYWRIGHT_CLI}`);
  return diagnostics;
}

export function createBrowserSkippedError(): Error {
  return new Error('Browser tools are disabled because LINGXIAO_SKIP_BROWSER=1. Unset it to enable browser automation.');
}

export function readBrowserDaemonFlag(): boolean {
  const env = (process.env.LINGXIAO_BROWSER_DAEMON || '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') return true;
  const cfg = (config as unknown as { browser?: { daemon?: boolean } }).browser?.daemon;
  return !!cfg;
}

export function readBrowserIdleMs(defaultMs: number): number {
  const env = process.env.LINGXIAO_BROWSER_IDLE_MS;
  if (env && /^\d+$/.test(env)) return Math.max(10_000, parseInt(env, 10));
  const cfg = (config as unknown as { browser?: { idle_ms?: number } }).browser?.idle_ms;
  if (typeof cfg === 'number' && cfg > 0) return Math.max(10_000, cfg);
  return defaultMs;
}

function readEnvProxy(): BrowserProxyConfig | undefined {
  const raw = process.env.LINGXIAO_BROWSER_PROXY
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const cfg: BrowserProxyConfig = { server: `${url.protocol}//${url.host}` };
    if (url.username) cfg.username = decodeURIComponent(url.username);
    if (url.password) cfg.password = decodeURIComponent(url.password);
    if (process.env.NO_PROXY || process.env.no_proxy) {
      cfg.bypass = process.env.NO_PROXY || process.env.no_proxy;
    }
    return cfg;
  } catch {/* expected: fallback to default */
    return { server: raw };
  }
}

function readConfigProxy(): BrowserProxyConfig | undefined {
  const cfg = (config as unknown as { browser?: { proxy?: BrowserProxyConfig } }).browser?.proxy;
  if (!cfg || !cfg.server) return undefined;
  return cfg;
}

export function resolveBrowserProxy(): BrowserProxyConfig | undefined {
  return resolveToolBrowserProxy() ?? readConfigProxy() ?? readEnvProxy();
}

export function browserProxyChanged(prev: BrowserProxyConfig | undefined, next: BrowserProxyConfig | undefined): boolean {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  return prev.server !== next.server
    || (prev.username || '') !== (next.username || '')
    || (prev.password || '') !== (next.password || '')
    || (prev.bypass || '') !== (next.bypass || '');
}

function expectedChromeExecutable(): string | undefined {
  try {
    return chromium.executablePath();
  } catch {/* expected: resource not available */
    return undefined;
  }
}

function normalizeConfiguredPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed || undefined;
}

function whichOnPath(cmd: string): string | undefined {
  try {
    const first = resolveCommandPath(cmd);
    if (first && existsSync(first)) return first;
  } catch {
    // ignore
  }
  return undefined;
}

function systemChromiumCandidates(): string[] {
  if (IS_WINDOWS) {
    const env = process.env;
    const paths: string[] = [];
    const programDirs = [
      env.LOCALAPPDATA,
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
    ].filter((p): p is string => Boolean(p));
    for (const base of programDirs) {
      paths.push(
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(base, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
    return paths;
  }
  if (IS_MACOS) {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (IS_LINUX) {
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/brave-browser',
      '/snap/bin/chromium',
      '/snap/bin/google-chrome',
    ];
  }
  return [];
}

function systemChromiumCommandCandidates(): string[] {
  if (IS_WINDOWS) {
    return ['chrome.exe', 'msedge.exe', 'brave.exe'];
  }
  return [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
    'brave-browser',
  ];
}

function detectChromeExecutable(): BrowserExecutableCandidate | undefined {
  if (cachedChromePath !== null) {
    return cachedChromePath && cachedChromeSource
      ? { source: cachedChromeSource, path: cachedChromePath, exists: true }
      : undefined;
  }

  const userPath = normalizeConfiguredPath(config.paths?.chrome_path);
  if (userPath && existsSync(userPath)) {
    cachedChromePath = userPath;
    cachedChromeSource = 'settings.paths.chrome_path';
    return { source: cachedChromeSource, path: userPath, exists: true };
  }

  for (const envKey of ['LINGXIAO_CHROME_PATH', 'CHROME_PATH', 'CHROME_BIN', 'PUPPETEER_EXECUTABLE_PATH'] as const) {
    const val = normalizeConfiguredPath(process.env[envKey]);
    if (val && existsSync(val)) {
      cachedChromePath = val;
      cachedChromeSource = `env.${envKey}`;
      return { source: cachedChromeSource, path: val, exists: true };
    }
  }

  const playwrightPath = expectedChromeExecutable();
  if (playwrightPath && existsSync(playwrightPath)) {
    cachedChromePath = playwrightPath;
    cachedChromeSource = 'playwright';
    return { source: cachedChromeSource, path: playwrightPath, exists: true };
  }

  for (const candidate of systemChromiumCandidates()) {
    if (existsSync(candidate)) {
      cachedChromePath = candidate;
      cachedChromeSource = 'system.path';
      return { source: cachedChromeSource, path: candidate, exists: true };
    }
  }

  for (const cmd of systemChromiumCommandCandidates()) {
    const found = whichOnPath(cmd);
    if (found) {
      cachedChromePath = found;
      cachedChromeSource = 'system.command';
      return { source: cachedChromeSource, path: found, exists: true };
    }
  }

  cachedChromePath = undefined;
  cachedChromeSource = undefined;
  return undefined;
}

function findChromeExecutable(): string | undefined {
  return detectChromeExecutable()?.path;
}

function listBrowserExecutableCandidates(): BrowserExecutableCandidate[] {
  const candidates: BrowserExecutableCandidate[] = [];
  const add = (source: BrowserExecutableSource, path: string | undefined) => {
    const normalized = normalizeConfiguredPath(path);
    if (!normalized) return;
    candidates.push({ source, path: normalized, exists: existsSync(normalized) });
  };

  add('settings.paths.chrome_path', config.paths?.chrome_path);
  for (const envKey of ['LINGXIAO_CHROME_PATH', 'CHROME_PATH', 'CHROME_BIN', 'PUPPETEER_EXECUTABLE_PATH'] as const) {
    add(`env.${envKey}`, process.env[envKey]);
  }
  add('playwright', expectedChromeExecutable());
  for (const path of systemChromiumCandidates()) add('system.path', path);
  for (const cmd of systemChromiumCommandCandidates()) add('system.command', whichOnPath(cmd));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function _resetChromePathCacheForTesting(): void {
  cachedChromePath = null;
  cachedChromeSource = undefined;
}

async function probeReachable(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const scopedFetch = getScopedProxyFetch('tools') || fetch;
      const res = await scopedFetch(url, { method: 'HEAD', signal: ctrl.signal });
      return res.status >= 200 && res.status < 600;
    } finally {
      clearTimeout(timer);
    }
  } catch {/* expected: operation may fail */
    return false;
  }
}

async function resolveDownloadMirrors(): Promise<Array<{ label: string; host: string; maxAttempts: number }>> {
  const userHost = process.env.PLAYWRIGHT_DOWNLOAD_HOST;
  if (userHost) {
    return [{ label: 'user configured', host: userHost, maxAttempts: 3 }];
  }

  const regionPref = (process.env.LINGXIAO_BROWSER_REGION || '').toLowerCase().trim();
  const officialMirror = { label: 'Playwright CDN', host: 'https://cdn.playwright.dev', maxAttempts: 2 };
  const cnMirror = { label: 'npmmirror China mirror', host: 'https://npmmirror.com/mirrors/playwright', maxAttempts: 3 };

  if (regionPref === 'cn' || regionPref === 'china') {
    return [cnMirror, officialMirror];
  }
  if (regionPref === 'global' || regionPref === 'official') {
    return [officialMirror, cnMirror];
  }

  const officialReachable = await probeReachable('https://cdn.playwright.dev', 1500);
  return officialReachable ? [officialMirror, cnMirror] : [cnMirror, officialMirror];
}

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|TLS|network|fetch failed|429|503/i.test(msg);
}

async function buildDownloadFailureError(rawErr: unknown, isNetwork: boolean): Promise<Error> {
  const cause = rawErr instanceof Error ? rawErr.message : String(rawErr);
  const commands = buildPlaywrightInstallCommands();
  const depsHint = commands.installDepsCommand
    ? `\n  - If Linux system dependencies are missing: ${commands.installDepsCommand}`
    : '';

  const guidance: string[] = [];
  guidance.push(`Chromium browser setup failed: ${cause}`);
  if (isNetwork) {
    guidance.push('Reason: Playwright browser download source is unreachable after trying the official CDN and npmmirror.');
  }
  guidance.push('');
  guidance.push('Recovery options:');
  guidance.push('  1. Install Chrome / Chromium / Edge / Brave with the OS package manager; Lingxiao will detect it automatically.');
  guidance.push('     - Linux: apt install chromium-browser, apt install chromium, or snap install chromium');
  guidance.push('     - macOS: brew install --cask google-chrome');
  guidance.push('     - Windows: install Google Chrome or Microsoft Edge');
  guidance.push('  2. Set an explicit executable path: LINGXIAO_CHROME_PATH=/path/to/chrome or settings paths.chrome_path.');
  guidance.push('  3. Retry with a region hint: LINGXIAO_BROWSER_REGION=cn or PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright');
  guidance.push(`  4. Install Playwright Chromium manually: ${commands.installCommand}${depsHint}`);
  guidance.push('  5. Disable browser runtime temporarily: LINGXIAO_SKIP_BROWSER=1');
  return new Error(guidance.join('\n'));
}

async function downloadBrowser(): Promise<void> {
  const enumeratedSystem = systemChromiumCandidates().filter((p) => existsSync(p));
  const sysPathHits = systemChromiumCommandCandidates().map(whichOnPath).filter(Boolean) as string[];
  const allSystem = [...new Set([...enumeratedSystem, ...sysPathHits])];

  if (allSystem.length > 0) {
    console.error(`[Browser] Detected installed Chromium-family browser, skipping download: ${allSystem.join(', ')}`);
    _resetChromePathCacheForTesting();
    return;
  }

  console.error('[Browser] Chromium browser not found. Downloading with local Playwright runtime...');

  if (!existsSync(PLAYWRIGHT_CLI)) {
    throw await buildDownloadFailureError(new Error(`Local Playwright CLI not found: ${PLAYWRIGHT_CLI}`), false);
  }

  const mirrors = await resolveDownloadMirrors();
  let lastErr: unknown;

  for (const mirror of mirrors) {
    console.error(`[Browser] Using download source: ${mirror.label} (${mirror.host})`);
    const env: NodeJS.ProcessEnv = withToolProxyEnv({ ...process.env });
    if (mirror.host) env.PLAYWRIGHT_DOWNLOAD_HOST = mirror.host;
    else delete env.PLAYWRIGHT_DOWNLOAD_HOST;

    for (let attempt = 1; attempt <= mirror.maxAttempts; attempt++) {
      try {
        execFileSync(process.execPath, [PLAYWRIGHT_CLI, 'install', 'chromium'], {
          stdio: 'inherit',
          timeout: 300_000,
          env,
          windowsHide: IS_WINDOWS,
        });
        console.error('[Browser] Download complete.');
        _resetChromePathCacheForTesting();
        return;
      } catch (e) {
        lastErr = e;
        const network = isNetworkError(e);
        if (attempt < mirror.maxAttempts && network) {
          const wait = Math.min(2000 * 2 ** (attempt - 1), 10000);
          console.error(`[Browser] ${mirror.label} attempt ${attempt}/${mirror.maxAttempts} failed; retrying in ${wait}ms...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        break;
      }
    }
    console.error(`[Browser] ${mirror.label} failed; trying next source...`);
  }

  throw await buildDownloadFailureError(lastErr, true);
}

export async function ensureBrowserInstalled(): Promise<void> {
  if (isBrowserSkipped()) throw createBrowserSkippedError();
  if (findChromeExecutable()) return;
  if (installPromise) return installPromise;

  installPromise = downloadBrowser();
  try {
    await installPromise;
  } finally {
    installPromise = null;
  }
}

export async function checkBrowserHealth(options?: { launch?: boolean }): Promise<BrowserHealth> {
  const expectedExecutablePath = expectedChromeExecutable();
  const detected = detectChromeExecutable();
  const resolvedExecutablePath = detected?.path;
  const playwrightCliExists = existsSync(PLAYWRIGHT_CLI);
  const executableExists = Boolean(resolvedExecutablePath || (expectedExecutablePath && existsSync(expectedExecutablePath)));
  const diagnostics: string[] = createBrowserMissingDiagnostics(executableExists, playwrightCliExists);
  if (isBrowserSkipped()) diagnostics.push('Browser tools are disabled by LINGXIAO_SKIP_BROWSER.');

  let playwrightVersion: string | undefined;
  try {
    const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'node_modules', 'playwright', 'package.json'), 'utf8'));
    playwrightVersion = pkg.version;
  } catch {/* swallowed: unhandled error */
    diagnostics.push('Unable to read local Playwright package version.');
  }

  let canLaunch: boolean | undefined;
  if (options?.launch && !isBrowserSkipped()) {
    try {
      const browser = await launchManagedChromium({ log: false });
      await browser.browser.close();
      canLaunch = true;
    } catch (error) {
      canLaunch = false;
      diagnostics.push(`Launch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    platform: process.platform,
    playwrightVersion,
    expectedExecutablePath,
    resolvedExecutablePath,
    resolvedExecutableSource: detected?.source,
    playwrightCliExists,
    executableExists,
    canLaunch,
    ...buildPlaywrightInstallCommands(),
    detectedCandidates: listBrowserExecutableCandidates(),
    diagnostics,
  };
}

function buildBrowserLaunchOptions(options?: {
  proxy?: BrowserProxyConfig;
  extraArgs?: string[];
}): Parameters<typeof chromium.launch>[0] {
  const chromePath = detectChromeExecutable()?.path;
  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless: true,
    args: [...DEFAULT_BROWSER_ARGS, ...(options?.extraArgs || [])],
    ...(options?.proxy ? { proxy: options.proxy } : {}),
  };
  if (chromePath) launchOptions.executablePath = chromePath;
  return launchOptions;
}

export async function launchManagedChromium(options?: {
  proxy?: BrowserProxyConfig;
  extraArgs?: string[];
  log?: boolean;
}): Promise<BrowserLaunchResult> {
  await ensureBrowserInstalled();

  const proxy = options?.proxy ?? resolveBrowserProxy();
  const detected = detectChromeExecutable();
  const executablePath = detected?.path;
  const launchOptions = buildBrowserLaunchOptions({ proxy, extraArgs: options?.extraArgs });
  const log = options?.log !== false;

  if (log) {
    if (executablePath) console.error(`[Browser] Using Chromium executable: ${executablePath}`);
    else console.error('[Browser] No executablePath resolved; letting Playwright use its default browser resolution.');
    if (proxy) console.error(`[Browser] Proxy enabled: ${proxy.server}${proxy.username ? ' (with auth)' : ''}`);
  }

  try {
    const browser = await chromium.launch(launchOptions);
    return { browser, proxy, executablePath, executableSource: detected?.source };
  } catch (error) {
    const health = await checkBrowserHealth({ launch: false }).catch(() => undefined);
    const depsHint = process.platform === 'linux' && health?.installDepsCommand
      ? `\nIf Chromium is installed but cannot launch, install system dependencies: ${health.installDepsCommand}`
      : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${health ? `\nInstall command: ${health.installCommand}` : ''}${depsHint}`);
  }
}
