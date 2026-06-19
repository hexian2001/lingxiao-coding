import type { WorkerInteractiveRuntimeSnapshot } from '../../agents/runtime/WorkerInteractiveRuntime.js';
import { isTerminalSessionActiveStatus, normalizeTerminalSessionStatus } from '../../core/StateSemantics.js';
import { t } from '../../i18n.js';
import { buildPermissionPreviewHint, truncateDisplayText } from '../utils.js';

export interface InteractiveRuntimePanelView {
  visible: boolean;
  lines: string[];
}

function summarizeLiveOutput(content: string, maxWidth: number): string {
  const normalized = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' · ');
  return truncateDisplayText(normalized || t('tui.runtime.empty_output'), maxWidth);
}

export function buildInteractiveRuntimePanelView(
  snapshot: WorkerInteractiveRuntimeSnapshot | undefined,
  maxWidth: number,
): InteractiveRuntimePanelView {
  if (!snapshot) {
    return { visible: false, lines: [] };
  }

  const lines: string[] = [];
  const shellPids = Object.values(snapshot.shellPids);
  const terminalSessions = snapshot.terminalSessions || [];
  const activeTerminals = terminalSessions.filter(s => isTerminalSessionActiveStatus(s.status));
  const summaryParts = [
    snapshot.queuedMessages.length > 0 ? t('tui.runtime.queue', snapshot.queuedMessages.length) : '',
    snapshot.pendingApprovals.length > 0 ? t('tui.runtime.approval', snapshot.pendingApprovals.length) : '',
    snapshot.liveOutputs.length > 0 ? t('tui.runtime.output', snapshot.liveOutputs.length) : '',
    shellPids.length > 0 ? t('tui.runtime.shell', shellPids.join(',')) : '',
    activeTerminals.length > 0 ? t('tui.runtime.terminal', activeTerminals.length) : '',
  ].filter(Boolean);

  if (summaryParts.length > 0) {
    lines.push(truncateDisplayText(summaryParts.join(' · '), maxWidth));
  }

  if (snapshot.lastProgressMessage) {
    lines.push(truncateDisplayText(t('tui.runtime.progress', snapshot.lastProgressMessage), maxWidth));
  }

  if (snapshot.queuedMessages.length > 0) {
    lines.push(
      truncateDisplayText(
        t('tui.runtime.pending', snapshot.queuedMessages.slice(-1)[0] || ''),
        maxWidth,
      ),
    );
  }

  for (const approval of snapshot.pendingApprovals.slice(0, 2)) {
    const hint = buildPermissionPreviewHint(approval.toolName);
    lines.push(
      truncateDisplayText(
        t('tui.runtime.approval_line', approval.toolName, approval.reason, hint),
        maxWidth,
      ),
    );
  }

  for (const output of snapshot.liveOutputs.slice(0, 2)) {
    const pidText = typeof output.pid === 'number' ? ` pid=${output.pid}` : '';
    lines.push(
      truncateDisplayText(
        t('tui.runtime.output_line', output.toolName, output.stream, pidText, summarizeLiveOutput(output.content, Math.max(16, maxWidth - 20))),
        maxWidth,
      ),
    );
  }

  for (const terminal of activeTerminals.slice(0, 3)) {
    const tid = terminal.terminalId.substring(0, 6);
    const pidText = terminal.pid ? ` pid=${terminal.pid}` : '';
    const statusLabel = normalizeTerminalSessionStatus(terminal.status) === 'suspended'
      ? t('tui.runtime.terminal.suspended')
      : t('tui.runtime.terminal.running');
    lines.push(
      truncateDisplayText(
        t('tui.runtime.terminal_line', tid, pidText, statusLabel),
        maxWidth,
      ),
    );
  }

  return {
    visible: lines.length > 0,
    lines,
  };
}
