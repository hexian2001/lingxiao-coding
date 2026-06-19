/**
 * AttemptCompletionTool — Agent 主动汇报任务完成
 *
 * Agent 必须调用此工具来声明任务完成。框架不再通过 LLM Judge 被动猜测完成状态。
 * 工具内部做基本校验（如信息收集任务需要真实收集结果），通过后标记为完成。
 *
 * 结构化字段（summary / artifacts / verification / next_steps）会被框架解析后
 * 透传给 Leader，让 Leader 一眼看清"任务做完了什么 + 改动了哪些文件 + 怎么验证的"。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import type { ToolMetadata } from '../ToolMetadata.js';
import {
  isWorkerContractComplianceStatus,
  type WorkerContractComplianceProof,
} from '../../core/AgentProtocol.js';

const ArtifactsSchema = z
  .object({
    files_modified: z
      .array(z.string())
      .optional()
      .describe('本次任务实际修改过的文件路径列表（绝对路径或仓库相对路径）'),
    files_created: z
      .array(z.string())
      .optional()
      .describe('本次任务新创建的文件路径列表'),
    commands_run: z
      .array(z.string())
      .optional()
      .describe('执行过的关键命令（构建/测试/部署等），用于让 Leader 复核'),
  })
  .optional()
  .describe('本次任务的可见产物清单，包含 Leader 验收所需的关键文件和命令。');

const VerificationItemSchema = z.object({
  kind: z
    .enum(['build', 'test', 'lint', 'typecheck', 'manual', 'screenshot', 'other'])
    .describe('验证类别'),
  detail: z.string().describe('具体证据，如命令、退出码、测试名、截图路径等'),
  passed: z.boolean().optional().describe('该项验证是否通过（未填默认视为 true）'),
});

const ContractComplianceSchema = z.object({
  surface: z
    .string()
    .min(1)
    .describe('本任务遵守/产出/升级的契约 surface；无跨栈契约时使用 task:<taskId>'),
  status: z
    .enum(['complied', 'upgraded', 'blocked', 'not_applicable'])
    .describe('契约遵守结论：已遵守/已升级/被阻塞/不适用'),
  evidence: z
    .array(z.string().min(1))
    .min(1)
    .describe('证明该结论的证据，如文件路径、命令、测试、报告、graph_contract 或 work_note'),
  deviations: z
    .array(z.string().min(1))
    .optional()
    .describe('偏离契约之处；无偏离时可写 ["无"]'),
});

const AttemptCompletionSchema = z.object({
  summary: z
    .string()
    .describe('一句话总结你完成了什么——Leader 在 UI 上看到的就是这一行'),
  verdict: z
    .enum(['PASS', 'FAIL', 'BLOCKED'])
    .optional()
    .describe('验收结论（仅 evaluator/review 任务使用）。普通实现任务不需要填写。evaluator 必须填写此字段以结构化输出验收结论。'),
  artifacts: ArtifactsSchema,
  verification: z
    .array(VerificationItemSchema)
    .optional()
    .describe('完成证据列表；至少应包含一项（编译/测试/手测），无法验证时显式说明'),
  evidence_refs: z
    .array(z.string())
    .optional()
    .describe('证据/资源引用，如 MCP resource URI、网页 URL、截图路径、报告路径或外部工具结果 ID'),
  contract_compliance: ContractComplianceSchema
    .describe('必填。契约遵守证明；每个任务收尾都必须生成，系统会据此拦截无证明完成。'),
  next_steps: z
    .array(z.string())
    .optional()
    .describe('给 Leader 的后续建议，如"等待 review"、"需要部署到 staging"等'),
  blocked_by_discovery: z
    .array(z.string().min(1))
    .optional()
    .describe('执行中发现的新依赖/阻塞说明。填写后 Leader 会据此更新依赖或创建后续任务，不代表自动派发。'),
  needs_leader_coordination: z
    .boolean()
    .optional()
    .describe('当需要 Leader 协调其他 worker、用户决策或跨任务依赖时设为 true。'),
  result: z
    .string()
    .optional()
    .describe(
      '可选的完整结果说明（Markdown）。如不提供，框架会自动用 summary + artifacts + verification 渲染。',
    ),
});

export type AttemptCompletionParams = z.infer<typeof AttemptCompletionSchema>;

export interface AttemptCompletionStructuredResult {
  summary: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  artifacts: {
    files_modified: string[];
    files_created: string[];
    commands_run: string[];
  };
  verification: Array<{
    kind: string;
    detail: string;
    passed: boolean;
  }>;
  next_steps: string[];
  blocked_by_discovery: string[];
  needs_leader_coordination: boolean;
  evidence_refs: string[];
  contract_compliance: WorkerContractComplianceProof;
  /** 渲染后的 Markdown 文本，可直接展示给 Leader */
  rendered: string;
}

/**
 * 把结构化字段渲染成 Markdown 文本，作为 Leader 可读的 result 字符串。
 * Leader 端展示和上游 result 消费使用同一份渲染结果。
 */
export function renderAttemptCompletion(params: AttemptCompletionParams): string {
  const lines: string[] = [];
  if (params.summary?.trim()) {
    lines.push(`## 完成摘要\n${params.summary.trim()}`);
  }

  const filesModified = params.artifacts?.files_modified ?? [];
  const filesCreated = params.artifacts?.files_created ?? [];
  const commandsRun = params.artifacts?.commands_run ?? [];
  if (filesModified.length || filesCreated.length || commandsRun.length) {
    const block: string[] = ['## 产物'];
    if (filesCreated.length) {
      block.push('**新建文件:**');
      block.push(...filesCreated.map((p) => `- ${p}`));
    }
    if (filesModified.length) {
      block.push('**修改文件:**');
      block.push(...filesModified.map((p) => `- ${p}`));
    }
    if (commandsRun.length) {
      block.push('**执行命令:**');
      block.push(...commandsRun.map((c) => `- \`${c}\``));
    }
    lines.push(block.join('\n'));
  }

  if (params.verification && params.verification.length > 0) {
    const block: string[] = ['## 验证证据'];
    for (const v of params.verification) {
      const status = v.passed === false ? '❌' : '✅';
      block.push(`- ${status} **${v.kind}**: ${v.detail}`);
    }
    lines.push(block.join('\n'));
  }

  if (params.evidence_refs && params.evidence_refs.length > 0) {
    const block: string[] = ['## 证据引用'];
    block.push(...params.evidence_refs.map((ref) => `- ${ref}`));
    lines.push(block.join('\n'));
  }

  if (params.contract_compliance) {
    const proof = params.contract_compliance;
    const block: string[] = ['## 契约遵守证明'];
    block.push(`surface: ${proof.surface.trim()}`);
    block.push(`status: ${proof.status}`);
    block.push('evidence:');
    block.push(...proof.evidence.map((item) => `- ${item.trim()}`).filter((item) => item !== '- '));
    block.push('deviations:');
    const deviations = proof.deviations && proof.deviations.length > 0 ? proof.deviations : ['无'];
    block.push(...deviations.map((item) => `- ${item.trim()}`).filter((item) => item !== '- '));
    lines.push(block.join('\n'));
  }

  if (params.next_steps && params.next_steps.length > 0) {
    const block: string[] = ['## 后续建议'];
    block.push(...params.next_steps.map((s) => `- ${s}`));
    lines.push(block.join('\n'));
  }

  // 优先用调用方提供的 result，否则用结构化字段渲染
  if (params.result?.trim()) {
    lines.push(`## 详细说明\n${params.result.trim()}`);
  }

  return lines.join('\n\n').trim();
}

/**
 * 规范化结构化字段，保证下游拿到的形状稳定（数组绝不为 undefined）。
 */
export function normalizeAttemptCompletion(
  params: AttemptCompletionParams,
): AttemptCompletionStructuredResult {
  const contractCompliance = params.contract_compliance;
  return {
    summary: params.summary?.trim() ?? '',
    verdict: params.verdict,
    artifacts: {
      files_modified: params.artifacts?.files_modified ?? [],
      files_created: params.artifacts?.files_created ?? [],
      commands_run: params.artifacts?.commands_run ?? [],
    },
    verification: (params.verification ?? []).map((v) => ({
      kind: v.kind,
      detail: v.detail,
      passed: v.passed !== false,
    })),
    evidence_refs: params.evidence_refs ?? [],
    contract_compliance: {
      surface: contractCompliance.surface.trim(),
      status: contractCompliance.status,
      evidence: contractCompliance.evidence.map((item) => item.trim()).filter(Boolean),
      deviations: (contractCompliance.deviations ?? ['无']).map((item) => item.trim()).filter(Boolean),
    },
    next_steps: params.next_steps ?? [],
    blocked_by_discovery: params.blocked_by_discovery ?? [],
    needs_leader_coordination: params.needs_leader_coordination === true,
    rendered: renderAttemptCompletion(params),
  };
}

export class AttemptCompletionTool extends Tool {
  readonly name = 'attempt_completion';
  readonly description = '声明当前 task 已完成并提交最终结果。Worker 唯一的任务收尾入口——不调用则框架不判定完成。必填：summary + contract_compliance。调用后 Worker 进程立即结束当前 task。字段说明见各参数 schema description。进度汇报用 send_message(report)。';
  readonly parameters = AttemptCompletionSchema;
  readonly metadata: ToolMetadata = {
    tier: 'read',
    category: 'general',
    visibility: 'all',
    core: true,
  };

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    const params = args as AttemptCompletionParams;

    if (!params || typeof params !== 'object') {
      return {
        success: false,
        data: null,
        error: 'attempt_completion 入参缺失。请提供至少 summary 字段，描述你完成了什么。',
      };
    }

    const summary = (params.summary ?? '').trim();
    if (summary.length < 8) {
      return {
        success: false,
        data: null,
        error:
          '完成摘要 (summary) 过短，请提供有意义的一句话总结（至少 8 个字符），例如："实现 UserService 软删除并补齐单测"。',
      };
    }

    const proof = params.contract_compliance;
    const proofRecord = proof && typeof proof === 'object' ? proof as Record<string, unknown> : undefined;
    const surface = typeof proofRecord?.surface === 'string' ? proofRecord.surface.trim() : '';
    const status = typeof proofRecord?.status === 'string' ? proofRecord.status.trim() : '';
    const evidence = Array.isArray(proofRecord?.evidence)
      ? proofRecord.evidence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (!surface || !isWorkerContractComplianceStatus(status) || evidence.length === 0) {
      return {
        success: false,
        data: null,
        error:
          '缺少有效的契约遵守证明 (contract_compliance)。请提供 surface、status(complied/upgraded/blocked/not_applicable) 和至少一条 evidence；无跨栈契约时 surface 使用 task:<taskId>。',
      };
    }

    const structured = normalizeAttemptCompletion(params);

    return {
      success: true,
      // data 同时携带结构化与 rendered，BaseAgent 会读取 data.rendered 写入 task result
      // 且会读取 data.summary/artifacts/verification/next_steps 透传给 Leader
      data: structured,
    };
  }
}

export default AttemptCompletionTool;
