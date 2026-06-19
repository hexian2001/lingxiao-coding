/**
 * WorkerRoutes — Worker/进程管理路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { SessionRuntimeState } from '../core/SessionRuntimeState.js';
import type { InteractionTurnState } from '../core/TurnCoordinator.js';
import { deriveRuntimeWaitGate, runtimeImpliesBusy } from '../core/StateSemantics.js';
import type { AgentHandle } from '../contracts/types/Agent.js';
import type { AuthFn } from './types.js';
import { killProcess } from '../utils/platform.js';

type LeaderWorkerStatus = 'running' | 'waiting' | 'permission' | 'review' | 'idle' | 'unknown';

type InteractionRuntimeSnapshot = {
  runtimeState: SessionRuntimeState;
  turn: InteractionTurnState;
};

type WorkerRouteRow = {
  id: string;
  kind: string;
  status: LeaderWorkerStatus;
  sessionId: string;
  startedAt?: string;
	  runtimeState?: SessionRuntimeState;
	  turn?: InteractionTurnState;
	  statusReason?: string;
  statusSource?: 'runtime_state' | 'unknown';
  name?: string;
  taskId?: string;
  iteration?: number;
  toolCalls?: number;
  backend?: NonNullable<AgentHandle['workerBackend']>;
  externalSessionId?: string;
  pid?: number;
  logPath?: string;
  stderrTail?: string[];
  stdoutTail?: string[];
  recoverable?: boolean;
  recoveryAction?: string;
  lastHeartbeat?: number;
  lastProgress?: number;
};

function deriveLeaderWorkerStatus(
  interaction: InteractionRuntimeSnapshot | null,
): LeaderWorkerStatus {
  if (!interaction) return 'unknown';
  const { runtimeState } = interaction;
  const waitGate = deriveRuntimeWaitGate(runtimeState);

  if (waitGate?.kind === 'permission') {
    return 'permission';
  }
  if (waitGate?.kind === 'review') {
    return 'review';
  }
  if (waitGate?.kind === 'waiting') {
    return 'waiting';
  }
  if (runtimeImpliesBusy({ runtimeState, turn: interaction.turn })) {
    return 'running';
  }
  return 'idle';
}

export function registerWorkerRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    sessionManager: SessionManager;
    requireServerToken: AuthFn;
  },
): void {
  const { repos, sessionManager, requireServerToken } = deps;

  // Workers (real agent data from SessionManager)
  fastify.get('/api/v1/workers', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const workers: WorkerRouteRow[] = [];
    for (const sessionId of sessionManager.getActiveSessionIds()) {
      const session = sessionManager.getSession(sessionId);
      if (!session) continue;
      // Leader as primary worker
      const dbSession = repos.sessions.get(sessionId);
      const interaction = (
        sessionManager as unknown as {
          getInteractionRuntimeState?: (id: string) => InteractionRuntimeSnapshot | null;
        }
      ).getInteractionRuntimeState?.(sessionId) ?? null;
      const leaderStatus = deriveLeaderWorkerStatus(interaction);
	      const leaderRuntimeFields: Partial<WorkerRouteRow> = interaction ? {
	        runtimeState: interaction.runtimeState,
	        turn: interaction.turn,
	        statusReason: interaction.turn.summary,
	        statusSource: 'runtime_state',
      } : {
        statusReason: 'runtime_state_unavailable',
        statusSource: 'unknown',
      };
      workers.push({
        id: `leader-${sessionId}`,
        kind: 'leader',
        status: leaderStatus,
        sessionId,
        startedAt: dbSession?.created_at ? new Date(dbSession.created_at * 1000).toISOString() : new Date().toISOString(),
        ...leaderRuntimeFields,
      });
      // Running agents
      try {
        const running: AgentHandle[] = session.pool?.getRunning?.() ?? [];
        for (const handle of running) {
          workers.push({
            id: handle.agentId,
            kind: handle.roleType || 'worker',
            status: 'running',
            sessionId,
            name: handle.name,
            taskId: handle.taskId,
            iteration: handle.iteration,
            toolCalls: handle.toolCalls,
            backend: handle.workerBackend || 'worker_process',
            externalSessionId: handle.externalSessionId,
            pid: handle.externalPid,
            logPath: handle.externalDiagnostics?.logPath,
            stderrTail: handle.externalDiagnostics?.stderrTail?.slice(-5),
            stdoutTail: handle.externalDiagnostics?.stdoutTail?.slice(-5),
            recoverable: handle.externalDiagnostics?.recoverable,
            recoveryAction: handle.externalDiagnostics?.recoveryAction,
            lastHeartbeat: handle.lastHeartbeat,
            lastProgress: handle.lastProgress,
          });
        }
      } catch {/* expected: best-effort cleanup */}
    }
    return { data: workers };
  });

  fastify.get('/api/v1/processes', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { PidRegistry } = await import('../core/PidRegistry.js');
    return { data: PidRegistry.listAll() };
  });

  fastify.delete('/api/v1/processes/:pid', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { pid } = request.params as { pid: string };
    const pidNum = parseInt(pid, 10);
    if (isNaN(pidNum)) {
      reply.status(400);
      return { error: 'Invalid PID' };
    }
    const { PidRegistry } = await import('../core/PidRegistry.js');
    const entry = PidRegistry.findByPid(pidNum);
    if (!entry) {
      reply.status(403);
      return { error: 'PID not managed by Lingxiao' };
    }
    try {
      await killProcess(pidNum, 'SIGTERM', { tree: true });
    } catch {/* expected: best-effort cleanup */}
    PidRegistry.unregister(pidNum);
    return { success: true };
  });

  fastify.delete('/api/v1/workers/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    if (id.startsWith('leader-')) {
      const sessionId = id.replace('leader-', '');
      await sessionManager.interruptSession(sessionId);
    } else {
      for (const sid of sessionManager.getActiveSessionIds()) {
        const session = sessionManager.getSession(sid);
        if (!session) continue;
        try {
          const running: AgentHandle[] = session.pool?.getRunning?.() ?? [];
          const handle = running.find((h) => h.agentId === id);
          if (handle) {
            session.pool?.stopAgent(handle.name);
            break;
          }
        } catch {/* expected: best-effort cleanup */}
      }
    }
    return { success: true };
  });
}
