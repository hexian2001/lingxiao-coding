/**
 * DagScheduler — 通用 DAG 调度纯函数(无 IO,确定性,零启发式)。
 *
 * 单一图算法真相源,服务凌霄原本各写一遍的多套依赖解锁:
 *  - bughunt 调查 DAG(`BughuntDagScheduler` 薄封装复用本模块)
 *  - 通用任务 DAG(`TaskBoard` 的环检测 / ready 判定复用本模块)
 *  - 黑板 intent 依赖(`BlackboardGraph.getDispatchableIntents` 复用本模块)
 *  - 项目蓝图子系统依赖(`ProjectBlueprint.getReadySubsystems` 复用本模块)
 *
 * 设计:领域语义(status 字面值 / 契约门 / evidence gate / 「依赖缺失是否视为已解决」)
 * 全部外提成 `DagSchedulerDeps` 回调,引擎只懂 `{ id, blocked_by }` 的纯图运算。
 * 同一套 Kahn 拓扑 + 三道门就绪判定 + DFS 环检测,各领域注入各自 deps,语义各自保留:
 *   - bughunt: 依赖须 completed;候选态 planned;evidence gate
 *   - TaskBoard: 依赖须 terminal+completed;候选态 dispatchable 且无 blocked_reason;契约门
 *   - 黑板: 依赖缺失视为已解决(与上两者相反);候选态 open;无额外门
 *
 * 零运行时依赖(泛型自带,无 import),便于单测与跨入口复用。
 */

// ─── 节点协议 ────────────────────────────────────────────────────────────────

/** 通用 DAG 节点:只要有稳定 id 与依赖边即可。status / gate 等领域字段由 deps 回调解释。 */
export interface DagNodeLike {
  readonly id: string;
  /** 依赖边:本节点被这些 id 阻塞,直到它们都被判定为「已满足」。 */
  readonly blocked_by: readonly string[];
}

/** 领域语义注入回调,把「依赖满足 / 候选态 / 额外门」外提,引擎不耦合具体 status 字面值。 */
export interface DagSchedulerDeps<TNode extends DagNodeLike> {
  /**
   * 依赖是否已满足。接收依赖节点(可能 undefined —— 依赖 id 不在图里)。
   * 各领域语义:
   *  - bughunt / TaskBoard: undefined → 未满足(算 blocker);
   *  - 黑板: undefined → 视为已解决(不算 blocker)。
   */
  isDependencySatisfied: (dep: TNode | undefined) => boolean;
  /** 节点是否处于「可派发候选态」(bughunt: planned;Task: dispatchable 且无 blocked_reason;黑板: open)。 */
  isCandidate: (node: TNode) => boolean;
  /** 额外就绪门(契约 / evidence gate),返回缺口数组,空 = 通过;缺省视为无门。 */
  evaluateExtraGate?: (node: TNode) => string[];
}

export interface DagTopoResult<TNode extends DagNodeLike> {
  readonly order: readonly TNode[];
}

export interface DagCycleResult {
  readonly cycle: readonly string[];
}

export interface DagNodeReadiness {
  readonly ready: boolean;
  readonly reason?: string;
}

// ─── 拓扑排序(Kahn + 环检测,fail-closed)─────────────────────────────────────

/**
 * Kahn 拓扑排序。存在环时返回 { cycle }(fail-closed,避免调度死锁)。
 * 依赖边引用了图中不存在的 id 时,该边忽略(当作无依赖),与各领域既有行为一致。
 */
export function topologicalOrder<TNode extends DagNodeLike>(
  dag: readonly TNode[],
): DagTopoResult<TNode> | DagCycleResult {
  const ids = new Set(dag.map((n) => n.id));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of dag) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const n of dag) {
    for (const b of n.blocked_by) {
      if (ids.has(b)) {
        adj.get(b)!.push(n.id);
        indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
      }
    }
  }
  const queue: string[] = [...dag]
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .map((n) => n.id);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  if (ordered.length < dag.length) {
    const cyclic = dag.filter((n) => !ordered.includes(n.id)).map((n) => n.id);
    return { cycle: cyclic };
  }
  return { order: ordered.map((id) => dag.find((n) => n.id === id)!) };
}

// ─── 环检测(增量,模拟「给 nodeId 加这些依赖是否成环」)──────────────────────

/**
 * 假设给 `nodeId` 追加 `newBlockedBy` 依赖,是否会形成环。
 * 从每个 newBlockedBy 出发,沿现有 blocked_by 反向回溯,看能否回到 nodeId。
 * 泛型自 TaskBoard.wouldCreateDependencyCycle 的 DFS。不修改 dag(纯查询)。
 */
export function wouldCreateCycle<TNode extends DagNodeLike>(
  dag: readonly TNode[],
  nodeId: string,
  newBlockedBy: readonly string[],
): boolean {
  const byId = new Map(dag.map((n) => [n.id, n]));
  const visit = (currentId: string, seen: ReadonlySet<string>): boolean => {
    if (currentId === nodeId) return true;
    if (seen.has(currentId)) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(currentId);
    const current = byId.get(currentId);
    if (!current) return false;
    return current.blocked_by.some((depId) => visit(depId, nextSeen));
  };
  return newBlockedBy.some((depId) => visit(depId, new Set<string>()));
}

// ─── 就绪判定(三道门)+ 候选集 ───────────────────────────────────────────────

/**
 * 节点是否就绪可派发,依次过三道门:
 *  1. 候选态(isCandidate —— 非终态/非在跑/无外部阻塞);
 *  2. blocked_by 全部已满足(isDependencySatisfied);
 *  3. 额外门通过(evaluateExtraGate,如契约就绪 / evidence gate)。
 * 任一不满足返回 { ready: false, reason }。reason 含语义标签供各领域测试匹配。
 */
export function isNodeReady<TNode extends DagNodeLike>(
  node: TNode,
  byId: ReadonlyMap<string, TNode>,
  deps: DagSchedulerDeps<TNode>,
): DagNodeReadiness {
  if (!deps.isCandidate(node)) {
    return { ready: false, reason: 'not a dispatch candidate' };
  }
  const blockers = node.blocked_by.filter((id) => !deps.isDependencySatisfied(byId.get(id)));
  if (blockers.length > 0) {
    return { ready: false, reason: `blocked_by=${blockers.join(',')}` };
  }
  const gaps = deps.evaluateExtraGate ? deps.evaluateExtraGate(node) : [];
  if (gaps.length > 0) {
    return { ready: false, reason: gaps.join('; ') };
  }
  return { ready: true };
}

/**
 * 就绪候选集:遍历 dag 过滤 ready 节点。**只返回候选,不自动 dispatch** ——
 * dispatch 决策权保留给 Leader(凌霄铁律:DAG ready-node 仅作候选提示注入上下文)。
 */
export function getReadyNodes<TNode extends DagNodeLike>(
  dag: readonly TNode[],
  deps: DagSchedulerDeps<TNode>,
): TNode[] {
  const byId = new Map(dag.map((n) => [n.id, n]));
  return dag.filter((node) => isNodeReady(node, byId, deps).ready);
}
