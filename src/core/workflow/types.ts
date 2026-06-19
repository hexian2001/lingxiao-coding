/**
 * Canvas Workflow 类型定义
 * 
 * 定义 workflow 执行引擎的核心数据结构
 */

import type { DatabaseManager } from '../Database.js';
import type { EventEmitter } from '../EventEmitter.js';
import type { BlackboardGraph } from '../blackboard/BlackboardGraph.js';
import type { WorkflowManager } from './WorkflowManager.js';
import type { WorkflowEngine } from './WorkflowEngine.js';

// ============================================================================
// ReactFlow 兼容类型定义
// ============================================================================

export interface Position {
  x: number;
  y: number;
}

export interface Node<T = unknown> {
  id: string;
  type?: string;
  position: Position;
  data: T;
  selected?: boolean;
  dragging?: boolean;
}

export interface Edge<T = unknown> {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: T;
  selected?: boolean;
}

// ============================================================================
// 节点类型定义
// ============================================================================

export type NodeType = 
  | 'start'      // 起始节点
  | 'leader'     // Leader Agent
  | 'agent'      // Worker Agent
  | 'tool'       // 工具调用
  | 'template'   // 文本/JSON 模板
  | 'variable_assigner'    // 变量赋值
  | 'variable_aggregator'  // 变量聚合
  | 'list_operator'        // 列表处理
  | 'http_request'         // HTTP 请求
  | 'json_extractor'       // JSON/参数提取
  | 'condition'  // 条件分支
  | 'loop'       // 循环节点
  | 'parallel'   // 并行执行
  | 'schedule_trigger' // 定时触发入口
  | 'input'      // 输入节点
  | 'output';    // 输出节点

export type NodeStatus = 
  | 'idle'       // 未执行
  | 'waiting'    // 等待前置节点
  | 'running'    // 执行中
  | 'completed'  // 已完成
  | 'failed'     // 失败
  | 'skipped'    // 跳过（条件分支）
  | 'paused'     // 暂停
  | 'cancelled'; // 取消

export interface NodeConfig {
  // Agent 节点配置
  agentRole?: string;
  agentModel?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  
  // Tool 节点配置
  toolName?: string;
  toolArgs?: Record<string, unknown>;

  // Template 节点配置
  template?: string;
  templateFormat?: 'text' | 'json';
  outputKey?: string;

  // Variable Assigner / Aggregator 节点配置
  assignments?: Record<string, unknown> | Array<{
    name: string;
    value: unknown;
  }>;
  aggregate?: Record<string, string> | string[];

  // List Operator 节点配置
  listSource?: string;
  listOperation?: 'first' | 'last' | 'length' | 'slice' | 'join' | 'flatten' | 'unique' | 'reverse' | 'sort' | 'pluck' | 'compact';
  listProperty?: string;
  listStart?: number;
  listEnd?: number;
  listDelimiter?: string;

  // HTTP Request 节点配置。执行时会委托已注册的 http_request tool，避免绕过现有请求实现。
  httpRequest?: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
    maxResponseSize?: number;
    followRedirects?: boolean;
  };

  // JSON Extractor / Parameter Extractor 节点配置
  jsonSource?: string;
  extractPaths?: Record<string, string>;
  
  // Condition 节点配置
  conditionType?: 'expression' | 'llm';
  expression?: string;  // JavaScript 表达式
  llmPrompt?: string;   // LLM 判断提示词
  conditionAgentRole?: string;
  conditionModel?: string;
  
  // Loop 节点配置
  loopType?: 'count' | 'while' | 'foreach';
  loopCount?: number;
  loopCondition?: string;
  loopItems?: string;  // 变量引用
  maxIterations?: number;  // 最大迭代次数
  
  // Parallel 节点配置
  parallelBranches?: string[];  // 子节点 ID 列表
  waitAll?: boolean;  // 是否等待所有分支完成

  // Schedule Trigger 节点配置。保存 workflow 时会同步为真实 scheduled_tasks。
  scheduleCron?: string;
  scheduleSessionId?: string;
  schedulePrompt?: string;
  scheduleRecurring?: boolean;
  scheduleDurable?: boolean;
  scheduleEnabled?: boolean;
  scheduleIntensity?: 'gentle' | 'normal' | 'aggressive' | 'critical';
  scheduleAudience?: 'personal' | 'team' | 'ops' | 'customer';
  scheduleWorkflowInput?: Record<string, unknown>;
  
  // 通用配置
  timeout?: number;
  retryCount?: number;
  retryDelay?: number;
}

export interface NodeInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';
  required: boolean;
  defaultValue?: unknown;
  source?: string;  // 变量引用，如 "${node_id.output_key}"
}

export interface NodeOutput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';
  value?: unknown;
}

export interface WorkflowNodeData {
  // 基础信息
  label: string;
  type: NodeType;
  status: NodeStatus;
  description?: string;
  
  // 配置
  config: NodeConfig;
  
  // 输入输出
  inputs: Record<string, NodeInput>;
  outputs: Record<string, NodeOutput>;
  
  // 执行结果
  result?: unknown;
  error?: string;
  startTime?: number;
  endTime?: number;
  
  // 元数据
  metadata?: Record<string, unknown>;
}

export type NodeDefinition = Node<WorkflowNodeData>;

// ============================================================================
// 边类型定义
// ============================================================================

export type EdgeType = 
  | 'sequence'   // 顺序执行
  | 'condition'  // 条件分支（true/false）
  | 'data'       // 数据流
  | 'loop';      // 循环边

export interface WorkflowEdgeData {
  type: EdgeType;
  
  // 条件边配置
  conditionValue?: boolean;  // true 或 false 分支
  
  // 数据流配置
  dataMapping?: Record<string, string>;  // 输出到输入的映射
  
  // 样式
  style?: {
    stroke?: string;
    strokeWidth?: number;
    strokeDasharray?: string;
  };
}

export type EdgeDefinition = Edge<WorkflowEdgeData>;

// ============================================================================
// Workflow 定义
// ============================================================================

export interface WorkflowConfig {
  // 执行配置
  maxExecutionTime?: number;  // 最大执行时间（秒）
  maxIterations?: number;     // 最大迭代次数
  
  // 全局变量
  variables?: Record<string, unknown>;
  
  // 环境配置
  workspace?: string;
  sessionId?: string;
  
  // 权限配置
  allowedTools?: string[];
  permissionMode?: 'ask' | 'allow' | 'deny';
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  version: string;
  
  // 节点和边
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  
  // 全局配置
  config: WorkflowConfig;
  
  // 元数据
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  tags?: string[];
}

// ============================================================================
// 执行上下文
// ============================================================================

export interface ExecutionLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  nodeId?: string;
  message: string;
  data?: unknown;
}

export interface NodeExecutionState {
  nodeId: string;
  status: NodeStatus;
  startTime: number;
  endTime?: number;
  result?: unknown;
  error?: string;
  retryCount: number;
  logs: ExecutionLog[];
}

export interface VariableScope {
  // 全局变量
  workflow: {
    variables: Record<string, unknown>;
    config: WorkflowConfig;
  };
  
  // 执行上下文
  context: {
    workflowId: string;
    executionId: string;
    sessionId: string;
    startTime: number;
  };
  
  // 节点输出
  nodes: Record<string, {
    outputs: Record<string, unknown>;
    result?: unknown;
  }>;
  
  // 输入数据
  input?: Record<string, unknown>;
  
  // 环境变量
  env: Record<string, string | undefined>;
}

export interface ExecutionContext {
  workflowId: string;
  executionId: string;
  sessionId: string;
  
  // 执行状态
  status: 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
  startTime: number;
  endTime?: number;
  
  // 变量存储
  variables: Map<string, unknown>;
  
  // 节点执行记录
  nodeExecutions: Map<string, NodeExecutionState>;
  
  // 执行日志
  logs: ExecutionLog[];

  // 共享运行时服务（供 workflow tool node 复用标准 ToolContext）
  db?: DatabaseManager;
  emitter?: EventEmitter;
  workflowManager?: WorkflowManager;
  workflowEngine?: WorkflowEngine;
  blackboardGraph?: BlackboardGraph;
  
  // 错误信息
  error?: string;
}

export interface ExecutionState {
  context: ExecutionContext;
  currentNodeId?: string;
  pendingNodes: Set<string>;
  completedNodes: Set<string>;
  failedNodes: Set<string>;
}

// ============================================================================
// 执行选项和结果
// ============================================================================

export interface ExecutionOptions {
  // 覆盖全局变量
  variables?: Record<string, unknown>;
  sessionId?: string;
  
  // 执行配置
  timeout?: number;
  maxIterations?: number;
  
}

export interface ExecutionResult {
  executionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  outputs: Record<string, unknown>;
  error?: string;
  duration: number;
  nodeExecutions: NodeExecutionState[];
  logs: ExecutionLog[];
}

// ============================================================================
// 数据库记录类型
// ============================================================================

export interface WorkflowRecord {
  id: string;
  name: string;
  description: string | null;
  definition: string;  // JSON: WorkflowDefinition
  version: string;
  config: string | null;  // JSON: WorkflowConfig
  tags: string | null;  // JSON: string[]
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

export interface WorkflowExecutionRecord {
  id: string;
  workflow_id: string;
  session_id: string;
  status: string;
  start_time: number;
  end_time: number | null;
  context: string;  // JSON: ExecutionContext
  error: string | null;
  created_at: number;
}

export interface WorkflowExecutionLogRecord {
  id: number;
  execution_id: string;
  timestamp: number;
  level: string;
  node_id: string | null;
  message: string;
  data: string | null;  // JSON
}
