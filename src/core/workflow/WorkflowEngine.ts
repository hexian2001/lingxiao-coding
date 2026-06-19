/**
 * WorkflowEngine - Workflow 执行引擎
 * 
 * 职责：
 * - 执行 workflow
 * - 管理执行状态
 * - 调度节点执行
 * - 处理错误和重试
 */

import { randomUUID } from 'crypto';
import { ExecutionGraph } from './ExecutionGraph.js';
import { VariableResolver } from './VariableResolver.js';
import { buildVariableScope } from './variableScope.js';
import { evaluateExpression } from './expressionEvaluator.js';
import { auditModeEvent } from '../ModeAudit.js';
import { AgentNodeExecutor, type WorkflowAgentExecutor } from './executors/AgentNodeExecutor.js';
import { ToolNodeExecutor } from './executors/ToolNodeExecutor.js';
import { ConditionNodeExecutor } from './executors/ConditionNodeExecutor.js';
import { DataNodeExecutor } from './executors/DataNodeExecutor.js';
import { ParallelNodeExecutor } from './executors/ParallelNodeExecutor.js';
import type { BaseNodeExecutor } from './executors/BaseNodeExecutor.js';
import type {
  WorkflowDefinition,
  NodeDefinition,
  EdgeDefinition,
  ExecutionContext,
  ExecutionOptions,
  ExecutionResult,
  NodeExecutionState,
  NodeInput
} from './types.js';
import type { DatabaseManager } from '../Database.js';
import type { EventEmitter } from '../EventEmitter.js';
import type { ToolRegistryContract } from '../../contracts/types/Tool.js';
import type { WorkflowRealtimeEventName } from '../../contracts/types/Workflow.js';
import type { WorkflowManager } from './WorkflowManager.js';
import type { BlackboardGraph } from '../blackboard/BlackboardGraph.js';

export interface WorkflowEngineDeps {
  db: DatabaseManager;
  toolRegistry: ToolRegistryContract;
  eventEmitter: EventEmitter;
  workflowManager?: WorkflowManager;
  agentExecutor?: WorkflowAgentExecutor;
  blackboardGraph?: BlackboardGraph | (() => BlackboardGraph | null | undefined);
  maxExecutionHistory?: number;
}

const MAX_EXECUTION_HISTORY = 100;

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : undefined;
}

export class WorkflowEngine {
  private db: DatabaseManager;
  private toolRegistry: ToolRegistryContract;
  private eventEmitter: EventEmitter;
  private variableResolver: VariableResolver;
  private executors: Map<string, BaseNodeExecutor>;
  private activeExecutions: Map<string, ExecutionContext>;
  private executionHistory: Map<string, ExecutionContext>;
  private workflowManager: WorkflowManager | null;
  private agentExecutor?: WorkflowAgentExecutor;
  private blackboardGraphProvider?: BlackboardGraph | (() => BlackboardGraph | null | undefined);
  private maxExecutionHistory: number;
  private workflowCache: Map<string, WorkflowDefinition>;

  constructor(deps: WorkflowEngineDeps) {
    this.db = deps.db;
    this.toolRegistry = deps.toolRegistry;
    this.eventEmitter = deps.eventEmitter;
    this.variableResolver = new VariableResolver();
    this.executors = new Map();
    this.activeExecutions = new Map();
    this.executionHistory = new Map();
    this.workflowManager = deps.workflowManager || null;
    this.agentExecutor = deps.agentExecutor;
    this.blackboardGraphProvider = deps.blackboardGraph;
    this.workflowCache = new Map();
    this.maxExecutionHistory = deps.maxExecutionHistory ?? MAX_EXECUTION_HISTORY;

    this.initializeExecutors();
  }

  /**
   * 设置 WorkflowManager（延迟注入）
   */
  setWorkflowManager(manager: WorkflowManager): void {
    this.workflowManager = manager;
  }

  setBlackboardGraphProvider(provider: BlackboardGraph | (() => BlackboardGraph | null | undefined) | undefined): void {
    this.blackboardGraphProvider = provider;
  }

  private getBlackboardGraph(): BlackboardGraph | undefined {
    const provider = this.blackboardGraphProvider;
    if (!provider) return undefined;
    return typeof provider === 'function' ? provider() ?? undefined : provider;
  }

  private attachRuntimeServices(context: ExecutionContext): ExecutionContext {
    context.db = this.db;
    context.emitter = this.eventEmitter;
    context.workflowManager = this.workflowManager ?? undefined;
    context.workflowEngine = this;
    context.blackboardGraph = this.getBlackboardGraph();
    return context;
  }

  setAgentExecutor(executor: WorkflowAgentExecutor): void {
    this.agentExecutor = executor;
    this.initializeExecutors();
  }

  /**
   * 返回 WorkflowEngine 使用的 ToolRegistry（用于 web UI/工具列举）。
   */
  getToolRegistry(): ToolRegistryContract {
    return this.toolRegistry;
  }

  /**
   * 初始化节点执行器
   */
  private initializeExecutors(): void {
    this.executors.set('agent', new AgentNodeExecutor(this.agentExecutor));
    this.executors.set('tool', new ToolNodeExecutor(this.toolRegistry));
    const dataExecutor = new DataNodeExecutor(this.toolRegistry);
    for (const type of ['template', 'variable_assigner', 'variable_aggregator', 'list_operator', 'http_request', 'json_extractor']) {
      this.executors.set(type, dataExecutor);
    }
    this.executors.set('condition', new ConditionNodeExecutor(this.agentExecutor));
    this.executors.set('parallel', new ParallelNodeExecutor({
      getWorkflow: (context) => {
        const workflow = this.workflowCache.get(context.workflowId);
        if (!workflow) throw new Error(`Workflow not found in execution cache: ${context.workflowId}`);
        return workflow;
      },
      executeNode: (workflow, context, nodeId) => this.executeNode(workflow, context, nodeId),
      collectParallelBodyNodeIds: (workflow, parallelNodeId) => this.collectParallelBodyNodeIds(workflow, parallelNodeId),
      shouldStopExecution: (context) => this.shouldStopExecution(context),
      selectConditionEdges: (edges, result) => this.selectConditionEdges(edges, result),
      dependenciesSatisfiedWithin: (nodeId, workflow, completed, allowedNodes) => this.dependenciesSatisfiedWithin(nodeId, workflow, completed, allowedNodes),
    }));
  }

  /**
   * 执行单个节点（Canvas 右键 Run 的后端入口）。
   *
   * 与完整 workflow 执行不同：
   * - 不从 DB 加载 workflow，接收已有的 node 定义与 sessionId
   * - 不触发前驱/后继节点，只跑当前节点
   * - 失败抛出错误（调用方负责标记节点 UI 状态）
   *
   * 支持 input/output/tool/condition/parallel/loop/agent/leader/start
   * 其中 parallel/loop 对单节点运行意义有限，此处按节点自身 input 直跑单次。
   */
  async executeSingleNode(params: {
    node: NodeDefinition;
    sessionId: string;
    workflowId?: string;
    input?: Record<string, unknown>;
    variables?: Record<string, unknown>;
  }): Promise<unknown> {
    const { node, sessionId, input, variables } = params;
    const workflowId = params.workflowId?.trim() || `__single_node__${node.id}`;

    const context = this.attachRuntimeServices({
      workflowId,
      executionId: randomUUID(),
      sessionId,
      status: 'running',
      startTime: Date.now(),
      variables: new Map(Object.entries(variables ?? {})),
      nodeExecutions: new Map(),
      logs: [],
    });

    const effectiveInput: Record<string, unknown> = input ?? {};
    const nodeType = node.data.type;
    const baseEvent = {
      workflowId: context.workflowId,
      executionId: context.executionId,
      sessionId: context.sessionId,
      reason: 'single_node',
    };

    this.emitEvent('workflow:execution_started', {
      ...baseEvent,
      startTime: context.startTime,
      nodeCount: 1,
    });
    this.emitEvent('workflow:node_started', {
      ...baseEvent,
      nodeId: node.id,
      startTime: context.startTime,
    });

    try {
      let result: unknown;
      switch (nodeType) {
        case 'start':
        case 'schedule_trigger':
        case 'input':
          result = effectiveInput;
          break;

        case 'output':
          context.variables.set('__output__', effectiveInput);
          result = effectiveInput;
          break;

        case 'leader':
        case 'agent': {
          const executor = this.executors.get('agent');
          if (!executor) throw new Error('agent executor not initialized');
          result = await executor.execute(node, effectiveInput, context);
          break;
        }

        case 'tool':
        case 'condition':
        case 'template':
        case 'variable_assigner':
        case 'variable_aggregator':
        case 'list_operator':
        case 'http_request':
        case 'json_extractor': {
          const executor = this.executors.get(nodeType);
          if (!executor) throw new Error(`No executor for node type: ${nodeType}`);
          result = await executor.execute(node, effectiveInput, context);
          break;
        }

        case 'parallel':
        case 'loop':
          // 单节点模式下无法遍历 workflow 结构；上层应传完整 workflow 走 execute()。
          throw new Error(`Node type ${nodeType} cannot be executed in isolation; use execute() with full workflow`);

        default:
          throw new Error(`Unknown node type: ${nodeType}`);
      }

      context.status = 'completed';
      context.endTime = Date.now();
      this.emitEvent('workflow:node_completed', {
        ...baseEvent,
        nodeId: node.id,
        result,
        startTime: context.startTime,
        endTime: context.endTime,
        duration: context.endTime - context.startTime,
      });
      this.emitEvent('workflow:execution_completed', {
        ...baseEvent,
        output: result,
        startTime: context.startTime,
        endTime: context.endTime,
        duration: context.endTime - context.startTime,
      });
      return result;
    } catch (error) {
      context.status = 'failed';
      context.error = error instanceof Error ? error.message : String(error);
      context.endTime = Date.now();
      this.emitEvent('workflow:node_failed', {
        ...baseEvent,
        nodeId: node.id,
        error: context.error,
        startTime: context.startTime,
        endTime: context.endTime,
        duration: context.endTime - context.startTime,
        reason: 'single_node_error',
      });
      this.emitEvent('workflow:execution_failed', {
        ...baseEvent,
        error: context.error,
        startTime: context.startTime,
        endTime: context.endTime,
        duration: context.endTime - context.startTime,
        reason: 'single_node_error',
      });
      throw error;
    }
  }

  /**
   * 执行 workflow
   */
  async execute(
    workflowId: string,
    input?: Record<string, unknown>,
    options?: ExecutionOptions
  ): Promise<string> {
    // 加载 workflow 定义
    const workflow = await this.loadWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const sessionId = normalizeSessionId(options?.sessionId) ?? normalizeSessionId(workflow.config.sessionId);
    if (!sessionId) {
      throw new Error(`sessionId is required to execute workflow: ${workflowId}`);
    }

    // 创建执行上下文
    const executionId = randomUUID();
    const context = this.attachRuntimeServices({
      workflowId,
      executionId,
      sessionId,
      status: 'running',
      startTime: Date.now(),
      variables: new Map(),
      nodeExecutions: new Map(),
      logs: []
    });

    // 初始化变量
    this.initializeVariables(context, workflow, input, options);

    // 保存到活动执行列表
    this.activeExecutions.set(executionId, context);
    this.workflowCache.set(workflowId, workflow);

    // 发送开始事件
    this.emitEvent('workflow:execution_started', {
      executionId,
      workflowId,
      sessionId: context.sessionId,
      startTime: context.startTime,
      nodeCount: workflow.nodes.length,
    });

    // 应用超时：优先使用 options.timeout（毫秒），否则 workflow.config.maxExecutionTime（秒）
    // maxExecutionTime 为 0 表示不限时，仅在显式 >0 时才强制
    const timeoutMs = options?.timeout
      ?? (workflow.config.maxExecutionTime && workflow.config.maxExecutionTime > 0
        ? workflow.config.maxExecutionTime * 1000
        : undefined);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (context.status === 'running' || context.status === 'paused') {
          context.status = 'failed';
          context.error = `Execution timeout after ${timeoutMs}ms`;
          context.endTime = Date.now();
          this.emitEvent('workflow:execution_failed', {
            executionId,
            workflowId,
            sessionId: context.sessionId,
            timeoutMs,
            error: context.error,
            startTime: context.startTime,
            endTime: context.endTime,
            duration: context.endTime - context.startTime,
            reason: 'timeout',
          });
        }
      }, timeoutMs);
    }

    // 异步执行
    this.runWorkflow(workflow, context)
      .then(() => {
        if (context.status === 'failed') {
          // runWorkflow 提前被超时/取消终止，不要再覆盖状态
          if (this.isExecutionTimeout(context)) {
            return;
          }
          this.emitEvent('workflow:execution_failed', {
            executionId,
            workflowId,
            sessionId: context.sessionId,
            error: context.error,
            endTime: context.endTime,
            reason: 'execution_failed',
          });
          return;
        }
        if (context.status !== 'running') {
          return;
        }
        context.status = 'completed';
        context.endTime = Date.now();
        this.emitEvent('workflow:execution_completed', {
          executionId,
          workflowId,
          sessionId: context.sessionId,
          output: context.variables.get('__output__'),
          startTime: context.startTime,
          endTime: context.endTime,
          duration: context.endTime - context.startTime,
        });
      })
      .catch((error) => {
        if (this.isExecutionTimeout(context)) {
          return;
        }
        this.handleExecutionError(context, error);
      })
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.storeExecutionHistory(executionId, context);
        // paused 的执行保留在 activeExecutions 中，以便 resume() 可以找到并恢复
        if (context.status !== 'paused') {
          this.activeExecutions.delete(executionId);
          this.workflowCache.delete(workflowId);
        }
        this.saveExecution(context).catch(err => {
          console.error('Failed to save execution:', err);
        });
      });

    return executionId;
  }

  /**
   * 初始化变量
   */
  private initializeVariables(
    context: ExecutionContext,
    workflow: WorkflowDefinition,
    input?: Record<string, unknown>,
    options?: ExecutionOptions
  ): void {
    // 全局变量
    if (workflow.config.variables) {
      for (const [key, value] of Object.entries(workflow.config.variables)) {
        context.variables.set(key, value);
      }
    }

    // 选项覆盖
    if (options?.variables) {
      for (const [key, value] of Object.entries(options.variables)) {
        context.variables.set(key, value);
      }
    }
    if (options?.maxIterations !== undefined) {
      context.variables.set('__maxIterations__', options.maxIterations);
    }

    // 输入数据
    if (input) {
      context.variables.set('__input__', input);
    }

    // 上下文信息
    context.variables.set('__context__', {
      workflowId: context.workflowId,
      executionId: context.executionId,
      sessionId: context.sessionId,
      startTime: context.startTime
    });
  }

  /**
   * 运行 workflow
   */
  private async runWorkflow(
    workflow: WorkflowDefinition,
    context: ExecutionContext
  ): Promise<void> {
    // 构建执行图
    const graph = new ExecutionGraph(workflow);

    // 验证图
    const validation = graph.validate();
    if (!validation.valid) {
      throw new Error(`Invalid workflow: ${validation.errors.join(', ')}`);
    }

    const startNodes = graph.getStartNodes();
    const completed = new Set<string>();
    const skipped = new Set<string>();
    const queued = new Set<string>(startNodes);
    const queue = [...startNodes];

    this.log(context, 'info', '', `Executing workflow from ${startNodes.length} start nodes`);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      queued.delete(nodeId);

      if (completed.has(nodeId) || skipped.has(nodeId)) {
        continue;
      }

      if (this.shouldStopExecution(context)) {
        break;
      }

      await this.executeNode(workflow, context, nodeId);
      completed.add(nodeId);

      // 超时/取消：executeNode 完成后再次检查，防止节点内新触发的中止状态被下一轮循环吞掉
      // (context.status 可能被 timeout 回调异步改为 'failed')
      if (this.shouldStopExecution(context)) {
        break;
      }

      const node = workflow.nodes.find(n => n.id === nodeId);
      if (node?.data.type === 'loop') {
        for (const bodyNodeId of this.collectLoopBodyNodeIds(workflow, nodeId)) {
          completed.add(bodyNodeId);
        }
      }
      if (node?.data.type === 'parallel') {
        for (const bodyNodeId of this.collectParallelBodyNodeIds(workflow, nodeId)) {
          completed.add(bodyNodeId);
        }
      }

      const result = context.nodeExecutions.get(nodeId)?.result;
      const outgoingEdges = workflow.edges.filter(edge => edge.source === nodeId);
      const activeEdges = node?.data.type === 'condition'
        ? this.selectConditionEdges(outgoingEdges, result)
        : outgoingEdges.filter(edge => edge.data?.type !== 'data' && edge.data?.type !== 'loop' && !(node?.data.type === 'parallel' && this.isParallelBodyEntryEdge(workflow, edge)));
      const activeTargets = new Set(activeEdges.map(edge => edge.target));

      if (node?.data.type === 'condition') {
        for (const edge of outgoingEdges) {
          if (!activeTargets.has(edge.target)) {
            this.skipInactiveBranch(workflow, context, edge.target, skipped, activeTargets, completed, true);
          }
        }
      }

      for (const edge of activeEdges) {
        if (!queued.has(edge.target) && !completed.has(edge.target) && !skipped.has(edge.target) && this.dependenciesSatisfied(workflow, edge.target, completed, skipped)) {
          queue.push(edge.target);
          queued.add(edge.target);
        }
      }

      for (const candidate of workflow.nodes) {
        if (!queued.has(candidate.id) && !completed.has(candidate.id) && !skipped.has(candidate.id) && this.dependenciesSatisfied(workflow, candidate.id, completed, skipped)) {
          queue.push(candidate.id);
          queued.add(candidate.id);
        }
      }
    }

    // 设置输出
    const outputNodes = workflow.nodes.filter(n => n.data.type === 'output');
    if (outputNodes.length > 0) {
      const outputNode = outputNodes[0];
      const execution = context.nodeExecutions.get(outputNode.id);
      if (execution) {
        context.variables.set('__output__', execution.result);
      }
    }
  }

  private selectConditionEdges(edges: WorkflowDefinition['edges'], result: unknown): WorkflowDefinition['edges'] {
    const conditionResult = Boolean(result);
    const conditionEdges = edges.filter(edge => edge.data?.type === 'condition');
    if (conditionEdges.length === 0) {
      return edges.filter(edge => edge.data?.type !== 'data');
    }
    return conditionEdges.filter(edge => edge.data?.conditionValue === conditionResult);
  }

  private dependenciesSatisfied(
    workflow: WorkflowDefinition,
    nodeId: string,
    completed: Set<string>,
    skipped: Set<string>
  ): boolean {
    const inputEdges = workflow.edges.filter(edge => edge.target === nodeId && edge.data?.type !== 'data');
    if (inputEdges.length === 0) {
      return true;
    }
    return inputEdges.every(edge => completed.has(edge.source) || skipped.has(edge.source));
  }

  private skipInactiveBranch(
    workflow: WorkflowDefinition,
    context: ExecutionContext,
    nodeId: string,
    skipped: Set<string>,
    activeTargets: Set<string>,
    completed: Set<string>,
    force = false
  ): void {
    if (skipped.has(nodeId) || context.nodeExecutions.has(nodeId) || activeTargets.has(nodeId)) {
      return;
    }

    const incomingControlEdges = workflow.edges.filter(edge => edge.target === nodeId && edge.data?.type !== 'data');
    if (!force && incomingControlEdges.some(edge => activeTargets.has(edge.source) || completed.has(edge.source))) {
      return;
    }

    skipped.add(nodeId);
    context.nodeExecutions.set(nodeId, {
      nodeId,
      status: 'skipped',
      startTime: Date.now(),
      endTime: Date.now(),
      retryCount: 0,
      logs: []
    });
    const skippedExecution = context.nodeExecutions.get(nodeId);
    this.emitEvent('workflow:node_skipped', {
      nodeId,
      workflowId: context.workflowId,
      executionId: context.executionId,
      sessionId: context.sessionId,
      startTime: skippedExecution?.startTime,
      endTime: skippedExecution?.endTime,
      reason: 'condition_branch_skipped',
    });

    for (const edge of workflow.edges.filter(edge => edge.source === nodeId && edge.data?.type !== 'data')) {
      this.skipInactiveBranch(workflow, context, edge.target, skipped, activeTargets, completed);
    }
  }

  private collectSubgraphNodeIds(
    workflow: WorkflowDefinition,
    sourceNodeId: string,
    bodyEdgeType: 'loop' | 'sequence'
  ): Set<string> {
    const body = new Set<string>();
    const exits = new Set(workflow.edges
      .filter(edge => edge.source === sourceNodeId && edge.data?.type !== bodyEdgeType && edge.data?.type !== 'data')
      .map(edge => edge.target));
    const queue = workflow.edges
      .filter(edge => edge.source === sourceNodeId && edge.data?.type === bodyEdgeType)
      .map(edge => edge.target);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (nodeId === sourceNodeId || exits.has(nodeId) || body.has(nodeId)) {
        continue;
      }
      body.add(nodeId);
      for (const edge of workflow.edges.filter(edge => edge.source === nodeId && edge.data?.type !== 'data')) {
        queue.push(edge.target);
      }
    }

    return body;
  }

  private collectLoopBodyNodeIds(workflow: WorkflowDefinition, loopNodeId: string): Set<string> {
    return this.collectSubgraphNodeIds(workflow, loopNodeId, 'loop');
  }

  private collectParallelBodyNodeIds(workflow: WorkflowDefinition, parallelNodeId: string): Set<string> {
    return this.collectSubgraphNodeIds(workflow, parallelNodeId, 'sequence');
  }

  private isParallelBodyEntryEdge(workflow: WorkflowDefinition, edge: EdgeDefinition): boolean {
    if (edge.data?.type !== 'sequence') {
      return false;
    }
    const source = workflow.nodes.find(node => node.id === edge.source);
    if (source?.data.type !== 'parallel') {
      return false;
    }
    return this.collectParallelBodyNodeIds(workflow, edge.source).has(edge.target);
  }

  private shouldStopExecution(context: ExecutionContext): boolean {
    return context.status === 'paused' || context.status === 'failed' || context.status === 'cancelled';
  }

  private isExecutionTimeout(context: ExecutionContext): boolean {
    return context.status === 'failed' && context.error?.startsWith('Execution timeout after ') === true;
  }

  private async executeLoopNode(
    workflow: WorkflowDefinition,
    context: ExecutionContext,
    nodeId: string,
    input: Record<string, unknown>
  ): Promise<unknown[]> {
    const node = workflow.nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const bodyEntryEdges = workflow.edges.filter(edge => edge.source === nodeId && edge.data?.type === 'loop');
    if (bodyEntryEdges.length === 0) {
      throw new Error(`Loop node ${nodeId} has no loop body edge`);
    }

    const bodyNodeIds = this.collectLoopBodyNodeIds(workflow, nodeId);
    if (bodyNodeIds.size === 0) {
      throw new Error(`Loop node ${nodeId} has no executable body`);
    }

    const config = node.data.config;
    const iterations = config.loopType === 'while' ? undefined : this.resolveLoopIterations(node, input, context);
    const maxWhileIterations = config.maxIterations ?? (context.variables.get('__maxIterations__') as number | undefined) ?? 1000;
    const results: unknown[] = [];
    const loopVariableKeys = [`${nodeId}.index`, 'loop.index', 'loop.item', 'loop.length', 'loop'];
    const previousLoopVariables = new Map(loopVariableKeys.map(key => [key, context.variables.get(key)]));
    const hadLoopVariables = new Set(loopVariableKeys.filter(key => context.variables.has(key)));

    try {
      for (let i = 0; ; i++) {
        if (config.loopType === 'while' && i >= maxWhileIterations) {
          throw new Error(`Loop iteration limit exceeded: ${maxWhileIterations}`);
        }
        if (iterations && i >= iterations.length) {
          break;
        }

        const item = iterations ? iterations[i] : i;
        const length = iterations ? iterations.length : maxWhileIterations;
        context.variables.set(`${nodeId}.index`, i);
        context.variables.set('loop.index', i);
        context.variables.set('loop.item', item);
        context.variables.set('loop.length', length);
        context.variables.set('loop', { index: i, item, length });

        if (config.loopType === 'while') {
          if (!config.loopCondition) {
            throw new Error(`Loop condition is required for while loop node ${nodeId}`);
          }
          if (!this.evaluateLoopCondition(config.loopCondition, input, context)) {
            break;
          }
        }

        const iterationResults: Record<string, unknown> = {};
        const completedBody = new Set<string>([nodeId]);
        const queue = bodyEntryEdges.map(edge => edge.target);
        const queued = new Set(queue);

        while (queue.length > 0) {
          if (this.shouldStopExecution(context)) {
            break;
          }

          const bodyNodeId = queue.shift()!;
          queued.delete(bodyNodeId);
          if (!bodyNodeIds.has(bodyNodeId) || completedBody.has(bodyNodeId)) {
            continue;
          }

          await this.executeNode(workflow, context, bodyNodeId);
          if (this.shouldStopExecution(context)) {
            break;
          }
          completedBody.add(bodyNodeId);
          iterationResults[bodyNodeId] = context.nodeExecutions.get(bodyNodeId)?.result;

          const bodyNode = workflow.nodes.find(n => n.id === bodyNodeId);
          const bodyResult = context.nodeExecutions.get(bodyNodeId)?.result;
          const outgoingEdges = workflow.edges.filter(edge => edge.source === bodyNodeId && edge.data?.type !== 'data');
          const activeEdges = bodyNode?.data.type === 'condition'
            ? this.selectConditionEdges(outgoingEdges, bodyResult)
            : outgoingEdges;

          for (const edge of activeEdges) {
            if (bodyNodeIds.has(edge.target) && !queued.has(edge.target) && !completedBody.has(edge.target) && this.dependenciesSatisfiedWithin(edge.target, workflow, completedBody, bodyNodeIds)) {
              queue.push(edge.target);
              queued.add(edge.target);
            }
          }
        }

        results.push(iterationResults);
      }
    } finally {
      for (const key of loopVariableKeys) {
        if (hadLoopVariables.has(key)) {
          context.variables.set(key, previousLoopVariables.get(key));
        } else {
          context.variables.delete(key);
        }
      }
    }
    return results;
  }

  private dependenciesSatisfiedWithin(
    nodeId: string,
    workflow: WorkflowDefinition,
    completed: Set<string>,
    allowedNodes: Set<string>
  ): boolean {
    const inputEdges = workflow.edges.filter(edge => edge.target === nodeId && edge.data?.type !== 'data' && (allowedNodes.has(edge.source) || completed.has(edge.source)));
    return inputEdges.every(edge => completed.has(edge.source));
  }

  private resolveLoopIterations(node: NodeDefinition, input: Record<string, unknown>, context: ExecutionContext): unknown[] {
    const config = node.data.config;
    if (config.loopType === 'count') {
      const count = config.loopCount ?? 1;
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Loop count must be a non-negative integer for node ${node.id}`);
      }
      return Array.from({ length: count }, (_, index) => index);
    }

    if (config.loopType === 'foreach') {
      if (!config.loopItems) {
        throw new Error(`Loop items is required for foreach loop node ${node.id}`);
      }
      const items = this.resolveLoopItems(config.loopItems, input, context);
      if (!Array.isArray(items)) {
        throw new Error(`Loop items must resolve to an array for node ${node.id}`);
      }
      return items;
    }

    if (config.loopType === 'while') {
      if (!config.loopCondition) {
        throw new Error(`Loop condition is required for while loop node ${node.id}`);
      }
      return [];
    }

    throw new Error(`Unknown loop type: ${config.loopType}`);
  }

  private resolveLoopItems(reference: string, input: Record<string, unknown>, context: ExecutionContext): unknown {
    const expressionMatch = reference.match(/^\$\{(.+)\}$/);
    const path = expressionMatch ? expressionMatch[1] : reference;
    if (path === 'input') return input;
    if (path.startsWith('input.')) return this.getPathValue(input, path.slice('input.'.length));
    if (path === 'variables') return Object.fromEntries(context.variables);
    if (path.startsWith('variables.')) return context.variables.get(path.slice('variables.'.length));
    return context.variables.get(path) ?? reference;
  }

  private evaluateLoopCondition(condition: string, input: Record<string, unknown>, context: ExecutionContext): boolean {
    const variables = Object.fromEntries(context.variables);
    // 安全说明见 `src/core/workflow/expressionEvaluator.ts` 模块级注释。
    return evaluateExpression(condition, { input, variables, Math, Date, JSON });
  }

  /**
   * 执行单个节点
   */
  private async executeNode(
    workflow: WorkflowDefinition,
    context: ExecutionContext,
    nodeId: string
  ): Promise<void> {
    const node = workflow.nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const nodeData = node.data;
    const execution: NodeExecutionState = {
      nodeId,
      status: 'running',
      startTime: Date.now(),
      retryCount: 0,
      logs: []
    };

    context.nodeExecutions.set(nodeId, execution);
    this.emitEvent('workflow:node_started', {
      nodeId,
      workflowId: context.workflowId,
      executionId: context.executionId,
      sessionId: context.sessionId,
      startTime: execution.startTime,
    });

    const maxRetries = nodeData.config.retryCount ?? 0;
    const retryDelay = nodeData.config.retryDelay ?? 1000;

    // 重试循环：失败后重试 maxRetries 次，总共最多执行 maxRetries + 1 次
    // 之前的版本用递归调用 executeNode 实现重试，递归会重置 retryCount=0
    // 造成只要持续失败就会无限重试，这里改成显式循环。
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      execution.retryCount = attempt;
      if (attempt > 0) {
        execution.status = 'running';
        execution.startTime = Date.now();
        execution.endTime = undefined;
        execution.error = undefined;
        this.log(context, 'info', nodeId, `Retrying in ${retryDelay}ms (attempt ${attempt}/${maxRetries})`);
        await this.delay(retryDelay);
        if (this.shouldStopExecution(context)) {
          return;
        }
        this.emitEvent('workflow:node_retrying', {
          nodeId,
          workflowId: context.workflowId,
          attempt,
          executionId: context.executionId,
          sessionId: context.sessionId,
          startTime: execution.startTime,
        });
      }

      if (this.shouldStopExecution(context)) {
        return;
      }

      try {
        // 准备输入
        const input = await this.prepareNodeInput(workflow, context, nodeId);

        // 执行节点
        let result: unknown;

        switch (nodeData.type) {
          case 'start':
            result = context.variables.get('__input__') || {};
            break;

          case 'schedule_trigger':
            result = context.variables.get('__input__') || input || {};
            if (result && typeof result === 'object' && '__schedule' in (result as Record<string, unknown>)) {
              context.variables.set('schedule', (result as Record<string, unknown>).__schedule);
            }
            break;

          case 'input':
            result = input;
            break;

          case 'output':
            result = input;
            context.variables.set('__output__', input);
            break;

          case 'leader':
            result = await this.executors.get('agent')!.execute(node, input, context);
            break;

          case 'parallel':
            result = await this.executors.get('parallel')!.execute(node, input, context);
            break;

          case 'loop':
            result = await this.executeLoopNode(workflow, context, nodeId, input);
            break;

          case 'agent':
          case 'tool':
          case 'template':
          case 'variable_assigner':
          case 'variable_aggregator':
          case 'list_operator':
          case 'http_request':
          case 'json_extractor':
          case 'condition': {
            const executor = this.executors.get(nodeData.type);
            if (!executor) {
              throw new Error(`No executor found for node type: ${nodeData.type}`);
            }
            result = await executor.execute(node, input, context);
            break;
          }

          default:
            throw new Error(`Unknown node type: ${nodeData.type}`);
        }

        if (this.shouldStopExecution(context)) {
          execution.endTime = Date.now();
          return;
        }

        // 保存结果
        execution.result = result;
        execution.status = 'completed';
        execution.endTime = Date.now();

        // 更新输出到上下文
        this.updateOutputs(nodeId, nodeData.outputs, result, context);

        this.emitEvent('workflow:node_completed', {
          nodeId,
          workflowId: context.workflowId,
          executionId: context.executionId,
          sessionId: context.sessionId,
          result,
          startTime: execution.startTime,
          endTime: execution.endTime,
          duration: execution.endTime - execution.startTime,
        });

        return;
      } catch (error) {
        execution.status = 'failed';
        execution.error = error instanceof Error ? error.message : String(error);
        execution.endTime = Date.now();

        this.log(
          context,
          'error',
          nodeId,
          `Node execution failed (attempt ${attempt + 1}/${maxRetries + 1}): ${execution.error}`
        );

        this.emitEvent('workflow:node_failed', {
          nodeId,
          workflowId: context.workflowId,
          executionId: context.executionId,
          sessionId: context.sessionId,
          error: execution.error,
          attempt: attempt + 1,
          startTime: execution.startTime,
          endTime: execution.endTime,
          duration: execution.endTime - execution.startTime,
          reason: 'node_error',
        });

        if (attempt >= maxRetries) {
          throw error;
        }
      }
    }
  }

  /**
   * 准备节点输入
   */
  private async prepareNodeInput(
    workflow: WorkflowDefinition,
    context: ExecutionContext,
    nodeId: string
  ): Promise<Record<string, unknown>> {
    const node = workflow.nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const inputs = node.data.inputs || {};
    const resolved: Record<string, unknown> = {};

    // 构建变量作用域
    const scope = buildVariableScope(context, { config: workflow.config, extractOutputs: false });

    for (const [key, input] of Object.entries(inputs)) {
      if (input.source) {
        // 解析变量引用
        const value = this.variableResolver.resolve(input.source, scope);
        resolved[key] = value;
      } else if (input.defaultValue !== undefined) {
        resolved[key] = input.defaultValue;
      } else if (input.required) {
        throw new Error(`Required input missing: ${key} for node ${nodeId}`);
      }
    }

    const dataEdges = workflow.edges.filter(e => e.target === nodeId && e.data?.type === 'data');
    for (const edge of dataEdges) {
      const sourceExecution = context.nodeExecutions.get(edge.source);
      if (!sourceExecution) continue;

      const mapping = edge.data?.dataMapping;
      if (mapping && Object.keys(mapping).length > 0) {
        for (const [sourcePath, targetPath] of Object.entries(mapping)) {
          const value = this.getPathValue(sourceExecution.result, sourcePath);
          if (value === undefined) {
            const actual = sourceExecution.result;
            const shape =
              actual === null || actual === undefined
                ? String(actual)
                : typeof actual === 'object'
                  ? Array.isArray(actual)
                    ? `array[${actual.length}]`
                    : `object{${Object.keys(actual as Record<string, unknown>).join(',')}}`
                  : `${typeof actual}(${JSON.stringify(actual).slice(0, 80)})`;
            throw new Error(
              `Data mapping failed: source path "${sourcePath}" not found from node "${edge.source}". ` +
                `Actual result shape: ${shape}. ` +
                `Tip: for tools that return a bare value (string/number), use "." or "result" as the source path to map the whole value. "content"/"text" also read plain string results.`,
            );
          }
          this.setPathValue(resolved, targetPath, value);
        }
      } else if (Object.keys(resolved).length === 0) {
        resolved.input = sourceExecution.result;
      }
    }

    // 如果没有定义输入，从前置节点获取
    if (Object.keys(resolved).length === 0) {
      const inputEdges = workflow.edges.filter(e => e.target === nodeId && e.data?.type !== 'loop');
      if (inputEdges.length === 1) {
        const sourceId = inputEdges[0].source;
        const sourceExecution = context.nodeExecutions.get(sourceId);
        if (sourceExecution) {
          return { input: sourceExecution.result };
        }
      } else if (inputEdges.length > 1) {
        // 多输入，合并
        for (const edge of inputEdges) {
          const sourceExecution = context.nodeExecutions.get(edge.source);
          if (sourceExecution) {
            resolved[edge.source] = sourceExecution.result;
          }
        }
      }
    }

    return resolved;
  }

  private getPathValue(source: unknown, path: string): unknown {
    if (path === '' || path === 'result' || path === '.') {
      return source;
    }
    // Bare-value fields: map "content"/"text"/"value"/"output" to the whole
    // non-object result (common pattern for tools that return a plain string/number).
    if (
      (path === 'content' || path === 'text' || path === 'value' || path === 'output') &&
      (typeof source === 'string' || typeof source === 'number' || typeof source === 'boolean')
    ) {
      return source;
    }

    let current: unknown = source;
    for (const part of path.split('.')) {
      if (current === undefined || current === null) return undefined;
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        current = (current as Record<string, unknown>)[arrayMatch[1]];
        current = Array.isArray(current) ? current[Number(arrayMatch[2])] : undefined;
      } else {
        current = (current as Record<string, unknown>)[part];
      }
    }
    return current;
  }

  private setPathValue(target: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.').filter(Boolean);
    if (parts.length === 0) return;

    let current: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }

  /**
   * 更新节点输出到上下文
   */
  private updateOutputs(
    nodeId: string,
    outputs: Record<string, unknown>,
    result: unknown,
    context: ExecutionContext
  ): void {
    // 保存节点结果
    context.variables.set(`${nodeId}.result`, result);

    // 保存定义的输出
    if (outputs) {
      for (const [key, output] of Object.entries(outputs)) {
        if (result && typeof result === 'object' && key in result) {
          context.variables.set(`${nodeId}.outputs.${key}`, (result as Record<string, unknown>)[key]);
        }
      }
    }
  }

  /**
   * 获取执行状态
   */
  getStatus(executionId: string): ExecutionContext | undefined {
    return this.activeExecutions.get(executionId) ?? this.executionHistory.get(executionId);
  }

  private storeExecutionHistory(executionId: string, context: ExecutionContext): void {
    this.executionHistory.set(executionId, context);
    while (this.executionHistory.size > this.maxExecutionHistory) {
      const oldestExecutionId = this.executionHistory.keys().next().value;
      if (!oldestExecutionId) break;
      this.executionHistory.delete(oldestExecutionId);
    }
  }

  /**
   * 取消执行
   */
  async cancel(executionId: string): Promise<void> {
    const context = this.activeExecutions.get(executionId);
    if (!context) {
      throw new Error(`Execution not found: ${executionId}`);
    }

    context.status = 'failed';
    context.error = 'Cancelled by user';
    context.endTime = Date.now();

    this.storeExecutionHistory(executionId, context);
    this.activeExecutions.delete(executionId);
    this.emitEvent('workflow:execution_cancelled', {
      executionId,
      workflowId: context.workflowId,
      sessionId: context.sessionId,
      error: context.error,
      endTime: context.endTime,
      reason: 'cancelled_by_user',
    });
    await this.saveExecution(context);
  }

  /**
   * 暂停执行 — 正在运行的节点会完成，后续节点在下一次 shouldStopExecution 检查前停止。
   */
  pause(executionId: string): void {
    const context = this.activeExecutions.get(executionId);
    if (!context) {
      throw new Error(`Execution not found: ${executionId}`);
    }
    if (context.status !== 'running') {
      throw new Error(`Execution is not running: ${executionId} (status=${context.status})`);
    }
    context.status = 'paused';
    this.emitEvent('workflow:execution_paused', {
      executionId,
      workflowId: context.workflowId,
      sessionId: context.sessionId,
    });
  }

  /**
   * 恢复已暂停的执行。
   * 将状态改为 running 并重新启动 runWorkflow 循环 — 已完成的节点会被跳过。
   */
  async resume(executionId: string): Promise<void> {
    const context = this.activeExecutions.get(executionId);
    if (!context) {
      throw new Error(`Execution not found: ${executionId}`);
    }
    if (context.status !== 'paused') {
      throw new Error(`Execution is not paused: ${executionId} (status=${context.status})`);
    }
    context.status = 'running';
    this.emitEvent('workflow:execution_resumed', {
      executionId,
      workflowId: context.workflowId,
      sessionId: context.sessionId,
    });

    // 重新启动执行循环 — runWorkflow 内部会跳过已 completed/skipped 的节点
    const workflow = this.workflowCache.get(context.workflowId);
    if (!workflow) {
      context.status = 'failed';
      context.error = 'Cannot resume: workflow definition no longer cached';
      this.activeExecutions.delete(executionId);
      this.emitEvent('workflow:execution_failed', {
        executionId,
        workflowId: context.workflowId,
        sessionId: context.sessionId,
        error: context.error,
        endTime: context.endTime,
        reason: 'resume_workflow_missing',
      });
      return;
    }

    this.runWorkflow(workflow, context)
      .then(() => {
        if (context.status === 'failed') {
          if (this.isExecutionTimeout(context)) {
            return;
          }
          this.emitEvent('workflow:execution_failed', {
            executionId,
            workflowId: context.workflowId,
            sessionId: context.sessionId,
            error: context.error,
            endTime: context.endTime,
            reason: 'execution_failed',
          });
          return;
        }
        if (context.status !== 'running') {
          return;
        }
        context.status = 'completed';
        context.endTime = Date.now();
        this.emitEvent('workflow:execution_completed', {
          executionId,
          workflowId: context.workflowId,
          sessionId: context.sessionId,
          output: context.variables.get('__output__'),
          startTime: context.startTime,
          endTime: context.endTime,
          duration: context.endTime - context.startTime,
        });
      })
      .catch((error) => {
        if (this.isExecutionTimeout(context)) {
          return;
        }
        this.handleExecutionError(context, error);
      })
      .finally(() => {
        this.storeExecutionHistory(executionId, context);
        if (context.status !== 'paused') {
          this.activeExecutions.delete(executionId);
          this.workflowCache.delete(context.workflowId);
        }
        this.saveExecution(context).catch(err => {
          console.error('Failed to save execution after resume:', err);
        });
      });
  }

  /**
   * 加载 workflow 定义
   */
  private async loadWorkflow(workflowId: string): Promise<WorkflowDefinition | null> {
    return this.workflowManager ? this.workflowManager.get(workflowId) : null;
  }

  /**
   * 保存执行记录
   */
  private async saveExecution(context: ExecutionContext): Promise<void> {
    try {
      const existing = this.db.getWorkflowExecution(context.executionId);
      const serializable = {
        workflowId: context.workflowId,
        executionId: context.executionId,
        sessionId: context.sessionId,
        status: context.status,
        startTime: context.startTime,
        endTime: context.endTime,
        variables: Object.fromEntries(context.variables),
        nodeExecutions: Object.fromEntries(
          [...context.nodeExecutions.entries()].map(([id, state]) => [id, { ...state, logs: undefined }])
        ),
        error: context.error,
      };

      if (existing) {
        this.db.updateWorkflowExecution(context.executionId, {
          status: context.status,
          end_time: context.endTime,
          context: serializable,
          error: context.error,
        });
      } else {
        this.db.createWorkflowExecution({
          id: context.executionId,
          workflow_id: context.workflowId,
          session_id: context.sessionId,
          status: context.status,
          start_time: context.startTime,
          end_time: context.endTime,
          context: serializable,
          error: context.error,
        });
      }

      // 保存日志
      for (const log of context.logs) {
        this.db.createWorkflowExecutionLog({
          execution_id: context.executionId,
          timestamp: log.timestamp,
          level: log.level,
          node_id: log.nodeId || undefined,
          message: log.message,
          data: log.data,
        });
      }
    } catch (err) {
      console.error('[WorkflowEngine] Failed to save execution:', err);
    }
  }

  /**
   * 处理执行错误
   */
  private handleExecutionError(context: ExecutionContext, error: unknown): void {
    context.status = 'failed';
    context.error = error instanceof Error ? error.message : String(error);
    context.endTime = Date.now();

    this.log(context, 'error', '', `Execution failed: ${context.error}`);

    this.emitEvent('workflow:execution_failed', {
      executionId: context.executionId,
      workflowId: context.workflowId,
      sessionId: context.sessionId,
      error: context.error,
      endTime: context.endTime,
      reason: 'execution_error',
    });
  }

  /**
   * 记录日志
   */
  private log(
    context: ExecutionContext,
    level: 'info' | 'warn' | 'error' | 'debug',
    nodeId: string,
    message: string,
    data?: unknown
  ): void {
    const logEntry = {
      timestamp: Date.now(),
      level,
      nodeId,
      message,
      data
    };
    context.logs.push(logEntry);

    // 同步把日志通过 SSE 推给前端，驱动 CanvasView 的 execution_progress 监听
    this.emitEvent('workflow:execution_progress', {
      executionId: context.executionId,
      workflowId: context.workflowId,
      sessionId: context.sessionId,
      nodeId,
      log: logEntry
    });
  }

  /**
   * 发送事件
   */
  private emitEvent(event: WorkflowRealtimeEventName, data: Record<string, unknown>): void {
    this.eventEmitter.emit(event as import('../EventEmitter.js').EventName, data as never);
    // 统一 per-mode 可观测出口：把执行生命周期事件桥接到 ModeAudit metrics。
    this.recordWorkflowAuditEvent(event, data);
  }

  private recordWorkflowAuditEvent(event: WorkflowRealtimeEventName, data: Record<string, unknown>): void {
    try {
      switch (event) {
        case 'workflow:execution_completed':
        case 'workflow:execution_failed':
        case 'workflow:execution_cancelled':
        case 'workflow:execution_paused':
        case 'workflow:execution_resumed': {
          const outcome = String(event).split(':').pop()?.replace('execution_', '') ?? 'unknown';
          auditModeEvent('workflow', {
            kind: 'workflow_execution',
            outcome,
            executionId: String(data.executionId ?? ''),
            durationMs: typeof data.duration === 'number' ? data.duration : undefined,
          });
          break;
        }
        default:
          break;
      }
    } catch {
      // 审计/metrics 失败绝不影响 workflow 主路径。
    }
  }

  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
