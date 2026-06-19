export interface LeaderSupervisionConfigInput {
  initialProbeSilenceSeconds: number;
  maxProbeIntervalSeconds: number;
  probeBackoffMultiplier: number;
  idleWarningSeconds: number;
}

export interface LeaderSupervisionConfig extends LeaderSupervisionConfigInput {
  initialProbeSilenceMs: number;
  maxProbeIntervalMs: number;
  idleWarningMs: number;
}

export interface LeaderSupervisionAgentSnapshot {
  agentId: string;
  name: string;
  roleType?: string;
  /** Last meaningful task progress; heartbeats are intentionally excluded. */
  lastActivityAtMs: number;
  /** Last worker heartbeat / process liveness signal. */
  lastHeartbeatAtMs?: number;
}

export interface LeaderSupervisionState {
  lastMeaningfulProgressAtMs?: number;
  lastProbeAtMs?: number;
  probesWithoutProgress: number;
  warnedIdleActivities: Record<string, number>;
}

export type LeaderSupervisionDecision =
  | {
      type: 'wait';
      waitTimeoutMs: number;
      nextIdleWarningAtMs?: number;
    }
  | {
      type: 'warn_idle';
      waitTimeoutMs: number;
      idleAgents: LeaderSupervisionAgentSnapshot[];
    };

export interface LeaderSupervisionEvaluation {
  state: LeaderSupervisionState;
  decision: LeaderSupervisionDecision;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeLeaderSupervisionConfig(
  input: LeaderSupervisionConfigInput,
): LeaderSupervisionConfig {
  const initialProbeSilenceSeconds = clamp(input.initialProbeSilenceSeconds, 10, 300);
  const maxProbeIntervalSeconds = clamp(
    input.maxProbeIntervalSeconds,
    initialProbeSilenceSeconds,
    900,
  );
  const probeBackoffMultiplier = clamp(input.probeBackoffMultiplier, 1.25, 4);
  const idleWarningSeconds = clamp(
    input.idleWarningSeconds,
    Math.max(initialProbeSilenceSeconds, 30),
    1800,
  );

  return {
    initialProbeSilenceSeconds,
    maxProbeIntervalSeconds,
    probeBackoffMultiplier,
    idleWarningSeconds,
    initialProbeSilenceMs: Math.round(initialProbeSilenceSeconds * 1000),
    maxProbeIntervalMs: Math.round(maxProbeIntervalSeconds * 1000),
    idleWarningMs: Math.round(idleWarningSeconds * 1000),
  };
}

export function createLeaderSupervisionState(
  partial: Partial<LeaderSupervisionState> = {},
): LeaderSupervisionState {
  return {
    lastMeaningfulProgressAtMs: partial.lastMeaningfulProgressAtMs,
    lastProbeAtMs: partial.lastProbeAtMs,
    probesWithoutProgress: partial.probesWithoutProgress ?? 0,
    warnedIdleActivities: { ...(partial.warnedIdleActivities || {}) },
  };
}

function cleanupWarnedIdleActivities(
  state: LeaderSupervisionState,
  agents: LeaderSupervisionAgentSnapshot[],
): LeaderSupervisionState {
  const runningIds = new Set(agents.map((agent) => agent.agentId));
  const warnedIdleActivities = Object.fromEntries(
    Object.entries(state.warnedIdleActivities).filter(([agentId]) => runningIds.has(agentId)),
  );

  if (Object.keys(warnedIdleActivities).length === Object.keys(state.warnedIdleActivities).length) {
    return state;
  }

  return {
    ...state,
    warnedIdleActivities,
  };
}

function getProbeIntervalMs(
  config: LeaderSupervisionConfig,
  probesWithoutProgress: number,
  agents: LeaderSupervisionAgentSnapshot[],
): number {
  const exponentialInterval =
    config.initialProbeSilenceMs *
    Math.pow(config.probeBackoffMultiplier, Math.max(0, probesWithoutProgress));
  
  // 更耐心的策略：根据运行中的 Agent 类型调整间隔
  // coding/verify 任务通常需要更长时间，给予 3x 而不是 2x 的宽限
  const hasLongRunningExecutionRole = agents.some((agent) =>
    agent.roleType === 'coding' || agent.roleType === 'verify'
  );
  const roleAdjustedInterval = hasLongRunningExecutionRole
    ? exponentialInterval * 3  // 从 2x 增加到 3x - 更耐心
    : exponentialInterval;
  
  return Math.min(Math.round(roleAdjustedInterval), config.maxProbeIntervalMs);
}

export function recordLeaderSupervisionProgress(
  state: LeaderSupervisionState,
  progressAtMs: number,
): LeaderSupervisionState {
  return {
    ...state,
    lastMeaningfulProgressAtMs: progressAtMs,
    lastProbeAtMs: undefined,
    probesWithoutProgress: 0,
  };
}

export function recordLeaderSupervisionProbe(
  state: LeaderSupervisionState,
  probedAtMs: number,
): LeaderSupervisionState {
  return {
    ...state,
    lastProbeAtMs: probedAtMs,
    probesWithoutProgress: state.probesWithoutProgress + 1,
  };
}

export function evaluateLeaderSupervision(options: {
  agents: LeaderSupervisionAgentSnapshot[];
  nowMs: number;
  config: LeaderSupervisionConfig;
  state: LeaderSupervisionState;
  defaultWaitTimeoutMs?: number;
  consumeIdleWarnings?: boolean;
}): LeaderSupervisionEvaluation {
  const {
    agents,
    nowMs,
    config,
    state,
    defaultWaitTimeoutMs = 30000,
    consumeIdleWarnings = true,
  } = options;

  let nextState = cleanupWarnedIdleActivities(state, agents);

  if (agents.length === 0) {
    return {
      state: nextState,
      decision: {
        type: 'wait',
        waitTimeoutMs: defaultWaitTimeoutMs,
        nextIdleWarningAtMs: nowMs + defaultWaitTimeoutMs,
      },
    };
  }

  const latestActivityAtMs = Math.max(...agents.map((agent) => agent.lastActivityAtMs));
  if (
    nextState.lastMeaningfulProgressAtMs === undefined ||
    latestActivityAtMs > nextState.lastMeaningfulProgressAtMs
  ) {
    nextState = recordLeaderSupervisionProgress(nextState, latestActivityAtMs);
  }

  const idleAgents = agents.filter((agent) => {
    const warnedAt = nextState.warnedIdleActivities[agent.agentId];
    return (
      nowMs - agent.lastActivityAtMs >= config.idleWarningMs &&
      warnedAt !== agent.lastActivityAtMs
    );
  });

  if (idleAgents.length > 0) {
    if (consumeIdleWarnings) {
      nextState = {
        ...nextState,
        warnedIdleActivities: {
          ...nextState.warnedIdleActivities,
          ...Object.fromEntries(idleAgents.map((agent) => [agent.agentId, agent.lastActivityAtMs])),
        },
      };
    }
    return {
      state: nextState,
      decision: {
        type: 'warn_idle',
        waitTimeoutMs: 0,
        idleAgents,
      },
    };
  }

  const nextProbeIntervalMs = getProbeIntervalMs(config, nextState.probesWithoutProgress, agents);
  const probeAnchorMs =
    nextState.probesWithoutProgress > 0 && nextState.lastProbeAtMs !== undefined
      ? nextState.lastProbeAtMs
      : (nextState.lastMeaningfulProgressAtMs ?? nowMs);
  const nextProbeAtMs = probeAnchorMs + nextProbeIntervalMs;

  const nextIdleWarningAtMs = agents.reduce<number>((soonest, agent) => {
    if (nextState.warnedIdleActivities[agent.agentId] === agent.lastActivityAtMs) {
      return soonest;
    }
    return Math.min(soonest, agent.lastActivityAtMs + config.idleWarningMs);
  }, Number.POSITIVE_INFINITY);

  const nextWakeAtMs =
    nowMs >= nextProbeAtMs ? nextIdleWarningAtMs : Math.min(nextProbeAtMs, nextIdleWarningAtMs);
  const waitTimeoutMs = Number.isFinite(nextWakeAtMs)
    ? Math.max(0, nextWakeAtMs - nowMs)
    : defaultWaitTimeoutMs;

  return {
    state: nextState,
    decision: {
      type: 'wait',
      waitTimeoutMs,
      nextIdleWarningAtMs: Number.isFinite(nextIdleWarningAtMs) ? nextIdleWarningAtMs : undefined,
    },
  };
}
