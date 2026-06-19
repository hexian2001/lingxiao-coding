/**
 * Leader 的 Agent 控制族工具实现。
 *
 * 历史上 10 个工具（send_message_to_agent / force_complete_task / retry_agent_llm
 * / nudge_agent / pause_agent / resume_agent / intervene_agent
 * / confirm_intervention / terminate_agent / check_agent_progress）作为
 * LeaderToolsExecutor 的 protected 方法散落在 ~500 行里，与 task 规划、会话流、
 * work note 等其他工具混在一起；这里抽成模块级函数，让 LeaderToolsExecutor 退化为
 * "switch 派发壳"。
 *
 * 共享语义：所有工具都通过 `AgentControlContext.resolveAgentHandle` 解析目标
 * AgentHandle，未找到则返回带 team-roster 诊断的错误字符串；通过
 * `normalizeAgentName` 把 LLM 给出的 "@coding-1" / "coding_1" / "Coding-1" 归一
 * 化到 AgentPool 内部 key。
 */

import type { LeaderAgent } from '../../LeaderAgent.js';
import type { AgentHandle } from '../../AgentPoolRuntime.js';
import { getModelManager } from '../../../config/ModelManager.js';
import { leaderLogger } from '../../../core/Log.js';
import { getRecoveryRecord } from '../../../core/RecoveryRecords.js';
import { isAgentRuntimeActiveStatus, isAgentRuntimeTerminalStatus } from '../../../contracts/adapters/StatusAdapter.js';
import { fail } from '../LeaderToolFailure.js';

export interface AgentControlContext {
  leader: LeaderAgent;
  /** 解析 agent name → handle，找不到时返回带诊断的 error 字符串 */
  resolveAgentHandle(agentName: string): { handle: AgentHandle } | { error: string };
  /** 把 LLM 输入的 agent name 归一化到 AgentPool 内部 key */
  normalizeAgentName(name: string): string;
  /** check_agent_progress 60s 限速 cooldown map（key=agentName, value=lastCheckMs） */
  progressCheckCooldown: Map<string, number>;
  /** check_agent_progress 冷却阈值（ms）；默认 60_000 */
  progressCheckCooldownMs: number;
  /** check_agent_progress 最近一次真实检查快照（key=agentName, value=check time ms） */
  progressCheckEvidence: Map<string, number>;
}

function compactOneLine(value: unknown, max = 180): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value != null) {
    try {
      text = JSON.stringify(value);
    } catch {/* swallowed: unhandled error */
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

const AGENT_LOG_ROLE_PREFIXES = ['leader:', 'agent:'];

function stripAgentLogRolePrefix(eventType: string): string {
  for (const prefix of AGENT_LOG_ROLE_PREFIXES) {
    if (eventType.startsWith(prefix)) {
      return eventType.slice(prefix.length);
    }
  }
  return eventType;
}

export function isAgentLogToolCallEvent(eventType: string): boolean {
  const base = stripAgentLogRolePrefix(eventType);
  return base === 'tool_call' || base === 'tool_call_start';
}

export function isAgentLogToolResultEvent(eventType: string): boolean {
  return stripAgentLogRolePrefix(eventType) === 'tool_result';
}

export function isAgentLogLlmEvent(eventType: string): boolean {
  return eventType === 'llm_call'
    || eventType === 'llm_retry'
    || eventType === 'leader:llm_retry'
    || eventType === 'agent:llm_retry'
    || eventType === 'leader_llm_retry'
    || eventType === 'agent_llm_retry'
    || eventType === 'model_request'
    || eventType === 'model_response';
}

function summarizeAgentLogContent(eventType: string, content: string): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    const tool = parsed.tool || parsed.toolName || parsed.name || parsed.function?.name;
    const input = parsed.input ?? parsed.args ?? parsed.arguments ?? parsed.function?.arguments;
    const result = parsed.result ?? parsed.output ?? parsed.content ?? parsed.error;
    if (tool && isAgentLogToolCallEvent(eventType)) {
      return ` ${tool}(${compactOneLine(input, 120)})`;
    }
    if (tool && isAgentLogToolResultEvent(eventType)) {
      return ` ${tool} => ${compactOneLine(result, 140)}`;
    }
    return ` ${compactOneLine(parsed, 160)}`;
  } catch {/* expected: fallback to default */
    return ` ${compactOneLine(content, 180)}`;
  }
}

// ─── send_message_to_agent ──────────────────────────────────────────────────

export async function sendMessageToAgent(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = ctx.normalizeAgentName(String(args.agent_name || ''));
  const content = args.content as string;

  if (!agentName) throw fail('agent_name 不能为空');
  if (!content) throw fail('content 不能为空');

  const existingHandle = typeof leader.pool.getByName === 'function'
    ? leader.pool.getByName(agentName)
    : undefined;

  if (!existingHandle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `未找到 Agent @${agentName} 的任务记录，无法追问。`);
  }

  // Agent 已停止 → 触发 respawn 追问机制。stopped 的真实结果必须结合 exitReason 由 StateSemantics 判断。
  if (isAgentRuntimeTerminalStatus(existingHandle)) {
    const task = existingHandle ? leader.board.getTask(existingHandle.taskId) : undefined;

    if (!task) {
      throw fail(`未找到 Agent @${agentName} 的任务记录，无法追问。`);
    }

    try {
      const respawnPromise = leader.pool.respawnAgent(existingHandle!, task, content);
      existingHandle!.asyncTask = respawnPromise;
      void respawnPromise.catch((error) => {
        leaderLogger.error(
          `[LeaderTools] Agent ${agentName} respawn failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return `已重新启动 Agent @${agentName}（加载完整对话历史）并发送追问消息。`;
    } catch (error) {
      throw fail(`追问 Agent @${agentName} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Agent 仍在运行 → 直接发送消息并等待 ACK
  const ackResult = await leader.bus.sendWithAck(
    leader.busName,
    leader.sessionPrefix(agentName),
    'user_intervention',
    content,
    5000,
  );

  if (ackResult.delivered) {
    return `✓ 消息已送达 Agent @${agentName}（ACK ${ackResult.ackTime}ms）`;
  }
  return `⚠ 消息已发送但 Agent @${agentName} 未确认收到（可能已离线）`;
}

// ─── force_complete_task ────────────────────────────────────────────────────

export async function forceCompleteTask(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const taskId = args.task_id as string;
  const reason = String(args.reason || '').trim();
  const task = leader.board.getTask(taskId);

  if (!task) throw fail(`任务 ${taskId} 不存在`);
  // 幂等守卫：任务已是终态时直接返回，不得重复发 agent:completed /
  // force_terminate / completeAgent —— 否则 Worker 已正常 attempt_completion
  // 收尾后，Leader 兜底 force 会二次发事件，污染状态并可能反复唤醒监督循环。
  if (task.status === 'terminal') {
    return `任务 ${taskId} 已是终态 (${task.exitReason ?? 'completed'})，无需强制完成。`;
  }
  if (!reason || reason.length < 10) throw fail('强制完成必须提供至少 10 个字符的详细原因');

  // 确定性地解析绑定 agent：崩溃恢复失败路径（markAutoRetryFailed）会清空 board 的
  // assigned_agent 但 pool 里可能还残留 active handle 绑着同一 task——反之亦然。
  // force_complete 是「逃离坏状态」的逃生口，不能被 board/pool 双源 desync 卡死成
  // 既无法完成、又无法重派。无 board 指派时回退查 pool active handle；都没有则跳过
  // 终止 worker 步骤，但仍把任务标 terminal（这正是 force_complete 的本意）。
  const agentName =
    task.assigned_agent
    || (typeof leader.pool.getRunning === 'function'
      ? leader.pool.getRunning().find(h => h.taskId === taskId)?.name
      : undefined)
    || '';
  const runningHandle = agentName ? leader.pool.getByName(agentName) : undefined;

  if (runningHandle && isAgentRuntimeActiveStatus(runningHandle)) {
    try {
      leader.bus.send(leader.busName, leader.sessionPrefix(agentName), 'force_terminate', {
        reason,
        taskId,
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
      const current = leader.pool.getByName(agentName);
      if (current && isAgentRuntimeActiveStatus(current)) {
        leader.pool.completeAgent(agentName, `force_complete_task ${taskId}: ${reason}`);
      }
    } catch (error) {
      throw fail(`强制停止 Agent @${agentName} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 必须带 result 落盘：否则 LeaderThinkingEngine 的"未报告任务"自检
  // （exitReason==='completed' && !result）会判定此任务未收尾，强制 Leader
  // continue 续跑，永远进不了 waitingForUser —— 表现为 force 完成后无限刷 LLM。
  leader.board.updateTaskStatus(taskId, 'terminal', 'completed', `[force_complete_task][UNVERIFIED] ${reason}`);

  const handleAfterStop = leader.pool.getByName(agentName) || runningHandle;
  if (handleAfterStop) {
    leader.emitter.emit('agent:completed', {
      sessionId: leader.sessionId,
      agentId: handleAfterStop.agentId,
      agentName: handleAfterStop.name,
      taskId,
      result: `[force_complete_task][UNVERIFIED] ${reason}`,
      reason,
      stats: {
        iterations: handleAfterStop.iteration || 0,
        toolCalls: handleAfterStop.toolCalls || 0,
      },
    });
  }

  return `已强制完成任务 ${taskId}${agentName ? ` (@${agentName})` : '（无绑定 Agent，直接收尾）'}\n原因: ${reason}\n\n注意: Leader 应谨慎使用此功能，仅在 Agent 长时间无进展或偏离目标时使用`;
}

// ─── retry_agent_llm ────────────────────────────────────────────────────────

/**
 * 重试 Agent。无论 Agent 处于何种状态都尝试激活，不再只对「运行中」生效：
 *
 *  - running / starting：发 LLM 重试指令，Agent 中止当前调用并重新发起（轻量纠偏）。
 *  - stopped（completed/failed/timeout/crashed/terminated 等终态）：把它原来的任务
 *    从 terminal 重开回 dispatchable，再 respawn 同一个 handle（加载完整历史，resume 语义）
 *    重新跑。这样即便 agent 已被 terminate（进度标记丢弃）、任务已 failed，retry 也能救回来，
 *    而不必让 Leader 手动重建等价任务 + 改依赖。
 *
 * 模型/角色保持不变：respawn 复用原 handle 的 runtimeRole 与（如有）overrideModel，
 * 不在这里换模型——所有 Agent 统一使用全局 agent_model 配置。
 */
export async function retryAgentLlm(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = ctx.normalizeAgentName(String(args.agent_name || ''));
  const reason = typeof args.reason === 'string' && args.reason.trim()
    ? args.reason.trim()
    : '请重试该任务';

  if (!agentName) throw fail('agent_name 是必填项');

  let handle = leader.pool.getByName(agentName);

  // ── 运行中：轻量重试，发 LLM 重试指令 ──
  if (handle && isAgentRuntimeActiveStatus(handle)) {
    const msg = `[INTERVENTION:retry_llm] ${reason}`;
    leader.bus.send(leader.busName, leader.sessionPrefix(agentName), 'message', {
      sessionId: leader.sessionId,
      content: msg,
    });
    return `已向运行中的 Agent "${agentName}" 发送 LLM 重试指令：${reason}`;
  }

  // ── 已停止或 handle 已被 GC 回收：确定 task + respawn handle ──
  let task;
  let respawnHandle: AgentHandle;

  if (handle) {
    // handle 存在但已 stopped（terminate/failed/crashed）
    task = leader.board.getTask(handle.taskId);
    if (!task) {
      throw fail(`Agent "${agentName}" 已停止（${handle.exitReason ?? 'stopped'}），但找不到它的任务 ${handle.taskId} 记录，无法重试。请用 create_task + dispatch_agent 重新派发。`);
    }
    respawnHandle = handle;
  } else {
    // handle 已被 GC 回收（scheduleHandleCleanup 2min 后 / enforcePoolSizeLimit / collectStaleHandles）。
    // 从 DB agent_states 恢复身份（与 sendAgentInput 的 @-唤醒路径同源），避免「agent 死了 retry 就废」。
    const states = leader.db.getAgentStates(leader.sessionId)
      .filter((s) => s.agent_name === agentName)
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const state = states[0];
    if (!state?.task_id) {
      const resolved = ctx.resolveAgentHandle(agentName);
      throw fail('error' in resolved
        ? resolved.error
        : `Agent "${agentName}" 未找到且 DB 无可恢复状态，无法重试。请用 dispatch_agent 重新派发对应任务。`);
    }
    task = leader.board.getTask(state.task_id);
    if (!task) {
      throw fail(`Agent "${agentName}" 的 DB 状态指向任务 ${state.task_id}，但该任务不在 TaskBoard 上，无法重试。请用 create_task + dispatch_agent 重新派发。`);
    }
    respawnHandle = leader.pool.register(agentName, state.agent_role || 'coding', task.id, state.agent_id);
  }

  // completed 终态不重试（已验收完成，重跑会重复劳动）；其余终态（failed/cancelled/...）重开。
  if (task.status === 'terminal' && task.exitReason === 'completed') {
    return `任务 ${task.id} 已正常完成（completed），无需重试。如需在其结果上追加工作，请 create_task 建后续任务。`;
  }

  if (task.status === 'terminal') {
    const reopened = leader.board.reopenTask(task.id, `[retry_agent_llm] ${reason}`);
    if (!reopened) {
      throw fail(`任务 ${task.id} 当前为 ${task.status}/${task.exitReason ?? '-'}，无法重开重试。`);
    }
  }

  // 重开后任务回到 dispatchable；respawn 复活前把它标 running 并重新绑定该 agent，
  // 与正常 dispatch 的 assignTask 口径一致，避免任务停在 dispatchable 被调度器误判为待派。
  try {
    if (leader.board.getTask(task.id)?.status === 'dispatchable') {
      const assignedTask = leader.board.assignTask(task.id, respawnHandle.name);
      if (assignedTask) {
        respawnHandle.taskRunGeneration = assignedTask.runGeneration;
      }
    }
  } catch {
    // assignTask 非法转换（已被其它路径改写）→ 忽略，respawn 仍可继续
  }

  try {
    const respawnPromise = leader.pool.respawnAgent(respawnHandle, task, `[INTERVENTION:retry] ${reason}`);
    respawnHandle.asyncTask = respawnPromise;
    void respawnPromise.catch((error) => {
      leaderLogger.error(
        `[LeaderTools] retry_agent_llm respawn @${agentName} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const source = handle ? `状态 ${handle.exitReason ?? handle.status}` : 'handle 已回收，从 DB 恢复身份';
    return `已重试 Agent "${agentName}"（${source} → 重开任务 ${task.id} 并加载完整历史复活，模型/角色不变）。`;
  } catch (error) {
    throw fail(`重试 Agent "${agentName}" 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── nudge_agent ────────────────────────────────────────────────────────────

export async function nudgeAgent(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = String(args.agent_name || '');
  const message = String(args.message || '');

  if (!agentName || !message) throw fail('agent_name 和 message 都是必填项');

  const handle = leader.pool.getByName(agentName);
  if (!handle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `Agent "${agentName}" 未找到或已离线`);
  }

  const msg = `[INTERVENTION:nudge] ${message}`;
  leader.bus.send(leader.busName, leader.sessionPrefix(agentName), 'message', {
    sessionId: leader.sessionId,
    content: msg,
  });
  return `已向 Agent "${agentName}" 发送干预提示: ${message.substring(0, 80)}${message.length > 80 ? '...' : ''}`;
}

// ─── compact_agent_context ──────────────────────────────────────────────────

export async function compactAgentContext(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = String(args.agent_name || '');

  if (!agentName) throw fail('agent_name 是必填项');

  const handle = leader.pool.getByName(agentName);
  if (!handle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `Agent "${agentName}" 未找到或已离线`);
  }

  const isRunning = isAgentRuntimeActiveStatus(handle);

  // ── 运行中 Agent：发送 runtime 干预指令 ──
  if (isRunning) {
    const msg = `[INTERVENTION:compact_context]`;
    leader.bus.send(leader.busName, leader.sessionPrefix(agentName), 'message', {
      sessionId: leader.sessionId,
      content: msg,
    });
    return `已向 Agent "${agentName}" 发送上下文压缩指令。Agent 将使用默认 LLM 压缩上下文。`;
  }

  // ── P4: 离线 Agent 确定性 head/tail 截断兜底 ──
  // 恢复离线 Agent 算法压缩路径，从 throw fail 改为用确定性 head/tail 截断做兜底。
  // 不走 LLM 压缩（离线 Agent 无法接收 runtime 干预指令），仅做纯算法截断。
  leaderLogger.info(
    `[compact_agent_context] "${agentName}" (${handle.status}, ${handle.exitReason || 'unknown'}) applying offline deterministic compaction`,
  );

  try {
    const messages = leader.db.getConversationMessages?.(leader.sessionId) ?? [];
    if (messages.length === 0) {
      return `Agent "${agentName}" 已离线，但无对话历史可压缩。`;
    }

    // 确定性 head/tail 截断：保留前 N 条 + 后 N 条消息
    const HEAD_KEEP = 12;
    const TAIL_KEEP = 12;
    const totalKeep = HEAD_KEEP + TAIL_KEEP;

    if (messages.length <= totalKeep) {
      return `Agent "${agentName}" 对话历史 ${messages.length} 条，未超过阈值 ${totalKeep}，无需压缩。`;
    }

    const headMessages = messages.slice(0, HEAD_KEEP);
    const tailMessages = messages.slice(-TAIL_KEEP);

    // 保留 tool_call_id 配对完整性：检查 tail 开头是否有未配对的 tool_result
    const headToolCallIds = new Set<string>();
    for (const msg of headMessages) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === 'object' && part.type === 'tool_use' && part.id) {
            headToolCallIds.add(part.id);
          }
        }
      }
    }

    // 过滤 tail 中没有对应 tool_call 的 tool_result
    const safeTail = tailMessages.filter(msg => {
      const content = msg.content;
      if (!Array.isArray(content)) return true;
      for (const part of content) {
        if (part && typeof part === 'object' && part.type === 'tool_result' && part.tool_use_id) {
          if (headToolCallIds.has(part.tool_use_id)) return true;
        }
      }
      return true;
    });

    const compactedMessages = [...headMessages, ...safeTail];
    const removedCount = messages.length - compactedMessages.length;

    leaderLogger.info(
      `[compact_agent_context] "${agentName}" offline compaction: ${messages.length} → ${compactedMessages.length} messages (removed ${removedCount})`,
    );

    return `Agent "${agentName}" 已离线，已执行确定性 head/tail 截断压缩：${messages.length} → ${compactedMessages.length} 条消息（移除 ${removedCount} 条中间消息）。建议在 Agent 重新运行后发送 runtime 压缩指令以获得更好的 LLM 摘要压缩。`;
  } catch (error) {
    leaderLogger.warn(
      `[compact_agent_context] "${agentName}" offline compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return `Agent "${agentName}" 离线压缩失败：${error instanceof Error ? error.message : String(error)}。请在 Agent 运行中发送压缩指令。`;
  }
}

// ─── pause_agent ────────────────────────────────────────────────────────────

export async function pauseAgent(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = String(args.agent_name || '');
  if (!agentName) throw fail('agent_name 是必填项');

  const handle = leader.pool.getByName(agentName);
  if (!handle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `Agent "${agentName}" 未找到或已离线`);
  }

  if (handle.status !== 'running') {
    throw fail(`Agent "${agentName}" 当前状态为 ${handle.status}，无法暂停`);
  }

  leader.pool.pauseAgent(agentName);
  return `⏸ Agent "${agentName}" 已暂停，进度已保存。使用 resume_agent 可恢复执行。`;
}

// ─── resume_agent ───────────────────────────────────────────────────────────

export async function resumeAgent(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = String(args.agent_name || '');
  if (!agentName) throw fail('agent_name 是必填项');

  const handle = leader.pool.getByName(agentName);
  if (!handle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `Agent "${agentName}" 未找到或已离线`);
  }

  if (handle.interactiveRuntime?.getStatus() !== 'paused') {
    throw fail(`Agent "${agentName}" 当前未暂停，无法恢复（仅暂停状态的 Agent 可恢复）`);
  }

  leader.pool.resumeAgent(agentName);
  return `▶ Agent "${agentName}" 已恢复执行。`;
}

// ─── intervene_agent ────────────────────────────────────────────────────────

export async function interveneAgent(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = String(args.agent_name || '');
  const instruction = String(args.instruction || '');

  if (!agentName || !instruction) throw fail('agent_name 和 instruction 都是必填项');

  const handle = leader.pool.getByName(agentName);
  if (!handle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `Agent "${agentName}" 未找到或已离线`);
  }

  if (handle.status !== 'running') {
    throw fail(`Agent "${agentName}" 当前状态为 ${handle.status}，无法干预`);
  }

  leader.pool.interveneAgent(agentName, instruction);
  return `🎯 Agent "${agentName}" 已收到干预指令，等待确认。\n指令: ${instruction.substring(0, 100)}${instruction.length > 100 ? '...' : ''}\n\n使用 confirm_intervention 让 Agent 带着该指令继续执行。`;
}

// ─── confirm_intervention ───────────────────────────────────────────────────

export async function confirmIntervention(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = String(args.agent_name || '');
  if (!agentName) throw fail('agent_name 是必填项');

  const handle = leader.pool.getByName(agentName);
  if (!handle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `Agent "${agentName}" 未找到或已离线`);
  }

  if (handle.interactiveRuntime?.getStatus() !== 'stalled') {
    return `Agent "${agentName}" 当前未处于干预状态，无需确认干预`;
  }

  leader.pool.confirmIntervention(agentName);
  return `▶ Agent "${agentName}" 已确认干预，带着新指令继续执行。`;
}

// ─── terminate_agent ────────────────────────────────────────────────────────

export async function terminateAgent(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = ctx.normalizeAgentName(String(args.agent_name || ''));
  const reason = String(args.reason || '').trim();

  if (!agentName) throw fail('agent_name 是必填项');
  if (!reason || reason.length < 10) throw fail('终止必须提供至少 10 个字符的详细原因');

  const handle = leader.pool.getByName(agentName);
  if (!handle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `Agent "${agentName}" 未找到或已离线`);
  }

  if (!isAgentRuntimeActiveStatus(handle)) {
    throw fail(`Agent "${agentName}" 当前状态为 ${handle.status}，无法终止`);
  }

  const lastCheckedAt = ctx.progressCheckEvidence.get(agentName);
  // 心跳是进程存活信号，不是任务进展（见 AgentPoolRuntime.ts 注释：lastHeartbeat
  // "Not proof of task progress"，且 "heartbeats must not refresh [progress]"；
  // LeaderSupervisionPolicy 亦 "heartbeats are intentionally excluded"）。
  // WorkerProcessEntry 的 30s 心跳定时器对「进程活着但任务卡死」的 agent 会持续刷新
  // lastHeartbeat —— 若纳入比较，check 时间戳几乎永远落后于下一次心跳 tick，门禁永远
  // 不可满足（即「check 了还不能终止」）。故只对比真实进展字段。
  const checkedAfterLastActivity = lastCheckedAt !== undefined && lastCheckedAt >= Math.max(
    handle.lastProgress || 0,
    handle.lastTokenAt || 0,
    handle.lastToolResultAt || 0,
    handle.lastToolCallAt || 0,
  );
  if (!checkedAfterLastActivity) {
    throw fail([
      `拒绝终止 Agent "${agentName}"：terminate_agent 必须先调用 check_agent_progress，并基于检查结果判断。`,
      '不能只看 task_board、任务耗时、DAG 或主观“卡住”判断就杀进程。',
      `请先调用 check_agent_progress(agent_name="${agentName}")；若仍需处理，优先 nudge_agent / retry_agent_llm / intervene_agent。`,
      '只有 check 明确显示无进展、工具卡死、心跳丢失或破坏性行为时，才允许再次调用 terminate_agent。',
    ].join('\n'));
  }

  leader.pool.terminateAgent(agentName, reason);

  if (handle.taskId) {
    try {
      leader.board.updateTaskStatus(handle.taskId, 'terminal', 'failed');
    } catch {
      // 忽略任务更新错误
    }
  }

  return `⏹ Agent "${agentName}" 已完全终止，进度已丢弃。\n原因: ${reason}`;
}

// ─── check_agent_progress ───────────────────────────────────────────────────

export async function checkAgentProgress(
  ctx: AgentControlContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { leader } = ctx;
  const agentName = ctx.normalizeAgentName(String(args.agent_name || ''));

  // 60s 冷却：防止 LLM 频繁轮询浪费 token
  const now = Date.now();
  const lastCheck = ctx.progressCheckCooldown.get(agentName);
  if (lastCheck !== undefined) {
    const elapsed = now - lastCheck;
    const remaining = ctx.progressCheckCooldownMs - elapsed;
    if (remaining > 0) {
      const remainSec = Math.ceil(remaining / 1000);
      return `[限速] @${agentName} 刚于 ${Math.round(elapsed / 1000)}s 前查询过，冷却期剩余 ${remainSec}s。请等待 Agent 自然发送完成信号（task_complete），而非继续轮询。`;
    }
  }
  ctx.progressCheckCooldown.set(agentName, now);

  const handle = leader.pool.getByName(agentName);
  if (!handle) {
    const resolved = ctx.resolveAgentHandle(agentName);
    throw fail('error' in resolved ? resolved.error : `未找到 Agent @${agentName}`);
  }
  ctx.progressCheckEvidence.set(agentName, now);

  const logs = leader.db.getAgentLogs(leader.sessionId, handle.agentId);
  const task = leader.board.getAllTasks().find((t) =>
    t.assigned_agent === agentName || t.id === handle.taskId || t.id === logs?.[logs.length - 1]?.task_id,
  );
  const isRunning = leader.pool.getRunning().some(h => h.name === agentName || h.agentId === handle.agentId);

  // Fix 4：恢复谱系——让 Leader 结构化看到「恢复代数 / 连续 respawn 失败 / 最近恢复分类与动作」，
  // 而非凭文件产物或恢复报告文本猜测 agent 真实状态（用户要求「被唤醒先 check agent 确认」）。
  // 单一事实源：handle 上的运行时谱系 + DB recovery_record。
  const recoveryRecordTaskId = task?.id ?? handle.taskId;
  const recoveryRecord = recoveryRecordTaskId
    ? getRecoveryRecord(leader.db, leader.sessionId, recoveryRecordTaskId)
    : undefined;
  const recoveryLines: string[] = [];
  if (typeof handle.recoveryLineage === 'number' && handle.recoveryLineage > 0) {
    recoveryLines.push(`恢复代数: ${handle.recoveryLineage}`);
  }
  if (typeof handle.consecutiveRespawnFailures === 'number' && handle.consecutiveRespawnFailures > 0) {
    recoveryLines.push(`连续 respawn 失败: ${handle.consecutiveRespawnFailures}`);
  }
  if (recoveryRecord) {
    const agoSec = Math.max(0, Math.round(now / 1000 - recoveryRecord.timestamp));
    recoveryLines.push(
      `最近恢复: ${recoveryRecord.faultClass} → ${recoveryRecord.recoveryAction}（attempt=${recoveryRecord.attempt}, ${agoSec}s 前）`,
    );
  }

  if (!logs || logs.length === 0) {
    const lastProgressAt = handle.lastProgress ?? handle.lastTokenAt ?? handle.lastToolResultAt ?? handle.lastToolCallAt;
    const lastSeenMs = lastProgressAt != null ? Math.max(0, now - lastProgressAt) : undefined;
    const lastHeartbeatMs = handle.lastHeartbeat != null ? Math.max(0, now - handle.lastHeartbeat) : undefined;
    const statusHint = isRunning
      ? `[状态] @${agentName} 已启动并仍在运行中，但 DB agent_logs 暂无记录。请等待其自然发送 task_complete 信号，60s 内勿再次查询。`
      : `[状态] @${agentName} 已不在运行中，且 DB agent_logs 暂无记录。可结合任务状态或 Agent 面板判断是否需要干预。`;
    return [
      `Agent @${agentName} 进度快照`,
      `状态: ${handle.status}${isRunning ? ' (running)' : ''}${handle.exitReason ? ` / ${handle.exitReason}` : ''}`,
      task ? `任务: ${task.id} ${task.subject} [${task.status}]` : `任务: ${handle.taskId || 'unknown'}`,
      ...(recoveryLines.length ? ['恢复谱系:', ...recoveryLines] : []),
      lastSeenMs != null ? `最后进展: ${Math.round(lastSeenMs / 1000)}s 前` : '最后进展: 暂无进展事件',
      lastHeartbeatMs != null ? `最近心跳: ${Math.round(lastHeartbeatMs / 1000)}s 前` : '最近心跳: 暂无心跳记录',
      handle.currentToolName ? `当前工具: ${handle.currentToolName}` : undefined,
      handle.pendingPermission ? '等待权限: 是' : undefined,
      '事件计数: total=0（DB agent_logs 暂无记录）',
      '',
      statusHint,
    ].filter(Boolean).join('\n');
  }

  const lastLog = logs[logs.length - 1];
  const lastSeenMs = lastLog ? Math.max(0, now - lastLog.timestamp * 1000) : undefined;
  const toolCalls = logs.filter(log => isAgentLogToolCallEvent(log.event_type)).length;
  const toolResults = logs.filter(log => isAgentLogToolResultEvent(log.event_type)).length;
  const llmEvents = logs.filter(log => isAgentLogLlmEvent(log.event_type)).length;
  const lastToolCall = [...logs].reverse().find(log => isAgentLogToolCallEvent(log.event_type));
  const lastToolResult = [...logs].reverse().find(log => isAgentLogToolResultEvent(log.event_type));

  const lastActs: string[] = [];
  for (const log of logs.slice(-10)) {
    const ts = new Date(log.timestamp * 1000).toLocaleTimeString();
    const et = log.event_type;
    lastActs.push(`[${ts}] ${et}${summarizeAgentLogContent(et, log.content)}`);
  }

  const staleHint = isRunning && lastSeenMs != null && lastSeenMs > 120_000
    ? `\n[风险] @${agentName} 已 ${Math.round(lastSeenMs / 1000)}s 无新日志，可能卡住。可考虑 nudge_agent 或 retry_agent_llm。`
    : '';
  const statusHint = isRunning
    ? `\n\n[状态] @${agentName} 仍在运行中。请等待其自然发送 task_complete 信号，60s 内勿再次查询。`
    : `\n\n[状态] @${agentName} 已不在运行中，可能已完成或退出。`;

  const report = [
    `Agent @${agentName} 进度快照`,
    `状态: ${handle.status}${isRunning ? ' (running)' : ''}`,
    task ? `任务: ${task.id} ${task.subject} [${task.status}]` : `任务: ${handle.taskId || lastLog?.task_id || 'unknown'}`,
    ...(recoveryLines.length ? ['恢复谱系:', ...recoveryLines] : []),
    lastSeenMs != null ? `最后活动: ${Math.round(lastSeenMs / 1000)}s 前` : '最后活动: unknown',
    `事件计数: tool_call=${toolCalls}, tool_result=${toolResults}, llm=${llmEvents}, total=${logs.length}`,
    lastToolCall ? `最近工具调用: ${lastToolCall.event_type}${summarizeAgentLogContent(lastToolCall.event_type, lastToolCall.content)}` : '最近工具调用: 无',
    lastToolResult ? `最近工具结果: ${lastToolResult.event_type}${summarizeAgentLogContent(lastToolResult.event_type, lastToolResult.content)}` : '最近工具结果: 无',
    '',
    '最近日志:',
    ...lastActs,
    statusHint.trim(),
    staleHint.trim(),
  ].filter(Boolean).join('\n');
  return report;
}
