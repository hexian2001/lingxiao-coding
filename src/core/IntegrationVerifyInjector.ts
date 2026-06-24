/**
 * IntegrationVerifyInjector — 集成验证自动编排
 *
 * 在 DAG 中检测"多个并行 implement 节点无共同下游验证"的模式，
 * 自动建议插入 integration_verify 节点。
 *
 * 触发条件：
 * - 存在 2+ 个 implement 节点共享同一 contract surface 但无共同 evaluate 后继
 * - 存在 2+ 个 implement 节点的 write_scope 有交集（可能产生集成冲突）
 * - 前后端并行实现但没有端到端验证节点
 *
 * 产出：
 * - 建议的 verify 节点定义（subject, description, blocked_by, agent_type）
 * - 验证场景清单（从 contract 推导）
 */

import type { Task } from './TaskBoard.js';
import type { SharedLedger, LedgerEntry } from './SharedLedger.js';

export interface VerifyInjection {
  /** 是否需要注入集成验证 */
  needed: boolean;
  /** 原因说明 */
  reason: string;
  /** 建议的验证节点 */
  verifyNode?: {
    subject: string;
    description: string;
    agentType: string;
    blockedBy: string[];
    /** 验证场景清单 */
    scenarios: VerifyScenario[];
  };
}

export interface VerifyScenario {
  /** 场景 ID */
  id: string;
  /** 场景描述 */
  description: string;
  /** 涉及的 contract surface */
  contractSurface?: string;
  /** 验证类型 */
  type: 'api_call' | 'browser_check' | 'build_test' | 'e2e_flow';
  /** 建议的验证命令/步骤 */
  steps: string[];
}

export interface DAGNode {
  id: string;
  nodeKind?: string;
  agentType?: string;
  writeScope?: string[];
  blockedBy?: string[];
  status?: string;
  contractSurface?: string;
}

export class IntegrationVerifyInjector {
  /**
   * 分析当前 DAG，决定是否需要注入集成验证节点
   */
  analyze(tasks: DAGNode[], ledger?: SharedLedger): VerifyInjection {
    const implementNodes = tasks.filter(
      t => t.nodeKind === 'implement' && t.status !== 'cancelled',
    );

    if (implementNodes.length < 2) {
      return { needed: false, reason: 'less than 2 implement nodes' };
    }

    // 检查是否已有覆盖所有 implement 的 evaluate/verify 节点
    const evaluateNodes = tasks.filter(
      t => (t.nodeKind === 'evaluate' || t.agentType === 'evaluator' || t.agentType === 'verify'),
    );
    const allImplIds = new Set(implementNodes.map(n => n.id));
    const coveredByEval = evaluateNodes.some(ev => {
      const deps = new Set(ev.blockedBy || []);
      return [...allImplIds].every(id => deps.has(id));
    });
    if (coveredByEval) {
      return { needed: false, reason: 'existing evaluate node covers all implement nodes' };
    }

    // 检测并行模式
    const parallelGroups = this.detectParallelGroups(implementNodes);
    if (parallelGroups.length === 0) {
      return { needed: false, reason: 'no parallel implement groups detected' };
    }

    // 检测跨层模式（前后端并行）
    const crossLayerGroup = this.findCrossLayerGroup(parallelGroups);
    const scenarios = this.buildScenarios(crossLayerGroup || parallelGroups[0], ledger);

    const blockedBy = (crossLayerGroup || parallelGroups[0]).map(n => n.id);
    return {
      needed: true,
      reason: crossLayerGroup
        ? `cross-layer parallel: ${crossLayerGroup.map(n => n.agentType).join('+')}`
        : `parallel implement group: ${blockedBy.length} nodes`,
      verifyNode: {
        subject: `集成验证: ${blockedBy.length} 个并行实现节点`,
        description: this.buildVerifyDescription(scenarios),
        agentType: 'verify',
        blockedBy,
        scenarios,
      },
    };
  }

  /**
   * 检测共享相同 blockedBy（同一 contract）的并行 implement 组
   */
  private detectParallelGroups(nodes: DAGNode[]): DAGNode[][] {
    // 按 blockedBy 签名分组
    const groups = new Map<string, DAGNode[]>();
    for (const node of nodes) {
      const key = (node.blockedBy || []).sort().join(',') || '__root__';
      const group = groups.get(key) || [];
      group.push(node);
      groups.set(key, group);
    }
    // 只返回 size >= 2 的组
    return [...groups.values()].filter(g => g.length >= 2);
  }

  /**
   * 找到前后端并行的组
   */
  private findCrossLayerGroup(groups: DAGNode[][]): DAGNode[] | null {
    for (const group of groups) {
      const roles = new Set(group.map(n => n.agentType));
      const hasFe = roles.has('frontend') || roles.has('fe');
      const hasBe = roles.has('backend') || roles.has('be');
      if (hasFe && hasBe) return group;
    }
    return null;
  }

  /**
   * 从 SharedLedger 的 contract 条目推导验证场景
   */
  private buildScenarios(group: DAGNode[], ledger?: SharedLedger): VerifyScenario[] {
    const scenarios: VerifyScenario[] = [];

    // 从 ledger 获取相关 contract
    if (ledger) {
      const contracts = ledger.getActiveContracts();
      for (const contract of contracts.slice(0, 5)) {
        scenarios.push(this.contractToScenario(contract));
      }
    }

    // 基于节点角色类型推导通用场景
    const roles = new Set(group.map(n => n.agentType));
    if (roles.has('frontend') || roles.has('fe')) {
      scenarios.push({
        id: 'browser-smoke',
        description: '浏览器冒烟测试：打开主要页面，验证渲染和基本交互',
        type: 'browser_check',
        steps: ['启动开发服务器', '浏览器打开首页', '检查关键元素存在', '截图对比'],
      });
    }
    if (roles.has('backend') || roles.has('be')) {
      scenarios.push({
        id: 'api-health',
        description: 'API 健康检查：验证主要 endpoint 可达且返回正确 schema',
        type: 'api_call',
        steps: ['启动后端服务', '请求 /health 或主要 endpoint', '验证 status code', '验证 response schema'],
      });
    }
    if ((roles.has('frontend') || roles.has('fe')) && (roles.has('backend') || roles.has('be'))) {
      scenarios.push({
        id: 'e2e-flow',
        description: '端到端流程：前端发起请求 → 后端处理 → 前端展示结果',
        type: 'e2e_flow',
        steps: ['同时启动前后端', '浏览器执行核心用户流程', '验证数据从前端到后端再回来'],
      });
    }

    // 构建检查
    scenarios.push({
      id: 'build-check',
      description: '构建检查：确保所有模块可以同时编译通过',
      type: 'build_test',
      steps: ['运行 tsc --noEmit 或对应构建命令', '检查无类型错误', '检查无 lint 错误'],
    });

    return scenarios;
  }

  /**
   * 将 contract 条目转换为验证场景
   */
  private contractToScenario(contract: LedgerEntry): VerifyScenario {
    const isApi = /^(GET|POST|PUT|DELETE|PATCH)\s/i.test(contract.surface);
    return {
      id: `contract-${contract.id}`,
      description: `验证契约: ${contract.surface}`,
      contractSurface: contract.surface,
      type: isApi ? 'api_call' : 'build_test',
      steps: isApi
        ? [`请求 ${contract.surface}`, '验证 response 符合契约定义', '验证错误码处理']
        : [`检查 ${contract.surface} 的实现是否符合契约`, '运行相关单元测试'],
    };
  }

  private buildVerifyDescription(scenarios: VerifyScenario[]): string {
    const lines = [
      '集成验证：确认所有并行实现节点的产出可以协同工作。',
      '',
      '验证场景：',
    ];
    for (const s of scenarios) {
      lines.push(`- [${s.type}] ${s.description}`);
      for (const step of s.steps) {
        lines.push(`  → ${step}`);
      }
    }
    lines.push('', '验收标准：所有场景 PASS 才算通过。');
    return lines.join('\n');
  }
}
