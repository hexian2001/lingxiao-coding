import type { EventEmitter } from '../../core/EventEmitter.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { TaskBoard } from '../../core/TaskBoard.js';
import type { RemoteWorkerDescriptor, RemoteWorkerRegistry } from '../../core/transport/RemoteWorkerRegistry.js';
import type { AgentHandle } from '../AgentPoolRuntime.js';

export function emitAgentSpawned(input: {
  emitter: EventEmitter;
  sessionId: string;
  taskBoard: TaskBoard;
  handle: AgentHandle;
}): void {
  const task = input.taskBoard.getTask(input.handle.taskId);
  input.emitter.emit('agent:spawned', {
    sessionId: input.sessionId,
    agentId: input.handle.agentId,
    agentName: input.handle.name,
    role: input.handle.displayRole || input.handle.roleType,
    taskId: input.handle.taskId,
    workingDirectory: task?.working_directory,
    writeScope: task?.write_scope,
    baselineRole: input.handle.capabilityDetails?.baselineRole,
    skillNames: input.handle.capabilityDetails?.skillNames,
    droppedTools: input.handle.capabilityDetails?.droppedTools,
    tools: input.handle.capabilityDetails?.tools,
    backend: input.handle.workerBackend || 'worker_process',
    externalSessionId: input.handle.externalSessionId,
    pid: input.handle.externalPid,
    logPath: input.handle.externalDiagnostics?.logPath,
  });
}

export function registerRemoteWorker(input: {
  registry: RemoteWorkerRegistry;
  bus: MessageBus;
  sessionId: string;
  endpoint: string;
  capabilities: string[];
  options?: Partial<Pick<RemoteWorkerDescriptor, 'id' | 'maxConcurrency' | 'region'>>;
}): RemoteWorkerDescriptor {
  const descriptor: RemoteWorkerDescriptor = {
    id: input.options?.id ?? `remote-${input.endpoint.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    endpoint: input.endpoint,
    capabilities: [...input.capabilities],
    maxConcurrency: input.options?.maxConcurrency ?? 1,
    currentLoad: 0,
    region: input.options?.region,
    lastHeartbeat: Date.now(),
  };
  input.registry.register(descriptor);
  input.bus.send(`${input.sessionId}:agent_pool`, 'remote:worker_registry', 'worker_register', descriptor);
  return descriptor;
}
