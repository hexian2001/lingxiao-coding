/**
 * 项目蓝图前端镜像类型 —— 与后端 src/core/ProjectBlueprint.ts 同构。
 * 后端事件 leader:blueprint_updated 的 payload(blueprint/coverage)与 runtime snapshot
 * 的 modes.blueprint 都用此形状。前端 BlueprintView 据此渲染子系统矩阵 + 覆盖仪表盘。
 *
 * 蓝图子系统清单 100% 由 LLM 自写(id/名称/范围/角色/状态/依赖),系统不预设模板;
 * 后端已移除 PROJECT_TYPES 查表,前端也不再持有子系统字典,name/description 直接取自 entry。
 */

export type ProjectTypeId =
  | 'web-app'
  | 'saas'
  | 'admin-dashboard'
  | 'content-platform'
  | 'e-commerce'
  | 'api-service'
  | 'cli-tool'
  | 'generic';

export type BlueprintSubsystemStatus = 'implement' | 'defer' | 'not_applicable';

export interface BlueprintSubsystemEntry {
  subsystemId: string;
  /** 子系统中文名(LLM 自写,与后端 entry.name 对齐)。 */
  name: string;
  /** 该子系统涵盖范围(LLM 自写,与后端 entry.description 对齐)。 */
  description: string;
  status: BlueprintSubsystemStatus;
  rationale?: string;
  taskIds: readonly string[];
  agentType?: string;
  /** 该子系统依赖的其它 subsystemId(与后端 BlueprintSubsystemEntry.dependsOn 对齐)。 */
  dependsOn?: readonly string[];
}

export interface ProjectBlueprint {
  /** 后端已移除 projectType 字段(蓝图改为 LLM 自写子系统清单),旧快照可能带,保留可选用于向后兼容。 */
  projectType?: ProjectTypeId;
  subsystems: readonly BlueprintSubsystemEntry[];
  createdAt: number;
  updatedAt: number;
  notes?: string;
}

export interface BlueprintCoverage {
  implemented: readonly string[];
  /** implement 但无任务覆盖 → dispatch 拦截;前端只取 id/name 展示 */
  uncovered: readonly { id: string; name: string }[];
  deferred: readonly string[];
  notApplicable: readonly string[];
  readyToDispatch: boolean;
}

/** 前端复刻后端 computeBlueprintCoverage(纯函数):从蓝图条目自带 name 算覆盖状态。 */
export function computeBlueprintCoverage(blueprint: ProjectBlueprint): BlueprintCoverage {
  const implemented: string[] = [];
  const uncovered: Array<{ id: string; name: string }> = [];
  const deferred: string[] = [];
  const notApplicable: string[] = [];
  for (const entry of blueprint.subsystems) {
    if (entry.status === 'implement') {
      if (entry.taskIds.length > 0) implemented.push(entry.subsystemId);
      else uncovered.push({ id: entry.subsystemId, name: entry.name });
    } else if (entry.status === 'defer') {
      deferred.push(entry.subsystemId);
    } else {
      notApplicable.push(entry.subsystemId);
    }
  }
  return {
    implemented,
    uncovered,
    deferred,
    notApplicable,
    readyToDispatch: uncovered.length === 0,
  };
}

/**
 * 角色 → 方寸汉字(与 TUI `src/tui/design/iconography.ts` ROLE_HANZI 同源,国风点睛)。
 * 蓝图默认角色含 `fullstack`(TUI 无此键),此处补「贯」——贯通前后端,与「枢/屏」对仗。
 * 命中失败回退 DEFAULT_ROLE_HANZI「士」(执事之才,中性典雅)。
 */
export const ROLE_HANZI: Record<string, string> = {
  research: '研',
  coding: '码',
  review: '审',
  verify: '验',
  frontend: '屏',
  backend: '枢',
  fullstack: '贯',
  qa: '测',
  ux_designer: '韵',
  planning: '谋',
  testing: '试',
  architect: '构',
};
export const DEFAULT_ROLE_HANZI = '士';

/** 取角色方寸字,未命中回退默认。纯函数。 */
export function roleHanzi(role?: string): string {
  return (role && ROLE_HANZI[role]) || DEFAULT_ROLE_HANZI;
}

/**
 * 蓝图状态 → 方寸几何符(与 TUI `BlueprintPanel.entryIcon` 同源,U+25A0–25FF,宽1 冷静)。
 * `implement` 但无任务覆盖即为「缺口」,用 BLUEPRINT_GAP_GLYPH「◇」覆盖(运行时判定,不入静态表)。
 */
export const BLUEPRINT_STATUS_GLYPH: Record<BlueprintSubsystemStatus, string> = {
  implement: '◉',
  defer: '◓',
  not_applicable: '◌',
};
export const BLUEPRINT_GAP_GLYPH = '◇';

// ─── 契约状态(从 /api/v1/contracts 拉取,映射到子系统 surface) ──────────────

/** 契约条目(与后端 ContractPackEntry 对齐,只取可视化所需字段)。 */
export interface ContractEntry {
  surface: string;
  title: string;
  version?: number;
  sha256: string;
  tags?: string[];
  allowedScope?: { allow: string[]; forbid?: string[]; allowCreate?: boolean };
}

/** 子系统契约状态:有契约✓/无契约✗/版本号。 */
export interface SubsystemContractStatus {
  hasContract: boolean;
  version?: number;
  title?: string;
}

/** 从契约列表构建 surface→status 映射。纯函数。 */
export function buildContractStatusMap(contracts: ContractEntry[]): Map<string, SubsystemContractStatus> {
  const map = new Map<string, SubsystemContractStatus>();
  for (const c of contracts) {
    map.set(c.surface, { hasContract: true, version: c.version, title: c.title });
  }
  return map;
}

// ─── DAG 任务节点(从 dagSnapshot.nodes 取可视化所需字段) ────────────────────

export type TaskReadiness = 'ready' | 'blocked' | 'running' | 'terminal';

export interface DAGTaskNode {
  id: string;
  subject: string;
  status: string;
  readiness?: TaskReadiness;
  agentType?: string;
  assignedAgent?: string;
  blockedBy?: string[];
  displayState?: string;
  orchestration?: {
    contractBinding?: { surface?: string; tag?: string; requireContract?: boolean };
    nodeKind?: string;
  };
}

/** 从 dagSnapshot.nodes 提取任务节点(容错:后端 nodes 是 Record<string,unknown>[])。 */
export function extractDAGTaskNodes(nodes: Array<Record<string, unknown>>): DAGTaskNode[] {
  return nodes.map((n) => ({
    id: String(n.id ?? ''),
    subject: String(n.subject ?? ''),
    status: String(n.status ?? ''),
    readiness: (n.readiness as TaskReadiness) ?? undefined,
    agentType: n.agentType ? String(n.agentType) : undefined,
    assignedAgent: n.assignedAgent ? String(n.assignedAgent) : undefined,
    blockedBy: Array.isArray(n.blockedBy) ? (n.blockedBy as string[]) : undefined,
    displayState: n.displayState ? String(n.displayState) : undefined,
    orchestration: n.orchestration as DAGTaskNode['orchestration'],
  }));
}

/** 任务可视化状态(从 displayState/readiness/status 派生,纯函数)。 */
export type TaskVisualState = 'running' | 'ready' | 'blocked' | 'completed' | 'failed' | 'pending';
export function taskVisualState(node: DAGTaskNode): TaskVisualState {
  if (node.readiness === 'running') return 'running';
  if (node.readiness === 'terminal') {
    return node.status === 'failed' || node.status === 'cancelled' ? 'failed' : 'completed';
  }
  if (node.readiness === 'ready') return 'ready';
  if (node.readiness === 'blocked') return 'blocked';
  if (node.displayState === 'in_progress') return 'running';
  if (node.displayState === 'completed') return 'completed';
  if (node.displayState === 'failed' || node.displayState === 'cancelled') return 'failed';
  if (node.displayState === 'blocked') return 'blocked';
  return 'pending';
}
