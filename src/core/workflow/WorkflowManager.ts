/**
 * WorkflowManager - Workflow 管理器
 * 
 * 职责：
 * - Workflow CRUD 操作
 * - 节点和边的管理
 * - Workflow 验证
 * - 持久化到数据库
 *
 * ⚠️ 安全模型（务必知悉）：
 * workflow 的 condition / loop 表达式由执行引擎经 `new Function` 在**本进程**直接
 * 求值（见 executors/ConditionNodeExecutor.ts:evaluateExpression 与
 * WorkflowEngine.ts:evaluateLoopCondition），等价于运行任意 JavaScript 代码，可
 * 读取环境变量、访问文件系统、发起网络请求乃至执行 shell 命令。本管理器的
 * import() / create() / update*() 等写入入口**不会**对表达式做安全校验或沙箱化
 * （这是有意保留的能力，workflow 通常由本机主人自建）。
 *
 * 因此：仅导入 / 编辑**可信来源**的 workflow，切勿运行他人分享的未经审查的
 * workflow，切勿把这些写入入口暴露给不可信用户。
 */

import { randomUUID } from 'crypto';
import { ExecutionGraph } from './ExecutionGraph.js';
import type {
  WorkflowDefinition,
  NodeDefinition,
  EdgeDefinition,
  WorkflowConfig,
  WorkflowRecord
} from './types.js';
import type { DatabaseManager } from '../Database.js';
import type { EventEmitter } from '../EventEmitter.js';

export interface CreateWorkflowParams {
  id?: string;
  name: string;
  description?: string;
  config?: Partial<WorkflowConfig>;
  tags?: string[];
  createdBy?: string;
  nodes?: NodeDefinition[];
  edges?: EdgeDefinition[];
  version?: string;
}

export interface WorkflowFilter {
  search?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    type: string;
    message: string;
    nodeId?: string;
    edgeId?: string;
  }>;
}

export class WorkflowManager {
  constructor(
    private db: DatabaseManager,
    private eventEmitter: EventEmitter
  ) {
    // 表 DDL 已统一在 Database.ts 创建，构造器无需再初始化表。
  }

  /**
   * 将数据库行转换为 WorkflowDefinition
   */
  private dbRowToDefinition(row: { id: string; name: string; description: string | null; nodes: unknown; edges: unknown; version?: string | null; config?: unknown; workspace?: string | null; tags?: unknown; created_by?: string | null; createdAt: number; updatedAt: number }): WorkflowDefinition {
    const nodes = Array.isArray(row.nodes) ? row.nodes : [];
    const edges = Array.isArray(row.edges) ? row.edges : [];
    const config = row.config && typeof row.config === 'object' ? { ...row.config } as WorkflowConfig : {};
    if (!config.workspace && row.workspace) {
      config.workspace = row.workspace;
    }
    const tags = Array.isArray(row.tags) ? row.tags as string[] : undefined;

    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      version: row.version || '1.0.0',
      nodes: nodes as NodeDefinition[],
      edges: edges as EdgeDefinition[],
      config,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.created_by || undefined,
      tags,
    };
  }

  /**
   * 创建 workflow
   */
  async create(params: CreateWorkflowParams): Promise<string> {
    const workflowId = params.id || randomUUID();
    const now = Date.now();

    const workflow: WorkflowDefinition = {
      id: workflowId,
      name: params.name,
      description: params.description,
      version: params.version || '1.0.0',
      nodes: params.nodes || [],
      edges: params.edges || [],
      config: {
        maxExecutionTime: params.config?.maxExecutionTime || 3600,
        maxIterations: params.config?.maxIterations || 1000,
        variables: params.config?.variables || {},
        workspace: params.config?.workspace,
        sessionId: params.config?.sessionId,
        allowedTools: params.config?.allowedTools,
        permissionMode: params.config?.permissionMode || 'ask'
      },
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
      tags: params.tags
    };

    await this.save(workflow);

    this.eventEmitter.emit('workflow:created', {
      workflow,
      workflowId,
      sessionId: workflow.config.sessionId,
    });

    return workflowId;
  }

  /**
   * 获取 workflow
   */
  async get(workflowId: string): Promise<WorkflowDefinition | null> {
    const row = this.db.getWorkflow(workflowId);
    if (!row) return null;
    return this.dbRowToDefinition(row);
  }

  /**
   * 列出 workflows
   */
  async list(filter?: WorkflowFilter): Promise<WorkflowDefinition[]> {
    const rows = this.db.listWorkflowsFull(filter?.search ? undefined : undefined);
    let results = rows.map(row => this.dbRowToDefinition(row));

    // 按搜索词过滤
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      results = results.filter(w => w.name.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q));
    }

    // 按标签过滤
    if (filter?.tags && filter.tags.length > 0) {
      results = results.filter(w => filter.tags!.some(t => w.tags?.includes(t)));
    }

    // 分页
    if (filter?.offset) results = results.slice(filter.offset);
    if (filter?.limit) results = results.slice(0, filter.limit);

    return results;
  }

  /**
   * 更新 workflow
   */
  async update(
    workflowId: string,
    updates: Partial<Pick<WorkflowDefinition, 'name' | 'description' | 'config' | 'tags' | 'nodes' | 'edges' | 'version'>>
  ): Promise<void> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (updates.name) workflow.name = updates.name;
    if (updates.description !== undefined) workflow.description = updates.description;
    if (updates.nodes !== undefined) workflow.nodes = updates.nodes;
    if (updates.edges !== undefined) workflow.edges = updates.edges;
    if (updates.version !== undefined) workflow.version = updates.version;
    if (updates.config) workflow.config = { ...workflow.config, ...updates.config };
    if (updates.tags) workflow.tags = updates.tags;

    workflow.updatedAt = Date.now();

    await this.save(workflow);

    this.eventEmitter.emit('workflow:updated', { workflowId, workflow, updates, sessionId: workflow.config.sessionId });
  }

  /**
   * 删除 workflow
   */
  async delete(workflowId: string): Promise<void> {
    const workflow = await this.get(workflowId);
    this.db.deleteWorkflow(workflowId);
    this.eventEmitter.emit('workflow:deleted', { workflowId, sessionId: workflow?.config.sessionId });
  }

  /**
   * 添加节点
   */
  async addNode(workflowId: string, node: Omit<NodeDefinition, 'id'> & { id?: string }): Promise<string> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const nodeId = node.id || randomUUID();
    if (workflow.nodes.some(n => n.id === nodeId)) {
      throw new Error(`Node already exists: ${nodeId}`);
    }
    const { id: _ignored, ...nodeWithoutId } = node;
    const fullNode: NodeDefinition = {
      ...nodeWithoutId,
      id: nodeId
    };

    workflow.nodes.push(fullNode);
    workflow.updatedAt = Date.now();

    await this.save(workflow);

    this.eventEmitter.emit('workflow:node_added', {
      workflowId,
      sessionId: workflow.config.sessionId,
      node: fullNode
    });

    return nodeId;
  }

  /**
   * 更新节点
   */
  async updateNode(
    workflowId: string,
    nodeId: string,
    updates: Partial<NodeDefinition>
  ): Promise<void> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const node = workflow.nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // 更新节点属性；data/config 必须合并，避免部分更新覆盖 data.type/status/inputs/outputs
    const { data, ...topLevelUpdates } = updates;
    Object.assign(node, topLevelUpdates);

    if (data) {
      node.data = {
        ...node.data,
        ...data,
        config: {
          ...node.data.config,
          ...data.config,
        },
      };
    }

    workflow.updatedAt = Date.now();

    await this.save(workflow);

    this.eventEmitter.emit('workflow:node_updated', {
      workflowId,
      sessionId: workflow.config.sessionId,
      nodeId,
      node,
      updates
    });
  }

  /**
   * 删除节点
   */
  async deleteNode(workflowId: string, nodeId: string): Promise<string[]> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    // 删除节点
    workflow.nodes = workflow.nodes.filter(n => n.id !== nodeId);

    // 删除相关的边
    const deletedEdges = workflow.edges
      .filter(e => e.source === nodeId || e.target === nodeId)
      .map(e => e.id);

    workflow.edges = workflow.edges.filter(
      e => e.source !== nodeId && e.target !== nodeId
    );

    workflow.updatedAt = Date.now();

    await this.save(workflow);

    this.eventEmitter.emit('workflow:node_deleted', {
      workflowId,
      sessionId: workflow.config.sessionId,
      nodeId,
      deletedEdges
    });

    return deletedEdges;
  }

  /**
   * 添加边
   */
  async addEdge(workflowId: string, edge: Omit<EdgeDefinition, 'id'>): Promise<string> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    // 验证源节点和目标节点存在
    const sourceExists = workflow.nodes.some(n => n.id === edge.source);
    const targetExists = workflow.nodes.some(n => n.id === edge.target);

    if (!sourceExists) {
      throw new Error(`Source node not found: ${edge.source}`);
    }
    if (!targetExists) {
      throw new Error(`Target node not found: ${edge.target}`);
    }

    const edgeId = randomUUID();
    const fullEdge: EdgeDefinition = {
      ...edge,
      id: edgeId
    };

    workflow.edges.push(fullEdge);
    workflow.updatedAt = Date.now();

    await this.save(workflow);

    this.eventEmitter.emit('workflow:edge_added', {
      workflowId,
      sessionId: workflow.config.sessionId,
      edge: fullEdge
    });

    return edgeId;
  }

  /**
   * 更新边
   */
  async updateEdge(
    workflowId: string,
    edgeId: string,
    updates: Partial<EdgeDefinition>
  ): Promise<void> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const edge = workflow.edges.find(e => e.id === edgeId);
    if (!edge) {
      throw new Error(`Edge not found: ${edgeId}`);
    }

    Object.assign(edge, updates);
    workflow.updatedAt = Date.now();

    await this.save(workflow);

    this.eventEmitter.emit('workflow:edge_updated', {
      workflowId,
      sessionId: workflow.config.sessionId,
      edgeId,
      edge,
      updates
    });
  }

  /**
   * 删除边
   */
  async deleteEdge(workflowId: string, edgeId: string): Promise<void> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    workflow.edges = workflow.edges.filter(e => e.id !== edgeId);
    workflow.updatedAt = Date.now();

    await this.save(workflow);

    this.eventEmitter.emit('workflow:edge_deleted', {
      workflowId,
      sessionId: workflow.config.sessionId,
      edgeId
    });
  }

  /**
   * 验证 workflow
   */
  async validate(workflowId: string): Promise<ValidationResult> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const errors: ValidationResult['errors'] = [];

    // 基本验证
    if (workflow.nodes.length === 0) {
      errors.push({
        type: 'empty_workflow',
        message: 'Workflow has no nodes'
      });
      return { valid: false, errors };
    }

    // 验证节点
    for (const node of workflow.nodes) {
      if (!node.id) {
        errors.push({
          type: 'invalid_node',
          message: 'Node missing ID',
          nodeId: node.id
        });
      }

      if (!node.data.type) {
        errors.push({
          type: 'invalid_node',
          message: 'Node missing type',
          nodeId: node.id
        });
      }

      // 验证节点配置
      const nodeData = node.data;
      if (nodeData.type === 'tool' && !nodeData.config.toolName) {
        errors.push({
          type: 'invalid_config',
          message: 'Tool node missing toolName',
          nodeId: node.id
        });
      }

      if (nodeData.type === 'condition' && !nodeData.config.conditionType) {
        errors.push({
          type: 'invalid_config',
          message: 'Condition node missing conditionType',
          nodeId: node.id
        });
      }
      if (nodeData.type === 'condition' && nodeData.config.conditionType === 'llm') {
        if (!nodeData.config.llmPrompt) {
          errors.push({
            type: 'invalid_config',
            message: 'LLM condition node missing llmPrompt',
            nodeId: node.id
          });
        }
        if (!nodeData.config.conditionAgentRole) {
          errors.push({
            type: 'invalid_config',
            message: 'LLM condition node missing conditionAgentRole',
            nodeId: node.id
          });
        }
      }

      if (nodeData.type === 'loop' && !nodeData.config.loopType) {
        errors.push({
          type: 'invalid_config',
          message: 'Loop node missing loopType',
          nodeId: node.id
        });
      }
    }

    // 验证边
    for (const edge of workflow.edges) {
      if (!edge.source || !edge.target) {
        errors.push({
          type: 'invalid_edge',
          message: 'Edge missing source or target',
          edgeId: edge.id
        });
      }

      const sourceExists = workflow.nodes.some(n => n.id === edge.source);
      const targetExists = workflow.nodes.some(n => n.id === edge.target);

      if (!sourceExists) {
        errors.push({
          type: 'invalid_edge',
          message: `Edge references non-existent source node: ${edge.source}`,
          edgeId: edge.id
        });
      }

      if (!targetExists) {
        errors.push({
          type: 'invalid_edge',
          message: `Edge references non-existent target node: ${edge.target}`,
          edgeId: edge.id
        });
      }
    }

    // 验证图结构
    try {
      const graph = new ExecutionGraph(workflow);
      const graphValidation = graph.validate();

      if (!graphValidation.valid) {
        for (const error of graphValidation.errors) {
          errors.push({
            type: 'graph_error',
            message: error
          });
        }
      }
    } catch (error) {
      errors.push({
        type: 'graph_error',
        message: error instanceof Error ? error.message : String(error)
      });
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 保存 workflow 到数据库
   */
  private async save(workflow: WorkflowDefinition): Promise<void> {
    const existing = this.db.getWorkflow(workflow.id);
    if (existing) {
      this.db.updateWorkflow(workflow.id, {
        name: workflow.name,
        description: workflow.description,
        workspace: workflow.config?.workspace,
        nodes: workflow.nodes,
        edges: workflow.edges,
        config: workflow.config,
        tags: workflow.tags,
        version: workflow.version,
      });
    } else {
      this.db.createWorkflow({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        workspace: workflow.config?.workspace,
        nodes: workflow.nodes,
        edges: workflow.edges,
        version: workflow.version,
        config: workflow.config,
        tags: workflow.tags,
        created_by: workflow.createdBy,
      });
    }
  }

  /**
   * 克隆 workflow
   */
  async clone(workflowId: string, newName?: string): Promise<string> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const newWorkflowId = randomUUID();
    const now = Date.now();

    const clonedWorkflow: WorkflowDefinition = {
      ...workflow,
      id: newWorkflowId,
      name: newName || `${workflow.name} (Copy)`,
      createdAt: now,
      updatedAt: now
    };

    await this.save(clonedWorkflow);

    return newWorkflowId;
  }

  /**
   * 导出 workflow 为 JSON
   */
  async export(workflowId: string): Promise<string> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    return JSON.stringify(workflow, null, 2);
  }

  /**
   * 从 JSON 导入 workflow
   *
   * ⚠️ 安全风险：导入的 workflow 中的 condition / loop 表达式会在执行时经
   * `new Function` 在本进程直接运行（等价于任意代码执行），此处**不做**表达式
   * 安全校验。仅导入可信来源的 workflow，切勿导入他人分享的未经审查的 workflow。
   */
  async import(json: string): Promise<string> {
    const workflow = JSON.parse(json) as WorkflowDefinition;

    // 生成新 ID
    const newWorkflowId = randomUUID();
    workflow.id = newWorkflowId;
    workflow.createdAt = Date.now();
    workflow.updatedAt = Date.now();

    // 先保存，再验证（验证需要从数据库读取）
    await this.save(workflow);

    const validation = await this.validate(newWorkflowId);
    if (!validation.valid) {
      // 验证失败则回滚
      this.db.deleteWorkflow(newWorkflowId);
      throw new Error(`Invalid workflow: ${validation.errors[0].message}`);
    }

    return newWorkflowId;
  }
}
