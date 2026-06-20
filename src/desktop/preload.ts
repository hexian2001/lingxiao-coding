/**
 * Electron Preload Script — 安全暴露 IPC 通道到渲染进程
 *
 * 通过 contextBridge 暴露 lingxiaoDesktop 对象，
 * 仅允许 renderer 调用白名单 IPC 方法，不暴露 ipcRenderer 本身。
 */

import { contextBridge, ipcRenderer } from 'electron';

/** 下载进度信息 */
interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
}

/** 更新错误信息 */
interface UpdateError {
  message: string;
}

/** 桌面端暴露给前端的 API 接口 */
export interface LingxiaoDesktopAPI {
  /** 查询 electron-updater 更新状态 */
  getUpdateStatus: () => Promise<{ updateDownloaded: boolean; updateVersion: string | null }>;
  /** 重启应用以安装更新 */
  relaunchApp: () => Promise<void>;
  /** 监听更新下载完成事件 */
  onUpdateDownloaded: (callback: (data: { updateVersion: string | null }) => void) => () => void;
  /** 触发检查并下载更新 */
  checkAndDownloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  /** 监听下载进度事件 */
  onDownloadProgress: (callback: (data: DownloadProgress) => void) => () => void;
  /** 监听更新错误事件 */
  onUpdateError: (callback: (data: UpdateError) => void) => () => void;
  /** 是否为桌面端环境 */
  isDesktop: true;
}

contextBridge.exposeInMainWorld('lingxiaoDesktop', {
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  relaunchApp: () => ipcRenderer.invoke('update:relaunch'),
  onUpdateDownloaded: (callback: (data: { updateVersion: string | null }) => void) => {
    const handler = (_event: unknown, data: { updateVersion: string | null }) => callback(data);
    ipcRenderer.on('update:downloaded', handler);
    // 返回取消监听函数
    return () => ipcRenderer.removeListener('update:downloaded', handler as never);
  },
  checkAndDownloadUpdate: () => ipcRenderer.invoke('update:checkAndDownload'),
  onDownloadProgress: (callback: (data: DownloadProgress) => void) => {
    const handler = (_event: unknown, data: DownloadProgress) => callback(data);
    ipcRenderer.on('update:downloadProgress', handler);
    return () => ipcRenderer.removeListener('update:downloadProgress', handler as never);
  },
  onUpdateError: (callback: (data: UpdateError) => void) => {
    const handler = (_event: unknown, data: UpdateError) => callback(data);
    ipcRenderer.on('update:error', handler);
    return () => ipcRenderer.removeListener('update:error', handler as never);
  },
  isDesktop: true as const,
});
