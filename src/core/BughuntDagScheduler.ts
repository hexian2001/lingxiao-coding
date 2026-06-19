/**
 * BughuntDagScheduler — 调查 DAG 的结构化调度核心(纯函数,无 IO)。
 *
 * 现为 `DagScheduler`(通用 DAG 引擎)的薄封装:拓扑排序 / 三道门就绪判定 / 候选集
 * 委托通用引擎,本文件只注入 bughunt 领域语义(`bughuntDeps`):
 *   - isDependencySatisfied: 依赖节点 status==='completed';
 *   - isCandidate: status==='planned';
 *   - evaluateExtraGate: 结构化 evidence_gate(ADT)求值,查 ledger。
 *
 * 保留 bughunt 专属的 `evaluateEvidenceGate`(查 ledger.findings/events 的领域 gate kind),
 * 不上浮到通用引擎——通用层只懂 {id, blocked_by} 纯图运算,零业务耦合。
 *
 * 公开 API 签名不变,调用方(BughuntLedger / LeaderTools bughunt 路径)零改动。
 * 运行时只 import type(编译期擦除)+ 通用纯函数。
 */
import {
  topologicalOrder as dagTopologicalOrder,
  isNodeReady as dagIsNodeReady,
  getReadyNodes as dagGetReadyNodes,
} from './DagScheduler.js';
import type { DagSchedulerDeps, DagTopoResult, DagCycleResult, DagNodeReadiness } from './DagScheduler.js';
import type {
  BughuntDagNode,
  BughuntEvidenceGate,
  BughuntEvidenceKind,
  BughuntLedger,
} from './BughuntLedger.js';

export type { DagTopoResult, DagCycleResult, DagNodeReadiness };

/** Kahn 拓扑排序;存在环时返回 { cycle }(fail-closed)。委托通用引擎。 */
export function topologicalOrder(dag: readonly BughuntDagNode[]): DagTopoResult<BughuntDagNode> | DagCycleResult {
  return dagTopologicalOrder(dag);
}

const VALID_GATE_KINDS = new Set<BughuntEvidenceGate['kind']>(['all', 'finding_status', 'event_present', 'artifact_present']);

/**
 * 求值结构化 evidence_gate,返回缺口(空 = 通过)。
 * string gate(旧数据)视为无结构门,返回 [](通过,向后兼容)。
 */
export function evaluateEvidenceGate(gate: BughuntEvidenceGate | string | undefined, ledger: BughuntLedger): string[] {
  if (!gate) return [];
  if (typeof gate === 'string') return []; // 旧数据:无结构门,通过
  if (!VALID_GATE_KINDS.has(gate.kind)) return [`unknown gate kind: ${gate.kind}`];
  switch (gate.kind) {
    case 'all': {
      return gate.gates.flatMap((g) => evaluateEvidenceGate(g, ledger));
    }
    case 'finding_status': {
      const f = ledger.findings.find((x) => x.id === gate.findingId);
      if (!f) return [`finding ${gate.findingId} not found`];
      if (f.status !== gate.status) return [`finding ${gate.findingId} status=${f.status}, required=${gate.status}`];
      return [];
    }
    case 'event_present': {
      const kind: BughuntEvidenceKind = gate.eventKind;
      const has = ledger.events.some((e) => e.kind === kind);
      return has ? [] : [`no event of kind ${gate.eventKind}`];
    }
    case 'artifact_present': {
      const field = gate.field;
      const has = ledger.findings.some((f) => {
        const v = (f as unknown as Record<string, unknown>)[field];
        return Array.isArray(v) ? v.length > 0 : Boolean(v);
      });
      return has ? [] : [`no finding with non-empty ${field}`];
    }
  }
}

/** bughunt 领域语义注入:依赖须 completed;候选态 planned;额外门为 evidence_gate。 */
function bughuntDeps(ledger: BughuntLedger): DagSchedulerDeps<BughuntDagNode> {
  return {
    isDependencySatisfied: (dep) => dep?.status === 'completed',
    isCandidate: (n) => n.status === 'planned',
    evaluateExtraGate: (n) => {
      if (!n.evidence_gate || typeof n.evidence_gate === 'string') return [];
      // 缺口字符串带 evidence_gate 标签,便于上游 reason 与测试语义匹配。
      return evaluateEvidenceGate(n.evidence_gate, ledger).map((g) => `evidence_gate: ${g}`);
    },
  };
}

/** 节点是否就绪可派发:非终态 + blocked_by 全 completed + evidence_gate 通过。委托通用引擎。 */
export function isDagNodeReady(node: BughuntDagNode, ledger: BughuntLedger): DagNodeReadiness {
  const byId = new Map(ledger.dag.map((n) => [n.id, n]));
  return dagIsNodeReady(node, byId, bughuntDeps(ledger));
}

export interface ReadyDagNode {
  node: BughuntDagNode;
  taskId?: string;
}

/** 就绪候选集(给 Leader 读,不自动 dispatch)。委托通用引擎。 */
export function getReadyDagNodes(ledger: BughuntLedger): ReadyDagNode[] {
  return dagGetReadyNodes(ledger.dag, bughuntDeps(ledger)).map((node) => ({ node, taskId: node.task_id }));
}
