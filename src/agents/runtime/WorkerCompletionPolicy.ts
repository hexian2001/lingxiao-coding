import {
  contentToPlainText,
  type ChatMessage,
  type ToolDefinition,
} from '../../llm/types.js';
import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import type { Task } from '../BaseAgentRuntime.js';
import { agentLogger } from '../../core/Log.js';
import { summarizeRecentMessages } from './messageSummary.js';
import { runStructuredJudgment } from '../../core/JudgmentService.js';
import { getConfigValue } from '../../config.js';
import type { VerificationResult } from '../../core/VerificationPipeline.js';
import { createLlmGuard } from '../LlmGuard.js';
import { isWorkerContractComplianceStatus } from '../../core/AgentProtocol.js';
import { getPromptCatalog, type PromptLocale } from '../prompts/i18n/catalog.js';

export interface WorkerCompletionDecision {
  accepted: boolean;
  reason?: string;
  feedback: string;
}

export interface EvaluateWorkerCompletionCandidateInput {
  final: string;
  task: Task;
  role: string;
  messages: ChatMessage[];
  contractCompliance?: unknown;
  llm?: ContentGenerator;
  model?: string;
  /** 构建诊断结果 (由 BuildDiagnosticsCollector 提供, 为空则跳过检查) */
  buildDiagnostics?: { passed: boolean; errors: Array<{ file: string; line: number; message: string; code?: string }> };
  /** 强制验证管线结果。存在且未通过时，语义 LLM judge 不得接受完成。 */
  verification?: VerificationResult;
  /** B4: task 是否有契约 allowedScope——有则强制开 judge(无视 worker_completion_judge_enabled 全局开关)。 */
  hasContractAllowedScope?: boolean;
  locale?: PromptLocale;
}

// ─── 结构化检查（无 regex） ───

/** 文本是否为空或过短（不包含实质内容）*/
export function isWorkInProgressCompletionText(text: string): boolean {
  if (!text) {
    return true;
  }
  const trimmed = text.trim();
  // 空或极短文本不是有效完成
  return trimmed.length < 8;
}

/** 最近一次工具结果是否是 ERROR */
export function getLatestToolError(messages: ChatMessage[]): string | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'tool') {
      continue;
    }
    const content = contentToPlainText(message.content).trim();
    return content.startsWith('ERROR:') ? content : null;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasStructuredContractComplianceProof(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const surface = isNonEmptyString(record.surface) ? record.surface.trim() : '';
  const status = isNonEmptyString(record.status) ? record.status.trim() : '';
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.filter(isNonEmptyString)
    : [];
  return Boolean(surface && isWorkerContractComplianceStatus(status) && evidence.length > 0);
}

function fieldValue(line: string, field: string): string | null {
  const trimmed = line.trim();
  const prefix = `${field}:`;
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  return trimmed.slice(prefix.length).trim();
}

export function hasContractComplianceProofText(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## 契约遵守证明');
  if (start < 0) return false;

  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith('## ')) break;
    section.push(line);
  }

  const surface = section.map((line) => fieldValue(line, 'surface')).find((value): value is string => Boolean(value));
  const status = section.map((line) => fieldValue(line, 'status')).find((value): value is string => Boolean(value));
  const hasEvidenceField = section.some((line) => fieldValue(line, 'evidence') !== null);
  const inlineEvidence = section
    .map((line) => fieldValue(line, 'evidence'))
    .find((value): value is string => Boolean(value));
  const bulletEvidence = hasEvidenceField && section.some((line) => line.trim().startsWith('- ') && line.trim().slice(2).trim().length > 0);
  const hasDeviationsField = section.some((line) => fieldValue(line, 'deviations') !== null);

  return Boolean(
    surface &&
    status &&
    isWorkerContractComplianceStatus(status) &&
    hasEvidenceField &&
    (inlineEvidence || bulletEvidence) &&
    hasDeviationsField,
  );
}

function expectedContractSurface(task: Task): string {
  const binding = (task as Task & { orchestration?: { contractBinding?: { surface?: unknown } } }).orchestration?.contractBinding;
  return isNonEmptyString(binding?.surface) ? binding.surface.trim() : `task:${task.id}`;
}

function missingContractComplianceFeedback(task: Task): string {
  const surface = expectedContractSurface(task);
  return [
    '缺少“契约遵守证明”，不能收尾。请继续完成任务，并在最终收尾中使用 attempt_completion.contract_compliance，或输出以下机器可检格式：',
    '## 契约遵守证明',
    `surface: ${surface}`,
    'status: complied | upgraded | blocked | not_applicable',
    'evidence:',
    '- 写出真实文件、命令、测试、报告或契约节点证据',
    'deviations:',
    '- 无；如有偏离，说明偏离原因和影响',
  ].join('\n');
}

/**
 * 硬运行时守卫。
 * 这里不做语义完成度判断，只拦截结构上不可能完成的情况。
 */
export function evaluateWorkerCompletionHardGuards(input: EvaluateWorkerCompletionCandidateInput): WorkerCompletionDecision | null {
  const trimmed = input.final.trim();

  if (isWorkInProgressCompletionText(trimmed)) {
    return {
      accepted: false,
      reason: 'final_text_still_describes_future_work',
      feedback: '你刚才输出的是工作计划，不是任务完成证明。继续执行，完成后给出实际产出。',
    };
  }

  const latestToolError = getLatestToolError(input.messages);
  if (latestToolError) {
    return {
      accepted: false,
      reason: 'latest_tool_result_is_error',
      feedback: `最近一次工具结果仍然报错，请先修复。错误: ${latestToolError.slice(0, 300)}`,
    };
  }

  if (
    !hasStructuredContractComplianceProof(input.contractCompliance) &&
    !hasContractComplianceProofText(trimmed)
  ) {
    return {
      accepted: false,
      reason: 'missing_contract_compliance_proof',
      feedback: missingContractComplianceFeedback(input.task),
    };
  }

  if (input.verification && !input.verification.allPassed) {
    const failedGates = input.verification.gates.filter((gate) => !gate.passed);
    const diagnostics = failedGates.flatMap((gate) => gate.diagnostics.map((line) => `${gate.gate}: ${line}`));
    const gateSummary = failedGates.map((gate) => gate.gate).join(', ') || 'unknown';
    return {
      accepted: false,
      reason: 'verification_gate_failed',
      feedback: [
        `强制验证门控未通过: ${gateSummary}`,
        ...diagnostics.slice(0, 12).map((line) => `- ${line}`),
        '',
        '请修复以上确定性验证失败后重新调用 attempt_completion。',
      ].join('\n').trim(),
    };
  }

  // 构建诊断闸：如果提供了 buildDiagnostics 且未通过，拒绝完成。
  // 判定条件是确定性的: passed === false (由真实 build 工具 exit code 决定)。
  if (input.buildDiagnostics && !input.buildDiagnostics.passed) {
    const topErrors = input.buildDiagnostics.errors.slice(0, 5);
    const errorSummary = topErrors
      .map(e => `  ${e.file}:${e.line} ${e.code ? `[${e.code}]` : ''} ${e.message}`)
      .join('\n');
    return {
      accepted: false,
      reason: 'build_diagnostics_failed',
      feedback: `构建诊断失败 (${input.buildDiagnostics.errors.length} errors):\n${errorSummary}\n\n请修复以上编译错误后重新完成任务。`,
    };
  }

  return null;
}

export function evaluateWorkerCompletionCandidateFallback(input: EvaluateWorkerCompletionCandidateInput): WorkerCompletionDecision {
  return evaluateWorkerCompletionHardGuards(input) ?? {
    accepted: true,
    reason: 'hard_guards_passed',
    feedback: '',
  };
}

function isWorkerCompletionJudgeEnabled(hasContractAllowedScope?: boolean): boolean {
  if (getConfigValue('agents.worker_completion_judge_enabled') === true) return true;
  // B4: 契约驱动门控——有 allowedScope 的实现型任务强制语义 judge(契约=高信任要求,必须核对 worker 真按契约做)。
  if (getConfigValue('verification.judge_gated_by_contract') !== false && hasContractAllowedScope) return true;
  return false;
}

// ─── LLM-based judge ───

function buildWorkerCompletionVerdictTool(locale?: PromptLocale): ToolDefinition {
  const catalog = getPromptCatalog(locale).judges.workerCompletion;
  return {
    type: 'function',
    function: {
      name: 'submit_completion_verdict',
      description: catalog.toolDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: {
            type: 'boolean',
          },
          reason: {
            type: 'string',
            description: catalog.reasonDescription,
          },
          feedback: {
            type: 'string',
            description: catalog.feedbackDescription,
          },
        },
        required: ['accepted', 'reason', 'feedback'],
      },
    },
  };
}

function buildWorkerCompletionJudgeMessages(input: EvaluateWorkerCompletionCandidateInput): ChatMessage[] {
  const catalog = getPromptCatalog(input.locale).judges.workerCompletion;
  return [
    {
      role: 'system',
      content: catalog.system,
    },
    {
      role: 'user',
      content: [
        `worker_role: ${input.role}`,
        `task_subject: ${input.task.subject}`,
        `task_description: ${input.task.description}`,
        '',
        '[worker_final_text]',
        input.final || '(empty)',
        '[/worker_final_text]',
        '',
        '[recent_context]',
        summarizeRecentMessages(input.messages),
        '[/recent_context]',
      ].join('\n'),
    },
  ];
}

function validateWorkerCompletionVerdict(parsed: unknown): WorkerCompletionDecision | null {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const accepted = 'accepted' in parsed ? parsed.accepted : undefined;
  const reason = 'reason' in parsed ? parsed.reason : undefined;
  const feedback = 'feedback' in parsed ? parsed.feedback : undefined;
  if (typeof accepted !== 'boolean' || typeof reason !== 'string' || typeof feedback !== 'string') {
    return null;
  }

  return {
    accepted,
    reason,
    feedback,
  };
}

export async function evaluateWorkerCompletionCandidate(
  input: EvaluateWorkerCompletionCandidateInput,
): Promise<WorkerCompletionDecision> {
  const hardGuard = evaluateWorkerCompletionHardGuards(input);
  if (hardGuard) {
    return hardGuard;
  }

  if (!isWorkerCompletionJudgeEnabled(input.hasContractAllowedScope)) {
    return {
      accepted: true,
      reason: 'deterministic_hard_guards_passed',
      feedback: '',
    };
  }

  const result = await runStructuredJudgment({
    kind: 'worker_completion',
    llm: input.llm,
    model: input.model,
    messages: buildWorkerCompletionJudgeMessages(input),
    tool: buildWorkerCompletionVerdictTool(input.locale),
    validate: validateWorkerCompletionVerdict,
    llmGuardFactory: createLlmGuard,
    logger: agentLogger,
    gatewayContext: {
      actorType: 'agent',
      actorLabel: 'WorkerCompletionJudge',
      purpose: 'verify',
      sessionId: input.task.session_id,
      taskId: input.task.id,
      role: input.role,
      requestedModel: input.model,
    },
  });
  if (result.verdict) {
    return result.verdict;
  }

  return {
    accepted: true,
    reason: result.status === 'unavailable' ? 'judge_unavailable_hard_guards_passed' : 'judge_invalid_hard_guards_passed',
    feedback: '',
  };
}
