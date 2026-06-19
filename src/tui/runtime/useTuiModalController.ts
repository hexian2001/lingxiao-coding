import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { getDAGSelectableItems } from '../DAGPanel.js';
import { getGraphSelectableItems } from '../GraphPanel.js';
import { createModalSync } from '../state/modalSync.js';
import { createInitialChannelMap } from '../state/channelState.js';
import type {
  CommandInitialChannelSeed,
  CommandItemsModalResult,
  CommandLogMessage,
  CommandReportModalResult,
  CommandResult,
  CommandResumeModalResult,
  CommandSessionStatusData,
  CommandTaskData,
} from '../../commands/types.js';
import type { ChannelState } from '../state/types.js';
import type { WorkerBackend } from '../../contracts/types/Agent.js';

type TuiCommandResult = CommandResult | string | void;

interface ReportModalData {
  title?: string;
  report?: string;
}

type TuiModalData = CommandResumeModalResult | CommandItemsModalResult | CommandReportModalResult | ReportModalData | null;

interface LaunchedAgent {
  name: string;
  role: string;
  taskId: string;
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
}

interface TuiGraphNode {
  id: string;
  kind: 'fact' | 'intent' | 'hint' | 'origin' | 'goal';
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdAt: number;
  supersededBy?: string;
  confidence?: string;
  intentStatus?: string;
  priority?: number;
}

interface ModalSyncItem {
  id?: string;
  agentName?: string;
  name?: string;
}

type ExistingModalData = CommandResumeModalResult | CommandItemsModalResult | null;
type TuiModalDataSetterInput = TuiModalData | ((prev: ExistingModalData) => ExistingModalData);
type TuiModalDataSetter = (value: TuiModalDataSetterInput) => void;

interface HydrateChannelSeed extends CommandInitialChannelSeed {
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
}

const WORKER_BACKENDS: readonly WorkerBackend[] = ['worker_process', 'claude', 'codex', 'remote'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readWorkerBackend(value: unknown): WorkerBackend | undefined {
  return typeof value === 'string'
    ? WORKER_BACKENDS.find((backend) => backend === value)
    : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalPid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function withHydrateChannelMetadata(seed: CommandInitialChannelSeed): HydrateChannelSeed {
  const backend = readWorkerBackend(recordValue(seed, 'backend'));
  const externalSessionId = readOptionalString(recordValue(seed, 'externalSessionId'));
  const pid = readOptionalPid(recordValue(seed, 'pid'));
  return {
    ...seed,
    ...(backend === undefined ? {} : { backend }),
    ...(externalSessionId === undefined ? {} : { externalSessionId }),
    ...(pid === undefined ? {} : { pid }),
  };
}

function isCommandResumeModalData(data: TuiModalData): data is CommandResumeModalResult {
  return isRecord(data)
    && data.action === 'resume_modal'
    && Array.isArray(data.sessions);
}

function isCommandItemsModalData(data: TuiModalData): data is CommandItemsModalResult {
  return isRecord(data)
    && typeof data.action === 'string'
    && data.action !== 'resume_modal'
    && data.action !== 'report_modal'
    && Array.isArray(data.items);
}

function isExistingModalData(data: TuiModalData): data is ExistingModalData {
  return data === null || isCommandResumeModalData(data) || isCommandItemsModalData(data);
}

interface UseTuiModalControllerOptions {
  onCommandRef: React.MutableRefObject<(input: string) => Promise<TuiCommandResult>>;
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  setSessionStatus: Dispatch<SetStateAction<CommandSessionStatusData>>;
  setTasks: Dispatch<SetStateAction<CommandTaskData[]>>;
  setChannels: Dispatch<SetStateAction<Record<string, ChannelState>>>;
  setTokenUsage: Dispatch<SetStateAction<{ total: number }>>;
  setAgentTokens: Dispatch<SetStateAction<Record<string, number>>>;
  setLeaderStatus: Dispatch<SetStateAction<string>>;
  setLeaderMode: Dispatch<SetStateAction<'direct' | 'delegate' | 'hybrid' | undefined>>;
  setLeaderModeReason: Dispatch<SetStateAction<string>>;
  setTabOrder: Dispatch<SetStateAction<string[]>>;
  setLaunchedAgents: Dispatch<SetStateAction<LaunchedAgent[]>>;
  setCurrentTab: Dispatch<SetStateAction<string>>;
  sortedTasks: CommandTaskData[];
  launchedAgents: LaunchedAgent[];
  graphNodes: TuiGraphNode[];
  switchTab: (name: string) => void;
}

export function useTuiModalController({
  onCommandRef,
  appendMessage,
  setSessionStatus,
  setTasks,
  setChannels,
  setTokenUsage,
  setAgentTokens,
  setLeaderStatus,
  setLeaderMode,
  setLeaderModeReason,
  setTabOrder,
  setLaunchedAgents,
  setCurrentTab,
  sortedTasks,
  launchedAgents,
  graphNodes,
  switchTab,
}: UseTuiModalControllerOptions) {
  const [modalType, setModalType] = useState<string | null>(null);
  const [modalCursor, setModalCursor] = useState(0);
  const [modalData, setModalDataState] = useState<TuiModalData>(null);
  const setModalData = useCallback<TuiModalDataSetter>((value) => {
    if (typeof value !== 'function') {
      setModalDataState(value);
      return;
    }
    setModalDataState((prev) => value(isExistingModalData(prev) ? prev : null));
  }, []);

  const modalTypeRef = useRef(modalType);
  const modalCursorRef = useRef(modalCursor);
  const modalDataRef = useRef(modalData);

  const handleResumeSelection = useCallback((id: string) => {
    onCommandRef.current(`/resume ${id}`).then((result: TuiCommandResult) => {
      if (typeof result === 'string') appendMessage('main', { type: 'system', content: result });
      else if (result?.action === 'hydrate') {
        if (result.sessionStatus) setSessionStatus({ ...result.sessionStatus });
        if (result.tasks) setTasks(result.tasks);
        const agentChannels = (result.channels || []).map(withHydrateChannelMetadata);
        const newChannelMap = createInitialChannelMap(result.messages || [], agentChannels);
        setChannels(newChannelMap);
        if (result.tokenUsage !== undefined) setTokenUsage({ total: result.tokenUsage });
        if (result.agentTokens) setAgentTokens(result.agentTokens);
        if (result.leaderStatus) setLeaderStatus(result.leaderStatus);
        if (result.leaderMode) setLeaderMode(result.leaderMode);
        if (result.leaderReason) setLeaderModeReason(result.leaderReason);
        const agentTabs = agentChannels.filter((channel) => channel.name !== 'main');
        setTabOrder(['main', ...agentTabs.map((channel) => channel.name)]);
        setLaunchedAgents(agentTabs.map((channel) => ({
          name: channel.name,
          role: channel.role || 'worker',
          taskId: channel.taskId || '',
          backend: channel.backend,
          externalSessionId: channel.externalSessionId,
          pid: channel.pid,
        })));
        setCurrentTab('main');
      }
    });
  }, [
    appendMessage,
    onCommandRef,
    setAgentTokens,
    setChannels,
    setCurrentTab,
    setLaunchedAgents,
    setLeaderMode,
    setLeaderModeReason,
    setLeaderStatus,
    setSessionStatus,
    setTabOrder,
    setTasks,
    setTokenUsage,
  ]);

  const modalSync = useMemo(() => createModalSync({
    getModalType: () => modalTypeRef.current,
    getModalCursor: () => modalCursorRef.current,
    getModalItems: () => {
      const data = modalDataRef.current;
      if (modalTypeRef.current === 'resume' && isCommandResumeModalData(data)) {
        return data.sessions;
      }
      if (modalTypeRef.current === 'history' && isCommandItemsModalData(data) && data.action === 'history_modal') {
        return data.items;
      }
      if (modalTypeRef.current === 'dag') {
        const dagItems = getDAGSelectableItems(sortedTasks, launchedAgents.map(agent => ({
          name: agent.name,
          role: agent.role || 'coding',
          taskId: agent.taskId,
        })));
        return dagItems.map<ModalSyncItem>((item) => {
          if (item.kind === 'agent') {
            return { id: item.agent.name, name: item.agent.name };
          }
          return {
            id: item.task.id,
            agentName: item.agentName,
            name: item.task.subject,
          };
        });
      }
      if (modalTypeRef.current === 'graph') {
        return getGraphSelectableItems(graphNodes).map<ModalSyncItem>((item) => ({
          id: item.id,
          name: item.title,
        }));
      }
      if (modalTypeRef.current === 'team') {
        // Agent 侧栏：把已派发的 Agent 列表作为可选项（↑/↓ 导航、Enter 聚焦其渠道）。
        return launchedAgents.map<ModalSyncItem>((agent) => ({
          id: agent.name,
          name: agent.name,
        }));
      }
      return undefined;
    },
    setModalType,
    setModalCursor,
    setModalData: setModalDataState,
    onResume: handleResumeSelection,
    onDAGSelect: (agentName: string) => {
      switchTab(agentName);
    },
    onTeamSelect: (agentName: string) => {
      switchTab(agentName);
    },
  }), [graphNodes, handleResumeSelection, launchedAgents, setModalDataState, sortedTasks, switchTab]);

  return {
    modalType,
    setModalType,
    modalCursor,
    setModalCursor,
    modalData,
    setModalData,
    modalTypeRef,
    modalCursorRef,
    modalDataRef,
    modalSync,
  };
}
