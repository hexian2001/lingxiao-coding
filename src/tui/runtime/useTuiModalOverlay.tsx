import React, { useMemo } from 'react';
import { Box } from 'ink';
import { DAGPanel } from '../DAGPanel.js';
import { BlueprintPanel } from '../BlueprintPanel.js';
import { ContractPanel } from '../ContractPanel.js';
import { GraphPanel } from '../GraphPanel.js';
import { WorkNotesPanel } from '../WorkNotesPanel.js';
import { GitPanel } from '../GitPanel.js';
import { ReportPanel } from '../ReportPanel.js';
import { MemoryPanel, type TuiMemoryStatus } from '../MemoryPanel.js';
import { TeamView } from '../TeamView.js';
import { NotificationCenter, type Notification } from '../NotificationCenter.js';
import { PickerPanel } from '../PickerPanel.js';
import { SettingsPanel, EMPTY_SETTINGS_EDIT, type SettingsEditState, type SettingsFeedback } from '../SettingsPanel.js';
import { tuiTheme } from '../theme.js';
import type { AgentRuntimeDiagnostic, ChannelState } from '../state/types.js';
import { normalizeChannelStatusInput } from '../state/channelState.js';
import type { CommandItemsModalResult, CommandResumeModalResult, CommandTaskData } from '../../commands/types.js';
import type { WorkerBackend } from '../../contracts/types/Agent.js';
import { t } from '../../i18n.js';

interface UseTuiModalOverlayOptions {
  modalType: string | null;
  modalData: CommandResumeModalResult | CommandItemsModalResult | { title?: string; report?: string } | null;
  modalCursor: number;
  termCols: number;
  termRows: number;
  sortedTasks: CommandTaskData[];
  launchedAgents: Array<{ name: string; role?: string; taskId: string; backend?: WorkerBackend; externalSessionId?: string; pid?: number }>;
  agentDiagnostics: Record<string, AgentRuntimeDiagnostic>;
  channels: Record<string, ChannelState>;
  notifications: Notification[];
  workNotes?: import('../WorkNotesPanel.js').WorkNoteItem[];
  gitData?: import('../GitPanel.js').GitPanelData | null;
  blueprint?: import('../../core/ProjectBlueprint.js').ProjectBlueprint | null;
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  graphEnabled: boolean;
  settingsEditState?: SettingsEditState;
  settingsFeedback?: SettingsFeedback | null;
  memoryStatus?: TuiMemoryStatus | null;
}

type GraphNodeKind = 'fact' | 'intent' | 'hint' | 'origin' | 'goal';
type GraphNodeIntentStatus = 'open' | 'exploring' | 'resolved' | 'abandoned';

interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdAt: number;
  supersededBy?: string;
  confidence?: 'confirmed' | 'likely' | 'tentative';
  intentStatus?: GraphNodeIntentStatus;
  priority?: number;
}

interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  createdAt: number;
}

function toTeamAgentStatus(status?: string): 'idle' | 'working' | 'waiting' | 'completed' | 'failed' {
  const normalized = normalizeChannelStatusInput(status).status;
  switch (normalized) {
    case 'failed':
    case 'crashed':
      return 'failed';
    case 'completed':
    case 'stopped':
      return 'completed';
    case 'idle':
    case 'unknown':
      return 'waiting';
    default:
      return 'working';
  }
}

export function useTuiModalOverlay({
  modalType,
  modalData,
  modalCursor,
  termCols,
  termRows,
  sortedTasks,
  launchedAgents,
  agentDiagnostics,
  channels,
  notifications,
  workNotes,
  gitData,
  graphNodes,
  graphEdges,
  graphEnabled,
  settingsEditState,
  settingsFeedback,
  memoryStatus,
  blueprint,
}: UseTuiModalOverlayOptions): React.ReactNode {
  const modalVisibleRows = Math.max(6, Math.min(12, termRows - 14));
  const modalMaxWidth = Math.max(24, termCols - 10);

  return useMemo(() => {
    if (!modalType) return null;

    const panelProps = {
      borderColor: tuiTheme.panelBorder,
      maxWidth: modalMaxWidth,
      termCols,
      cursor: modalCursor,
      visibleRows: modalVisibleRows,
    };

    let panel: React.ReactNode = null;
    if (modalType === 'dag') {
      panel = (
        <DAGPanel
          tasks={sortedTasks}
          agents={launchedAgents.map(agent => ({
            name: agent.name,
            role: agent.role || 'coding',
            taskId: agent.taskId,
          }))}
          width={modalMaxWidth}
          cursor={modalCursor}
        />
      );
    } else if (modalType === 'graph') {
      panel = (
        <GraphPanel
          nodes={graphNodes}
          edges={graphEdges}
          width={modalMaxWidth}
          cursor={modalCursor}
          enabled={graphEnabled}
        />
      );
    } else if (modalType === 'workNotes') {
      panel = <WorkNotesPanel notes={workNotes || []} maxNotes={20} />;
    } else if (modalType === 'git') {
      panel = (
        <GitPanel
          data={gitData}
          width={modalMaxWidth}
          cursor={modalCursor}
          visibleRows={modalVisibleRows}
        />
      );
    } else if (modalType === 'blueprint') {
      panel = <BlueprintPanel blueprint={blueprint ?? null} width={modalMaxWidth} />;
    } else if (modalType === 'contracts') {
      panel = <ContractPanel width={modalMaxWidth} />;
    } else if (modalType === 'report') {
      const report = modalData as { title?: string; report?: string } | null;
      panel = (
        <ReportPanel
          data={report && report.report != null ? { title: report.title || t('tui.report.title'), report: report.report } : null}
          width={modalMaxWidth}
          cursor={modalCursor}
          visibleRows={modalVisibleRows}
        />
      );
    } else if (modalType === 'team') {
      panel = (
        <TeamView
          agents={launchedAgents.map(agent => {
            const diagnostic = agentDiagnostics[agent.name];
            const status = toTeamAgentStatus(channels[agent.name]?.status);
            return {
              id: agent.name,
              name: agent.name,
              role: agent.role || 'coding',
              taskId: agent.taskId,
              status,
              backend: diagnostic?.backend || agent.backend,
              externalSessionId: diagnostic?.externalSessionId || agent.externalSessionId,
              pid: diagnostic?.pid || agent.pid,
              recoveryAction: diagnostic?.recoveryAction,
              stderrTail: diagnostic?.stderrTail,
            };
          })}
          width={modalMaxWidth}
          cursorIndex={modalCursor}
        />
      );
    } else if (modalType === 'notifications') {
      panel = (
        <NotificationCenter
          notifications={notifications}
          maxDisplay={20}
          width={modalMaxWidth}
        />
      );
    } else if (modalType === 'resume' && modalData) {
      const modalSessions = (modalData as CommandResumeModalResult).sessions;
      panel = (
        <PickerPanel
          title={t('tui.modal.resume_title', modalSessions?.length || 0)}
          items={modalSessions?.map(session => ({ title: `${session.id} [${session.status}]`, detail: session.preview || '' })) || []}
          helpText={t('tui.modal.picker_help')}
          {...panelProps}
        />
      );
    } else if (modalType === 'history' && modalData) {
      const modalItems = (modalData as CommandItemsModalResult).items;
      panel = (
        <PickerPanel
          title={t('tui.modal.history_title', modalItems?.length || 0)}
          items={modalItems?.map(item => ({ title: `${item.id} [${item.status ?? ''}]`, detail: item.preview || '' })) || []}
          helpText={t('tui.modal.picker_help')}
          {...panelProps}
        />
      );
    } else if (modalType === 'settings') {
      panel = (
        <SettingsPanel width={modalMaxWidth} cursor={modalCursor} editState={settingsEditState || EMPTY_SETTINGS_EDIT} feedback={settingsFeedback} />
      );
    } else if (modalType === 'memory') {
      panel = <MemoryPanel status={memoryStatus || null} width={modalMaxWidth} />;
    }

    if (!panel) return null;
    return (
      <Box flexDirection="column" paddingX={1}>
        {panel}
      </Box>
    );
  }, [
    modalType,
    modalData,
    modalCursor,
    modalVisibleRows,
    modalMaxWidth,
    termCols,
    sortedTasks,
    launchedAgents,
    agentDiagnostics,
    channels,
    notifications,
    workNotes,
    gitData,
    graphNodes,
    graphEdges,
    graphEnabled,
    settingsEditState,
    settingsFeedback,
    memoryStatus,
    blueprint,
  ]);
}
