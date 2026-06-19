/**
 * formatWorkerCompletion — 把 worker 的 task_complete 结构化负载渲染成给 Leader
 * 看的统一 Cross-Agent Artifact Awareness 区块。
 */

import { buildArtifactAwarenessBlock } from '../../core/ArtifactAwareness.js';
import type { WorkerContractComplianceProof } from '../../core/AgentProtocol.js';

type WorkerCompletionArtifactTrace = {
  files_created?: string[];
  files_modified?: string[];
  commands_run?: string[];
};

type WorkerCompletionVerification = {
  kind: string;
  detail: string;
  passed?: boolean;
};

interface WorkerCompletionPayloadForFormat {
  kind?: string;
  result?: string;
  summary?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  artifacts?: WorkerCompletionArtifactTrace;
  verification?: WorkerCompletionVerification[];
  next_steps?: string[];
  blocked_by_discovery?: string[];
  needs_leader_coordination?: boolean;
  evidence_refs?: string[];
  contract_compliance?: WorkerContractComplianceProof;
  toolTrace?: WorkerCompletionArtifactTrace;
}

export interface WorkerCompletionDigest {
  /** 给 Leader 看的统一 awareness Markdown，已包含摘要、产物、验证、后续建议、原始 result */
  block: string;
  /** 单行文本，可用于 UI 通知/状态栏 */
  oneLine: string;
}

const MAX_RESULT_PREVIEW = 5000;

/**
 * 把 task_complete payload 渲染成 Leader 上下文区块。
 *
 * @param payload  从 readAgentControlMessage 解析出的结构化 payload
 * @param meta     上下文元信息（agent 名、taskId、是 completed 还是 failed 等）
 */
export function formatWorkerCompletion(
  payload: WorkerCompletionPayloadForFormat,
  meta: {
    agentName: string;
    taskId: string;
    exitReason: 'completed' | 'failed';
  },
): WorkerCompletionDigest {
  const status = meta.exitReason === 'completed' ? '已完成' : '失败';
  const heading = `--- Agent @${meta.agentName} 任务 [${meta.taskId}] ${status} ---`;

  const summary = (payload.summary ?? '').trim();
  const rawResult = (payload.result ?? '').trim();
  const previewed = rawResult.length > MAX_RESULT_PREVIEW
    ? `${rawResult.slice(0, MAX_RESULT_PREVIEW)}\n...(truncated ${rawResult.length - MAX_RESULT_PREVIEW} chars)`
    : rawResult;

  const coordination = [
    payload.needs_leader_coordination ? 'needs_leader_coordination: true' : '',
    ...(payload.blocked_by_discovery?.length
      ? [
          'blocked_by_discovery:',
          ...payload.blocked_by_discovery.map((item) => `- ${item}`),
        ]
      : []),
  ].filter(Boolean).join('\n');

  const block = [
    heading,
    buildArtifactAwarenessBlock({
      source: meta.exitReason === 'completed' ? 'worker_completion' : 'worker_failure',
      taskId: meta.taskId,
      agentId: meta.agentName?.replace(/^[^:]+:/, ''),
      summary: summary || undefined,
      result: previewed,
      resultLabel: meta.exitReason === 'completed' ? 'Worker Result' : 'Worker Failure',
      artifacts: payload.artifacts,
      toolTrace: payload.toolTrace,
      evidenceRefs: payload.evidence_refs,
      contractCompliance: payload.contract_compliance,
      verification: payload.verification,
      nextSteps: payload.next_steps,
    }),
    coordination ? `### Leader Coordination Request\n${coordination}` : '',
  ].filter(Boolean).join('\n\n');

  const oneLine = summary
    ? `Agent @${meta.agentName} ${status}：${summary}`
    : `Agent @${meta.agentName} 任务 ${meta.taskId} ${status}`;

  return { block, oneLine };
}
