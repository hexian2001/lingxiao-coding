import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CommandLogMessage, CommandSessionStatusData } from '../../commands/types.js';
import {
  shouldSurfaceLeaderStatus,
} from '../utils.js';
import { buildToolCallLogMessage, buildToolResultLogMessage } from '../state/toolLogItem.js';
import { createLeaderStatusSync } from '../state/leaderStatusSync.js';
import { finalizeStreamMessages } from '../state/streamFinalize.js';
import type { ChannelState } from '../state/types.js';
import { t } from '../../i18n.js';
import type { TuiEventPayload } from './useTuiEventBridge.js';

export type LeaderMode = 'direct' | 'hybrid' | 'delegate';

interface UseTuiLeaderHandlersOptions {
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  setSessionStatus: Dispatch<SetStateAction<CommandSessionStatusData>>;
  resetUiAfterInterrupt: () => void;
  setLeaderStatus: Dispatch<SetStateAction<string>>;
  setLeaderMode: Dispatch<SetStateAction<LeaderMode | undefined>>;
  setLeaderModeReason: Dispatch<SetStateAction<string>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  setInFlightMessage: Dispatch<SetStateAction<string>>;
  leaderStatusRef: MutableRefObject<string>;
  inFlightMessageRef: MutableRefObject<string>;
  channelsRef: MutableRefObject<Record<string, ChannelState>>;
  lastLeaderStatusLogRef: MutableRefObject<string>;
  updateChannelStatus: (ch: string, status: string) => void;
  updateChannelNext: (ch: string, next: string) => void;
  appendChannelStream: (ch: string, field: 'currentStream' | 'currentThinkingStream', chunk: string) => void;
  clearChannelStreams: (ch: string) => void;
  flushStreamBuffer: (onlyChannel?: string) => void;
  throttledUpdateChannelStatus: (ch: string, status: string) => void;
  markVisibleLeaderActivity: () => void;
  switchTab: (name: string) => void;
  showThinkingContent: boolean;
  /** 工具执行状态 setter — 驱动 StreamingStatusLine tool_executing phase */
  setToolExecutingState: Dispatch<SetStateAction<{ toolName?: string; startedAt?: number; partialJson?: string }>>;
}

/**
 * Leader/session event handlers for the TUI.
 *
 * These are grouped together because they share a lot of state
 * (leader status refs, channel mutators) and used to account for ~10
 * separate useCallback blocks inline in LingXiaoTUI.tsx.
 */
export function useTuiLeaderHandlers({
  appendMessage,
  setSessionStatus,
  resetUiAfterInterrupt,
  setLeaderStatus,
  setLeaderMode,
  setLeaderModeReason,
  setSubmitting,
  setInFlightMessage,
  leaderStatusRef,
  inFlightMessageRef,
  channelsRef,
  lastLeaderStatusLogRef,
  updateChannelStatus,
  updateChannelNext,
  appendChannelStream,
  clearChannelStreams,
  flushStreamBuffer,
  throttledUpdateChannelStatus,
  markVisibleLeaderActivity,
  switchTab,
  showThinkingContent,
  setToolExecutingState,
}: UseTuiLeaderHandlersOptions) {
  // Refs so we can keep stable callbacks while dependent props may change.
  const showThinkingRef = useRef(showThinkingContent);
  showThinkingRef.current = showThinkingContent;

  const handleSessionInterrupted = useCallback((event: TuiEventPayload<'session:interrupted'>) => {
    setSessionStatus(prev => ({ ...prev, status: 'interrupted' }));
    resetUiAfterInterrupt();
    appendMessage('main', {
      type: 'system',
      content: t('tui.leader.interrupted', event.stoppedAgents ?? 0),
    });
  }, [appendMessage, resetUiAfterInterrupt, setSessionStatus]);

  const handleSessionCompleted = useCallback((event: TuiEventPayload<'session:completed'>) => {
    setSessionStatus(prev => ({ ...prev, status: 'completed' }));
    setLeaderStatus(t('tui.leader.status.completed'));
    leaderStatusRef.current = t('tui.leader.status.completed');
    setLeaderMode(undefined);
    setLeaderModeReason('');
    setSubmitting(false);
    setInFlightMessage('');
    inFlightMessageRef.current = '';
    updateChannelStatus('main', t('tui.leader.status.completed'));
    updateChannelNext('main', '');
    appendMessage('main', { type: 'system', content: t('tui.leader.session_completed', event.sessionId) });
  }, [
    appendMessage,
    inFlightMessageRef,
    leaderStatusRef,
    setInFlightMessage,
    setLeaderMode,
    setLeaderModeReason,
    setLeaderStatus,
    setSessionStatus,
    setSubmitting,
    updateChannelNext,
    updateChannelStatus,
  ]);

  const handleLeaderStatus = useCallback((event: TuiEventPayload<'leader:status'>) => {
    createLeaderStatusSync({
      setLeaderStatus,
      leaderStatusRef,
      updateChannelStatus,
      updateChannelNext,
      appendMessage,
      shouldSurfaceLeaderStatus,
      lastLeaderStatusLogRef,
      markVisibleLeaderActivity,
    }).handleLeaderStatusEvent(event);
  }, [
    appendMessage,
    lastLeaderStatusLogRef,
    leaderStatusRef,
    markVisibleLeaderActivity,
    setLeaderStatus,
    updateChannelNext,
    updateChannelStatus,
  ]);

  const handleLeaderRoute = useCallback((event: TuiEventPayload<'leader:route'>) => {
    setLeaderMode(event.mode);
    setLeaderModeReason(event.reason);
    appendMessage('main', { type: 'system', content: t('tui.leader.mode_changed', event.mode, event.reason) });
  }, [appendMessage, setLeaderMode, setLeaderModeReason]);

  const handleLeaderTextChunk = useCallback((event: TuiEventPayload<'leader:text_chunk'>) => {
    appendChannelStream('main', 'currentStream', event.chunk);
    throttledUpdateChannelStatus('main', t('tui.leader.status.leading'));
  }, [appendChannelStream, throttledUpdateChannelStatus]);

  const handleLeaderThinkingChunk = useCallback((event: TuiEventPayload<'leader:thinking_chunk'>) => {
    if (showThinkingRef.current === false) return;
    appendChannelStream('main', 'currentThinkingStream', event.chunk);
    throttledUpdateChannelStatus('main', t('tui.leader.status.thinking'));
  }, [appendChannelStream, throttledUpdateChannelStatus]);

  const handleLeaderToolCall = useCallback((event: TuiEventPayload<'leader:tool_call'>) => {
    const icons: Record<string, string> = { ask_user: '?', create_task: '+', dispatch_agent: '>>', finish_session: 'done' };
    updateChannelNext('main', `${icons[event.tool] || '#'} ${event.tool.replace(/_/g, ' ')}`);
    appendMessage('main', buildToolCallLogMessage(event.tool, event.input));
    // 设置工具执行状态 — 驱动 StreamingStatusLine 显示「⚙ 正在执行…」+ 计时器
    setToolExecutingState({ toolName: event.tool.replace(/_/g, ' '), startedAt: Date.now(), partialJson: undefined });
    markVisibleLeaderActivity();
  }, [appendMessage, markVisibleLeaderActivity, setToolExecutingState, updateChannelNext]);

  const handleLeaderToolResult = useCallback((event: TuiEventPayload<'leader:tool_result'>) => {
    appendMessage('main', buildToolResultLogMessage(event.tool, event.result));
    updateChannelNext('main', '');
    // 清除工具执行状态
    setToolExecutingState({});
    markVisibleLeaderActivity();
  }, [appendMessage, markVisibleLeaderActivity, setToolExecutingState, updateChannelNext]);

  const handleLeaderText = useCallback((event: TuiEventPayload<'leader:text'>) => {
    finalizeStreamMessages(
      {
        channel: 'main',
        eventContent: event.content,
        eventReasoning: event.reasoningContent,
        finalRole: 'leader',
        showThinking: showThinkingRef.current !== false,
      },
      {
        appendMessage,
        flushStreamBuffer,
        channelsRef,
        clearStreams: clearChannelStreams,
      },
    );
    updateChannelNext('main', '');
    markVisibleLeaderActivity();
    setLeaderStatus(t('tui.leader.status.observing'));
    leaderStatusRef.current = t('tui.leader.status.observing');
    updateChannelStatus('main', t('tui.leader.status.observing'));
  }, [
    appendMessage,
    channelsRef,
    clearChannelStreams,
    flushStreamBuffer,
    leaderStatusRef,
    markVisibleLeaderActivity,
    setLeaderStatus,
    updateChannelNext,
    updateChannelStatus,
  ]);

  const handleLeaderPlanApproved = useCallback(() => {
    appendMessage('plan', { type: 'system', content: t('tui.plan.approved') });
    updateChannelStatus('plan', 'approved');
    updateChannelNext('plan', '');
    setLeaderStatus(t('tui.leader.status.executing'));
    leaderStatusRef.current = t('tui.leader.status.executing');
    updateChannelStatus('main', t('tui.leader.status.executing'));
    updateChannelNext('main', '');
    switchTab('main');
  }, [appendMessage, leaderStatusRef, setLeaderStatus, switchTab, updateChannelNext, updateChannelStatus]);

  const handleLeaderPlanRejected = useCallback((event: TuiEventPayload<'leader:plan_rejected'>) => {
    const feedback = typeof event?.feedback === 'string' && event.feedback.trim()
      ? `: ${event.feedback.trim()}`
      : '';
    appendMessage('plan', { type: 'system', content: t('tui.plan.rejected', feedback) });
    updateChannelStatus('plan', 'rejected');
    updateChannelNext('plan', t('tui.plan.rewrite_wait'));
    setLeaderStatus(t('tui.leader.status.replanning'));
    leaderStatusRef.current = t('tui.leader.status.replanning');
    updateChannelStatus('main', t('tui.leader.status.replanning'));
    updateChannelNext('main', t('tui.plan.resubmit_wait'));
  }, [appendMessage, leaderStatusRef, setLeaderStatus, updateChannelNext, updateChannelStatus]);

  return {
    handleSessionInterrupted,
    handleSessionCompleted,
    handleLeaderStatus,
    handleLeaderRoute,
    handleLeaderTextChunk,
    handleLeaderThinkingChunk,
    handleLeaderToolCall,
    handleLeaderToolResult,
    handleLeaderText,
    handleLeaderPlanApproved,
    handleLeaderPlanRejected,
  };
}
