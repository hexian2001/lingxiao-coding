import { useEffect, useRef, type MutableRefObject } from 'react';
import { t } from '../../i18n.js';
import type { NormalizedLeaderStatusKind } from '../../core/StateSemantics.js';
import type { ChannelState } from '../state/types.js';
import {
  formatLeaderHeartbeat,
  isLeaderStatusActive,
  shouldEmitLeaderHeartbeat,
} from '../utils.js';

interface UseLeaderHeartbeatOptions {
  leaderStatusRef: MutableRefObject<string>;
  leaderStatusKindRef?: MutableRefObject<NormalizedLeaderStatusKind | undefined>;
  leaderPhaseRef?: MutableRefObject<string | undefined>;
  channelsForHeartbeatRef: MutableRefObject<Record<string, ChannelState>>;
  lastLeaderVisibleActivityAtRef: MutableRefObject<number>;
  lastLeaderHeartbeatAtRef: MutableRefObject<number>;
  updateChannelNext: (channel: string, next: string) => void;
  /** 工具执行状态 ref — 让心跳文案感知工具执行进度 */
  toolExecutingStateRef?: MutableRefObject<{ toolName?: string; startedAt?: number; partialJson?: string }>;
}

export function useLeaderHeartbeat({
  leaderStatusRef,
  leaderStatusKindRef,
  leaderPhaseRef,
  channelsForHeartbeatRef,
  lastLeaderVisibleActivityAtRef,
  lastLeaderHeartbeatAtRef,
  updateChannelNext,
  toolExecutingStateRef,
}: UseLeaderHeartbeatOptions): void {
  // P0-4 (2026-05-14)：记录上一轮是否处于 active，用于检测 active→idle 转变并主动清空 next，
  // 防止 leader 回到 idle 后 channel.next 残留 "处理中 (Ns)"。
  const wasActiveRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const status = leaderStatusRef.current;
      const statusKind = leaderStatusKindRef?.current;
      const phase = leaderPhaseRef?.current;
      const mainChannel = channelsForHeartbeatRef.current.main;
      const hasVisibleStream = Boolean(mainChannel?.currentStream || mainChannel?.currentThinkingStream);
      const now = Date.now();

      const currentlyActive = isLeaderStatusActive(status, { statusKind });
      // active→idle 转变：清空 next 中残留的 "处理中 (Ns)"。
      if (wasActiveRef.current && !currentlyActive) {
        if (mainChannel?.currentNext) {
          updateChannelNext('main', '');
        }
      }
      wasActiveRef.current = currentlyActive;

      if (!shouldEmitLeaderHeartbeat({
        status,
        statusKind,
        hasVisibleStream,
        lastVisibleActivityAt: lastLeaderVisibleActivityAtRef.current,
        lastHeartbeatAt: lastLeaderHeartbeatAtRef.current,
        now,
      })) {
        return;
      }
      updateChannelNext('main', formatLeaderHeartbeat(status, now - lastLeaderVisibleActivityAtRef.current, {
        statusKind,
        phase,
        toolExecuting: toolExecutingStateRef?.current?.toolName && toolExecutingStateRef?.current?.startedAt
          ? { toolName: toolExecutingStateRef.current.toolName!, startedAt: toolExecutingStateRef.current.startedAt! }
          : undefined,
      }));
      lastLeaderHeartbeatAtRef.current = now;

      const elapsed = now - lastLeaderVisibleActivityAtRef.current;
      if (elapsed > 300000) {
        // P1-2: 300s 可操作升级 — 引导用户主动中断/重启
        updateChannelNext('main', `🔴 ${t('tui.leader.heartbeat.critical_stall', status, Math.floor(elapsed / 1000))}`);
      } else if (elapsed > 120000) {
        updateChannelNext('main', `⚠️ ${t('tui.leader.heartbeat.long_stall', status, Math.floor(elapsed / 1000))}`);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [
    channelsForHeartbeatRef,
    lastLeaderHeartbeatAtRef,
    lastLeaderVisibleActivityAtRef,
    leaderPhaseRef,
    leaderStatusKindRef,
    leaderStatusRef,
    toolExecutingStateRef,
    updateChannelNext,
  ]);
}
