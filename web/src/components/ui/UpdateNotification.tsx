import { useEffect, useRef, useCallback, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getServerToken } from '../../api/headers';

// ── Types ───────────────────────────────────────────────────────────

/** 版本检测 API 响应 */
interface VersionCheckResponse {
  data: {
    current: string;
    latest: string;
    hasUpdate: boolean;
    releaseUrl: string;
    releaseNotes: string;
  };
}

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

/** 桌面端 IPC 接口（由 preload.ts 注入） */
interface LingxiaoDesktopAPI {
  getUpdateStatus: () => Promise<{ updateDownloaded: boolean; updateVersion: string | null }>;
  relaunchApp: () => Promise<void>;
  onUpdateDownloaded: (callback: (data: { updateVersion: string | null }) => void) => () => void;
  checkAndDownloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  onDownloadProgress: (callback: (data: DownloadProgress) => void) => () => void;
  onUpdateError: (callback: (data: UpdateError) => void) => () => void;
  isDesktop: true;
}

/** Window 上可能存在的桌面端 API */
declare global {
  interface Window {
    lingxiaoDesktop?: LingxiaoDesktopAPI;
  }
}

/** 对话框状态机 */
type DialogState = 'idle' | 'confirming' | 'downloading' | 'downloaded' | 'error';

// ── Constants ───────────────────────────────────────────────────────

const INITIAL_DELAY = 5_000; // 启动后5秒首次检查
const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 每4小时检查一次
const SHOW_UPDATE_DIALOG_EVENT = 'lingxiao:show-update-dialog';

// ── Helpers ─────────────────────────────────────────────────────────

/** 带认证 token 调用 API */
async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    headers: {
      'x-lingxiao-token': getServerToken(),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** 格式化文件大小 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** 获取平台对应的更新命令 */
function getPlatformUpdateCommand(): { command: string; description: string } {
  return {
    command: 'lingxiao upgrade',
    description: 'lingxiao upgrade',
  };
}

// ── Update Dialog Component ─────────────────────────────────────────

interface UpdateDialogProps {
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  releaseUrl: string;
  isDesktop: boolean;
  onClose: () => void;
}

function UpdateDialog({
  currentVersion,
  latestVersion,
  releaseNotes,
  releaseUrl,
  isDesktop,
  onClose,
}: UpdateDialogProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<DialogState>('confirming');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const downloadInitiatedRef = useRef(false);

  // 监听下载进度
  useEffect(() => {
    if (!isDesktop || !window.lingxiaoDesktop) return;

    const unsubProgress = window.lingxiaoDesktop.onDownloadProgress((data) => {
      setProgress(data);
      setState('downloading');
    });

    const unsubDownloaded = window.lingxiaoDesktop.onUpdateDownloaded(() => {
      setState('downloaded');
    });

    const unsubError = window.lingxiaoDesktop.onUpdateError((data) => {
      setErrorMessage(data.message);
      setState('error');
    });

    return () => {
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, [isDesktop]);

  // 桌面端：确认后自动开始下载
  const handleConfirmDownload = useCallback(async () => {
    if (!isDesktop || !window.lingxiaoDesktop) return;
    if (downloadInitiatedRef.current) return;
    downloadInitiatedRef.current = true;

    setState('downloading');
    setProgress({ percent: 0, transferred: 0, total: 0 });

    try {
      const result = await window.lingxiaoDesktop.checkAndDownloadUpdate();
      if (!result.success) {
        setErrorMessage(result.error || t('update.error.unknown', '未知错误'));
        setState('error');
      }
      // 成功时等待 onDownloadProgress / onUpdateDownloaded 事件驱动状态
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [isDesktop, t]);

  // 重启应用
  const handleRelaunch = useCallback(() => {
    void window.lingxiaoDesktop?.relaunchApp();
  }, []);

  // 重试下载
  const handleRetry = useCallback(() => {
    downloadInitiatedRef.current = false;
    setErrorMessage('');
    setProgress(null);
    setState('confirming');
  }, []);

  // 截取 release notes 前 500 字符
  const notesPreview = releaseNotes.slice(0, 300);
  const platformCmd = getPlatformUpdateCommand();
  const progressPercent = Math.round(progress?.percent ?? 0);

  return (
    <div
      className="fixed bottom-5 right-5 z-50 lx-update-toast"
      role="dialog"
      aria-label={t('update.title', '发现新版本')}
    >
      <div
        className="lingxiao-cloud-panel relative w-[380px] rounded-xl"
        style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--color-border-default)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
        }}
      >
        {/* Close button */}
        {state !== 'downloading' && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3.5 top-3 z-10 rounded-md p-1.5 transition-colors hover:bg-[var(--color-bg-primary)]"
            style={{ color: 'var(--color-text-tertiary)' }}
            title={t('update.close', '关闭')}
          >
            <X size={14} />
          </button>
        )}

        {/* Header */}
        <div
          className="flex items-center gap-2.5 px-5 py-3"
          style={{ borderBottom: '1px solid var(--color-border-muted)' }}
        >
          <div
            className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{
              background: 'color-mix(in srgb, var(--color-accent-brand) 12%, transparent)',
            }}
          >
            <Zap size={14} style={{ color: 'var(--color-accent-brand)' }} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              {t('update.title', '发现新版本')}
            </div>
            <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              v{currentVersion} → v{latestVersion}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {/* Release Notes */}
          {notesPreview && (
            <div>
              <div className="text-xs font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                {t('update.releaseNotes', '更新内容')}
              </div>
              <div
                className="text-xs rounded-lg p-2.5 max-h-[120px] overflow-y-auto"
                style={{
                  background: 'var(--color-bg-input)',
                  border: '1px solid var(--color-border-muted)',
                  color: 'var(--color-text-secondary)',
                  whiteSpace: 'pre-wrap',
                  lineHeight: '1.5',
                }}
              >
                {notesPreview}
                {releaseNotes.length > 300 && '...'}
              </div>
            </div>
          )}

          {/* Downloading: progress bar */}
          {state === 'downloading' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  {t('update.downloading', '下载中...')}
                </span>
                <span>{progressPercent}%</span>
              </div>
              <div
                className="h-2 rounded-full overflow-hidden"
                style={{ background: 'var(--color-bg-input)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${progressPercent}%`,
                    background: 'var(--color-accent-brand)',
                  }}
                />
              </div>
              {progress && progress.total > 0 && (
                <div className="text-xs text-right" style={{ color: 'var(--color-text-tertiary)' }}>
                  {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
                </div>
              )}
            </div>
          )}

          {/* Downloaded: success message */}
          {state === 'downloaded' && (
            <div
              className="flex items-center gap-2.5 rounded-lg p-3"
              style={{
                background: 'color-mix(in srgb, var(--color-accent-green) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-accent-green) 25%, transparent)',
              }}
            >
              <CheckCircle2 size={18} style={{ color: 'var(--color-accent-green)' }} />
              <span className="text-sm" style={{ color: 'var(--color-text-primary)' }}>
                {t('update.downloaded', '更新已下载完成，重启后生效')}
              </span>
            </div>
          )}

          {/* Error message */}
          {state === 'error' && (
            <div
              className="flex items-start gap-2.5 rounded-lg p-3"
              style={{
                background: 'color-mix(in srgb, var(--color-accent-red) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-accent-red) 25%, transparent)',
              }}
            >
              <AlertCircle size={18} style={{ color: 'var(--color-accent-red)', flexShrink: 0, marginTop: 1 }} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                  {t('update.error.title', '更新失败')}
                </div>
                <div className="text-xs mt-1 break-words" style={{ color: 'var(--color-text-secondary)' }}>
                  {errorMessage}
                </div>
              </div>
            </div>
          )}

          {/* Non-desktop: platform update command */}
          {!isDesktop && state === 'confirming' && (
            <div className="space-y-2">
              <div className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                {t('update.command.title', '更新命令')}
              </div>
              <div
                className="flex items-center justify-between rounded-lg p-3"
                style={{
                  background: 'var(--color-bg-input)',
                  border: '1px solid var(--color-border-input)',
                }}
              >
                <code
                  className="text-xs font-mono"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {platformCmd.command}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(platformCmd.command);
                  }}
                  className="rounded px-2 py-1 text-xs transition-colors"
                  style={{
                    background: 'var(--color-bg-primary)',
                    color: 'var(--color-text-secondary)',
                    border: '1px solid var(--color-border-default)',
                  }}
                  title={t('update.command.copy', '复制')}
                >
                  {t('update.command.copy', '复制')}
                </button>
              </div>
              {releaseUrl && (
                <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('update.orDownload', '或前往')}
                  {' '}
                  <a
                    href={releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--color-accent-brand)' }}
                  >
                    GitHub Releases
                  </a>
                  {' '}
                  {t('update.downloadManually', '手动下载')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: '1px solid var(--color-border-muted)' }}
        >
          {/* Cancel / Close button */}
          {state !== 'downloading' && state !== 'downloaded' && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-all"
              style={{
                color: 'var(--color-text-secondary)',
                background: 'transparent',
                border: '1px solid var(--color-border-default)',
              }}
            >
              {t('update.cancel', '稍后更新')}
            </button>
          )}

          {/* Confirm / Download button (desktop confirming) */}
          {isDesktop && state === 'confirming' && (
            <button
              type="button"
              onClick={handleConfirmDownload}
              className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-medium transition-all"
              style={{
                background: 'var(--primary-button-bg)',
                color: 'var(--primary-button-fg)',
                boxShadow: '0 0 16px color-mix(in srgb, var(--color-accent-brand) 20%, transparent)',
              }}
            >
              <Download size={15} />
              {t('update.downloadNow', '立即下载')}
            </button>
          )}

          {/* Restart button (downloaded) */}
          {state === 'downloaded' && (
            <button
              type="button"
              onClick={handleRelaunch}
              className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-medium transition-all"
              style={{
                background: 'var(--primary-button-bg)',
                color: 'var(--primary-button-fg)',
                boxShadow: '0 0 16px color-mix(in srgb, var(--color-accent-brand) 20%, transparent)',
              }}
            >
              <RotateCcw size={15} />
              {t('update.restart', '重启生效')}
            </button>
          )}

          {/* Retry button (error) */}
          {state === 'error' && (
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-medium transition-all"
              style={{
                background: 'var(--primary-button-bg)',
                color: 'var(--primary-button-fg)',
                boxShadow: '0 0 16px color-mix(in srgb, var(--color-accent-brand) 20%, transparent)',
              }}
            >
              <RefreshCw size={15} />
              {t('update.retry', '重试')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────

/**
 * 版本更新通知组件
 *
 * - App 启动 5 秒后调用 version/check
 * - 检测到更新后弹出确认对话框（不是 Toast）
 * - 桌面端：确认后调用 electron-updater 下载，显示进度条，完成后提示重启
 * - 非桌面端：显示平台对应的更新命令（npm update -g / brew upgrade）
 * - 支持外部通过 CustomEvent('lingxiao:show-update-dialog') 触发对话框
 * - 每 4 小时重复检查
 */
export default function UpdateNotification() {
  const dismissedVersionRef = useRef<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [versionData, setVersionData] = useState<{
    current: string;
    latest: string;
    releaseUrl: string;
    releaseNotes: string;
  } | null>(null);

  const isDesktop = !!(typeof window !== 'undefined' && window.lingxiaoDesktop?.isDesktop);

  const checkVersion = useCallback(async () => {
    try {
      const checkRes = await apiFetch<VersionCheckResponse>('/version/check');
      const { hasUpdate, latest, current, releaseUrl, releaseNotes } = checkRes.data;

      if (!hasUpdate) return;

      // 用户已关闭过该版本的对话框，不再自动弹出
      if (dismissedVersionRef.current === latest) return;

      setVersionData({ current, latest, releaseUrl, releaseNotes });
      setShowDialog(true);
    } catch {
      // 静默失败 — 不影响用户使用
    }
  }, []);

  // 监听外部触发（来自 SidebarVersionBadge）
  useEffect(() => {
    const handler = () => {
      // 如果已有版本数据，直接显示；否则先检查
      if (versionData) {
        setShowDialog(true);
      } else {
        void checkVersion();
      }
    };

    window.addEventListener(SHOW_UPDATE_DIALOG_EVENT, handler);
    return () => window.removeEventListener(SHOW_UPDATE_DIALOG_EVENT, handler);
  }, [versionData, checkVersion]);

  // 监听桌面端更新下载完成事件 — 自动弹出对话框显示"重启生效"
  useEffect(() => {
    if (!isDesktop || !window.lingxiaoDesktop) return;

    const unsub = window.lingxiaoDesktop.onUpdateDownloaded((data) => {
      // 直接弹出对话框，显示已下载状态
      setVersionData((prev) => ({
        current: prev?.current ?? '',
        latest: data.updateVersion ?? prev?.latest ?? '',
        releaseUrl: prev?.releaseUrl ?? '',
        releaseNotes: prev?.releaseNotes ?? '',
      }));
      setShowDialog(true);
    });

    return unsub;
  }, [isDesktop]);

  // 启动延迟检查 + 定期检查
  useEffect(() => {
    const initialTimer = setTimeout(() => {
      void checkVersion();
    }, INITIAL_DELAY);

    const intervalTimer = setInterval(() => {
      void checkVersion();
    }, CHECK_INTERVAL);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [checkVersion]);

  const handleClose = useCallback(() => {
    setShowDialog(false);
    if (versionData) {
      dismissedVersionRef.current = versionData.latest;
    }
  }, [versionData]);

  if (!showDialog || !versionData) return null;

  return (
    <UpdateDialog
      currentVersion={versionData.current}
      latestVersion={versionData.latest}
      releaseNotes={versionData.releaseNotes}
      releaseUrl={versionData.releaseUrl}
      isDesktop={isDesktop}
      onClose={handleClose}
    />
  );
}
