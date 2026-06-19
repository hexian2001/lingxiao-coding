/**
 * ResyncAlertBanner — P4: SSE resync failure user-visible alert.
 *
 * Shows a dismissible banner when session:resync_failed event fires,
 * indicating the SSE connection has exceeded max reconnect attempts.
 */
import { useSessionStore } from '../stores/sessionStore';
import { AlertTriangle, X } from 'lucide-react';

export default function ResyncAlertBanner() {
  const resyncAlert = useSessionStore((s) => s.resyncAlert);
  const dismissResyncAlert = useSessionStore((s) => s.dismissResyncAlert);

  if (!resyncAlert?.active) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span className="flex-1">
        <strong>SSE 连接同步失败</strong> — 实时事件可能中断。
        原因: {resyncAlert.reason}
      </span>
      <button
        onClick={dismissResyncAlert}
        className="shrink-0 p-0.5 hover:bg-red-100 dark:hover:bg-red-900/50 rounded transition-colors"
        aria-label="dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
