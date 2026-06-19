import { z } from 'zod';
import { AssumptionTracker, type AssumptionVerificationType } from '../../core/AssumptionTracker.js';
import { Tool, createToolError, type ToolContext, type ToolResult } from '../Tool.js';

const VerificationTypeSchema = z.enum(['type_check', 'file_content', 'test_execution', 'ast_query']);

const DeclareAssumptionSchema = z.object({
  title: z.string().min(1).describe('Short human-readable title for the assumption.'),
  content: z.string().optional().describe('Optional explanation of the assumption and why it matters.'),
  verification_type: VerificationTypeSchema.describe('Executable verification type.'),
  target: z.string().min(1).describe('File/test/symbol target. For ast_query, use Symbol or file#Symbol.'),
  expected: z.string().min(1).describe('Exact expected evidence text. No regex or natural-language confidence.'),
  dependent_task_ids: z.array(z.string().min(1)).optional().describe('Task IDs whose work depends on this assumption.'),
});

type DeclareAssumptionParams = z.infer<typeof DeclareAssumptionSchema>;

function getTracker(context?: ToolContext): AssumptionTracker | null {
  if (context?.assumptionTracker) return context.assumptionTracker;
  if (!context?.db) return null;
  return new AssumptionTracker({
    db: context.db,
    emitter: context.emitter,
    sessionId: context.sessionId,
    projectRoot: context.taskWorkingDirectory || context.workspace,
  });
}

export class DeclareAssumptionTool extends Tool {
  readonly name = 'declare_assumption';
  readonly description = '声明一个可执行验证的假设。系统会在相关文件变化后自动验证；证伪时会把结构化证据反馈给 worker。';
  readonly parameters = DeclareAssumptionSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as DeclareAssumptionParams;
    const tracker = getTracker(context);
    if (!tracker) {
      return createToolError({
        code: 'ASSUMPTION_TRACKER_UNAVAILABLE',
        message: 'Assumption tracker requires database context.',
        retryable: false,
        cause: 'ToolContext.db is missing.',
        fix: 'Only use declare_assumption inside a worker/session runtime with database context.',
      });
    }

    const assumption = tracker.declare({
      title: params.title,
      content: params.content,
      verificationType: params.verification_type as AssumptionVerificationType,
      target: params.target,
      expected: params.expected,
      dependentTaskIds: params.dependent_task_ids ?? (context?.taskId ? [context.taskId] : []),
      createdBy: context?.agentId || context?.agentName,
      sessionId: context?.sessionId,
    });

    return {
      success: true,
      data: {
        assumption,
        next: 'The runtime will verify this assumption when the target file changes, or when verifyAll is invoked.',
      },
    };
  }
}
