/**
 * Leader 工具门控的纯函数模块。
 *
 * 历史上 Leader 这条链路上分散了几处"按模式 / 按角色 / 按执行类别过滤工具"的逻辑：
 *   - LeaderExecutionController.getActiveToolDefinitions：按 bughunt/office 模式过滤
 *   - ToolPruner.filterToolsByMode：按 'bughunt' / 'blackboard' 执行模式过滤
 *   - LeaderToolsExecutor.validateDispatchAgentName：按 active team roster 校验目标 agent
 *   - LeaderToolsExecutor.isLeaderExecutionPermissionRequest：拦截 Leader 自己申请实现类权限
 *
 * 这些都是无副作用的纯逻辑（只读输入 → 纯结果），却各自塞在对应类的 protected 方法里，
 * 写测试要先把整个 LeaderAgent 起来，重构起来也碍事。这里把它们抽成模块级纯函数，
 * controller / executor 改为转发调用。
 *
 * 注意：抽的是判定与过滤的语义，不抽副作用（setActiveTeam / emit / setSessionState）；
 * 后者仍然属于 controller / executor 的职责，要通过显式调用纯函数后再执行副作用。
 */

import type { ToolDefinition } from '../../llm/types.js';
import { BUGHUNT_SCAN_TOOL_NAMES } from '../../contracts/constants/leaderToolDefinitions.js';
import { getToolMetadata } from '../../tools/ToolMetadata.js';
import {
  filterToolsByModePolicy,
} from '../../core/ModeToolPolicy.js';
import type { ModeRuntimeProjection } from '../../core/ModeRuntimeProjection.js';

/**
 * Bughunt 扫描类工具（已下放为普通 Tool，注册在 ToolRegistry 中），
 * 仍然只允许在 bughunt 模式下露出给 Leader / Worker。
 *
 * 注意：bughunt ledger 工具（set_bughunt_dag / upsert_bughunt_finding / get_bughunt_*）
 * 是另外一组，由 BUGHUNT_TOOLS schema 定义，命中字段都在 leaderToolDefinitions.ts。
 */
export const BUGHUNT_SCAN_NAMES: ReadonlySet<string> = new Set(BUGHUNT_SCAN_TOOL_NAMES);

/**
 * Blackboard 写入类工具 — 仅在 'blackboard' 执行模式下露出。
 * 抽到模块级常量供 filterToolsByExecutionMode 与 worker 角色裁剪共用。
 */
export const BLACKBOARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  'blackboard',
]);

export interface LeaderToolFilterInput {
  /** Leader meta + direct tools 合并后的候选清单 */
  candidates: ToolDefinition[];
  /** Bughunt schema 工具（leaderToolDefinitions.BUGHUNT_TOOLS） */
  bughuntTools: readonly ToolDefinition[];
  /** Office 模式专属工具名列表（leaderToolDefinitions.OFFICE_TOOL_NAMES） */
  officeToolNames: readonly string[];
  /** Workflow 模式专属工具名列表（leaderToolDefinitions.WORKFLOW_TOOL_NAMES） */
  workflowToolNames: readonly string[];
  bughuntMode: boolean;
  officeMode: boolean;
  workflowMode: boolean;
  modes?: ModeRuntimeProjection;
  /**
   * 黑板是否启用。false 时把 blackboard 统一入口及黑板写入工具从
   * Leader 工具集中剔除 —— 否则 Leader 会调用一个底层 graph 为 null、必然报
   * 「黑板图未初始化」的工具，浪费轮次。默认 true。
   */
  blackboardEnabled?: boolean;
}

/**
 * Leader 视角下根据 bughunt / office / workflow 模式过滤可见工具。
 *
 * 行为：
 *   - bughunt 开 → 把 BUGHUNT_TOOLS 注入到候选前，去重；scan 工具天然保留
 *   - bughunt 关 → 候选中过滤掉所有 BUGHUNT_TOOLS schema + scan 工具名
 *   - office 关 → 过滤掉 office 专属工具
  *   - workflow 关 → 过滤掉 workflow 专属工具（7 件套已在核心工具里立即注册）
  *   - Leader 保留执行类工具，按 S1/S2/S3 分层决定自办或派发
  *   - 最终按 function.name 去重，先出先留
 */
export function filterLeaderTools(input: LeaderToolFilterInput): ToolDefinition[] {
  const bughuntSchemaNames = new Set(input.bughuntTools.map((t) => t.function.name));
  const officeNames = new Set(input.officeToolNames);
  const workflowNames = new Set(input.workflowToolNames);

  let filtered: ToolDefinition[] = input.bughuntMode
    ? [...input.bughuntTools, ...input.candidates]
    : input.candidates.filter((t) => {
        const name = t.function.name;
        return !bughuntSchemaNames.has(name) && !BUGHUNT_SCAN_NAMES.has(name);
      });

  if (!input.officeMode) {
    filtered = filtered.filter((t) => !officeNames.has(t.function.name));
  }

  if (!input.workflowMode) {
    filtered = filtered.filter((t) => !workflowNames.has(t.function.name));
  }

  // 黑板关闭时剔除黑板写入工具（默认启用）
  if (input.blackboardEnabled === false) {
    filtered = filtered.filter((t) => !BLACKBOARD_TOOL_NAMES.has(t.function.name));
  }

  if (input.modes) {
    filtered = filterToolsByModePolicy(filtered, {
      actor: 'leader',
      controlMode: input.modes.controlMode,
      routeMode: input.modes.route.mode,
      collaborationMode: input.modes.collaboration.mode,
      activeModes: input.modes.modePlugins,
      blackboardMode: input.modes.blackboard.mode,
      permissionMode: input.modes.permission.mode,
      activeTeamName: input.modes.collaboration.activeTeamName ?? null,
      callerInTeamRoster: true,
      callerIsTeamLeader: true,
      getToolMetadata,
    });
  }

  return dedupeToolsByName(filtered);
}

/** 按 function.name 去重，保留首次出现的 ToolDefinition */
export function dedupeToolsByName(tools: ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>();
  const out: ToolDefinition[] = [];
  for (const tool of tools) {
    const name = tool.function.name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}

/**
 * Worker / pruner 视角的执行模式工具过滤。
 *
 * - 'bughunt' 模式：bughunt schema 工具 + scan 工具仅此模式可见
 * - 'blackboard' 模式：blackboard 写入工具仅此模式可见
 * - 其余模式：上述两类工具都被剔除
 *
 * 注意：函数返回的工具数组是输入的子集，保留原顺序。
 */
export function filterToolsByExecutionMode(
  tools: ToolDefinition[],
  mode: string,
  bughuntToolNames: readonly string[],
): ToolDefinition[] {
  const bughuntSet = new Set<string>([...bughuntToolNames, ...BUGHUNT_SCAN_NAMES]);

  return tools.filter((tool) => {
    const name = tool.function.name;
    if (bughuntSet.has(name) && mode !== 'bughunt') return false;
    if (BLACKBOARD_TOOL_NAMES.has(name) && mode !== 'blackboard') return false;
    return true;
  });
}

/**
 * Leader 调用 dispatch_agent 之前的目标名校验。
 *
 * 真值矩阵：
 *   - 没有 active team → 拒绝，提示先 team_manage(action="create")
 *   - active team roster 空 → 拒绝，提示 team_manage(action="create") 加 members
 *   - agent 不在 roster.member 中 → 拒绝，列出可派发成员
 *   - 否则 → ok
 */
export interface DispatchAgentNameInput {
  agentName: string;
  activeTeam: string | null;
  roster: ReadonlyArray<{ name: string; role: string }>;
}

export type DispatchAgentNameResult =
  | { ok: true }
  | { ok: false; message: string };

export function validateDispatchAgentName(input: DispatchAgentNameInput): DispatchAgentNameResult {
  if (!input.activeTeam) {
    return {
      ok: false,
      message: `当前没有 active team，无法 dispatch_agent @${input.agentName}。请先调用 team_manage(action="create") 建团，并把 @${input.agentName} 列入 members（agent_name 使用你要派发的 @${input.agentName} 精确名字），然后再 dispatch_agent。`,
    };
  }
  if (input.roster.length === 0) {
    return {
      ok: false,
      message: `Team "${input.activeTeam}" 的 roster 为空，无法 dispatch_agent @${input.agentName}。请重新 team_manage(action="create") 并把 @${input.agentName} 列入 members（名字必须与派发目标一致）。`,
    };
  }
  if (input.roster.some((m) => m.name === input.agentName && m.role === 'member')) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `Agent @${input.agentName} 不在当前 active team "${input.activeTeam}" 的 members roster 中。要派发它，请先 team_manage(action="edit", edit_action="add", team_name="${input.activeTeam}", member="${input.agentName}") 把它加入 team，或改用现有成员。当前可派发成员：${formatRoster(input.roster)}`,
  };
}

/** 把 roster 渲染成 `@name(role), @name(role)` 列表，给错误信息和系统注入用 */
export function formatRoster(roster: ReadonlyArray<{ name: string; role: string }>): string {
  return roster.map((m) => `@${m.name}(${m.role})`).join(', ');
}

/**
 * Leader 与 Worker 均可使用的执行类工具集合。
 * 该集合仅用于测试/策略识别；是否调用由 Leader 的 S1/S2/S3 分层提示词决定。
 */
export const LEADER_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'python_exec',
  'structured_patch',
  'file_create',
]);

export function isLeaderExecutionTool(toolName: string): boolean {
  return LEADER_EXECUTION_TOOLS.has(toolName.trim().toLowerCase());
}
