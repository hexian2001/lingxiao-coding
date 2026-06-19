import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import { analyzeWorkflow } from '../../../core/workflow/WorkflowAnalyzer.js';

const WorkflowAuditSchema = z.object({
  workflow_id: z.string().describe('Workflow ID to audit'),
  include_dify_parity: z.boolean().default(true).describe('Include Dify capability parity notes'),
}).strict();

export class WorkflowAuditTool extends Tool {
  readonly name = '__workflow_delegate_audit';
  readonly description = `审计 workflow 的 Dify 对标能力、DAG 结构风险、节点配置完整性和 LLM 后续操作建议。

返回：
- summary: 图规模、节点类型分布、入口/出口
- difyParity: 与 Dify Workflow/Chatflow 节点能力的支持/部分支持/缺口
- issues: error/warning/info 风险清单
- nextSuggestedActions: LLM 可直接执行的下一步工具调用`;

  readonly parameters = WorkflowAuditSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowAuditSchema.parse(args);
    const workflowManager = context?.workflowManager as { get: (id: string) => Promise<import('../../../core/workflow/types.js').WorkflowDefinition | undefined> } | undefined;
    if (!workflowManager) {
      return { success: false, data: null, error: 'WorkflowManager not available in context' };
    }

    try {
      const workflow = await workflowManager.get(params.workflow_id);
      if (!workflow) {
        return { success: false, data: null, error: `Workflow not found: ${params.workflow_id}` };
      }
      const analysis = analyzeWorkflow(workflow);
      return {
        success: analysis.issues.every(issue => issue.severity !== 'error'),
        data: {
          workflowId: workflow.id,
          valid: analysis.issues.every(issue => issue.severity !== 'error'),
          summary: analysis.summary,
          difyParity: params.include_dify_parity ? analysis.difyParity : undefined,
          issues: analysis.issues,
          nextSuggestedActions: analysis.nextSuggestedActions,
          llmDslHint: analysis.llmDslHint,
        },
        error: analysis.issues.some(issue => issue.severity === 'error')
          ? `Workflow has ${analysis.issues.filter(issue => issue.severity === 'error').length} blocking issue(s)`
          : undefined,
      };
    } catch (error) {
      return { success: false, data: null, error: error instanceof Error ? error.message : 'Failed to audit workflow' };
    }
  }
}
