import type { EventEmitter } from '../core/EventEmitter.js';
import type { Task } from '../core/TaskBoard.js';
import { withDisplayState } from '../core/TaskDisplayState.js';
import type { OrchestrationTaskMetadata, OrchestrationVerdict } from '../core/OrchestrationTypes.js';
import { isTaskTerminalStatus, normalizeTaskStatus } from '../contracts/adapters/StatusAdapter.js';

export interface OrchestrationRuntimeOptions {
  sessionId: string;
  emitter: EventEmitter;
  getTasks: () => Task[];
  /** 写回 task.orchestration.verdict 并 persistTask；可选，缺省时 verdict 仅用于事件投影不会落库 */
  setOrchestrationVerdict?: (taskId: string, verdict: OrchestrationVerdict) => boolean;
  createFollowupTask?: (input: {
    subject: string;
    description: string;
    agentType: string;
    blockedBy?: string[];
    orchestration: OrchestrationTaskMetadata;
    context?: string;
  }) => string | undefined;
}

interface RunProjection {
  runId: string;
  generation: number;
  eventCount: number;
}

export interface OrchestrationTerminalResult {
  handled: boolean;
  accepted: boolean;
  reason?: string;
}

function normalizeVerdict(value: unknown): OrchestrationVerdict | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.toUpperCase();
  if (upper === 'PASS' || upper === 'FAIL' || upper === 'BLOCKED' || upper === 'UNKNOWN') return upper;
  return undefined;
}

function parseResultPayload(result: unknown): Record<string, unknown> | null {
  if (result && typeof result === 'object') return result as Record<string, unknown>;
  if (typeof result !== 'string') return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

function extractVerdict(result: unknown): OrchestrationVerdict | undefined {
  const payload = parseResultPayload(result);
  if (!payload) return undefined;
  return normalizeVerdict(payload.verdict)
    ?? normalizeVerdict((payload.report as Record<string, unknown> | undefined)?.verdict)
    ?? normalizeVerdict((payload.evaluation as Record<string, unknown> | undefined)?.verdict);
}

function isRejectVerdict(verdict: OrchestrationVerdict | undefined): boolean {
  return verdict === 'FAIL' || verdict === 'BLOCKED';
}

/**
 * 默认最小验收策略：当任务没有显式 evaluationPolicy 时自动注入。
 * 确保每个完成的任务都会触发 evaluator 验收，堵住"Agent说完成就完成"的漏洞。
 */
const DEFAULT_MAX_REPAIR_BY_NODE_KIND: Record<string, number> = {
  implement: 2,
  evaluate: 1,
  repair: 0,
};

function getDefaultMaxRepair(nodeKind: string | undefined): number {
  if (nodeKind && nodeKind in DEFAULT_MAX_REPAIR_BY_NODE_KIND) {
    return DEFAULT_MAX_REPAIR_BY_NODE_KIND[nodeKind];
  }
  return 1;
}

const DEFAULT_MINIMAL_EVALUATION_POLICY = {
  required_evidence: ['任务产出文件路径'],
  critical_gates: [] as string[],
  max_repair: 1,
};

function buildDefaultEvaluationPolicy(nodeKind?: string): { required_evidence: string[]; critical_gates: string[]; max_repair: number } {
  return {
    required_evidence: ['任务产出文件路径'],
    critical_gates: [],
    max_repair: getDefaultMaxRepair(nodeKind),
  };
}

export class OrchestrationRuntime {
  private readonly sessionId: string;
  private readonly emitter: EventEmitter;
  private readonly getTasks: () => Task[];
  private readonly setOrchestrationVerdict?: (taskId: string, verdict: OrchestrationVerdict) => boolean;
  private readonly createFollowupTask?: OrchestrationRuntimeOptions['createFollowupTask'];
  private readonly runs = new Map<string, RunProjection>();
  private subscribed = false;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: OrchestrationRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.emitter = options.emitter;
    this.getTasks = options.getTasks;
    this.setOrchestrationVerdict = options.setOrchestrationVerdict;
    this.createFollowupTask = options.createFollowupTask;
    this.subscribe();
  }

  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    const onCreated = ({ task }: { task: Task }) => this.handleTaskLifecycle('NodeCreated', task);
    const onUpdated = ({ task }: { task: Task }) => this.handleTaskLifecycle('NodeUpdated', task);
    const onAssigned = ({ task }: { task: Task }) => this.handleTaskLifecycle('NodeDispatched', task);
    const onCompleted = ({ task, result }: { task?: Task; result?: unknown }) => {
      if (task) void this.handleTerminalTask(task, 'completed', result);
    };
    const onFailed = ({ task, reason }: { task?: Task; reason?: unknown }) => {
      if (task) void this.handleTerminalTask(task, 'failed', reason);
    };
    const onCancelled = ({ task, reason }: { task?: Task; reason?: unknown }) => {
      if (task) void this.handleTerminalTask(task, 'cancelled', reason);
    };
    this.emitter.on('task:created', onCreated);
    this.emitter.on('task:updated', onUpdated);
    this.emitter.on('task:assigned', onAssigned);
    this.emitter.on('task:completed', onCompleted);
    this.emitter.on('task:failed', onFailed);
    this.emitter.on('task:cancelled', onCancelled);
    this.unsubscribers.push(
      () => this.emitter.off('task:created', onCreated),
      () => this.emitter.off('task:updated', onUpdated),
      () => this.emitter.off('task:assigned', onAssigned),
      () => this.emitter.off('task:completed', onCompleted),
      () => this.emitter.off('task:failed', onFailed),
      () => this.emitter.off('task:cancelled', onCancelled),
    );
  }

  /**
   * 退订所有 task:* 生命周期监听器，断开对共享 emitter 的引用。
   * 必须在 LeaderAgent 实例终结（dispose）时调用，避免会话重建在共享 emitter 上累积监听器（H1）。
   */
  dispose(): void {
    if (!this.subscribed) return;
    for (const off of this.unsubscribers) {
      try { off(); } catch { /* tolerate：单个退订失败不阻断其余 */ }
    }
    this.unsubscribers.length = 0;
    this.subscribed = false;
  }

  async handleTaskResult(task: Task | undefined, exitReason: 'completed' | 'failed', result: unknown, structuredVerdict?: 'PASS' | 'FAIL' | 'BLOCKED'): Promise<OrchestrationTerminalResult> {
    if (!task?.orchestration?.orchestrationRunId) {
      // P1: 对无 orchestration metadata 的 implement 类任务，强制注入 orchestrationRunId
      if (task && exitReason === 'completed') {
        const autoRunId = `auto-orch-${task.id}`;
        const autoNodeKind = task.orchestration?.nodeKind ?? 'implement';
        const autoPolicy = buildDefaultEvaluationPolicy(autoNodeKind);
        // 注入默认 orchestration metadata 并触发 evaluator
        if (!task.orchestration) {
          task.orchestration = {
            orchestrationRunId: autoRunId,
            nodeKind: autoNodeKind,
            generation: 0,
            verdict: 'UNKNOWN',
            evaluationPolicy: autoPolicy,
            acceptance: { status: 'pending', evidenceTaskIds: [task.id] },
          };
        } else if (!task.orchestration.orchestrationRunId) {
          task.orchestration.orchestrationRunId = autoRunId;
          task.orchestration.evaluationPolicy ??= autoPolicy;
        }
        this.ensureEvaluatorTask(task, result);
      }
      return { handled: false, accepted: true };
    }
    const verdict = normalizeVerdict(structuredVerdict) ?? extractVerdict(result) ?? task.orchestration.verdict;
    // 真写回 task.orchestration.verdict —— 让 BLOCKED/FAIL 在 DB 落地，
    // reject/repair 分支真生效（之前 verdict 永远停在 'UNKNOWN'）
    if (verdict && verdict !== task.orchestration.verdict && this.setOrchestrationVerdict) {
      try { this.setOrchestrationVerdict(task.id, verdict); } catch { /* tolerate */ }
    }
    // evaluator 任务完成时总是 accepted=true: evaluator 的 verdict 是对源任务的验收结论,
    // 不是 evaluator 自身的成败。FAIL/BLOCKED 应触发 repair, 而非 redispatch evaluator。
    // 否则 evaluator 被 redispatch → repair 任务被 evaluator blocked → 死锁。
    const isEvaluator = task.orchestration.nodeKind === 'evaluate';
    const accepted = exitReason === 'completed'
      ? (isEvaluator ? true : !isRejectVerdict(verdict))
      : false;
    if (accepted) {
      if (isEvaluator && isRejectVerdict(verdict)) {
        // evaluator 验收未通过: 为源任务创建 repair, 但 evaluator 自身正常完成
        this.ensureRepairTask(task, verdict ?? 'FAIL', result);
      } else {
        this.ensureEvaluatorTask(task, result);
      }
    } else {
      this.ensureRepairTask(task, verdict ?? 'FAIL', result);
    }
    return {
      handled: true,
      accepted,
      reason: accepted ? undefined : `orchestration verdict rejected: ${verdict ?? exitReason}`,
    };
  }

  private async handleTerminalTask(task: Task, exitReason: 'completed' | 'failed' | 'cancelled', result: unknown): Promise<void> {
    const metadata = task.orchestration;
    if (!metadata?.orchestrationRunId) return;
    const run = this.ensureRun(metadata);
    const verdict = extractVerdict(result) ?? metadata.verdict;
    const eventType = exitReason === 'completed' ? 'NodeCompleted' : exitReason === 'cancelled' ? 'NodeCancelled' : 'NodeFailed';
    // 不再默认 PASS：如果 verdict 为 undefined 或 UNKNOWN，不假设通过，直接 return（让 evaluator 决定）
    if (!verdict || verdict === 'UNKNOWN') {
      // evaluator 自身完成时 verdict 仍为 UNKNOWN: 不再重复创建 evaluator, 直接 emit terminal
      if (metadata.nodeKind === 'evaluate') {
        this.emitApplied(run.runId, eventType, task, metadata, 'UNKNOWN');
        this.emitRunState(run.runId);
        return;
      }
      // 仍触发 evaluator 验收，但不 emit terminal event（verdict 未定）
      this.ensureEvaluatorTask(task, result);
      this.emitRunState(run.runId);
      return;
    }
    // 写回 verdict 到 task.orchestration —— 跨进程 / 重启后保留（与 handleTaskResult 对称）
    if (verdict !== metadata.verdict && this.setOrchestrationVerdict) {
      try { this.setOrchestrationVerdict(task.id, verdict); } catch { /* tolerate */ }
    }
    this.emitApplied(run.runId, eventType, task, metadata, verdict);

    if (isRejectVerdict(verdict) && metadata.nodeKind === 'evaluate') {
      this.emitRepairSuggestion(task, metadata, `evaluation verdict ${verdict}`);
    }
    this.emitRunState(run.runId);
  }

  private handleTaskLifecycle(eventType: string, task: Task): void {
    const metadata = task.orchestration;
    if (!metadata?.orchestrationRunId) return;
    const run = this.ensureRun(metadata);
    this.emitter.emit('orchestration:node_update', {
      sessionId: this.sessionId,
      runId: run.runId,
      eventType,
      task: withDisplayState(task),
      metadata,
      displayState: withDisplayState(task).displayState,
    });
    // P0-4 修复（audit-2026-05-15）：生命周期事件只 emit node_update，
    // 不再重复 emit event_applied —— event_applied 仅保留给真正的 verdict 变更
    // （由 handleTerminalTask 触发 NodeCompleted / NodeFailed / NodeCancelled）。
    // 避免前端 history 出现 NodeCreated/NodeDispatched/NodeUpdated × 2 的重复条目。
    this.emitRunState(run.runId);
  }

  private ensureEvaluatorTask(task: Task, result: unknown): void {
    if (!this.createFollowupTask) return;
    const metadata = task.orchestration;
    // 对没有 orchestration metadata 的任务，生成 auto-eval-{taskId} 作为 runId
    const runId = metadata?.orchestrationRunId ?? `auto-eval-${task.id}`;
    // 对没有 evaluationPolicy 的任务，注入默认最小验收策略
    const policy = metadata?.evaluationPolicy ?? buildDefaultEvaluationPolicy(metadata?.nodeKind);
    // evaluator 任务自身不需要再触发 evaluator
    if (metadata?.nodeKind === 'evaluate') return;
    // dedup 检查：兼容 auto-eval-{taskId} 格式的 runId
    const existing = this.getTasks().find((candidate) =>
      candidate.orchestration?.orchestrationRunId === runId &&
      candidate.orchestration?.nodeKind === 'evaluate' &&
      candidate.blocked_by.includes(task.id)
    );
    if (existing) return;
    // 构建 evaluator task description，包含 critical_gates 执行指令
    let description = `根据 contract/evaluation_policy 验收任务 ${task.id} 的产出。必须输出 JSON verdict: PASS | FAIL | BLOCKED，并给出 summary/evidence。`;
    // P5: 注入 per-agent context 评估信息，帮助 evaluator 理解任务执行上下文
    const contextInfo: string[] = [];
    if (task.assigned_agent) contextInfo.push(`执行 Agent: ${task.assigned_agent}`);
    if (task.agent_type) contextInfo.push(`角色类型: ${task.agent_type}`);
    if (metadata?.generation) contextInfo.push(`编排代数: ${metadata.generation}`);
    if (metadata?.repairCount) contextInfo.push(`修复次数: ${metadata.repairCount}`);
    if (contextInfo.length > 0) {
      description += `\n\n## 任务上下文\n${contextInfo.join('\n')}`;
    }
    const criticalGates = (policy as { critical_gates?: string[] }).critical_gates;
    if (Array.isArray(criticalGates) && criticalGates.length > 0) {
      const gateList = criticalGates.map((gate, i) => `${i + 1}. ${gate}`).join('\n');
      description += `\n\n必须执行以下验证命令并确认全部通过（exit code 0）：\n${gateList}`;
    }
    this.createFollowupTask({
      subject: `验收 ${task.id}: ${task.subject}`,
      description,
      agentType: 'verify',
      blockedBy: [task.id],
      context: JSON.stringify({ sourceTaskId: task.id, result, contract: metadata?.contract, evaluationPolicy: policy }, null, 2),
      orchestration: {
        orchestrationRunId: runId,
        nodeKind: 'evaluate',
        generation: metadata?.generation ?? 0,
        verdict: 'UNKNOWN',
        contract: metadata?.contract,
        evaluationPolicy: policy,
        acceptance: { status: 'pending', evidenceTaskIds: [task.id] },
      },
    });
  }

  private ensureRepairTask(task: Task, verdict: OrchestrationVerdict, result: unknown): void {
    const metadata = task.orchestration;
    if (!metadata?.orchestrationRunId || !this.createFollowupTask) return;
    const existing = this.getTasks().find((candidate) =>
      candidate.orchestration?.orchestrationRunId === metadata.orchestrationRunId &&
      candidate.orchestration?.nodeKind === 'repair' &&
      candidate.blocked_by.includes(task.id)
    );
    if (existing) return;

    // P2: repairCount tracking and limit check
    const sourceRepairCount = metadata.repairCount ?? 0;
    const policy = metadata.evaluationPolicy as { max_repair?: number } | undefined;
    const maxRepair = policy?.max_repair ?? getDefaultMaxRepair(metadata.nodeKind);
    const newRepairCount = sourceRepairCount + 1;
    const repairLimitReached = newRepairCount >= maxRepair;

    if (repairLimitReached) {
      // Repair limit reached: do not create another repair task
      this.emitter.emit('orchestration:event_rejected', {
        sessionId: this.sessionId,
        runId: metadata.orchestrationRunId,
        eventId: `${metadata.orchestrationRunId}:${task.id}:repair_limit_reached`,
        eventType: 'RepairLimitReached',
        taskId: task.id,
        reason: `repair limit reached (${newRepairCount}/${maxRepair})`,
      });
      return;
    }

    this.createFollowupTask({
      subject: `修复 ${task.id}: ${task.subject}`,
      description: `任务 ${task.id} 验收结果为 ${verdict}，请基于失败原因修复并产出可再次验收的结果。`,
      agentType: task.agent_type || 'coding',
      blockedBy: [task.id],
      context: JSON.stringify({ sourceTaskId: task.id, verdict, result, contract: metadata.contract, evaluationPolicy: metadata.evaluationPolicy }, null, 2),
      orchestration: {
        orchestrationRunId: metadata.orchestrationRunId,
        nodeKind: 'repair',
        generation: (metadata.generation ?? 0) + 1,
        verdict: 'UNKNOWN',
        contract: metadata.contract,
        evaluationPolicy: metadata.evaluationPolicy,
        acceptance: { status: 'pending', evidenceTaskIds: [task.id] },
        nextAction: `修复 ${task.id} 后重新验收`,
        repairCount: newRepairCount,
        repairLimitReached,
      },
    });
  }

  private emitRepairSuggestion(task: Task, metadata: OrchestrationTaskMetadata, reason: string): void {
    const runId = metadata.orchestrationRunId;
    if (!runId) return;
    this.emitter.emit('orchestration:event_rejected', {
      sessionId: this.sessionId,
      runId,
      eventId: `${runId}:${task.id}:repair_suggestion`,
      eventType: 'RepairSuggested',
      taskId: task.id,
      reason,
    });
  }

  private ensureRun(metadata: OrchestrationTaskMetadata): RunProjection {
    const runId = metadata.orchestrationRunId ?? `run-${this.sessionId}`;
    const existing = this.runs.get(runId);
    if (existing) {
      existing.generation = Math.max(existing.generation, metadata.generation ?? 0);
      return existing;
    }
    const run = { runId, generation: metadata.generation ?? 0, eventCount: 0 };
    this.runs.set(runId, run);
    return run;
  }

  private emitApplied(runId: string, eventType: string, task: Task, metadata: OrchestrationTaskMetadata, verdict?: OrchestrationVerdict): void {
    const run = this.runs.get(runId) ?? this.ensureRun(metadata);
    run.eventCount += 1;
    this.emitter.emit('orchestration:event_applied', {
      sessionId: this.sessionId,
      runId,
      eventId: `${runId}:${task.id}:${eventType}:${run.eventCount}`,
      eventType,
      taskId: task.id,
      nodeKind: metadata.nodeKind,
      generation: metadata.generation,
      verdict,
    });
  }

  private emitRunState(runId: string): void {
    const tasks = this.getTasks().filter((task) => task.orchestration?.orchestrationRunId === runId);
    const run = this.runs.get(runId) ?? { runId, generation: 0, eventCount: 0 };
    // 编排运行态是 Web/TUI/远程端共同消费的投影，终态统计必须使用中心任务语义。
    const terminal = tasks.filter((task) => isTaskTerminalStatus(task));
    const failed = terminal.filter((task) => {
      const status = normalizeTaskStatus(task);
      return status === 'failed' || status === 'cancelled';
    });
    const blocked = tasks.filter((task) => task.status === 'dispatchable' && (task.blocked_by?.length ?? 0) > 0);
    const running = tasks.filter((task) => normalizeTaskStatus(task) === 'running');
    const active = running.length > 0 ? running : tasks.filter((task) => !isTaskTerminalStatus(task));
    const status = failed.length > 0
      ? 'failed'
      : tasks.length > 0 && terminal.length === tasks.length
        ? 'completed'
        : active.length > 0
          ? 'running'
          : 'planning';
    const currentNodeId = active[0]?.id ?? null;
    const explanationState = status === 'completed'
      ? 'idle'
      : running.length > 0
        ? 'working'
        : blocked.length > 0
          ? 'waiting_for_dependency'
            : tasks.some((task) => task.orchestration?.nodeKind === 'evaluate' && !terminal.includes(task))
            ? 'evaluating'
            : tasks.some((task) => task.orchestration?.nodeKind === 'repair' && !terminal.includes(task))
              ? 'repairing'
              : 'working';
    this.emitter.emit('run:explanation_updated', {
      sessionId: this.sessionId,
      explanation: {
        mode: 'manual',
        state: explanationState,
        reason: blocked.length > 0
          ? `等待 ${blocked.length} 个 blocked DAG 节点解锁`
          : `Orchestration ${status}: ${terminal.length}/${tasks.length} nodes terminal`,
        nextAction: blocked[0]?.orchestration?.nextAction,
        activeTaskIds: active.map((task) => task.id),
        blockedTaskIds: blocked.map((task) => task.id),
        since: Date.now(),
        confidence: 'observed',
      },
    });
    this.emitter.emit('orchestration:run_state', {
      sessionId: this.sessionId,
      runId,
      status,
      generation: run.generation,
      totalNodes: tasks.length,
      completedNodes: terminal.filter((task) => normalizeTaskStatus(task) === 'completed').length,
      failedNodes: failed.length,
      blockedNodes: blocked.length,
      activeNodeIds: active.map((task) => task.id),
      currentNodeId,
      bottleneck: blocked[0]?.id ?? currentNodeId ?? undefined,
      summary: `Orchestration ${status}: ${terminal.length}/${tasks.length} nodes terminal`,
      eventCount: run.eventCount,
    });
  }
}
