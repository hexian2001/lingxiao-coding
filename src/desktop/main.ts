/**
 * Electron 主进程入口 — 桌面端自动更新与 IPC
 *
 * 仅在 Electron 环境下运行；通过动态 import electron-updater 避免在非桌面构建中引入硬依赖。
 * 暴露 IPC 通道：update:status / update:relaunch / update:checkAndDownload
 * 事件通道：update:downloaded / update:downloadProgress / update:error
 */

// 动态加载 electron 和 electron-updater（非桌面环境不会执行此文件）
import type { app as AppType, BrowserWindow, ipcMain } from 'electron';

interface AutoUpdaterModule {
  autoUpdater: {
    checkForUpdatesAndNotify: () => Promise<unknown>;
    checkForUpdates: () => Promise<{ downloadPromise?: Promise<unknown> } | null>;
    downloadUpdate: () => Promise<unknown>;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    quitAndInstall: () => void;
  };
}

let updateDownloaded = false;
let updateVersion: string | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * 启动桌面端更新检查与 IPC 通道注册。
 * 在 Electron app ready 之后调用。
 */
export async function startDesktopUpdater(
  electron: typeof import('electron'),
  updaterModule: AutoUpdaterModule,
): Promise<void> {
  const { app, ipcMain: ipc, BrowserWindow: Win } = electron;
  const { autoUpdater } = updaterModule;

  // --- IPC: 查询更新状态 ---
  ipc.handle('update:status', () => ({
    updateDownloaded,
    updateVersion,
  }));

  // --- IPC: 重启应用 ---
  ipc.handle('update:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // --- IPC: 检查并下载更新 ---
  ipc.handle('update:checkAndDownload', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result) {
        // checkForUpdates 返回 UpdateCheckResult，如果有更新会自动开始下载
        // 但在某些配置下需要手动调用 downloadUpdate
        await autoUpdater.downloadUpdate();
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:error', { message });
      }
      return { success: false, error: message };
    }
  });

  // --- electron-updater 事件: 下载进度 ---
  autoUpdater.on('download-progress', (progress: unknown) => {
    const p = progress as { percent?: number; transferred?: number; total?: number };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:downloadProgress', {
        percent: p?.percent ?? 0,
        transferred: p?.transferred ?? 0,
        total: p?.total ?? 0,
      });
    }
  });

  // --- electron-updater 事件: 错误 ---
  autoUpdater.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:error', { message });
    }
  });

  // --- electron-updater 事件: 下载完成 ---
  autoUpdater.on('update-downloaded', (info: unknown) => {
    const releaseInfo = info as { version?: string };
    updateDownloaded = true;
    updateVersion = releaseInfo?.version ?? null;

    // 通知所有渲染进程
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:downloaded', { updateVersion });
    }
  });

  // 自动检查更新
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch {
    // 静默失败 — 开发环境或无网络时不影响使用
  }

  // 定期检查（每4小时）
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

/**
 * 设置主窗口引用，用于向渲染进程发送 IPC 消息。
 */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/**
 * 创建桌面端应用窗口。
 * 此函数仅在 Electron 环境中被调用。
 */
export async function createDesktopWindow(
  port: number,
): Promise<void> {
  // 动态导入 electron
  const electron = await import('electron');
  const { app, BrowserWindow } = electron;

  await app.whenReady();

  // 性能优化 (T-8)：GPU 进程崩溃处理 — exe 打包后在部分 Windows 机器上 GPU
  // 进程可能崩溃导致软件渲染卡顿。监听 child-process-gone 事件记录 GPU 崩溃。
  app.on('child-process-gone', (_event: unknown, details: { reason?: string; type?: string; exitCode?: number }) => {
    if (details?.type === 'GPU') {
      console.error('[desktop] GPU child process gone:', details.reason, 'exitCode:', details.exitCode);
    }
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: `${__dirname}/preload.js`,
      contextIsolation: true,
      nodeIntegration: false,
      // 性能优化 (T-8)：禁用后台节流，避免窗口失焦时定时器/动画被限流导致卡顿。
      backgroundThrottling: false,
    },
  });

  setMainWindow(win);

  // 尝试加载本地 web 服务器
  await win.loadURL(`http://localhost:${port}`);

  // 动态加载 electron-updater（可选依赖）
  try {
    const updaterModule = await import('electron-updater') as unknown as AutoUpdaterModule;
    await startDesktopUpdater(electron, updaterModule);
  } catch {
    // electron-updater 不可用 — 跳过自动更新
  }
}

// 当通过 electron 命令直接运行时启动桌面端
if (typeof process !== 'undefined' && (process.versions as Record<string, string | undefined>).electron) {
  const port = parseInt(process.env.LINGXIAO_PORT || '8080', 10);
  createDesktopWindow(port).catch((err) => {
    console.error('[desktop] Failed to start:', err);
    process.exit(1);
  });
}
