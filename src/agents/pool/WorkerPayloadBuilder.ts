import type { DatabaseManager } from '../../core/Database.js';
import {
  ExecutionTraceMemory,
  extractProjectModelEvidence,
} from '../../core/ExecutionTraceMemory.js';
import type { ProjectExecutionModel } from '../../core/ExecutionTraceMemory.js';
import {
  buildSpeculativeOrchestrationPlan,
  renderSpeculativeOrchestrationPlan,
  type SpeculativeProjectEvidence,
} from '../../core/SpeculativeOrchestrationPlanner.js';
// v1.0.4: AdaptiveHarness removed — static defaults used inline
import { SESSION_KEYS } from '../../core/SessionStateKeys.js';
import { resolveModeRuntimeProjection } from '../../core/ModeRuntimeProjection.js';
import { enrichTaskContext } from '../../core/TaskContextEnricher.js';
import type { WorkNoteManager } from '../../core/WorkNoteManager.js';
import {
  renderContractPackManifestSection,
  renderContractPackSystemMessage,
  type ContractPack,
} from '../../core/ContractPack.js';
import { intersectContractScopes } from '../../core/ContractAllowedScope.js';
import type { WorkerTaskPayload } from '../../core/WorkerProcessRunner.js';
import type { Task as BoardTask } from '../../core/TaskBoard.js';
import type { AgentRole } from '../RoleRegistry.js';
import type { AgentHandle } from '../AgentPoolRuntime.js';
import { getPromptLocale } from '../prompts/i18n/catalog.js';
import { parseBlueprint, computeBlueprintCoverage, type ProjectBlueprint } from '../../core/ProjectBlueprint.js';
import { config as runtimeConfig } from '../../config.js';
import type { ChatMessage } from '../../llm/types.js';
import {
  estimateChatMessagesBytes,
  stripOldImageParts,
} from '../messageMemoryBudget.js';

type LoggerLike = {
  warn?: (msg: string, ...args: unknown[]) => void;
  info?: (msg: string, ...args: unknown[]) => void;
  debug?: (msg: string, ...args: unknown[]) => void;
};

type WorkerConversationHistory = NonNullable<WorkerTaskPayload['conversationHistory']>;

function normalizeWorkerHistoryForBudget(history: WorkerConversationHistory): ChatMessage[] {
  return history
    .filter((msg): msg is WorkerConversationHistory[number] & { role: ChatMessage['role'] } => (
      msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
    ))
    .map((msg) => ({
      role: msg.role,
      content: msg.content as ChatMessage['content'],
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls as ChatMessage['tool_calls'] } : {}),
      ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
      ...(msg.thinking ? { thinking: msg.thinking as ChatMessage['thinking'] } : {}),
      ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
    }));
}

function trimWorkerConversationHistory(
  history: WorkerConversationHistory | undefined,
  agentName: string,
  logger?: LoggerLike,
): WorkerConversationHistory | undefined {
  if (!history || history.length === 0) return undefined;

  const normalized = normalizeWorkerHistoryForBudget(history);
  if (normalized.length === 0) return undefined;

  // Only strip old image base64 payloads — do not remove any messages (including tool results).
  // Message trimming is exclusively handled by the compact path.
  const imageSafe = stripOldImageParts(normalized, {
    retainImageMessages: runtimeConfig.advanced.image_history_retain_rounds,
    protectedCount: 2,
  });

  if (imageSafe.length !== normalized.length) {
    const beforeBytes = estimateChatMessagesBytes(normalized);
    const afterBytes = estimateChatMessagesBytes(imageSafe);
    logger?.info?.(
      `[AgentPool] @${agentName} worker payload history image-stripped ${normalized.length}→${imageSafe.length} messages, ${beforeBytes}→${afterBytes} bytes`,
    );
  }
  return imageSafe as WorkerConversationHistory;
}

export interface WorkerPayloadBuilderInput {
  sessionId: string;
  workspace: string;
  db: DatabaseManager;
  workNoteManager: WorkNoteManager;
  handle: AgentHandle;
  task: BoardTask;
  role: AgentRole;
  agentModel: string;
  maxIterations: number;
  maxRuntimeMinutes: number;
  getBlackboardSnapshot?: () => string;
  getContractPack?: () => ContractPack | null;
  getChangeImpactContext?: (taskId: string, workingDir: string) => string;
  logger?: LoggerLike;
  options?: {
    conversationHistory?: WorkerTaskPayload['conversationHistory'];
    inheritHistoryMode?: 'resume' | 'new_task';
    logPrefix?: string;
  };
}

export async function loadInheritedWorkerHistory(input: {
  db: DatabaseManager;
  sessionId: string;
  agentId: string;
  agentName: string;
  logger?: LoggerLike;
}): Promise<WorkerTaskPayload['conversationHistory'] | undefined> {
  try {
    const history = await input.db.getAgentConversation(input.sessionId, input.agentId);
    if (!history || history.length === 0) {
      return undefined;
    }
    input.logger?.info?.(`[AgentPool] @${input.agentName} 复用同名 worker，继承 ${history.length} 条历史对话 (agentId=${input.agentId})`);
    const mapped = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
      tool_calls: msg.tool_calls,
      tool_call_id: msg.tool_call_id,
      thinking: msg.thinking,
      timestamp: msg.timestamp,
    }));
    return trimWorkerConversationHistory(mapped, input.agentName, input.logger);
  } catch (error) {
    input.logger?.warn?.(`[AgentPool] 加载 @${input.agentName} 继承历史失败: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function readCurrentContractPack(getContractPack: (() => ContractPack | null) | undefined, logger?: LoggerLike): ContractPack | null {
  try {
    return getContractPack?.() ?? null;
  } catch (error) {
    logger?.warn?.(`[AgentPool] Contract Pack 读取失败: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function buildWorkerSystemPrompt(basePrompt: string, contractPack: ContractPack | null): string {
  const contractPrompt = renderContractPackSystemMessage(contractPack);
  return [basePrompt, contractPrompt].filter((part) => part.trim()).join('\n\n');
}

export function stripSoloWorkerTeamInstructions(basePrompt: string): string {
  return basePrompt
    .split(/\r?\n/)
    .filter((line) => !/\bteam_manage\b|\bteam_message\b|\bteam_inbox\b|Team mailbox|Team 通信|Team 协作|团队通信|团队协作/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildProjectExecutionMemory(input: {
  db: DatabaseManager;
  projectRoot: string;
  evidenceFiles: string[];
  logger?: LoggerLike;
}): { section: string; evidence?: SpeculativeProjectEvidence; model?: ProjectExecutionModel } {
  if (typeof (input.db as { getDb?: unknown }).getDb !== 'function') {
    return { section: '' };
  }
  try {
    const memory = new ExecutionTraceMemory(input.db);
    const model = memory.getProjectModel(input.projectRoot);
    const evidence = extractProjectModelEvidence(model, input.evidenceFiles);
    if (
      evidence.hotspots.length === 0 &&
      evidence.fixPatterns.length === 0 &&
      evidence.timingBaselines.length === 0 &&
      evidence.taskTypeSuccessRates.length === 0
    ) {
      return { section: '', evidence, model };
    }
    return {
      section: [
        '### Project Execution Memory (persisted traces)',
        JSON.stringify({
          projectRoot: model.projectRoot,
          traceCount: model.traceCount,
          hotspots: evidence.hotspots,
          fixPatterns: evidence.fixPatterns,
          timingBaselines: evidence.timingBaselines,
          taskTypeSuccessRates: evidence.taskTypeSuccessRates,
        }, null, 2),
      ].join('\n'),
      evidence,
      model,
    };
  } catch (error) {
    input.logger?.warn?.(`[AgentPool] Project Execution Memory 注入跳过: ${error instanceof Error ? error.message : String(error)}`);
    return { section: '' };
  }
}

export async function buildWorkerPayload(input: WorkerPayloadBuilderInput): Promise<WorkerTaskPayload> {
  const options = input.options ?? {};
  const conversationHistory = trimWorkerConversationHistory(
    options.conversationHistory,
    input.handle.name,
    input.logger,
  );
  const leaderContextSummary = input.db
    ? (input.db.getSessionState(input.sessionId, SESSION_KEYS.LEADER_CONTEXT_SUMMARY) as string | null) ?? undefined
    : undefined;

  const modes = resolveModeRuntimeProjection({
    sessionId: input.sessionId,
    db: input.db,
    blackboardAvailable: Boolean(input.getBlackboardSnapshot),
  });
  const fullBlackboardAllowed = modes.blackboard.mode === 'full';
  const contractPack = fullBlackboardAllowed
    ? readCurrentContractPack(input.getContractPack, input.logger)
    : null;
  const contractPackPayload = contractPack
    ? {
        sessionId: contractPack.sessionId,
        contractsDir: contractPack.contractsDir,
        generatedAt: contractPack.generatedAt,
        entries: contractPack.entries,
      }
    : undefined;
  const contractManifest = renderContractPackManifestSection(contractPack);
  let enrichedContext = input.task.context || '';
  try {
    const blockedByTaskIds = input.task.blocked_by && input.task.blocked_by.length > 0 ? input.task.blocked_by : undefined;
    const enriched = await enrichTaskContext({
      sessionId: input.sessionId,
      existingContext: input.task.context,
      workingDirectory: input.task.working_directory,
      writeScope: input.task.write_scope,
      workNoteManager: input.workNoteManager,
      injectFileTree: false,
      blockedByTaskIds,
      blackboardSnapshot: fullBlackboardAllowed ? input.getBlackboardSnapshot?.() : undefined,
      manifestSections: contractManifest
        ? [{ title: 'Contract Pack', content: contractManifest }]
        : undefined,
      db: input.db,
      workspace: input.workspace,
    });
    enrichedContext = enriched.context;
  } catch (error) {
    input.logger?.warn?.(`[AgentPool] ${options.logPrefix || 'buildWorkerPayload'} enrichTaskContext 失败:`, error instanceof Error ? error.message : String(error));
  }

  if (input.getChangeImpactContext) {
    try {
      const impactContext = input.getChangeImpactContext(input.task.id, input.task.working_directory || input.workspace);
      if (impactContext) {
        enrichedContext = enrichedContext
          ? `${enrichedContext}\n\n### 变更影响分析 (Import Graph)\n${impactContext}`
          : impactContext;
      }
    } catch (error) {
      input.logger?.debug?.(`[AgentPool] ChangeImpact 注入跳过: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const projectMemory = buildProjectExecutionMemory({
    db: input.db,
    projectRoot: input.task.working_directory || input.workspace,
    evidenceFiles: input.task.write_scope || [],
    logger: input.logger,
  });
  if (projectMemory.section) {
    enrichedContext = enrichedContext
      ? `${enrichedContext}\n\n${projectMemory.section}`
      : projectMemory.section;
  }

  const speculativePlan = buildSpeculativeOrchestrationPlan({
    task: input.task,
    projectEvidence: projectMemory.evidence,
  });
  const speculativeSection = renderSpeculativeOrchestrationPlan(speculativePlan);
  if (speculativeSection) {
    enrichedContext = enrichedContext
      ? `${enrichedContext}\n\n${speculativeSection}`
      : speculativeSection;
  }

  // v1.0.4: AdaptiveHarness 移除——用静态默认值替代动态策略
  const adaptivePlan = {
    strategy: 'standard' as const,
    params: { maxRounds: 25, timeoutMs: 10 * 60_000, parallelToolCalls: true },
    signals: {},
  };
  // 不再注入 adaptive section 到 worker context

  // B-B: 注入蓝图定位段,让 Worker 知道自己在整体项目中的位置(防局部优化)。
  // 从 session state 读蓝图,反查 task 属于哪个子系统,投影定位 + 整体进度 + 依赖链。
  const blueprintSection = buildBlueprintLocatorSection(input.db, input.sessionId, input.task.id);
  if (blueprintSection) {
    enrichedContext = enrichedContext
      ? `${enrichedContext}\n\n${blueprintSection}`
      : blueprintSection;
  }

  const contractAllowedScope = contractPack
    ? intersectContractScopes(contractPack.entries.map(entry => entry.allowedScope))
    : undefined;
  // 派发时按当前 locale 选角色 system prompt（完全动态，对齐 leader 每 think 周期重读 locale）；
  // 缺 byLocale 映射时回落 systemPrompt（zh 默认）。
  const roleBasePrompt = input.role.systemPromptByLocale?.[getPromptLocale()] ?? input.role.systemPrompt;
  return {
    taskId: input.task.id,
    sessionId: input.sessionId,
    agentName: input.handle.name,
    agentId: input.handle.agentId,
    roleType: input.handle.roleType,
    systemPrompt: buildWorkerSystemPrompt(
      modes.collaboration.mode === 'team' && modes.collaboration.teamEnabled
        ? roleBasePrompt
        : stripSoloWorkerTeamInstructions(roleBasePrompt),
      contractPack,
    ),
    toolNames: input.role.tools,
    skillNames: input.role.skillNames,
    taskSubject: input.task.subject,
    taskDescription: input.task.description || '',
    workingDirectory: input.task.working_directory,
    writeScope: input.task.write_scope,
    model: input.agentModel,
    workspace: input.workspace,
    maxIterations: Math.max(adaptivePlan.params.maxRounds, input.maxIterations),
    maxRuntimeMinutes: Math.max(Math.ceil(adaptivePlan.params.timeoutMs / 60_000), input.maxRuntimeMinutes),
    leaderContextSummary,
    taskContext: enrichedContext,
    ...(contractPackPayload ? { contractPack: contractPackPayload } : {}),
    ...(contractAllowedScope ? { contractAllowedScope } : {}),
    adaptiveStrategy: adaptivePlan,
    ...(speculativePlan ? { speculativePlan } : {}),
    agentType: input.task.agent_type,
    ...(input.role.gitIdentity ? { gitIdentity: input.role.gitIdentity } : {}),
    ...(conversationHistory ? { conversationHistory } : {}),
    ...(options.inheritHistoryMode ? { inheritHistoryMode: options.inheritHistoryMode } : {}),
  };
}

/**
 * B-B: 构建 Worker 蓝图定位段。从 session state 读蓝图,反查 task 属于哪个子系统,
 * 投影「你负责的子系统 + 项目类型 + 整体进度 + 依赖你的子系统」。
 * 让 Worker 知道自己在整体项目中的位置,对抗局部优化。无蓝图/任务不在蓝图中时返回 null。
 */
function buildBlueprintLocatorSection(db: DatabaseManager, sessionId: string, taskId: string): string | null {
  try {
    const raw = db.getSessionState(sessionId, SESSION_KEYS.PROJECT_BLUEPRINT);
    const blueprint: ProjectBlueprint | null = parseBlueprint(raw);
    if (!blueprint) return null;
    // 反查 task 属于哪个子系统
    const entry = blueprint.subsystems.find((e) => e.taskIds.includes(taskId));
    if (!entry) return null;  // 任务不在蓝图中(无 subsystem 或子系统已删)
    const coverage = computeBlueprintCoverage(blueprint);
    const total = blueprint.subsystems.length;
    const implementedCount = coverage.implemented.length;
    const pct = total > 0 ? Math.round((implementedCount / total) * 100) : 0;
    // 找依赖本子系统的下游子系统
    const downstream = blueprint.subsystems
      .filter((e) => e.status === 'implement' && e.dependsOn?.includes(entry.subsystemId))
      .map((e) => e.subsystemId);
    const lines: string[] = [
      `[蓝图定位] 你负责的子系统: ${entry.subsystemId}(${entry.name}) · 整体进度: ${implementedCount}/${total} (${pct}%)`,
    ];
    if (entry.dependsOn && entry.dependsOn.length > 0) {
      lines.push(`  上游依赖子系统(应已完成): ${entry.dependsOn.join(', ')}`);
    }
    if (downstream.length > 0) {
      lines.push(`  下游等待你的子系统(你的交付会解锁): ${downstream.join(', ')}`);
    }
    lines.push(`  你的工作是整个项目蓝图的一部分,请确保接口/契约与上下游对齐,不要只做局部优化。`);
    return lines.join('\n');
  } catch {
    return null;
  }
}
