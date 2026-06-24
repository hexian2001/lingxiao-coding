/**
 * ProjectBlueprint — 项目蓝图:把"做一个完整项目"展开成 LLM 自主规划的子系统清单。
 *
 * 设计:系统不再持有"项目类型 → 标准子系统"模板表——不替 LLM 做项目规划决策。
 * 子系统清单 100% 由 LLM 在 define_project_blueprint 自写(id/名称/范围/角色/状态/依赖),
 * 系统只做结构化载体 + 确定性校验(id 唯一、name+description 必填、depends_on 无环且引用
 * 必须在本清单内、defer·not_applicable 必带 rationale)+ 三道完整性 gate(覆盖 gate / 路由锁
 * / 项目模式 hint)。
 *
 * 治本:把"完整交付"从 prompt 劝说升级为机器 gate——声明 implement 的子系统必须建任务覆盖,
 * 否则 dispatch 被拦截(防规划坍缩成 MVP);蓝图未完成时强制委派(防介入后 Leader 自己干)。
 *
 * 零启发式:校验全是集合运算 + DAG 拓扑(复用通用 DagScheduler 纯函数 topologicalOrder / getReadyNodes)。
 * 单一事实源为会话 session state 里的 ProjectBlueprint JSON;本模块保持纯函数。
 */
import { topologicalOrder, getReadyNodes, type DagSchedulerDeps } from './DagScheduler.js';

// ─── 蓝图实体(会话 session state 持久化) ───────────────────────────────────

export type BlueprintSubsystemStatus = 'implement' | 'defer' | 'not_applicable';

export interface BlueprintSubsystemEntry {
  /** 稳定标识,作为 create_task.subsystem 的取值。全蓝图内唯一。 */
  readonly subsystemId: string;
  /** 必填:LLM 自写的子系统名称(parseBlueprint 对旧快照缺失时用 subsystemId 兜底)。 */
  readonly name: string;
  /** 必填:该子系统涵盖范围(给 Leader 建任务时参考)。parseBlueprint 对旧快照缺失兜底为 ''。 */
  readonly description: string;
  readonly status: BlueprintSubsystemStatus;
  /** defer/not_applicable 必填;implement 时可空 */
  readonly rationale?: string;
  /** 已登记到该子系统的任务 id 列表(create_task 带 subsystem 时追加) */
  readonly taskIds: readonly string[];
  /** LLM 为该子系统指定的实现角色(可选,scaffold/前端有兜底)。 */
  readonly agentType?: string;
  /** 该子系统依赖的其它 subsystemId。必须无环,且引用本清单内的 id(normalize 时过滤非法引用)。
   *  ready 子系统判定据此拓扑(getReadySubsystems)。 */
  readonly dependsOn?: readonly string[];
}

export interface ProjectBlueprint {
  readonly subsystems: readonly BlueprintSubsystemEntry[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly notes?: string;
}

// ─── 纯函数 ─────────────────────────────────────────────────────────────────

function normalizeStatus(value: unknown): BlueprintSubsystemStatus | undefined {
  if (value === 'implement' || value === 'defer' || value === 'not_applicable') return value;
  if (value === 'deferred' || value === 'skip-later') return 'defer';
  if (value === 'na' || value === 'n/a' || value === 'skip' || value === 'out-of-scope') return 'not_applicable';
  if (value === 'required' || value === 'yes' || value === 'include' || value === 'build') return 'implement';
  return undefined;
}

export interface BlueprintSubsystemInput {
  subsystemId: string;
  name: string;
  description: string;
  status?: BlueprintSubsystemStatus;
  rationale?: string;
  agentType?: string;
  dependsOn?: readonly string[];
}

export interface NormalizeBlueprintInput {
  /** LLM 自写的子系统数组(归一化前的 unknown)。 */
  subsystems: unknown;
  notes?: unknown;
  /** 注入时间戳(测试可控);运行时默认 Date.now() */
  now?: number;
  /** 已有蓝图:保留其 taskIds 与 rationale(resume/重定义一致性) */
  existing?: ProjectBlueprint | null;
}

export type NormalizeBlueprintResult = ProjectBlueprint | { error: string };

/**
 * 把 LLM 自写的子系统清单归一化为合法蓝图。全确定性、零启发式:
 *  - subsystems 必须非空;逐条过滤无 id 的;id 必须唯一;name/description 必填。
 *  - depends_on 引用必须在本清单内,不在的静默过滤(集合判定);整体必须无环(复用 DagScheduler)。
 *  - defer/not_applicable 必须带 rationale(砍掉一个子系统的实现必须有理由)。
 *  - 向后兼容:existing 的 taskIds/rationale 保留(resume 一致性)。
 */
export function normalizeBlueprint(input: NormalizeBlueprintInput): NormalizeBlueprintResult {
  if (!Array.isArray(input.subsystems) || input.subsystems.length === 0) {
    return { error: 'define_project_blueprint 必须提供非空 subsystems 数组(列出本项目的全部子系统)。' };
  }

  const raws: BlueprintSubsystemInput[] = [];
  for (const item of input.subsystems) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const subsystemId = typeof o.subsystem_id === 'string'
      ? o.subsystem_id.trim()
      : typeof o.subsystemId === 'string' ? o.subsystemId.trim() : '';
    if (!subsystemId) continue; // 无 id 的条目直接丢弃
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const description = typeof o.description === 'string' ? o.description.trim() : '';
    const agentRaw = typeof o.agent_type === 'string' ? o.agent_type : o.agentType;
    const dependsRaw = Array.isArray(o.depends_on) ? o.depends_on : Array.isArray(o.dependsOn) ? o.dependsOn : undefined;
    raws.push({
      subsystemId,
      name,
      description,
      status: normalizeStatus(o.status),
      rationale: typeof o.rationale === 'string' ? o.rationale.trim() || undefined : undefined,
      agentType: typeof agentRaw === 'string' ? agentRaw.trim() || undefined : undefined,
      ...(dependsRaw ? { dependsOn: dependsRaw.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map((d) => d.trim()) } : {}),
    });
  }
  if (raws.length === 0) {
    return { error: 'subsystems 数组中没有任何带 subsystem_id 的有效条目。' };
  }

  // id 唯一性(确定性报错并列出重复项)。
  const seen = new Map<string, number>();
  for (const r of raws) seen.set(r.subsystemId, (seen.get(r.subsystemId) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (dupes.length > 0) {
    return { error: `subsystems 中存在重复 subsystem_id: ${dupes.join(', ')}。每个子系统 id 必须唯一。` };
  }

  const noName = raws.filter((r) => !r.name).map((r) => r.subsystemId);
  if (noName.length > 0) {
    return { error: `以下子系统缺少 name: ${noName.join(', ')}。每个子系统必须有名称。` };
  }
  const noDesc = raws.filter((r) => !r.description).map((r) => r.subsystemId);
  if (noDesc.length > 0) {
    return { error: `以下子系统缺少 description: ${noDesc.join(', ')}。每个子系统必须有范围描述。` };
  }

  // depends_on 引用必须在本清单内(集合判定,非启发式);不在的静默过滤。
  const knownIds = new Set(raws.map((r) => r.subsystemId));
  // 向后兼容 existing 的 taskIds 与 rationale(resume/重定义一致性)。
  const existingBy = new Map<string, BlueprintSubsystemEntry | undefined>();
  if (input.existing) {
    for (const e of input.existing.subsystems) existingBy.set(e.subsystemId, e);
  }

  const entries: BlueprintSubsystemEntry[] = raws.map((r) => {
    const status = r.status ?? 'implement';
    const existing = existingBy.get(r.subsystemId);
    const rationale = r.rationale ?? existing?.rationale;
    const dependsRaw = r.dependsOn ?? existing?.dependsOn;
    const dependsOn = dependsRaw && dependsRaw.length > 0 ? dependsRaw.filter((d) => knownIds.has(d)) : undefined;
    return {
      subsystemId: r.subsystemId,
      name: r.name,
      description: r.description,
      status,
      ...(rationale ? { rationale } : {}),
      taskIds: existing?.taskIds ?? [],
      ...(r.agentType ? { agentType: r.agentType } : existing?.agentType ? { agentType: existing.agentType } : {}),
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
    };
  });

  const missingRationale = entries.filter((e) => e.status !== 'implement' && !e.rationale);
  if (missingRationale.length > 0) {
    const first = missingRationale[0];
    return {
      error: `以下子系统标记为 ${first.status} 但未给出 rationale: ${missingRationale.map((e) => e.subsystemId).join(', ')}。砍掉一个子系统的实现必须有明确理由(为何不需要/何时补做)。`,
    };
  }

  // 子系统依赖拓扑无环校验(fail-closed,复用 DagScheduler.topologicalOrder)。
  const topo = topologicalOrder(entries.map((e) => ({ id: e.subsystemId, blocked_by: e.dependsOn ?? [] })));
  if ('cycle' in topo) {
    return { error: `子系统依赖存在环: ${topo.cycle.join(' → ')}。请检查 depends_on,移除成环依赖。` };
  }

  // integration-verify 强制检查:implement 子系统 ≥ 3 时,必须定义 integration-verify 类型子系统。
  // 治 projectD 案例:7个 implement 子系统但无集成验证,导致任务全绿但前端全 404。
  // 识别用 subsystemId 模式匹配(不强制固定名称),小项目(< 3 implement)不触发。
  const implementCount = entries.filter((e) => e.status === 'implement').length;
  if (implementCount >= 3) {
    const hasIntegrationVerify = entries.some((e) =>
      /integration[-_]?verify|integ[-_]?verify/i.test(e.subsystemId),
    );
    if (!hasIntegrationVerify) {
      return {
        error: `蓝图包含 ${implementCount} 个 implement 子系统(≥ 3),但未定义 integration-verify 类型子系统。` +
          `当 implement 子系统 ≥ 3 时,必须额外定义一个用于集成验证的子系统(subsystemId 包含 integration-verify / integration_verify / integ-verify),` +
          `确保各子系统产出能被端到端验证。请在 subsystems 中补充一个 integration-verify 子系统(如 subsystemId: 'integration-verify', status: 'implement')。`,
      };
    }
  }

  const now = typeof input.now === 'number' ? input.now : Date.now();
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : undefined;

  return {
    subsystems: entries,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    ...(notes ? { notes } : {}),
  };
}

/** 把 taskId 登记到某 subsystem(幂等)。返回新蓝图(不可变)。子系统不存在则原样返回。 */
export function registerTaskId(blueprint: ProjectBlueprint, subsystemId: string, taskId: string, now: number = Date.now()): ProjectBlueprint {
  if (!blueprint.subsystems.some((e) => e.subsystemId === subsystemId)) return blueprint;
  let changed = false;
  const subsystems = blueprint.subsystems.map((e) => {
    if (e.subsystemId !== subsystemId) return e;
    if (e.taskIds.includes(taskId)) return e;
    changed = true;
    return { ...e, taskIds: [...e.taskIds, taskId] };
  });
  return changed ? { ...blueprint, subsystems, updatedAt: now } : blueprint;
}

/** 从所有 subsystem 移除某 taskId(删任务时调用,保持一致)。返回新蓝图(幂等)。 */
export function unregisterTaskId(blueprint: ProjectBlueprint, taskId: string, now: number = Date.now()): ProjectBlueprint {
  let changed = false;
  const subsystems = blueprint.subsystems.map((e) => {
    if (!e.taskIds.includes(taskId)) return e;
    changed = true;
    return { ...e, taskIds: e.taskIds.filter((id) => id !== taskId) };
  });
  return changed ? { ...blueprint, subsystems, updatedAt: now } : blueprint;
}

export interface BlueprintCoverage {
  /** status=implement 且已登记任务 */
  readonly implemented: readonly string[];
  /** status=implement 但无任何任务 → 必须补(dispatch gate 据此拦截) */
  readonly uncovered: readonly { readonly id: string; readonly name: string }[];
  readonly deferred: readonly string[];
  readonly notApplicable: readonly string[];
  /** uncovered 为空才允许自由 dispatch */
  readonly readyToDispatch: boolean;
}

/**
 * 覆盖状态投影。直接按蓝图条目的 status/taskIds 判定(不再查任何外部表),
 * 否则自定义 subsystemId 会被静默跳过、dispatch gate 失效。
 */
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
 * 蓝图中"可推进"的 implement 子系统:其 dependsOn 子系统都已开始(已登记任务)。
 * 委托通用 DagScheduler.getReadyNodes;只返回候选 id,不自动派发(dispatch 决策归 Leader)。
 * 用于上下文提示 Leader 按依赖顺序优先建/派任务,治"执行顺序完整性"。
 */
export function getReadySubsystems(
  blueprint: ProjectBlueprint,
  coverage: BlueprintCoverage = computeBlueprintCoverage(blueprint),
): string[] {
  const implemented = new Set(coverage.implemented);
  const entryById = new Map(blueprint.subsystems.map((e) => [e.subsystemId, e]));
  const views = blueprint.subsystems.map((e) => ({ id: e.subsystemId, blocked_by: e.dependsOn ?? [] }));
  const deps: DagSchedulerDeps<{ id: string; blocked_by: readonly string[] }> = {
    isDependencySatisfied: (dep) => !!dep && implemented.has(dep.id),
    isCandidate: (e) => entryById.get(e.id)?.status === 'implement',
  };
  return getReadyNodes(views, deps).map((v) => v.id);
}

/**
 * 蓝图是否处于"项目活跃"状态:存在未覆盖的 implement 子系统(还没建任务),
 * 或有任何未 terminal 的登记任务。用于路由锁定——活跃时 chooseExecutionRoute
 * 倾向 delegate(优先委派),而非 default_autonomous 让 Leader 退回自己干。
 * isTaskTerminal 由 caller 提供(查 board 真实任务状态),保持本模块纯函数。
 */
export function isBlueprintActive(blueprint: ProjectBlueprint, isTaskTerminal: (taskId: string) => boolean): boolean {
  if (computeBlueprintCoverage(blueprint).uncovered.length > 0) return true;
  for (const entry of blueprint.subsystems) {
    if (entry.status !== 'implement') continue;
    for (const taskId of entry.taskIds) {
      if (!isTaskTerminal(taskId)) return true;
    }
  }
  return false;
}

/** 子系统契约状态(由 caller 从黑板 ContractPack 查得,保持本模块纯函数)。 */
export interface SubsystemContractStatus {
  /** 该 surface 是否有活跃契约 */
  hasContract: boolean;
  /** 契约版本(有契约时) */
  version?: number;
  /** 是否有 contract 任务(不管是否完成),用于区分"契约收敛中"和"真缺口" */
  hasContractTask?: boolean;
}

/** 蓝图概览(注入 Leader 每轮动态上下文,确定性投影覆盖状态 + 依赖拓扑 + 可推进子系统 + 契约覆盖)。
 *  contractStatusBySubsystem: 可选,由 caller 从黑板 ContractPack 查得每个子系统 surface 的契约状态。
 *  未提供时不渲染契约列(向后兼容)。 */
export function renderBlueprintOverview(
  blueprint: ProjectBlueprint,
  coverage: BlueprintCoverage = computeBlueprintCoverage(blueprint),
  contractStatusBySubsystem?: ReadonlyMap<string, SubsystemContractStatus>,
): string {
  const ready = getReadySubsystems(blueprint, coverage);
  const readySet = new Set(ready);
  const lines: string[] = [];
  lines.push(`[项目蓝图] 共 ${blueprint.subsystems.length} 子系统`);
  if (coverage.uncovered.length > 0) {
    lines.push(`⚠ 覆盖缺口(已声明 implement 但尚无任务,dispatch 会被拦截): ${coverage.uncovered.map((s) => `${s.id}(${s.name})`).join(', ')}`);
    lines.push(`  补救:为每个缺口 create_task(subsystem=<id>),或在 define_project_blueprint 改 status=defer/not_applicable 并附 rationale。`);
  } else {
    lines.push(`✓ 蓝图覆盖完整:${coverage.implemented.length} 实现中 · ${coverage.deferred.length} 延后 · ${coverage.notApplicable.length} 不适用`);
  }
  if (ready.length > 0) {
    lines.push(`◉ 可推进子系统(依赖已就绪,优先建/派任务): ${ready.join(', ')}`);
  }
  // 契约覆盖摘要:三态分类——已有契约/契约收敛中(contract任务已建)/真缺口
  if (contractStatusBySubsystem) {
    const withContract: string[] = [];
    const converging: string[] = [];
    const withoutContract: string[] = [];
    for (const entry of blueprint.subsystems) {
      if (entry.status !== 'implement') continue;
      const cs = contractStatusBySubsystem.get(entry.subsystemId);
      if (cs?.hasContract) withContract.push(entry.subsystemId);
      else if (cs?.hasContractTask) converging.push(entry.subsystemId);
      else withoutContract.push(entry.subsystemId);
    }
    if (withoutContract.length > 0) {
      lines.push(`⚠ 契约缺口(尚无契约且无 contract 任务): ${withoutContract.join(', ')}`);
      lines.push(`  补救:为每个缺口派 architect 建 contract(surface=<subsystem-id>),或由 Leader 显式建 contract_surface=<id>。`);
    }
    if (converging.length > 0) {
      lines.push(`⏳ 契约收敛中(contract 任务已建/运行中,待物化后实现任务解锁): ${converging.join(', ')}`);
    }
    if (withContract.length > 0 && withoutContract.length === 0) {
      lines.push(`✓ 契约覆盖完整:${withContract.length} 个 implement 子系统已有契约`);
    }
  }
  for (const entry of blueprint.subsystems) {
    const tag = entry.status === 'implement'
      ? (entry.taskIds.length ? `[${entry.taskIds.join(',')}]` : '✗缺任务')
      : entry.status === 'defer'
        ? '延后'
        : '不适用';
    const readyTag = entry.status === 'implement' && readySet.has(entry.subsystemId) ? ' ◉可推进' : '';
    const depTag = entry.dependsOn && entry.dependsOn.length > 0 ? ` ← ${entry.dependsOn.join(',')}` : '';
    // 契约列:✓契约@v2 / ⏳收敛中 / ✗无契约 / (非 implement 不显示)
    let contractTag = '';
    if (contractStatusBySubsystem && entry.status === 'implement') {
      const cs = contractStatusBySubsystem.get(entry.subsystemId);
      if (cs?.hasContract) {
        contractTag = ` ✓契约${cs.version ? `@v${cs.version}` : ''}`;
      } else if (cs?.hasContractTask) {
        contractTag = ' ⏳契约收敛中';
      } else {
        contractTag = ' ✗无契约';
      }
    }
    const r = entry.rationale ? ` · ${entry.rationale}` : '';
    lines.push(`  - ${entry.subsystemId}(${entry.name}): ${tag}${contractTag}${readyTag}${depTag}${r}`);
  }
  return lines.join('\n');
}

/** define_project_blueprint 返回给 Leader 的建任务脚手架(照着 create_task)。 */
export function renderBlueprintScaffold(blueprint: ProjectBlueprint): string {
  const lines: string[] = ['已记录项目蓝图。为每个 implement 子系统至少建一个任务(create_task 带 subsystem=<id>),参考建议:'];
  for (const entry of blueprint.subsystems) {
    if (entry.status !== 'implement') continue;
    lines.push(`  - subsystem=${entry.subsystemId} (${entry.name}) · 角色=${entry.agentType ?? '(未定)'} · ${entry.description}`);
  }
  lines.push('提示:dispatch 前系统会校验所有 implement 子系统都有任务覆盖;缺口会拦截派发。defer/not_applicable 必须在 define_project_blueprint 给 rationale。');
  return lines.join('\n');
}

/**
 * 把蓝图 implement 子系统映射成契约种子(surface=子系统 id),供 leader/architect 收敛子系统契约。
 * 治 planner→blueprint→contract 断裂:子系统清单(由 LLM 自主规划)经此物化成 contract surface 清单,
 * 让刚完成的蓝图与契约约束合一。纯函数,leader 决策是否 seed(尊重 dispatch 决策权)。
 */
export interface SubsystemContractSeed {
  readonly surface: string;
  readonly title: string;
  readonly content: string;
}

export function buildSubsystemContractSeeds(blueprint: ProjectBlueprint): SubsystemContractSeed[] {
  return blueprint.subsystems
    .filter((e) => e.status === 'implement')
    .map((e) => ({
      surface: e.subsystemId,
      title: e.name,
      content: `${e.name}: ${e.description}。实现角色=${e.agentType ?? '(未定)'}。`,
    }));
}

export function serializeBlueprint(blueprint: ProjectBlueprint): string {
  return JSON.stringify(blueprint);
}

/**
 * 把 session state 里的蓝图 JSON 解析回 ProjectBlueprint。宽容解析,保证 resume 不崩:
 *  - 不校验 projectType(字段已移除,旧快照可能带也可能不带)。
 *  - subsystems 必须是非空数组;旧快照 entry 缺 name → 用 subsystemId 兜底,缺 description → ''。
 */
export function parseBlueprint(raw: unknown): ProjectBlueprint | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    if (!Array.isArray(rec.subsystems) || rec.subsystems.length === 0) return null;
    const subsystems: BlueprintSubsystemEntry[] = (rec.subsystems as unknown[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => {
        const dependsArr = Array.isArray(s.depends_on) ? s.depends_on : Array.isArray(s.dependsOn) ? s.dependsOn : undefined;
        const dependsOn = dependsArr ? dependsArr.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map((d) => d.trim()) : undefined;
        const subsystemId = typeof s.subsystemId === 'string' ? s.subsystemId : '';
        return {
          subsystemId,
          name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : subsystemId,
          description: typeof s.description === 'string' ? s.description.trim() : '',
          status: normalizeStatus(s.status) ?? 'implement',
          ...(typeof s.rationale === 'string' && s.rationale.trim() ? { rationale: s.rationale.trim() } : {}),
          taskIds: Array.isArray(s.taskIds) ? s.taskIds.filter((id): id is string => typeof id === 'string') : [],
          ...(typeof s.agentType === 'string' && s.agentType.trim() ? { agentType: s.agentType.trim() } : {}),
          ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
        };
      })
      .filter((e) => e.subsystemId);
    if (subsystems.length === 0) return null;
    return {
      subsystems,
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : 0,
      updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
      ...(typeof rec.notes === 'string' && rec.notes.trim() ? { notes: rec.notes.trim() } : {}),
    };
  } catch {
    return null;
  }
}

// ─── 增删改操作 ───────────────────────────────────────────────────────────

export interface AddSubsystemInput {
  subsystemId: string;
  name: string;
  description: string;
  status?: BlueprintSubsystemStatus;
  rationale?: string;
  agentType?: string;
  dependsOn?: readonly string[];
}

export type AddSubsystemResult = ProjectBlueprint | { error: string };

/**
 * 添加单个子系统到蓝图。校验同 normalizeBlueprint：
 *  - subsystemId 必须唯一（不与现有冲突）
 *  - name/description 必填
 *  - defer/not_applicable 必须带 rationale
 *  - dependsOn 引用必须在蓝图内（包括新增的）
 *  - 添加后整体必须无环
 */
export function addSubsystem(blueprint: ProjectBlueprint, input: AddSubsystemInput, now: number = Date.now()): AddSubsystemResult {
  const subsystemId = input.subsystemId.trim();
  if (!subsystemId) {
    return { error: '子系统 subsystem_id 不能为空。' };
  }
  if (blueprint.subsystems.some((e) => e.subsystemId === subsystemId)) {
    return { error: `子系统 ${subsystemId} 已存在。请使用 update_subsystem 修改现有子系统。` };
  }
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) {
    return { error: `子系统 ${subsystemId} 缺少 name。` };
  }
  if (!description) {
    return { error: `子系统 ${subsystemId} 缺少 description。` };
  }

  const status = input.status ?? 'implement';
  const rationale = input.rationale?.trim();
  if (status !== 'implement' && !rationale) {
    return { error: `子系统 ${subsystemId} 标记为 ${status} 但未给出 rationale。砍掉一个子系统的实现必须有明确理由。` };
  }

  // 构建新条目
  const knownIds = new Set([...blueprint.subsystems.map((e) => e.subsystemId), subsystemId]);
  const dependsOn = input.dependsOn && input.dependsOn.length > 0
    ? input.dependsOn.filter((d) => knownIds.has(d))
    : undefined;

  const newEntry: BlueprintSubsystemEntry = {
    subsystemId,
    name,
    description,
    status,
    ...(rationale ? { rationale } : {}),
    taskIds: [],
    ...(input.agentType?.trim() ? { agentType: input.agentType.trim() } : {}),
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
  };

  const newSubsystems = [...blueprint.subsystems, newEntry];

  // 无环校验
  const topo = topologicalOrder(newSubsystems.map((e) => ({ id: e.subsystemId, blocked_by: e.dependsOn ?? [] })));
  if ('cycle' in topo) {
    return { error: `添加子系统 ${subsystemId} 后依赖存在环: ${topo.cycle.join(' → ')}。请检查 depends_on。` };
  }

  // integration-verify 强制检查
  const implementCount = newSubsystems.filter((e) => e.status === 'implement').length;
  if (implementCount >= 3) {
    const hasIntegrationVerify = newSubsystems.some((e) =>
      /integration[-_]?verify|integ[-_]?verify/i.test(e.subsystemId),
    );
    if (!hasIntegrationVerify) {
      return {
        error: `添加后蓝图包含 ${implementCount} 个 implement 子系统(≥ 3),但未定义 integration-verify 类型子系统。` +
          `请先添加一个 integration-verify 子系统(如 subsystemId: 'integration-verify', status: 'implement')。`,
      };
    }
  }

  return {
    ...blueprint,
    subsystems: newSubsystems,
    updatedAt: now,
  };
}

export interface UpdateSubsystemInput {
  subsystemId: string;
  name?: string;
  description?: string;
  status?: BlueprintSubsystemStatus;
  rationale?: string;
  agentType?: string;
  dependsOn?: readonly string[];
}

export type UpdateSubsystemResult = ProjectBlueprint | { error: string };

/**
 * 更新子系统属性。只更新提供的字段，未提供的保持不变。
 * 校验规则：
 *  - subsystemId 必须存在
 *  - 更新后 name/description 不能为空
 *  - defer/not_applicable 必须带 rationale
 *  - dependsOn 引用必须在蓝图内
 *  - 更新后整体必须无环
 */
export function updateSubsystem(blueprint: ProjectBlueprint, input: UpdateSubsystemInput, now: number = Date.now()): UpdateSubsystemResult {
  const subsystemId = input.subsystemId.trim();
  if (!subsystemId) {
    return { error: 'subsystem_id 不能为空。' };
  }

  const existingIndex = blueprint.subsystems.findIndex((e) => e.subsystemId === subsystemId);
  if (existingIndex === -1) {
    return { error: `子系统 ${subsystemId} 不存在。请使用 add_subsystem 添加新子系统。` };
  }

  const existing = blueprint.subsystems[existingIndex];
  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const description = input.description !== undefined ? input.description.trim() : existing.description;

  if (!name) {
    return { error: `子系统 ${subsystemId} 的 name 不能为空。` };
  }
  if (!description) {
    return { error: `子系统 ${subsystemId} 的 description 不能为空。` };
  }

  const status = input.status ?? existing.status;
  const rationale = input.rationale !== undefined ? input.rationale?.trim() : existing.rationale;

  if (status !== 'implement' && !rationale) {
    return { error: `子系统 ${subsystemId} 标记为 ${status} 但未给出 rationale。` };
  }

  const knownIds = new Set(blueprint.subsystems.map((e) => e.subsystemId));
  const dependsOn = input.dependsOn !== undefined
    ? (input.dependsOn.length > 0 ? input.dependsOn.filter((d) => knownIds.has(d)) : undefined)
    : existing.dependsOn;

  const agentType = input.agentType !== undefined ? input.agentType?.trim() || undefined : existing.agentType;

  const updatedEntry: BlueprintSubsystemEntry = {
    ...existing,
    name,
    description,
    status,
    ...(rationale ? { rationale } : {}),
    ...(agentType ? { agentType } : {}),
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
  };

  const newSubsystems = [...blueprint.subsystems];
  newSubsystems[existingIndex] = updatedEntry;

  // 无环校验
  const topo = topologicalOrder(newSubsystems.map((e) => ({ id: e.subsystemId, blocked_by: e.dependsOn ?? [] })));
  if ('cycle' in topo) {
    return { error: `更新子系统 ${subsystemId} 后依赖存在环: ${topo.cycle.join(' → ')}。请检查 depends_on。` };
  }

  return {
    ...blueprint,
    subsystems: newSubsystems,
    updatedAt: now,
  };
}

export type DeleteSubsystemResult = ProjectBlueprint | { error: string };

/**
 * 删除子系统。校验规则：
 *  - subsystemId 必须存在
 *  - 不能有其他子系统依赖它（避免破坏依赖链）
 *  - 如果有关联任务，给出警告但允许删除（任务的 subsystem 绑定会失效）
 */
export function deleteSubsystem(blueprint: ProjectBlueprint, subsystemId: string, now: number = Date.now()): DeleteSubsystemResult {
  const trimmedId = subsystemId.trim();
  if (!trimmedId) {
    return { error: 'subsystem_id 不能为空。' };
  }

  const existing = blueprint.subsystems.find((e) => e.subsystemId === trimmedId);
  if (!existing) {
    return { error: `子系统 ${trimmedId} 不存在。` };
  }

  // 检查是否有其他子系统依赖它
  const dependents = blueprint.subsystems.filter((e) =>
    e.dependsOn?.includes(trimmedId),
  );
  if (dependents.length > 0) {
    return {
      error: `无法删除子系统 ${trimmedId}：有 ${dependents.length} 个子系统依赖它: ${dependents.map((e) => e.subsystemId).join(', ')}。` +
        `请先移除这些依赖关系或删除依赖的子系统。`,
    };
  }

  const newSubsystems = blueprint.subsystems.filter((e) => e.subsystemId !== trimmedId);

  // 删除后检查 integration-verify 规则
  const implementCount = newSubsystems.filter((e) => e.status === 'implement').length;
  if (implementCount >= 3) {
    const hasIntegrationVerify = newSubsystems.some((e) =>
      /integration[-_]?verify|integ[-_]?verify/i.test(e.subsystemId),
    );
    if (!hasIntegrationVerify) {
      return {
        error: `删除 ${trimmedId} 后蓝图仍有 ${implementCount} 个 implement 子系统(≥ 3),但缺少 integration-verify 子系统。` +
          `无法删除该子系统。`,
      };
    }
  }

  return {
    ...blueprint,
    subsystems: newSubsystems,
    updatedAt: now,
  };
}
