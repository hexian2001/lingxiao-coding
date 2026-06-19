/**
 * ModeAudit — 三模式审计的统一出口 + per-mode metrics sink。
 *
 * 历史上三类模式事件各自走独立通道：
 *   - office：Registry.execute 调 auditOfficeToolExecution → jsonl 落盘
 *   - bughunt：appendBughuntEvent → ledger.events[]
 *   - workflow：WorkflowEngine.emitEvent → 订阅者 + DB execution 表
 *
 * 三者没有统一的事件 schema，也没有共享的可观测出口。本模块提供：
 *   1. 统一的 ModeAuditEvent 判别联合（per kind 收窄 payload）；
 *   2. auditModeEvent(mode, event) 单一入口，落各自既有通道 + 写统一 metrics sink；
 *   3. 复用 MetricsRegistry（lingxiao_mode_*_total）做 per-mode 调用/拦截/耗时计数。
 *
 * 本模块**不接管**各模式既有的数据落盘（jsonl/ledger/DB），只在其之上加一层统一
 * 抽象与可观测桥接——避免一次性大重构破坏既有审计与回归。各通道的底层写函数仍由
 * 调用方持有，auditModeEvent 只做「分发 + metrics」。
 *
 * 确定性：metrics 只记录结构化 label（mode/kind/outcome/tool），无启发式、无采样推断。
 */

import type { ModeId } from '../contracts/modes.js';
import { metrics } from './MetricsRegistry.js';

/** office 工具调用审计事件。 */
export interface OfficeToolAuditEvent {
  kind: 'office_tool_call';
  tool: string;
  success: boolean;
  /** redact 后的 args 摘要（由调用方经 summarizeOfficeArgs 产出）。 */
  argsSummary?: unknown;
}

/** bughunt ledger 事件（finding/scan/evidence）。 */
export interface BughuntLedgerAuditEvent {
  kind: 'bughunt_ledger_event';
  /** 事件类型（worker_result/scan_result/finding_note/status_change...）。 */
  bughuntKind: string;
  findingIds?: readonly string[];
}

/** workflow 执行生命周期事件。 */
export interface WorkflowExecutionAuditEvent {
  kind: 'workflow_execution';
  /** completed/failed/cancelled/paused/resumed。 */
  outcome: string;
  executionId: string;
  /** 毫秒；可空。 */
  durationMs?: number;
}

/** fail-closed 拦截事件（模式未启用却被调用，被 mode_forbidden 挡下）。 */
export interface ModeGateBlockEvent {
  kind: 'mode_gate_blocked';
  /** 被拦截的工具名。 */
  tool: string;
  /** 拦截原因码（WORKFLOW_MODE_REQUIRED / OFFICE_MODE_REQUIRED / BUGHUNT_MODE_REQUIRED）。 */
  reason: string;
  /** 调用方角色（leader/worker/team_member/workflow_node...）。 */
  actor: string;
}

export type ModeAuditEvent =
  | OfficeToolAuditEvent
  | BughuntLedgerAuditEvent
  | WorkflowExecutionAuditEvent
  | ModeGateBlockEvent;

const MODE_COUNTER_NAMES: Record<ModeId, string> = {
  bughunt: 'lingxiao_mode_bughunt_total',
  office: 'lingxiao_mode_office_total',
  workflow: 'lingxiao_mode_workflow_total',
};

/** fail-closed 拦截计数（跨模式，按 mode/tool 分 label）。 */
const modeGateBlockedTotal = metrics.counter(
  'lingxiao_mode_gate_blocked_total',
  '会话级模式未启用时，工具调用被 mode_forbidden 拦截的次数',
);

/**
 * 读取某 (mode, tool) 组合的累计拦截次数——确定性、结构化。
 *
 * 用于反馈点（N5）：例如 bughunt 模式未启用却反复有 set_bughunt_dag 调用，
 * 累计拦截数即「反复尝试」的真实信号源。不做基于 confidence 的推断，只暴露计数，
 * 由上层（runtime projection / prompt）决定如何提示。
 */
export function getModeGateBlockCount(mode: ModeId, tool: string): number {
  let total = 0;
  try {
    for (const sample of modeGateBlockedTotal.getValues()) {
      if (sample.labels.mode === mode && sample.labels.tool === tool) {
        total += sample.value;
      }
    }
  } catch {
    // 读取失败返回 0。
  }
  return total;
}

/** 反馈阈值：同一 (mode,tool) 累计拦截达到该值即视为「反复尝试未启用模式的工具」。 */
const REPEATED_GATE_BLOCK_THRESHOLD = 3;

/**
 * 反馈点：判定某 (mode,tool) 是否达到「反复尝试未启用模式」的信号。
 * 确定性：基于真实计数器与固定阈值，无启发式 / 无关键词。
 */
export function isRepeatedModeGateBlock(mode: ModeId, tool: string): boolean {
  return getModeGateBlockCount(mode, tool) >= REPEATED_GATE_BLOCK_THRESHOLD;
}

function modeCounter(mode: ModeId) {
  return metrics.counter(
    MODE_COUNTER_NAMES[mode],
    `模式 ${mode} 的工具调用/事件计数`,
  );
}

/**
 * 记录一个 per-mode 审计事件并更新 metrics。
 *
 * 调用方仍负责把事件落到该模式既有的数据通道（office jsonl / bughunt ledger /
 * workflow DB）；本函数只负责「统一 metrics 计数 + 一个可观测的汇聚点」。
 *
 * @param mode 事件所属模式。
 * @param event 结构化审计事件。
 * @param callerContext 可选的调用方上下文（用于 metrics label，不落库）。
 */
export function auditModeEvent(
  mode: ModeId,
  event: ModeAuditEvent,
  callerContext?: { actor?: string },
): void {
  try {
    const baseLabels: Record<string, string> = { kind: event.kind };
    const outcome = auditOutcomeFor(event);
    if (outcome) baseLabels.outcome = outcome;

    modeCounter(mode).inc(baseLabels);

    if (event.kind === 'mode_gate_blocked') {
      modeGateBlockedTotal.inc({
        mode,
        tool: event.tool,
        reason: event.reason,
        actor: callerContext?.actor ?? event.actor,
      });
    }
  } catch {
    // metrics 写入失败绝不影响业务路径。
  }
}

/** 从审计事件派生确定性的 outcome label（无启发式）。 */
function auditOutcomeFor(event: ModeAuditEvent): string | undefined {
  switch (event.kind) {
    case 'office_tool_call':
      return event.success ? 'success' : 'failure';
    case 'workflow_execution':
      return event.outcome;
    case 'bughunt_ledger_event':
      return event.bughuntKind;
    case 'mode_gate_blocked':
      return 'blocked';
    default:
      return undefined;
  }
}

/**
 * fail-closed 拦截的便捷记录器。
 * 供 ModeToolPolicy 命中 `*_MODE_REQUIRED` 时调用（确定性统计反复尝试）。
 */
export function recordModeGateBlock(
  mode: ModeId,
  tool: string,
  reason: string,
  actor: string,
): void {
  auditModeEvent(mode, { kind: 'mode_gate_blocked', tool, reason, actor }, { actor });
}
