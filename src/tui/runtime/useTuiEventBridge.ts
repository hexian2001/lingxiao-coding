import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { homedir } from 'node:os';
import type { EventHandler, EventEmitter, EventMap, EventName } from '../../core/EventEmitter.js';
import type { CommandLogMessage, CommandSessionStatusData } from '../../commands/types.js';
import type { Notification } from '../NotificationCenter.js';
import type { QuestionDialogState, QuestionItem, QuestionOption } from '../QuestionDialog.js';
import { t } from '../../i18n.js';
import {
  canonicalizeEventPayload,
  createEventProcessorState,
  eventPayloadToEnvelope,
  processEvent,
} from '../../contracts/adapters/EventAdapter.js';
import type { EventPayload, EventType } from '../../contracts/types/Event.js';

type EmittableEventType = Extract<EventType, EventName>;
export type TuiEventPayload<T extends EventType> = T extends EventName
  ? EventPayload<T> & EventMap[T]
  : EventPayload<T>;
export type TuiEventHandler<T extends EventType = EventType> = (event: TuiEventPayload<T>) => void;

interface UseTuiEventBridgeOptions {
  emitter: EventEmitter;
  workspace: string;
  /**
   * 读取 TUI 当前正在展示的 session id（live，非快照）。
   * emitter 是跨 session 共享的全局单例：另一个 session（如 Web UI 切过去的会话）
   * spawn 的 agent 同样会发 agent:* 事件。若不按 session 过滤，这些事件会污染本 TUI
   * 的 launchedAgents/tabOrder/channels，导致 Tab 能切到"上个会话的 agent"。
   */
  getActiveSessionId: () => string | undefined;
  setSessionStatus: Dispatch<SetStateAction<CommandSessionStatusData>>;
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  setNotifications: Dispatch<SetStateAction<Notification[]>>;
  setAgentQuestionState: Dispatch<SetStateAction<QuestionDialogState | null>>;
  pasteTimeoutRef: MutableRefObject<NodeJS.Timeout | null>;
  onSessionInterrupted: TuiEventHandler<'session:interrupted'>;
  onSessionCompleted: TuiEventHandler<'session:completed'>;
  onLeaderStatus: TuiEventHandler<'leader:status'>;
  onLeaderRoute: TuiEventHandler<'leader:route'>;
  onLeaderTextChunk: TuiEventHandler<'leader:text_chunk'>;
  onLeaderThinkingChunk: TuiEventHandler<'leader:thinking_chunk'>;
  onLeaderToolCall: TuiEventHandler<'leader:tool_call'>;
  onLeaderToolResult: TuiEventHandler<'leader:tool_result'>;
  onLeaderText: TuiEventHandler<'leader:text'>;
  onLeaderPlanApproved: TuiEventHandler<'leader:plan_approved'>;
  onLeaderPlanRejected?: TuiEventHandler<'leader:plan_rejected'>;
  onAgentSpawned: TuiEventHandler<'agent:spawned'>;
  onAgentCompleted: TuiEventHandler<'agent:completed'>;
  onAgentStatus: TuiEventHandler<'agent:status'>;
  onAgentProgress: TuiEventHandler<'agent:progress'>;
  onAgentToolCall: TuiEventHandler<'agent:tool_call'>;
  onAgentToolResult: TuiEventHandler<'agent:tool_result'>;
  onAgentTextChunk: TuiEventHandler<'agent:text_chunk'>;
  onAgentThinkingChunk: TuiEventHandler<'agent:thinking_chunk'>;
  onAgentText: TuiEventHandler<'agent:text'>;
  onAgentFailed: TuiEventHandler<'agent:failed'>;
  onAgentHeartbeat: TuiEventHandler<'agent:heartbeat'>;
  onAgentInteractiveState: TuiEventHandler<'agent:interactive_state'>;
  onTaskCreated: TuiEventHandler<'task:created'>;
  onTaskUpdated: TuiEventHandler<'task:updated' | 'task:assigned' | 'task:completed' | 'task:failed' | 'task:cancelled'>;
  onOrchestrationStatus: TuiEventHandler<'orchestration:run_state' | 'orchestration:node_update' | 'orchestration:event_applied' | 'orchestration:event_rejected'>;
  onPermissionModeChanged: TuiEventHandler<'permission:mode_changed'>;
  onPermissionRequest: TuiEventHandler<'permission:request'>;
  onPermissionResolved?: TuiEventHandler<'permission:resolved'>;
  onControlModeChanged?: TuiEventHandler<'leader:control_mode_changed'>;
  onTokenUsage: TuiEventHandler<'token:usage'>;
  onContextRuntimeUpdated: TuiEventHandler<'context:runtime_updated'>;
  onContextCompressed: TuiEventHandler<'context:compressed'>;
  /** 压缩进行中事件 — context:compacting，用于显示「压缩上下文中…」进度 */
  onContextCompacting?: TuiEventHandler<'context:compacting'>;
  onPlanSubmitted: TuiEventHandler<'plan:submitted'>;
  /** 黑板增量事件 — LeaderBlackboard 聚合后的 BlackboardDelta，用于 GraphPanel 实时更新 */
  onBlackboardDelta?: TuiEventHandler<'blackboard:delta'>;
  /** 黑板初始化结果（可用/不可用），用于同步 graphEnabled */
  onBlackboardInitialized?: TuiEventHandler<'blackboard:initialized'>;
  /** 工作笔记写入 — work_note:written，供 /notes 面板增量收集 */
  onWorkNoteWritten?: TuiEventHandler<'work_note:written'>;
  /** Leader 输入队列深度变化 — leader:message_queued/dequeued */
  onLeaderQueueChanged?: TuiEventHandler<'leader:message_queued' | 'leader:message_dequeued'>;
  /** LLM 重试 — leader:llm_retry / agent:llm_retry */
  onLlmRetry?: TuiEventHandler<'leader:llm_retry' | 'agent:llm_retry'>;
  /** Agent 进程崩溃 — agent:crashed */
  onAgentCrashed?: TuiEventHandler<'agent:crashed'>;
  /** 干预消息注入 — agent:intervention */
  onAgentIntervention?: TuiEventHandler<'agent:intervention'>;
  /** 上下文溢出告警 — context:overflow */
  onContextOverflow?: TuiEventHandler<'context:overflow'>;
  /** 工具入参流式增量 — leader:tool_call_delta */
  onLeaderToolCallDelta?: TuiEventHandler<'leader:tool_call_delta'>;
  /** 工具入参流式增量 — agent:tool_call_delta */
  onAgentToolCallDelta?: TuiEventHandler<'agent:tool_call_delta'>;
  /** Leader 阶段变更 — leader:phase_change（对齐 CodeBuddy phaseSubject） */
  onLeaderPhaseChange?: TuiEventHandler<'leader:phase_change'>;
  /** Wiki 生成开始 — wiki:generation_started */
  onWikiStarted?: TuiEventHandler<'wiki:generation_started'>;
  /** Wiki 生成进度 — wiki:generation_progress */
  onWikiProgress?: TuiEventHandler<'wiki:generation_progress'>;
  /** Wiki 章节流式内容 — wiki:generation_stream */
  onWikiStream?: TuiEventHandler<'wiki:generation_stream'>;
  /** Wiki 生成完成 — wiki:generation_completed */
  onWikiCompleted?: TuiEventHandler<'wiki:generation_completed'>;
  /** Wiki 生成失败 — wiki:generation_failed */
  onWikiFailed?: TuiEventHandler<'wiki:generation_failed'>;
  /** 记忆维护开始 — memory:maintenance_started（全局活动，不按 session 过滤） */
  onMaintenanceStarted?: TuiEventHandler<'memory:maintenance_started'>;
  /** 记忆维护进度 — memory:maintenance_progress */
  onMaintenanceProgress?: TuiEventHandler<'memory:maintenance_progress'>;
  /** 记忆维护完成 — memory:maintenance_completed */
  onMaintenanceCompleted?: TuiEventHandler<'memory:maintenance_completed'>;
  /** 记忆维护失败 — memory:maintenance_failed */
  onMaintenanceFailed?: TuiEventHandler<'memory:maintenance_failed'>;
  /** Web UI 切会话 → TUI 同步：回调中应更新 sessionId + 清空 channels/messages/tasks */
  onSessionFocus?: TuiEventHandler<'session:focus'>;
  /** Unified backend runtime snapshot used to calibrate session/kernel state. */
  onSessionRuntimeState?: TuiEventHandler<'session:runtime_state'>;
  onCleanup?: () => void;
}

export function useTuiEventBridge({
  emitter,
  workspace,
  getActiveSessionId,
  setSessionStatus,
  appendMessage,
  setNotifications,
  setAgentQuestionState,
  pasteTimeoutRef,
  onSessionInterrupted,
  onSessionCompleted,
  onLeaderStatus,
  onLeaderRoute,
  onLeaderTextChunk,
  onLeaderThinkingChunk,
  onLeaderToolCall,
  onLeaderToolResult,
  onLeaderText,
  onLeaderPlanApproved,
  onLeaderPlanRejected,
  onAgentSpawned,
  onAgentCompleted,
  onAgentStatus,
  onAgentProgress,
  onAgentToolCall,
  onAgentToolResult,
  onAgentTextChunk,
  onAgentThinkingChunk,
  onAgentText,
  onAgentFailed,
  onAgentHeartbeat,
  onAgentInteractiveState,
  onTaskCreated,
  onTaskUpdated,
  onOrchestrationStatus,
  onPermissionModeChanged,
  onPermissionRequest,
  onPermissionResolved,
  onControlModeChanged,
  onTokenUsage,
  onContextRuntimeUpdated,
  onContextCompressed,
  onContextCompacting,
  onPlanSubmitted,
  onBlackboardDelta,
  onBlackboardInitialized,
  onWorkNoteWritten,
  onLeaderQueueChanged,
  onLlmRetry,
  onAgentCrashed,
  onAgentIntervention,
  onContextOverflow,
  onLeaderToolCallDelta,
  onAgentToolCallDelta,
  onLeaderPhaseChange,
  onWikiStarted,
  onWikiProgress,
  onWikiStream,
  onWikiCompleted,
  onWikiFailed,
  onMaintenanceStarted,
  onMaintenanceProgress,
  onMaintenanceCompleted,
  onMaintenanceFailed,
  onSessionFocus,
  onSessionRuntimeState,
  onCleanup,
}: UseTuiEventBridgeOptions): void {
  useEffect(() => {
    let tuiEventProcessorState = createEventProcessorState({ sessionId: getActiveSessionId() });
    const reduceCanonicalEvent = (type: EventType, event: unknown) => {
      const envelope = eventPayloadToEnvelope(type, event, getActiveSessionId() ?? '');
      tuiEventProcessorState = processEvent(envelope, tuiEventProcessorState);
    };

    // emitter 是跨 session 共享的全局单例。把"针对某个具体 session 的事件回调"
    // 包一层 session 过滤：事件带 sessionId 且与当前 TUI 展示的 session 不一致时丢弃。
    // 不带 sessionId 的事件（少数旧事件）放行，保持兼容。
    // 这是修复"Web UI 切换会话后，TUI 仍能 Tab 切到上个会话 agent"的根因：
    // 旧会话 agent 的 agent:spawned/completed/... 会灌进本 TUI 的 launchedAgents/tabOrder。
    const scoped = <T extends EmittableEventType>(type: T, fn: TuiEventHandler<T>): EventHandler<T> =>
      ((event: EventMap[T]) => {
        const evSid = (event as { sessionId?: string }).sessionId;
        if (evSid && evSid !== getActiveSessionId()) return;
        const canonicalEvent = canonicalizeEventPayload(type, event) as TuiEventPayload<T>;
        reduceCanonicalEvent(type, canonicalEvent);
        fn(canonicalEvent);
      }) as EventHandler<T>;

    const unsubscribeSessionCreated = emitter.subscribe('session:created', (event) => {
      const activeSessionId = getActiveSessionId();
      if (activeSessionId && activeSessionId !== '未创建' && event.sessionId !== activeSessionId) return;
      reduceCanonicalEvent('session:created', event);
      setSessionStatus({
        sessionId: event.sessionId,
        workspace: event.workspace || workspace,
        status: 'active',
        createdAt: event.createdAt || Date.now(),
      });
      appendMessage('main', { type: 'system', content: t('tui.event.session_created', event.sessionId) });
    });

    const unsubscribeSessionFailed = emitter.subscribe('session:failed', (event) => {
      reduceCanonicalEvent('session:failed', event);
      setSessionStatus(prev => ({ ...prev, status: 'failed' }));
      appendMessage('main', {
        type: 'error',
        content: t('tui.event.session_failed', event.sessionId, event.error || t('tui.event.unknown_error')),
      });
    });

    const unsubscribeSessionDeleted = emitter.subscribe('session:deleted', (event) => {
      reduceCanonicalEvent('session:deleted', event);
      appendMessage('main', { type: 'system', content: t('tui.event.session_deleted', event.sessionId) });
    });

    // Web UI 切换会话 → TUI 同步：回调中应更新 sessionId + 清空旧数据
    const unsubscribeSessionFocus = onSessionFocus
      ? emitter.subscribe('session:focus', (event) => {
          if (event.sessionId) {
            reduceCanonicalEvent('session:focus', event);
            onSessionFocus(event);
          }
        })
      : () => {};
    const unsubscribeSessionRuntimeState = onSessionRuntimeState
      ? emitter.subscribe('session:runtime_state', scoped('session:runtime_state', onSessionRuntimeState))
      : () => {};

    const unsubscribeSessionInterrupted = emitter.subscribe('session:interrupted', scoped('session:interrupted', onSessionInterrupted));
    const unsubscribeSessionCompleted = emitter.subscribe('session:completed', scoped('session:completed', onSessionCompleted));

    const unsubscribeChatUserMessage = emitter.subscribe('chat:user_message', scoped('chat:user_message', (event) => {
      // TUI 本地输入已经在提交时乐观写入；只补其它入口（Web/QQBot/API）的用户消息，
      // 避免 Web 能看到 TUI 消息、TUI 却看不到 Web 消息的跨端不一致。
      if (event.source === 'tui') return;
      appendMessage('main', {
        type: 'user',
        content: typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
      });
    }));

    const unsubscribeLeaderStatus = emitter.subscribe('leader:status', scoped('leader:status', onLeaderStatus));
    const unsubscribeLeaderRoute = emitter.subscribe('leader:route', scoped('leader:route', onLeaderRoute));
    const unsubscribeLeaderTextChunk = emitter.subscribe('leader:text_chunk', scoped('leader:text_chunk', onLeaderTextChunk));
    const unsubscribeLeaderThinkingChunk = emitter.subscribe('leader:thinking_chunk', scoped('leader:thinking_chunk', onLeaderThinkingChunk));
    const unsubscribeLeaderToolCall = emitter.subscribe('leader:tool_call', scoped('leader:tool_call', onLeaderToolCall));
    const unsubscribeLeaderToolResult = emitter.subscribe('leader:tool_result', scoped('leader:tool_result', onLeaderToolResult));
    const unsubscribeLeaderText = emitter.subscribe('leader:text', scoped('leader:text', onLeaderText));
    const unsubscribeLeaderPlanApproved = emitter.subscribe('leader:plan_approved', scoped('leader:plan_approved', onLeaderPlanApproved));
    const unsubscribeLeaderPlanRejected = onLeaderPlanRejected
      ? emitter.subscribe('leader:plan_rejected', scoped('leader:plan_rejected', onLeaderPlanRejected))
      : () => {};

    const unsubscribeAgentSpawned = emitter.subscribe('agent:spawned', scoped('agent:spawned', onAgentSpawned));
    const unsubscribeAgentCompleted = emitter.subscribe('agent:completed', scoped('agent:completed', onAgentCompleted));
    const unsubscribeAgentStatus = emitter.subscribe('agent:status', scoped('agent:status', onAgentStatus));
    const unsubscribeAgentProgress = emitter.subscribe('agent:progress', scoped('agent:progress', onAgentProgress));
    const unsubscribeAgentToolCall = emitter.subscribe('agent:tool_call', scoped('agent:tool_call', onAgentToolCall));
    const unsubscribeAgentToolResult = emitter.subscribe('agent:tool_result', scoped('agent:tool_result', onAgentToolResult));
    const unsubscribeAgentTextChunk = emitter.subscribe('agent:text_chunk', scoped('agent:text_chunk', onAgentTextChunk));
    const unsubscribeAgentThinkingChunk = emitter.subscribe('agent:thinking_chunk', scoped('agent:thinking_chunk', onAgentThinkingChunk));
    const unsubscribeAgentText = emitter.subscribe('agent:text', scoped('agent:text', onAgentText));
    const unsubscribeAgentFailed = emitter.subscribe('agent:failed', scoped('agent:failed', onAgentFailed));
    const unsubscribeAgentHeartbeat = emitter.subscribe('agent:heartbeat', scoped('agent:heartbeat', onAgentHeartbeat));
    const unsubscribeAgentInteractiveState = emitter.subscribe('agent:interactive_state', scoped('agent:interactive_state', onAgentInteractiveState));

    // task:* 事件的 session 标识在 event.task.session_id（不是顶层 sessionId）。
    const scopedTask = <T extends EmittableEventType>(type: T, fn: TuiEventHandler<T>): EventHandler<T> =>
      ((event: EventMap[T]) => {
        const eventWithSession = event as { sessionId?: string; task?: { session_id?: string } };
        const evSid = eventWithSession.task?.session_id ?? eventWithSession.sessionId;
        if (evSid && evSid !== getActiveSessionId()) return;
        reduceCanonicalEvent(type, event);
        fn(event as TuiEventPayload<T>);
      }) as EventHandler<T>;

    const unsubscribeTaskCreated = emitter.subscribe('task:created', scopedTask('task:created', onTaskCreated));
    const unsubscribeTaskUpdated = emitter.subscribe('task:updated', scopedTask('task:updated', onTaskUpdated));
    const unsubscribeTaskAssigned = emitter.subscribe('task:assigned', scopedTask('task:assigned', onTaskUpdated));
    const unsubscribeTaskCompleted = emitter.subscribe('task:completed', scopedTask('task:completed', onTaskUpdated));
    const unsubscribeTaskFailed = emitter.subscribe('task:failed', scopedTask('task:failed', onTaskUpdated));
    const unsubscribeTaskCancelled = emitter.subscribe('task:cancelled', scopedTask('task:cancelled', onTaskUpdated));

    const unsubscribeOrchestrationStatus = emitter.subscribe('orchestration:run_state', scoped('orchestration:run_state', onOrchestrationStatus));
    const unsubscribeOrchestrationNodeUpdate = emitter.subscribe('orchestration:node_update', scopedTask('orchestration:node_update', (event) => {
      onOrchestrationStatus(event);
      if (event.task) onTaskUpdated({ task: event.task } as TuiEventPayload<'task:updated'>);
    }));
    const unsubscribeOrchestrationEventApplied = emitter.subscribe('orchestration:event_applied', scoped('orchestration:event_applied', (event) => {
      onOrchestrationStatus(event);
    }));
    const unsubscribeOrchestrationEventRejected = emitter.subscribe('orchestration:event_rejected', scoped('orchestration:event_rejected', (event) => {
      onOrchestrationStatus(event);
      appendMessage('main', { type: 'error', content: t('tui.event.orchestration_rejected', event.eventType, event.reason ?? 'unknown') });
    }));
    const unsubscribePermissionModeChanged = emitter.subscribe('permission:mode_changed', scoped('permission:mode_changed', onPermissionModeChanged));
    const unsubscribePermissionRequest = emitter.subscribe('permission:request', scoped('permission:request', onPermissionRequest));
    const unsubscribePermissionResolved = onPermissionResolved
      ? emitter.subscribe('permission:resolved', scoped('permission:resolved', onPermissionResolved))
      : null;
    const unsubscribeControlModeChanged = onControlModeChanged
      ? emitter.subscribe('leader:control_mode_changed', scoped('leader:control_mode_changed', onControlModeChanged))
      : null;
    const unsubscribeTokenUsage = emitter.subscribe('token:usage', scoped('token:usage', onTokenUsage));
    const unsubscribeContextRuntimeUpdated = emitter.subscribe('context:runtime_updated', scoped('context:runtime_updated', onContextRuntimeUpdated));
    const unsubscribeContextCompressed = emitter.subscribe('context:compressed', scoped('context:compressed', onContextCompressed));
    const unsubscribeContextCompacting = onContextCompacting
      ? emitter.subscribe('context:compacting', scoped('context:compacting', onContextCompacting))
      : null;
    const unsubscribePlanSubmitted = emitter.subscribe('plan:submitted', scoped('plan:submitted', onPlanSubmitted));

    const unsubscribeSkillsLoaded = emitter.subscribe('skills:loaded', scoped('skills:loaded', (event) => {
      const skills = (event.skills || []) as Array<{ name: string; source: string; summary: string }>;
      if (skills.length > 0) {
        const projectSkills = skills.filter((skill) => skill.source === 'project');
        const pluginSkills = skills.filter((skill) => skill.source === 'plugin');
        const parts = [t('tui.event.skills_ready', skills.length)];
        if (projectSkills.length > 0) {
          parts.push(t('tui.event.skills_project', projectSkills.length));
        }
        if (pluginSkills.length > 0) {
          parts.push(t('tui.event.skills_plugin', pluginSkills.length));
        }
        appendMessage('main', { type: 'system', content: `✓ ${parts.join(' · ')}` });
      }
    }));

    const unsubscribeSkillInvoked = emitter.subscribe('skill:invoked', scoped('skill:invoked', (event) => {
      const skills = (event.skills || []) as Array<{ name: string; source: string; summary: string }>;
      for (const skill of skills) {
        const sourceTag = skill.source === 'project'
          ? t('tui.event.skill_source.project')
          : skill.source === 'plugin'
            ? t('tui.event.skill_source.plugin')
            : skill.source === 'global'
              ? t('tui.event.skill_source.global')
            : t('tui.event.skill_source.builtin');
        appendMessage('main', { type: 'system', content: t('tui.event.skill_invoked', skill.name, sourceTag, skill.summary) });
      }
    }));

    const unsubscribeSoulExtracted = emitter.subscribe('session:soul_extracted', scoped('session:soul_extracted', (event) => {
      if (event.entryCount > 0) {
        const shortPath = event.soulPath?.replace(homedir(), '~') || '';
        appendMessage('main', { type: 'system', content: t('tui.event.soul_updated', shortPath, event.entryCount) });
      }
    }));

    const unsubscribeNotificationNew = emitter.subscribe('notification:new', scoped('notification:new', (event) => {
      if (!event.id) return;
      const notification = event as Notification;

      setNotifications(prev => {
        if (prev.some(item => item.id === notification.id)) return prev;

        const similarThreshold = 5000;
        const now = Date.now();
        const similarIndex = prev.findIndex(item =>
          item.type === notification.type &&
          item.title === notification.title &&
          (now - item.timestamp) < similarThreshold &&
          !item.read
        );

        if (similarIndex >= 0) {
          const updated = [...prev];
          updated[similarIndex] = {
            ...updated[similarIndex],
            timestamp: now,
            duplicateCount: (updated[similarIndex].duplicateCount || 1) + 1,
          };
          return updated;
        }

        // D8: 通知数组无界增长(只 append 无 cap)。FIFO oldest-first 封顶,保留最近 MAX_NOTIFICATIONS 条;
        // UI NotificationCenter 已只展示 maxDisplay 条,内存里存更多纯属浪费。新通知在数组尾部 → slice(-MAX)。
        const MAX_NOTIFICATIONS = 500;
        const next = prev.length >= MAX_NOTIFICATIONS ? prev.slice(prev.length - MAX_NOTIFICATIONS + 1) : prev;
        return [...next, notification];
      });
    }));

    const unsubscribeNotificationRead = emitter.subscribe('notification:mark_read', scoped('notification:mark_read', (event) => {
      const readEvent = event as TuiEventPayload<'notification:mark_read'> & { markAllRead?: boolean };
      if (event.notificationId) {
        setNotifications(prev =>
          prev.map(notification =>
            notification.id === event.notificationId ? { ...notification, read: true } : notification
          )
        );
      } else if (readEvent.markAllRead) {
        setNotifications(prev => prev.map(notification => ({ ...notification, read: true })));
      }
    }));

    const unsubscribeInputNeeded = emitter.subscribe('user:input_needed', scoped('user:input_needed', (event) => {
      const options: QuestionOption[] | undefined = Array.isArray(event.options) ? event.options : undefined;
      const questions = Array.isArray(event.questions) ? event.questions as QuestionItem[] : undefined;
      const questionItems: QuestionItem[] = questions && questions.length > 0
        ? questions
        : [{ question: event.question || t('tui.event.question_required'), options, multiSelect: event.multiSelect === true }];
      setAgentQuestionState({
        questions: questionItems,
        currentStep: 0,
        stepAnswers: Array.from({ length: questionItems.length }, () => ({
          cursor: 0,
          checked: new Set<number>(),
          inputText: '',
          inputCursor: 0,
        })),
      });
    }));

    const unsubscribeQuestionAnswered = emitter.subscribe('user:question_answered', scoped('user:question_answered', () => {
      setAgentQuestionState(null);
      // 自动清除 ask_user 派发的"需要用户输入"通知，避免 Web UI 回答后 TUI 仍显示过期通知
      setNotifications(prev => prev.map(n =>
        n.type === 'user_input_needed' ? { ...n, read: true } : n
      ));
    }));

    // 黑板增量推送 — Worker 写入新节点/边后由 LeaderBlackboard 聚合下发
    const unsubscribeBlackboardDelta = onBlackboardDelta
      ? emitter.subscribe('blackboard:delta', scoped('blackboard:delta', onBlackboardDelta))
      : () => {};
    const unsubscribeBlackboardInitialized = onBlackboardInitialized
      ? emitter.subscribe('blackboard:initialized', scoped('blackboard:initialized', onBlackboardInitialized))
      : () => {};

    const unsubscribeWorkNoteWritten = onWorkNoteWritten
      ? emitter.subscribe('work_note:written', scoped('work_note:written', onWorkNoteWritten))
      : () => {};
    const unsubscribeLeaderQueued = onLeaderQueueChanged
      ? emitter.subscribe('leader:message_queued', scoped('leader:message_queued', onLeaderQueueChanged))
      : () => {};
    const unsubscribeLeaderDequeued = onLeaderQueueChanged
      ? emitter.subscribe('leader:message_dequeued', scoped('leader:message_dequeued', onLeaderQueueChanged))
      : () => {};

    const unsubscribeLeaderRetry = onLlmRetry
      ? emitter.subscribe('leader:llm_retry', scoped('leader:llm_retry', onLlmRetry))
      : () => {};
    const unsubscribeAgentRetry = onLlmRetry
      ? emitter.subscribe('agent:llm_retry', scoped('agent:llm_retry', onLlmRetry))
      : () => {};
    const unsubscribeAgentCrashed = onAgentCrashed
      ? emitter.subscribe('agent:crashed', scoped('agent:crashed', onAgentCrashed))
      : () => {};
    const unsubscribeAgentIntervention = onAgentIntervention
      ? emitter.subscribe('agent:intervention', scoped('agent:intervention', onAgentIntervention))
      : () => {};
    const unsubscribeContextOverflow = onContextOverflow
      ? emitter.subscribe('context:overflow', scoped('context:overflow', onContextOverflow))
      : () => {};
    const unsubscribeLeaderToolCallDelta = onLeaderToolCallDelta
      ? emitter.subscribe('leader:tool_call_delta', scoped('leader:tool_call_delta', onLeaderToolCallDelta))
      : () => {};
    const unsubscribeAgentToolCallDelta = onAgentToolCallDelta
      ? emitter.subscribe('agent:tool_call_delta', scoped('agent:tool_call_delta', onAgentToolCallDelta))
      : () => {};
    const unsubscribeLeaderPhaseChange = onLeaderPhaseChange
      ? emitter.subscribe('leader:phase_change', scoped('leader:phase_change', onLeaderPhaseChange))
      : () => {};

    const unsubscribeWikiStarted = onWikiStarted
      ? emitter.subscribe('wiki:generation_started', scoped('wiki:generation_started', onWikiStarted))
      : () => {};
    const unsubscribeWikiProgress = onWikiProgress
      ? emitter.subscribe('wiki:generation_progress', scoped('wiki:generation_progress', onWikiProgress))
      : () => {};
    const unsubscribeWikiStream = onWikiStream
      ? emitter.subscribe('wiki:generation_stream', scoped('wiki:generation_stream', onWikiStream))
      : () => {};
    const unsubscribeWikiCompleted = onWikiCompleted
      ? emitter.subscribe('wiki:generation_completed', scoped('wiki:generation_completed', onWikiCompleted))
      : () => {};
    const unsubscribeWikiFailed = onWikiFailed
      ? emitter.subscribe('wiki:generation_failed', scoped('wiki:generation_failed', onWikiFailed))
      : () => {};

    // 记忆维护事件不按 session 过滤：后台 dream/distill 是全局活动，daemon 触发时
    // 的 sessionId 未必等于当前 TUI 会话，scoped 会误丢。直接透传给状态行回调。
    const unscoped = <T extends EmittableEventType>(type: T, fn: TuiEventHandler<T>): EventHandler<T> =>
      ((event: EventMap[T]) => {
        fn(canonicalizeEventPayload(type, event) as TuiEventPayload<T>);
      }) as EventHandler<T>;
    const unsubscribeMaintenanceStarted = onMaintenanceStarted
      ? emitter.subscribe('memory:maintenance_started', unscoped('memory:maintenance_started', onMaintenanceStarted))
      : () => {};
    const unsubscribeMaintenanceProgress = onMaintenanceProgress
      ? emitter.subscribe('memory:maintenance_progress', unscoped('memory:maintenance_progress', onMaintenanceProgress))
      : () => {};
    const unsubscribeMaintenanceCompleted = onMaintenanceCompleted
      ? emitter.subscribe('memory:maintenance_completed', unscoped('memory:maintenance_completed', onMaintenanceCompleted))
      : () => {};
    const unsubscribeMaintenanceFailed = onMaintenanceFailed
      ? emitter.subscribe('memory:maintenance_failed', unscoped('memory:maintenance_failed', onMaintenanceFailed))
      : () => {};

    return () => {
      unsubscribeSessionCreated();
      unsubscribeSessionFailed();
      unsubscribeSessionDeleted();
      unsubscribeSessionFocus();
      unsubscribeSessionRuntimeState();
      unsubscribeSessionInterrupted();
      unsubscribeSessionCompleted();
      unsubscribeChatUserMessage();
      unsubscribeLeaderStatus();
      unsubscribeLeaderRoute();
      unsubscribeLeaderTextChunk();
      unsubscribeLeaderThinkingChunk();
      unsubscribeLeaderToolCall();
      unsubscribeLeaderToolResult();
      unsubscribeLeaderText();
      unsubscribeLeaderPlanApproved();
      unsubscribeLeaderPlanRejected();
      unsubscribeAgentSpawned();
      unsubscribeAgentCompleted();
      unsubscribeAgentStatus();
      unsubscribeAgentProgress();
      unsubscribeAgentToolCall();
      unsubscribeAgentToolResult();
      unsubscribeAgentTextChunk();
      unsubscribeAgentThinkingChunk();
      unsubscribeAgentText();
      unsubscribeAgentFailed();
      unsubscribeAgentHeartbeat();
      unsubscribeAgentInteractiveState();
      unsubscribeTaskCreated();
      unsubscribeTaskUpdated();
      unsubscribeTaskAssigned();
      unsubscribeTaskCompleted();
      unsubscribeTaskFailed();
      unsubscribeTaskCancelled();
      unsubscribeOrchestrationStatus();
      unsubscribeOrchestrationNodeUpdate();
      unsubscribeOrchestrationEventApplied();
      unsubscribeOrchestrationEventRejected();
      unsubscribePermissionModeChanged();
      unsubscribePermissionRequest();
      unsubscribePermissionResolved?.();
      unsubscribeControlModeChanged?.();
      unsubscribeTokenUsage();
      unsubscribeContextRuntimeUpdated();
      unsubscribeContextCompressed();
      unsubscribeContextCompacting?.();
      unsubscribePlanSubmitted();
      unsubscribeSkillsLoaded();
      unsubscribeSkillInvoked();
      unsubscribeSoulExtracted();
      unsubscribeNotificationNew();
      unsubscribeNotificationRead();
      unsubscribeInputNeeded();
      unsubscribeQuestionAnswered();
      unsubscribeBlackboardDelta();
      unsubscribeBlackboardInitialized();
      unsubscribeWorkNoteWritten();
      unsubscribeLeaderQueued();
      unsubscribeLeaderDequeued();
      unsubscribeLeaderRetry();
      unsubscribeAgentRetry();
      unsubscribeAgentCrashed();
      unsubscribeAgentIntervention();
      unsubscribeContextOverflow();
      unsubscribeLeaderToolCallDelta();
      unsubscribeAgentToolCallDelta();
      unsubscribeLeaderPhaseChange();
      unsubscribeWikiStarted();
      unsubscribeWikiProgress();
      unsubscribeWikiStream();
      unsubscribeWikiCompleted();
      unsubscribeWikiFailed();
      unsubscribeMaintenanceStarted();
      unsubscribeMaintenanceProgress();
      unsubscribeMaintenanceCompleted();
      unsubscribeMaintenanceFailed();
      onCleanup?.();
      if (pasteTimeoutRef.current) clearTimeout(pasteTimeoutRef.current);
    };
  }, [
    appendMessage,
    emitter,
    getActiveSessionId,
    onAgentCompleted,
    onAgentFailed,
    onAgentHeartbeat,
    onAgentInteractiveState,
    onAgentProgress,
    onAgentSpawned,
    onAgentStatus,
    onAgentText,
    onAgentTextChunk,
    onAgentThinkingChunk,
    onAgentToolCall,
    onAgentToolResult,
    onCleanup,
    onContextCompressed,
    onContextCompacting,
    onContextRuntimeUpdated,
    onOrchestrationStatus,
    onLeaderPlanApproved,
    onLeaderPlanRejected,
    onLeaderRoute,
    onLeaderStatus,
    onLeaderText,
    onLeaderTextChunk,
    onLeaderThinkingChunk,
    onLeaderToolCall,
    onLeaderToolResult,
    onPermissionModeChanged,
    onPermissionRequest,
    onPermissionResolved,
    onPlanSubmitted,
    onSessionCompleted,
    onSessionFocus,
    onTaskCreated,
    onTaskUpdated,
    onTokenUsage,
    onSessionInterrupted,
    pasteTimeoutRef,
    setAgentQuestionState,
    setNotifications,
    setSessionStatus,
    workspace,
    onBlackboardDelta,
    onBlackboardInitialized,
    onWorkNoteWritten,
    onLeaderQueueChanged,
    onLlmRetry,
    onAgentCrashed,
    onAgentIntervention,
    onContextOverflow,
    onLeaderToolCallDelta,
    onAgentToolCallDelta,
    onWikiStarted,
    onWikiProgress,
    onWikiStream,
    onWikiCompleted,
    onWikiFailed,
    onMaintenanceStarted,
    onMaintenanceProgress,
    onMaintenanceCompleted,
    onMaintenanceFailed,
    onSessionRuntimeState,
  ]);
}
