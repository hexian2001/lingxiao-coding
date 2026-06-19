/**
 * 模式单一事实源（Single Source of Truth for session-scoped modes）。
 *
 * 历史上三个会话级模式（bughunt / office / workflow）的「定义」散落在三处：
 *   - 工具名常量：src/contracts/constants/toolNames.ts（BUGHUNT/OFFICE/WORKFLOW_TOOL_NAMES）
 *   - 会话状态键：src/core/SessionStateKeys.ts（*_MODE_ACTIVE）
 *   - 插件映射：src/web-server/AcpHandler.ts（SESSION_SCOPED_PLUGIN_KEYS + getPluginToolNames）
 *
 * 三处各自维护，没有强类型注册表，也没有一个地方能回答「工具 X 属于哪个模式」。
 * 本文件把它们收口为一张强类型的 MODE_REGISTRY，所有消费者（ModeToolPolicy、
 * LeaderToolGates、AcpHandler、LeaderExecutionController）改为从这里派生，杜绝漂移。
 *
 * 设计原则（对齐 docs/contracts/modes.md）：
 *   - 模式是「能力暴露（exposure）+ 执行期 fail-closed」，**不是安全边界**。
 *     安全由 PermissionSystem + Sandbox 正交保证。
 *   - 三模式彼此可叠加（非互斥），由 exclusiveWith 显式声明互斥关系（目前为空）。
 *   - requiresExecuteGate=true 的模式，其工具在模式关闭时必须被 mode_forbidden 挡掉
 *     （见 ModeToolPolicy.resolveModeToolDecision + Registry.resolveToolAndValidateArgs）。
 */

import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import {
  BUGHUNT_MODE_TOOL_NAMES,
  OFFICE_TOOL_NAMES,
  WORKFLOW_TOOL_NAMES,
} from './constants/toolNames.js';

/** 会话级模式标识符。三个并列的模式/插件 toggle。 */
export type ModeId = 'bughunt' | 'office' | 'workflow';

/**
 * 执行卫生配置（非安全边界）。
 *
 * worktree=true 的模式默认在独立 git worktree 中执行扫描/修改，防止污染主工作树。
 * 这是工程卫生，不是安全隔离——权限与沙箱仍由 PermissionSystem/Sandbox 独立保证。
 */
export interface ModeExecutionHygiene {
  /** 是否默认在独立 git worktree 执行（bughunt 扫描 / workflow 执行）。 */
  worktree: boolean;
}

/** 单个模式的声明式描述符。 */
export interface ModeDescriptor {
  /** 模式标识符，同时用作 pluginId（AcpHandler plugin toggle 的 key）。 */
  readonly id: ModeId;
  /** 持久化该模式开关的 session_state 键（值为 'true' | 'false'）。 */
  readonly sessionKey: string;
  /** 该模式专属的工具名清单（关闭时全部 fail-closed）。 */
  readonly toolNames: readonly string[];
  /**
   * 模式关闭时，toolNames 中的工具是否必须在执行期被 mode_forbidden 拦截。
   * 三模式均为 true——契约 docs/contracts/modes.md:150 要求 hidden tool 必须
   * also fail preflight/execute。
   */
  readonly requiresExecuteGate: true;
  /** 与其它模式互斥关系；空/缺省 = 可与任意模式叠加。 */
  readonly exclusiveWith?: readonly ModeId[];
  /** 执行卫生配置；缺省 = 不启用 worktree 隔离。 */
  readonly executionHygiene?: ModeExecutionHygiene;
}

/**
 * 模式注册表——单一事实源。
 *
 * 修改模式集合、工具清单、执行卫生、互斥关系时，只改这里，所有消费者自动跟随。
 */
export const MODE_REGISTRY: Readonly<Record<ModeId, ModeDescriptor>> = Object.freeze({
  bughunt: {
    id: 'bughunt',
    sessionKey: SESSION_KEYS.BUGHUNT_MODE_ACTIVE,
    toolNames: BUGHUNT_MODE_TOOL_NAMES,
    requiresExecuteGate: true,
    executionHygiene: { worktree: true },
  },
  office: {
    id: 'office',
    sessionKey: SESSION_KEYS.OFFICE_MODE_ACTIVE,
    toolNames: OFFICE_TOOL_NAMES,
    requiresExecuteGate: true,
    // office 工具产出文档到用户可见工作区，不启用 worktree 隔离。
  },
  workflow: {
    id: 'workflow',
    sessionKey: SESSION_KEYS.WORKFLOW_MODE_ACTIVE,
    toolNames: WORKFLOW_TOOL_NAMES,
    requiresExecuteGate: true,
    executionHygiene: { worktree: true },
  },
});

/** 全部模式专属工具名的并集（用于「工具是否属于某个模式」的快速判定）。 */
export const ALL_MODE_TOOL_NAMES: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const id of Object.keys(MODE_REGISTRY) as ModeId[]) {
    for (const name of MODE_REGISTRY[id].toolNames) set.add(name);
  }
  return Object.freeze(set);
})();

/** 工具名 → 所属模式 id 的反查表（构建一次，O(1) 查询）。 */
const TOOL_TO_MODE: ReadonlyMap<string, ModeId> = (() => {
  const map = new Map<string, ModeId>();
  for (const id of Object.keys(MODE_REGISTRY) as ModeId[]) {
    for (const name of MODE_REGISTRY[id].toolNames) map.set(name, id);
  }
  return map;
})();

/**
 * 反查工具所属模式。
 * @returns 模式 id；若工具不属于任何模式（普通工具）返回 null。
 */
export function findModeOfTool(toolName: string): ModeId | null {
  return TOOL_TO_MODE.get(toolName) ?? null;
}

/** 工具是否属于某个会话级模式（即受 mode gate 约束）。 */
export function isModeTool(toolName: string): boolean {
  return TOOL_TO_MODE.has(toolName);
}

/** 全部模式 id（用于遍历）。 */
export const ALL_MODE_IDS: readonly ModeId[] = Object.freeze(
  Object.keys(MODE_REGISTRY) as ModeId[],
);

/**
 * 从会话状态读取器解析当前激活的模式集合。
 *
 * @param reader 任何提供 getSessionState(sessionId, key) 的对象（DatabaseManager / 测试 stub）。
 * @param sessionId 会话 id。
 * @returns Record<ModeId, boolean>，每个模式是否启用。
 *
 * 确定性：只读 session_state 的 *_MODE_ACTIVE 布尔，无启发式、无推断。
 */
export function resolveActiveModes(
  reader: { getSessionState(sessionId: string, key: string): unknown | null },
  sessionId: string,
): Record<ModeId, boolean> {
  const result = {} as Record<ModeId, boolean>;
  for (const id of ALL_MODE_IDS) {
    const descriptor = MODE_REGISTRY[id];
    result[id] = reader.getSessionState(sessionId, descriptor.sessionKey) === 'true';
  }
  return result;
}
