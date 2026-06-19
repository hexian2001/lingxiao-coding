/**
 * DispatcherEngine — 图感知调度引擎
 *
 * 任务从图的态势动态产生，不从角色定义来。
 *
 * 职责：
 *   1. 分析图状态 (analyze)
 *   2. 评估目标完成 (evaluateGoalCompletion)
 */

import type {
  GraphSnapshot,
  GraphNode,
  GraphAnalysis,
} from './types.js';

// ═══════════════════════════════════════════════════════════════
// DispatcherEngine
// ═══════════════════════════════════════════════════════════════

export class DispatcherEngine {

  /**
   * 分析当前图状态，返回结构化分析结果
   */
  analyze(graph: GraphSnapshot): GraphAnalysis {
    const openIntents = graph.nodes.filter(
      n => n.kind === 'intent' && (n.intentStatus === 'open' || n.intentStatus === undefined),
    );

    const blockedIntents = openIntents.filter(intent => {
      const deps = graph.edges.filter(
        e => e.toNodeId === intent.id && e.edgeType === 'depends_on',
      );
      if (deps.length === 0) return false;
      return deps.some(dep => {
        const target = graph.nodes.find(n => n.id === dep.fromNodeId);
        return !target || (target.kind === 'intent' && target.intentStatus !== 'resolved');
      });
    });

    const unresolvedContradictions = graph.edges
      .filter(e => e.edgeType === 'contradicts')
      .map(e => ({
        nodeA: graph.nodes.find(n => n.id === e.fromNodeId)!,
        nodeB: graph.nodes.find(n => n.id === e.toNodeId)!,
      }))
      .filter(pair => pair.nodeA && pair.nodeB);

    const recentFacts = graph.nodes
      .filter(n => n.kind === 'fact')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);

    const knowledgeGaps = this.detectKnowledgeGaps(graph, blockedIntents);
    const completionSignals = this.detectCompletionSignals(graph);

    return {
      openIntents: openIntents.filter(i => !blockedIntents.includes(i)),
      unresolvedContradictions,
      knowledgeGaps,
      blockedIntents,
      recentFacts,
      completionSignals,
    };
  }

  /**
   * 评估目标是否达成
   */
  evaluateGoalCompletion(graph: GraphSnapshot): {
    achieved: boolean;
    remainingGaps: string[];
    summary: string;
  } {
    // ─── Orchestration verdict 收尾：失败的 step 仍未修复时，目标视为未达成 ───
    const verdictFacts = graph.nodes.filter(
      n => n.kind === 'fact' && n.tags.includes('orchestration:verdict'),
    );
    const failedSteps = new Map<string, GraphNode>();
    for (const fact of verdictFacts) {
      const stepTag = fact.tags.find(t => t.startsWith('orchestration:node:'));
      if (!stepTag) continue;
      const isFail = fact.tags.includes('verdict:fail');
      const isPass = fact.tags.includes('verdict:pass');
      if (isFail) {
        failedSteps.set(stepTag, fact);
      } else if (isPass) {
        failedSteps.delete(stepTag);
      }
    }
    if (failedSteps.size > 0) {
      return {
        achieved: false,
        remainingGaps: [...failedSteps.values()].map(f => `${f.id}: ${f.title}`),
        summary: `${failedSteps.size} orchestration node(s) currently FAIL — repair required`,
      };
    }

    const openIntents = graph.nodes.filter(
      n => n.kind === 'intent' && n.intentStatus !== 'resolved',
    );
    const facts = graph.nodes
      .filter(n => n.kind === 'fact')
      .sort((a, b) => b.createdAt - a.createdAt);

    if (openIntents.length === 0 && facts.length > 0) {
      const evidenceSummary = facts
        .slice(0, 5)
        .map(fact => `[${fact.id}] ${fact.title}: ${fact.content}`.slice(0, 220))
        .join(' | ');
      return {
        achieved: true,
        remainingGaps: [],
        summary: `All intents resolved. Evidence facts: ${evidenceSummary}`.slice(0, 800),
      };
    }

    return {
      achieved: false,
      remainingGaps: openIntents.map(i => `${i.id}: ${i.title}`),
      summary: openIntents.length > 0
        ? `${openIntents.length} intents still open.`
        : 'No open intents, but no completion evidence facts.',
    };
  }

  // ───────────────────────────────────────────────────────────
  // Private
  // ───────────────────────────────────────────────────────────

  /**
   * 检测结构化阻塞 — 有 Intent 依赖未解决节点时需要 Reason 重新规划
   */
  private detectKnowledgeGaps(graph: GraphSnapshot, blockedIntents: GraphNode[]): string[] {
    const gaps: string[] = [];

    for (const intent of blockedIntents) {
      const deps = graph.edges.filter(e => e.toNodeId === intent.id && e.edgeType === 'depends_on');
      const unresolved = deps
        .map(dep => graph.nodes.find(n => n.id === dep.fromNodeId) ?? dep.fromNodeId)
        .filter(dep => typeof dep === 'string' || (dep.kind === 'intent' && dep.intentStatus !== 'resolved'));
      if (unresolved.length > 0) {
        gaps.push(`Intent ${intent.id} (${intent.title}) waits for ${unresolved.length} unresolved dependenc${unresolved.length === 1 ? 'y' : 'ies'}`);
      }
    }

    return gaps;
  }

  /**
   * 检测结构化完成信号
   */
  private detectCompletionSignals(graph: GraphSnapshot): string[] {
    const signals: string[] = [];

    const verdictFacts = graph.nodes.filter(
      n => n.kind === 'fact' && n.tags.includes('orchestration:verdict'),
    );
    if (verdictFacts.length > 0 && !verdictFacts.some(n => n.tags.includes('verdict:fail'))) {
      signals.push('All orchestration verdict facts are pass/neutral');
    }

    const openCount = graph.nodes.filter(
      n => n.kind === 'intent' && n.intentStatus !== 'resolved',
    ).length;

    if (openCount === 0 && graph.nodes.filter(n => n.kind === 'fact').length > 0) {
      signals.push('No open intents remaining');
    }

    return signals;
  }
}
