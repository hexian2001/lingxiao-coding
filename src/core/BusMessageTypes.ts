/**
 * BusMessage 判别联合 — 广播消息的完全结构化类型层。
 *
 * 取代旧的 `{ type: string; payload: unknown }`:
 *  - `type` 是字符串字面量联合(单一事实源),typo(如 'task_complte')编译期直接报错。
 *  - `payload` 按 type 精确收窄:发送 `send(..., 'task_complete', x)` 时 x 必须是 TaskCompletePayload;
 *    消费 `switch(message.type)` 后 payload 自动 narrow,消灭散落的 `as` 转型。
 *
 * 设计权衡:
 *  - 6 个控制类 payload 复用 AgentProtocol.ts 已有 interface(单一事实源)。
 *  - `message`/`user_intervention` 的 payload 真正多态(string | MessageContent | 对象 | team 协议),
 *    用显式联合诚实建模,消费侧 typeof/in narrow —— 比 unknown 严格得多。
 *  - `parseBusMessage` 是反序列化守卫(transport/IPC 逃逸口用),只校验 type 字面量合法 + 信封字段;
 *    payload 形状 best-effort(多态 type 无法在守卫里强校验)。
 *
 * 注意:不要用 `Pick<BusMessage,'type'|'payload'>` 作函数入参 —— 会把判别联合拍扁成宽联合,丢失 narrow。
 * 消费侧请传完整 `BusMessage`。
 */

import type {
  TaskCompletePayload,
  TaskFailedPayload,
  PermissionRequestControlPayload,
  PermissionResponsePayload,
  AgentHealthCriticalPayload,
  WorkerRecoveryPayload,
} from './AgentProtocol.js';
import type { TeamProtocolMessage } from './TeamProtocol.js';
import type { MessageContent } from '../contracts/types/Message.js';
import type { RemoteWorkerDescriptor } from './transport/RemoteWorkerRegistry.js';

// ── 1. type 字面量联合(穷举真实生产发送点) ─────────────────────────
export type BusMessageType =
  | 'task_complete'
  | 'task_failed'
  | 'worker_recovery'
  | 'permission_request'
  | 'permission_response'
  | 'agent_health_critical'
  | 'user_intervention'
  | 'message'
  | 'force_terminate'
  | 'intervene'
  | 'control'
  | 'system_context'
  | 'supervision_probe'
  | 'request_work_note'
  | 'eternal_goal_set'
  | 'worker_register';

// ── 2. 多态 payload 的显式联合(诚实建模,非 unknown) ────────────────
/** `message` type 的 payload:自由文本 / 富文本 / 会话定向消息 / team 协议封装。 */
export type MessagePayload =
  | string
  | MessageContent
  | { sessionId: string; content: string }
  | { _protocol: 'team'; message: TeamProtocolMessage };

/** `user_intervention` type 的 payload:自由文本 / 富文本 / 系统通知封装。 */
export type UserInterventionPayload =
  | string
  | MessageContent
  | { _system_notice: true; kind: 'task:failed' | 'task:cancelled'; taskId: string; content: string };

// ── 3. 单一形状 payload(补齐 AgentProtocol 未覆盖的 type) ───────────
export interface ForceTerminatePayload {
  reason: string;
  taskId: string;
}
export interface IntervenePayload {
  sessionId: string;
  content: string;
  instruction?: string;
}
export interface ControlPayload {
  action: 'nudge' | 'redirect' | 'retry_llm' | 'swap_model' | 'compact_context';
  reason?: string;
  message?: string;
  model?: string;
  newModel?: string;
}
export interface SupervisionProbePayload {
  kind: 'agent_health_report';
  source: string;
  timestamp: number;
  decisions: unknown[];
}
export interface RequestWorkNotePayload {
  sessionId: string;
  requesterAgentId: string;
}
export interface EternalGoalSetPayload {
  goal: string;
}

// ── 4. type → payload 映射(单一事实源) ─────────────────────────────
export interface BusMessagePayloadMap {
  task_complete: TaskCompletePayload;
  task_failed: TaskFailedPayload;
  worker_recovery: WorkerRecoveryPayload;
  permission_request: PermissionRequestControlPayload;
  permission_response: PermissionResponsePayload;
  agent_health_critical: AgentHealthCriticalPayload;
  user_intervention: UserInterventionPayload;
  message: MessagePayload;
  force_terminate: ForceTerminatePayload;
  intervene: IntervenePayload;
  control: ControlPayload;
  system_context: string;
  supervision_probe: SupervisionProbePayload;
  request_work_note: RequestWorkNotePayload;
  eternal_goal_set: EternalGoalSetPayload;
  worker_register: RemoteWorkerDescriptor;
}

// ── 5. 信封字段(非判别部分) ─────────────────────────────────────────
export interface BusMessageEnvelope {
  id: string;
  from: string;
  to: string;
  timestamp: number;
  seq?: number;
  traceId?: string;
  parentSpanId?: string;
}

// ── 6. 判别联合 BusMessage(mapped + indexed,见陷阱 c) ──────────────
export type BusMessage = BusMessageEnvelope & {
  [K in BusMessageType]: { type: K; payload: BusMessagePayloadMap[K] };
}[BusMessageType];

// ── 7. 反序列化守卫(堵 transport/IPC 逃逸口) ───────────────────────
const BUS_MESSAGE_TYPES: ReadonlySet<string> = new Set<BusMessageType>([
  'task_complete', 'task_failed', 'worker_recovery', 'permission_request',
  'permission_response', 'agent_health_critical', 'user_intervention', 'message',
  'force_terminate', 'intervene', 'control', 'system_context', 'supervision_probe',
  'request_work_note', 'eternal_goal_set', 'worker_register',
]);

export function isBusMessageType(type: unknown): type is BusMessageType {
  return typeof type === 'string' && BUS_MESSAGE_TYPES.has(type);
}

/**
 * 从未知来源(transport/IPC 跨进程)解析 BusMessage。
 * 校验:type ∈ 已知集合 + 信封字段齐全。payload 形状 best-effort(多态 type 不强校验)。
 * 不合法返回 null(调用方丢弃),合法返回窄化为 BusMessage 的对象。
 */
export function parseBusMessage(raw: unknown): BusMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.id !== 'string' ||
    typeof m.from !== 'string' ||
    typeof m.to !== 'string' ||
    typeof m.type !== 'string' ||
    !Object.prototype.hasOwnProperty.call(m, 'payload') ||
    typeof m.timestamp !== 'number' ||
    !BUS_MESSAGE_TYPES.has(m.type)
  ) {
    return null;
  }
  return { ...m } as unknown as BusMessage;
}
