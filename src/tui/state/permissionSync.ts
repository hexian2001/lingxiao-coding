import type { CommandLogMessage as LogMessage, CommandSessionStatusData as SessionStatusData } from '../../commands/types.js';
import { t } from '../../i18n.js';
import type { ApprovalBannerState } from './types.js';

interface PermissionSyncDeps {
  setSessionStatus: (updater: (prev: SessionStatusData) => SessionStatusData) => void;
  setPendingPermissionRequest: (request: ApprovalBannerState | null) => void;
  getPendingPermissionRequest?: () => ApprovalBannerState | null;
  appendMessage: (channel: string, message: LogMessage) => void;
  buildPreviewHint: (toolName: string) => string;
}

export const createPermissionSync = (deps: PermissionSyncDeps) => {
  const handleModeChanged = (event: { summary: string; mode?: 'strict' | 'dev' | 'networked' | 'yolo' }) => {
    deps.setSessionStatus((prev) => ({ ...prev, permissionSummary: event.summary, permissionMode: event.mode ?? prev.permissionMode }));
    deps.setPendingPermissionRequest(null);
    deps.appendMessage('main', { type: 'system', content: t('tui.permission.state_updated', event.summary) });
  };

  const handleRequest = (event: ApprovalBannerState & { requestId?: string }) => {
    deps.setPendingPermissionRequest(event);
    const previewHint = deps.buildPreviewHint(event.toolName);
    deps.appendMessage('main', {
      type: 'system',
      content: t(
        'tui.permission.request_log',
        event.requestId || '',
        event.source || '',
        event.workerName || '',
        event.toolName,
        event.reason,
        previewHint,
      ),
    });
  };

  const handleResolved = (event: { requestId?: string }) => {
    const current = deps.getPendingPermissionRequest?.();
    if (current?.requestId && event.requestId && current.requestId !== event.requestId) return;
    deps.setPendingPermissionRequest(null);
  };

  return {
    handleModeChanged,
    handleRequest,
    handleResolved,
  };
};
