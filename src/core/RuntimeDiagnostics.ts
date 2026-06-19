import type { DatabaseManager, AgentState, Task as DbTask } from './Database.js';
import { loadEffectivePermissionContext } from './PermissionStore.js';
import { normalizeToolPermissionContext, summarizePermissionContextForDisplay } from './PermissionSystem.js';
import { collectAvailableSkills, formatSkillSourceLabel } from './SkillCatalog.js';
import { getSessionScopeDescription } from '../contracts/adapters/SessionScope.js';
import { listRecoveryRecords } from './RecoveryRecords.js';
import { ProjectRuntimeManager } from './ProjectRuntimeManager.js';
import { EternalRuntimeTelemetry } from './EternalRuntimeTelemetry.js';
import { ProjectRetentionPolicy } from './ProjectRetentionPolicy.js';
import { BlockedAgingPolicy } from '../contracts/adapters/BlockedAgingPolicy.js';
import { SESSION_KEYS } from './SessionStateKeys.js';
import {
  isProjectBacklogTerminalStatus,
  isProjectDependencyTerminalStatus,
  isTaskTerminalStatus,
  normalizeAgentStatus,
  normalizeProjectRuntimeMode,
  normalizeTaskStatus,
} from './StateSemantics.js';
import { globalTracer, summarizeSpans, type TraceSummary } from './Tracing.js';

interface RuntimeSessionView {
  status: string;
  board?: {
    getStats(): {
      total: number;
      dispatchableRaw: number;
      ready: number;
      blocked: number;
      running: number;
      terminal: number;
      completed: number;
      failed: number;
      cancelled: number;
      timeout: number;
    };
  };
  pool?: {
    getStatus(): { total: number; running: number; completed: number; failed: number; interrupted?: number };
    getRunning(): Array<{ name: string; roleType: string; taskId: string }>;
  };
}

export interface BuildRuntimeDiagnosticsOptions {
  db: Pick<DatabaseManager,
    'getSession' | 'getSessionState' | 'listSessionStateByPrefix' | 'getTasksBySession' | 'getAgentStates' | 'getTokenSummary'>;
  workspace: string;
  sessionId?: string;
  session?: RuntimeSessionView;
  detectSandboxCapabilities?: () => {
    bubblewrapAvailable: boolean;
    bubblewrapSupportsNetworkIsolation: boolean;
  };
}

export interface RuntimeDiagnosticsPayload {
  workspace: string;
  sessionId?: string;
  sessionStatus: string;
  scopeDescription: string;
  leaderMode?: string;
  leaderReason?: string;
  permissionSummary: string;
  bubblewrapAvailable: boolean;
  bubblewrapSupportsNetworkIsolation: boolean;
  skillsTotal: number;
  skillCounts: Array<{ source: string; count: number }>;
  skillExamples: string[];
  taskStats: Record<string, number>;
  agentStats: { total: number; running: number; completed: number; failed: number; interrupted: number };
  runningAgents: Array<{ name: string; roleType: string; taskId: string }>;
  totalTokens: number;
  tokenSummary: Array<{ name: string; total: number }>;
  recoveryStats: {
    total: number;
    recovering: number;
    blocked: number;
    latestReason?: string;
  };
  recoveringTasks: Array<{
    taskId: string;
    agentName: string;
    category: string;
    faultClass: string;
    recoveryAction: string;
    status: string;
  }>;
  orchestrationProject?: {
    projectId: string;
    mode: string;
    priority?: string;
    dependencyCount: number;
    unresolvedDependencies: number;
    backlogRemaining: number;
    auditEntries: number;
    latestAudit?: string;
    staleRejected: number;
    schedulerSwitchCount: number;
    trendSamples?: number;
    trendDeltas?: {
      repairs: number;
      resets: number;
      blockedDurationMs: number;
      staleRejected: number;
      schedulerSwitches: number;
    };
    retentionState?: string;
    blockedAgingSeverity?: string;
  };
}

export interface RuntimeDiagnosticsItem {
  id: string;
  status?: string;
  preview: string;
  detail: string;
}

export function recentTraces(n: number): TraceSummary[] {
  const limit = Math.max(0, Math.floor(n));
  return summarizeSpans(globalTracer.recent(limit * 20)).slice(0, limit);
}

function buildTaskStats(tasks: DbTask[]): Record<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // 诊断面板直接读 DB 快照，必须通过中心语义把 terminal+exit_reason 还原成 completed/failed/cancelled。
  const isCompleted = (task: DbTask | undefined): boolean => normalizeTaskStatus(task) === 'completed';
  const isReady = (task: DbTask): boolean => {
    if (task.status !== 'dispatchable') return false;
    for (const depId of task.blocked_by || []) {
      if (!isCompleted(byId.get(depId))) return false;
    }
    return true;
  };
  const dispatchableRaw = tasks.filter((task) => task.status === 'dispatchable');
  const ready = dispatchableRaw.filter(isReady);
  return {
    total: tasks.length,
    dispatchableRaw: dispatchableRaw.length,
    ready: ready.length,
    blocked: dispatchableRaw.length - ready.length,
    running: tasks.filter((task) => normalizeTaskStatus(task) === 'running').length,
    terminal: tasks.filter((task) => isTaskTerminalStatus(task)).length,
    completed: tasks.filter((task) => normalizeTaskStatus(task) === 'completed').length,
    failed: tasks.filter((task) => normalizeTaskStatus(task) === 'failed').length,
    cancelled: tasks.filter((task) => normalizeTaskStatus(task) === 'cancelled').length,
    timeout: tasks.filter((task) => task.status === 'terminal' && task.exit_reason === 'timeout').length,
  };
}

function buildAgentStats(states: AgentState[]): {
  total: number;
  running: number;
  completed: number;
  failed: number;
  interrupted: number;
} {
  return {
    total: states.length,
    running: states.filter((state) => normalizeAgentStatus(state.status) === 'running').length,
    completed: states.filter((state) => normalizeAgentStatus(state.status) === 'completed').length,
    failed: states.filter((state) => normalizeAgentStatus(state.status) === 'failed').length,
    interrupted: states.filter((state) => normalizeAgentStatus(state.status) === 'interrupted').length,
  };
}

export function buildRuntimeDiagnosticsPayload(options: BuildRuntimeDiagnosticsOptions): RuntimeDiagnosticsPayload {
  const { db, workspace, sessionId, session } = options;
  const sessionInfo = sessionId ? db.getSession(sessionId) : null;
  const tasks = sessionId ? db.getTasksBySession(sessionId) : [];
  const taskStats = session?.board?.getStats() || buildTaskStats(tasks);
  const agentStates = sessionId ? db.getAgentStates(sessionId) : [];
  const poolStats = session?.pool?.getStatus();
  const agentStats = poolStats
    ? {
      ...poolStats,
      interrupted: (poolStats as { interrupted?: number }).interrupted ?? 0,
    }
    : buildAgentStats(agentStates);
  const runningAgents = session?.pool?.getRunning() || [];
  const tokenSummary = sessionId ? db.getTokenSummary(sessionId) : [];
  const totalTokens = tokenSummary.reduce((sum, item) => sum + (item.total || 0), 0);
  const recoveryRecords = sessionId && 'listSessionStateByPrefix' in db
    ? listRecoveryRecords(db as DatabaseManager, sessionId)
    : [];
  const skills = collectAvailableSkills(workspace);
  const skillCounts = new Map<string, number>();
  for (const skill of skills) {
    const label = formatSkillSourceLabel(skill.source);
    skillCounts.set(label, (skillCounts.get(label) || 0) + 1);
  }

  const permissionContext = sessionId
    ? loadEffectivePermissionContext(db as DatabaseManager, workspace, sessionId)
    : normalizeToolPermissionContext(null);
  const sandboxCaps = options.detectSandboxCapabilities?.() ?? {
    bubblewrapAvailable: false,
    bubblewrapSupportsNetworkIsolation: false,
  };
  const leaderMode = sessionId ? db.getSessionState(sessionId, SESSION_KEYS.LEADER_EXECUTION_MODE) : null;
  const leaderReason = sessionId ? db.getSessionState(sessionId, SESSION_KEYS.LEADER_EXECUTION_REASON) : null;
  const orchestrationRuntime = sessionId ? db.getSessionState(sessionId, `orchestration_runtime:${sessionId}`) : null;
  let orchestrationProject: RuntimeDiagnosticsPayload['orchestrationProject'];
  if (orchestrationRuntime && typeof orchestrationRuntime === 'string') {
    try {
      const parsed = JSON.parse(orchestrationRuntime) as { projectId?: string };
      if (parsed.projectId) {
        const runtimeManager = new ProjectRuntimeManager(workspace);
        const telemetry = new EternalRuntimeTelemetry(workspace);
        const record = runtimeManager.loadProject(parsed.projectId);
        const metrics = telemetry.loadMetrics(parsed.projectId);
        const audit = telemetry.loadAudit(parsed.projectId);
        const trends = telemetry.summarizeTrends(parsed.projectId);
        if (record) {
          const runtimeMode = normalizeProjectRuntimeMode(record.state.mode);
          const retention = new ProjectRetentionPolicy().evaluate({
            completedAt: runtimeMode === 'completed' ? record.state.lastActionAt * 1000 : undefined,
            archivedAt: runtimeMode === 'archived' ? record.state.lastActionAt * 1000 : undefined,
            transferCount: 0,
            auditCount: audit.length,
            trendSamples: trends.samples,
          });
          const blockedAging = new BlockedAgingPolicy().evaluate({
            blockedSinceAt: runtimeMode === 'blocked' || runtimeMode === 'waiting'
              ? record.state.lastActionAt * 1000
              : undefined,
          });
          orchestrationProject = {
            projectId: parsed.projectId,
            mode: record.state.mode,
            priority: typeof record.metadata?.priority === 'string' ? record.metadata.priority : undefined,
            dependencyCount: record.dependencyLedger.entries.length,
            unresolvedDependencies: record.dependencyLedger.entries.filter((entry) => !isProjectDependencyTerminalStatus(entry.status)).length,
            backlogRemaining: record.backlog.filter((item) => !isProjectBacklogTerminalStatus(item.status)).length,
            auditEntries: audit.length,
            latestAudit: audit.at(-1)?.summary,
            staleRejected: metrics.staleResultRejected,
            schedulerSwitchCount: metrics.schedulerSwitchCount,
            trendSamples: trends.samples,
            trendDeltas: trends.deltas,
            retentionState: retention.state,
            blockedAgingSeverity: blockedAging.severity,
          };
        }
      }
    } catch {
      // ignore malformed orchestration runtime state
    }
  }

  return {
    workspace,
    sessionId,
    sessionStatus: sessionInfo ? sessionInfo.status : (session?.status || 'idle'),
    scopeDescription: getSessionScopeDescription(workspace, sessionId),
    leaderMode: typeof leaderMode === 'string' ? leaderMode : undefined,
    leaderReason: typeof leaderReason === 'string' && leaderReason ? leaderReason : undefined,
    permissionSummary: summarizePermissionContextForDisplay(permissionContext),
    bubblewrapAvailable: sandboxCaps.bubblewrapAvailable,
    bubblewrapSupportsNetworkIsolation: sandboxCaps.bubblewrapSupportsNetworkIsolation,
    skillsTotal: skills.length,
    skillCounts: Array.from(skillCounts.entries()).map(([source, count]) => ({ source, count })),
    skillExamples: skills.slice(0, 8).map((skill) => skill.name),
    taskStats,
    agentStats,
    runningAgents,
    totalTokens,
    tokenSummary: tokenSummary.map((row) => ({
      name: row.agent_name || row.agent_id,
      total: row.total,
    })),
    recoveryStats: {
      total: recoveryRecords.length,
      recovering: recoveryRecords.filter((record) => record.status === 'recovering').length,
      blocked: recoveryRecords.filter((record) => record.status === 'blocked').length,
      latestReason: recoveryRecords[0]?.reason,
    },
    recoveringTasks: recoveryRecords.map((record) => ({
      taskId: record.taskId,
      agentName: record.agentName,
      category: record.category,
      faultClass: record.faultClass,
      recoveryAction: record.recoveryAction,
      status: record.status,
    })),
    orchestrationProject,
  };
}

export function renderRuntimeDiagnostics(payload: RuntimeDiagnosticsPayload): string {
  const recoveringTasks = payload.recoveringTasks.filter((task) => task.status === 'recovering');
  const blockedRecoveries = payload.recoveringTasks.filter((task) => task.status === 'blocked');
  const interruptedAgents = payload.agentStats.interrupted || 0;
  return [
    '# Runtime Doctor',
    '',
    '## Session',
    payload.scopeDescription,
    `状态: ${payload.sessionStatus}`,
    payload.sessionStatus === 'interrupted' ? 'Interrupted: yes' : '',
    payload.leaderMode ? `Leader mode: ${payload.leaderMode}` : '',
    payload.leaderReason ? `Leader reason: ${payload.leaderReason}` : '',
    '',
    '## Permissions / Sandbox',
    `Effective permission: ${payload.permissionSummary}`,
    `bubblewrap available: ${payload.bubblewrapAvailable ? 'yes' : 'no'}`,
    '',
    '## Skills',
    `Total skills: ${payload.skillsTotal}`,
    payload.skillCounts.length > 0
      ? `By source: ${payload.skillCounts.map((item) => `${item.source}=${item.count}`).join(', ')}`
      : 'By source: none',
    payload.skillExamples.length > 0 ? `Examples: ${payload.skillExamples.join(', ')}` : 'Examples: none',
    '',
    '## Tasks',
    `total=${payload.taskStats.total || 0} dispatchableRaw=${payload.taskStats.dispatchableRaw || 0} ready=${payload.taskStats.ready || 0} blocked=${payload.taskStats.blocked || 0} running=${payload.taskStats.running || 0} terminal=${payload.taskStats.terminal || 0} (completed=${payload.taskStats.completed || 0} failed=${payload.taskStats.failed || 0} cancelled=${payload.taskStats.cancelled || 0} timeout=${payload.taskStats.timeout || 0})`,
    '',
    '## Agents',
    `total=${payload.agentStats.total} running=${payload.agentStats.running} completed=${payload.agentStats.completed} failed=${payload.agentStats.failed} interrupted=${payload.agentStats.interrupted || 0}`,
    interruptedAgents > 0 ? `Interrupted agents: ${interruptedAgents}` : '',
    payload.runningAgents.length > 0
      ? `Running: ${payload.runningAgents.map((agent) => `@${agent.name}(${agent.roleType}) -> ${agent.taskId}`).join(', ')}`
      : 'Running: none',
    '',
    '## Recovery',
    payload.recoveryStats.total > 0
      ? [
        `total=${payload.recoveryStats.total} recovering=${payload.recoveryStats.recovering} blocked=${payload.recoveryStats.blocked}`,
        payload.recoveryStats.latestReason ? `latest_reason=${payload.recoveryStats.latestReason}` : '',
        `Recovering: ${recoveringTasks.map((task) => `[${task.taskId}] @${task.agentName} ${task.category}/${task.faultClass} -> ${task.recoveryAction}`).join(', ') || 'none'}`,
        `Blocked: ${blockedRecoveries.map((task) => `[${task.taskId}] @${task.agentName} ${task.category}/${task.faultClass} -> ${task.recoveryAction}`).join(', ') || 'none'}`,
      ].filter(Boolean).join('\n')
      : 'Recovering: none',
    '',
    '## Tokens',
    `Session total: ${payload.totalTokens}`,
    payload.tokenSummary.length > 0
      ? payload.tokenSummary.map((row) => `- ${row.name}: ${row.total}`).join('\n')
      : 'No token usage recorded.',
    '',
    '## Eternal Orchestration',
    payload.orchestrationProject
      ? [
          `project=${payload.orchestrationProject.projectId} mode=${payload.orchestrationProject.mode}${payload.orchestrationProject.priority ? ` priority=${payload.orchestrationProject.priority}` : ''}`,
          `dependencies=${payload.orchestrationProject.unresolvedDependencies}/${payload.orchestrationProject.dependencyCount} unresolved`,
          `backlog_remaining=${payload.orchestrationProject.backlogRemaining}`,
          `audit_entries=${payload.orchestrationProject.auditEntries} stale_rejected=${payload.orchestrationProject.staleRejected} scheduler_switches=${payload.orchestrationProject.schedulerSwitchCount}`,
          payload.orchestrationProject.latestAudit ? `latest_audit=${payload.orchestrationProject.latestAudit}` : '',
          payload.orchestrationProject.trendSamples !== undefined ? `trend_samples=${payload.orchestrationProject.trendSamples}` : '',
          payload.orchestrationProject.trendDeltas
            ? `trend_deltas=repairs:${payload.orchestrationProject.trendDeltas.repairs},resets:${payload.orchestrationProject.trendDeltas.resets},stale:${payload.orchestrationProject.trendDeltas.staleRejected},switches:${payload.orchestrationProject.trendDeltas.schedulerSwitches}`
            : '',
          payload.orchestrationProject.retentionState ? `retention_state=${payload.orchestrationProject.retentionState}` : '',
          payload.orchestrationProject.blockedAgingSeverity ? `blocked_aging=${payload.orchestrationProject.blockedAgingSeverity}` : '',
        ].join('\n')
      : 'No orchestration project bound.',
  ].filter(Boolean).join('\n');
}

export function buildRuntimeDiagnosticsItems(payload: RuntimeDiagnosticsPayload): RuntimeDiagnosticsItem[] {
  const recoveringTasks = payload.recoveringTasks.filter((task) => task.status === 'recovering');
  const blockedRecoveries = payload.recoveringTasks.filter((task) => task.status === 'blocked');
  return [
    {
      id: 'session',
      status: payload.sessionStatus,
      preview: `${payload.sessionId || '未绑定'} · ${payload.workspace}`,
      detail: [
        '[Session]',
        payload.scopeDescription,
        `状态: ${payload.sessionStatus}`,
        payload.sessionStatus === 'interrupted' ? 'Interrupted: yes' : '',
        payload.leaderMode ? `Leader mode: ${payload.leaderMode}` : '',
        payload.leaderReason ? `Leader reason: ${payload.leaderReason}` : '',
      ].filter(Boolean).join('\n'),
    },
    {
      id: 'permission',
      status: payload.permissionSummary,
      preview: payload.permissionSummary,
      detail: [
        '[Permissions / Sandbox]',
        `Effective permission: ${payload.permissionSummary}`,
        `bubblewrap available: ${payload.bubblewrapAvailable ? 'yes' : 'no'}`,
      ].join('\n'),
    },
    {
      id: 'skills',
      status: `${payload.skillsTotal} skills`,
      preview: payload.skillCounts.map((item) => `${item.source}=${item.count}`).join(', ') || '(none)',
      detail: [
        '[Skills]',
        `Total skills: ${payload.skillsTotal}`,
        payload.skillCounts.length > 0
          ? `By source: ${payload.skillCounts.map((item) => `${item.source}=${item.count}`).join(', ')}`
          : 'By source: none',
        payload.skillExamples.length > 0 ? `Examples: ${payload.skillExamples.join(', ')}` : 'Examples: none',
      ].join('\n'),
    },
    {
      id: 'tasks',
      status: `${payload.taskStats.total} total`,
      preview: `ready=${payload.taskStats.ready || 0} blocked=${payload.taskStats.blocked || 0} running=${payload.taskStats.running || 0} completed=${payload.taskStats.completed || 0}`,
      detail: [
        '[Tasks]',
        `total=${payload.taskStats.total || 0} dispatchableRaw=${payload.taskStats.dispatchableRaw || 0} ready=${payload.taskStats.ready || 0} blocked=${payload.taskStats.blocked || 0} running=${payload.taskStats.running || 0} terminal=${payload.taskStats.terminal || 0} (completed=${payload.taskStats.completed || 0} failed=${payload.taskStats.failed || 0} cancelled=${payload.taskStats.cancelled || 0} timeout=${payload.taskStats.timeout || 0})`,
      ].join('\n'),
    },
    {
      id: 'agents',
      status: `${payload.agentStats.running} running`,
      preview: payload.runningAgents.length > 0
        ? payload.runningAgents.map((agent) => `@${agent.name}`).join(', ')
        : 'running: none',
      detail: [
        '[Agents]',
        `total=${payload.agentStats.total} running=${payload.agentStats.running} completed=${payload.agentStats.completed} failed=${payload.agentStats.failed} interrupted=${payload.agentStats.interrupted || 0}`,
        payload.runningAgents.length > 0
          ? `Running: ${payload.runningAgents.map((agent) => `@${agent.name}(${agent.roleType}) -> ${agent.taskId}`).join(', ')}`
          : 'Running: none',
      ].join('\n'),
    },
    {
      id: 'recovery',
      status: `${payload.recoveryStats.recovering || 0} recovering`,
      preview: payload.recoveryStats.total > 0
        ? `recovering=${payload.recoveryStats.recovering || 0}`
        : 'none',
      detail: payload.recoveryStats.total > 0
        ? [
          '[Recovery]',
          `total=${payload.recoveryStats.total} recovering=${payload.recoveryStats.recovering} blocked=${payload.recoveryStats.blocked}`,
          payload.recoveryStats.latestReason ? `latest_reason=${payload.recoveryStats.latestReason}` : '',
          `Recovering: ${recoveringTasks.map((task) => `[${task.taskId}] @${task.agentName} ${task.category}/${task.faultClass} -> ${task.recoveryAction}`).join(', ') || 'none'}`,
          `Blocked: ${blockedRecoveries.map((task) => `[${task.taskId}] @${task.agentName} ${task.category}/${task.faultClass} -> ${task.recoveryAction}`).join(', ') || 'none'}`,
        ].filter(Boolean).join('\n')
        : '[Recovery]\nRecovering: none',
    },
    {
      id: 'tokens',
      status: `${payload.totalTokens} total`,
      preview: payload.tokenSummary.slice(0, 3).map((row) => `${row.name}=${row.total}`).join(', ') || 'none',
      detail: [
        '[Tokens]',
        `Session total: ${payload.totalTokens}`,
        payload.tokenSummary.length > 0
          ? payload.tokenSummary.map((row) => `- ${row.name}: ${row.total}`).join('\n')
          : 'No token usage recorded.',
      ].join('\n'),
    },
    {
      id: 'orchestration',
      status: payload.orchestrationProject?.mode || 'unbound',
      preview: payload.orchestrationProject
        ? `${payload.orchestrationProject.projectId} · unresolved=${payload.orchestrationProject.unresolvedDependencies} · backlog=${payload.orchestrationProject.backlogRemaining}`
        : 'No orchestration project bound.',
      detail: payload.orchestrationProject
        ? [
            '[Eternal Orchestration]',
            `project=${payload.orchestrationProject.projectId}`,
            `mode=${payload.orchestrationProject.mode}`,
            payload.orchestrationProject.priority ? `priority=${payload.orchestrationProject.priority}` : '',
            `dependencies=${payload.orchestrationProject.unresolvedDependencies}/${payload.orchestrationProject.dependencyCount} unresolved`,
            `backlog_remaining=${payload.orchestrationProject.backlogRemaining}`,
            `audit_entries=${payload.orchestrationProject.auditEntries}`,
            payload.orchestrationProject.latestAudit ? `latest_audit=${payload.orchestrationProject.latestAudit}` : '',
            `stale_rejected=${payload.orchestrationProject.staleRejected}`,
            `scheduler_switches=${payload.orchestrationProject.schedulerSwitchCount}`,
            payload.orchestrationProject.trendSamples !== undefined ? `trend_samples=${payload.orchestrationProject.trendSamples}` : '',
            payload.orchestrationProject.trendDeltas
              ? `trend_deltas=repairs:${payload.orchestrationProject.trendDeltas.repairs},resets:${payload.orchestrationProject.trendDeltas.resets},stale:${payload.orchestrationProject.trendDeltas.staleRejected},switches:${payload.orchestrationProject.trendDeltas.schedulerSwitches}`
              : '',
            payload.orchestrationProject.retentionState ? `retention_state=${payload.orchestrationProject.retentionState}` : '',
            payload.orchestrationProject.blockedAgingSeverity ? `blocked_aging=${payload.orchestrationProject.blockedAgingSeverity}` : '',
          ].filter(Boolean).join('\n')
        : '[Eternal Orchestration]\nNo orchestration project bound.',
    },
  ];
}

function buildRuntimeDiagnostics(options: BuildRuntimeDiagnosticsOptions): string {
  return renderRuntimeDiagnostics(buildRuntimeDiagnosticsPayload(options));
}
