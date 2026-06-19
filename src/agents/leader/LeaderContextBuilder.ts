/**
 * LeaderContextBuilder — Leader 上下文构建子模块。
 *
 * 从 LeaderAgent 抽出的上下文构建逻辑(B4):
 * - buildRuntimeStateSection / buildLeaderLiveRuntimeAwareness: Leader 运行时实时感知段
 * - appendRuntimeContextManifestIfChanged / appendContextMemoryIfChanged: runtime manifest 与记忆的去重注入
 * - buildMissionSection: 「当前使命」锚点段(原始 goal + TaskBoard 进度,防漂移双锚点)
 * - getDynamicContext: 每轮装配 sections(mission 置顶),带 token 预算门(A2)
 * - getTeamModeHint: Solo/Team 模式提示
 *
 * 设计:
 * - 通过 LeaderContextBuilderDeps 注入 Leader 的可变状态(getter 闭包捕获运行期才初始化的字段)
 * - 非纯方法(改 fingerprint / addMessage / db)经 deps 回调上抛,保持 LeaderAgent 单一持久化入口
 * - A2 token 预算门: getDynamicContext 装配的 system 段总 token 超过 context window 60% 时,
 *   按优先级丢弃低优 fragment(mission 锚点必留)。预算判定走 ContextTokenCalculator 系列的
 *   确定性编码器(getEncodingForModel + getCachedEncoder),不引入新估算器。
 */

import {
  renderContextManifest,
  type ContextManifestSection,
} from '../../core/ContextManifest.js';
import { type SystemSlotMatcher } from '../../core/SystemMessageSlot.js';
import { buildDynamicContext } from './dynamicContext.js';
import { buildMemoryItemsFingerprint } from './contextMemory.js';
import { ContextMemoryIndex } from '../../core/ContextMemoryIndex.js';
import {
  renderContractPackManifestSection,
  renderContractPackSystemMessage,
} from '../../core/ContractPack.js';
import { parseBlueprint, renderBlueprintOverview, isBlueprintActive, computeBlueprintCoverage, getReadySubsystems, type SubsystemContractStatus } from '../../core/ProjectBlueprint.js';
import { computeScopeOrthogonality } from '../../core/ContractAllowedScope.js';
import { buildOfficeModeProtocol } from '../office/OfficeModeProtocol.js';
import { resolveModeRuntimeProjection, resolveEffectiveRoutePreference } from '../../core/ModeRuntimeProjection.js';
import { getTeamMemberRegistry } from '../../core/TeamMailbox.js';
import { getPromptLocale } from '../prompts/i18n/catalog.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { SESSION_KEYS } from '../../core/SessionStateKeys.js';
import { readPersistedEternalGoal } from '../../core/EternalGoal.js';
import { config as globalConfig } from '../../config.js';
import { getEncodingForModel, getCachedEncoder } from '../../core/TiktokenCache.js';
import { getModelDevInfo } from '../../llm/ModelsDevRegistry.js';
import { getContextWindowSizeFromProvider } from '../../llm/model_capabilities.js';
import { resolveModelContextLimit } from './contextLimit.js';
import type { TaskBoard, Task, TaskStats } from '../../core/TaskBoard.js';
import type { AgentPool, AgentHandle } from '../AgentPoolRuntime.js';
import type { DatabaseManager } from '../../core/Database.js';
import type { ContextManager } from '../../core/ContextManager.js';
import type { LeaderWorkOrchestrator } from '../LeaderWorkOrchestrator.js';
import type { LeaderBlackboard } from '../LeaderBlackboard.js';
import type { WorkNoteManager } from '../../core/WorkNoteManager.js';
import type { ContextRuntimeState } from '../../core/ContextRuntimeState.js';
import type { ChatMessage } from '../../llm/types.js';
import type { CompletionSignal } from './p0Message.js';
import { leaderLogger } from '../../core/Log.js';

/** A2: system 段 token 预算占比(context window 的 60%)。 */
const SYSTEM_CONTEXT_BUDGET_RATIO = 0.6;

/**
 * 协作模式 hint 的固定产出前缀（getTeamModeHint/buildCollaborationHint 单一事实源）。
 * pruneStaleModeHints 据此识别 conversation 中的 mode hint system 消息——用内容指纹
 * 而非 metadata：leader_conversation 表无 metadata 列，resume 从 DB 重建后仍可据此识别。
 */
export const MODE_HINT_PREFIXES = ['[Solo 模式]', '[Team 模式]', '[Solo mode]', '[Team mode]'] as const;

/** 判断一条消息内容是否为协作模式 hint（LeaderAgent.pruneStaleModeHints 用）。 */
export function isModeHintContent(content: unknown): boolean {
  return typeof content === 'string' && MODE_HINT_PREFIXES.some((p) => content.startsWith(p));
}

/**
 * 动态 section 的优先级(A2 丢弃低优 fragment 用)。
 * 数值越大越不可裁: mission 锚点最高,协议类次之,直觉/记忆可裁。
 */
const enum FragmentPriority {
  /** 直觉快照(可裁) */
  Intuition = 1,
  /** 长期记忆索引(可裁) */
  Memory = 2,
  /** Office 模式协议 */
  OfficeMode = 3,
  /** Contract Pack manifest */
  ContractManifest = 4,
  /** Contract Pack system protocol */
  ContractSystem = 5,
  /** 项目蓝图(覆盖状态投影,防规划坍缩成 MVP) */
  Blueprint = 6,
  /** 当前使命 / Eternal Goal 锚点(防漂移,不可裁) */
  Mission = 99,
}

/** 带优先级的 section 装配条目。 */
interface PrioritizedSection {
  section: ContextManifestSection;
  priority: FragmentPriority;
}

/** LeaderContextBuilder 所需的依赖(经 getter 闭包注入,捕获运行期状态)。 */
export interface LeaderContextBuilderDeps {
  readonly sessionId: string;
  readonly model: string;
  readonly workspace: string;
  /** pending agent 完成信号(运行时感知段用) */
  getPendingAgentCompletionSignals: () => CompletionSignal[];
  /** agent 池(枚举 stopped agent) */
  getPool: () => AgentPool;
  /** 任务板 */
  getBoard: () => TaskBoard;
  /** runtime orchestrator(buildRuntimeStateSection 复用其摘要) */
  getWorkOrchestrator: () => LeaderWorkOrchestrator;
  /** 上下文管理器(runtime state / context window) */
  getContextManager: () => ContextManager;
  /** 黑板(获取 contract pack / blackboard snapshot) */
  getLeaderBlackboard: () => LeaderBlackboard | null;
  /** work note manager(记忆 recall 用) */
  getWorkNoteManager: () => WorkNoteManager;
  /** 原始 goal(防漂移锚点) */
  getOriginalGoal: () => string | null;
  /** active team name */
  getActiveTeamName: () => string | null;
  /** 黑板是否启用 */
  isBlackboardEnabled: () => boolean;
  /** 交互快照的 permissionSummary(team hint 投影用) */
  getPermissionSummary: () => string;
  /** DB 读 session state */
  getDb: () => DatabaseManager;
  /** 注入 system 消息(事件/指令类 append 用；状态镜像类走 upsertSystemSlot) */
  addMessage: (msg: ChatMessage) => void;
  /**
   * 单槽 in-place system 注入（状态镜像类：runtime manifest / memory manifest / 黑板分析）。
   * 治本「每轮 append 堆积占满上下文」：命中同槽则覆盖内容 + collapse 残留，无匹配则 append。
   * 只改内存运行时视图，不落库（manifest 是可重算状态镜像，DB 保持 append-only）。
   * 返回是否发生变更。
   */
  upsertSystemSlot: (matcher: SystemSlotMatcher, content: string) => boolean;
}

/**
 * Leader 上下文构建器。所有方法为 LeaderAgent 同名方法的实现搬迁;
 * fingerprint 状态收归本类(原 LeaderAgent 的 lastRuntimeContextFingerprint /
 * lastContextMemoryFingerprint 迁移至此,经 getter 暴露以便 LeaderAgent 兼容引用)。
 */
export class LeaderContextBuilder {
  private lastRuntimeContextFingerprint: string | null = null;
  private lastContextMemoryFingerprint: string | null = null;

  constructor(private readonly deps: LeaderContextBuilderDeps) {}

  /** 暴露 runtime context fingerprint(兼容 LeaderAgent 既有引用)。 */
  getLastRuntimeContextFingerprint(): string | null {
    return this.lastRuntimeContextFingerprint;
  }

  /** 暴露 context memory fingerprint(兼容 LeaderAgent 既有引用)。 */
  getLastContextMemoryFingerprint(): string | null {
    return this.lastContextMemoryFingerprint;
  }

  buildRuntimeStateSection(): string {
    const orchestrator = this.deps.getWorkOrchestrator();
    return [
      orchestrator.buildRuntimeStateSection(),
      this.buildLeaderLiveRuntimeAwareness(),
    ].filter(Boolean).join('\n');
  }

  buildLeaderLiveRuntimeAwareness(): string {
    const lines: string[] = [];
    const signals = this.deps.getPendingAgentCompletionSignals();

    if (signals.length > 0) {
      lines.push(
        `pending_completion_signals: ${signals.slice(0, 6).map((signal) => {
          const agent = signal.agentName?.replace(/^[^:]+:/, '') || 'unknown';
          const result = signal.result
            ? ` result="${signal.result.replace(/\s+/g, ' ').slice(0, 120)}"`
            : ' result_pending';
          return `@${agent}:${signal.taskId}:${signal.exitReason}${result}`;
        }).join(' | ')}${signals.length > 6 ? ` | +${signals.length - 6} more` : ''}`,
      );
    }

    const pool = this.deps.getPool() as unknown as { getAll?: () => AgentHandle[] };
    const allAgents = typeof pool.getAll === 'function' ? pool.getAll.call(pool) : [];
    const stoppedAgents = allAgents
      .filter((agent) => agent.status === 'stopped')
      .sort((a, b) => (b.endTime ?? b.startTime ?? 0) - (a.endTime ?? a.startTime ?? 0))
      .slice(0, 6);
    if (stoppedAgents.length > 0) {
      lines.push(
        `recent_stopped_agents: ${stoppedAgents.map((agent) => {
          const reason = agent.exitReason ? `/${agent.exitReason}` : '';
          return `@${agent.name}:${agent.taskId}:stopped${reason}`;
        }).join(' | ')}${allAgents.filter((agent) => agent.status === 'stopped').length > stoppedAgents.length ? ' | +more' : ''}`,
      );
    }

    const board = this.deps.getBoard();
    const terminalTasks = board.getAllTasks()
      .filter((task) => task.status === 'terminal')
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 6);
    if (terminalTasks.length > 0) {
      lines.push(
        `recent_terminal_tasks: ${terminalTasks.map((task) => {
          const agent = task.assigned_agent ? ` @${task.assigned_agent}` : '';
          const reason = task.exitReason ? `/${task.exitReason}` : '';
          return `[${task.id}]${reason}${agent} ${task.subject}`.replace(/\s+/g, ' ').slice(0, 180);
        }).join(' | ')}`,
      );
    }

    return lines.join('\n');
  }

  appendRuntimeContextManifestIfChanged(): boolean {
    const runtimeContext = this.buildRuntimeStateSection();
    const missionSection = this.buildMissionSection();
    const contextManager = this.deps.getContextManager();
    const runtime: ContextRuntimeState = contextManager.getRuntimeState();
    const fingerprint = JSON.stringify({
      runtimeContext,
      mission: missionSection,
      warningLevel: runtime.warningLevel,
      consecutiveFailures: runtime.consecutiveFailures,
      lastArchivePath: runtime.lastArchivePath || null,
      lastCompact: runtime.lastCompact
        ? {
          timestamp: runtime.lastCompact.timestamp,
          oldTokens: runtime.lastCompact.oldTokens,
          newTokens: runtime.lastCompact.newTokens,
          archivePath: runtime.lastCompact.archivePath || null,
        }
        : null,
      recentFiles: runtime.recentFiles.map((file) => ({
        path: file.path,
        timestamp: file.timestamp,
        charCount: file.charCount,
        tokenEstimate: file.tokenEstimate,
      })),
    });
    if (fingerprint === this.lastRuntimeContextFingerprint) {
      return false;
    }
    this.lastRuntimeContextFingerprint = fingerprint;
    this.deps.upsertSystemSlot(
      { kind: 'manifestSlot', slot: 'leader_runtime' },
      renderContextManifest({
        scope: 'leader',
        slot: 'leader_runtime',
        sessionId: this.deps.sessionId,
        runtime,
        sections: [
          ...(missionSection ? [missionSection] : []),
          { title: 'Leader Runtime State', content: runtimeContext },
        ],
      }),
    );
    return true;
  }

  async appendContextMemoryIfChanged(): Promise<boolean> {
    const blackboard = this.deps.getLeaderBlackboard();
    const memory = await new ContextMemoryIndex(this.deps.getDb(), this.deps.getWorkNoteManager()).recall({
      sessionId: this.deps.sessionId,
      tokenBudget: 2_500,
      maxItems: 8,
      blackboardSnapshot: blackboard?.blackboardGraph?.getSnapshot(this.deps.sessionId) ?? null,
      workspace: this.deps.workspace,
    });

    if (!memory.rendered) {
      return false;
    }

    const fingerprint = buildMemoryItemsFingerprint(memory.items);
    if (fingerprint === this.lastContextMemoryFingerprint) {
      return false;
    }

    this.lastContextMemoryFingerprint = fingerprint;
    this.deps.upsertSystemSlot(
      { kind: 'manifestSlot', slot: 'leader_memory' },
      renderContextManifest({
        scope: 'leader',
        slot: 'leader_memory',
        sessionId: this.deps.sessionId,
        memory,
      }),
    );
    return true;
  }

  /**
   * 构建「当前使命」锚点段(防漂移:原始 goal + TaskBoard 进度)。
   * 被 getDynamicContext(init 置顶, primacy 锚点)与 appendRuntimeContextManifestIfChanged
   * (每轮 runtime manifest, recency 锚点)共用，确保原始任务在长会话中不被稀释。
   * 返回 null 时表示无原始 goal(如纯 resume 无 prompt)，调用方应跳过。
   */
  buildMissionSection(): { title: string; content: string } | null {
    const originalGoal = this.deps.getOriginalGoal();
    const board = this.deps.getBoard();
    if (!originalGoal || !board) return null;
    const stats: TaskStats = board.getStats();
    const focus = board.getInProgressTasks()
      .map((t: Task) => t.subject)
      .filter((s): s is string => Boolean(s))
      .slice(0, 3);
    const lines = [
      `原始任务：${originalGoal}`,
      `进度：已完成 ${stats.completed}/${stats.total} · 进行中 ${stats.running} · 待派发 ${stats.dispatchableRaw}`,
    ];
    if (focus.length) lines.push(`当前焦点：${focus.join(' / ')}`);
    lines.push('说明：此为系统每轮刷新的使命锚点，不可偏离；所有行动须服务原始任务。');
    return { title: '当前使命(锚点 · 每轮刷新)', content: lines.join('\n') };
  }

  buildEternalGoalSection(): { title: string; content: string } | null {
    const db = this.deps.getDb();
    const controlMode = db.getSessionState(this.deps.sessionId, SESSION_KEYS.CONTROL_MODE);
    if (controlMode !== 'eternal') return null;
    const goal = readPersistedEternalGoal(db, this.deps.sessionId);
    if (!goal || goal.paused) return null;
    const updated = new Date(goal.updatedAt).toISOString();
    return {
      title: 'Eternal Goal(锚点 · 每轮刷新)',
      content: [
        `目标：${goal.description}`,
        `updatedAt：${updated}`,
        '说明：这是当前 control_mode=eternal 的最高优先级目标，不是背景偏好。',
        '所有后续规划、实现、验证、派发和收尾都必须优先服务该目标；目标完成时调用 complete_eternal_goal，暂停/删除后才停止注入。',
      ].join('\n'),
    };
  }

  /**
   * 获取动态上下文(Context Manifest dynamic context)— 作为独立 system 消息注入
   * 避免动态内容变化导致 Anthropic prompt cache 失效。
   *
   * A2 token 预算门: mission 置顶(sections[0]);装配后总 token 超过 context window 60% 时,
   * 按优先级丢弃低优 fragment(mission 锚点必留)。token 判定走 ContextTokenCalculator 系列
   * 确定性编码器(getEncodingForModel + getCachedEncoder),不引入新估算器。
   */
  getDynamicContext(): string | null {
    const db = this.deps.getDb();
    const sessionId = this.deps.sessionId;
    const officeMode = db.getSessionState(sessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE) === 'true';
    const contractPack = this.deps.getLeaderBlackboard()?.getContractPack() ?? null;
    const contractSystemMessage = renderContractPackSystemMessage(contractPack);
    const contractManifest = renderContractPackManifestSection(contractPack);
    const blueprint = parseBlueprint(db.getSessionState(sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));
    // 防漂移:每轮置顶「当前使命」锚点(原始 goal + TaskBoard 进度),对抗长会话 goal 稀释。
    // 复用独立 system 消息注入范式(getDynamicContext 本就是每轮变化的 system 段),
    // 避免污染对话流/next-speaker judge,也避免被压缩管道摘要稀释。
    const missionSection = this.buildMissionSection();
    const eternalGoalSection = this.buildEternalGoalSection();
    const sections: PrioritizedSection[] = [];
    if (eternalGoalSection) {
      sections.push({ section: eternalGoalSection, priority: FragmentPriority.Mission });
    }
    if (missionSection) {
      sections.push({ section: missionSection, priority: FragmentPriority.Mission });
    }
    if (contractSystemMessage) {
      sections.push({
        section: { title: 'Contract Pack Protocol', content: contractSystemMessage },
        priority: FragmentPriority.ContractSystem,
      });
    }
    if (contractManifest) {
      sections.push({
        section: { title: 'Contract Pack Manifest', content: contractManifest },
        priority: FragmentPriority.ContractManifest,
      });
    }
    if (officeMode) {
      sections.push({
        section: { title: 'Office Mode Protocol', content: buildOfficeModeProtocol() },
        priority: FragmentPriority.OfficeMode,
      });
    }
    if (blueprint) {
      // B-C: 从 ContractPack 构建子系统契约状态映射,让蓝图概览显示契约三态(已物化/收敛中/真缺口)。
      const contractStatusBySubsystem = new Map<string, SubsystemContractStatus>();
      // 先从蓝图 subsystem.taskIds 检查是否有 contract 任务(区分"收敛中"和"真缺口")
      const board = this.deps.getBoard();
      for (const entry of blueprint.subsystems) {
        if (entry.status !== 'implement') continue;
        const hasContractTask = entry.taskIds.some((tid) => {
          const t = board.getTask(tid);
          return t?.orchestration?.nodeKind === 'contract';
        });
        if (hasContractTask) {
          contractStatusBySubsystem.set(entry.subsystemId, { hasContract: false, hasContractTask: true });
        }
      }
      // 再用 ContractPack 物化契约覆盖 hasContractTask 状态(已物化 > 收敛中)
      if (contractPack) {
        for (const entry of contractPack.entries) {
          const existing = contractStatusBySubsystem.get(entry.surface);
          contractStatusBySubsystem.set(entry.surface, { hasContract: true, version: entry.version, hasContractTask: existing?.hasContractTask });
        }
      }
      sections.push({
        section: { title: '项目蓝图', content: renderBlueprintOverview(blueprint, computeBlueprintCoverage(blueprint), contractStatusBySubsystem) },
        priority: FragmentPriority.Blueprint,
      });
    }

    const budgetedSections = this.applyTokenBudget(sections).map((entry) => entry.section);

    return buildDynamicContext({
      sessionId,
      readIntuitionPrompt: () => {
        const intuition = db.getSessionState(
          sessionId,
          SESSION_KEYS.INTUITION_SNAPSHOT,
        ) as { prompt?: unknown } | null;
        return intuition && typeof intuition.prompt === 'string' ? intuition.prompt : null;
      },
      readMemoryIndex: () => {
        if (globalConfig.memory.enabled === false) return null;
        const memoryManager = new MemoryManager(this.deps.workspace);
        return memoryManager.getAllIndexContent({ tokenBudget: 1_200, maxEntriesPerScope: 12 }) || null;
      },
      sections: budgetedSections,
    });
  }

  /**
   * A2 token 预算门: 装配后的 system 段总 token 超过 context window 的 60% 时,
   * 按优先级升序丢弃低优 fragment(mission 锚点 priority 最高,不可裁)。
   * 确定性:编码器取自 ContextTokenCalculator 系列(getEncodingForModel + getCachedEncoder)。
   */
  private applyTokenBudget(sections: PrioritizedSection[]): PrioritizedSection[] {
    if (sections.length === 0) return sections;
    const contextLimit = resolveModelContextLimit({
      providerCtx: getContextWindowSizeFromProvider(this.deps.model),
      modelInfoCtx: getModelDevInfo(this.deps.model)?.contextLimit,
      configuredCtx: globalConfig.llm.context_max_tokens,
    });
    // 无 context window 信号时无法做预算判定,保守全量保留(不裁)。
    if (!contextLimit || contextLimit <= 0) return sections;

    const budget = Math.floor(contextLimit * SYSTEM_CONTEXT_BUDGET_RATIO);
    const encoder = getCachedEncoder(getEncodingForModel(this.deps.model));
    // 编码器不可用时退回保守全量(确定性退化:不裁)。
    if (!encoder) return sections;

    const measureTokens = (entries: readonly PrioritizedSection[]): number => {
      let tokens = 0;
      for (const entry of entries) {
        tokens += encoder.encode(`${entry.section.title}\n${entry.section.content}`).length;
      }
      return tokens;
    };

    if (measureTokens(sections) <= budget) {
      return [...sections];
    }

    // 超预算:保留 mission(priority 最高)与其余按优先级从高到低贪心纳入,
    // 直至纳入下一个会超预算则停止(低优 fragment 整体丢弃,确定性裁剪)。
    const kept = sections.filter((entry) => entry.priority === FragmentPriority.Mission);
    const candidates = sections
      .filter((entry) => entry.priority !== FragmentPriority.Mission)
      .sort((a, b) => b.priority - a.priority); // 高优先级先纳入

    let running = measureTokens(kept);
    for (const entry of candidates) {
      const next = encoder.encode(`${entry.section.title}\n${entry.section.content}`).length;
      if (running + next > budget) {
        break; // 确定性裁剪:剩余低优 fragment 不再纳入
      }
      kept.push(entry);
      running += next;
    }

    leaderLogger.info(
      `[LeaderContextBuilder] system 段超预算(ctx ${contextLimit} · budget ${budget} · ${SYSTEM_CONTEXT_BUDGET_RATIO});` +
      ` 裁前 ${sections.length} 段 → 保留 ${kept.length} 段(mission 锚点必留)。`,
    );
    return kept;
  }

  /**
   * 并发概览(每轮注入 getTeamModeHint):把"并行度 = scope 正交宽度"这个确定性
   * 关系投影给 Leader——当前槽位占用、running worker 角色分布、待派发任务的
   * write_scope 正交分组与冲突对。Leader 据此决定同层并行 vs 串行,不靠猜、不做 gate。
   */
  buildConcurrencyOverview(): string {
    const pool = this.deps.getPool() as unknown as { getAll?: () => AgentHandle[] };
    const allAgents = typeof pool.getAll === 'function' ? pool.getAll.call(pool) : [];
    const running = allAgents.filter((a) => a.status === 'running');

    const board = this.deps.getBoard();
    const maxConcurrent = (globalConfig.agents?.max_concurrent as number | undefined) ?? 5;

    // 写作用域相对 workspace + 截断,控制 token
    const shorten = (p: string): string => {
      const ws = this.deps.workspace;
      let rel = p && p.startsWith(ws) ? p.slice(ws.length).replace(/^\/+/, '') : (p || '');
      if (rel.length > 28) rel = `…${rel.slice(-27)}`;
      return rel || '(root)';
    };

    // running worker 角色分布 + 写作用域(从 task 取,确定性)
    const runningLines = running.slice(0, 8).map((a) => {
      const task = typeof board.getTask === 'function' ? board.getTask(a.taskId) : undefined;
      const scope = task?.write_scope?.length
        ? `[write:${task.write_scope.map(shorten).join('|')}]`
        : '';
      return `@${a.name}(${a.roleType})→${a.taskId || '?'}${scope}`;
    });

    // 待派发任务 scope 正交分析(确定性:ContractAllowedScope.computeScopeOrthogonality)
    const readyTasks = (typeof board.getAllTasks === 'function' ? board.getAllTasks() : [])
      .filter((t) => t.status === 'dispatchable');
    const ortho = computeScopeOrthogonality(
      readyTasks.map((t) => ({ id: t.id, write_scope: t.write_scope ?? [] })),
    );
    const parallelGroups = ortho.orthogonalGroups.filter((g) => g.length >= 2);

    const lines: string[] = [];
    const slotTail = running.length >= maxConcurrent
      ? '(已满,新派发需等待槽位释放)'
      : `, 空槽 ${maxConcurrent - running.length}`;
    lines.push(`- 并发概览: 槽位 ${running.length}/${maxConcurrent} 占用${slotTail}`);
    if (runningLines.length) {
      lines.push(`  运行中: ${runningLines.join(' · ')}${running.length > runningLines.length ? ' · +more' : ''}`);
    }
    if (parallelGroups.length || ortho.overlaps.length) {
      const parts: string[] = [];
      if (parallelGroups.length) {
        parts.push(parallelGroups.slice(0, 3).map((g) => `${g.join('·')} 两两正交→可同层并行`).join('; '));
      }
      if (ortho.overlaps.length) {
        parts.push(`${ortho.overlaps.slice(0, 3).map(([a, b]) => `${a}↔${b} scope 重叠→建议 blocked_by 串行或缩窄 scope`).join('; ')}`);
      }
      lines.push(`  待派发正交分析: ${parts.join(' | ')}`);
    }
    return lines.join('\n');
  }

  /**
   * Build the per-turn team-mode hint shown to the Leader before each user
   * message. 组合 collaboration hint（Solo/Team）+ 执行路由偏好 section（若有）。
   * route 偏好作为尾部 section 合并进同一条 hint（开头前缀仍是 [Solo/Team 模式]），
   * 故 pruneStaleModeHints 按前缀识别整条 hint，route 变化由 prune 刷新最新 hint 自动覆盖，
   * 不新增 append-only 消息类型、不新增残留。
   */
  getTeamModeHint(): string | null {
    const collaborationHint = this.buildCollaborationHint();
    const routeSection = this.buildRoutePreferenceSection();
    const blueprintSection = this.buildBlueprintModeSection();
    return [collaborationHint, routeSection, blueprintSection].filter(Boolean).join('\n') || null;
  }

  /**
   * 项目模式 hint:会话有未完成的项目蓝图(复杂项目)时注入,强力推向委派(create_task+dispatch),
   * 对抗介入后 Leader-first 退回自己干。确定性:蓝图 active 判定;无蓝图 no-op。
   * 与 chooseExecutionRoute 的 project_blueprint_active 路由锁同源(route=delegate + 此 hint 双重锚定)。
   */
  private buildBlueprintModeSection(): string | null {
    const blueprint = parseBlueprint(this.deps.getDb().getSessionState(this.deps.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));
    if (!blueprint) return null;
    const active = isBlueprintActive(blueprint, (taskId) => {
      const task = this.deps.getBoard().getTask(taskId);
      return task?.status === 'terminal';
    });
    if (!active) return null;
    const coverage = computeBlueprintCoverage(blueprint);
    const gapHint = coverage.uncovered.length > 0
      ? ` 缺口子系统需先建 create_task(subsystem=<id>) 才能 dispatch。`
      : '';
    const ready = getReadySubsystems(blueprint, coverage);
    const readyHint = ready.length > 0 ? ` 可推进(依赖已就绪)优先: ${ready.join(', ')}。` : '';
    return `[项目模式] 当前有未完成项目蓝图(${blueprint.subsystems.length} 子系统),默认优先 create_task+dispatch 委派实现,不要自己干大型实现;只有小范围现场闭合才自办。${gapHint}${readyHint}`;
  }

  /**
   * 执行路由偏好提示 section。读 EXECUTION_ROUTE_OVERRIDE 并归一化（hybrid→auto），
   * 仅 direct/delegate 注入显式偏好文案；auto 由 Leader 自主判断，不注入（返回 null）。
   * 归一化复用 resolveEffectiveRoutePreference（单一事实源，与 chooseExecutionRoute 同源）。
   */
  private buildRoutePreferenceSection(): string | null {
    const pref = resolveEffectiveRoutePreference(
      this.deps.getDb().getSessionState(this.deps.sessionId, SESSION_KEYS.EXECUTION_ROUTE_OVERRIDE),
    );
    const locale = getPromptLocale();
    if (pref === 'direct') {
      return locale === 'zh'
        ? '[执行偏好] 用户要求本轮由你（Leader）自己执行；除非任务明显需要并行且你判断必要，否则不派发 worker。'
        : '[Execution preference] The user asks the Leader to execute this turn directly; do not dispatch workers unless the task clearly needs parallelism and you judge it necessary.';
    }
    if (pref === 'delegate') {
      return locale === 'zh'
        ? '[执行偏好] 用户要求本轮优先委派助手；倾向 create_task + dispatch_agent 派发，你自己只做协调与验收。'
        : '[Execution preference] The user asks to delegate this turn; prefer create_task + dispatch_agent, and limit yourself to coordination and review.';
    }
    return null;
  }

  /**
   * Solo/Team 协作模式提示主体（原 getTeamModeHint 实现）。
   */
  private buildCollaborationHint(): string {
    const locale = getPromptLocale();
    const modes = resolveModeRuntimeProjection({
      sessionId: this.deps.sessionId,
      db: this.deps.getDb(),
      blackboardAvailable: this.deps.isBlackboardEnabled(),
      permissionSummary: this.deps.getPermissionSummary(),
    });

    if (modes.collaboration.mode !== 'team') {
      return locale === 'zh'
        ? [
          '[Solo 模式] 当前协作模式为单人。',
          '- Leader 是唯一前台负责人；优先直接完成解释、定位、小范围修改、明确命令和定向验证。',
          '- 需要隔离执行、上下文压力明显、独立验证有价值或用户明确要求时，才 create_task + dispatch_agent 派发内部 ephemeral worker。',
          '- Solo worker 不进入 Team roster、不使用 Team mailbox、不代表最终用户回复；Leader 负责综合结果并最终交付。',
          '- 任务规模较大、涉及前后端或可拆分时，仍按 Solo 语义推进：Leader 直达或内部 ephemeral worker；长期多人 roster 或 P2P 协作确有必要时，先提醒用户切换到 Team。',
          this.buildConcurrencyOverview(),
        ].join('\n')
        : [
          '[Solo mode] Current collaboration mode is Solo.',
          '- The Leader is the only foreground owner; prefer direct closure for explanation, inspection, small edits, explicit commands, and targeted validation.',
          '- Use create_task + dispatch_agent only when isolated execution, context pressure, independent validation, or an explicit user request makes an internal ephemeral worker valuable.',
          '- Solo workers do not enter Team roster, do not use Team mailbox, and do not provide the final user-facing answer; the Leader synthesizes and delivers.',
          '- For broad, frontend/backend, or parallel-safe work, still proceed with Solo semantics: Leader-direct work or internal ephemeral workers. Ask the user to switch to Team first only when long-lived roster or P2P collaboration is truly needed.',
          this.buildConcurrencyOverview(),
        ].join('\n');
    }

    const active = modes.collaboration.activeTeamName || this.deps.getActiveTeamName();
    if (active) {
      // 获取当前 team 的成员列表，让 Leader 感知已有 agent
      let rosterSection = '';
      try {
        const registry = getTeamMemberRegistry();
        const members = registry.getByTeam(active, this.deps.sessionId);
        if (members.length > 0) {
          const memberLines = members.map(m => `  · @${m.name} (${m.role})`);
          rosterSection = `\n- 当前成员 (${members.length}):\n${memberLines.join('\n')}`;
        }
      } catch { /* tolerate */ }

      return locale === 'zh'
        ? [
          `[Team 模式] 当前 active team: "${active}"。`,
          '- 该 team 已建好；实现/写文件/跑命令/构建测试类工作继续走 create_task + dispatch_agent，不要 Leader 单干。',
          '- dispatch_agent 只能使用当前 roster member 名字；新增执行者先 team_manage(action="edit", edit_action="add") 加入 roster。',
          '- 子 agent 之间用 team_message 直接通信；Leader 偶尔 team_inbox 看广播即可。',
          '- 想要快速查看团队成员、待办任务和未读消息时调用 team_manage(action="status")。',
          '- 需要增删改成员名册（加人/删人/改名/换 leader）时用 team_manage(action="edit", edit_action="add|remove|rename|set_leader") 更新当前 roster。',
          '- 任务全部完成后调 team_manage(action="delete") 清理。',
          '- create_task 时用 preferred_agent_name 指定已有成员可复用；dispatch_agent 时 agent_name 需与 preferred_agent_name 一致。',
          rosterSection,
          this.buildConcurrencyOverview(),
        ].filter(Boolean).join('\n')
        : [
          `[Team mode] Current active team: "${active}".`,
          '- This team already exists; implementation, file writes, commands, builds, and tests should continue through create_task + dispatch_agent.',
          '- dispatch_agent may use only current roster member names. Add new executors with team_manage(action="edit", edit_action="add") first.',
          '- Agents communicate directly with team_message; the Leader may occasionally check team_inbox for broadcasts.',
          '- Use team_manage(action="status") for a quick member/task/unread-message view.',
          '- Use team_manage(action="edit", edit_action="add|remove|rename|set_leader") to maintain the roster.',
          '- Clean up with team_manage(action="delete") after all tasks finish.',
          '- preferred_agent_name may reuse an existing member; dispatch_agent.agent_name must match it.',
          rosterSection,
          this.buildConcurrencyOverview(),
        ].filter(Boolean).join('\n');
    }
    return locale === 'zh'
      ? [
        '[Team 模式] 当前 collaboration mode 为 team，但还没有有效 active team。',
        '- dispatch_agent 时系统会自动建团（包含 leader + 目标 agent），无需手动 team_manage(action="create")。',
        '- 如果用户只是想单人完成，请先切回 Solo，再用 Leader 直达或 ephemeral worker。',
      ].join('\n')
      : [
        '[Team mode] Current collaboration mode is team, but there is no valid active team.',
        '- dispatch_agent will auto-create a team (leader + target agent); no manual team_manage(action="create") needed.',
        '- If the user wants Solo execution, switch back to Solo first, then use Leader direct execution or ephemeral workers.',
      ].join('\n');
  }
}
