/**
 * ToolFailureLoopGuard — 工具调用连续失败熔断器
 *
 * 解决问题：当前 LLM Agent 在 toolName + args 完全相同的调用上反复失败时（尤其是
 * permission / mode / write_scope / sandbox / network / schema 这类「状态类」错误），
 * 会陷入"工具报失败 → LLM 读到错误 → 重试同一调用 → 工具再次同样失败"的死循环，
 * 持续消耗 token 与 round budget。旧 ToolLoopDetector 仅检测"同 toolName + 相同 arguments
 * 的循环调用"（成功也会计入），不区分错误类型，无法识别"持续失败但 LLM 不断重试"场景。
 *
 * 本类定位：
 *   - key = `${toolName}::${argsHash}::${errorSignature}` 三元组
 *   - errorSignature = `${errorKind}:${errorCode}`，errorKind ∈ permission/mode/write_scope/
 *     sandbox/network/schema/other，由 ToolErrorEnvelope.code 推导
 *   - 默认 threshold=3：同一 key 累计失败 3 次时触发熔断
 *   - 熔断动作：emit('agent:tool_failure_loop', ...) + 返回 LoopGuardDecision { tripped, ... }
 *     调用方（BaseAgentRuntime）据此跳过 LLM 自循环：拒绝再次重试同一调用，转去 escalate_to_leader
 *     或 requestPermissionFromLeader
 *   - 状态类错误可枚举集合（PERMISSION/MODE/WRITE_SCOPE/SANDBOX/NETWORK/SCHEMA）即使
 *     retryable=true 也会被计数 —— 这些错误继续重试没有意义
 *
 * 用法：
 *   const guard = new ToolFailureLoopGuard({ threshold: 3, emitter });
 *   const decision = guard.record(toolName, args, errorCode, errorMessage);
 *   if (decision.tripped) { return escalateToLeader(decision); }
 *
 * 设计取舍：
 *   - 不持久化到 db（in-memory only），agent 进程重启即清空；避免 state 漂移
 *   - 不绑定具体 tool 实现（ToolResult 来源 Registry.execute / executeToolCall 都可）
 *   - argsHash 用 stableJson（与 ToolLoopDetector 一致），保证 {a:1,b:2}≡{b:2,a:1}
 *   - 触发后保留 1 分钟上下文（trippedKeys）防止同 key 快速重复熔断刷屏
 *   - 支持 session 维度隔离：跨 session 不串数据
 */

import { createHash } from 'node:crypto';
import type { EventEmitter } from '../../core/EventEmitter.js';

// ─── 类型定义 ────────────────────────────────────────

/** 错误大类，用于归一化 argsHash+errorSignature 的第三段。 */
export type ToolFailureErrorKind =
  | 'permission'
  | 'mode'
  | 'write_scope'
  | 'sandbox'
  | 'network'
  | 'schema'
  | 'precondition'
  | 'execution'
  | 'timeout'
  | 'aborted'
  | 'other';

/**
 * ToolErrorEnvelope.code / 自定义错误前缀 → errorKind 的映射。
 * 只识别可枚举的状态类错误；其他归到 other（仍会计入失败，但不优先熔断）。
 */
const ERROR_KIND_PATTERNS: Array<{ kind: ToolFailureErrorKind; pattern: RegExp }> = [
  { kind: 'permission', pattern: /PERMISSION_REQUIRED|PERMISSION_DENIED|TOOL_SCOPE_FORBIDDEN|permission_required/i },
  { kind: 'mode', pattern: /MODE_TOOL_FORBIDDEN|MODE_FORBIDDEN|TOOL_MODE_MISMATCH|mode_forbidden/i },
  { kind: 'write_scope', pattern: /WRITE_SCOPE_FORBIDDEN|WRITE_OUT_OF_SCOPE|SCOPE_FORBIDDEN|write_scope/i },
  { kind: 'sandbox', pattern: /SANDBOX_FORBIDDEN|SANDBOX_BLOCKED|sandbox/i },
  { kind: 'network', pattern: /NETWORK_FORBIDDEN|NETWORK_BLOCKED|NETWORK_UNREACHABLE|network/i },
  { kind: 'precondition', pattern: /FILE_MUST_BE_READ_FIRST|READ_FIRST|file_must_read_first/i },
  { kind: 'schema', pattern: /TOOL_ARGUMENT_PARSE_FAILED|TOOL_ARGUMENT_VALIDATION_FAILED|TOOL_NOT_FOUND|SCHEMA_INVALID|argument_validation/i },
  { kind: 'timeout', pattern: /TOOL_TIMEOUT|TIMEOUT/i },
  { kind: 'aborted', pattern: /TOOL_ABORTED|ABORTED|AbortError/i },
];

/**
 * 哪些 errorKind 属于"状态类错误"（继续重试无意义，必须升级）。
 * 状态类错误到达阈值时，强制 trip 并由 BaseAgentRuntime 走 escalate 路径。
 * precondition/execution/timeout/aborted/other 不强制升级（可能可按工具提示修复或因临时抖动重试有效）。
 */
export const STATE_ERROR_KINDS: ReadonlySet<ToolFailureErrorKind> = new Set([
  'permission',
  'mode',
  'write_scope',
  'sandbox',
  'network',
  'schema',
]);

/**
 * 带明确 next_tool/fix 的前置条件错误不应触发 TOOL_FAILURE_LOOP_TRIPPED。
 * 例如 structured_patch 的 FILE_MUST_BE_READ_FIRST：正确下一步是先 file_read，
 * 若熔断器把它替换成不可恢复错误，LLM 反而看不到原始修复指引。
 */
const NON_TRIPPING_ERROR_KINDS: ReadonlySet<ToolFailureErrorKind> = new Set([
  'precondition',
]);

export interface ToolFailureLoopGuardOptions {
  /** 同一 key 连续失败次数阈值；默认 3。 */
  threshold?: number;
  /** trip 后保留记忆时长（ms），防止快速重试再次触发；默认 60_000。 */
  trippedRetentionMs?: number;
  /** 单 session 最多跟踪多少个 key；超过时淘汰最旧；默认 256。 */
  maxKeysPerSession?: number;
}

export interface ToolFailureSignature {
  toolName: string;
  argsHash: string;
  errorKind: ToolFailureErrorKind;
  errorCode: string;
}

export interface ToolFailureRecord extends ToolFailureSignature {
  count: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  /** 最近一次 error 原始 message（用于上报时给 Leader / Health 看的可读摘要） */
  lastErrorMessage: string;
  tripped: boolean;
  trippedAtMs: number;
}

export interface ToolFailureLoopEvent {
  sessionId: string;
  agentId: string;
  agentName: string;
  taskId?: string;
  signature: ToolFailureSignature;
  count: number;
  threshold: number;
  /** 是否在 STATE_ERROR_KINDS 集合内（必须升级）。 */
  requiresEscalation: boolean;
  lastErrorMessage: string;
  timestamp: number;
}

export interface LoopGuardDecision {
  /** 当前 key 是否达到阈值。 */
  tripped: boolean;
  /** 当前累计次数（tripped=true 时为 threshold 之后的下一个数）。 */
  count: number;
  /** 错误大类。 */
  errorKind: ToolFailureErrorKind;
  /** 当前 key 的归一化签名。 */
  signature: ToolFailureSignature;
  /** 是否在 STATE_ERROR_KINDS 集合内（true 时调用方必须走 escalate，不允许 LLM 自循环）。 */
  requiresEscalation: boolean;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_TRIPPED_RETENTION_MS = 60_000;
const DEFAULT_MAX_KEYS = 256;

// ─── 工具函数 ────────────────────────────────────────

/** 把任意 JSON 值序列化为稳定字符串（递归排序对象 key）；与 ToolLoopDetector.stableJson 对齐。 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .map((k) => JSON.stringify(k) + ':' + stableJson(obj[k]))
    .join(',');
  return '{' + body + '}';
}

/** 对 args 做 SHA-1 截断 hash；用 SHA-1 仅做指纹（不需要加密强度，比 stableJson 字符串拼接更省内存）。 */
function hashArgs(args: unknown): string {
  const raw = typeof args === 'string' ? args : stableJson(args);
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/** 把 args（string | object | null）规整成用于 hash 的形态。 */
function normalizeArgsForHash(args: unknown): unknown {
  if (typeof args === 'string') {
    if (args.length === 0) return {};
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args ?? {};
}

/** 从 errorCode + errorMessage 推导 errorKind。 */
export function classifyToolFailure(errorCode: string, errorMessage: string): ToolFailureErrorKind {
  const combined = `${errorCode || ''} ${errorMessage || ''}`.trim();
  if (!combined) return 'other';
  for (const { kind, pattern } of ERROR_KIND_PATTERNS) {
    if (pattern.test(combined)) return kind;
  }
  return 'other';
}

// ─── 核心类 ──────────────────────────────────────────

/**
 * ToolFailureLoopGuard — 跨 session 独立的失败熔断器。
 *
 * 每个 sessionId 维护独立的 Map<key, ToolFailureRecord>，避免跨 session 串数据。
 * 触发熔断时通过 emitter 广播 `agent:tool_failure_loop` 事件，
 * BaseAgentRuntime / AgentHealthMonitor / LeaderPermissionManager 各自订阅并按职责响应。
 */
export class ToolFailureLoopGuard {
  private readonly threshold: number;
  private readonly trippedRetentionMs: number;
  private readonly maxKeysPerSession: number;

  /** sessionId → (key → record) */
  private readonly states = new Map<string, Map<string, ToolFailureRecord>>();
  /** sessionId → 最近一次触发时间（仅作 debug / 测试观测用） */
  private readonly lastTrippedAt = new Map<string, number>();

  constructor(
    private readonly options: ToolFailureLoopGuardOptions = {},
    private emitter?: EventEmitter,
  ) {
    this.threshold = Math.max(2, options.threshold ?? DEFAULT_THRESHOLD);
    this.trippedRetentionMs = options.trippedRetentionMs ?? DEFAULT_TRIPPED_RETENTION_MS;
    this.maxKeysPerSession = Math.max(16, options.maxKeysPerSession ?? DEFAULT_MAX_KEYS);
  }

  /**
   * 进程级惰性单例允许之后再注入 emitter。用 setter 不用下标访问，避开 TS 严格检查
   * （emitter 在 constructor 是 optional，且 TS 不允许下标访问 readonly 字段）。
   * 多次调用以最后一次为准。
   */
  setEmitter(emitter: EventEmitter | undefined): void {
    this.emitter = emitter;
  }

  /**
   * 记录一次工具失败并返回决策。
   *
   * 调用方应在以下场景调用：
   *   1. Registry.execute 返回 success=false
   *   2. BaseAgentRuntime.executeToolCall 看到工具失败
   *   3. 任何 LLM 自循环路径上的失败点
   *
   * 若 decision.tripped 为 true，调用方应停止对该 toolCall 的本地重试，
   * 改走 escalate 路径（escalate_to_leader / requestPermissionFromLeader）。
   */
  record(
    input: {
      sessionId: string;
      agentId: string;
      agentName: string;
      taskId?: string;
      toolName: string;
      args: unknown;
      errorCode: string;
      errorMessage: string;
    },
  ): LoopGuardDecision {
    const sessionId = input.sessionId || '<unknown>';
    const errorKind = classifyToolFailure(input.errorCode, input.errorMessage);
    const argsHash = hashArgs(normalizeArgsForHash(input.args));
    const key = `${input.toolName}::${argsHash}::${errorKind}`;
    const now = Date.now();

    const sessionMap = this.getOrCreateSessionMap(sessionId);
    let record = sessionMap.get(key);
    if (!record) {
      // 容量保护：超过 maxKeysPerSession 时淘汰最旧
      if (sessionMap.size >= this.maxKeysPerSession) {
        this.evictOldest(sessionMap);
      }
      record = {
        toolName: input.toolName,
        argsHash,
        errorKind,
        errorCode: input.errorCode || '',
        count: 0,
        firstSeenAtMs: now,
        lastSeenAtMs: now,
        lastErrorMessage: input.errorMessage || '',
        tripped: false,
        trippedAtMs: 0,
      };
      sessionMap.set(key, record);
    }

    // 已被熔断：刷新 lastSeenAtMs / lastErrorMessage，但不再累计 count
    // —— 防止熔断后 LLM 仍不断发同 key 调用导致计数爆炸。
    if (record.tripped) {
      record.lastSeenAtMs = now;
      record.lastErrorMessage = input.errorMessage || record.lastErrorMessage;
      return {
        tripped: true,
        count: record.count,
        errorKind,
        signature: {
          toolName: record.toolName,
          argsHash: record.argsHash,
          errorKind: record.errorKind,
          errorCode: record.errorCode,
        },
        requiresEscalation: STATE_ERROR_KINDS.has(errorKind),
      };
    }

    record.count += 1;
    record.lastSeenAtMs = now;
    record.lastErrorMessage = input.errorMessage || record.lastErrorMessage;

    const canTrip = !NON_TRIPPING_ERROR_KINDS.has(errorKind);
    const tripped = canTrip && record.count >= this.threshold;
    if (tripped) {
      record.tripped = true;
      record.trippedAtMs = now;
      this.lastTrippedAt.set(sessionId, now);
      this.emitTripped(sessionId, input, record);
    }

    return {
      tripped,
      count: record.count,
      errorKind,
      signature: {
        toolName: record.toolName,
        argsHash: record.argsHash,
        errorKind: record.errorKind,
        errorCode: record.errorCode,
      },
      requiresEscalation: STATE_ERROR_KINDS.has(errorKind),
    };
  }

  /**
   * 工具调用成功时调用，清除同 (toolName, argsHash) 下所有 errorKind 的失败记录。
   * 防止"成功后下次又因不同 errorKind 失败"被错误归并。
   */
  clearOnSuccess(sessionId: string, toolName: string, args: unknown): void {
    const sessionMap = this.states.get(sessionId);
    if (!sessionMap) return;
    const argsHash = hashArgs(normalizeArgsForHash(args));
    for (const [key, record] of sessionMap.entries()) {
      if (record.toolName === toolName && record.argsHash === argsHash) {
        sessionMap.delete(key);
      }
    }
  }

  /** 清空某 session 的所有失败记录（agent terminated / session 结束时调用）。 */
  resetSession(sessionId: string): void {
    this.states.delete(sessionId);
    this.lastTrippedAt.delete(sessionId);
  }

  /** 测试 / 观测用：返回某 session 当前的失败记录快照。 */
  snapshot(sessionId: string): ToolFailureRecord[] {
    const sessionMap = this.states.get(sessionId);
    if (!sessionMap) return [];
    return Array.from(sessionMap.values()).map((r) => ({ ...r }));
  }

  /** 测试 / 观测用：返回某 session 触发的熔断 key 数量。 */
  countTripped(sessionId: string): number {
    const sessionMap = this.states.get(sessionId);
    if (!sessionMap) return 0;
    let count = 0;
    for (const r of sessionMap.values()) {
      if (r.tripped) count += 1;
    }
    return count;
  }

  // ─── 内部辅助 ──────────────────────────────────────

  private getOrCreateSessionMap(sessionId: string): Map<string, ToolFailureRecord> {
    let m = this.states.get(sessionId);
    if (!m) {
      m = new Map();
      this.states.set(sessionId, m);
    }
    return m;
  }

  private evictOldest(sessionMap: Map<string, ToolFailureRecord>): void {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, record] of sessionMap.entries()) {
      if (record.lastSeenAtMs < oldestTs) {
        oldestTs = record.lastSeenAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      sessionMap.delete(oldestKey);
    }
  }

  private emitTripped(
    sessionId: string,
    input: {
      agentId: string;
      agentName: string;
      taskId?: string;
    },
    record: ToolFailureRecord,
  ): void {
    if (!this.emitter) return;
    const event: ToolFailureLoopEvent = {
      sessionId,
      agentId: input.agentId,
      agentName: input.agentName,
      taskId: input.taskId,
      signature: {
        toolName: record.toolName,
        argsHash: record.argsHash,
        errorKind: record.errorKind,
        errorCode: record.errorCode,
      },
      count: record.count,
      threshold: this.threshold,
      requiresEscalation: STATE_ERROR_KINDS.has(record.errorKind),
      lastErrorMessage: record.lastErrorMessage,
      timestamp: Date.now(),
    };
    try {
      this.emitter.emit('agent:tool_failure_loop', event);
    } catch {
      // emitter 异常不应阻止熔断主流程
    }
  }
}

// ─── 进程级单例 + 工厂 ──────────────────────────────

/**
 * 进程级单例（惰性创建）。BaseAgentRuntime / Registry.execute / AgentHealthMonitor
 * 任何位置都可调用 `getToolFailureLoopGuard(emitter)` 拿到同一实例，保证跨模块共享失败计数。
 *
 * 设计依据：tool failure loop 是"agent 全局"维度，不应每个 caller 各持一份 state。
 */
let _globalGuard: ToolFailureLoopGuard | null = null;

export function getToolFailureLoopGuard(emitter?: EventEmitter): ToolFailureLoopGuard {
  if (!_globalGuard) {
    _globalGuard = new ToolFailureLoopGuard({}, emitter);
  } else if (emitter) {
    _globalGuard.setEmitter(emitter);
  }
  return _globalGuard;
}

/** 测试 / 进程退出时调用，重置全局单例。 */
export function resetToolFailureLoopGuard(): void {
  _globalGuard = null;
}
