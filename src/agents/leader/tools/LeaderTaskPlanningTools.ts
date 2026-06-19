/**
 * Leader 的任务规划族工具实现。
 *
 * 把 LeaderToolsExecutor 中的下面这些方法抽成模块级函数：
 *   - create_task / update_task / delete_task / update_task_status
 *   - define_agent_role / materializeRoleDefinition（define_agent_role + create_task 内联使用）
 *   - list_available_roles
 *
 * dispatchAgent 状态副作用最重（scheduler / setDelegateMode / capability 重写），
 * 仍留在 LeaderToolsExecutor 内部。
 */

import type { LeaderAgent } from '../../LeaderAgent.js';
import type { Task as BoardTask, TaskScopeConfig } from '../../../core/TaskBoard.js';
import type {
  OrchestrationContractBinding,
  OrchestrationTaskMetadata,
  OrchestrationNodeKind,
} from '../../../core/OrchestrationTypes.js';
import { SESSION_KEYS } from '../../../core/SessionStateKeys.js';
import { leaderLogger } from '../../../core/Log.js';
import { isAgentRuntimeActiveStatus, normalizeTaskStatusUpdateTarget } from '../../../contracts/adapters/StatusAdapter.js';
import { WorktreeService, type WorktreeView } from '../../../core/WorktreeService.js';
import { resolveModeRuntimeProjection } from '../../../core/ModeRuntimeProjection.js';
import { DatabaseRepositoryAdapter } from '../../../core/DatabaseRepositories.js';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fail } from '../LeaderToolFailure.js';
import { resolveRoleFromName, ROLE_FALLBACK_DEFAULT } from '../../RoleRegistry.js';
import { PRESET_ROLE_PROFILES } from '../../RoleCapabilityModel.js';
import {
  normalizeBlueprint,
  serializeBlueprint,
  parseBlueprint,
  computeBlueprintCoverage,
  renderBlueprintScaffold,
  registerTaskId,
  unregisterTaskId,
  buildSubsystemContractSeeds,
  type SubsystemContractSeed,
} from '../../../core/ProjectBlueprint.js';

export interface TaskPlanningContext {
  leader: LeaderAgent;
  /** 把 LLM 输入的 agent name 归一化到 AgentPool 内部 key */
  normalizeAgentName(name: string): string;
  /** dispatchAgent 仍在 LeaderToolsExecutor 内部，必要时可被回调 */
  dispatchAgent(args: Record<string, unknown>): Promise<string>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function pickContractSurface(contract: Record<string, unknown> | undefined, fallback: string): string {
  const candidates = [
    contract?.surface,
    contract?.contract_surface,
    contract?.id,
    contract?.name,
    contract?.title,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeOptionalString(candidate);
    if (normalized) return normalized;
  }
  return fallback;
}

function normalizeContractContent(contract: Record<string, unknown> | undefined, evaluationPolicy: Record<string, unknown> | undefined): string {
  if (contract && typeof contract.content === 'string' && !evaluationPolicy) {
    return contract.content;
  }
  return JSON.stringify({
    contract: contract ?? null,
    evaluation_policy: evaluationPolicy ?? null,
  }, null, 2);
}

function writeContractNodeToBlackboard(ctx: TaskPlanningContext, input: {
  taskId: string;
  subject: string;
  agentType: string;
  contract?: Record<string, unknown>;
  evaluationPolicy?: Record<string, unknown>;
  surface?: string;
}): void {
  if (!input.contract && !input.evaluationPolicy) return;
  try {
    const blackboard = (ctx.leader as unknown as { leaderBlackboard?: { blackboardGraph?: { addContract?: (input: unknown) => unknown } } }).leaderBlackboard;
    const graph = blackboard?.blackboardGraph;
    if (!graph?.addContract) return;
    const contractTitle = normalizeOptionalString(input.contract?.title) ?? input.subject;
    const contractContent = normalizeContractContent(input.contract, input.evaluationPolicy);
    const surface = input.surface ?? input.taskId;
    graph.addContract({
      sessionId: ctx.leader.sessionId,
      title: `Contract: ${contractTitle}`,
      content: contractContent,
      tags: [`contract:${surface}`, `contract:${input.taskId}`, `task:${input.taskId}`, `agent:${input.agentType}`],
      createdBy: input.taskId,
    });
  } catch (err) {
    leaderLogger.warn(`[LeaderTools] contract 节点写入失败 (task=${input.taskId}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

type ContractTemplateResult = {
  ok: true;
  contract?: Record<string, unknown>;
  evaluationPolicy?: Record<string, unknown>;
  surface?: string;
  version?: number;
  requestId?: string;
  binding?: OrchestrationContractBinding;
  acceptanceCriteria?: string[];
} | {
  ok: false;
  message: string;
};

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function normalizeOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function validateContractTemplate(contract: Record<string, unknown> | undefined): string[] {
  if (!contract) return [];
  const errors: string[] = [];
  const surface = normalizeOptionalString(contract.surface ?? contract.contract_surface);
  const title = normalizeOptionalString(contract.title);
  const content = normalizeOptionalString(contract.content);
  if (!surface) errors.push('contract.surface 必填且不能为空');
  if (!title) errors.push('contract.title 必填且不能为空');
  if (!content) errors.push('contract.content 必填且不能为空');
  if (contract.version !== undefined) {
    const version = normalizeOptionalNumber(contract.version);
    if (!version || version < 1 || !Number.isInteger(version)) {
      errors.push('contract.version 必须是正整数');
    }
  }
  return errors;
}

function validateEvaluationPolicy(policy: Record<string, unknown> | undefined): string[] {
  if (!policy) return [];
  const errors: string[] = [];
  const requiredEvidence = normalizeStringArray(policy.required_evidence);
  const criticalGates = normalizeStringArray(policy.critical_gates ?? policy.critical_gate);
  if (policy.required_evidence !== undefined && !requiredEvidence) {
    errors.push('evaluation_policy.required_evidence 必须是非空字符串数组');
  }
  if ((policy.critical_gates ?? policy.critical_gate) !== undefined && !criticalGates) {
    errors.push('evaluation_policy.critical_gates 必须是非空字符串数组');
  }
  if (policy.max_repair !== undefined) {
    const maxRepair = normalizeOptionalNumber(policy.max_repair);
    if (maxRepair === undefined || maxRepair < 0 || !Number.isInteger(maxRepair)) {
      errors.push('evaluation_policy.max_repair 必须是非负整数');
    }
  }
  const adaptive = normalizeOptionalObject(policy.adaptive);
  if (policy.adaptive !== undefined && !adaptive) {
    errors.push('evaluation_policy.adaptive 必须是对象');
  }
  if (adaptive) {
    if ((adaptive as { confidence?: unknown }).confidence !== undefined) {
      errors.push('evaluation_policy.adaptive 禁止使用 confidence 分数');
    }
    const difficultySignalsValue = adaptive.difficulty_signals ?? adaptive.difficultySignals;
    const difficultySignals = normalizeOptionalObject(difficultySignalsValue);
    if (difficultySignalsValue !== undefined && !difficultySignals) {
      errors.push('evaluation_policy.adaptive.difficulty_signals 必须是对象');
    }
    const signalSource = difficultySignals ?? adaptive;
    for (const key of ['impact_ratio', 'impactRatio']) {
      if (signalSource[key] !== undefined) {
        const value = normalizeOptionalNumber(signalSource[key]);
        if (value === undefined || value < 0) {
          errors.push(`evaluation_policy.adaptive.${key} 必须是非负数字`);
        }
      }
    }
    for (const key of ['hotspot_overlap', 'hotspotOverlap', 'cross_module_deps', 'crossModuleDeps', 'prior_failures', 'priorFailures', 'total_project_files', 'totalProjectFiles']) {
      if (signalSource[key] !== undefined) {
        const value = normalizeOptionalNumber(signalSource[key]);
        if (value === undefined || value < 0 || !Number.isInteger(value)) {
          errors.push(`evaluation_policy.adaptive.${key} 必须是非负整数`);
        }
      }
    }
    for (const key of ['has_ambiguous_path', 'hasAmbiguousPath', 'ambiguous']) {
      if (signalSource[key] !== undefined && typeof signalSource[key] !== 'boolean') {
        errors.push(`evaluation_policy.adaptive.${key} 必须是 boolean`);
      }
    }
  }
  const speculation = normalizeOptionalObject(policy.speculation);
  if (policy.speculation !== undefined && !speculation) {
    errors.push('evaluation_policy.speculation 必须是对象');
  }
  if (speculation) {
    const selectionPolicy = normalizeOptionalString(speculation.selection_policy ?? speculation.selectionPolicy);
    if (
      selectionPolicy !== undefined &&
      !['first_green', 'fewest_changes', 'fastest_tests'].includes(selectionPolicy)
    ) {
      errors.push('evaluation_policy.speculation.selection_policy 必须是 first_green/fewest_changes/fastest_tests');
    }
    const maxBranches = normalizeOptionalNumber(speculation.max_branches ?? speculation.maxBranches);
    if (
      (speculation.max_branches ?? speculation.maxBranches) !== undefined &&
      (maxBranches === undefined || maxBranches < 1 || maxBranches > 6 || !Number.isInteger(maxBranches))
    ) {
      errors.push('evaluation_policy.speculation.max_branches 必须是 1 到 6 的整数');
    }
    const timeoutMs = normalizeOptionalNumber(speculation.timeout_ms ?? speculation.timeoutMs);
    if (
      (speculation.timeout_ms ?? speculation.timeoutMs) !== undefined &&
      (timeoutMs === undefined || timeoutMs < 1 || !Number.isInteger(timeoutMs))
    ) {
      errors.push('evaluation_policy.speculation.timeout_ms 必须是正整数');
    }
    if (speculation.alternatives !== undefined) {
      if (!Array.isArray(speculation.alternatives)) {
        errors.push('evaluation_policy.speculation.alternatives 必须是数组');
      } else {
        speculation.alternatives.forEach((value, index) => {
          const alternative = normalizeOptionalObject(value);
          if (!alternative) {
            errors.push(`evaluation_policy.speculation.alternatives[${index}] 必须是对象`);
            return;
          }
          if (!normalizeOptionalString(alternative.id ?? alternative.name)) {
            errors.push(`evaluation_policy.speculation.alternatives[${index}].id 必填且不能为空`);
          }
          if (
            (alternative.write_scope ?? alternative.writeScope) !== undefined &&
            !normalizeStringArray(alternative.write_scope ?? alternative.writeScope)
          ) {
            errors.push(`evaluation_policy.speculation.alternatives[${index}].write_scope 必须是非空字符串数组`);
          }
        });
      }
    }
  }
  const adversarial = normalizeOptionalObject(policy.adversarial ?? policy.breaker);
  if ((policy.adversarial ?? policy.breaker) !== undefined && !adversarial) {
    errors.push('evaluation_policy.adversarial 必须是对象');
  }
  if (adversarial) {
    const timeoutMs = normalizeOptionalNumber(adversarial.timeout_ms ?? adversarial.timeoutMs);
    if (
      (adversarial.timeout_ms ?? adversarial.timeoutMs) !== undefined &&
      (timeoutMs === undefined || timeoutMs < 1 || !Number.isInteger(timeoutMs))
    ) {
      errors.push('evaluation_policy.adversarial.timeout_ms 必须是正整数');
    }
    if (adversarial.strategies !== undefined) {
      if (!Array.isArray(adversarial.strategies)) {
        errors.push('evaluation_policy.adversarial.strategies 必须是数组');
      } else {
        adversarial.strategies.forEach((value, index) => {
          const strategy = normalizeOptionalObject(value);
          if (!strategy) {
            errors.push(`evaluation_policy.adversarial.strategies[${index}] 必须是对象`);
            return;
          }
          if (strategy.type !== 'command') {
            errors.push(`evaluation_policy.adversarial.strategies[${index}].type 必须是 command`);
          }
          if (!normalizeOptionalString(strategy.id)) {
            errors.push(`evaluation_policy.adversarial.strategies[${index}].id 必填且不能为空`);
          }
          if (!normalizeOptionalString(strategy.command)) {
            errors.push(`evaluation_policy.adversarial.strategies[${index}].command 必填且不能为空`);
          }
          if (
            strategy.args !== undefined &&
            (!Array.isArray(strategy.args) || strategy.args.some((arg) => typeof arg !== 'string'))
          ) {
            errors.push(`evaluation_policy.adversarial.strategies[${index}].args 必须是字符串数组`);
          }
        });
      }
    }
  }
  return errors;
}

function buildContractTemplate(input: {
  args: Record<string, unknown>;
  subject: string;
  agentType: string;
  nodeKind?: OrchestrationNodeKind;
  existing?: OrchestrationTaskMetadata;
}): ContractTemplateResult {
  const contract = normalizeOptionalObject(input.args.contract);
  const evaluationPolicy = normalizeOptionalObject(input.args.evaluation_policy);
  const contractErrors = [
    ...(hasOwn(input.args, 'contract') && !contract ? ['contract 必须是对象'] : []),
    ...validateContractTemplate(contract),
  ];
  const policyErrors = [
    ...(hasOwn(input.args, 'evaluation_policy') && !evaluationPolicy ? ['evaluation_policy 必须是对象'] : []),
    ...validateEvaluationPolicy(evaluationPolicy),
  ];
  if (contractErrors.length > 0 || policyErrors.length > 0) {
    return {
      ok: false,
      message: [
        '契约模板校验失败：',
        ...contractErrors,
        ...policyErrors,
        'contract 模板至少需要 surface/title/content；version 如提供必须为正整数。',
      ].join('\n- '),
    };
  }

  const explicitContractSurface = normalizeOptionalString(input.args.contract_surface);
  const inheritedSurface = input.existing?.contractBinding?.surface;
  const surface = contract || evaluationPolicy || explicitContractSurface || inheritedSurface
    ? explicitContractSurface ?? normalizeOptionalString(contract?.surface ?? contract?.contract_surface) ?? inheritedSurface ?? pickContractSurface(contract, input.subject)
    : undefined;
  const version = normalizeOptionalNumber(input.args.contract_version ?? contract?.version ?? input.existing?.contractBinding?.version);
  if (version !== undefined && (version < 1 || !Number.isInteger(version))) {
    return { ok: false, message: 'contract_version 必须是正整数。' };
  }
  const requestId = normalizeOptionalString(input.args.contract_request_id)
    ?? (surface ? `${surface}@v${version ?? 1}` : undefined);
  const isContractProducer = input.nodeKind === 'contract' || input.agentType === 'architect';
  const requireContract = hasOwn(input.args, 'require_contract')
    ? input.args.require_contract !== false
    : input.existing?.contractBinding?.requireContract ?? Boolean(surface && !isContractProducer);
  const requireAck = hasOwn(input.args, 'require_ack')
    ? input.args.require_ack === true
    : input.existing?.contractBinding?.requireAck ?? false;
  const acceptanceCriteria = normalizeStringArray(contract?.criteria)
    ?? normalizeStringArray(evaluationPolicy?.criteria)
    ?? input.existing?.acceptance?.criteria;

  return {
    ok: true,
    contract: contract ?? (input.existing?.contract as Record<string, unknown> | undefined),
    evaluationPolicy: evaluationPolicy ?? (input.existing?.evaluationPolicy as Record<string, unknown> | undefined),
    surface,
    version,
    requestId,
    binding: surface ? {
      surface,
      version,
      tag: `contract:${surface}`,
      requestId,
      requireContract,
      requireAck,
    } : input.existing?.contractBinding,
    acceptanceCriteria,
  };
}

function deriveSubject(description: string): string {
  const firstLine = description
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) ?? description;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

type WorktreePolicy = 'none' | 'session' | 'task' | 'auto';

function normalizeWorktreePolicy(value: unknown): WorktreePolicy {
  return value === 'task' || value === 'session' || value === 'none' || value === 'auto' ? value : 'none';
}

function shouldIsolateTask(input: {
  agentType: string;
  baseRole?: string;
  scope: TaskScopeConfig;
  collaborationMode: 'solo' | 'team';
}): boolean {
  // Solo 模式下 ephemeral worker 不需要 git worktree 隔离——
  // write_scope 正交已防止写冲突，worktree 只会制造分支垃圾。
  if (input.collaborationMode === 'solo') return false;
  if (input.scope.working_directory) return false;
  const implementationRoles = new Set(['coding', 'frontend', 'backend', 'fullstack']);
  const role = input.agentType.toLowerCase();
  const baseRole = input.baseRole?.toLowerCase();
  return implementationRoles.has(role) || (baseRole ? implementationRoles.has(baseRole) : false);
}

function safeWorktreeName(sessionId: string, taskId: string, subject: string): string {
  const session = sessionId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(-18);
  const prefix = [session, taskId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')].filter(Boolean).join('-');
  const suffix = subject
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return [prefix, suffix].filter(Boolean).join('-').slice(0, 70) || prefix || `task-${Date.now()}`;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function realpathPreservingMissingSuffix(path: string): string {
  const resolved = resolve(path);
  let cursor = resolved;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolved;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  const canonicalBase = realpathSync.native(cursor);
  return suffix.length > 0 ? join(canonicalBase, ...suffix) : canonicalBase;
}

function mapPathIntoWorktree(inputPath: string | undefined, workspace: string, repoRoot: string, worktreePath: string): string {
  const source = resolve(workspace, inputPath || '.');
  const canonicalRepoRoot = realpathPreservingMissingSuffix(repoRoot);
  const canonicalSource = realpathPreservingMissingSuffix(source);
  if (!isInside(canonicalRepoRoot, canonicalSource)) return worktreePath;
  return join(worktreePath, relative(canonicalRepoRoot, canonicalSource));
}

async function applyWorktreePolicy(input: {
  ctx: TaskPlanningContext;
  taskId: string;
  subject: string;
  scope: TaskScopeConfig;
  policy: Exclude<WorktreePolicy, 'auto'>;
}): Promise<{ scope: TaskScopeConfig; contextNote?: string; worktree?: WorktreeView }> {
  if (input.policy === 'none') {
    return { scope: input.scope };
  }

  if (input.policy === 'session') {
    return {
      scope: {
        ...input.scope,
        working_directory: input.scope.working_directory || input.ctx.leader.workspace,
      },
      contextNote: `[Worktree] policy=session，任务使用当前会话工作目录：${input.scope.working_directory || input.ctx.leader.workspace}`,
    };
  }

  const repos = new DatabaseRepositoryAdapter(input.ctx.leader.db);
  const service = new WorktreeService(repos.worktrees);
  const repoRoot = await service.repoRoot(input.ctx.leader.workspace);
  const worktree = await service.create({
    repoRoot,
    name: safeWorktreeName(input.ctx.leader.sessionId, input.taskId, input.subject),
    sessionId: input.ctx.leader.sessionId,
    taskId: input.taskId,
  });
  const nextScope: TaskScopeConfig = {
    working_directory: mapPathIntoWorktree(input.scope.working_directory, input.ctx.leader.workspace, repoRoot, worktree.path),
    write_scope: input.scope.write_scope && input.scope.write_scope.length > 0
      ? input.scope.write_scope.map((entry) => mapPathIntoWorktree(entry, input.ctx.leader.workspace, repoRoot, worktree.path))
      : [worktree.path],
  };
  return {
    scope: nextScope,
    worktree,
    contextNote: [
      '[Worktree] policy=task，系统已为该任务创建独立 git worktree。',
      `path=${worktree.path}`,
      `branch=${worktree.branch}`,
      `base=${worktree.base_branch}`,
      '任务内所有写入应限制在该 worktree/write_scope 内；合并前必须提交或清理未提交变更。',
    ].join('\n'),
  };
}

function createTaskArgumentHelp(availableRoles: string[]): string {
  return [
    'create_task 参数不足：至少需要提供 subject、description 和显式 agent_type。',
    '示例：{"subject":"修复模型切换不生效","description":"检查 web ui chat 模型切换是否写入设置并影响后续请求","agent_type":"frontend"}',
    `可用角色: ${availableRoles.join(', ') || '无'}`,
  ].join('\n');
}

function createTaskAgentTypeHelp(availableRoles: string[]): string {
  return [
    'agent_type 必须显式提供；由 Leader 根据任务契约选择并写入角色。',
    '请选择已有预设/自定义角色，或通过 role_definition.role_name 一次性创建并绑定新角色。',
    `可用角色: ${availableRoles.join(', ') || '无'}`,
  ].join('\n');
}

/** create_task 实现 */
export async function createTask(
  ctx: TaskPlanningContext,
  args: Record<string, unknown> = {},
): Promise<string> {
  args = args && typeof args === 'object' ? args : {};
  const availableRoles = ctx.leader.getRoleRegistry().listRoleNames();
  const roleDefinition = (args.role_definition && typeof args.role_definition === 'object')
    ? args.role_definition as Record<string, unknown>
    : undefined;
  const subjectInput = normalizeOptionalString(args.subject);
  const descriptionInput = normalizeOptionalString(args.description);
  if (!subjectInput && !descriptionInput) {
    throw fail(createTaskArgumentHelp(availableRoles));
  }

  const subject = subjectInput ?? deriveSubject(descriptionInput!);
  const description = descriptionInput ?? subject;
  const context = normalizeOptionalString(args.context);
  // agent_type 现在做多层回落，不因缺省/变体名/笔误就中断建图：
  //   - 完全省略 → 优先取 role_definition.role_name，否则回落默认规范角色(fullstack)。
  //   - 提供了但不是已注册角色、且未带 role_definition → 按名字推断复用已有规范角色（见下方）。
  let agentType = normalizeOptionalString(args.agent_type);
  let agentTypeNote: string | undefined;
  if (!agentType) {
    const roleDefinitionName0 = normalizeOptionalString(roleDefinition?.role_name);
    agentType = roleDefinitionName0
      ?? (ctx.leader.getRoleRegistry().exists(ROLE_FALLBACK_DEFAULT) ? ROLE_FALLBACK_DEFAULT : availableRoles[0]);
    if (!agentType) {
      throw fail(createTaskAgentTypeHelp(availableRoles));
    }
    if (!roleDefinitionName0) {
      agentTypeNote = `(省略→${agentType})`;
    }
  }
  const roleDefinitionName = normalizeOptionalString(roleDefinition?.role_name);
  if (roleDefinitionName && roleDefinitionName !== agentType) {
    throw fail(`role_definition.role_name (${roleDefinitionName}) 必须与 agent_type (${agentType}) 一致，避免任务绑定角色与新建角色分叉。`);
  }
  // 角色存在性回落：用户没带 role_definition 时，按名字确定性推断复用已有规范角色
  // （resolveRoleFromName：精确/别名/分词/子串），推断不到再回落 fullstack。
  // 带 role_definition 的路径走下方 materialize 新建角色，不在此改写。
  if (!roleDefinition && !ctx.leader.getRoleRegistry().exists(agentType)) {
    const registry = ctx.leader.getRoleRegistry();
    const resolved = resolveRoleFromName(agentType, registry.listRoleNames())
      ?? (registry.exists(ROLE_FALLBACK_DEFAULT) ? ROLE_FALLBACK_DEFAULT : undefined);
    if (!resolved) {
      throw fail(`角色 '${agentType}' 不存在，且无可用规范角色可回落。可用角色: ${registry.listRoleNames().join(', ')}`);
    }
    if (resolved !== agentType) {
      leaderLogger.warn(`[LeaderTools] create_task role inferred '${agentType}' -> '${resolved}' (no role_definition)`);
      agentTypeNote = `'${agentType}'→${resolved}`;
    }
    agentType = resolved;
  }
  const blockedBy = Array.isArray(args.blocked_by)
    ? (args.blocked_by as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)
    : [];
  const scope: TaskScopeConfig = {
    working_directory: typeof args.working_directory === 'string' ? args.working_directory : undefined,
    write_scope: Array.isArray(args.write_scope)
      ? (args.write_scope as string[]).filter((value) => typeof value === 'string')
      : undefined,
  };
  const requestedWorktreePolicy = normalizeWorktreePolicy(args.worktree_policy);
  const collaborationMode = resolveModeRuntimeProjection({
    sessionId: ctx.leader.sessionId,
    db: ctx.leader.db,
    blackboardAvailable: ctx.leader.isBlackboardEnabled(),
    permissionSummary: ctx.leader.getInteractionSnapshot().permissionSummary,
  }).collaboration.mode;
  const worktreePolicy: Exclude<WorktreePolicy, 'auto'> = requestedWorktreePolicy === 'auto'
    ? shouldIsolateTask({ agentType, baseRole: normalizeOptionalString(roleDefinition?.base_role), scope, collaborationMode }) ? 'task' : 'none'
    : requestedWorktreePolicy;
  const nodeKind = typeof args.node_kind === 'string' ? args.node_kind as OrchestrationNodeKind : undefined;
  // 蓝图实现任务自动绑 contract_surface(=subsystemId),触发 requireContract gate。
  // 治"派发跳过契约":Leader 只传 subsystem 建实现任务时,自动等待对应 surface 的黑板契约;
  // 契约由 define_project_blueprint 自动生成的 contract 任务(architect)产出后才解锁派发。
  // 只注入 surface 不传 contract 模板 → 不预写黑板契约节点(真契约由 architect 经 graph_contract 物化)。
  if (nodeKind !== 'contract' && agentType !== 'architect'
    && !hasOwn(args, 'contract_surface')
    && !normalizeOptionalObject(args.contract)?.surface) {
    const subsystemId = normalizeOptionalString(args.subsystem);
    if (subsystemId) {
      const blueprint = parseBlueprint(ctx.leader.db.getSessionState(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));
      const entry = blueprint?.subsystems.find((e) => e.subsystemId === subsystemId);
      if (entry?.status === 'implement') {
        args = { ...args, contract_surface: subsystemId };
      }
    }
  }
  const contractTemplate = buildContractTemplate({ args, subject, agentType, nodeKind });
  if (!contractTemplate.ok) {
    throw fail(contractTemplate.message);
  }
  const orchestrationRunId = typeof args.orchestration_run_id === 'string' && args.orchestration_run_id.trim()
    ? args.orchestration_run_id.trim()
    : `run-${ctx.leader.sessionId}`;
  const generation = typeof args.generation === 'number' && Number.isFinite(args.generation) ? args.generation : 0;
  const orchestration: OrchestrationTaskMetadata | undefined = (contractTemplate.contract || contractTemplate.evaluationPolicy || contractTemplate.binding || nodeKind || args.orchestration_run_id || args.generation !== undefined)
    ? {
        orchestrationRunId,
        nodeKind: nodeKind ?? (contractTemplate.binding ? 'implement' : 'generic'),
        generation,
        verdict: 'UNKNOWN',
        contract: contractTemplate.contract,
        contractBinding: contractTemplate.binding,
        evaluationPolicy: contractTemplate.evaluationPolicy,
        acceptance: {
          status: contractTemplate.evaluationPolicy ? 'pending' : 'skipped',
          criteria: contractTemplate.acceptanceCriteria,
        },
      }
    : undefined;

  // 重复任务防御
  if (orchestration) {
    const normalizedSubject = subject.trim();
    const dup = ctx.leader.board.getAllTasks().find((t) => {
      if (!t.orchestration) return false;
      if (t.orchestration.orchestrationRunId !== orchestration.orchestrationRunId) return false;
      if ((t.orchestration.nodeKind ?? 'generic') !== (orchestration.nodeKind ?? 'generic')) return false;
      if ((t.orchestration.generation ?? 0) !== (orchestration.generation ?? 0)) return false;
      if (t.subject.trim() !== normalizedSubject) return false;
      return t.status !== 'terminal';
    });
    if (dup) {
      leaderLogger.warn(`[LeaderTools] create_task duplicate suppressed: existing=${dup.id} subject="${normalizedSubject}" runId=${orchestration.orchestrationRunId} nodeKind=${orchestration.nodeKind ?? 'generic'} gen=${orchestration.generation ?? 0}`);
      return `已存在等效任务 ${dup.id}: ${dup.subject} [${dup.status}] · 复用现有节点（runId=${orchestration.orchestrationRunId}, nodeKind=${orchestration.nodeKind ?? 'generic'}, generation=${orchestration.generation ?? 0}）`;
    }
  }

  if (!ctx.leader.getRoleRegistry().exists(agentType)) {
    if (!roleDefinition) {
      throw fail(`角色 '${agentType}' 不存在。请在 create_task 中附带 role_definition 一次性创建，或使用 define_agent_role 预先定义。可用角色: ${ctx.leader.getRoleRegistry().listRoleNames().join(', ')}`);
    }

    const materialized = materializeRoleDefinition(ctx, {
      role_name: agentType,
      base_role: roleDefinition.base_role as string | undefined,
      role_description: roleDefinition.role_description as string,
      system_prompt: roleDefinition.system_prompt as string,
      tools: roleDefinition.tools as string[],
      skill_names: Array.isArray(roleDefinition.skill_names)
        ? roleDefinition.skill_names as string[]
        : undefined,
    });

    if (!materialized.ok) {
      throw fail(materialized.message);
    }
  }

  const taskId = ctx.leader.board.nextTaskId();
  let effectiveScope = scope;
  let effectiveContext = context;
  let worktree: WorktreeView | undefined;
  try {
    const applied = await applyWorktreePolicy({
      ctx,
      taskId,
      subject,
      scope,
      policy: worktreePolicy,
    });
    effectiveScope = applied.scope;
    worktree = applied.worktree;
    if (applied.contextNote) {
      effectiveContext = [context, applied.contextNote].filter(Boolean).join('\n\n');
    }
  } catch (error) {
    throw fail(`创建任务失败：worktree_policy=${requestedWorktreePolicy} 初始化失败：${error instanceof Error ? error.message : String(error)}`);
  }

  let task: BoardTask;
  try {
    // contract / evaluation_policy 不再拼到 description 末尾，而是物化为 BlackboardGraph 节点。
    // worker 通过 contract:<surface> tag 拉取契约，避免 description 被裸 JSON 污染。
    task = ctx.leader.board.createTask(taskId, subject, description, agentType, blockedBy, [], effectiveScope, effectiveContext, {
      orchestration,
      preferred_agent_name: typeof args.preferred_agent_name === 'string' ? args.preferred_agent_name : undefined,
    });
    writeContractNodeToBlackboard(ctx, {
      taskId: task.id,
      subject,
      agentType,
      contract: contractTemplate.contract,
      evaluationPolicy: contractTemplate.evaluationPolicy,
      surface: contractTemplate.surface,
    });
  } catch (error) {
    throw fail(`创建任务失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const subsystemWarning = registerTaskSubsystem(ctx, task.id, args);

  return `已创建任务 ${task.id}: ${task.subject} [${task.status}]${worktree ? ` · worktree:${worktree.branch}` : requestedWorktreePolicy !== 'none' ? ` · worktree_policy:${requestedWorktreePolicy}->${worktreePolicy}` : ''}${orchestration ? ` · orchestration:${orchestration.nodeKind ?? 'generic'} gen=${orchestration.generation ?? 0}` : ''}${contractTemplate.surface ? ` · contract 已写入/绑定黑板 (tag=contract:${contractTemplate.surface})` : ''}${agentTypeNote ? ` · 角色:${agentTypeNote}` : ''}${subsystemWarning ? ` · ${subsystemWarning}` : ''}`;
}

/** update_task 实现 */
export async function updateTask(
  ctx: TaskPlanningContext,
  args: Record<string, unknown>,
): Promise<string> {
  const taskId = String(args.task_id || '').trim();
  if (!taskId) {
    throw fail('task_id 不能为空');
  }

  const task = ctx.leader.board.getTask(taskId);
  if (!task) {
    throw fail(`任务 ${taskId} 不存在`);
  }
  // 放宽：assigned_agent 不为空但 worker 实际未 running，仍允许编辑（修正 DAG 错误）
  if (task.status === 'running') {
    throw fail(`任务 ${taskId} 正在运行中，无法编辑。请先 cancel 或等待终态。`);
  }
  if (task.status === 'terminal') {
    throw fail(`任务 ${taskId} 已是终态 (${task.exitReason ?? 'completed'}), 不能编辑。`);
  }
  if (task.assigned_agent) {
    const handle = ctx.leader.pool.getByName(task.assigned_agent);
    if (handle && isAgentRuntimeActiveStatus(handle)) {
      throw fail(`任务 ${taskId} 已派发给 @${task.assigned_agent} (${handle.status}), 不能编辑。`);
    }
  }

  const updates: Parameters<typeof ctx.leader.board.updateTask>[1] = {};
  if (typeof args.subject === 'string') updates.subject = args.subject;
  if (typeof args.description === 'string') updates.description = args.description;
  if (typeof args.context === 'string') updates.context = args.context;
  if (typeof args.agent_type === 'string') {
    // 同 create_task 的多层回落：未注册的变体名/缩写按名字推断复用规范角色，再回落 fullstack。
    const registry = ctx.leader.getRoleRegistry();
    let nextAgentType = args.agent_type.trim();
    if (nextAgentType && !registry.exists(nextAgentType)) {
      const resolved = resolveRoleFromName(nextAgentType, registry.listRoleNames())
        ?? (registry.exists(ROLE_FALLBACK_DEFAULT) ? ROLE_FALLBACK_DEFAULT : undefined);
      if (!resolved) {
        throw fail(`角色 '${args.agent_type}' 不存在，且无可用规范角色可回落。可用角色: ${registry.listRoleNames().join(', ')}`);
      }
      nextAgentType = resolved;
    }
    updates.agent_type = nextAgentType;
  }
  if (Array.isArray(args.blocked_by)) {
    updates.blocked_by = (args.blocked_by as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean);
  }
  if (typeof args.working_directory === 'string') updates.working_directory = args.working_directory;
  if (Array.isArray(args.write_scope)) {
    updates.write_scope = (args.write_scope as unknown[]).filter((value): value is string => typeof value === 'string');
  }
  // 预绑定成员：允许改绑到另一个 team 成员，或传空字符串清除预绑定回到 Leader 决策。
  if (typeof args.preferred_agent_name === 'string') {
    updates.preferred_agent_name = args.preferred_agent_name.trim();
  }

  const hasContractBindingUpdate = [
    'contract',
    'contract_surface',
    'contract_version',
    'contract_request_id',
    'require_contract',
    'require_ack',
    'evaluation_policy',
    'node_kind',
    'orchestration_run_id',
    'generation',
  ].some((key) => hasOwn(args, key));

  let nextContractTemplate: Extract<ContractTemplateResult, { ok: true }> | undefined;
  if (hasContractBindingUpdate) {
    const nextAgentType = typeof updates.agent_type === 'string' ? updates.agent_type : task.agent_type;
    const nextSubject = typeof updates.subject === 'string' ? updates.subject : task.subject;
    const nextNodeKind = typeof args.node_kind === 'string'
      ? args.node_kind as OrchestrationNodeKind
      : task.orchestration?.nodeKind;
    const contractTemplate = buildContractTemplate({
      args,
      subject: nextSubject,
      agentType: nextAgentType,
      nodeKind: nextNodeKind,
      existing: task.orchestration,
    });
    if (!contractTemplate.ok) {
      throw fail(contractTemplate.message);
    }
    nextContractTemplate = contractTemplate;

    const orchestrationRunId = typeof args.orchestration_run_id === 'string' && args.orchestration_run_id.trim()
      ? args.orchestration_run_id.trim()
      : task.orchestration?.orchestrationRunId ?? `run-${ctx.leader.sessionId}`;
    const generation = typeof args.generation === 'number' && Number.isFinite(args.generation)
      ? args.generation
      : task.orchestration?.generation ?? 0;
    updates.orchestration = {
      ...(task.orchestration ?? {}),
      orchestrationRunId,
      nodeKind: nextNodeKind ?? (contractTemplate.binding ? 'implement' : task.orchestration?.nodeKind ?? 'generic'),
      generation,
      verdict: task.orchestration?.verdict ?? 'UNKNOWN',
      contract: contractTemplate.contract,
      contractBinding: contractTemplate.binding,
      evaluationPolicy: contractTemplate.evaluationPolicy,
      acceptance: {
        ...(task.orchestration?.acceptance ?? {}),
        status: contractTemplate.evaluationPolicy
          ? (task.orchestration?.acceptance?.status === 'passed' ? 'passed' : 'pending')
          : (task.orchestration?.acceptance?.status ?? 'skipped'),
        criteria: contractTemplate.acceptanceCriteria,
      },
    };
  }

  if (Object.keys(updates).length === 0) {
    throw fail('没有提供可更新字段');
  }

  try {
    const updated = ctx.leader.board.updateTask(taskId, updates);
    if (nextContractTemplate) {
      writeContractNodeToBlackboard(ctx, {
        taskId: updated.id,
        subject: updated.subject,
        agentType: updated.agent_type,
        contract: nextContractTemplate.contract,
        evaluationPolicy: nextContractTemplate.evaluationPolicy,
        surface: nextContractTemplate.surface,
      });
    }
    const bindingLabel = updated.preferred_agent_name ? `预绑定=@${updated.preferred_agent_name}` : '预绑定=无';
    const contractLabel = updated.orchestration?.contractBinding?.surface
      ? ` · contract=contract:${updated.orchestration.contractBinding.surface}`
      : '';
    return `已更新任务 ${updated.id}: ${updated.subject} [blocked_by=${updated.blocked_by.join(', ') || '无'} · ${bindingLabel}${contractLabel}]`;
  } catch (error) {
    throw fail(`更新任务失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** delete_task 实现 */
export async function deleteTask(
  ctx: TaskPlanningContext,
  args: Record<string, unknown>,
): Promise<string> {
  const taskId = String(args.task_id || '').trim();
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!taskId) {
    throw fail('task_id 不能为空');
  }

  const task = ctx.leader.board.getTask(taskId);
  if (!task) {
    throw fail(`任务 ${taskId} 不存在`);
  }
  if (task.status === 'running') {
    throw fail(`任务 ${taskId} 正在运行中，无法删除。请先 cancel 或等待终态。`);
  }
  if (task.status === 'terminal') {
    throw fail(`任务 ${taskId} 已是终态 (${task.exitReason ?? 'completed'}), 不能删除。`);
  }
  if (task.assigned_agent) {
    const handle = ctx.leader.pool.getByName(task.assigned_agent);
    if (handle && isAgentRuntimeActiveStatus(handle)) {
      throw fail(`任务 ${taskId} 已派发给 @${task.assigned_agent} (${handle.status}), 不能删除。`);
    }
  }

  try {
    const result = ctx.leader.board.deleteTask(taskId);
    unregisterTaskSubsystem(ctx, taskId);
    const affected = result.affectedTasks.map(t => t.id);
    return `已删除任务 ${taskId}${reason ? `（原因：${reason}` : ''}${affected.length > 0 ? `；已从下游依赖中移除并更新: ${affected.join(', ')}` : ''}`;
  } catch (error) {
    throw fail(`删除任务失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** define_agent_role 实现 */
export async function defineAgentRole(
  ctx: TaskPlanningContext,
  args: Record<string, unknown>,
): Promise<string> {
  const result = materializeRoleDefinition(ctx, {
    role_name: args.role_name as string,
    base_role: args.base_role as string | undefined,
    role_description: args.role_description as string,
    system_prompt: args.system_prompt as string,
    tools: args.tools as string[],
    skill_names: Array.isArray(args.skill_names)
      ? (args.skill_names as string[])
      : undefined,
  });

  return result.message;
}

/** define_project_blueprint 实现:由 Leader 自主列出子系统清单,存入 session state,并自动为 implement 子系统建 contract 前置任务。 */
export async function defineProjectBlueprint(
  ctx: TaskPlanningContext,
  args: Record<string, unknown> = {},
): Promise<string> {
  args = args && typeof args === 'object' ? args : {};
  const existing = parseBlueprint(ctx.leader.db.getSessionState(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));
  const result = normalizeBlueprint({
    subsystems: args.subsystems,
    notes: args.notes,
    existing,
  });
  if ('error' in result) {
    throw fail(result.error);
  }
  ctx.leader.db.setSessionState(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT, serializeBlueprint(result));
  const coverage = computeBlueprintCoverage(result);
  try {
    ctx.leader.emitter.emit('leader:blueprint_updated', { sessionId: ctx.leader.sessionId, blueprint: result, coverage });
  } catch (err) {
    leaderLogger.warn(`[LeaderTools] blueprint_updated 事件发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const implementCount = coverage.implemented.length + coverage.uncovered.length;
  const header = `已定义项目蓝图 · ${result.subsystems.length} 子系统(implement ${implementCount} · defer ${coverage.deferred.length} · na ${coverage.notApplicable.length})。`;
  // 治本接线:蓝图存盘后,为每个 implement 子系统自动建 contract 前置任务(architect 产真契约)。
  // 陷阱A:不传 contract 模板(writeContractNodeToBlackboard 守卫不预写节点,真契约由 architect 经 graph_contract 物化才就绪);
  // 陷阱B 已修正:contract 任务也登记 subsystem,使 computeBlueprintCoverage 判定覆盖完整(避免"建了任务仍显示缺口"的 UX 摩擦);
  // 陷阱F:幂等——已有未完成同 surface 的 contract 任务则跳过,重复 define_project_blueprint 不翻倍。
  const seeds = buildSubsystemContractSeeds(result);
  const contractTaskNotes: string[] = [];
  for (const seed of seeds) {
    const dup = ctx.leader.board.getAllTasks().find((t) =>
      t.orchestration?.nodeKind === 'contract'
      && t.orchestration?.contractBinding?.surface === seed.surface
      && t.status !== 'terminal');
    if (dup) {
      contractTaskNotes.push(`${seed.surface}:复用 ${dup.id}`);
      continue;
    }
    try {
      const id = await createContractSeedTask(ctx, seed);
      contractTaskNotes.push(`${seed.surface}:${id}`);
    } catch (err) {
      leaderLogger.warn(`[LeaderTools] contract seed 任务创建失败 (surface=${seed.surface}): ${err instanceof Error ? err.message : String(err)}`);
      contractTaskNotes.push(`${seed.surface}:创建失败`);
    }
  }
  const contractSummary = contractTaskNotes.length > 0
    ? `\n已自动生成 ${contractTaskNotes.length} 个 contract 前置任务(architect 角色,已登记到对应 subsystem,覆盖完整): ${contractTaskNotes.join('; ')}。\n【执行步骤】1. 先 dispatch 这些 contract 任务收敛契约(可并行派发);2. contract 完成后,为每个 subsystem 建 implement 任务(create_task 带 subsystem=<id>);3. implement 任务会自动等待对应 surface 的契约就绪后解锁派发。`
    : '';
  return [header, contractSummary].filter(Boolean).join('\n');
}

/** 建单个 contract 前置任务(architect 产真契约)。复用 createTask,保留其重复防御/角色校验/持久化/事件路径。
 *  陷阱A:不传 contract 模板——writeContractNodeToBlackboard 守卫不预写黑板节点,
 *          真契约由 architect 经 graph_contract 块物化(addContract)后才"就绪",seed.content 仅进 description 当上下文;
 *  contract 任务也登记 subsystem(使覆盖判定完整);A4 跳过 contract(isContractProducer)避免被依赖链阻塞。
 *  node_kind=contract → isContractProducer → requireContract 自动 false,contract 任务自身不被契约 gate 拦,可先派。 */
async function createContractSeedTask(ctx: TaskPlanningContext, seed: SubsystemContractSeed): Promise<string> {
  return createTask(ctx, {
    node_kind: 'contract',
    agent_type: 'architect',
    contract_surface: seed.surface,
    subsystem: seed.surface,
    subject: `契约:${seed.title} (surface=${seed.surface})`,
    description: [
      seed.content,
      '',
      `产出 graph_contract 代码块(surface=${seed.surface},含 endpoints/schema/errors/status/关键状态转换),`,
      `由 worker 解析器物化到黑板 contract:${seed.surface} 节点。`,
      `实现本子系统的任务已自动绑定 contract_surface=${seed.surface},会等待本契约就绪后才解锁派发。`,
    ].join('\n'),
  });
}

/** 把任务登记到蓝图对应子系统(覆盖 gate 据此判定;无蓝图时静默——subsystem 仅在已定义蓝图时有效)。
 *  联动:A3 自动绑定 contract_surface=subsystemId(任务无显式 surface 时);
 *       A4 子系统 dependsOn 自动传递为任务 blocked_by(任务无显式 blocked_by 时)。 */
function registerTaskSubsystem(ctx: TaskPlanningContext, taskId: string, args: Record<string, unknown>): string | null {
  const subsystemId = normalizeOptionalString(args.subsystem);
  if (!subsystemId) return null;
  try {
    const existing = parseBlueprint(ctx.leader.db.getSessionState(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));
    if (!existing) return null;
    // 检查 subsystemId 是否存在于蓝图中,不存在时返回明确 warning 给 Leader
    const subsystemExists = existing.subsystems.some((e) => e.subsystemId === subsystemId);
    if (!subsystemExists) {
      const validIds = existing.subsystems.map((e) => e.subsystemId).join(', ');
      return `⚠ 子系统 "${subsystemId}" 不在当前蓝图中,任务 ${taskId} 未绑定到任何 subsystem。蓝图不会显示覆盖。合法 subsystem id: ${validIds}`;
    }
    const next = registerTaskId(existing, subsystemId, taskId);
    ctx.leader.db.setSessionState(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT, serializeBlueprint(next));
    ctx.leader.emitter.emit('leader:blueprint_updated', { sessionId: ctx.leader.sessionId, blueprint: next, coverage: computeBlueprintCoverage(next) });

    // A3: 自动绑定 contract_surface=subsystemId。
    // 任务无显式 contract_surface 且非 architect/contract 产出者时,把 subsystem id 作为 contract surface,
    // requireContract=true 让 DAG 契约门激活——实现任务须等对应子系统契约就绪才可派发。
    // 不覆盖 Leader 显式指定的 contract_surface(尊重显式意图)。
    const task = ctx.leader.board.getTask(taskId);
    if (task) {
      const hasExplicitSurface = Boolean(task.orchestration?.contractBinding?.surface);
      const isContractProducer = task.orchestration?.nodeKind === 'contract' || task.agent_type === 'architect';
      if (!hasExplicitSurface && !isContractProducer) {
        const orchestration = {
          ...(task.orchestration ?? {}),
          contractBinding: {
            surface: subsystemId,
            tag: `contract:${subsystemId}`,
            requireContract: true,
          },
        };
        try {
          ctx.leader.board.updateTask(taskId, { orchestration });
        } catch (err) {
          leaderLogger.warn(`[LeaderTools] subsystem→contract_surface 自动绑定失败 (task=${taskId}, subsystem=${subsystemId}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // A4: 子系统 dependsOn 自动传递为任务 blocked_by。
      // 任务无显式 blocked_by 且蓝图子系统有 dependsOn 时,把已登记的依赖子系统任务自动加为 blocked_by。
      // 不覆盖 Leader 显式指定的 blocked_by(尊重显式意图)。
      // contract 任务跳过:契约收敛是第一步,不应被依赖链阻塞。
      const entry = next.subsystems.find((e) => e.subsystemId === subsystemId);
      const depSubsystemIds = entry?.dependsOn ?? [];
      if (!isContractProducer && depSubsystemIds.length > 0 && (!task.blocked_by || task.blocked_by.length === 0)) {
        const depTaskIds = depSubsystemIds
          .flatMap((depId) => next.subsystems.find((e) => e.subsystemId === depId)?.taskIds ?? [])
          .filter((id) => id && id !== taskId);
        if (depTaskIds.length > 0) {
          try {
            ctx.leader.board.updateTask(taskId, { blocked_by: depTaskIds });
          } catch (err) {
            leaderLogger.warn(`[LeaderTools] subsystem dependsOn→blocked_by 自动传递失败 (task=${taskId}, subsystem=${subsystemId}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
    return null;
  } catch (err) {
    leaderLogger.warn(`[LeaderTools] subsystem 登记失败 (task=${taskId}, subsystem=${subsystemId}): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 删任务时从蓝图登记中移除,保持覆盖判定一致。 */
function unregisterTaskSubsystem(ctx: TaskPlanningContext, taskId: string): void {
  try {
    const existing = parseBlueprint(ctx.leader.db.getSessionState(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));
    if (!existing) return;
    const next = unregisterTaskId(existing, taskId);
    ctx.leader.db.setSessionState(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT, serializeBlueprint(next));
    ctx.leader.emitter.emit('leader:blueprint_updated', { sessionId: ctx.leader.sessionId, blueprint: next, coverage: computeBlueprintCoverage(next) });
  } catch (err) {
    leaderLogger.warn(`[LeaderTools] subsystem 反注册失败 (task=${taskId}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** materializeRoleDefinition：define_agent_role / create_task 公用 */
export function materializeRoleDefinition(
  ctx: TaskPlanningContext,
  args: {
    role_name: string;
    base_role?: string;
    role_description: string;
    system_prompt: string;
    tools: string[];
    skill_names?: string[];
  },
): { ok: boolean; message: string } {
  // base_role 同样按名字确定性归约到某个 preset（fe→frontend/be→backend 等），
  // 命中不到则原样透传（resolveDynamicRoleCapability 对未知 base_role 安全地忽略）。
  const presetNames = Object.keys(PRESET_ROLE_PROFILES);
  const resolvedBaseRole = normalizeOptionalString(args.base_role)
    ? (resolveRoleFromName(args.base_role as string, presetNames) ?? args.base_role)
    : args.base_role;
  const capability = ctx.leader.resolveRoleCapability({
    roleName: args.role_name,
    baseRoleName: resolvedBaseRole,
    roleDescription: args.role_description,
    systemPrompt: args.system_prompt,
    tools: args.tools,
    requestedSkillNames: args.skill_names,
  });

  const role = ctx.leader.getRoleRegistry().register({
    name: args.role_name,
    description: args.role_description,
    systemPrompt: args.system_prompt,
    tools: capability.tools,
    droppedTools: capability.droppedTools,
    skillNames: capability.skillNames,
    capabilityProfile: capability.capabilityProfile,
    createdBy: 'llm',
  });

  ctx.leader.db.setSessionState(
    ctx.leader.sessionId,
    SESSION_KEYS.CUSTOM_ROLES,
    JSON.stringify(ctx.leader.getRoleRegistry().toDict()),
  );
  const existingSkillHistory = ctx.leader.db.getSessionState(ctx.leader.sessionId, SESSION_KEYS.LEADER_SELECTED_SKILLS_HISTORY);
  const skillHistory = Array.isArray(existingSkillHistory)
    ? existingSkillHistory as Array<Record<string, unknown>>
    : [];
  skillHistory.push({
    timestamp: Date.now() / 1000,
    role_name: role.name,
    skills: capability.skillNames,
    skill_sources: capability.skillSources,
    baseline_role: capability.capabilityProfile.baselineRole,
  });
  ctx.leader.db.setSessionState(
    ctx.leader.sessionId,
    SESSION_KEYS.LEADER_SELECTED_SKILLS_HISTORY,
    skillHistory.slice(-25),
  );

  const notes: string[] = [];
  if (capability.capabilityProfile.baselineRole) {
    notes.push(`baseline=${capability.capabilityProfile.baselineRole}`);
  }
  if (capability.droppedTools.length > 0) {
    notes.push(`dropped_tools=${capability.droppedTools.join(', ')}`);
  }

  return {
    ok: true,
    message: `已创建新角色 '${role.name}'${capability.skillNames.length > 0 ? `，附带 skills: ${capability.skillNames.join(', ')}` : ''}${notes.length > 0 ? ` (${notes.join(' · ')})` : ''}`,
  };
}

/** list_available_roles 实现 */
export function listAvailableRoles(ctx: TaskPlanningContext): string {
  return ctx.leader.getRoleRegistry().toLLMContext();
}

/** update_task_status 实现：UI 状态语义 → TaskBoard 状态机 */
export async function updateTaskStatus(
  ctx: TaskPlanningContext,
  args: Record<string, unknown>,
): Promise<string> {
  const taskId = args.task_id as string;
  const status = args.status as string;
  const result = typeof args.result === 'string' ? args.result : undefined;
  const task = ctx.leader.board.getTask(taskId);

  if (!task) {
    throw fail(`任务 ${taskId} 不存在`);
  }

  // schema enum 收敛为 ['cancelled','failed']：
  // - completed：worker 自己 emit task:completed，Leader 不应直接标
  // - 其它运行/重置态：走 cancel + 重建 task 路径，避免 STATUS_MAP 暴露 LLM 看不到的内部值
  const normalized = normalizeTaskStatusUpdateTarget(status);
  if (!normalized) {
    throw fail(`无效状态 '${status}'。允许: cancelled, failed`);
  }

  const isTerminalTarget = normalized.status === 'terminal';
  const runningHandle = task.assigned_agent
    ? ctx.leader.pool.getByName(task.assigned_agent)
    : undefined;

  if (isTerminalTarget && runningHandle && isAgentRuntimeActiveStatus(runningHandle)) {
    throw fail(`任务 ${taskId} 当前仍由 @${task.assigned_agent} 执行中，Leader 不能在队友运行时直接标记为 ${status}。`);
  }

  if (task.status === 'terminal' && isTerminalTarget && task.exitReason === normalized.exitReason) {
    return `任务 ${taskId} 已经是 ${status}，无需重复操作`;
  }

  if (task.status === 'terminal' && !isTerminalTarget) {
    throw fail(`任务 ${taskId} 已处于终态 '${task.exitReason}'，不能降级为 '${status}'`);
  }

  if (task.status === normalized.status && !isTerminalTarget) {
    return `任务 ${taskId} 已经是 ${status}，无需重复操作`;
  }

  try {
    if (isTerminalTarget && task.status === 'dispatchable' && !task.assigned_agent) {
      ctx.leader.board.updateTaskStatus(taskId, 'running');
    }
    ctx.leader.board.updateTaskStatus(taskId, normalized.status, normalized.exitReason, result);
    return `已更新任务 ${taskId} 状态为 ${status}`;
  } catch (error) {
    throw fail(`更新任务状态失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
