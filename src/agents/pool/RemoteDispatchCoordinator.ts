import type { MessageBus } from '../../core/MessageBus.js';
import type { EventEmitter } from '../../core/EventEmitter.js';
import type { RemoteWorkerDescriptor, RemoteWorkerRegistry } from '../../core/transport/RemoteWorkerRegistry.js';
import type { WorkerTaskPayload } from '../../core/WorkerProcessRunner.js';
import type { SpeculativeWinnerEvidence } from '../../core/SpeculativeExecutionController.js';
import type { Task as BoardTask } from '../../core/TaskBoard.js';
import type { AgentHandle } from '../AgentPoolRuntime.js';

export interface RemoteCompletion {
  result: string;
  stats: { iterations: number; toolCalls: number };
  tokenUsage?: { total?: number; prompt?: number; completion?: number };
  summary?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  artifacts?: { files_created?: string[]; files_modified?: string[]; commands_run?: string[] };
  verification?: Array<{ kind: string; detail: string; passed?: boolean }>;
  next_steps?: string[];
  blocked_by_discovery?: string[];
  needs_leader_coordination?: boolean;
  evidence_refs?: string[];
  contract_compliance?: unknown;
  toolTrace?: { files_created?: string[]; files_modified?: string[]; commands_run?: string[] };
  speculativeWinner?: SpeculativeWinnerEvidence;
}

export interface RemoteDispatchCallbacks<TCompletionPayload> {
  getTaskRunGeneration(handle: AgentHandle): number;
  markRemoteRunning(handle: AgentHandle): void;
  markAgentFailed(error: Error, source: string): void;
  parseCompletion(payload: unknown): RemoteCompletion;
  buildCompletionPayload(completion: RemoteCompletion): TCompletionPayload;
  acceptCompletion(completion: RemoteCompletion, completionPayload: TCompletionPayload): void;
}

export function selectRemoteWorker(
  registry: RemoteWorkerRegistry,
  tools: string[],
  enabled: boolean,
): RemoteWorkerDescriptor | null {
  if (!enabled) {
    return null;
  }
  return registry.findWorker({ tools, preferLocal: false });
}

function isMatchingRemoteEnvelope(
  envelopePayload: unknown,
  dispatchId: string,
  sessionId: string,
  handle: AgentHandle,
  task: BoardTask,
): envelopePayload is Record<string, unknown> {
  if (!envelopePayload || typeof envelopePayload !== 'object') {
    return false;
  }
  const payload = envelopePayload as Record<string, unknown>;
  return payload.dispatchId === dispatchId
    || (
      payload.sessionId === sessionId
      && payload.taskId === task.id
      && (payload.agentId === handle.agentId || payload.agentName === handle.name)
    );
}

export async function runAgentOnRemoteWorker<TCompletionPayload>(input: {
  sessionId: string;
  handle: AgentHandle;
  task: BoardTask;
  worker: RemoteWorkerDescriptor;
  payload: WorkerTaskPayload;
  bus: MessageBus;
  emitter: EventEmitter;
  registry: RemoteWorkerRegistry;
  callbacks: RemoteDispatchCallbacks<TCompletionPayload>;
}): Promise<string> {
  const transport = input.bus.getTransport();
  const dispatchId = `${input.sessionId}:${input.handle.name}:${input.callbacks.getTaskRunGeneration(input.handle)}:${Date.now()}`;
  if (!transport.isAlive()) {
    const reason = `remote transport is disconnected before dispatch to ${input.worker.id}`;
    input.registry.deregister(input.worker.id);
    input.callbacks.markAgentFailed(new Error(reason), 'remote_transport');
    throw new Error(reason);
  }

  input.registry.markAssigned(input.worker.id);
  input.callbacks.markRemoteRunning(input.handle);

  try {
    input.bus.sendTransportEnvelope('task_dispatch', {
      dispatchId,
      sessionId: input.sessionId,
      workerId: input.worker.id,
      endpoint: input.worker.endpoint,
      taskId: input.task.id,
      agentId: input.handle.agentId,
      agentName: input.handle.name,
      payload: input.payload,
      runtimeContext: {
        systemPrompt: input.payload.systemPrompt,
        toolNames: input.payload.toolNames,
        workspace: input.payload.workspace,
        workingDirectory: input.payload.workingDirectory,
        writeScope: input.payload.writeScope,
        contractPack: input.payload.contractPack,
        contractPackRequired: Boolean(input.payload.contractPack?.entries?.length),
      },
    });
  } catch (error) {
    const reason = `remote dispatch to ${input.worker.id} failed: ${error instanceof Error ? error.message : String(error)}`;
    input.registry.markReleased(input.worker.id);
    input.registry.deregister(input.worker.id);
    input.callbacks.markAgentFailed(new Error(reason), 'remote_dispatch');
    throw error instanceof Error ? error : new Error(reason);
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let disconnectTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      unsubscribe();
      if (disconnectTimer) clearInterval(disconnectTimer);
      input.registry.markReleased(input.worker.id);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    unsubscribe = input.emitter.subscribe('transport:envelope', (envelope) => {
      if (!isMatchingRemoteEnvelope(envelope.payload, dispatchId, input.sessionId, input.handle, input.task)) {
        return;
      }
      const remotePayload = envelope.payload as Record<string, unknown>;
      if (envelope.type === 'heartbeat') {
        input.registry.markHeartbeat(input.worker.id);
        input.handle.lastHeartbeat = Date.now();
        return;
      }
      if (envelope.type === 'task_failed') {
        const errorMessage = typeof remotePayload.error === 'string'
          ? remotePayload.error
          : `remote worker ${input.worker.id} failed task ${input.task.id}`;
        settle(() => {
          input.callbacks.markAgentFailed(new Error(errorMessage), 'remote_worker');
          reject(new Error(errorMessage));
        });
        return;
      }
      if (envelope.type !== 'task_complete') {
        return;
      }

      settle(() => {
        try {
          const completion = input.callbacks.parseCompletion(remotePayload.completion ?? remotePayload.payload ?? remotePayload);
          const completionPayload = input.callbacks.buildCompletionPayload(completion);
          input.callbacks.acceptCompletion(completion, completionPayload);
          resolve(completion.result);
        } catch (error) {
          const protocolError = error instanceof Error ? error : new Error(String(error));
          input.callbacks.markAgentFailed(protocolError, 'remote_protocol');
          reject(protocolError);
        }
      });
    });

    disconnectTimer = setInterval(() => {
      const alive = transport.isAlive()
        && input.registry.getAliveWorkers().some((candidate) => candidate.id === input.worker.id);
      if (alive) {
        return;
      }
      const reason = `remote worker ${input.worker.id} disconnected during task ${input.task.id}`;
      settle(() => {
        input.registry.deregister(input.worker.id);
        input.callbacks.markAgentFailed(new Error(reason), 'remote_worker_disconnect');
        reject(new Error(reason));
      });
    }, 1_000);
    if (disconnectTimer.unref) disconnectTimer.unref();
  });
}
