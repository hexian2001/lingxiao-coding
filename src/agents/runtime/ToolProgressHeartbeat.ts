/**
 * ToolProgressHeartbeat — 长工具执行心跳
 *
 * 解决问题：除 Shell 通过 agent:tool_output 推 stdout/stderr 外，绝大多数工具
 * （WebFetch / FileRead / Glob / WebSearch / Agent dispatch / HttpRequest / Python /
 *  Office 生成 / OCR / Browser 等）执行期完全静默。30s+ 长工具期间 SseBridge 不会
 * 转发任何 tool_progress 事件，前端 ToolCallCard 只剩本地 1s 计时器在转，体感像挂死。
 *
 * 设计：
 * - 工具开始执行时启动定时器，每 PROGRESS_INTERVAL_MS（默认 5s）emit 一次 progress 事件
 * - 工具结束（resolve/reject）后立即停止定时器
 * - 复用已有的 callId / sessionId / agentId 轴，与 tool_call / tool_result 同一卡片
 * - Shell 已有更细粒度的 tool_output，不重复挂心跳（避免双流）
 */

import type { EventEmitter } from '../../core/EventEmitter.js';
import type { ToolCall } from '../../llm/types.js';

/** 默认心跳间隔：5s — 足够让用户感知"系统还活着"，又不至于刷屏 */
const DEFAULT_INTERVAL_MS = 5_000;
/** 心跳启动延迟：3s — 短工具不挂心跳避免噪音，只有真正长跑的才上 progress */
const DEFAULT_START_DELAY_MS = 3_000;

/** 不挂心跳的工具（已有更细粒度的 progress 推送或本质上瞬时） */
const SKIP_TOOLS = new Set<string>([
  'shell',          // 已有 agent:tool_output / agent:shell_state
  'python_exec',    // 已有 agent:tool_output 逐 chunk 流式（execFile→spawn 重构后）
  'send_message',   // 瞬时
  'work_note',      // 瞬时
]);

export interface ToolProgressOptions {
  emitter?: EventEmitter;
  /** 当前工具调用 */
  toolCall: ToolCall;
  /** 关联会话 / agent / task 元数据 */
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  /** 'leader' 走 leader:tool_progress，'agent' 走 agent:tool_progress */
  scope: 'leader' | 'agent';
  /** 心跳间隔（毫秒），默认 5s */
  intervalMs?: number;
  /** 启动延迟（毫秒），默认 3s — 在此之前不发心跳避免短工具噪音 */
  startDelayMs?: number;
}

export interface ToolProgressHandle {
  /** 停止心跳。幂等 */
  stop(): void;
}

/**
 * 启动一个长工具心跳，返回句柄；调用方在工具执行完毕后必须 stop()。
 *
 * 使用方式：
 *   const hb = startToolProgressHeartbeat({ ... });
 *   try { return await runTool(); } finally { hb.stop(); }
 */
export function startToolProgressHeartbeat(opts: ToolProgressOptions): ToolProgressHandle {
  const toolName = opts.toolCall.function.name;
  // 已有细粒度 progress 的工具直接返回 noop 句柄
  if (SKIP_TOOLS.has(toolName) || !opts.emitter) {
    return { stop: () => {} };
  }

  const intervalMs = Math.max(1_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const startDelayMs = Math.max(0, opts.startDelayMs ?? DEFAULT_START_DELAY_MS);
  const startedAt = Date.now();
  const eventName = opts.scope === 'leader' ? 'leader:tool_progress' : 'agent:tool_progress';

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    if (stopped) return;
    const elapsed = Date.now() - startedAt;
    const payload = {
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      agentName: opts.agentName,
      taskId: opts.taskId,
      callId: opts.toolCall.id,
      tool: toolName,
      elapsedMs: elapsed,
      message: formatElapsedMessage(toolName, elapsed),
    };
    try {
      // 类型擦除：scope 决定走哪个事件名，两个 payload 形状一致
      (opts.emitter as unknown as { emit: (k: string, v: unknown) => void }).emit(eventName, payload);
    } catch {
      // 防御：emitter 故障不影响工具执行
    }
  };

  const startTimer = setTimeout(() => {
    if (stopped) return;
    // 立即发一次，让前端从"运行中"切到"运行 Xs..."
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }, startDelayMs);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(startTimer);
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// ─── LLM 调用期间的心跳 ──────────────────────────────────────────────────────

export interface LlmInFlightHeartbeatOptions {
  emitter?: EventEmitter;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  /** 'leader' 走 leader:progress，'agent' 走 agent:progress（后者在 WorkerProcessEntry
   *  bridgedEvents 内 → 桥接到父进程 reset lastHeartbeat —— 这是本心跳的核心目的） */
  scope: 'leader' | 'agent';
  /** 心跳间隔（ms），默认 15s —— 密于 worker 的 30s setInterval，在 60-90s 心跳窗口内提供充足 headroom */
  intervalMs?: number;
}

export type LlmInFlightHeartbeatHandle = ToolProgressHandle;

/**
 * LLM 调用期间持续 emit `agent:progress`，解决「request_timeout 全程（首 token 前）worker 除
 * 30s setInterval 外零 IPC，父进程心跳阈值会把 LlmGuard 正在重试的活 worker 误判
 * heartbeat_timeout 杀掉」（即「LLM 自愈噪声干扰 leader」的误杀根因）。
 *
 * 与 startToolProgressHeartbeat 的关键区别：
 *   - emit `agent:progress`（非 `agent:tool_progress`）：前者在 WorkerProcessEntry.bridgedEvents，
 *     会桥接到父进程 reset lastHeartbeat；后者不在 bridgedEvents，到不了父进程、不 reset 心跳。
 *   - 无 startDelay：LLM 调用一进入就可能长时间无 token（TTFB），必须立即开始 reset 心跳。
 *   - 无 SKIP：所有 LLM 调用都挂。
 *
 * 残留风险：若 SDK 同步阻塞 event loop 超过父进程心跳阈值，setInterval tick 不触发 —— 该
 * pathological 场景由阈值安全网（WORKER_HEARTBEAT_TIMEOUT_MS=90s）部分覆盖，更深层属 SDK 问题。
 */
export function startLlmInFlightHeartbeat(opts: LlmInFlightHeartbeatOptions): LlmInFlightHeartbeatHandle {
  if (!opts.emitter) {
    return { stop: () => {} };
  }
  const intervalMs = Math.max(1_000, opts.intervalMs ?? 15_000);
  const eventName = opts.scope === 'leader' ? 'leader:progress' : 'agent:progress';
  const startedAt = Date.now();

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    if (stopped) return;
    const elapsed = Date.now() - startedAt;
    try {
      (opts.emitter as unknown as { emit: (k: string, v: unknown) => void }).emit(eventName, {
        sessionId: opts.sessionId,
        agentId: opts.agentId,
        agentName: opts.agentName,
        taskId: opts.taskId,
        phase: 'llm_inference',
        elapsedMs: elapsed,
        message: `LLM 推理中 ${Math.floor(elapsed / 1000)}s`,
      });
    } catch {
      // 防御：emitter 故障不影响 LLM 调用
    }
  };

  // 立即发一次（TTFB 可能从第 0s 开始），再按间隔续发
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function formatElapsedMessage(tool: string, ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${tool} 已运行 ${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${tool} 已运行 ${m}m${s.toString().padStart(2, '0')}s`;
}
