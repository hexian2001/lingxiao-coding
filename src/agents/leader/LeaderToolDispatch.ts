import { contentToPlainText, type ChatMessage, type ChatResponse, type ToolCall } from '../../llm/types.js';
import type { EventEmitter } from '../../core/EventEmitter.js';
import type { DatabaseManager } from '../../core/Database.js';
import { leaderLogger } from '../../core/Log.js';
import { ToolScheduler } from '../runtime/ToolScheduler.js';
import type { ToolResultContent } from '../runtime/ToolResponseProcessor.js';
import { executeToolCallsWithTruncationGuard } from '../runtime/ToolCallSafety.js';
import { isStopFinishReason } from '../runtime/CompletionTerminationPolicy.js';
import { FILE_MODIFYING_TOOLS } from '../runtime/parallelToolBatch.js';
import { registerLeaderFlush, unregisterLeaderFlush } from '../../core/RuntimeGuards.js';

export type LeaderToolDispatchResult = { done: boolean; result?: string };

export interface LeaderToolDispatchOptions {
  sessionId: string;
  emitter: EventEmitter;
  db: DatabaseManager;
  finishReason?: ChatResponse['finish_reason'];
  wasOutputTruncated?: boolean;
  planningGateBlockCount: number;
  setPlanningGateBlockCount(value: number): void;
  addMessage(message: ChatMessage): void;
  getConversation(): ChatMessage[];
  setRawXmlRetryCount(value: number): void;
  setEmptyResponseRetryCount(value: number): void;
  isUserInterruptPending(): boolean;
  getActiveTeam?: () => string | null;
  getCollaborationMode?: () => 'solo' | 'team';
  peekNextTaskIds?: (count: number) => string[];
  getTaskById?: (taskId: string) => { id: string; status: string } | undefined;
  executeToolCallsBatch(toolCalls: ToolCall[]): Promise<Array<{ toolCall: ToolCall; result: ToolResultContent }>>;
  createFileSnapshot?: (turnCount: number, label: string) => Promise<void>;
  getTurnCount(): number;
  isWaitingForUser(): boolean;
  isPendingReview(): boolean;
  isFinished(): boolean;
  isAgentCompletionPending?: () => boolean;
  evaluateContinuationAfterStop(input: {
    finishReason?: ChatResponse['finish_reason'];
    content: string;
    continuationRole: 'user' | 'system';
  }): Promise<LeaderToolDispatchResult | null>;
}

function parseArgs(toolCall: ToolCall): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

function hasTeamCreate(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((toolCall) =>
    toolCall.function.name === 'team_manage' && parseArgs(toolCall)?.action === 'create'
  );
}

function isDispatchTool(name: string): boolean {
  // explore 内部走 dispatchAgentWithOptions，命中同一 team roster gate，故纳入预检提示
  return name === 'dispatch_agent' || name === 'dispatch_batch' || name === 'explore';
}

function collectDispatchAgentNames(toolCalls: ToolCall[]): Set<string> {
  const names = new Set<string>();
  for (const toolCall of toolCalls) {
    const args = parseArgs(toolCall);
    if (toolCall.function.name === 'dispatch_agent' || toolCall.function.name === 'explore') {
      const name = String(args?.agent_name || '').trim();
      if (name) names.add(name);
    }
    if (toolCall.function.name === 'dispatch_batch' && Array.isArray(args?.dispatches)) {
      for (const item of args.dispatches) {
        if (!item || typeof item !== 'object') continue;
        const name = String((item as Record<string, unknown>).agent_name || '').trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

function collectCreatingTaskIds(
  toolCalls: ToolCall[],
  peekNextTaskIds?: (count: number) => string[],
): Set<string> {
  const createTaskCalls = toolCalls.filter((toolCall) => toolCall.function.name === 'create_task');
  const ids = new Set<string>(peekNextTaskIds?.(createTaskCalls.length) ?? []);
  for (const toolCall of createTaskCalls) {
    const id = parseArgs(toolCall)?.id;
    if (id) ids.add(String(id));
  }
  return ids;
}

function findMissingDispatchTaskIds(
  toolCalls: ToolCall[],
  creatingTaskIds: Set<string>,
  getTaskById?: (taskId: string) => { id: string; status: string } | undefined,
): string[] {
  const missing: string[] = [];
  for (const toolCall of toolCalls) {
    const args = parseArgs(toolCall);
    if (toolCall.function.name === 'dispatch_agent') {
      const taskId = String(args?.task_id || '');
      if (taskId && !creatingTaskIds.has(taskId) && !getTaskById?.(taskId)) {
        missing.push(taskId);
      }
    }
    if (toolCall.function.name === 'dispatch_batch' && Array.isArray(args?.dispatches)) {
      for (const item of args.dispatches) {
        if (!item || typeof item !== 'object') continue;
        const taskId = String((item as Record<string, unknown>).task_id || '');
        if (taskId && !creatingTaskIds.has(taskId) && !getTaskById?.(taskId)) {
          missing.push(taskId);
        }
      }
    }
  }
  return missing;
}

function maybeInjectDagHint(toolCalls: ToolCall[], addMessage: (message: ChatMessage) => void): void {
  const createTaskCalls = toolCalls.filter((toolCall) => toolCall.function.name === 'create_task');
  if (createTaskCalls.length < 3) return;

  const allNoDeps = createTaskCalls.every((toolCall) => {
    const deps = parseArgs(toolCall)?.blocked_by;
    return !Array.isArray(deps) || deps.length === 0;
  });
  if (!allNoDeps) return;

  const taskNames = createTaskCalls
    .map((toolCall) => String(parseArgs(toolCall)?.subject || '?'))
    .join('、');
  leaderLogger.warn(`[DAGGate] ${createTaskCalls.length} 个任务均无 blocked_by 依赖，注入 DAG 完整性提示`);
  addMessage({
    role: 'system',
    content: `[DAG完整性提示] 你创建了 ${createTaskCalls.length} 个任务（${taskNames}），但全部 blocked_by=[]。\n\n请确认：\n- research/调研类任务完成前，coding/实现类任务是否应该等待？若是，coding 任务需设 blocked_by=[research任务ID]\n- 写同一批文件的任务是否会产生冲突？若是，后者需 blocked_by 前者\n\n如果这些任务确实完全独立可并行，请忽略此提示继续执行。否则请重新规划并补充 blocked_by。`,
  });
}

function readCollaborationMode(options: LeaderToolDispatchOptions): 'solo' | 'team' {
  return options.getCollaborationMode?.() ?? (options.getActiveTeam?.() ? 'team' : 'solo');
}

export function createLeaderToolScheduler(
  options: LeaderToolDispatchOptions,
): ToolScheduler<LeaderToolDispatchResult> {
  const { sessionId, emitter, db, finishReason } = options;
  const toolResultsAcc: Array<{ id: string; name: string; input: string; result?: string }> = [];
  let planningGateBlockCount = options.planningGateBlockCount;
  const setPlanningGateBlockCount = (value: number) => {
    planningGateBlockCount = value;
    options.setPlanningGateBlockCount(value);
  };

  // ── 治本层：assistant 与其 tool results 原子批写 ────────────────────────────
  // 消除「assistant 已落库、tool results 未落库」的 DB 残缺裂缝。
  // 见 message_sanitizer.healInterruptedToolCalls 的根因注释：
  // persistAssistantMessage 先于 persistToolMessage 落库，中间隔着慢工具执行窗口，
  // 进程在此被 kill → 残缺历史 → resume 后 provider 边界反复合成 [tool result missing]。
  // 这里把 assistant 暂缓落库，攒齐全部 tool results 后一次性事务写入（要么全写要么全不写）。
  // 内存 conversation 仍按原时序即时 addMessage（保流式 UI / 引用语义），仅延迟 DB 持久化。
  let pendingAssistant: ChatMessage | null = null;
  let pendingAssistantTs: number | null = null;
  let pendingToolResults: ChatMessage[] = [];
  let currentBatchToolCalls: ToolCall[] = [];

  /**
   * 原子批写 assistant + pendingToolResults 到 DB。
   *
   * 补齐机制：如果 pendingToolResults 数量 < assistant.tool_calls 数量
   * （因 earlyStop / 异常 / executeToolCallsBatch 返回不完整），
   * 自动为缺失的 tool_call_id 合成 ERROR tool result，确保 assistant
   * 永远不会以 orphan 形式落库（orphan → resume 后 provider 合成
   * [tool result missing] → 死循环）。
   *
   * 幂等：pendingAssistant 为 null 时直接返回。
   */
  const flushBatch = () => {
    if (!pendingAssistant) return;

    const expectedCount = pendingAssistant.tool_calls?.length ?? 0;
    const collectedIds = new Set(
      pendingToolResults.map((r) => r.tool_call_id).filter(Boolean),
    );
    const missingToolCalls = (pendingAssistant.tool_calls ?? []).filter(
      (tc) => !collectedIds.has(tc.id),
    );

    // 补齐缺失的 tool results：合成 ERROR 消息，让 provider 看到明确的失败原因
    const syntheticResults: ChatMessage[] = missingToolCalls.map((tc) => ({
      role: 'tool' as const,
      content: `ERROR: [flush] tool_call ${tc.function.name}(${tc.id}) 未收到执行结果（进程中断/earlyStop/异常）。请重试该工具调用。`,
      tool_call_id: tc.id,
    }));

    // 同步补齐内存 conversation（保持 conversation 与 DB 一致）
    for (const synth of syntheticResults) {
      options.addMessage(synth);
      pendingToolResults.push(synth);
    }

    const batch = [pendingAssistant, ...pendingToolResults];
    // 真实 DatabaseManager 提供 saveConversationMessagesBatch（原子事务批写，治本核心）。
    // 既有测试的部分 mock db 未提供该方法 → 降级为逐条写（仅兼容未更新 mock；
    // 真实运行环境必走批写分支，原子性保证不受影响）。
    if (typeof db.saveConversationMessagesBatch === 'function') {
      db.saveConversationMessagesBatch(sessionId, batch, pendingAssistantTs ?? undefined);
    } else {
      for (const msg of batch) db.saveConversationMessage(sessionId, msg);
    }
    pendingAssistant = null;
    pendingAssistantTs = null;
    pendingToolResults = [];
    currentBatchToolCalls = [];
  };

  // pipeline-flush 契约：将 flushBatch 注册到 cleanupRegistry（priority=0），
  // 确保 gracefulShutdown → cleanupRegistry.runAll() 时 pending tool_results 被 flush。
  // 幂等：registerLeaderFlush 内部先反注册旧回调。
  registerLeaderFlush(flushBatch);

  const scheduler = new ToolScheduler({
    beforeToolCalls: (toolCalls, context) => {
      emitter.emit('leader:phase_change', { sessionId, phase: 'tool_executing', toolName: toolCalls[0]?.function.name });
      if (context?.source === 'raw_xml') {
        leaderLogger.warn(`检测到原始 XML 工具标签，容错解析出 ${toolCalls.length} 个工具调用`);
        emitter.emit('leader:status', { sessionId, status: `⚠️ 格式容错：解析到 ${toolCalls.length} 个工具调用，执行中...` });
      }
      options.setRawXmlRetryCount(0);
      options.setEmptyResponseRetryCount(0);

      const firstAskUserIndex = toolCalls.findIndex((toolCall) => toolCall.function.name === 'ask_user');
      if (firstAskUserIndex >= 0 && toolCalls.length > firstAskUserIndex + 1) {
        const dropped = toolCalls.slice(firstAskUserIndex + 1).map((toolCall) => toolCall.function.name).join(', ');
        leaderLogger.warn(`[UserGate] ask_user 后丢弃同批后续工具: ${dropped}`);
        emitter.emit('leader:status', { sessionId, status: '等待用户确认...' });
        toolCalls.splice(firstAskUserIndex + 1);
      }

      const hasCreateTask = toolCalls.some((toolCall) => toolCall.function.name === 'create_task');
      if (hasCreateTask) {
        setPlanningGateBlockCount(0);
        maybeInjectDagHint(toolCalls, options.addMessage);
      }

      const hasDispatch = toolCalls.some((toolCall) => isDispatchTool(toolCall.function.name));
      const collaborationMode = readCollaborationMode(options);
      // Auto-team fallback: dispatch/explore 在 Team 模式下无 active team 时不再仅注入警告，
      // 而是由 dispatchAgentWithOptions 内部的 ensureTeamForDispatch 自动建团。
      // 这里仅记录日志，不再注入阻断性提示消息。
      if (hasDispatch && collaborationMode === 'team' && !options.getActiveTeam?.() && !hasTeamCreate(toolCalls)) {
        const dispatchAgentNames = collectDispatchAgentNames(toolCalls);
        leaderLogger.info(`[AutoTeam] Team 模式下 dispatch/explore 无 active team（目标 agent：${[...dispatchAgentNames].join(', ') || '未知'}）；将自动建团`);
      }

      if (hasDispatch && planningGateBlockCount < 3) {
        const creatingTaskIds = collectCreatingTaskIds(toolCalls, options.peekNextTaskIds);
        const missingTaskIds = findMissingDispatchTaskIds(toolCalls, creatingTaskIds, options.getTaskById);
        if (missingTaskIds.length > 0) {
          setPlanningGateBlockCount(planningGateBlockCount + 1);
          // 非阻断提示：不再 return {done:true}（避免丢整轮 assistant 消息 + tool 结果 → [tool result missing]）。
          // dispatch 照常执行，返回"任务不存在"真实 ERROR，模型当轮即可看见并 create_task 纠正
          // （旧逻辑要连续丢 3 轮才放行，纯劣化）。
          leaderLogger.warn(`[PlanningGate] 提示：dispatch 引用了不存在的任务 ${missingTaskIds.join(', ')}（第 ${planningGateBlockCount} 次）；本次仍执行，dispatch 将返回"任务不存在"错误`);
          emitter.emit('leader:status', { sessionId, status: `⚠️ Planning Gate：任务 ${missingTaskIds.join(', ')} 不存在，请先 create_task` });
          options.addMessage({
            role: 'system',
            content: `[Planning Gate] 提示：你试图 dispatch 到以下不存在的任务：${missingTaskIds.join(', ')}。本次调用仍会执行并返回错误。\n\n正确流程：先 create_task 创建所有任务（一次性建完整个 DAG），再 dispatch 派发。可以在同一 batch 中同时调用 create_task 和 dispatch。`,
          });
        }
      }

      if (options.isUserInterruptPending()) {
        leaderLogger.info('[UserInterrupt] 检测到用户中断信号，跳过剩余工具调用');
        return { done: true };
      }
      // 记录本批将执行的 tool_calls（ask_user gate 可能已 splice 截断），
      // 供 persistToolMessage 判定「assistant + 全部 results 齐了」触发原子批写。
      currentBatchToolCalls = [...toolCalls];
      return null;
    },
    afterToolCalls: async ({ assistantContent, toolCallContext }) => {
      // 无条件 flush：无论 pendingToolResults 是否齐于 currentBatchSize。
      // 之前用 pendingToolResults.length >= currentBatchSize 做条件，
      // 当 executeToolCallsBatch 返回不完整结果时 flush 永不触发 → 全部悬内存 → 丢失。
      // flushBatch 内部已补齐缺失 tool results，可安全无条件调用。
      flushBatch();
      if (toolCallContext?.source !== 'raw_xml') toolResultsAcc.length = 0;
      if (toolCallContext?.source === 'raw_xml') return null;
      const continuation = await options.evaluateContinuationAfterStop({
        finishReason,
        content: contentToPlainText(assistantContent),
        continuationRole: 'system',
      });
      if (continuation) return continuation;
      return isStopFinishReason(finishReason) ? { done: true } : { done: false };
    },
    persistAssistantMessage: (message) => {
      // 上轮若因异常未 flush（防御）：先尽力写回，避免被本轮覆盖丢失；残缺由 resume heal 兜底。
      if (pendingAssistant) flushBatch();
      options.addMessage(message);
      const conv = options.getConversation();
      // 暂缓落库：攒齐 tool results 后由 persistToolMessage 触发原子批写。
      pendingAssistant = conv[conv.length - 1];
      pendingAssistantTs = Date.now() / 1000;
      pendingToolResults = [];
    },
    executeToolCallsBatch: (toolCalls) =>
      options.wasOutputTruncated
        ? executeToolCallsWithTruncationGuard(toolCalls, (calls) => options.executeToolCallsBatch(calls))
        : options.executeToolCallsBatch(toolCalls),
    emitToolCall: (toolCall) => {
      toolResultsAcc.push({
        id: toolCall.id || '',
        name: toolCall.function?.name || 'unknown',
        input: toolCall.function?.arguments || '',
      });
      emitter.emit('leader:tool_call', {
        sessionId,
        tool: toolCall.function.name,
        input: toolCall.function.arguments,
        callId: toolCall.id,
      });
    },
    transformToolResult: (_toolCall, rawResult) => rawResult,
    persistToolMessage: (message) => {
      options.addMessage(message);
      const conv = options.getConversation();
      pendingToolResults.push(conv[conv.length - 1]);
      // assistant 与其全部 tool results 齐了 → 原子事务批写（消除裂缝的核心）。
      // 用 pendingAssistant.tool_calls 的实际数量判定（而非 currentBatchToolCalls），
      // 因为 ask_user gate 可能已 splice 截断 toolCalls，两者可能不等。
      if (pendingAssistant && pendingToolResults.length >= (pendingAssistant.tool_calls?.length ?? 0)) {
        flushBatch();
      }
    },
    emitToolResult: (toolCall, renderedResult) => {
      const acc = toolResultsAcc.find((entry) => entry.id === toolCall.id);
      const renderedResultText = typeof renderedResult === 'string'
        ? renderedResult
        : contentToPlainText(renderedResult);
      if (acc) acc.result = renderedResultText.slice(0, 2000);
      emitter.emit('leader:tool_result', {
        sessionId,
        tool: toolCall.function.name,
        callId: toolCall.id,
        result: renderedResult,
        error: renderedResultText.startsWith('ERROR'),
      });
    },
    afterToolResult: async (toolCall) => {
      if (FILE_MODIFYING_TOOLS.has(toolCall.function.name)) {
        await options.createFileSnapshot?.(options.getTurnCount(), `[tool] Auto: ${toolCall.function.name}`);
      }
    },
    shouldStopAfterToolResult: () => {
      if (options.isWaitingForUser() || options.isPendingReview()) return { done: false };
      if (options.isFinished()) {
        // earlyStop 前强制 flush，防止 session 结束时 assistant + tool_results 悬在内存。
        flushBatch();
        return { done: true, result: 'Session finished' };
      }
      if (options.isAgentCompletionPending?.()) {
        // agent completion 信号触发 earlyStop → 跳过 afterToolCalls；
        // 此处强制 flush，确保 dispatch_batch 等工具的 tool_result 落 DB。
        flushBatch();
        leaderLogger.info('[AgentCompletion] 工具执行完毕后检测到 Agent 完成信号，中断当前轮次');
        return { done: true, result: 'agent_completion_pending' };
      }
      return null;
    },
    onEarlyStop: () => {
      // 第三道防线：覆盖 ToolScheduler.checkHighPriorityIntervention 短路 interrupted.done
      // 的场景——此时原始 shouldStopAfterToolResult 不被调用，afterToolCalls 也被跳过。
      // flushBatch 幂等：pendingAssistant 为 null（已在 persistToolMessage 中 flush）时直接返回。
      flushBatch();
    },
  });

  // pipeline-flush 契约：dispatch 完成（scheduler 创建完毕）后反注册 flush 回调。
  // scheduler.run() 是同步构造 + 异步执行；flush 在 run() 期间的 onEarlyStop/shouldStopAfterToolResult
  // 中已被调用。此处反注册防止 cleanupRegistry 持有已失效的闭包引用。
  // 注意：如果 gracefulShutdown 在 scheduler.run() 执行期间触发，
  // cleanupRegistry.runAll() 会调用 flushBatch（priority=0 最先执行），
  // 此时 flushBatch 仍在作用域内，正常 flush pending tool_results。
  unregisterLeaderFlush();

  return scheduler;
}
