/**
 * Canvas Workflow 类型定义
 * 
 * 定义 workflow 系统的核心数据结构，包括节点、边、执行上下文等
 */

import type { Node, Edge } from '@xyflow/react';
import type {
  WorkflowRealtimeEventName as ContractWorkflowRealtimeEventName,
} from '@contracts/types/Workflow';

// ─── 节点类型 ───

export type NodeType = 
  | 'start'      // 起始节点
  | 'leader'     // Leader Agent
  | 'agent'      // Worker Agent
  | 'tool'       // 工具调用
  | 'template'   // 文本/JSON 模板
  | 'variable_assigner'
  | 'variable_aggregator'
  | 'list_operator'
  | 'http_request'
  | 'json_extractor'
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

// ─── 节点配置 ───

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

  // Data 节点配置
  template?: string;
  templateFormat?: 'text' | 'json';
  outputKey?: string;
  assignments?: Record<string, unknown> | Array<{ name: string; value: unknown }>;
  aggregate?: Record<string, string> | string[];
  listSource?: string;
  listOperation?: 'first' | 'last' | 'length' | 'slice' | 'join' | 'flatten' | 'unique' | 'reverse' | 'sort' | 'pluck' | 'compact';
  listProperty?: string;
  listStart?: number;
  listEnd?: number;
  listDelimiter?: string;
  httpRequest?: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
    maxResponseSize?: number;
    followRedirects?: boolean;
  };
  jsonSource?: string;
  extractPaths?: Record<string, string>;
  
  // Condition 节点配置
  conditionType?: 'expression' | 'llm';
  expression?: string;  // JavaScript 表达式
  llmPrompt?: string;   // LLM 判断提示词
  
  // Loop 节点配置
  loopType?: 'count' | 'while' | 'foreach';
  loopCount?: number;
  loopCondition?: string;
  loopItems?: string;  // 变量引用
  
  // Parallel 节点配置
  parallelBranches?: string[];  // 子节点 ID 列表
  waitAll?: boolean;  // 是否等待所有分支完成

  // Schedule Trigger 节点配置
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
  config?: NodeConfig;
  
  // 输入输出
  inputs?: Record<string, NodeInput>;
  outputs?: Record<string, NodeOutput>;
  
  // 执行结果
  result?: unknown;
  error?: string;
  startTime?: number;
  endTime?: number;
  
  // 元数据
  metadata?: Record<string, unknown>;
  
  // Canvas 表单字段
  agentId?: string;
  agentModel?: string;
  agentPrompt?: string;
  model?: string;
  prompt?: string;
  systemPrompt?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  conditionExpr?: string;
  expression?: string;
  trueTarget?: string;
  falseTarget?: string;
  inputSource?: string;
  outputFormat?: string;
  
  // Additional node metadata
  [key: string]: unknown;
}

// ─── 边类型 ───

export type EdgeType = 
  | 'sequence'   // 顺序执行
  | 'condition'  // 条件分支（true/false）
  | 'data'       // 数据流
  | 'loop';      // 循环边

export interface WorkflowEdgeData {
  type?: EdgeType;
  
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
  
  // Additional edge metadata
  [key: string]: unknown;
}

// ─── Workflow 定义 ───

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  version: string;
  
  // 节点和边
  nodes: Node<WorkflowNodeData>[];
  edges: Edge<WorkflowEdgeData>[];
  
  // 全局配置
  config: WorkflowConfig;
  
  // 元数据
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  tags?: string[];
}

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

// ─── 执行上下文 ───

export interface WorkflowExecutionContext {
  workflowId: string;
  executionId: string;
  sessionId: string;
  
  // 执行状态
  status: 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
  startTime: number;
  endTime?: number;
  
  // 变量存储
  variables: Record<string, unknown>;
  
  // 节点执行记录
  nodeExecutions: Record<string, NodeExecution>;
  
  // 执行日志
  logs: ExecutionLog[];
  
  // 错误信息
  error?: string;
}

export interface NodeExecution {
  nodeId: string;
  status: NodeStatus;
  startTime: number;
  endTime?: number;
  result?: unknown;
  error?: string;
  retryCount: number;
  logs: ExecutionLog[];
}

export interface ExecutionLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  nodeId?: string;
  message: string;
  data?: unknown;
}

// ─── 执行状态（前端用） ───

export interface ExecutionState {
  executionId: string;
  workflowId: string;
  status: 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
  startTime: number;
  endTime?: number;
  currentNodeId?: string;
  progress?: {
    completedNodes: number;
    totalNodes: number;
    percentage: number;
  };
  logs: ExecutionLog[];
  output?: unknown;
  error?: string;
}

export type WorkflowExecutionRealtimeEventName = Extract<ContractWorkflowRealtimeEventName, `workflow:execution_${string}`>;
export type WorkflowNodeRealtimeEventName = Extract<ContractWorkflowRealtimeEventName, `workflow:node_${string}`>;
export type WorkflowRealtimeEventName = ContractWorkflowRealtimeEventName;

export type {
  WorkflowCanvasEdge,
  WorkflowCanvasNode,
  WorkflowCanvasNodeData as WorkflowContractNodeData,
  WorkflowDirectoryProjectionState,
  WorkflowDirectorySummaryProjection,
  WorkflowEngineLog,
  WorkflowExecutionLog as WorkflowUiExecutionLog,
  WorkflowExecutionProjection,
  WorkflowNodeExecutionProjection,
  WorkflowProjectionEvent,
  WorkflowProjectionMessages,
  WorkflowProjectionReduceOptions,
  WorkflowProjectionState,
} from '@contracts/types/Workflow';

export {
  WORKFLOW_REALTIME_EVENT_NAMES,
  createWorkflowProjectionState,
  normalizeWorkflowRealtimeEvent,
  reduceWorkflowDirectoryProjection,
  reduceWorkflowProjection,
} from '@contracts/types/Workflow';
