/**
 * AgentExecutionResult - Worker 结构化返回类型
 * 
 * 借鉴 CCSM 的状态驱动执行，Worker 完成时返回结构化结果而非纯文本：
 * - status: 执行状态 (completed/failed/blocked)
 * - summary: 简短摘要
 * - outputs: 结构化输出数组 (实现证据、测试结果、诊断信息、文件变更)
 * - metadata: 元数据 (文件列表、测试统计、执行时长)
 */

import type { RecoveryFaultClass } from '../core/RecoveryRecords.js';
import type { LLMErrorKind } from '../llm/errors.js';

export type ExecutionStatus = 'completed' | 'failed' | 'blocked';

export type ExecutionOutputType = 
  | 'implementation_evidence'
  | 'test_result'
  | 'diagnostic'
  | 'file_change'
  | 'error_trace'
  | 'performance_metric';

export interface ExecutionOutput {
  type: ExecutionOutputType;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentExecutionResult {
  status: ExecutionStatus;
  summary: string;
  outputs: ExecutionOutput[];
  metadata: {
    filesChanged: string[];
    testsRun?: number;
    testsPassed?: number;
    testsFailed?: number;
    duration: number;
    iterations?: number;
    toolCalls?: number;
    recoverable?: boolean;
    faultClass?: RecoveryFaultClass;
    // LLM 错误细分（request_timeout / network_error / connect_timeout / stream_timeout 等）。
    // 用于 FaultRecovery.classifyAutonomousFault：瞬时 provider 超时应归 external_retryable→
    // worker_restart（静默自主重派），而非默认 leader_takeover（唤醒 Leader）。仅在 LLM 重试
    // 耗尽的终态结果里填充；非 LLM 错误（worker_stopped/TimeoutError 等）留空。
    llmErrorKind?: LLMErrorKind;
    terminalKind?: 'failed' | 'recovering' | 'terminated';
    statusReason?: string;
    runtimePhase?: 'execute' | 'conclude';
  };
}

/**
 * 创建成功的执行结果
 */
export function createSuccessResult(input: {
  summary: string;
  filesChanged: string[];
  duration: number;
  additionalOutputs?: ExecutionOutput[];
  metadata?: Partial<AgentExecutionResult['metadata']>;
}): AgentExecutionResult {
  const outputs: ExecutionOutput[] = [
    {
      type: 'implementation_evidence',
      content: input.summary,
    },
    ...(input.additionalOutputs || []),
  ];

  return {
    status: 'completed',
    summary: input.summary,
    outputs,
    metadata: {
      filesChanged: input.filesChanged,
      duration: input.duration,
      ...input.metadata,
    },
  };
}

/**
 * 创建失败的执行结果
 */
export function createFailureResult(input: {
  summary: string;
  error: string;
  duration: number;
  diagnostics?: string[];
  metadata?: Partial<AgentExecutionResult['metadata']>;
}): AgentExecutionResult {
  const outputs: ExecutionOutput[] = [
    {
      type: 'error_trace',
      content: input.error,
    },
  ];

  if (input.diagnostics) {
    for (const diagnostic of input.diagnostics) {
      outputs.push({
        type: 'diagnostic',
        content: diagnostic,
      });
    }
  }

  return {
    status: 'failed',
    summary: input.summary,
    outputs,
    metadata: {
      filesChanged: [],
      duration: input.duration,
      ...input.metadata,
    },
  };
}

/**
 * 创建阻塞的执行结果
 */
export function createBlockedResult(input: {
  summary: string;
  reason: string;
  duration: number;
  metadata?: Partial<AgentExecutionResult['metadata']>;
}): AgentExecutionResult {
  return {
    status: 'blocked',
    summary: input.summary,
    outputs: [
      {
        type: 'diagnostic',
        content: `Blocked: ${input.reason}`,
      },
    ],
    metadata: {
      filesChanged: [],
      duration: input.duration,
      ...input.metadata,
    },
  };
}
