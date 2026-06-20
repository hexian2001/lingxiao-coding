import type { EventEmitter, EventMap, EventName } from '../core/EventEmitter.js';
import type { ConnectionManager } from './ConnectionManager.js';
import { isRunActiveStatus, normalizeRunStatus } from '../core/StateSemantics.js';
import {
  eventPayloadToEnvelope,
  eventPayloadToSessionUpdateMessage,
  type EventEnvelopeOptions,
  type EventType,
} from '../contracts/adapters/EventAdapter.js';
import { WORKFLOW_REALTIME_EVENT_NAMES } from '../contracts/types/Workflow.js';
import type { WorkflowRealtimeEventName } from '../contracts/types/Workflow.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

type TaskBridgeEvent =
  | 'task:created'
  | 'task:updated'
  | 'task:deleted'
  | 'task:assigned'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled';

type WikiGenerationEventType = Extract<EventType, `wiki:${string}`>;
type WorkflowRealtimeEventType = WorkflowRealtimeEventName;
type MemoryMaintenanceEventType = Extract<EventType, `memory:maintenance_${string}`>;

/**
 * 对称转发事件名表（单一事实源）：事件名即广播名，data 原样透传。
 * 新增同类事件只需在此 push 一行，无需再写一个 subscribe 闭包。
 *
 * - SESSION_FORWARD_EVENTS：直接转发到所属 session 的 session/update 信封。
 * - AGENT_FORWARD_EVENTS：经 agentId → sessionId 路由后转发。
 */
const SESSION_FORWARD_EVENTS = [
  // Leader 流式 / 离散
  'leader:text_chunk',
  'leader:thinking_chunk',
  'leader:tool_call',
  'leader:tool_call_delta',
  'leader:tool_result',
  'leader:phase_change',
  'leader:text',
  'leader:llm_retry',
  'leader:tool_progress',
  'chat:user_message',
  'leader:round_complete',
  'leader:watchdog_alert',
  'leader:progress_stagnant',
  'leader:control_mode_changed',
  'leader:blueprint_updated',
  'leader:plan_approved',
  'leader:plan_rejected',
  'leader:message_queued',
  // Permission / goal / user / plan
  'permission:request',
  'permission:resolved',
  'permission:mode_changed',
  'eternal:goal_changed',
  'user:input_needed',
  'user:question_answered',
  'plan:submitted',
  'plan:updated',
  'plan:finalized',
  // Orchestration（非 run_state）
  'orchestration:node_update',
  'orchestration:event_applied',
  'orchestration:event_rejected',
  // Session resync
  'session:resync_failed',
  // Session resync
  // Blackboard
  'blackboard:delta',
  'blackboard:initialized',
  // Session / run
  'session:soul_extracted',
  'session:renamed',
  'run:explanation_updated',
  // Context（非 compacting / runtime_updated）
  'context:compressed',
  'context:overflow',
  'session:runtime_state',
  // Langfuse real-time trace push
  'langfuse:trace',
  // Git activity (commit/push/pull with agent identity + gate result)
  'git:activity',
] as const satisfies readonly (EventType & EventName)[];

const AGENT_FORWARD_EVENTS = [
  'agent:text_chunk',
  'agent:thinking_chunk',
  'agent:llm_retry',
  'agent:tool_call',
  'agent:tool_call_delta',
  'agent:tool_result',
  'agent:shell_state',
  'agent:status',
  'agent:progress',
  'agent:heartbeat',
  'agent:interactive_state',
  'agent:crashed',
  'terminal:output',
  'terminal:state',
] as const satisfies readonly (EventType & EventName)[];

/** Wiki 生成事件：对称转发（broadcastWikiUpdate，sessionId 取自 payload）。 */
const WIKI_GENERATION_EVENTS = [
  'wiki:generation_started',
  'wiki:generation_progress',
  'wiki:generation_completed',
  'wiki:generation_failed',
  'wiki:generation_stream',
] as const satisfies readonly (WikiGenerationEventType & EventName)[];

/** 记忆维护事件：对称转发到所有已连接会话（broadcastMemoryMaintenance）。 */
const MEMORY_MAINTENANCE_EVENTS = [
  'memory:maintenance_started',
  'memory:maintenance_progress',
  'memory:maintenance_completed',
  'memory:maintenance_failed',
] as const satisfies readonly (MemoryMaintenanceEventType & EventName)[];

/**
 * 桥接凌霄 EventEmitter → SSE 客户端
 *
 * 订阅 emitter 事件，按 sessionId 过滤并转换为 ACP session/update 格式，
 * 通过 ConnectionManager 广播到对应的 SSE 客户端。
 */
export class SseBridge {
  private unsubscribes: (() => void)[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Throttle leader:status broadcasts — 重复状态 100ms 内不重发（原 500ms，降低感知延迟）*/
  private lastStatusBySession = new Map<string, { status: string; at: number }>();
  private static STATUS_THROTTLE_MS = 100;
  /** D15: lastStatusBySession 容量保护(超限时删最早 20%,与 agentSessionMap 同口径)。*/
  private static STATUS_MAP_MAX = 5_000;
  /**
   * agentId → sessionId 反查表。
   * 由 agent:spawned / agent:started 学习，下游事件即使 emitter 漏字段也能兜底，
   * 避免 agent session 路由因 sessionId 缺失丢弃事件并打 warn。
   *
   * 2026-05-28：completed/terminated/failed 不再立即 delete，改 60s 后清理。
   * 历史问题：长跑场景下 agent_text/tool_result/message:ack 偶有几百 ms ~ 数秒
   * 的尾部到达，立即 delete 会让这些晚到事件解析不到 sessionId 被丢弃，
   * 前端 agent 面板表现为"长时间不更新"。延迟到 60s 给晚到事件足够窗口。
   */
  private agentSessionMap = new Map<string, string>();
  /** agentId → 待清理 timer（spawn/started 同 agentId 出现时取消） */
  private agentSessionCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** agentSessionMap 延迟清理窗口；60s 与 LlmGuard wall-clock 量级匹配 */
  private static AGENT_SESSION_CLEANUP_MS = 60_000;
  /** agentSessionMap 最大容量，防止无界增长 */
  private static AGENT_SESSION_MAP_MAX = 10_000;
  /** Guard: prevent duplicate listeners if start() is called more than once */
  private _started = false;
  /** 标记实例是否已被 destroy，防止 stop 后残余 setImmediate 回调继续操作 */
  private _destroyed = false;

  constructor(
    private emitter: EventEmitter,
    private connectionManager: ConnectionManager,
  ) {}

  /**
   * 启动事件桥接：订阅所有需要的 emitter 事件
   */
  start() {
    if (this._started) return;
    this._destroyed = false;
    // 防御：清理可能残留的旧订阅（stop 异常后重新 start 的场景）
    if (this.unsubscribes.length > 0) {
      for (const unsub of this.unsubscribes) {
        try { unsub(); } catch { /* ignore */ }
      }
      this.unsubscribes = [];
    }
    this._started = true;

    // ============================================================
    // 对称转发：事件名即广播名，data 原样透传。
    // 收敛为三个泛型注册循环，新增同类事件只需 push 一行。
    // 非对称事件（throttle / transform / session 学习）见下方各自 subscribe。
    // ============================================================

    // --- 直接转发到所属 session 的 session/update 信封 ---
    // Leader 文本/工具/阶段/状态等流式与离散事件 + permission/goal/user/plan/orchestration/blackboard/session/run/context
    this.registerSessionForwarders(SESSION_FORWARD_EVENTS);

    // --- 直接转发到 agent 所属 session（agentId → sessionId 路由） ---
    // Worker 文本/工具/状态/心跳/终端等流式与离散事件
    this.registerAgentForwarders(AGENT_FORWARD_EVENTS);

    // --- Workflow 实时事件 → canonical direct envelope（单一事实源：Workflow.ts 常量） ---
    for (const name of WORKFLOW_REALTIME_EVENT_NAMES) {
      this.subscribe(name, (data) => this.broadcastWorkflowRealtimeEvent(name, data));
    }

    // ============================================================
    // 非对称事件：需要 throttle / transform / session 学习等特殊处理。
    // ============================================================

    // Leader 事件
    this.subscribe('leader:status', (data) => {
      const status = data.status as string;
      const sid = data.sessionId as string;
      // Throttle: skip duplicate status within window
      const last = this.lastStatusBySession.get(sid);
      const now = Date.now();
      if (last && last.status === status && now - last.at < SseBridge.STATUS_THROTTLE_MS) {
        return;
      }
      this.lastStatusBySession.set(sid, { status, at: now });
      // D15: throttle map 容量保护 — 已删 session 若没收到 deleted 事件会泄漏;超限删最早 20%。
      if (this.lastStatusBySession.size > SseBridge.STATUS_MAP_MAX) {
        const evictCount = Math.ceil(SseBridge.STATUS_MAP_MAX * 0.2);
        let removed = 0;
        for (const key of this.lastStatusBySession.keys()) {
          if (removed >= evictCount) break;
          this.lastStatusBySession.delete(key);
          removed++;
        }
      }
      this.broadcastSessionEvent('leader:status', data);
    });

    // 监听 conversation:message_saved 事件，将持久化的消息同步到 Web UI
    this.subscribe('conversation:message_saved', (data) => {
      // 只转发 assistant 消息（user 消息已在前端乐观插入）
      if (data.role === 'assistant') {
        // 把结构化 thinking blocks 拼成纯文本供前端展示；前端不需要 signature。
        const reasoningText = (data.thinking && data.thinking.length > 0)
          ? data.thinking
              .map((b: { type: string; text?: string }) => (b.type === 'thinking' ? b.text || '' : '[redacted]'))
              .filter(Boolean)
              .join('\n')
          : undefined;
        this.broadcastSessionEvent('conversation:message_saved', {
          ...data,
          reasoningContent: reasoningText,
        });
      }
    });

    // leader:error 非对称：把 error 对象规整为 message + errorKind 字符串（chat:user_message 已对称转发）。
    this.subscribe('leader:error', (data) => {
      const error = data.error as { llmErrorKind?: unknown; errorKind?: unknown; name?: unknown; message?: unknown } | undefined;
      this.broadcastSessionEvent('leader:error', {
        ...data,
        error: error?.message ? String(error.message) : String(data.error),
        errorKind: error?.llmErrorKind || error?.errorKind || error?.name,
      });
    });

    // P0-1 (2026-05-14): leader:round_complete 已在上面对称转发为 canonical 事件。
    // 该事件每次 leaderThinkAndAct() finally 都会触发，但 round 结束 ≠ 整体 idle —— Leader
    // 主循环可能立刻进入下一轮 thinkAndAct（agent 回报、driveOpenWork、连续用户输入），
    // 或 LlmGuard 正在重试。曾经的 status_change:'idle' 桥接已删除，会让 Web UI 误降级。
    // 真正的 idle 由 session:runtime_state / session:completed 表达。
    // 子审计文档：docs/audit/audit-22-sse-bridge.md

    // Workflow 事件已由上面的 WORKFLOW_REALTIME_EVENT_NAMES 循环统一转发。
    // Agent 文本/工具/状态/心跳等对称事件已由上面的 registerAgentForwarders 循环统一转发。

    // Agent 事件（非对称：leader 分流 / guard / transform / session 学习）
    this.subscribe('agent:tool_output', (data) => {
      // Leader 的 shell 输出 → 主对话 ToolCallCard 流式渲染
      if (data.agentId === 'leader') {
        const sessionId = data.sessionId as string;
        if (sessionId) {
          this.broadcastSessionEvent('leader:tool_output', { ...data, sessionId }, sessionId);
        }
        return;
      }
      // Worker 走原路径
      this.broadcastAgentSessionEvent('agent:tool_output', data.agentId, data.sessionId as string | undefined, data);
    });

    /**
     * 长工具心跳事件 — 让 30s+ 工具期间前端 UI 不至于完全静默。
     * Shell 已经走 agent:tool_output / agent:shell_state，不重复挂心跳。
     */
    this.subscribe('agent:tool_progress', (data) => {
      if (!data.agentId) return;
      this.broadcastAgentSessionEvent('agent:tool_progress', data.agentId, data.sessionId as string | undefined, data);
    });

    this.subscribe('agent:text', (data) => {
      this.broadcastAgentSessionEvent('agent:text', data.agentId, data.sessionId as string | undefined, {
        ...data,
        content: typeof data.content === 'string' ? data.content : JSON.stringify(data.content),
      });
    });

    this.subscribe('agent:spawned', (data) => {
      this.learnAgentSession(data?.agentId, data?.sessionId);
      this.broadcastAgentSessionEvent('agent:spawned', data.agentId, data.sessionId, data);
    });

    this.subscribe('agent:started', (data) => {
      this.learnAgentSession(data?.agentId, data?.sessionId);
      this.broadcastAgentSessionEvent('agent:started', data.agentId, data.sessionId, data);
    });

    this.subscribe('agent:completed', (data) => {
      this.broadcastAgentSessionEvent('agent:completed', data.agentId, data.sessionId, data);
      if (data?.agentId) this.scheduleAgentSessionCleanup(data.agentId);
    });

    this.subscribe('agent:terminated', (data) => {
      this.broadcastAgentSessionEvent('agent:terminated', data.agentId, data.sessionId, data);
      if (data?.agentId) this.scheduleAgentSessionCleanup(data.agentId);
    });

    this.subscribe('agent:failed', (data) => {
      this.broadcastAgentSessionEvent('agent:failed', data.agentId, data.sessionId, data);
      if (data?.agentId) this.scheduleAgentSessionCleanup(data.agentId);
    });

    // agent_intervention 仍被前端 TracesView 消费（labelKey + case），保留唯一桥接。
    this.subscribe('agent:intervention', (data) => {
      const sessionId = this.resolveAgentSessionId(data.agentId, data.sessionId);
      if (!sessionId) return;
      this.broadcastSessionEvent('agent:intervention', { ...data, sessionId }, sessionId);
    });

    // Artifact changes 由 FileChangesApi /api/v1/artifacts 快照拉取；当前没有生产路径 emit artifact:*，不保留假实时桥。
    // Permission / control_mode / goal / user input / plan / orchestration(node) /
    // blackboard / session:soul_extracted / session:renamed / leader:message_queued 等
    // 对称转发事件已由上面的 registerSessionForwarders 循环统一注册。

    // Orchestration 事件：统一编排内核的 Web/TUI 投影出口。
    // run_state 非对称（需 normalize status + 派生 busy）；其余 orchestration:* 对称转发。
    this.subscribe('orchestration:run_state', (data) => {
      const status = normalizeRunStatus(data.status);
      const busy = isRunActiveStatus(status);
      this.broadcastSessionEvent('orchestration:run_state', { ...data, status, busy });
    });

    // team 事件：非对称（sessionId 缺失即丢弃，不广播）。
    this.subscribe('team:message_sent', (data) => {
      if (!data.sessionId) return;
      this.broadcastSessionEvent('team:message_sent', data);
    });

    this.subscribe('team:message_read', (data) => {
      if (!data.sessionId) return;
      this.broadcastSessionEvent('team:message_read', data);
    });

    // Session 事件
    // session:soul_extracted / session:renamed 已对称转发；以下为注入 status 的终态事件。
    this.subscribe('session:interrupted', (data) => {
      this.lastStatusBySession.delete(data.sessionId);
      this.broadcastSessionEvent('session:interrupted', { ...data, status: 'interrupted' });
    });

    this.subscribe('session:completed', (data) => {
      this.broadcastSessionEvent('session:completed', { ...data, status: 'completed' });
    });

    // P0 死链修复：session:failed → 前端显示失败态
    this.subscribe('session:failed', (data) => {
      this.broadcastSessionEvent('session:failed', { ...data, status: 'failed' });
    });

    this.subscribe('session:deleted', (data) => {
      this.lastStatusBySession.delete(data.sessionId);
      for (const [agentId, sid] of this.agentSessionMap.entries()) {
        if (sid !== data.sessionId) continue;
        this.agentSessionMap.delete(agentId);
        const timer = this.agentSessionCleanupTimers.get(agentId);
        if (timer) clearTimeout(timer);
        this.agentSessionCleanupTimers.delete(agentId);
      }
    });

    this.subscribe('plugin:toggled', (data) => {
      if (!data.sessionId) return;
      this.broadcastSessionEvent('plugin:toggled', data);
    });

    // P0 死链修复：notification:new → 前端通知（ask_user / plan_approved 等）
    this.subscribe('notification:new', (data) => {
      const sid = data.sessionId ?? data.notification?.sessionId;
      if (!sid) return;
      this.broadcastSessionEvent('notification:new', { ...data, sessionId: sid }, sid);
    });

    // P0 死链修复：leader 消息出队 → 前端显示排队状态（leader:message_queued 已对称转发）。
    this.subscribe('leader:message_dequeued', (data) => {
      if (!data?.sessionId) return;
      this.broadcastSessionEvent('leader:message_dequeued', data);
    });

    // P0 死链修复：agent:error → 前端显示 Agent 错误
    this.subscribe('agent:error', (data) => {
      this.broadcastAgentSessionEvent('agent:error', data.agentId, data.sessionId, {
        ...data,
        agentId: data.agentId,
        error: data.error instanceof Error ? data.error.message : String(data.error),
      });
    });

    // Task 事件使用 TaskBoard 的 canonical payload: { task }, task.session_id。
    const broadcastTask = <T extends TaskBridgeEvent>(type: T, data: EventMap[T]) => {
      const dataRecord = asRecord(data);
      const taskRecord = asRecord(dataRecord.task);
      const sessionId = stringValue(taskRecord.session_id);
      if (!sessionId) return;
      this.broadcastSessionEvent(type, { ...dataRecord, task: taskRecord, sessionId }, sessionId);
    };
    this.subscribe('task:created', (data) => broadcastTask('task:created', data));
    this.subscribe('task:updated', (data) => broadcastTask('task:updated', data));
    this.subscribe('task:deleted', (data) => broadcastTask('task:deleted', data));
    this.subscribe('task:assigned', (data) => broadcastTask('task:assigned', data));
    this.subscribe('task:completed', (data) => broadcastTask('task:completed', data));
    this.subscribe('task:failed', (data) => broadcastTask('task:failed', data));
    this.subscribe('task:cancelled', (data) => broadcastTask('task:cancelled', data));
    this.subscribe('work_note:written', (data) => {
      if (!data.sessionId) return;
      this.broadcastSessionEvent('work_note:written', data);
    });

    // agent:heartbeat / agent:interactive_state / agent:crashed 已由上面的
    // registerAgentForwarders 循环统一转发。

    // orchestration:dag_updated：非对称（snapshot → dag 重命名）。
    this.subscribe('orchestration:dag_updated', (data) => {
      this.broadcastSessionEvent('orchestration:dag_updated', { ...data, dag: data.snapshot });
    });
    // run:explanation_updated 已对称转发。

    // Context 事件：context:compressed / context:overflow / session:runtime_state 已对称转发。
    // P1-6 (2026-05-14): leader:context_updated 事件源已删除。
    // 该链路被 ContextManager 的 context:runtime_updated 取代（覆盖更全：currentTokens / maxTokens / threshold / warningLevel），
    // 前端 sessionStore 只处理 context_runtime_updated。

    // 压缩「进行中」事件 — 让 Web UI 在长压缩期间显示进度，避免看起来卡死。
    this.subscribe('context:compacting', (data) => {
      if (!data.sessionId) return;
      this.broadcastSessionEvent('context:compacting', data);
    });

    // Context runtime 状态实时推送（currentTokens / threshold / warningLevel）
    this.subscribe('context:runtime_updated', (data) => {
      if (!data.sessionId) return;
      this.broadcastSessionEvent('context:runtime_updated', data);
    });

    // 低层 worker:* 事件不再桥接到 Web UI。
    // Web UI 已消费 agent:* / terminal:* 细粒度事件；统一 worker_event 没有前端 case，属于哑广播。

    this.subscribe('token:usage', (data) => {
      // token:usage 事件可能携带 sessionId（leader）或只有 agentId（worker）
      if (data.sessionId) {
        this.broadcastSessionEvent('token:usage', data, data.sessionId);
      } else {
        this.broadcastAgentSessionEvent('token:usage', data.agentId, data.sessionId as string | undefined, data);
      }
    });

    // Context 窗口使用率 — 每次 manage() 后推送
    this.subscribe('agent:context_updated', (data) => {
      this.broadcastAgentSessionEvent('agent:context_updated', data.agentId, data.sessionId as string | undefined, {
        ...data,
        agentId: data.agentId,
        contextTokens: data.tokens,
        contextMax: data.maxTokens,
      });
    });

    // terminal:output / terminal:state 已由上面的 registerAgentForwarders 循环统一转发
    // （sessionId 缺失时 broadcastAgentSessionEvent 也会通过 agentId 反查 session）。

    // Heartbeat: every 30s send ping to all clients
    // 同时检测并清理过期连接（5分钟无活动）
    // 每次从 connectionManager.getClients() 获取当前活跃列表，不闭包持有 client 对象
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;
    this.heartbeatInterval = setInterval(() => {
      if (this._destroyed || !this._started) return;    if (this.heartbeatInterval) this.heartbeatInterval.unref();
      const now = Date.now();
      const stats = this.connectionManager.getStats();
      for (const { sessionId } of stats.perSession) {
        const clients = this.connectionManager.getClients(sessionId);
        for (const client of clients) {
          // 检查是否过期
          if (now - client.lastActivity > STALE_THRESHOLD_MS) {
            console.log(`[SseBridge] 清理过期连接: ${client.connectionId} (session=${sessionId})`);
            this.connectionManager.removeClient(client.connectionId);
            continue;
          }

          // ping 复用 writeToClient 的背压/死流判定：半开/黑盒客户端的 ping 堆积进缓冲、
          // writableLength 超限即被移除；destroyed/writableEnded 或写抛错也立即移除。
          this.connectionManager.pingClient(client);
        }
      }
    }, 30_000);
    // unref：心跳不应阻止进程退出（优雅关闭/测试退出未显式 stop 也不挂住事件循环）
    this.heartbeatInterval.unref?.();

    // --- Wiki 事件（对称：type 即 wiki 事件名，sessionId 取自 payload） ---
    for (const name of WIKI_GENERATION_EVENTS) {
      this.subscribe(name, (data) => this.broadcastWikiUpdate(name, data.sessionId, data));
    }

    // --- 记忆维护（dream/distill）事件 ---
    // 后台维护是全局活动：daemon 触发时的 sessionId 未必等于浏览器当前会话，
    // 故广播到所有已连接会话，让任意打开的 Web 客户端都能看到浮层动画。
    // 对称：type 即 maintenance 事件名，data 原样传入。
    for (const name of MEMORY_MAINTENANCE_EVENTS) {
      this.subscribe(name, (data) => this.broadcastMemoryMaintenance(name, data));
    }
  }

  /**
   * 停止事件桥接
   */
  stop() {
    this._started = false;
    for (const unsub of this.unsubscribes) {
      try { unsub(); } catch { /* 个别 unsub 失败不影响其余清理 */ }
    }
    this.unsubscribes = [];
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    // 清理 agentSessionMap 延迟 timer，防止进程退出后回调泄漏
    for (const timer of this.agentSessionCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.agentSessionCleanupTimers.clear();
    this.agentSessionMap.clear();
    this.lastStatusBySession.clear();
  }

  /**
   * 最终销毁：stop() + 标记实例不可用，阻止残余异步回调继续操作。
   * 用于进程退出 / 测试 teardown 等场景，确保不留任何引用。
   */
  destroy() {
    this.stop();
    this._destroyed = true;
  }

  /**
   * 学习 agentId → sessionId 映射；spawn/started 时调用。
   * 同时取消该 agentId 待执行的延迟清理 timer（重生 / 二次绑定场景）。
   * 当 Map 超过容量上限时，批量淘汰最旧条目（FIFO，Map 迭代顺序即插入顺序）。
   */
  private learnAgentSession(agentId: string | undefined, sessionId: string | undefined): void {
    if (!agentId || !sessionId) return;
    this.agentSessionMap.set(agentId, sessionId);
    const pending = this.agentSessionCleanupTimers.get(agentId);
    if (pending) {
      clearTimeout(pending);
      this.agentSessionCleanupTimers.delete(agentId);
    }
    // 容量保护：超限时删除最早 20% 条目
    if (this.agentSessionMap.size > SseBridge.AGENT_SESSION_MAP_MAX) {
      const evictCount = Math.ceil(SseBridge.AGENT_SESSION_MAP_MAX * 0.2);
      let removed = 0;
      for (const key of this.agentSessionMap.keys()) {
        if (removed >= evictCount) break;
        this.agentSessionMap.delete(key);
        const t = this.agentSessionCleanupTimers.get(key);
        if (t) { clearTimeout(t); this.agentSessionCleanupTimers.delete(key); }
        removed++;
      }
    }
  }

  /**
   * 安排 60s 后清理 agentSessionMap[agentId]，给晚到的 agent_text/tool_result
   * 留出解析窗口。重复调用同一 agentId 会重置定时器（取最新一次终态）。
   */
  private scheduleAgentSessionCleanup(agentId: string | undefined): void {
    if (!agentId) return;
    const existing = this.agentSessionCleanupTimers.get(agentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      try {
        this.agentSessionMap.delete(agentId);
      } catch { /* ignore */ }
      // timer 执行完毕，从 timers Map 中移除自身，防止累积
      this.agentSessionCleanupTimers.delete(agentId);
    }, SseBridge.AGENT_SESSION_CLEANUP_MS);
    // 不阻塞进程退出
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    this.agentSessionCleanupTimers.set(agentId, timer);
  }

  /**
   * 批量注册「对称转发」事件：subscribe(event) → broadcastSessionEvent(event, data)。
   * 泛型逐元素推导保留 EventMap[T] 类型安全（typo / 未知事件名编译期报错）。
   * 约束 EventType & EventName：同时是 canonical EventType（满足广播方法签名）
   * 与 EventMap 键（满足 subscribe 类型安全）。
   */
  private registerSessionForwarders<E extends EventType & EventName>(events: readonly E[]) {
    for (const event of events) {
      this.subscribe(event, (data) => this.broadcastSessionEvent(event, data));
    }
  }

  /**
   * 批量注册「agent 对称转发」事件：subscribe(event) →
   * broadcastAgentSessionEvent(event, agentId, sessionIdHint, data)。
   * sessionId 缺失时由 broadcastAgentSessionEvent 经 agentSessionMap 兜底。
   */
  private registerAgentForwarders<E extends EventType & EventName>(events: readonly E[]) {
    for (const event of events) {
      this.subscribe(event, (data) => {
        const record = asRecord(data);
        this.broadcastAgentSessionEvent(
          event,
          record.agentId as string | undefined,
          record.sessionId as string | undefined,
          data,
        );
      });
    }
  }

  /**
   * 订阅 emitter 事件，收集取消函数。
   * 所有 handler 通过 setImmediate 延迟执行，避免同步 I/O（raw.write）阻塞事件循环，
   * 确保 LLM 流式 pipeline 的 token 处理不受 SSE 广播影响。
   * 延迟回调内检查 _destroyed 标记，防止 stop/destroy 后残余回调继续操作。
   */
  private subscribe<T extends EventName>(event: T, handler: (data: EventMap[T]) => void) {
    const asyncHandler = (data: EventMap[T]) => {
      setImmediate(() => {
        if (this._destroyed || !this._started) return;
        handler(data);
      });
    };
    const unsub = this.emitter.subscribe(event, asyncHandler);
    this.unsubscribes.push(unsub);
  }

  /**
   * 向指定 session 广播
   */
  private broadcast(sessionId: string, event: Record<string, unknown>) {
    this.connectionManager.broadcastToSession(sessionId, event);
  }

  private broadcastSessionEvent<T extends EventType>(
    type: T,
    payload: unknown,
    sessionIdHint = '',
    options: EventEnvelopeOptions = {},
  ): void {
    const wrapped = eventPayloadToSessionUpdateMessage(type, payload, sessionIdHint, {
      source: 'sse-bridge',
      ...options,
    });
    if (!wrapped) return;
    this.broadcast(wrapped.envelope.sessionId, wrapped.message as unknown as Record<string, unknown>);
  }

  private broadcastAgentSessionEvent<T extends EventType>(
    type: T,
    agentId: string | undefined,
    sessionIdHint: string | undefined,
    payload: unknown,
    options: EventEnvelopeOptions = {},
  ): void {
    const resolvedSessionId = this.resolveAgentSessionId(agentId, sessionIdHint);
    if (resolvedSessionId) {
      if (agentId && agentId !== 'leader') this.agentSessionMap.set(agentId, resolvedSessionId);
      this.broadcastSessionEvent(type, { ...asRecord(payload), sessionId: resolvedSessionId }, resolvedSessionId, options);
      return;
    }
    if (agentId === 'leader') {
      const stats = this.connectionManager.getStats();
      for (const { sessionId } of stats.perSession) {
        this.broadcastSessionEvent(type, { ...asRecord(payload), sessionId }, sessionId, options);
      }
      return;
    }
    this.warnMissingAgentSession(agentId);
  }

  private broadcastCanonicalEvent<T extends EventType>(
    type: T,
    payload: unknown,
    sessionIdHint = '',
    options: EventEnvelopeOptions = {},
  ): void {
    const envelope = eventPayloadToEnvelope(type, payload, sessionIdHint, {
      source: 'sse-bridge',
      method: type,
      ...options,
    });
    if (!envelope.sessionId) return;
    const event = { method: type, params: { update: envelope } };
    this.broadcast(envelope.sessionId, event);
  }

  private broadcastWorkflowRealtimeEvent(type: WorkflowRealtimeEventType, payload: unknown): void {
    const data = asRecord(payload);
    const sessionId = stringValue(data.sessionId);
	    if (sessionId) {
	      this.broadcastCanonicalEvent(type, { ...data, sessionId }, sessionId);
	      return;
	    }
	  }

  private warnMissingAgentSession(agentId: string | undefined): void {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[SseBridge] 事件缺失 sessionId（agentId=${agentId ?? 'unknown'}），上游 emitter 应补字段`);
    }
  }

  private resolveAgentSessionId(agentId: string | undefined, sessionIdHint: string | undefined): string | undefined {
    if (sessionIdHint) return sessionIdHint;
    return agentId ? this.agentSessionMap.get(agentId) : undefined;
  }

  private broadcastWikiUpdate(type: WikiGenerationEventType, sessionIdHint: string | undefined, params: Record<string, unknown>) {
    const sessionId = stringValue(sessionIdHint);
    const { sessionId: _ignoredSessionId, ...baseParams } = params;
    const payload = sessionId ? { ...baseParams, sessionId } : baseParams;
    this.broadcastCanonicalEvent(type, payload, sessionId);
  }

  /**
   * 记忆维护事件广播到所有已连接会话。后台 dream/distill 是全局活动，
   * 不绑定单一会话；逐会话 broadcastCanonicalEvent 复用既有 envelope 路径。
   */
  private broadcastMemoryMaintenance(type: MemoryMaintenanceEventType, params: Record<string, unknown>) {
    const { sessionId: _ignored, ...baseParams } = params;
    const stats = this.connectionManager.getStats();
    for (const { sessionId } of stats.perSession) {
      this.broadcastCanonicalEvent(type, { ...baseParams, sessionId }, sessionId);
    }
  }
}
