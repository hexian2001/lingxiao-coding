/**
 * SessionRunController — 会话编排相位投影与变更通知
 *
 * Phase 0–1：从现有信号纯函数推导 phase（不强制改写业务主循环），
 * 消灭「有 ready 却显示 idle」的语义黑洞，并为后续收编 waitingForUser 提供单一入口。
 *
 * 详见 docs/contracts/orchestration-kernel-v2.md
 */

import type {
  SessionRunPhase,
  SessionRunReason,
  SessionRunSignals,
  SessionRunSnapshot,
} from '../contracts/types/SessionRun.js';

export type SessionRunChangeListener = (
  next: SessionRunSnapshot,
  prev: SessionRunSnapshot | null,
) => void;

/**
 * 纯函数：由运行时信号推导 SessionRun 相位。
 * 优先级（高→低）：recovering → thinking → dispatching → waiting_workers
 * → waiting_user（含 deferred ready）→ eternal_patrol → ready_needs_decision → idle
 */
export function deriveSessionRunPhase(signals: SessionRunSignals): {
  phase: SessionRunPhase;
  reason: SessionRunReason;
  hasDeferredReadyWork: boolean;
  silentIdleViolation: boolean;
} {
  const ready = Math.max(0, signals.readyTaskCount | 0);
  const running = Math.max(0, signals.runningAgentCount | 0);
  const recovering = Math.max(0, signals.recoveringCount | 0);
  const hasDeferredReadyWork =
    ready > 0 && running === 0 && !signals.isBusyThinking && !signals.isDispatching;

  if (recovering > 0) {
    return {
      phase: 'recovering',
      reason: 'recovering',
      hasDeferredReadyWork,
      silentIdleViolation: false,
    };
  }

  if (signals.isBusyThinking) {
    return {
      phase: 'thinking',
      reason: 'busy_thinking',
      hasDeferredReadyWork,
      silentIdleViolation: false,
    };
  }

  if (signals.isDispatching) {
    return {
      phase: 'dispatching',
      reason: 'dispatching',
      hasDeferredReadyWork,
      silentIdleViolation: false,
    };
  }

  if (running > 0) {
    return {
      phase: 'waiting_workers',
      reason: 'workers_running',
      hasDeferredReadyWork,
      silentIdleViolation: false,
    };
  }

  // 硬用户门 / 评审：明确 waiting_user
  if (signals.explicitUserGate) {
    return {
      phase: 'waiting_user',
      reason: 'explicit_user_gate',
      hasDeferredReadyWork,
      silentIdleViolation: false,
    };
  }
  if (signals.pendingReview) {
    return {
      phase: 'waiting_user',
      reason: 'pending_review',
      hasDeferredReadyWork,
      silentIdleViolation: false,
    };
  }

  // 有 ready 可派、无 running：绝不能标 idle（这是 manual silent idle 的根因）
  if (hasDeferredReadyWork) {
    if (signals.waitingForUserFlag) {
      return {
        phase: 'waiting_user',
        reason: 'leader_deferred_ready_tasks',
        hasDeferredReadyWork: true,
        silentIdleViolation: false,
      };
    }
    // 未 latch 等待 → 需要决策回合（代码层应推进 thinking，投影先标 ready_needs_decision）
    return {
      phase: 'thinking',
      reason: 'ready_needs_decision',
      hasDeferredReadyWork: true,
      silentIdleViolation: false,
    };
  }

  if (signals.waitingForUserFlag) {
    return {
      phase: 'waiting_user',
      reason: 'soft_wait_user',
      hasDeferredReadyWork: false,
      silentIdleViolation: false,
    };
  }

  if (signals.controlMode === 'eternal' && signals.isEternalPatrolIdle) {
    return {
      phase: 'eternal_patrol',
      reason: 'eternal_patrol',
      hasDeferredReadyWork: false,
      silentIdleViolation: false,
    };
  }

  if (signals.allTasksTerminal || (ready === 0 && running === 0)) {
    return {
      phase: 'idle',
      reason: signals.allTasksTerminal ? 'all_work_terminal' : 'no_open_work',
      hasDeferredReadyWork: false,
      // 理论不应发生：ready>0 已在上方处理
      silentIdleViolation: ready > 0 && signals.controlMode === 'manual',
    };
  }

  return {
    phase: 'idle',
    reason: 'unknown',
    hasDeferredReadyWork: false,
    silentIdleViolation: ready > 0 && signals.controlMode === 'manual',
  };
}

export class SessionRunController {
  private snapshot: SessionRunSnapshot;
  private readonly listeners = new Set<SessionRunChangeListener>();

  constructor(initial?: Partial<SessionRunSnapshot>) {
    this.snapshot = {
      phase: 'idle',
      reason: 'init',
      generation: 0,
      updatedAt: Date.now(),
      readyTaskCount: 0,
      runningAgentCount: 0,
      recoveringCount: 0,
      waitingForUser: false,
      explicitUserGate: false,
      pendingReview: false,
      controlMode: 'manual',
      collaborationMode: 'solo',
      teamReady: null,
      hasDeferredReadyWork: false,
      silentIdleViolation: false,
      ...initial,
    };
  }

  getSnapshot(): SessionRunSnapshot {
    return { ...this.snapshot };
  }

  onChange(listener: SessionRunChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 用最新信号重算相位；仅 phase/reason/ready/running 等关键字段变化时 generation++ 并通知。
   */
  recompute(signals: SessionRunSignals): SessionRunSnapshot {
    const derived = deriveSessionRunPhase(signals);
    const prev = this.snapshot;
    const next: SessionRunSnapshot = {
      phase: derived.phase,
      reason: derived.reason,
      generation: prev.generation,
      updatedAt: Date.now(),
      readyTaskCount: Math.max(0, signals.readyTaskCount | 0),
      runningAgentCount: Math.max(0, signals.runningAgentCount | 0),
      recoveringCount: Math.max(0, signals.recoveringCount | 0),
      waitingForUser: signals.waitingForUserFlag,
      explicitUserGate: signals.explicitUserGate,
      pendingReview: signals.pendingReview,
      controlMode: signals.controlMode,
      collaborationMode: signals.collaborationMode,
      teamReady: signals.teamReady,
      hasDeferredReadyWork: derived.hasDeferredReadyWork,
      silentIdleViolation: derived.silentIdleViolation,
    };

    const changed =
      prev.phase !== next.phase
      || prev.reason !== next.reason
      || prev.readyTaskCount !== next.readyTaskCount
      || prev.runningAgentCount !== next.runningAgentCount
      || prev.waitingForUser !== next.waitingForUser
      || prev.hasDeferredReadyWork !== next.hasDeferredReadyWork
      || prev.controlMode !== next.controlMode
      || prev.collaborationMode !== next.collaborationMode
      || prev.teamReady !== next.teamReady;

    if (changed) {
      next.generation = prev.generation + 1;
      this.snapshot = next;
      for (const listener of this.listeners) {
        try {
          listener(next, prev);
        } catch {
          /* listener 不得拖垮编排 */
        }
      }
    } else {
      // 刷新计数时间戳但不升 generation
      this.snapshot = { ...next, generation: prev.generation, updatedAt: prev.updatedAt };
    }

    return this.getSnapshot();
  }
}
