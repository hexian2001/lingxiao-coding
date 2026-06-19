import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import type { ToolRegistry } from '../Registry.js';
import { getToolMetadata, isParallelSafeTool } from '../ToolMetadata.js';

const BatchOperationSchema = z.object({
  id: z.string().optional().describe('调用标识，便于在结果中对应'),
  tool: z.string().describe('只读且 parallelSafe 的工具名'),
  args: z.unknown().optional().describe('工具参数'),
});

const ParallelReadBatchSchema = z.object({
  operations: z.array(BatchOperationSchema).min(1).max(20).describe('要并行执行的只读工具调用'),
  max_concurrency: z.number().int().min(1).max(8).optional().default(4).describe('并发上限，默认 4'),
  allow_network: z.boolean().optional().default(false).describe('网络工具默认关闭；显式设为 true 后参与批处理'),
});

type AcceptedBatchOperation = { index: number; id: string; tool: string; args: unknown };

export class ParallelReadBatchTool extends Tool {
  readonly name = 'parallel_read_batch';
  readonly description = '显式并行只读批处理：并行执行 file_read/list_dir/glob/code_search 等安全读工具；写入、危险、非 parallelSafe 或预检失败的项会被跳过并在 rejected 中说明。';
  readonly parameters = ParallelReadBatchSchema;

  constructor(private readonly registry: ToolRegistry) {
    super();
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof ParallelReadBatchSchema>;
    const rejected: Array<{ index: number; id?: string; tool: string; reason: string; preflight?: unknown }> = [];
    const accepted = params.operations.map((op, index): AcceptedBatchOperation | null => {
      const preflight = this.registry.preflight(op.tool, op.args ?? {}, context);
      const meta = getToolMetadata(preflight.tool);
      const allowed =
        preflight.ok &&
        meta.readOnly === true &&
        meta.modifiesWorkspace !== true &&
        meta.dangerous !== true &&
        isParallelSafeTool(preflight.tool) &&
        (params.allow_network === true || meta.requiresNetwork !== true);
      if (!allowed) {
        rejected.push({
          index,
          id: op.id,
          tool: op.tool,
          reason: preflight.ok
            ? '工具不是安全并行只读工具，或需要网络/权限。'
            : preflight.repair?.message || '预检失败。',
          preflight,
        });
        return null;
      }
      return {
        index,
        id: op.id ?? String(index),
        tool: preflight.tool,
        args: preflight.normalizedArgs ?? op.args ?? {},
      };
    }).filter((op): op is AcceptedBatchOperation => op !== null);

    if (accepted.length === 0) {
      return {
        success: false,
        data: { rejected, accepted_count: 0 },
        error: `parallel_read_batch 没有可执行的安全只读调用；已跳过 ${rejected.length} 个不适合并行读取的调用。`,
      };
    }

    const max = params.max_concurrency ?? 4;
    const results: Array<{ index: number; id: string; tool: string; result: ToolResult }> = new Array(accepted.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(max, accepted.length) }, async () => {
      while (cursor < accepted.length) {
        const current = cursor++;
        const op = accepted[current];
        results[current] = {
          index: op.index,
          id: op.id,
          tool: op.tool,
          result: await this.registry.execute(op.tool, op.args, context),
        };
      }
    });
    await Promise.all(workers);

    return {
      success: true,
      data: {
        count: results.length,
        accepted_count: accepted.length,
        rejected_count: rejected.length,
        rejected,
        results,
      },
    };
  }
}

export default ParallelReadBatchTool;
