import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CommandLogMessage, CommandTaskData } from '../../commands/types.js';
import type { AgentRuntimeDiagnostic, ChannelState } from '../state/types.js';
import {
  DEFAULT_TEXT_DIAGNOSTIC_THROTTLE_MS,
  applyAgentDiagnosticUpdate,
  shouldRecordAgentTextActivity,
} from '../state/diagnosticSync.js';
import { buildToolCallLogMessage, buildToolResultLogMessage } from '../state/toolLogItem.js';
import { finalizeStreamMessages } from '../state/streamFinalize.js';
import { buildAgentSpawnTree } from '../utils.js';
import { isTaskTerminalStatus } from '../../core/StateSemantics.js';
import type { WorkerInteractiveRuntimeSnapshot } from '../../agents/runtime/WorkerInteractiveRuntime.js';
import type { WorkerBackend } from '../../contracts/types/Agent.js';
import { t } from '../../i18n.js';
import type { TuiEventPayload } from './useTuiEventBridge.js';

export type LaunchedAgent = {
  name: string;
  role: string;
  taskId: string;
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
};

interface UseTuiAgentHandlersOptions {
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  ensureChannel: (name: string, role?: string, taskId?: string) => void;
  clearChannelStreams: (ch: string) => void;
  flushStreamBuffer: (onlyChannel?: string) => void;
  appendChannelStream: (ch: string, field: 'currentStream' | 'currentThinkingStream', chunk: string) => void;
  updateChannelStatus: (ch: string, status: string) => void;
  updateChannelNext: (ch: string, next: string) => void;
  throttledUpdateChannelStatus: (ch: string, status: string) => void;
  setAgentDiagnostics: Dispatch<SetStateAction<Record<string, AgentRuntimeDiagnostic>>>;
  setAgentInteractiveStates: Dispatch<SetStateAction<Record<string, WorkerInteractiveRuntimeSnapshot>>>;
  setTasks: Dispatch<SetStateAction<CommandTaskData[]>>;
  setLaunchedAgents: Dispatch<SetStateAction<LaunchedAgent[]>>;
  setCurrentMode: Dispatch<SetStateAction<'chat' | 'plan' | 'agent'>>;
  setLeaderStatus: Dispatch<SetStateAction<string>>;
  agentIdMapRef: MutableRefObject<Record<string, string>>;
  channelsForHeartbeatRef: MutableRefObject<Record<string, ChannelState>>;
  channelsRef: MutableRefObject<Record<string, ChannelState>>;
  showThinkingContent: boolean;
  /** 工具执行状态 setter — 驱动 StreamingStatusLine tool_executing phase */
  setToolExecutingState: Dispatch<SetStateAction<{ toolName?: string; startedAt?: number; partialJson?: string }>>;
}

/**
 * Agent/task lifecycle event handlers for the TUI.
 *
 * Pulled out of LingXiaoTUI.tsx as a cohesive group since they all mutate
 * the same bag of state (diagnostics, channels, launched agents, tasks).
 */
export function useTuiAgentHandlers({
  appendMessage,
  ensureChannel,
  clearChannelStreams,
  flushStreamBuffer,
  appendChannelStream,
  updateChannelStatus,
  updateChannelNext,
  throttledUpdateChannelStatus,
  setAgentDiagnostics,
  setAgentInteractiveStates,
  setTasks,
  setLaunchedAgents,
  setCurrentMode,
  setLeaderStatus,
  agentIdMapRef,
  channelsForHeartbeatRef,
  channelsRef,
  showThinkingContent,
  setToolExecutingState,
}: UseTuiAgentHandlersOptions) {
  const updateAgentDiagnostic = useCallback((agentName: string, updates: Partial<AgentRuntimeDiagnostic>) => {
    setAgentDiagnostics(prev => applyAgentDiagnosticUpdate(prev, agentName, updates));
  }, [setAgentDiagnostics]);

  const showThinkingRef = useRef(showThinkingContent);
  showThinkingRef.current = showThinkingContent;

  const agentTextDiagnosticThrottleRef = useRef<Record<string, number>>({});
  const updateAgentTextActivity = useCallback((agentName: string) => {
    const now = Date.now();
    if (!shouldRecordAgentTextActivity(
      agentTextDiagnosticThrottleRef.current,
      agentName,
      now,
      DEFAULT_TEXT_DIAGNOSTIC_THROTTLE_MS,
    )) {
      return;
    }
    updateAgentDiagnostic(agentName, { lastTextAt: now });
  }, [updateAgentDiagnostic]);

  const handleAgentSpawned = useCallback((event: TuiEventPayload<'agent:spawned'>) => {
    agentIdMapRef.current = {
      ...agentIdMapRef.current,
      [event.agentName]: event.agentName,
      [event.agentId]: event.agentName,
    };
    ensureChannel(event.agentName, event.role, event.taskId);
    updateChannelStatus(event.agentName, 'running');
    const taskProgress = t('tui.agent.running_task', event.taskId);
    updateChannelNext(event.agentName, taskProgress);
    updateAgentDiagnostic(event.agentName, {
      lastProgressMessage: taskProgress,
      lastProgressAt: Date.now(),
      backend: event.backend || 'worker_process',
      externalSessionId: event.externalSessionId,
      pid: event.pid,
      logPath: event.logPath,
    });
    setCurrentMode(prev => (prev === 'chat' ? 'agent' : prev));
    setLaunchedAgents(prev => {
      const item: LaunchedAgent = {
        name: event.name,
        role: event.role,
        taskId: event.taskId,
        backend: event.backend || 'worker_process',
        externalSessionId: event.externalSessionId,
        pid: event.pid,
      };
      const next = prev.some(agent => agent.name === event.name)
        ? prev.map(agent => (agent.name === event.name ? { ...agent, ...item } : agent))
        : [...prev, item];
      appendMessage('main', { type: 'system', content: t('tui.agent.launched_count', next.length) });
      appendMessage('main', { type: 'system', content: buildAgentSpawnTree(next) });
      return next;
    });
    appendMessage(event.name, {
      type: 'system',
      content: t('tui.agent.started_task', event.taskId, event.backend && event.backend !== 'worker_process' ? event.backend : ''),
    });
  }, [
    agentIdMapRef,
    appendMessage,
    ensureChannel,
    setCurrentMode,
    setLaunchedAgents,
    updateAgentDiagnostic,
    updateChannelNext,
    updateChannelStatus,
  ]);

  const handleAgentCompleted = useCallback((event: TuiEventPayload<'agent:completed'>) => {
    ensureChannel(event.agentName, 'agent', event.taskId);
    flushStreamBuffer(event.agentName);
    clearChannelStreams(event.agentName);
    updateChannelStatus(event.agentName, 'completed');
    updateChannelNext(event.agentName, '');
    updateAgentDiagnostic(event.agentName, {
      lastProgressMessage: t('tui.meta.done', 1, 1),
      lastProgressAt: Date.now(),
      backend: event.backend,
      externalSessionId: event.externalSessionId,
      pid: event.pid,
      logPath: event.logPath,
    });
    const iterations = event.stats?.iterations ?? '?';
    const toolCalls = event.stats?.toolCalls ?? '?';
    appendMessage('main', {
      type: 'system',
      content: t('tui.agent.completed', event.agentName, String(iterations), String(toolCalls)),
    });
    appendMessage(event.agentName, {
      type: 'system',
      content: t('tui.agent.completed_self', String(iterations), String(toolCalls)),
    });
  }, [
    appendMessage,
    clearChannelStreams,
    ensureChannel,
    flushStreamBuffer,
    updateAgentDiagnostic,
    updateChannelNext,
    updateChannelStatus,
  ]);

  const handleAgentStatus = useCallback((event: TuiEventPayload<'agent:status'>) => {
    ensureChannel(event.agentName);
    updateChannelStatus(event.agentName, event.status);
    updateAgentDiagnostic(event.agentName, {
      lastProgressMessage: event.status,
      lastProgressAt: Date.now(),
      backend: event.backend,
      externalSessionId: event.externalSessionId,
      pid: event.pid,
      logPath: event.logPath,
      recoverable: event.recoverable,
      recoveryAction: event.recoveryAction,
    });
  }, [ensureChannel, updateAgentDiagnostic, updateChannelStatus]);

  const handleAgentProgress = useCallback((event: TuiEventPayload<'agent:progress'>) => {
    ensureChannel(event.name, 'agent', event.taskId);
    agentIdMapRef.current = { ...agentIdMapRef.current, [event.agentId]: event.name };
    updateAgentDiagnostic(event.name, {
      lastProgressMessage: event.message,
      lastProgressAt: Date.now(),
    });
    updateChannelNext(event.name, event.message);
    appendMessage(event.name, { type: 'system', content: event.message });
  }, [agentIdMapRef, appendMessage, ensureChannel, updateAgentDiagnostic, updateChannelNext]);

  const handleAgentToolCall = useCallback((event: TuiEventPayload<'agent:tool_call'>) => {
    const name = agentIdMapRef.current[event.agentId];
    if (!name) return;
    updateAgentDiagnostic(name, {
      lastToolName: event.tool,
      lastToolAt: Date.now(),
      lastProgressMessage: t('tui.agent.tool_call', event.tool),
      lastProgressAt: Date.now(),
    });
    ensureChannel(name);
    updateChannelNext(name, t('tui.agent.tool_call', event.tool));
    updateChannelStatus(name, t('tui.agent.status.calling', event.tool));
    appendMessage(name, buildToolCallLogMessage(event.tool, event.input));
    // 设置工具执行状态 — 驱动 StreamingStatusLine 显示「⚙ 正在执行…」+ 计时器
    setToolExecutingState({ toolName: event.tool.replace(/_/g, ' '), startedAt: Date.now(), partialJson: undefined });
  }, [agentIdMapRef, appendMessage, ensureChannel, setToolExecutingState, updateAgentDiagnostic, updateChannelNext, updateChannelStatus]);

  const handleAgentToolResult = useCallback((event: TuiEventPayload<'agent:tool_result'>) => {
    const name = agentIdMapRef.current[event.agentId];
    if (!name) return;
    updateAgentDiagnostic(name, {
      lastToolName: event.tool,
      lastToolAt: Date.now(),
      lastProgressMessage: t('tui.agent.tool_result', event.tool),
      lastProgressAt: Date.now(),
    });
    ensureChannel(name);
    updateChannelNext(name, '');
    updateChannelStatus(name, String(event.tool || '').toLowerCase() === 'attempt_completion' ? 'completed' : t('tui.agent.status.observing'));
    appendMessage(name, buildToolResultLogMessage(event.tool, event.result));
    // 清除工具执行状态
    setToolExecutingState({});
  }, [agentIdMapRef, appendMessage, ensureChannel, setToolExecutingState, updateAgentDiagnostic, updateChannelNext, updateChannelStatus]);

  const handleAgentTextChunk = useCallback((event: TuiEventPayload<'agent:text_chunk'>) => {
    const name = agentIdMapRef.current[event.agentId];
    if (!name) return;
    updateAgentTextActivity(name);
    ensureChannel(name);
    appendChannelStream(name, 'currentStream', event.chunk);
    throttledUpdateChannelStatus(name, t('tui.agent.status.working'));
  }, [agentIdMapRef, appendChannelStream, ensureChannel, throttledUpdateChannelStatus, updateAgentTextActivity]);

  const handleAgentThinkingChunk = useCallback((event: TuiEventPayload<'agent:thinking_chunk'>) => {
    if (showThinkingRef.current === false) return;
    const name = agentIdMapRef.current[event.agentId];
    if (!name) return;
    updateAgentTextActivity(name);
    ensureChannel(name);
    appendChannelStream(name, 'currentThinkingStream', event.chunk);
    throttledUpdateChannelStatus(name, t('tui.agent.status.thinking'));
  }, [agentIdMapRef, appendChannelStream, ensureChannel, throttledUpdateChannelStatus, updateAgentTextActivity]);

  const handleAgentText = useCallback((event: TuiEventPayload<'agent:text'>) => {
    const name = agentIdMapRef.current[event.agentId];
    if (!name) return;
    updateAgentDiagnostic(name, { lastTextAt: Date.now() });
    finalizeStreamMessages(
      {
        channel: name,
        eventContent: event.content,
        eventReasoning: event.reasoningContent,
        finalRole: 'agent',
        showThinking: showThinkingRef.current !== false,
      },
      {
        appendMessage,
        flushStreamBuffer,
        channelsRef,
        clearStreams: clearChannelStreams,
      },
    );
    updateChannelStatus(name, t('tui.agent.status.working'));
    updateChannelNext(name, '');
  }, [
    agentIdMapRef,
    appendMessage,
    channelsRef,
    clearChannelStreams,
    flushStreamBuffer,
    updateAgentDiagnostic,
    updateChannelNext,
    updateChannelStatus,
  ]);

  const handleAgentFailed = useCallback((event: TuiEventPayload<'agent:failed'>) => {
    const name = event.agentName || agentIdMapRef.current[event.agentId];
    if (!name) return;
    ensureChannel(name, 'agent', event.taskId);
    updateChannelStatus(name, 'failed');
    updateChannelNext(name, event.error || event.recoveryAction || t('tui.dag.status.failed'));
    updateAgentDiagnostic(name, {
      lastProgressMessage: event.error || t('tui.dag.status.failed'),
      lastProgressAt: Date.now(),
      backend: event.backend,
      externalSessionId: event.externalSessionId,
      pid: event.pid,
      logPath: event.logPath,
      recoverable: event.recoverable,
      recoveryAction: event.recoveryAction,
      stderrTail: event.stderrTail,
      stdoutTail: event.stdoutTail,
    });
    appendMessage(name, {
      type: 'error',
      content: t('tui.agent.failed', event.error || t('tui.event.unknown_error'), event.recoveryAction || ''),
    });
  }, [agentIdMapRef, appendMessage, ensureChannel, updateAgentDiagnostic, updateChannelNext, updateChannelStatus]);

  const handleAgentHeartbeat = useCallback((event: TuiEventPayload<'agent:heartbeat'>) => {
    if (!event.agentName) return;
    updateAgentDiagnostic(event.agentName, {
      lastHeartbeatAt: event.timestamp || Date.now(),
      heartbeatPhase: event.phase,
    });
    ensureChannel(event.agentName, 'agent', event.taskId);
    const channel = channelsForHeartbeatRef.current[event.agentName];
    const hasVisibleStream = Boolean(channel?.currentStream || channel?.currentThinkingStream);
    const next = channel?.currentNext || '';
    const heartbeatWait = t('tui.agent.heartbeat_wait');
    // heartbeatWait 为当前语言的心跳文案；中文哨兵兼容语言切换前残留的历史值，确保下次心跳能正确刷新
    if (!hasVisibleStream && (!next || next === heartbeatWait || next === '等待下一个输出（worker 心跳正常）')) {
      updateChannelNext(event.agentName, heartbeatWait);
    }
    if ((channel?.status || '') === 'running') {
      updateChannelStatus(event.agentName, t('tui.agent.status.working'));
    }
  }, [channelsForHeartbeatRef, ensureChannel, updateAgentDiagnostic, updateChannelNext, updateChannelStatus]);

  const handleAgentInteractiveState = useCallback((event: TuiEventPayload<'agent:interactive_state'>) => {
    if (!event.agentName || !event.state) return;
    setAgentInteractiveStates(prev => ({
      ...prev,
      [event.agentName]: event.state as WorkerInteractiveRuntimeSnapshot,
    }));
  }, [setAgentInteractiveStates]);

  const handleTaskCreated = useCallback((event: TuiEventPayload<'task:created'>) => {
    const task = event.task as CommandTaskData;
    if (!task?.id) return;
    // 幂等：task:created 可能晚于 orchestration:node_update 或会话快照补水合携带同一任务到达。
    // 同一 id 已在列表中时绝不能重复追加，否则一个任务会在 DAG/TaskBoard 里渲染成两条。
    let appended = false;
    setTasks(prev => {
      if (prev.some(item => item.id === task.id)) return prev;
      appended = true;
      return [...prev, task];
    });
    if (appended) {
      appendMessage('main', { type: 'system', content: t('tui.agent.task_created', task.id, task.subject) });
    }
  }, [appendMessage, setTasks]);

  const handleTaskUpdated = useCallback((event: TuiEventPayload<'task:updated' | 'task:assigned' | 'task:completed' | 'task:failed' | 'task:cancelled'>) => {
    const task = event.task as CommandTaskData | undefined;
    if (!task?.id) return;
    setTasks(prev => {
      const exists = prev.some(item => item.id === task.id);
      const next = exists ? prev.map(item => (item.id === task.id ? task : item)) : [...prev, task];
      if (next.length && next.every(item => isTaskTerminalStatus(item))) {
        setLeaderStatus(t('tui.leader.status.wrapping_up'));
        updateChannelNext('main', '');
      }
      return next;
    });
  }, [setLeaderStatus, setTasks, updateChannelNext]);

  return {
    updateAgentDiagnostic,
    updateAgentTextActivity,
    handleAgentSpawned,
    handleAgentCompleted,
    handleAgentStatus,
    handleAgentProgress,
    handleAgentToolCall,
    handleAgentToolResult,
    handleAgentTextChunk,
    handleAgentThinkingChunk,
    handleAgentText,
    handleAgentFailed,
    handleAgentHeartbeat,
    handleAgentInteractiveState,
    handleTaskCreated,
    handleTaskUpdated,
  };
}
