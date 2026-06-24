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
import { resolveRoleFromName, ROLE_FALLBACK_DEFAULT, type AgentRole } from '../../RoleRegistry.js';
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
  type ProjectBlueprint,
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

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
}

function persistCustomRolesSnapshot(ctx: TaskPlanningContext): void {
  ctx.leader.db.setSessionState(
    ctx.leader.sessionId,
    SESSION_KEYS.CUSTOM_ROLES,
    JSON.stringify(ctx.leader.getRoleRegistry().toDict()),
  );
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function assertLeaderTaskScopeAllowed(ctx: TaskPlanningContext, scope: TaskScopeConfig): void {
  const workspaceRoot = resolve(ctx.leader.workspace);
  const sessionsRoot = resolve(workspaceRoot, '.lingxiao', 'sessions');
  const currentSessionRoot = resolve(sessionsRoot, ctx.leader.sessionId);
  const entries = [scope.working_directory, ...(scope.write_scope ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const entry of entries) {
    const resolved = resolve(workspaceRoot, entry);
    if (!isPathInside(workspaceRoot, resolved)) {
      throw fail(`任务 scope 超出当前 workspace: ${entry}`);
    }
    if (isPathInside(sessionsRoot, resolved) && !isPathInside(currentSessionRoot, resolved)) {
      throw fail(`任务 scope 不能指向其他 session: ${entry}`);
    }
  }
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

type BlackboardContractWriteResult = {
  status: 'written' | 'skipped' | 'failed';
  tag?: string;
  reason?: string;
};

function writeContractNodeToBlackboard(ctx: TaskPlanningContext, input: {
  taskId: string;
  subject: string;
  agentType: string;
  contract?: Record<string, unknown>;
  evaluationPolicy?: Record<string, unknown>;
  surface?: string;
}): BlackboardContractWriteResult {
  // evaluation_policy 只是验收策略,不能伪装成 contract:<surface> 活跃契约。
  // 只有显式 contract 模板才物化为黑板 contract 节点。
  if (!input.contract) {
    return { status: 'skipped', reason: 'no explicit contract template' };
  }
  try {
    const blackboard = (ctx.leader as unknown as { leaderBlackboard?: { blackboardGraph?: { addContract?: (input: unknown) => unknown } } }).leaderBlackboard;
    const graph = blackboard?.blackboardGraph;
    if (!graph?.addContract) {
      return { status: 'skipped', reason: 'blackboard contract graph unavailable' };
    }
    const contractTitle = normalizeOptionalString(input.contract?.title) ?? input.subject;
    const contractContent = normalizeContractContent(input.contract, input.evaluationPolicy);
    const surface = input.surface ?? normalizeOptionalString(input.contract.surface) ?? input.taskId;
    const tag = `contract:${surface}`;
    graph.addContract({
      sessionId: ctx.leader.sessionId,
      title: `Contract: ${contractTitle}`,
      content: contractContent,
      tags: [tag, `contract:${input.taskId}`, `task:${input.taskId}`, `agent:${input.agentType}`, 'provenance:template'],
      createdBy: input.taskId,
    });
    return { status: 'written', tag };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    leaderLogger.warn(`[LeaderTools] contract 节点写入失败 (task=${input.taskId}): ${reason}`);
    return { status: 'failed', reason };
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

type ContractTemplateOk = Extract<ContractTemplateResult, { ok: true }>;

function formatTaskReadiness(ctx: TaskPlanningContext, task: BoardTask): string {
  const readiness = ctx.leader.board.getTaskReadiness(task);
  if (task.status === 'dispatchable') {
    return readiness === 'ready' ? 'ready' : `${readiness} · raw=dispatchable`;
  }
  return readiness === task.status ? task.status : `${readiness} · raw=${task.status}`;
}

function formatBlockedReason(ctx: TaskPlanningContext, task: BoardTask): string {
  const reason = ctx.leader.board.getBlockedReason(task);
  return reason ? ` · blocked_reason=${reason}` : '';
}

function formatContractToolStatus(template: ContractTemplateOk, writeResult: BlackboardContractWriteResult): string {
  const parts: string[] = [];
  if (template.binding?.surface) {
    parts.push(`contractBinding=contract:${template.binding.surface}[requireContract=${template.binding.requireContract === true},requireAck=${template.binding.requireAck === true}]`);
  }
  if (template.contract) {
    const writeLabel = writeResult.status === 'written'
      ? `blackboardWrite=written(${writeResult.tag ?? `contract:${template.binding?.surface ?? template.surface ?? '?'}`})`
      : `blackboardWrite=${writeResult.status}${writeResult.reason ? `(${writeResult.reason})` : ''}`;
    parts.push(writeLabel);
  }
  if (template.evaluationPolicy) {
    parts.push('evaluation_policy=attached');
  }
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

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
  // v1.0.4: adaptive/speculation/adversarial 字段已移除，仅保留基础验收字段验证
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

  const hasExplicitContractSurfaceArg = hasOwn(input.args, 'contract_surface');
  const explicitContractSurface = normalizeOptionalString(input.args.contract_surface);
  const contractSurface = normalizeOptionalString(contract?.surface ?? contract?.contract_surface);
  const inheritedSurface = hasExplicitContractSurfaceArg ? undefined : input.existing?.contractBinding?.surface;
  const surface = explicitContractSurface
    ?? contractSurface
    ?? inheritedSurface
    ?? (contract ? pickContractSurface(contract, input.subject) : undefined);
  const version = normalizeOptionalNumber(input.args.contract_version ?? contract?.version ?? input.existing?.contractBinding?.version);
  if (version !== undefined && (version < 1 || !Number.isInteger(version))) {
    return { ok: false, message: 'contract_version 必须是正整数。' };
  }
  const requestId = normalizeOptionalString(input.args.contract_request_id)
    ?? (surface ? `${surface}@v${version ?? 1}` : undefined);
  const isContractProducer = input.nodeKind === 'contract' || input.agentType === 'architect';
  const isImplementationConsumer = !input.nodeKind || input.nodeKind === 'implement' || input.nodeKind === 'repair';
  const hasExternalContractSurface = Boolean(explicitContractSurface || inheritedSurface);
  const onlyPolicyOrAckTouched = !hasOwn(input.args, 'contract')
    && !hasExplicitContractSurfaceArg
    && !hasOwn(input.args, 'node_kind')
    && !hasOwn(input.args, 'require_contract');
  const defaultRequireContract = Boolean(
    surface
    && hasExternalContractSurface
    && isImplementationConsumer
    && !isContractProducer,
  );
  const requireContract = hasOwn(input.args, 'require_contract')
    ? input.args.require_contract !== false
    : (onlyPolicyOrAckTouched ? input.existing?.contractBinding?.requireContract : undefined) ?? defaultRequireContract;
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
    } : undefined,
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
  assertLeaderTaskScopeAllowed(ctx, scope);
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
  let contractWriteResult: BlackboardContractWriteResult = { status: 'skipped', reason: 'not attempted' };
  try {
    // contract / evaluation_policy 不再拼到 description 末尾。
    // 只有显式 contract 模板物化为 BlackboardGraph contract；evaluation_policy 仅保留在 orchestration 元数据中。
    task = ctx.leader.board.createTask(taskId, subject, description, agentType, blockedBy, [], effectiveScope, effectiveContext, {
      orchestration,
      preferred_agent_name: typeof args.preferred_agent_name === 'string' ? args.preferred_agent_name : undefined,
    });
    contractWriteResult = writeContractNodeToBlackboard(ctx, {
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
  const readinessLabel = formatTaskReadiness(ctx, task);


  // 0→1: IntegrationVerifyInjector —— 检测是否需要插入集成验证节点
  let integrationHint = '';
  try {
    const allTasks = ctx.leader.board.getAllTasks().map(t => ({
      id: t.id,
      nodeKind: t.orchestration?.nodeKind,
      agentType: t.agent_type,
      writeScope: t.write_scope,
      blockedBy: t.blocked_by,
      status: t.status,
      contractSurface: t.orchestration?.contractBinding?.surface,
    }));
    const injection = ctx.leader.getIntegrationInjector().analyze(allTasks, ctx.leader.getSharedLedger());
    if (injection.needed && injection.verifyNode) {
      integrationHint = `\nℹ IntegrationVerifyInjector: 建议插入集成验证节点 (${injection.reason})，blocked_by=[${injection.verifyNode.blockedBy.join(',')}]`;
    }
  } catch { /* non-critical */ }

  return `已创建任务 ${task.id}: ${task.subject} [${readinessLabel}]${formatBlockedReason(ctx, task)}${worktree ? ` · worktree:${worktree.branch}` : requestedWorktreePolicy !== 'none' ? ` · worktree_policy:${requestedWorktreePolicy}->${worktreePolicy}` : ''}${orchestration ? ` · orchestration:${orchestration.nodeKind ?? 'generic'} gen=${orchestration.generation ?? 0}` : ''}${formatContractToolStatus(contractTemplate, contractWriteResult)}${agentTypeNote ? ` · 角色:${agentTypeNote}` : ''}${subsystemWarning ? ` · ${subsystemWarning}` : ''}${integrationHint}`;
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
  if (updates.working_directory !== undefined || updates.write_scope !== undefined) {
    assertLeaderTaskScopeAllowed(ctx, {
      working_directory: updates.working_directory ?? task.working_directory,
      write_scope: updates.write_scope ?? task.write_scope,
    });
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
    let contractWriteResult: BlackboardContractWriteResult = { status: 'skipped', reason: 'not attempted' };
    if (nextContractTemplate) {
      contractWriteResult = writeContractNodeToBlackboard(ctx, {
        taskId: updated.id,
        subject: updated.subject,
        agentType: updated.agent_type,
        contract: nextContractTemplate.contract,
        evaluationPolicy: nextContractTemplate.evaluationPolicy,
        surface: nextContractTemplate.surface,
      });
    }
    const bindingLabel = updated.preferred_agent_name ? `预绑定=@${updated.preferred_agent_name}` : '预绑定=无';
    const contractLabel = nextContractTemplate
      ? formatContractToolStatus(nextContractTemplate, contractWriteResult)
      : updated.orchestration?.contractBinding?.surface
        ? ` · contractBinding=contract:${updated.orchestration.contractBinding.surface}`
        : '';
    return `已更新任务 ${updated.id}: ${updated.subject} [${formatTaskReadiness(ctx, updated)}]${formatBlockedReason(ctx, updated)} · blocked_by=${updated.blocked_by.join(', ') || '无'} · ${bindingLabel}${contractLabel}`;
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
  let result: ProjectBlueprint | null = null;
  ctx.leader.db.updateSessionState<unknown>(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT, (current) => {
    const existing = parseBlueprint(current);
    const normalized = normalizeBlueprint({
      subsystems: args.subsystems,
      notes: args.notes,
      existing,
    });
    if ('error' in normalized) {
      throw fail(normalized.error);
    }
    result = normalized;
    return serializeBlueprint(normalized);
  });
  if (!result) {
    throw fail('define_project_blueprint 写入失败: 未生成有效蓝图。');
  }
  const blueprint = result as ProjectBlueprint;
  const coverage = computeBlueprintCoverage(blueprint);
  try {
    ctx.leader.emitter.emit('leader:blueprint_updated', { sessionId: ctx.leader.sessionId, blueprint, coverage });
  } catch (err) {
    leaderLogger.warn(`[LeaderTools] blueprint_updated 事件发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const implementCount = coverage.implemented.length + coverage.uncovered.length;
  const header = `已定义项目蓝图 · ${blueprint.subsystems.length} 子系统(implement ${implementCount} · defer ${coverage.deferred.length} · na ${coverage.notApplicable.length})。`;
  // v1.0.4: 自动 contract seed 默认关闭——Leader 可用 write_contract 直接写契约（更高效）
  // 仅当显式传 auto_contract_tasks: true 时才恢复旧行为
  const autoContractTasks = parseBooleanFlag(args.auto_contract_tasks);
  let contractSummary = '';
  if (autoContractTasks) {
    const seeds = buildSubsystemContractSeeds(blueprint);
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
      }
    }
    if (contractTaskNotes.length > 0) {
      contractSummary = `\n已生成 ${contractTaskNotes.length} 个 contract 任务: ${contractTaskNotes.join('; ')}`;
    }
  } else {
    const surfaces = blueprint.subsystems
      .filter(s => s.status === 'implement')
      .map(s => s.subsystemId);
    contractSummary = surfaces.length > 0
      ? `\n下一步: 用 write_contract(surface="<subsystem_id>", content="...") 为每个子系统写入契约，或 create_task(node_kind="contract") 建单个 architect 任务。\n待写契约: ${surfaces.join(', ')}`
      : '';
  }
  // 0→1: 蓝图完整性自动审查——派一个 planner 专门找遗漏
  let auditHint = '';
  try {
    const userRequest = ctx.leader.db.getSession(ctx.leader.sessionId)?.user_request || '';
    const blueprintJson = JSON.stringify(blueprint.subsystems.map(s => ({ id: s.subsystemId, name: s.name, status: s.status })));
    const auditTaskId = ctx.leader.board.nextTaskId();
    ctx.leader.board.createTask(
      auditTaskId,
      `蓝图完整性审查`,
      [
        `你是蓝图审查员。审查以下蓝图是否覆盖了“完整可用产品”所需的全部子系统。`,
        ``,
        `用户原始需求: ${userRequest}`,
        ``,
        `当前蓝图: ${blueprintJson}`,
        ``,
        `审查维度（不限于）:`,
        `- 用户怎么进来？（认证、登录、注册、OAuth）`,
        `- 用户怎么管理自己？（个人中心、设置、安全）`,
        `- 管理员怎么管？（后台、权限、审计）`,
        `- 出错了怎么办？（错误页、重试、降级）`,
        `- 数据多了怎么办？（分页、搜索、筛选、导出）`,
        `- 界面怎么组织？（导航、布局、响应式、空状态）`,
        `- 操作有反馈吗？（加载态、Toast、进度）`,
        ``,
        `输出格式:`,
        `1. 缺失的子系统列表（subsystem_id + name + 为什么必须有）`,
        `2. 现有子系统的补充建议`,
        `3. 优先级排序`,
        ``,
        `注意: 根据项目类型灵活判断。内部工具不需要注册、CLI 不需要导航、API only 不需要 UI 组件。不要无脑补充，只补真正缺失的。`,
      ].join('\n'),
      'planner',
      [], // blocked_by: 不阻塞任何人
      [], // deps
      {}, // scope
      undefined, // context
      { orchestration: { nodeKind: 'plan' } },
    );
    auditHint = `\n已自动创建蓝图完整性审查任务 ${auditTaskId}（planner 角色）。建议先派发它，根据审查结果补全蓝图后再开工。`;
  } catch (err) {
    leaderLogger.warn(`[LeaderTools] 蓝图审查任务创建失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [header, contractSummary, auditHint].filter(Boolean).join('\n');
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
    let warning: string | null = null;
    let next: ProjectBlueprint | null = null;
    ctx.leader.db.updateSessionState<unknown>(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT, (current) => {
      const existing = parseBlueprint(current);
      if (!existing) return current;
      // 检查 subsystemId 是否存在于蓝图中,不存在时返回明确 warning 给 Leader
      const subsystemExists = existing.subsystems.some((e) => e.subsystemId === subsystemId);
      if (!subsystemExists) {
        const validIds = existing.subsystems.map((e) => e.subsystemId).join(', ');
        warning = `⚠ 子系统 "${subsystemId}" 不在当前蓝图中,任务 ${taskId} 未绑定到任何 subsystem。蓝图不会显示覆盖。合法 subsystem id: ${validIds}`;
        return current;
      }
      next = registerTaskId(existing, subsystemId, taskId);
      return serializeBlueprint(next);
    });
    if (warning) return warning;
    if (!next) return null;
    const blueprint = next as ProjectBlueprint;
    ctx.leader.emitter.emit('leader:blueprint_updated', { sessionId: ctx.leader.sessionId, blueprint, coverage: computeBlueprintCoverage(blueprint) });

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
      const entry = blueprint.subsystems.find((e) => e.subsystemId === subsystemId);
      const depSubsystemIds = entry?.dependsOn ?? [];
      if (!isContractProducer && depSubsystemIds.length > 0 && (!task.blocked_by || task.blocked_by.length === 0)) {
        const depTaskIds = depSubsystemIds
          .flatMap((depId) => blueprint.subsystems.find((e) => e.subsystemId === depId)?.taskIds ?? [])
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
    let next: ProjectBlueprint | null = null;
    ctx.leader.db.updateSessionState<unknown>(ctx.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT, (current) => {
      const existing = parseBlueprint(current);
      if (!existing) return current;
      next = unregisterTaskId(existing, taskId);
      return serializeBlueprint(next);
    });
    if (!next) return;
    const blueprint = next as ProjectBlueprint;
    ctx.leader.emitter.emit('leader:blueprint_updated', { sessionId: ctx.leader.sessionId, blueprint, coverage: computeBlueprintCoverage(blueprint) });
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

/** delete_agent_role 实现：删除 define_agent_role/create_task(role_definition) 产生的 runtime 自定义角色 */
export function deleteAgentRole(ctx: TaskPlanningContext, args: Record<string, unknown>): string {
  const roleName = normalizeOptionalString(args.role_name ?? args.name);
  if (!roleName) {
    throw fail('role_name 不能为空');
  }

  const role = ctx.leader.getRoleRegistry().get(roleName) as AgentRole | undefined;
  if (!role) {
    return `角色 '${roleName}' 不存在，无需删除。`;
  }
  if (role.createdBy === 'system') {
    throw fail(`不能删除系统预设角色 '${roleName}'。如需调整工具，请使用角色 override/reset。`);
  }
  if (role.createdBy === 'user') {
    throw fail(`角色 '${roleName}' 来自持久化 custom agent 文件。请在 Settings → Roles 删除该 agent 文件，或删除 .lingxiao/agents/${roleName}.md。`);
  }

  const force = parseBooleanFlag(args.force);
  const activeRefs = ctx.leader.board.getAllTasks()
    .filter((task) => task.agent_type === roleName && task.status !== 'terminal')
    .map((task) => `${task.id}:${task.status}`);
  if (activeRefs.length > 0 && !force) {
    throw fail(`角色 '${roleName}' 仍被未终态任务引用：${activeRefs.join(', ')}。如确认只删除角色定义并保留任务记录，请传 force=true。`);
  }

  const removed = ctx.leader.getRoleRegistry().unregister(roleName);
  if (!removed) {
    throw fail(`角色 '${roleName}' 删除失败。`);
  }
  persistCustomRolesSnapshot(ctx);
  return `已删除 runtime 自定义角色 '${roleName}'。`;
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
