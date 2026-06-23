/**
 * LeaderToolsExecutor - Leader 元工具执行器
 * 执行 Leader 的管理类工具，如 create_task, dispatch_agent 等
 */

import type { LeaderAgent } from './LeaderAgent.js';
import type { Task as BoardTask, TaskScopeConfig } from '../core/TaskBoard.js';
import type { AgentHandle } from './AgentPoolRuntime.js';
import type { WorkNote } from '../core/WorkNoteManager.js';
import { PLAN_REVIEW_ENABLED } from '../config.js';
import type { PermissionMode } from '../core/PermissionSystem.js';
import type { PermissionUpdateDestination } from '../core/PermissionStore.js';
import { clearRecoveryRecord } from '../core/RecoveryRecords.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { parseBlueprint, computeBlueprintCoverage } from '../core/ProjectBlueprint.js';
import { tempDownloadRegistry } from '../core/TempDownloadRegistry.js';
import { getModelManager } from '../config/ModelManager.js';
import { leaderLogger } from '../core/Log.js';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { AssetUsageStore } from '../memory/AssetUsageStore.js';
import type { OrchestrationTaskMetadata, OrchestrationNodeKind } from '../core/OrchestrationTypes.js';
import { isAgentRuntimeActiveStatus } from '../contracts/adapters/StatusAdapter.js';
import {
  setBughuntDag,
  upsertBughuntFinding,
  readBughuntLedger,
  getOpenBughuntFindings,
  getBughuntFinding,
  appendBughuntEvent,
  summarizeBughuntLedger,
  buildBughuntBrief,
  type BughuntSeverity,
  type BughuntEvidenceKind,
} from '../core/BughuntLedger.js';
import { getReadyDagNodes } from '../core/BughuntDagScheduler.js';
import {
  runCompileVerification,
  runBlackboxVerification,
  type CompileCommand,
  type BlackboxProbe,
} from '../core/verify/BughuntVerificationRunner.js';
import {
  type AgentControlContext,
  sendMessageToAgent as agentSendMessage,
  forceCompleteTask as agentForceCompleteTask,
  retryAgentLlm as agentRetryLlm,
  nudgeAgent as agentNudge,
  compactAgentContext as agentCompactContext,
  pauseAgent as agentPause,
  resumeAgent as agentResume,
  interveneAgent as agentIntervene,
  confirmIntervention as agentConfirmIntervention,
  terminateAgent as agentTerminate,
  checkAgentProgress as agentCheckProgress,
  listRuntimeAgents as agentListRuntimeAgents,
} from './leader/tools/LeaderAgentControlTools.js';
import {
  type TaskPlanningContext,
  createTask as planCreateTask,
  updateTask as planUpdateTask,
  deleteTask as planDeleteTask,
  defineAgentRole as planDefineAgentRole,
  deleteAgentRole as planDeleteAgentRole,
  defineProjectBlueprint as planDefineProjectBlueprint,
  listAvailableRoles as planListAvailableRoles,
  updateTaskStatus as planUpdateTaskStatus,
} from './leader/tools/LeaderTaskPlanningTools.js';
import {
  validateDispatchAgentName as gateValidateDispatchAgentName,
  formatRoster as gateFormatRoster,
  isLeaderExecutionTool as gateIsLeaderExecutionTool,
  evaluateLeaderAutonomyToolGate,
} from './leader/LeaderToolGates.js';
import { LeaderToolFailure, fail, type DispatchItemStatus } from './leader/LeaderToolFailure.js';
import { getTeamMailbox, getTeamMemberRegistry } from '../core/TeamMailbox.js';
import { MemoryManager, type MemoryScope, type MemoryType } from '../memory/MemoryManager.js';
import { resolveModeRuntimeProjection, type ModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import { readPersistedEternalGoal } from '../core/EternalGoal.js';
import { getPromptCatalog } from './prompts/i18n/catalog.js';
import { normalizeCapabilityIntentProfile } from './IntentClassifier.js';
import type { LeaderAutonomyToolGateResult } from './leader/LeaderToolGates.js';
import { collectPrimitiveLeaves } from '../tools/Registry.js';

/**
 * 把应进入 string[] 的值深度拍平为非空 string 数组。GLM 常把 string[] 误写成嵌套对象
 * （如 {item:{...,$text:"path"}} —— XML 语义泄进 JSON）；Leader 元工具 args 不过
 * normalizeValueForSchema（ToolRegistry 路径才过），需在此手动 coerce，复用同源
 * collectPrimitiveLeaves 单一事实源（避免两处拍平逻辑漂移）。
 */
function coerceToStringArray(raw: unknown): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  const leaves: unknown[] = [];
  collectPrimitiveLeaves(raw, leaves);
  const arr = leaves.map((v) => String(v)).filter((s) => s.length > 0);
  return arr.length > 0 ? arr : undefined;
}

function compactOneLine(value: unknown, max = 180): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value != null) {
    try {
      text = JSON.stringify(value);
    } catch {/* swallowed: unhandled error */
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function memoryNameFromContent(prefix: string, content: string, timestamp = Date.now()): string {
  const slug = compactOneLine(content, 48)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${timestamp}${slug ? `-${slug}` : ''}`.slice(0, 120);
}

function normalizeAgentName(name: string): string {
  return name.trim().replace(/^@+/, '');
}

function isAgentLogToolCallEvent(eventType: string): boolean {
  return eventType === 'leader:tool_call' || eventType === 'agent:tool_call';
}

function isAgentLogToolResultEvent(eventType: string): boolean {
  return eventType === 'leader:tool_result' || eventType === 'agent:tool_result';
}

function summarizeAgentLogContent(eventType: string, content: string): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    const tool = parsed.tool || parsed.toolName || parsed.name || parsed.function?.name;
    const input = parsed.input ?? parsed.args ?? parsed.arguments ?? parsed.function?.arguments;
    const result = parsed.result ?? parsed.output ?? parsed.content ?? parsed.error;
    if (tool && isAgentLogToolCallEvent(eventType)) {
      return ` ${tool}(${compactOneLine(input, 120)})`;
    }
    if (tool && isAgentLogToolResultEvent(eventType)) {
      return ` ${tool} => ${compactOneLine(result, 140)}`;
    }
    return ` ${compactOneLine(parsed, 160)}`;
  } catch {/* expected: fallback to default */
    return ` ${compactOneLine(content, 180)}`;
  }
}

// dispatch_batch 子项状态沿用共享的 DispatchItemStatus（来自 LeaderToolFailure）。
// 子项的成功/跳过/失败不再靠字符串匹配判定，而是直接取自 dispatchAgentWithOptions
// 抛出的 LeaderToolFailure.status（成功项为 'ok'）——去启发式。

/**
 * Leader 元工具执行器
 */
export class LeaderToolsExecutor {
  protected leader: LeaderAgent;
  /** check_agent_progress 冷却：agentName → 上次调用时间戳(ms) */
  private _progressCheckCooldown = new Map<string, number>();
  /** terminate_agent 门禁：agentName → 最近一次真实 check_agent_progress 时间戳(ms) */
  private _progressCheckEvidence = new Map<string, number>();
  private static readonly PROGRESS_CHECK_COOLDOWN_MS = 60_000; // 同一 Agent 60s 内只能查一次

  constructor(leader: LeaderAgent) {
    this.leader = leader;
  }

  protected getLeader(): LeaderAgent {
    return this.leader;
  }

  /**
   * 解析 agent name：先查 AgentPool runtime handle，找不到时诊断 team member 状态
   */
  protected resolveAgentHandle(agentName: string): { handle: AgentHandle } | { error: string } {
    const handle = this.leader.pool.getByName(agentName);
    if (handle) return { handle };

    // 查 team member registry 提供诊断
    const allHandles = this.leader.pool.getAll();
    const allNames = allHandles.map(h => h.name);

    let diagnostic = `未找到 Agent @${agentName}。`;

    // 尝试检查是否是 team member（未 dispatch）
    try {
      const registry = getTeamMemberRegistry();
      const member = registry.getByName(agentName, this.leader.sessionId);
      if (member) {
        diagnostic += `\n@${agentName} 是 team roster 成员，但尚未被 dispatch_agent 派发，没有运行中的 AgentPool handle。`;
        diagnostic += `\n要操作此 Agent，请先用 dispatch_agent 派发任务给它。`;
      }
    } catch { /* TeamMailbox not available */ }

    if (allNames.length > 0) {
      diagnostic += `\n当前可操作的 runtime agents: ${allNames.join(', ')}`;
    } else {
      diagnostic += `\n当前没有运行中的 Agent。`;
    }

    return { error: diagnostic };
  }

  protected normalizeAgentName(name: string): string {
    return normalizeAgentName(name);
  }

  private getActiveTeamRoster(): Array<{ name: string; role: string }> {
    const activeTeam = this.leader.getActiveTeam();
    if (!activeTeam) return [];
    try {
      const registry = getTeamMemberRegistry();
      return registry.getByTeam(activeTeam, this.leader.sessionId).map((m: { name: string; role: string }) => ({ name: m.name, role: m.role }));
    } catch (err) {
      leaderLogger.warn(`[LeaderTools] getActiveTeamRoster 失败: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private formatActiveTeamRoster(): string {
    return gateFormatRoster(this.getActiveTeamRoster());
  }

  private validateDispatchAgentName(agentName: string): { ok: true } | { ok: false; message: string } {
    return gateValidateDispatchAgentName({
      agentName,
      activeTeam: this.leader.getActiveTeam() || null,
      roster: this.getActiveTeamRoster(),
    });
  }

  /**
   * Team 模式下 dispatch/explore 时自动建团/加成员 fallback。
   *
   * 当 collaboration mode 为 team 时：
   * - 没有 active team → 自动创建包含 leader + 目标 agent 的最小 team
   * - 有 active team 但 agent 不在 roster → 自动 add 成员
   *
   * 这消除了 Team 模式下"先建团再 dispatch"和"先 add 再 dispatch"的摩擦。
   * Leader 仍可主动 team_manage(create) 建团以设置 description/workspace/一次列全成员；
   * 此方法只是无摩擦兜底，不替代主动规划。
   */
  private ensureTeamForDispatch(agentName: string): { ok: true; teamName: string } | { ok: false; message: string } {
    const sessionId = this.leader.sessionId;
    const leaderName = this.leader.name || 'leader';
    const mailbox = getTeamMailbox();
    const registry = getTeamMemberRegistry();

    // 情况 1：已有 active team，但 agent 不在 roster → 自动 add
    const existingTeam = this.leader.getActiveTeam();
    if (existingTeam) {
      const team = mailbox.getTeam(existingTeam, sessionId);
      if (team) {
        const roster = registry.getByTeam(existingTeam, sessionId);
        const isInRoster = roster.some((m: { name: string; role: string }) => m.name === agentName);
        if (isInRoster) return { ok: true, teamName: existingTeam };
        // agent 不在 roster → 自动 add
        try {
          if (!team.members.includes(agentName)) {
            mailbox.updateTeam(existingTeam, sessionId, { members: [...team.members, agentName] });
          }
          registry.register({
            name: agentName,
            team: existingTeam,
            role: 'member',
            workspace: team.workspace || process.cwd(),
            sessionId,
          });
          leaderLogger.info(`[AutoTeam] 已将 @${agentName} 自动加入现有 team "${existingTeam}"`);
          return { ok: true, teamName: existingTeam };
        } catch (err) {
          return {
            ok: false,
            message: `自动加成员失败: ${err instanceof Error ? err.message : String(err)}。请手动 team_manage(action="edit", edit_action="add", member="${agentName}")。`,
          };
        }
      }
    }

    // 情况 2：没有活跃 team → 自动创建
    const teamName = `auto-${sessionId.slice(0, 8)}`;
    if (mailbox.teamExists(teamName, sessionId)) {
      const team = mailbox.getTeam(teamName, sessionId);
      if (team && !team.members.includes(agentName)) {
        mailbox.updateTeam(teamName, sessionId, { members: [...team.members, agentName] });
      }
      if (!registry.getByName(agentName, sessionId)) {
        registry.register({
          name: agentName,
          team: teamName,
          role: 'member',
          workspace: process.cwd(),
          sessionId,
        });
      }
    } else {
      try {
        mailbox.createTeam({
          name: teamName,
          description: 'Auto-created team for dispatch',
          leader: leaderName,
          members: [agentName],
          workspace: process.cwd(),
          sessionId,
        });
        registry.register({
          name: leaderName,
          team: teamName,
          role: 'leader',
          workspace: process.cwd(),
          sessionId,
        });
        registry.register({
          name: agentName,
          team: teamName,
          role: 'member',
          workspace: process.cwd(),
          sessionId,
        });
      } catch (err) {
        return {
          ok: false,
          message: `自动建团失败: ${err instanceof Error ? err.message : String(err)}。请手动调用 team_manage(action="create") 建团。`,
        };
      }
    }

    this.leader.setActiveTeam(teamName);
    leaderLogger.info(`[AutoTeam] 自动创建 team "${teamName}" (leader=@${leaderName}, member=@${agentName})`);
    this.leader.emitter.emit('leader:status', {
      sessionId,
      status: `ℹ️ 自动建团 "${teamName}" 并加入 @${agentName}`,
    });
    return { ok: true, teamName };
  }

  private buildTeamDispatchContext(agentName: string): string {
    const activeTeam = this.leader.getActiveTeam();
    if (!activeTeam) return '';
    const peers = this.getActiveTeamRoster()
      .filter(m => m.role === 'member' && m.name !== agentName)
      .map(m => m.name);
    return [
      '[Team 协作指令 — 系统注入]',
      `你属于 team "${activeTeam}"，当前成员：${this.formatActiveTeamRoster() || '未知'}。`,
      '启动后先调用 team_inbox(unread_only=true, mark_read=true) 读取 P2P 私信和 team 广播。',
      peers.length > 0 ? `需要对接时优先直接联系这些同伴：${peers.map(p => `@${p}`).join(', ')}。` : '',
      '想了解同伴进度时调用 team_manage(action="task_board")（只读，不打断同伴）。',
      '当 API/数据结构/文件路径/组件 props/运行命令/验收口径发生新增或变化时，必须用 team_message 通知受影响成员；全队相关事项用 target_type="team" + target 广播。',
      '需要对方明确答复时用 type="request"+request_id；处理完别人的 request 后用 type="ack"+同一 request_id 回执闭环。',
      '收到 [协商请求] 时先与对方直接协商收敛（拆分写入路径或串行化），谈拢后回 ack；谈不拢再升级 Leader。',
      '遇到依赖阻塞时先 team_message 询问对应成员；只有需要用户/Leader 决策或无人响应时才升级给 Leader。',
      '结束前再 team_inbox 一次，并在最终结果摘要中汇总关键收发消息。',
    ].filter(Boolean).join('\n');
  }

  /** 给 LeaderAgentControlTools 等子模块用的上下文，封装通用 helper + 状态字段 */
  protected getAgentControlContext(): AgentControlContext {
    return {
      leader: this.leader,
      resolveAgentHandle: (name) => this.resolveAgentHandle(name),
      normalizeAgentName: (name) => this.normalizeAgentName(name),
      progressCheckCooldown: this._progressCheckCooldown,
      progressCheckCooldownMs: LeaderToolsExecutor.PROGRESS_CHECK_COOLDOWN_MS,
      progressCheckEvidence: this._progressCheckEvidence,
    };
  }

  /** 给 LeaderTaskPlanningTools 用的上下文：dispatchAgent 仍留在本类内部 */
  protected getTaskPlanningContext(): TaskPlanningContext {
    return {
      leader: this.leader,
      normalizeAgentName: (name) => this.normalizeAgentName(name),
      dispatchAgent: (args) => this.dispatchAgent(args),
    };
  }

  private readCurrentUserTurnId(): number {
    const raw = this.leader.db.getSessionState(this.leader.sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID);
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
  }

  private readRecordedCapabilityIntentTurnId(): number | null {
    const raw = this.leader.db.getSessionState(this.leader.sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID);
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
  }

  private recordCapabilityIntent(args: Record<string, unknown>): string {
    // 意图识别工具豁免工具抑制检查：record_capability_intent 是理解用户需求的前提，
    // 即使用户说"不要调用工具"，也需要先识别意图才能理解用户到底想做什么。
    // 元认知工具 > 执行工具，意图识别属于元认知层，不应被执行层的抑制逻辑拦截。
    // if (this.leader.isUserInterruptPending() || this.leader.isToolUseSuppressedForCurrentTurn()) {
    //   return 'ERROR: record_capability_intent 已被跳过：检测到更新的用户输入/本轮用户明确要求不要调用工具。请立即停止工具调用，直接回复最新用户消息。';
    // }
    const currentTurnId = this.readCurrentUserTurnId();
    const recordedTurnId = this.readRecordedCapabilityIntentTurnId();
    if (currentTurnId > 0 && recordedTurnId === currentTurnId) {
      const existing = this.leader.db.getSessionState(this.leader.sessionId, SESSION_KEYS.CAPABILITY_INTENT_PROFILE);
      return `本轮 capability intent profile 已记录为 ${compactOneLine(existing, 120)}；不要再次调用 record_capability_intent，请直接继续执行用户请求。`;
    }

    const now = Date.now();
    const profile = normalizeCapabilityIntentProfile(args, {
      turnId: currentTurnId || null,
      now,
      source: 'record_capability_intent',
    });
    if (!profile) {
      return 'ERROR: record_capability_intent 参数无效：必须提供合法 primaryIntent/scope/phase/grants/denies/requiredGates/constraints/confidence/reason。';
    }
    this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.CAPABILITY_INTENT_PROFILE, JSON.stringify(profile));
    if (currentTurnId > 0) {
      this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID, currentTurnId);
    }
    this.leader.emitter.emit('leader:capability_intent', {
      sessionId: this.leader.sessionId,
      profile,
    });
    return `已记录 capability intent profile：${profile.primaryIntent}/${profile.phase}/${profile.scope.kind} (confidence=${profile.confidence.toFixed(2)}) — ${profile.reason}\n现在继续执行用户请求；本轮不要再次调用 record_capability_intent。`;
  }

  private recordAutonomyDecision(toolName: string, gate: LeaderAutonomyToolGateResult): void {
    const gateResult = gate.ok
      ? 'allow'
      : gate.gateKind === 'confirmation_required'
        ? 'confirmation_required'
        : 'blocked';
    const trace = {
      toolName,
      decision: gate.decision,
      gateResult,
      gateKind: gate.ok ? null : gate.gateKind,
      recordedAt: Date.now(),
      source: 'leader_tool_gate',
    };
    this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.AUTONOMY_DECISION_TRACE, JSON.stringify(trace));
    this.leader.emitter.emit('leader:autonomy_decision', {
      sessionId: this.leader.sessionId,
      ...trace,
    });
  }

  /**
   * 执行元工具
   *
   * 注意：team_manage / bughunt_*scan 已下放成
   * 普通 Tool（走 directToolsExecutor → ToolRegistry），不再在这里路由。
   * 这里只保留：
   *   - 带 Leader 状态副作用的元工具（setActiveTeam、setDelegateMode、agent
   *     生命周期控制等）
   *   - bughunt ledger 元工具（直接读写 BughuntLedger 内存表）
   */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'record_capability_intent') {
      return this.recordCapabilityIntent(args);
    }

    const autonomyGate = evaluateLeaderAutonomyToolGate({
      toolName: name,
      args,
      modes: resolveModeRuntimeProjection({
        sessionId: this.leader.sessionId,
        db: this.leader.db,
        blackboardAvailable: this.leader.isBlackboardEnabled(),
        permissionContext: this.leader.getPermissionContext(),
        permissionSummary: this.leader.getInteractionSnapshot().permissionSummary,
      }),
      permissionContext: this.leader.getPermissionContext(),
    });
    this.recordAutonomyDecision(name, autonomyGate);
    if (!autonomyGate.ok) {
      return `ERROR: ${autonomyGate.message}`;
    }

    const ctx = this.getAgentControlContext();
    const planCtx = this.getTaskPlanningContext();
    switch (name) {
      case 'create_task':
        return await planCreateTask(planCtx, args);
      case 'update_task':
        return await planUpdateTask(planCtx, args);
      case 'delete_task':
        return await planDeleteTask(planCtx, args);
      case 'define_agent_role':
        return await planDefineAgentRole(planCtx, args);
      case 'delete_agent_role':
        return planDeleteAgentRole(planCtx, args);
      case 'define_project_blueprint':
        return await planDefineProjectBlueprint(planCtx, args);
      case 'list_available_roles':
        return planListAvailableRoles(planCtx);
      case 'dispatch_agent':
        return await this.dispatchAgent(args);
      case 'dispatch_batch':
        return await this.dispatchBatch(args);
      case 'explore':
        return await this.exploreCodebase(args);
      case 'send_message_to_agent':
        return await agentSendMessage(ctx, args);
      case 'update_task_status':
        return await planUpdateTaskStatus(planCtx, args);
      case 'force_complete_task':
        return await agentForceCompleteTask(ctx, args);
      case 'retry_agent_llm':
        return await agentRetryLlm(ctx, args);
      case 'nudge_agent':
        return await agentNudge(ctx, args);
      case 'compact_agent_context':
        return await agentCompactContext(ctx, args);
      case 'create_download_link':
        return this.createDownloadLink(args);
      case 'pause_agent':
        return await agentPause(ctx, args);
      case 'resume_agent':
        return await agentResume(ctx, args);
      case 'intervene_agent':
        return await agentIntervene(ctx, args);
      case 'terminate_agent':
        return await agentTerminate(ctx, args);
      case 'confirm_intervention':
        return await agentConfirmIntervention(ctx, args);
      case 'ask_user':
        return await this.askUser(args);
      case 'plan_create':
        return this.planCreate(args);
      case 'plan_update':
        return this.planUpdate(args);
      case 'plan_checkpoint':
        return this.planCheckpoint(args);
      case 'plan_finalize':
        return this.planFinalize(args);
      case 'submit_plan':
        return await this.submitPlan(args);
      case 'finish_session':
        return await this.finishSession(args);
      case 'complete_eternal_goal':
        return await this.completeEternalGoal(args);
      case 'list_runtime_agents':
        return await agentListRuntimeAgents(ctx, args);
      case 'check_agent_progress':
        return await agentCheckProgress(ctx, args);
      case 'learn_soul':
        return await this.learnSoul(args);
      case 'request_permission_update':
        return await this.requestPermissionUpdate(args);
      case 'write_work_note':
        return await this.writeWorkNote(args);
      case 'request_work_note':
        return await this.requestWorkNote(args);
      case 'read_work_notes':
        return await this.readWorkNotes(args);
      case 'set_bughunt_dag':
        return this.setBughuntDagTool(args);
      case 'upsert_bughunt_finding':
        return this.upsertBughuntFindingTool(args);
      case 'get_bughunt_ledger':
        return this.getBughuntLedgerTool(args);
      case 'get_ready_dag_nodes':
        return this.getReadyDagNodesTool(args);
      case 'verify_finding':
        return await this.verifyFindingTool(args);
      default:
        throw new Error(`Unknown leader tool: ${name}`);
    }
  }

  protected createDownloadLink(args: Record<string, unknown>): string {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rawPath) {
      throw fail('path 不能为空');
    }

    const resolvedPath = resolve(this.leader.workspace, rawPath);
    if (!existsSync(resolvedPath)) {
      throw fail(`文件不存在：${resolvedPath}`);
    }


    try {
      const artifact = tempDownloadRegistry.create({
        path: resolvedPath,
        name: typeof args.name === 'string' ? args.name : undefined,
        mimeType: typeof args.mime_type === 'string' ? args.mime_type : undefined,
        expiresInSeconds: typeof args.expires_in_seconds === 'number' ? args.expires_in_seconds : undefined,
        sessionId: this.leader.sessionId,
      });
      return JSON.stringify(artifact);
    } catch (error) {
      throw fail(`创建下载链接失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }






  /**
   * 派发 Agent 执行任务
   */
  protected async dispatchAgent(args: Record<string, unknown>): Promise<string> {
    return this.dispatchAgentWithOptions(args);
  }

  protected async dispatchAgentWithOptions(
    args: Record<string, unknown>,
    options: { modes?: ModeRuntimeProjection } = {},
  ): Promise<string> {
    const taskId = args.task_id as string;
    const agentName = this.normalizeAgentName(String(args.agent_name || ''));

    const task = this.leader.board.getTask(taskId);
    if (!task) {
      throw fail(`任务 ${taskId} 不存在`);
    }
    // 项目蓝图覆盖 gate:会话定义了蓝图时,任何 implement 子系统若无任务覆盖,拦截派发。
    // 防止"定义了完整蓝图却只建部分任务就开工"导致规划坍缩成 MVP。确定性:机械比对蓝图
    // status=implement 子系统的 taskIds。解除方式见反馈。
    {
      const blueprint = parseBlueprint(this.leader.db.getSessionState(this.leader.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));
      if (blueprint) {
        const coverage = computeBlueprintCoverage(blueprint);
        // contract 节点(架构师产契约)豁免覆盖检查:契约是实现的前置,应能在所有 implement 子系统
        // 都建好实现任务之前先派发(define_project_blueprint 已自动为每子系统建 contract 任务)。
        // 仅豁免 node_kind=contract;evaluate/repair 等事后节点不豁免。
        if (coverage.uncovered.length > 0 && task.orchestration?.nodeKind !== 'contract') {
          const gapList = coverage.uncovered.map((s) => `${s.id}(${s.name})`).join(', ');
          throw fail([
            `项目蓝图覆盖不完整:${coverage.uncovered.length} 个 implement 子系统尚无任务,不能派发。`,
            `  缺口: ${gapList}`,
            `补救(任选其一):`,
            `  1. 为每个缺口 create_task(subsystem=<id>) 建任务;`,
            `  2. 若确实不做,define_project_blueprint 把对应子系统 status=defer/not_applicable 并附 rationale;`,
            `  3. 若这是与当前蓝图无关的新项目,重新 define_project_blueprint 覆盖旧蓝图。`,
            `合法 subsystem id 见每轮注入的「项目蓝图」概览。`,
          ].join('\n'), 'skipped');
        }
      }
    }
    // 终态任务防御性拒绝守卫
    if (task.status === 'terminal') {
      throw fail(`任务 ${taskId} 已处于终态 '${task.exitReason}'，不能重新派发。如需重新执行，请创建新任务。`, 'skipped');
    }
    if (task.status !== 'dispatchable') {
      throw fail(`任务状态为 ${task.status}`, 'skipped');
    }
    if (!this.leader.board.isTaskReady(task.id)) {
      const reason = this.leader.board.getBlockedReason(task) ?? '等待依赖或契约就绪';
      throw fail(`任务 ${taskId} 依赖/契约未就绪：${reason}`, 'skipped');
    }
    if (!agentName) {
      throw fail('agent_name 不能为空');
    }
    const modes = options.modes ?? resolveModeRuntimeProjection({
      sessionId: this.leader.sessionId,
      db: this.leader.db,
      blackboardAvailable: this.leader.isBlackboardEnabled(),
      permissionSummary: this.leader.getInteractionSnapshot().permissionSummary,
    });
    if (modes.collaboration.mode === 'team') {
      const rosterValidation = this.validateDispatchAgentName(agentName);
      if (!rosterValidation.ok) {
        // Auto-team fallback: Team 模式下无 active team 或 agent 不在 roster 时，
        // 自动建团/加成员而不是硬报错，消除两步摩擦。
        // Leader 仍可主动 team_manage(create) 建团以设置 description/workspace/一次列全成员。
        const autoTeam = this.ensureTeamForDispatch(agentName);
        if (!autoTeam.ok) {
          throw fail(autoTeam.message);
        }
        const reValidation = this.validateDispatchAgentName(agentName);
        if (!reValidation.ok) {
          throw fail(reValidation.message);
        }
      }
    }
    const preferredAgentName = typeof (task as BoardTask & { preferred_agent_name?: unknown }).preferred_agent_name === 'string'
      ? String((task as BoardTask & { preferred_agent_name?: unknown }).preferred_agent_name)
      : '';
    if (preferredAgentName && agentName !== preferredAgentName) {
      throw fail(`任务 ${taskId} 已预绑定 preferred_agent_name=@${preferredAgentName}，dispatch_agent 必须使用同一个 agent_name。当前传入 @${agentName}。`);
    }

    const existingHandle = typeof this.leader.pool.getByName === 'function'
      ? this.leader.pool.getByName(agentName)
      : undefined;
    if (existingHandle && isAgentRuntimeActiveStatus(existingHandle)) {
      throw fail(`Agent @${agentName} 已在执行任务 ${existingHandle.taskId}，请换一个新名字`, 'skipped');
    }

    // 检查角色是否存在
    if (!this.leader.getRoleRegistry().exists(task.agent_type)) {
      throw fail(`角色 '${task.agent_type}' 不存在`);
    }

    const registeredRole = this.leader.getRoleRegistry().get(task.agent_type)!;
    let roleType = task.agent_type;
    let displayRole = registeredRole.name;
    let capabilityDetails: AgentHandle['capabilityDetails'] | undefined;

    if (registeredRole.capabilityProfile?.source === 'preset') {
      const capability = this.leader.resolveRoleCapability({
        roleName: registeredRole.name,
        baseRoleName: registeredRole.capabilityProfile.baselineRole || registeredRole.name,
        roleDescription: `${task.subject}\n${task.description || ''}`,
        systemPrompt: registeredRole.systemPrompt,
        tools: registeredRole.tools,
        requestedSkillNames: registeredRole.skillNames,
      });

      const roleChanged =
        capability.skillNames.length > 0 ||
        capability.droppedTools.length > 0 ||
        capability.tools.join(',') !== registeredRole.tools.join(',');

      if (roleChanged) {
        roleType = `${registeredRole.name}__${task.id}`;
        displayRole = registeredRole.name;
        const enhancedRole = this.leader.getRoleRegistry().register({
          ...registeredRole,
          name: roleType,
          tools: capability.tools,
          droppedTools: capability.droppedTools,
          skillNames: capability.skillNames,
          capabilityProfile: capability.capabilityProfile,
          createdBy: 'llm',
        });
        this.leader.board.updateTask(task.id, { agent_type: roleType });
        task.agent_type = roleType;
        this.leader.db.setSessionState(
          this.leader.sessionId,
          SESSION_KEYS.CUSTOM_ROLES,
          JSON.stringify(this.leader.getRoleRegistry().toDict()),
        );
        capabilityDetails = {
          baselineRole: enhancedRole.capabilityProfile?.baselineRole || displayRole,
          skillNames: enhancedRole.skillNames || [],
          droppedTools: enhancedRole.droppedTools || [],
          tools: enhancedRole.tools,
        };
      }
    }

    const teamDispatchContext = modes.collaboration.teamEnabled
      ? this.buildTeamDispatchContext(agentName)
      : '';
    if (teamDispatchContext && !task.context?.includes('[Team 协作指令 — 系统注入]')) {
      task.context = task.context ? `${task.context}\n\n${teamDispatchContext}` : teamDispatchContext;
    }

    // 注：前序依赖、scratchpad、artifact awareness、黑板快照由 AgentPool.buildWorkerPayload
    // 内的 Context Manifest 统一注入；这里只保留 team dispatch 的即时协作指令。

    // 走统一调度器派发；scheduler 内部完成 pool.register + assignTask + bus.register + runAgentWrapper
    const scheduler = this.leader.getScheduler?.();
    if (!scheduler) {
      throw fail('UnifiedScheduler 未初始化，无法派发');
    }
    const dispatched = await scheduler.requestDispatch(task, {
      agentName,
      displayRole,
      capabilityDetails,
      collaborationMode: modes.collaboration.mode,
      runtimeIdentity: modes.collaboration.mode === 'team'
        ? {
            visibility: 'team',
            owner: 'team',
            interactive: true,
            persistAcrossTurns: true,
            teamMember: agentName,
          }
        : {
            visibility: 'ephemeral',
            owner: 'leader',
            interactive: false,
            persistAcrossTurns: false,
            teamMember: null,
          },
    });
    if (!dispatched) {
      // 优先使用 scheduler 的精确拒绝原因
      const schedulerReason = scheduler.getLastRejectReason?.();
      if (schedulerReason) {
        throw fail(`调度器拒绝派发任务 ${taskId}：${schedulerReason}`, 'skipped');
      }
      // 兜底：区分"槽位已满"与"任务状态变化/依赖未就绪"
      const cap = scheduler.getCapacityInfo();
      const blockedReason = this.leader.board.getBlockedReason(task);
      if (cap.available === 0) {
        throw fail(
          `并发槽位已满（${cap.running}/${cap.max}），任务 ${taskId} 暂时无法派发。` +
          `请等待正在运行的 Agent 完成后再重试，或减少同批 dispatch_batch 的并行数量。`,
          'skipped',
        );
      }
      const reason = blockedReason ?? '任务状态变化或依赖/契约未就绪';
      throw fail(`调度器拒绝派发任务 ${taskId}（${reason}）`, 'skipped');
    }
    // Record real usage so distill's C gate can later refine proven agents (N5-A).
    try {
      new AssetUsageStore(join(this.leader.workspace, '.lingxiao')).recordUsage({
        assetRef: `agents/${agentName}`,
        kind: 'agent_spawned',
        sessionId: this.leader.sessionId,
        taskId: task.id,
        timestamp: Date.now(),
      });
    } catch { /* usage tracking is best-effort, never blocks dispatch */ }
    this.leader.setDelegateMode(`已委派任务 ${taskId} 给 @${agentName}，Leader 切换为委派主控模式。`);

    return `已启动 Agent ${agentName}${capabilityDetails ? ` (baseline=${capabilityDetails.baselineRole}${capabilityDetails.skillNames.length > 0 ? ` · skills=${capabilityDetails.skillNames.join(', ')}` : ''}${capabilityDetails.droppedTools.length > 0 ? ` · dropped=${capabilityDetails.droppedTools.join(', ')}` : ''})` : ''}`;
  }

  /**
   * 一键只读探索：创建 explore 任务并派发 ephemeral worker（Solo 下）。
   * 等价于 create_task(agent_type="explore") + dispatch_agent，封装成单步调用。
   * worker 在独立隔离上下文做广度搜索，只回结论，避免主上下文被搜索过程撑爆。
   */
  protected async exploreCodebase(args: Record<string, unknown>): Promise<string> {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    if (!goal) {
      throw fail('explore 工具的 goal 不能为空');
    }
    const scope = typeof args.scope === 'string' ? args.scope.trim() : '';
    const breadth = args.breadth === 'thorough' ? 'thorough' : 'medium';
    const focusQuestions = Array.isArray(args.focus_questions)
      ? (args.focus_questions as unknown[])
          .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
          .map((q) => q.trim())
      : [];

    const subject = goal.length > 60 ? `${goal.slice(0, 60)}…` : goal;
    const contextParts: string[] = [`【探索目标】\n${goal}`];
    if (scope) contextParts.push(`【范围】${scope}`);
    contextParts.push(`【搜索广度】${breadth}`);
    if (focusQuestions.length > 0) {
      contextParts.push(`【需逐一回答的子问题】\n${focusQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
    }
    contextParts.push('【输出要求】用 attempt_completion 回流结构化结论：关键发现 + 精确定位点（文件路径:行号）+ 风险/注意 + 建议下一步。不要把源码正文抄进结论。');
    const context = contextParts.join('\n\n');

    // 自动生成唯一 ephemeral 名（带时间戳，避免与运行中 worker 重名）
    const requestedName = typeof args.agent_name === 'string' ? this.normalizeAgentName(args.agent_name) : '';
    const agentName = requestedName || memoryNameFromContent('explore', goal);

    const taskId = this.leader.board.nextTaskId();
    this.leader.board.createTask(
      taskId,
      subject,
      goal,
      'explore',
      [],
      [],
      undefined,
      context,
      { taskType: 'explore', preferred_agent_name: agentName },
    );

    const dispatchResult = await this.dispatchAgentWithOptions({ task_id: taskId, agent_name: agentName });
    // 在返回结果前缀 task_id，供 Leader 追踪异步探索任务
    return `[task_id=${taskId}] ${dispatchResult}`;
  }

  protected async dispatchBatch(args: Record<string, unknown>): Promise<string> {
    const rawDispatches = args.dispatches;
    if (!Array.isArray(rawDispatches) || rawDispatches.length === 0) {
      throw fail('dispatch_batch 参数无效：必须提供非空 dispatches 数组');
    }

    const modes = resolveModeRuntimeProjection({
      sessionId: this.leader.sessionId,
      db: this.leader.db,
      blackboardAvailable: this.leader.isBlackboardEnabled(),
      permissionSummary: this.leader.getInteractionSnapshot().permissionSummary,
    });

    const results: Array<{
      index: number;
      taskId: string;
      agentName: string;
      status: DispatchItemStatus;
      message: string;
    }> = [];

    for (const [index, item] of rawDispatches.entries()) {
      if (!item || typeof item !== 'object') {
        results.push({
          index,
          taskId: '',
          agentName: '',
          status: 'failed',
          message: 'dispatch item 必须是对象',
        });
        continue;
      }
      const record = item as Record<string, unknown>;
      const taskId = typeof record.task_id === 'string' ? record.task_id.trim() : '';
      const agentName = typeof record.agent_name === 'string' ? this.normalizeAgentName(record.agent_name) : '';
      if (!taskId || !agentName) {
        results.push({
          index,
          taskId,
          agentName,
          status: 'failed',
          message: 'task_id 和 agent_name 必填',
        });
        continue;
      }

      let message: string;
      let status: DispatchItemStatus;
      try {
        message = await this.dispatchAgentWithOptions({ task_id: taskId, agent_name: agentName }, { modes });
        status = 'ok';
      } catch (e) {
        // 子项失败：直接取抛错的确定性 status（'skipped'/'failed'），不再字符串匹配
        if (e instanceof LeaderToolFailure) {
          message = e.message;
          status = e.status;
        } else {
          throw e;
        }
      }
      results.push({
        index,
        taskId,
        agentName,
        status,
        message,
      });
    }

    const ok = results.filter((result) => result.status === 'ok').length;
    const skipped = results.filter((result) => result.status === 'skipped').length;
    const failed = results.filter((result) => result.status === 'failed').length;
    const lines = [
      `dispatch_batch 完成：ok=${ok} skipped=${skipped} failed=${failed}`,
      ...results.map((result) => `[${result.status}] #${result.index + 1} ${result.taskId || '<missing-task>'} -> @${result.agentName || '<missing-agent>'}: ${result.message}`),
    ];
    return lines.join('\n');
  }




  /**
   * 询问用户（支持单问题和多问题向导）
   *
   * Eternal 模式下不暂停、不弹通知；把问题作为 system 消息注入回对话，
   * 让 Leader 在下一轮 LLM 调用里自主决策（这是 eternal 自治的核心契约）。
   */
  protected async askUser(args: Record<string, unknown>): Promise<string> {
    // 多问题模式：questions 数组优先，过滤无效项
    const rawQuestions = Array.isArray(args.questions) ? args.questions : undefined;
    const questionsArg = rawQuestions
      ? (rawQuestions as unknown[]).filter(
          (q): q is { question: string; options?: Array<{ value: string; label?: string }>; multiSelect?: boolean } =>
            q != null && typeof q === 'object' && typeof (q as Record<string, unknown>).question === 'string' && ((q as Record<string, unknown>).question as string).trim().length > 0,
        )
      : undefined;
    const singleQuestion = typeof args.question === 'string' ? args.question.trim() : '';
    if ((!questionsArg || questionsArg.length === 0) && !singleQuestion) {
      throw fail([
        'ask_user 参数无效：必须提供非空 question，或提供 questions 数组且至少包含一个非空 question。',
        'ask_user 应作为本批次最后/唯一工具调用；如果只是阶段总结，请直接回复或写 work_note。',
      ].join('\n'));
    }

    // Eternal 模式：把问题反向注入回 Leader 自己，让 LLM 在下一轮自主决策
    if (this.leader.isEternalMode()) {
      const lines: string[] = [
        '[Eternal 自治] 你刚刚调用了 ask_user，但当前是 Eternal 模式，用户已授权由你自主决策。',
        '下一步直接基于已有上下文做出最合理的判断并继续推进；信息不足时记录假设并以保守路径执行。',
        '',
      ];
      if (questionsArg && questionsArg.length > 0) {
        lines.push('原本要问用户的问题：');
        for (const [i, q] of questionsArg.entries()) {
          const optTxt = Array.isArray(q.options) && q.options.length > 0
            ? `（候选: ${q.options.map((o) => o.label || o.value).join(' | ')}${q.multiSelect ? ' · 可多选' : ''}）`
            : '';
          lines.push(`${i + 1}. ${q.question} ${optTxt}`.trim());
        }
      } else {
        const question = singleQuestion;
        const options = Array.isArray(args.options)
          ? (args.options as Array<{ value: string; label?: string }>)
          : undefined;
        const multiSelect = args.multiSelect === true;
        const optTxt = options && options.length > 0
          ? `（候选: ${options.map((o) => o.label || o.value).join(' | ')}${multiSelect ? ' · 可多选' : ''}）`
          : '';
        lines.push(`原本要问用户的问题：${question} ${optTxt}`.trim());
      }
      this.leader.addMessage({ role: 'system', content: lines.join('\n') });
      return 'Eternal 模式：已把问题反注入对话。请基于现有信息自主决策并继续推进。';
    }

    if (questionsArg && questionsArg.length > 0) {
      // 多问题向导模式
      const firstQuestion = questionsArg[0]!.question;

      this.leader.emitter.emit('user:input_needed', {
        sessionId: this.leader.sessionId,
        question: firstQuestion,
        questions: questionsArg,
      });

      this.leader.emitter.emit('notification:new', {
        sessionId: this.leader.sessionId,
        id: `user_input_needed_${this.leader.sessionId}_${Date.now()}`,
        type: 'user_input_needed',
        priority: 'critical',
        title: '需要用户输入',
        message: `${questionsArg.length} 个问题等待回答`,
        timestamp: Date.now(),
        read: false,
      });

      this.leader.markWaitingForUser(true);
      this.leader.markPendingUserInput(firstQuestion);
      this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'true');
      this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.PENDING_USER_INPUT, firstQuestion);
      this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.PENDING_USER_GATE, {
        kind: 'ask_user',
        question: firstQuestion,
        questions: questionsArg,
        source: 'leader',
      });
    } else {
      // 单问题模式（向后兼容）
      const question = singleQuestion;
      const options = Array.isArray(args.options)
        ? (args.options as Array<{ value: string; label?: string }>)
        : undefined;
      const multiSelect = args.multiSelect === true;

      this.leader.emitter.emit('user:input_needed', {
        sessionId: this.leader.sessionId,
        question,
        options,
        multiSelect,
      });

      this.leader.emitter.emit('notification:new', {
        sessionId: this.leader.sessionId,
        id: `user_input_needed_${this.leader.sessionId}_${Date.now()}`,
        type: 'user_input_needed',
        priority: 'critical',
        title: '需要用户输入',
        message: question.substring(0, 100),
        timestamp: Date.now(),
        read: false,
      });

      this.leader.markWaitingForUser(true);
      this.leader.markPendingUserInput(question);
      this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'true');
      this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.PENDING_USER_INPUT, question);
      this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.PENDING_USER_GATE, {
        kind: 'ask_user',
        question,
        options,
        multiSelect,
        source: 'leader',
      });
    }

    return '正在等待用户回复...';
  }


  /**
   * Active Plan tools — separate from submit_plan/PENDING_PLAN approval gate.
   */
  private readActivePlan(): Record<string, unknown> | null {
    const raw = this.leader.db.getSessionState(this.leader.sessionId, SESSION_KEYS.ACTIVE_PLAN);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private normalizePlanItems(items: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(items)) return [];
    return items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map((item, index) => ({
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `P-${index + 1}`,
        title: String(item.title || '').trim(),
        status: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'].includes(String(item.status))
          ? String(item.status)
          : 'pending',
        ...(typeof item.notes === 'string' && item.notes.trim() ? { notes: item.notes.trim() } : {}),
      }))
      .filter((item) => typeof item.title === 'string' && item.title.length > 0);
  }

  private writeActivePlan(plan: Record<string, unknown>, reason?: string): string {
    this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.ACTIVE_PLAN, plan);
    this.leader.emitter.emit('plan:updated', {
      sessionId: this.leader.sessionId,
      plan,
      reason,
    });
    return JSON.stringify(plan, null, 2);
  }

  private planCreate(args: Record<string, unknown>): string {
    const goal = String(args.goal || '').trim();
    if (!goal) throw fail('plan_create requires goal');
    const now = Date.now();
    const plan = {
      plan_id: `plan-${now}`,
      session_id: this.leader.sessionId,
      status: 'active',
      version: 1,
      goal,
      items: this.normalizePlanItems(args.items),
      checkpoints: [],
      created_at: now,
      updated_at: now,
    };
    return this.writeActivePlan(plan, typeof args.reason === 'string' ? args.reason : 'plan_create');
  }

  private planUpdate(args: Record<string, unknown>): string {
    const existing = this.readActivePlan();
    if (!existing || existing.status !== 'active') throw fail('plan_update requires an active plan. Call plan_create first.');
    const now = Date.now();
    const next = {
      ...existing,
      ...(typeof args.goal === 'string' && args.goal.trim() ? { goal: args.goal.trim() } : {}),
      ...(Array.isArray(args.items) ? { items: this.normalizePlanItems(args.items) } : {}),
      version: Number(existing.version || 0) + 1,
      updated_at: now,
    };
    return this.writeActivePlan(next, typeof args.reason === 'string' ? args.reason : 'plan_update');
  }

  private planCheckpoint(args: Record<string, unknown>): string {
    const existing = this.readActivePlan();
    if (!existing || existing.status !== 'active') throw fail('plan_checkpoint requires an active plan. Call plan_create first.');
    const summary = String(args.summary || '').trim();
    if (!summary) throw fail('plan_checkpoint requires summary');
    const now = Date.now();
    const checkpoints = Array.isArray(existing.checkpoints) ? [...existing.checkpoints] : [];
    checkpoints.push({
      at: now,
      summary,
    });
    const next = {
      ...existing,
      checkpoints,
      version: Number(existing.version || 0) + 1,
      updated_at: now,
    };
    return this.writeActivePlan(next, typeof args.reason === 'string' ? args.reason : 'plan_checkpoint');
  }

  private planFinalize(args: Record<string, unknown>): string {
    const existing = this.readActivePlan();
    if (!existing || existing.status !== 'active') throw fail('plan_finalize requires an active plan. Call plan_create first.');
    const finalStatus = String(args.final_status || '').trim();
    if (!['completed', 'cancelled', 'superseded'].includes(finalStatus)) {
      throw fail('plan_finalize final_status must be completed, cancelled, or superseded');
    }
    const now = Date.now();
    const planId = String(existing.plan_id || '');
    const next = {
      ...existing,
      status: finalStatus === 'cancelled' ? 'cancelled' : 'finalized',
      final_status: finalStatus,
      summary: typeof args.summary === 'string' ? args.summary : '',
      version: Number(existing.version || 0) + 1,
      finalized_at: now,
      updated_at: now,
    };
    this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.ACTIVE_PLAN, next);
    this.leader.emitter.emit('plan:finalized', {
      sessionId: this.leader.sessionId,
      planId,
      finalStatus,
      summary: typeof args.summary === 'string' ? args.summary : undefined,
    });
    return JSON.stringify(next, null, 2);
  }


  /**
   * 提交方案
   */
  protected async submitPlan(args: Record<string, unknown>): Promise<string> {
    if (!PLAN_REVIEW_ENABLED) {
      return 'OK: 方案已提交 (当前禁用评审模式)。';
    }
    const tasks = this.leader.board.getAllTasks().filter((t: BoardTask) =>
      t.status === 'dispatchable'
    );

    const taskList = tasks.map((t: BoardTask) => ({
      id: t.id,
      subject: t.subject,
      type: t.agent_type,
      description: typeof t.description === 'string' ? t.description.slice(0, 2000) : '',
      status: t.status,
      blocked_by: t.blocked_by || [],
      working_directory: t.working_directory,
      write_scope: t.write_scope || [],
    }));

    const planData = {
      goal: args.goal as string || '',
      analysis: args.analysis as string || '',
      approach: args.approach as string || '',
      risks: args.risks as string || '',
      verification: args.verification as string || '',
      tasks: taskList,
    };

    // Eternal 模式：用户已授权自治，不再走人审，直接视为已批准并把方案落到对话历史
    if (this.leader.isEternalMode()) {
      this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.PENDING_PLAN, planData);
      // 复用 approvePlanInternally：写 LEADER_PENDING_REVIEW=false / LEADER_PLAN_APPROVED=true
      // 并 emit canonical 'leader:plan_approved'，前端 sessionStore 据此清空 pendingPlan，
      // 避免审批卡片继续挂在 UI 上。
      await this.leader.approvePlanInternally();
      // 注：故意不再 emit 'plan:submitted'。manual 模式下 plan:submitted 是触发审批 banner 的信号；
      // eternal 下若先 emit submitted 再 emit approved，前端会先 set pendingPlan 再清空，
      // 出现卡片闪现。eternal 自治不需要让用户审批 plan，因此跳过该事件。
      const summary = [
        '[Eternal 自治] submit_plan 已自动通过：用户已授权 Leader 自主决策。',
        `Goal: ${planData.goal || '(unset)'}`,
        `Approach: ${planData.approach?.slice(0, 200) || '(unset)'}`,
        `Tasks: ${planData.tasks.length}（dispatchable）`,
        '请立即按方案派发 ready 任务。',
      ].join('\n');
      this.leader.addMessage({ role: 'system', content: summary });
      return 'OK: Eternal 模式自动批准方案，请继续派发任务。';
    }

    // 设置等待评审标志
    this.leader.markPendingReview(true);
    this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.LEADER_PENDING_REVIEW, 'true');
    this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.PENDING_PLAN, planData);

    this.leader.emitter.emit('plan:submitted', {
      sessionId: this.leader.sessionId,
      plan: planData,
    });

    this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.PENDING_USER_INPUT, 'plan_review');

    return 'OK: 方案已提交。系统已暂停，请等待用户批准或建议。';
  }

  /**
   * 结束会话
   *
   * Eternal 模式下不真正结束（这是 24/7 自治的核心契约）：
   * 把它降级成"已交付当前阶段成果，进入 idle 等待新工作"，让 EternalLoop
   * 接管后续巡逻。只有用户显式 setControlMode('manual') 后才允许真退。
   */
  protected async finishSession(args: Record<string, unknown>): Promise<string> {
    const summary = args.summary as string;
    const nonTerminalTasks = this.leader.board.getAllTasks().filter((task) =>
      task.status !== 'terminal'
    );
    if (nonTerminalTasks.length > 0) {
      const taskSummary = nonTerminalTasks
        .slice(0, 5)
        .map((task) => `[${task.id}] ${task.subject} (${task.status}${task.assigned_agent ? ` @${task.assigned_agent}` : ''})`)
        .join(' | ');
      throw fail(`仍有未完成任务，先完成或明确收口这些任务后再结束会话：${taskSummary}${nonTerminalTasks.length > 5 ? ` | +${nonTerminalTasks.length - 5} more` : ''}。`);
    }

    // Eternal 模式：发布阶段性成果但不真退
    if (this.leader.isEternalMode()) {
      this.leader.publishAssistantOutput(summary);
      this.leader.emitter.emit('leader:status', {
        sessionId: this.leader.sessionId,
        status: 'Eternal · Idle (awaiting next signal)',
      });
      this.leader.addMessage({
        role: 'system',
        content: [
          '[Eternal 自治] 你刚刚调用了 finish_session，但当前是 Eternal 模式。',
          '阶段性总结已发布给用户；Eternal Loop 会继续巡逻、按需派发新任务。',
          '请在收到新输入或新事实前进入待命：保持已就绪 Agent 的握手，整理 work_note，下一轮 LLM 调用直接说"待命中"或基于黑板继续推进。',
          '后续保持 idle 待命；用户显式切回 manual 后，finish_session 可完成真实结束。',
        ].join('\n'),
      });
      return 'Eternal 模式：阶段性总结已发布，会话保持自治待命，请进入 idle 等待新工作。';
    }

    const activeAgents = this.leader.pool.getRunning();
    if (activeAgents.length > 0) {
      const agentSummary = activeAgents
        .slice(0, 5)
        .map((agent) => `@${agent.name}:${agent.taskId}`)
        .join(' | ');
      throw fail(`仍有运行中的 Worker，等待其完成或先明确终止后再结束会话：${agentSummary}${activeAgents.length > 5 ? ` | +${activeAgents.length - 5} more` : ''}。`);
    }

    this.leader.publishAssistantOutput(summary);

    this.leader.emitter.emit('leader:status', {
      sessionId: this.leader.sessionId,
      status: 'Idle',
    });
    this.leader.emitter.emit('leader:busy', {
      sessionId: this.leader.sessionId,
      isBusy: false,
      queueLength: 0,
      reason: 'session_completed',
    });
    this.leader.emitter.emit('leader:round_complete', {
      sessionId: this.leader.sessionId,
      trigger: 'finish_session',
    });
    this.leader.emitter.emit('session:completed', {
      sessionId: this.leader.sessionId,
      summary,
    });

    this.leader.db.updateSessionStatus(this.leader.sessionId, 'completed', summary);
    this.leader.markFinished();

    return '会话已结束';
  }

  /**
   * 标记当前 Eternal 目标为已完成。清除 goal、发布总结、进入 idle 待命。
   */
  protected async completeEternalGoal(args: Record<string, unknown>): Promise<string> {
    const catalog = getPromptCatalog().leader.eternalGoal;
    const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';

    if (!evidence) {
      return catalog.evidenceRequired;
    }
    if (!summary) {
      return catalog.summaryRequired;
    }

    const goal = readPersistedEternalGoal(this.leader.db, this.leader.sessionId);
    if (!goal) {
      return catalog.noActiveGoal;
    }

    // Soft-delete the goal (same as clearEternalGoal in SessionManagerRuntime)
    await this.leader.db.setSessionState(this.leader.sessionId, SESSION_KEYS.ETERNAL_GOAL, {
      ...goal,
      paused: true,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Publish completion output to user
    const completionMessage = [
      catalog.goalCompleted(goal.description),
      '',
      `${catalog.evidenceLabel}：${evidence}`,
      '',
      summary,
    ].join('\n');
    this.leader.publishAssistantOutput(completionMessage);

    // Emit goal change event
    this.leader.emitter.emit('eternal:goal_changed', {
      sessionId: this.leader.sessionId,
      goal: null,
      action: 'completed',
    });

    // Invalidate silence lock so next patrol re-evaluates cleanly
    this.leader.invalidateEternalSilenceLock('eternal_goal_completed');

    // Set leader to idle
    this.leader.emitter.emit('leader:status', {
      sessionId: this.leader.sessionId,
      status: catalog.completedStatus,
    });

    // Switch back to manual mode after goal completion
    if (this.leader.isEternalMode()) {
      const modeResult = await this.leader.setControlMode('manual');
      leaderLogger.info(`[CompleteEternalGoal] Auto-switched to manual mode: ${modeResult.message}`);
    }

    leaderLogger.info(`[CompleteEternalGoal] Goal completed: ${goal.description.slice(0, 80)}`);

    return catalog.completedToolResult(goal.description);
  }

  /**
   * 兼容旧 learn_soul 入口，实际写入统一长期记忆系统。
   */
  protected async learnSoul(args: Record<string, unknown>): Promise<string> {
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    const scope: MemoryScope = args.scope === 'user' ? 'user' : 'project';
    if (!content) throw fail('记忆内容为空，未写入。');

    const type: MemoryType = scope === 'user' ? 'user' : 'project';
    const manager = new MemoryManager(this.leader.workspace);
    const timestamp = new Date().toISOString();
    const saved = manager.saveMemory(
      memoryNameFromContent('leader-memory', content),
      type,
      compactOneLine(content, 140) || 'Leader recorded long-term memory',
      [`## 学习记录`, '', `source: learn_soul`, `createdAt: ${timestamp}`, '', content].join('\n'),
      scope,
    );

    const scopeName = scope === 'user' ? '用户级' : '项目级';
    return `已记录到${scopeName}长期记忆 "${saved.name}": ${saved.filePath}`;
  }

  protected async requestPermissionUpdate(args: Record<string, unknown>): Promise<string> {
    const payload = {
      requestId: String(args.request_id || `leader-${Date.now()}`),
      source: args.worker_name ? 'worker' as const : 'leader' as const,
      toolName: String(args.tool_name || 'unknown'),
      requestedMode: args.mode as PermissionMode,
      requestedHosts: Array.isArray(args.allowed_hosts)
        ? (args.allowed_hosts as string[])
        : undefined,
      destination: (args.destination as PermissionUpdateDestination | undefined) || 'session',
      reason: String(args.reason || '未说明原因'),
      workerName: args.worker_name ? String(args.worker_name) : undefined,
    };

    // Leader 可以为自己申请实现类权限——当所有 worker 被 api 契约 allowedScope
    // 阻塞时，Leader 需要能直接修改源码解除限制或执行实现工作。
    // 历史限制基于"Leader 是 PM/主控，不直接写代码"的假设，但凌霄的 Solo 模式
    // 和自改进场景下 Leader 需要具备完整的实现能力。
    return this.leader['requestPermissionUpdate'](payload);
  }

  protected isLeaderExecutionPermissionRequest(toolName: string, _reason: string): boolean {
    return gateIsLeaderExecutionTool(toolName);
  }


  /**
   * 写入工作笔记
   * 用法: write_work_note(agentId, taskId, phase, summary, details?, artifacts?, blockers?, nextSteps?)
   */
  protected async writeWorkNote(args: Record<string, unknown>): Promise<string> {
    // agentId/taskId 自动填充：Leader 写自己的工作笔记，身份固定为 'leader'
    // （与 LeaderAgent.ts:1835 agentId:'leader' 同源），符合工具描述「默认自动使用
    // 当前 agentId/taskId」。容忍 GLM 漏传——此前缺 agentId 即裸抛「必须提供 agentId」，
    // 致整条调研笔记（含 keyFindings/impactAnalysis）全部丢失。
    const agentId = String(args.agentId || 'leader');
    const taskId = String(args.taskId || 'leader');
    const phase = String(args.phase || 'other');
    // LLM 幻觉防护：模型有时误用 title 代替 summary
    const summary = String(args.summary || args.title || '');

    if (!summary) {
      throw fail('错误: 必须提供 summary（工作笔记的实质摘要）');
    }

    const validPhases = ['research', 'coding', 'testing', 'reviewing', 'other'];
    if (!validPhases.includes(phase)) {
      throw fail(`错误: phase 必须是 ${validPhases.join('、')} 之一`);
    }

    try {
      const note = await this.leader.getWorkNoteManager().writeNoteWithSession(this.leader.sessionId, {
        agentId,
        taskId,
        phase: phase as import('../core/WorkNoteManager.js').WorkNotePhase,
        summary,
        details: args.details ? String(args.details) : undefined,
        artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : undefined,
        blockers: Array.isArray(args.blockers) ? args.blockers.map(String) : undefined,
        nextSteps: Array.isArray(args.nextSteps) ? args.nextSteps.map(String) : undefined,
        // keyFindings/impactAnalysis 此前被丢弃；WorkNote schema 支持（WorkNoteManager.ts:24-25），
        // 补传避免 Leader 调研结果丢失。keyFindings 经 coerceToStringArray 深度拍平
        // （GLM 常把 string[] 误写成嵌套 {item,$text} XML-fold）。
        keyFindings: coerceToStringArray(args.keyFindings),
        impactAnalysis: args.impactAnalysis ? String(args.impactAnalysis) : undefined,
      });

      this.leader.emitter.emit('work_note:written', {
        sessionId: this.leader.sessionId,
        agentId,
        note,
      });

      return `笔记已写入: ${note.id} (agent=${agentId}, task=${taskId}, phase=${phase})`;
    } catch (error) {
      throw fail(`笔记写入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 请求某 Agent 更新工作笔记
   * 用法: request_work_note(agentId)
   */
  protected async requestWorkNote(args: Record<string, unknown>): Promise<string> {
    const targetAgentId = String(args.agentId || '');
    if (!targetAgentId) {
      throw fail('错误: 必须指定目标 agentId');
    }

    this.leader.bus.send(
      this.leader.busName,
      this.leader.sessionPrefix(targetAgentId),
      'request_work_note',
      { sessionId: this.leader.sessionId, requesterAgentId: 'leader' }
    );

    this.leader.emitter.emit('work_note:requested', {
      sessionId: this.leader.sessionId,
      requesterAgentId: 'leader',
      targetAgentId,
    });

    return `已请求 agent '${targetAgentId}' 更新工作笔记`;
  }

  /**
   * 读取指定 Agent 的工作笔记
   * 用法: read_work_notes(agentId?, taskId?, limit?)
   */
  protected async readWorkNotes(args: Record<string, unknown>): Promise<string> {
    const agentId = args.agentId ? String(args.agentId) : undefined;
    const taskId = args.taskId ? String(args.taskId) : undefined;
    const limit = Number(args.limit) || 10;

    try {
      let notes;
      if (agentId) {
        notes = await this.leader.getWorkNoteManager().getAgentNotes(this.leader.sessionId, agentId);
      } else {
        notes = await this.leader.getWorkNoteManager().getAllNotes(this.leader.sessionId);
      }

      // 按 taskId 过滤
      if (taskId) {
        notes = notes.filter((n: WorkNote) => n.taskId === taskId);
      }

      // 取最近的 limit 条
      notes = notes.slice(0, limit);

      if (notes.length === 0) {
        return '未找到工作笔记';
      }

      const formatted = notes.map((n: WorkNote, i: number) => {
        const time = new Date(n.timestamp).toLocaleString();
        let line = `[${i + 1}] [${n.phase}] ${n.agentId} @ ${time}: ${n.summary}`;
        if (n.details) {
          line += `\n      ${n.details.substring(0, 100)}${n.details.length > 100 ? '...' : ''}`;
        }
        if (n.blockers && n.blockers.length > 0) {
          line += `\n      ⚠️ 阻塞: ${n.blockers.join(', ')}`;
        }
        return line;
      }).join('\n\n');

      return `工作笔记 (${notes.length} 条):\n\n${formatted}`;
    } catch (error) {
      throw fail(`笔记读取失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ─── BugHunt 扫描工具已下放为普通 Tool（src/tools/implementations/
  //     BughuntScanToolWrappers.ts），通过 directToolsExecutor → ToolRegistry
  //     执行；此处不再保留 thin wrapper。

  // ─── BugHunt Ledger 工具 ───

  protected setBughuntDagTool(args: Record<string, unknown>): string {
    const nodes = args.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw fail('nodes 必须是非空数组');
    }
    const target = typeof args.target === 'string' ? args.target : undefined;
    try {
      const ledger = setBughuntDag(this.leader.db, this.leader.sessionId, target, nodes);
      // P5: DAG 是调度核心——写入后反馈就绪候选，引导 Leader 经 dispatch_agent 派发（不自动派发）。
      const ready = getReadyDagNodes(ledger);
      const readyLine = ready.length > 0
        ? `ready_now=[${ready.map((r) => r.node.id).join(', ')}]（get_ready_dag_nodes 查询，dispatch 决策由你定）`
        : 'ready_now=none（所有节点被 blocked_by/evidence_gate 门控）';
      return `已写入 Bughunt DAG（调度核心），共 ${ledger.dag.length} 个节点。${readyLine}\n\n${summarizeBughuntLedger(ledger)}`;
    } catch (err) {
      if (err instanceof LeaderToolFailure) throw err;
      throw fail(`set_bughunt_dag 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * P5: 返回就绪可派发的 DAG 节点候选（拓扑 + blocked_by + evidence_gate 硬门控判定）。
   * 仅提供候选，不自动 dispatch——派发决策权保留 Leader（经 create_task + dispatch_agent）。
   */
  protected getReadyDagNodesTool(_args: Record<string, unknown>): string {
    const ledger = readBughuntLedger(this.leader.db, this.leader.sessionId);
    if (!ledger) {
      throw fail('当前会话尚无 Bughunt ledger（先用 set_bughunt_dag 建立调查 DAG）');
    }
    const ready = getReadyDagNodes(ledger);
    if (ready.length === 0) {
      return `无就绪节点（共 ${ledger.dag.length} 个 DAG 节点均被 blocked_by 或 evidence_gate 门控）`;
    }
    const lines = ready.map((r) =>
      `- ${r.node.id} [${r.node.phase}/${r.node.status}] ${r.node.objective}${r.taskId ? `  task_id=${r.taskId}` : ''}  read=${r.node.read_scope.join(',') || '-'}  write=${r.node.write_scope.join(',') || '-'}`,
    );
    return `就绪候选（${ready.length}/${ledger.dag.length}，dispatch 决策由你定）：\n${lines.join('\n')}`;
  }

  /**
   * P6: verified 门真实执行——compile 层（必，跑 compile_commands 捕获 exit_code）+
   * 可选 blackbox 层（起目标服务 + HTTP probe，需 authorize_blackbox=true，默认关闭）。
   * 产出 compile_artifacts/blackbox_artifacts 回写 finding；verified 门认真产物（artifacts 非空优先于正则）。
   */
  protected async verifyFindingTool(args: Record<string, unknown>): Promise<string> {
    const findingId = typeof args.finding_id === 'string' ? args.finding_id.trim() : '';
    if (!findingId) throw fail('finding_id 不能为空');
    const rawCommands = Array.isArray(args.compile_commands) ? args.compile_commands : [];
    if (rawCommands.length === 0) {
      throw fail('compile_commands 不能为空（compile 层必跑，如 tsc --noEmit / npm test / build）');
    }

    const ledger = readBughuntLedger(this.leader.db, this.leader.sessionId);
    const existing = ledger ? getBughuntFinding(ledger, findingId) : undefined;
    if (!existing) {
      throw fail(`未找到 finding ${findingId}（先 upsert_bughunt_finding 建档，再验证）`);
    }

    let compileCommands: CompileCommand[];
    try {
      compileCommands = rawCommands.map((c, i) => {
        if (!c || typeof c !== 'object') throw new Error(`compile_commands[${i}] 必须是对象`);
        const o = c as Record<string, unknown>;
        const command = typeof o.command === 'string' ? o.command : '';
        const cwd = typeof o.cwd === 'string' ? o.cwd : '';
        if (!command || !cwd) throw new Error(`compile_commands[${i}] 需 command + cwd`);
        const argArr = Array.isArray(o.args) ? (o.args as unknown[]).map(String) : [];
        return { command, args: argArr, cwd };
      });
    } catch (err) {
      if (err instanceof LeaderToolFailure) throw err;
      throw fail(`compile_commands 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // blackbox 授权与解析（默认关闭）
    const authorizeBlackbox = args.authorize_blackbox === true;
    const rawProbe = args.blackbox_probe;
    let probe: BlackboxProbe | undefined;
    if (rawProbe && !authorizeBlackbox) {
      throw fail('blackbox_probe 需 authorize_blackbox=true（安全边界：blackbox 起目标服务 + 联网 probe，默认关闭）');
    }
    if (rawProbe && authorizeBlackbox && typeof rawProbe === 'object') {
      const p = rawProbe as Record<string, unknown>;
      const startCommand = typeof p.start_command === 'string' ? p.start_command : '';
      const cwd = typeof p.cwd === 'string' ? p.cwd : '';
      if (!startCommand || !cwd) throw fail('blackbox_probe 需 start_command + cwd');
      probe = {
        cwd,
        startCommand,
        startArgs: Array.isArray(p.start_args) ? (p.start_args as unknown[]).map(String) : undefined,
        healthPath: typeof p.health_path === 'string' ? p.health_path : undefined,
        requestPath: typeof p.request_path === 'string' ? p.request_path : '/',
        expectedStatus: typeof p.expected_status === 'number' ? p.expected_status : undefined,
        env: p.env && typeof p.env === 'object' ? (p.env as Record<string, string>) : undefined,
        readyTimeoutMs: typeof p.ready_timeout_ms === 'number' ? p.ready_timeout_ms : undefined,
      };
    }

    // compile 层（必）
    const compile = await runCompileVerification(compileCommands);
    // blackbox 层（可选 + 已授权）
    let blackbox;
    if (probe) {
      try {
        blackbox = await runBlackboxVerification(probe);
      } catch (err) {
        if (err instanceof LeaderToolFailure) throw err;
        throw fail(`compile=${compile.allPassed ? 'PASS' : 'FAIL'}；blackbox 启动失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 回写 artifacts（verified 门认非空产物）
    const patch: Record<string, unknown> = { id: findingId };
    patch.compile_commands = [...new Set([...(existing.compile_commands || []), ...compile.results.map((r) => r.command)])];
    patch.compile_artifacts = [...(existing.compile_artifacts || []), ...compile.artifacts];
    if (blackbox) {
      patch.blackbox_commands = [...new Set([...(existing.blackbox_commands || []), ...blackbox.probes.map((bp) => bp.requestPath)])];
      patch.blackbox_artifacts = [...(existing.blackbox_artifacts || []), ...blackbox.artifacts];
    }
    upsertBughuntFinding(this.leader.db, this.leader.sessionId, patch);

    // 证据事件（供 brief/report 追溯）
    const kind: BughuntEvidenceKind = blackbox ? 'blackbox_probe' : 'compile';
    appendBughuntEvent(this.leader.db, this.leader.sessionId, {
      kind,
      summary: `verify ${findingId}: compile ${compile.allPassed ? 'PASS' : 'FAIL'}${blackbox ? `, blackbox ${blackbox.probes[0]?.ok ? 'OK' : 'FAIL'}` : ''}`,
      finding_ids: [findingId],
      files: [],
      commands: compile.results.map((r) => r.command),
      exit_codes: compile.results.map((r) => String(r.exitCode)),
      evidence: [...compile.artifacts, ...(blackbox?.artifacts || [])],
    });

    const lines = [
      `verify ${findingId}:`,
      `  compile: ${compile.allPassed ? 'PASS' : 'FAIL'} (${compile.results.map((r) => `exit=${r.exitCode}`).join(', ')})`,
    ];
    if (blackbox) {
      lines.push(`  blackbox: ${blackbox.probes[0]?.ok ? 'OK' : 'FAIL'} (status=${blackbox.probes[0]?.status} ${blackbox.probes[0]?.requestPath})`);
    }
    lines.push(`  已回写 compile_artifacts(+${compile.artifacts.length})${blackbox ? `、blackbox_artifacts(+${blackbox.artifacts.length})` : ''}；verified 门现认真实执行产物。`);
    return lines.join('\n');
  }

  protected upsertBughuntFindingTool(args: Record<string, unknown>): string {
    const finding = args.finding;
    if (!finding || typeof finding !== 'object') {
      throw fail('finding 必须是对象');
    }
    try {
      const ledger = upsertBughuntFinding(this.leader.db, this.leader.sessionId, finding);
      const fid = (finding as Record<string, unknown>).id;
      const saved = fid ? ledger.findings.find((f) => f.id === fid) : undefined;
      return saved
        ? `已写入 finding ${saved.id} [${saved.severity}/${saved.status}] ${saved.title || ''}`
        : `已写入 finding（共 ${ledger.findings.length}）`;
    } catch (err) {
      if (err instanceof LeaderToolFailure) throw err;
      throw fail(`upsert_bughunt_finding 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  protected getBughuntLedgerTool(args: Record<string, unknown>): string {
    const scope = typeof args.scope === 'string' ? args.scope : 'brief';
    const ledger = readBughuntLedger(this.leader.db, this.leader.sessionId);
    if (!ledger) {
      throw fail('当前会话尚无 Bughunt ledger');
    }

    if (scope === 'finding') {
      const findingId = typeof args.finding_id === 'string' ? args.finding_id : '';
      if (!findingId) {
        throw fail('scope=finding 时 finding_id 不能为空');
      }
      const finding = getBughuntFinding(ledger, findingId);
      if (!finding) {
        throw fail(`未找到 finding: ${findingId}`);
      }
      return JSON.stringify(finding, null, 2);
    }

    if (scope === 'open') {
      const severity = typeof args.severity === 'string' ? args.severity as BughuntSeverity : undefined;
      const findings = getOpenBughuntFindings(ledger, severity);
      if (findings.length === 0) {
        return severity
          ? `无未关闭 finding（严重度=${severity}）`
          : '无未关闭 finding';
      }
      const lines = findings.map((f) =>
        `- ${f.id} [${f.severity}/${f.status}] ${f.title}${f.files?.length ? `  files: ${f.files.slice(0, 3).join(', ')}` : ''}`,
      );
      return `共 ${findings.length} 个未关闭 finding：\n${lines.join('\n')}`;
    }

    // scope === 'brief'（默认）
    return buildBughuntBrief(ledger);
  }
}

export default LeaderToolsExecutor;
