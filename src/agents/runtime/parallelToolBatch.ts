/**
 * 公共并行批量工具执行 helper。
 *
 * 历史上 BaseAgent / LeaderAgent / LeaderThinkingEngine 各自维护 PARALLEL_SAFE_TOOLS / FILE_MODIFYING_TOOLS
 * 与 canBatchExecuteToolCalls / executeToolCallsBatch，三处独立定义易漂移。这里收口三件事：
 *
 *   1. PARALLEL_SAFE_TOOLS 常量
 *      - BASE_PARALLEL_SAFE_TOOLS：BaseAgent 子类（worker）允许并行的只读工具
 *      - LEADER_PARALLEL_SAFE_TOOLS：Leader 额外允许 web_search / web_fetch / create_task 并行
 *   2. FILE_MODIFYING_TOOLS 常量：会修改工作区文件、需要触发 snapshot 的工具集合
 *   3. canBatchExecuteToolCalls / runToolCallsBatch 公共行为
 *      - canBatchExecuteToolCalls：长度 >1 且全部为 parallelSafe 时可批量
 *      - runToolCallsBatch：使用 Promise.race 并发池（默认上限 4，受 LINGXIAO_MAX_TOOL_CONCURRENCY
 *        覆盖），不可批量则退回顺序执行
 */
import type { ToolCall } from '../../llm/types.js';
import type { ToolResultContent } from './ToolResponseProcessor.js';
export {
  BASE_PARALLEL_SAFE_TOOLS,
  FILE_MODIFYING_TOOLS,
  LEADER_PARALLEL_SAFE_TOOLS,
} from '../../tools/ToolMetadata.js';
import {
  BASE_PARALLEL_SAFE_TOOLS,
  FILE_MODIFYING_TOOLS,
  LEADER_PARALLEL_SAFE_TOOLS,
} from '../../tools/ToolMetadata.js';

function errorToToolResult(error: unknown): ToolResultContent {
  const message = error instanceof Error ? error.message : String(error);
  return `ERROR: 工具执行异常: ${message}`;
}

/**
 * 当前批次是否可并行：长度 >1 且全部命中 parallelSafe 集合。
 * 单个调用没有并行收益、直接退回顺序执行。
 */
export function canBatchExecuteToolCalls(
  toolCalls: ToolCall[],
  parallelSafe: ReadonlySet<string>,
): boolean {
  return toolCalls.length > 1 && toolCalls.every(
    (toolCall) => parallelSafe.has(toolCall.function.name),
  );
}

/**
 * 解析并发上限：默认 4，可用环境变量 `LINGXIAO_MAX_TOOL_CONCURRENCY` 覆盖。
 * 非法值（NaN/0/负数）兜底回 4。
 */
function resolveMaxConcurrency(): number {
  const raw = Number(process.env.LINGXIAO_MAX_TOOL_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 4;
  }
  return Math.max(1, Math.floor(raw));
}

/**
 * 批量执行工具调用。
 * - 可批量：使用 Promise.race 并发池（默认 4），保留输入顺序写回结果
 * - 不可批量：顺序执行
 *
 * 该 helper 不直接调用 `BaseAgent.executeToolCall` / `LeaderAgent.executeToolCall`，
 * 而是接收一个 `executor` 闭包，避免对调用方类型耦合。
 */
export async function runToolCallsBatch(
  toolCalls: ToolCall[],
  executor: (toolCall: ToolCall) => Promise<ToolResultContent>,
  parallelSafe: ReadonlySet<string>,
): Promise<Array<{ toolCall: ToolCall; result: ToolResultContent }>> {
  const executeOne = async (toolCall: ToolCall): Promise<{ toolCall: ToolCall; result: ToolResultContent }> => {
    try {
      return { toolCall, result: await executor(toolCall) };
    } catch (error) {
      return { toolCall, result: errorToToolResult(error) };
    }
  };

  if (canBatchExecuteToolCalls(toolCalls, parallelSafe)) {
    const maxConcurrency = resolveMaxConcurrency();
    const results: Array<{ toolCall: ToolCall; result: ToolResultContent }> = new Array(toolCalls.length);
    const executing = new Set<Promise<void>>();

    for (let i = 0; i < toolCalls.length; i++) {
      const idx = i;
      const p = (async () => {
        results[idx] = await executeOne(toolCalls[idx]);
      })().finally(() => executing.delete(p));
      executing.add(p);
      if (executing.size >= maxConcurrency) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
    return results;
  }

  const results: Array<{ toolCall: ToolCall; result: ToolResultContent }> = [];
  for (const toolCall of toolCalls) {
    results.push(await executeOne(toolCall));
  }
  return results;
}
