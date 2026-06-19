import stringWidth from 'string-width';
import { isAgentTerminalStatus, normalizeAgentStatus } from '../../core/StateSemantics.js';
import { t } from '../../i18n.js';

export const AGENT_PROGRESS_STALE_MS = 60_000;
export const AGENT_HEARTBEAT_STALE_MS = 45_000;
export const AGENT_ACTIVITY_STALE_MS = 90_000;

const BOOTSTRAP_STATUSES = new Set(['bootstrapping', 'bootstrap', 'connecting', 'starting', '连接中', '启动中', '初始化中']);
const INACTIVE_STATUSES = new Set(['idle', 'completed', 'failed', 'error', 'waiting', 'approved', 'cancelled', 'terminated']);

export function sliceByWidth(text: string, maxWidth: number): { sliced: string; width: number } {
  if (maxWidth <= 0) return { sliced: '', width: 0 };
  let width = 0;
  let index = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (width + charWidth > maxWidth) break;
    width += charWidth;
    index += char.length;
  }
  return { sliced: text.slice(0, index), width };
}

export function formatElapsedLabel(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function isBootstrappingOrConnectingStatus(status: string): boolean {
  const normalized = status.toLowerCase().trim().replace(/[.…]+$/, '');
  return BOOTSTRAP_STATUSES.has(normalized);
}

export function isInactiveStatus(status: string): boolean {
  const normalized = normalizeAgentStatus(status);
  return normalized === 'idle' || isAgentTerminalStatus(normalized) || INACTIVE_STATUSES.has(status.toLowerCase().trim());
}

export function shouldShowAgentProgressMessage(message?: string, lastProgressAt?: number, now = Date.now()): boolean {
  if (!message) return false;
  if (!lastProgressAt) return true;
  if (now - lastProgressAt <= AGENT_PROGRESS_STALE_MS) return true;
  return !isBootstrappingOrConnectingStatus(message);
}

export function formatAgentHeartbeatText(options: {
  lastHeartbeatAt?: number;
  heartbeatPhase?: string;
  now?: number;
}): string | undefined {
  const { lastHeartbeatAt, heartbeatPhase, now = Date.now() } = options;
  if (!lastHeartbeatAt) return undefined;
  if (now - lastHeartbeatAt > AGENT_HEARTBEAT_STALE_MS) return undefined;
  return t('tui.agent.heartbeat_ok', heartbeatPhase || '');
}

export function deriveAgentStatusDisplay(options: {
  status?: string;
  lastProgressAt?: number;
  lastProgressMessage?: string;
  lastHeartbeatAt?: number;
  lastTextAt?: number;
  lastToolAt?: number;
  hasVisibleStream?: boolean;
  now?: number;
}): string {
  const {
    status = 'idle',
    lastProgressAt,
    lastProgressMessage,
    lastHeartbeatAt,
    lastTextAt,
    lastToolAt,
    hasVisibleStream,
    now = Date.now(),
  } = options;

  const statusLabel = status || 'idle';
  if (isInactiveStatus(statusLabel)) {
    return statusLabel;
  }

  const lastActivity = Math.max(
    lastProgressAt || 0,
    lastHeartbeatAt || 0,
    lastTextAt || 0,
    lastToolAt || 0,
  );
  const hasRecentActivity = lastActivity > 0 && (now - lastActivity) <= AGENT_ACTIVITY_STALE_MS;
  const progressStale = lastProgressAt ? (now - lastProgressAt) > AGENT_PROGRESS_STALE_MS : false;

  if (!hasVisibleStream && (!hasRecentActivity || progressStale)) {
    if (isBootstrappingOrConnectingStatus(statusLabel) || (lastProgressMessage && isBootstrappingOrConnectingStatus(lastProgressMessage))) {
      return t('tui.agent.wait_progress');
    }
    if (!hasRecentActivity) {
      return t('tui.agent.wait_progress');
    }
  }

  return statusLabel;
}

export function truncateDisplayText(text: unknown, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const singleLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (stringWidth(singleLine) <= maxWidth) {
    return singleLine;
  }
  if (maxWidth === 1) {
    return '…';
  }
  const { sliced } = sliceByWidth(singleLine, maxWidth - 1);
  return `${sliced}…`;
}
