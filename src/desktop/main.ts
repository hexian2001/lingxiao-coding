import { app, BrowserWindow, Menu, shell } from 'electron';
import { autoUpdater, UpdateCheckResult } from 'electron-updater';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateDefaultSettings, config as runtimeConfig } from '../config.js';
import { createServer, findAvailablePort, removePortFile, warnIfInsecureHostBinding, writePortFile } from '../server.js';
import { registerCleanup, runAllCleanups } from '../core/index.js';
import { isHardenedMode } from '../core/HardeningPolicy.js';

let mainWindow: BrowserWindow | null = null;
let shutdownStarted = false;

// ── Auto-updater ──────────────────────────────────────────────────────────────
// electron-updater 在打包后的 MSI/NSIS 安装版中自动检查 GitHub Releases。
// 开发模式（非 packaged）下跳过，避免无谓报错。

let updateNotificationShown = false;

function setupAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] 正在检查更新...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] 发现新版本: ${info.version}，开始下载...`);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] 当前版本已是最新。');
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = progress.percent.toFixed(1);
    console.log(`[Updater] 下载中: ${percent}% (${progress.transferred}/${progress.total} bytes)`);
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('[Updater] 更新已下载，将在退出时自动安装。');
    // 通知主窗口展示更新提示（通过 webContents executeJavaScript 注入 toast）
    if (mainWindow && !updateNotificationShown) {
      updateNotificationShown = true;
      mainWindow.webContents.executeJavaScript(
        `if (window.showToast) { window.showToast('新版本已下载，重启后生效。', 'info', 8000); }`
      ).catch(() => {/* 窗口可能还没准备好 */});
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] 检查更新失败:', err?.message || err);
  });

  // 启动后 5 秒检查更新，之后每 4 小时检查一次
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {/* 静默失败 */});
  }, 5_000);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {/* 静默失败 */});
  }, 4 * 60 * 60 * 1000);
}

function resolveIconPath(): string | undefined {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, '..', 'web', 'public', 'logo.svg'),
    join(__dirname, '..', '..', 'web', 'public', 'logo.svg'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function configureDesktopResourcePaths(): void {
  const bundledSkillsDir = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'bundled')
    : join(process.cwd(), 'skills', 'bundled');

  if (!process.env.LINGXIAO_BUNDLED_SKILLS_DIR && existsSync(bundledSkillsDir)) {
    process.env.LINGXIAO_BUNDLED_SKILLS_DIR = bundledSkillsDir;
  }
}

async function startDesktopServer(): Promise<string> {
  configureDesktopResourcePaths();
  generateDefaultSettings();

  const { fastify: server, token } = await createServer();
  const webHost = runtimeConfig.server.host;
  const requestedPort = runtimeConfig.server.random_port ? 0 : runtimeConfig.server.port;

  warnIfInsecureHostBinding(webHost, isHardenedMode());

  let actualPort = requestedPort;
  try {
    await server.listen({ host: webHost, port: requestedPort });
    const address = server.server.address();
    actualPort = (address && typeof address === 'object' ? address.port : null) ?? requestedPort;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      actualPort = await findAvailablePort(runtimeConfig.server.port, webHost);
      await server.listen({ host: webHost, port: actualPort });
    } else {
      throw err;
    }
  }

  writePortFile(actualPort, webHost);
  registerCleanup(() => removePortFile(), 2);
  registerCleanup(() => server.close(), 3);

  const displayHost = webHost === '0.0.0.0' ? 'localhost' : webHost;
  const baseUrl = `http://${displayHost}:${actualPort}`;
  return token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
}

function createMainWindow(url: string): BrowserWindow {
  const icon = resolveIconPath();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: 'LingXiao',
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  void window.loadURL(url);
  return window;
}

async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  removePortFile();
  await runAllCleanups(10_000);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void shutdown().finally(() => app.quit());
  }
});

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  void shutdown().finally(() => app.quit());
});

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const url = await startDesktopServer();
  mainWindow = createMainWindow(url);
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(url);
    }
  });
}).catch((err: unknown) => {
  console.error('[Desktop] Failed to start:', err);
  app.quit();
});
