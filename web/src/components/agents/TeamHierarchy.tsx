/**
 * TeamHierarchy — Tier 2 of CommandCenter: Leader → Task → Worker tree view
 *
 * Shows:
 * - Leader status (role badge, context window)
 * - Task board entries (with semantic display state from backend)
 * - Worker agents spawned per task
 */

import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore, subscribeTaskUpdates } from '../../stores/sessionStore';
import type { AgentConversation } from '../../stores/sessionStore';
import { normalizeAgentStatus, normalizeTaskDisplayState } from '../../stores/sessionStoreHelpers.ts';
import { getServerToken } from '../../api/headers';
import {
  Crown, Users, ChevronRight, Loader2, CheckCircle2,
  XCircle, Clock, Circle, Zap, AlertTriangle,
} from 'lucide-react';

const STATUS_ICON = {
  idle:        { icon: Circle,     cls: 'text-text-tertiary',             badgeCls: 'bg-bg-secondary text-text-tertiary' },
  running:     { icon: Loader2,    cls: 'text-accent-brand animate-spin',  badgeCls: 'bg-accent-brand/10 text-accent-brand' },
  recovering:  { icon: Loader2,    cls: 'text-accent-blue animate-spin',   badgeCls: 'bg-accent-blue/10 text-accent-blue' },
  completed:   { icon: CheckCircle2, cls: 'text-accent-green',              badgeCls: 'bg-accent-green/10 text-accent-green' },
  failed:      { icon: XCircle,    cls: 'text-accent-red',                badgeCls: 'bg-accent-red/10 text-accent-red' },
  interrupted: { icon: Clock,      cls: 'text-accent-yellow',             badgeCls: 'bg-accent-yellow/10 text-accent-yellow' },
} as const;

const DISPLAY_STATE_CONFIG = {
  pending:       { label: '待分配',  cls: 'text-text-tertiary',  dot: 'bg-text-tertiary' },
  dispatchable:  { label: '可调度',  cls: 'text-accent-blue',   dot: 'bg-accent-blue' },
  running:       { label: '运行中',  cls: 'text-accent-brand',  dot: 'bg-accent-brand animate-pulse' },
  completed:     { label: '已完成',  cls: 'text-accent-green',  dot: 'bg-accent-green' },
  failed:        { label: '已失败',  cls: 'text-accent-red',    dot: 'bg-accent-red' },
  cancelled:     { label: '已取消',  cls: 'text-accent-yellow', dot: 'bg-accent-yellow' },
  blocked:       { label: '阻塞中',  cls: 'text-accent-yellow', dot: 'bg-accent-yellow' },
} as const;

type TaskDisplayState = keyof typeof DISPLAY_STATE_CONFIG;
type TaskUpdateCallback = Parameters<typeof subscribeTaskUpdates>[0];
type TaskUpdatePayload = Parameters<TaskUpdateCallback>[0];
type TaskUpdateAction = Parameters<TaskUpdateCallback>[1];

interface TaskInfo {
  id: string;
  subject?: string;
  displayState?: TaskDisplayState;
  status?: string;
  exitReason?: string;
  assigned_agent?: string;
  blocked_by?: string[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function TaskDisplayBadge({ state }: { state: string }) {
  const cfg = DISPLAY_STATE_CONFIG[state as keyof typeof DISPLAY_STATE_CONFIG] ?? DISPLAY_STATE_CONFIG.pending;
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-mono ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function AgentDot({ conv }: { conv: AgentConversation }) {
  const status = normalizeAgentStatus(conv.status);
  const cfg = STATUS_ICON[status];
  const Icon = cfg.icon;
  const tokens = conv.tokenUsage;
  return (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] ${cfg.badgeCls}`}>
      <Icon size={9} className={`${cfg.cls} shrink-0`} />
      <span className="truncate max-w-[60px]">{conv.agentName}</span>
      {tokens && tokens.total > 0 && (
        <span className="opacity-60 font-mono text-[9px]">{formatTokens(tokens.total)}</span>
      )}
    </div>
  );
}

function LeaderRow() {
  const { t } = useTranslation();
  const contextRuntimeState = useSessionStore((s) => s.contextRuntimeState);
  const phase = useSessionStore((s) => s.phase);
  const leaderStatusText = useSessionStore((s) => s.leaderStatusText);
  const tokenUsage = useSessionStore((s) => s.tokenUsage);

  const phaseLabel: Record<string, string> = {
    idle: t('teamHierarchy.phase.idle'), streaming: t('teamHierarchy.phase.streaming'), thinking: t('teamHierarchy.phase.thinking'),
    tool_executing: t('teamHierarchy.phase.toolExecuting'), done: t('teamHierarchy.phase.done'), error: t('teamHierarchy.phase.error'), interrupted: t('teamHierarchy.phase.interrupted'),
  };

  return (
    <div className="px-4 py-2 flex items-center gap-3 border-b border-border-default">
      <Crown size={12} className="text-accent-purple shrink-0" />
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-text-primary">Leader</span>
        <span className={`px-1 py-0 rounded text-[9px] font-mono ${
          phase === 'idle' ? 'bg-text-tertiary/10 text-text-tertiary' :
          phase === 'error' ? 'bg-accent-red/10 text-accent-red' :
          'bg-accent-brand/10 text-accent-brand'
        }`}>
          {phaseLabel[phase] ?? phase}
        </span>
      </div>

      {/* Context window */}
      {contextRuntimeState && (
        <div className="flex items-center gap-1">
          <div className="w-16 h-1 bg-border-default rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                contextRuntimeState.warningLevel === 'critical' ? 'bg-accent-red' :
                contextRuntimeState.warningLevel === 'warning' ? 'bg-accent-yellow' :
                'bg-accent-brand'
              }`}
              style={{ width: `${Math.min((contextRuntimeState.currentTokens / contextRuntimeState.maxTokens) * 100, 100)}%` }}
            />
          </div>
          <span className="text-[9px] font-mono text-text-tertiary">
            {Math.round((contextRuntimeState.currentTokens / contextRuntimeState.maxTokens) * 100)}%
          </span>
        </div>
      )}

      {/* Leader tokens */}
      {tokenUsage.total > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] font-mono text-accent-blue ml-auto">
          <Zap size={9} className="text-accent-yellow" />
          {formatTokens(tokenUsage.total)}
        </span>
      )}

      {leaderStatusText && (
        <span className="text-[9px] text-text-tertiary truncate max-w-[120px] hidden md:block">
          {leaderStatusText}
        </span>
      )}
    </div>
  );
}

function TaskRow({ task, agents }: { task: TaskInfo; agents: AgentConversation[] }) {
  // Use real displayState from backend; fallback to agent-derived state
  let displayState: TaskDisplayState;
  if (task.displayState) {
    displayState = task.displayState;
  } else {
    const normalizedTask = normalizeTaskDisplayState(task);
    if (normalizedTask !== 'pending') {
      displayState = normalizedTask;
    } else {
    // Fallback: derive from agents
    const hasRunning = agents.some(a => normalizeAgentStatus(a.status) === 'running');
    const hasFailed = agents.some(a => normalizeAgentStatus(a.status) === 'failed');
    const allDone = agents.length > 0 && !hasRunning && !hasFailed;
    displayState = !agents.length ? 'pending' : hasRunning ? 'running' : hasFailed ? 'failed' : allDone ? 'completed' : 'pending';
    }
  }

  return (
    <div className="border-b border-border-default/50 last:border-0">
      {/* Task header */}
      <div className="px-4 py-1.5 flex items-center gap-2">
        <ChevronRight size={10} className="text-text-tertiary/40 shrink-0" />
        <span className="text-[10px] font-mono text-text-tertiary truncate flex-1">
          {task.subject ? `${task.id} ${task.subject}` : task.id}
        </span>
        <TaskDisplayBadge state={displayState} />
        <span className="text-[9px] text-text-tertiary font-mono">{agents.length}</span>
      </div>

      {/* Agent dots */}
      {agents.length > 0 && (
        <div className="px-6 pb-1.5 flex items-center gap-1 flex-wrap">
          {agents.map(a => (
            <AgentDot key={a.agentId} conv={a} />
          ))}
        </div>
      )}

      {/* Diagnostics: task has assigned_agent but no runtime agent */}
      {task.assigned_agent && agents.length === 0 && displayState !== 'completed' && displayState !== 'cancelled' && (
        <div className="px-6 pb-1.5 flex items-center gap-1 text-[9px] text-accent-yellow">
          <AlertTriangle size={9} />
          <span>assigned @{task.assigned_agent} — no runtime agent</span>
        </div>
      )}
    </div>
  );
}

export default function TeamHierarchy() {
  const { t } = useTranslation();
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const currentSessionId = useSessionStore((s) => s.sessionId);

  // Fetch real tasks from backend for accurate displayState
  const [taskMap, setTaskMap] = useState<Record<string, TaskInfo>>({});
  const currentSessionRef = useRef<string | null>(currentSessionId);

  const fetchTasks = useCallback(async () => {
    const requestSessionId = currentSessionId;
    if (!requestSessionId) {
      setTaskMap({});
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(requestSessionId)}/tasks`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) return;
      const data: TaskInfo[] = await res.json();
      if (currentSessionRef.current !== requestSessionId) return;
      const map: Record<string, TaskInfo> = {};
      for (const task of data) {
        map[task.id] = task;
      }
      setTaskMap(map);
    } catch { /* non-critical */ }
  }, [currentSessionId]);

  useEffect(() => {
    currentSessionRef.current = currentSessionId;
    setTaskMap({});
    fetchTasks();
  }, [currentSessionId, fetchTasks]);

  // Subscribe to real-time task updates
  useEffect(() => {
    const unsub = subscribeTaskUpdates((updatedTask: TaskUpdatePayload, action: TaskUpdateAction) => {
      const taskSessionId = updatedTask.session_id || updatedTask.sessionId;
      if (!currentSessionRef.current || taskSessionId !== currentSessionRef.current) return;
      if (action === 'deleted') {
        setTaskMap(prev => {
          const next = { ...prev };
          delete next[updatedTask.id];
          return next;
        });
      } else {
        setTaskMap(prev => ({ ...prev, [updatedTask.id]: updatedTask }));
      }
    });
    return unsub;
  }, []);

  // Group agents by role (planner → task → worker hierarchy)
  const grouped = useMemo(() => {
    const byRole: Record<string, { planner?: AgentConversation; tasks: Record<string, AgentConversation[]> }> = {};

    for (const a of agents) {
      const conv = agentConversations[a.agentId];
      if (!conv) continue;

      const role = a.role || 'worker';
      const roleGroup = byRole[role] ?? { tasks: {} };

      if (role === 'planner') {
        roleGroup.planner = conv;
      } else {
        const taskId = a.taskId || conv.taskId
          || (a.agentName.includes(':') ? a.agentName.split(':')[0] : a.agentName);
        if (!roleGroup.tasks[taskId]) roleGroup.tasks[taskId] = [];
        roleGroup.tasks[taskId].push(conv);
      }

      byRole[role] = roleGroup;
    }

    return byRole;
  }, [agents, agentConversations]);

  const roleOrder = ['planner', 'scheduler', 'worker'];
  const sortedRoles = useMemo(() => {
    const keys = Object.keys(grouped);
    return [...keys].sort((a, b) => {
      const ai = roleOrder.indexOf(a);
      const bi = roleOrder.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [grouped]);

  return (
    <div className="flex flex-col">
      <div className="px-4 py-1.5 flex items-center gap-2 border-b border-border-default shrink-0">
        <Users size={10} className="text-text-tertiary" />
        <span className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
          {t('teamHierarchy.title', 'Team')}
        </span>
        <span className="ml-auto text-[9px] text-text-tertiary font-mono">{agents.length} {t('teamHierarchy.agents', 'agents')}</span>
      </div>

      {/* Leader row */}
      <LeaderRow />

      {/* Role sections */}
      {sortedRoles.length === 0 ? (
        <div className="px-4 py-6 flex flex-col items-center text-text-tertiary">
          <Users size={20} className="mb-2 opacity-30" />
          <p className="text-[11px]">{t('teamHierarchy.noTeam', 'No team members yet')}</p>
        </div>
      ) : (
        sortedRoles.map(role => {
          const group = grouped[role];
          if (!group) return null;
          const planner = group.planner;
          const taskEntries = Object.entries(group.tasks);

          return (
            <div key={role}>
              {/* Role section header */}
              <div className="px-4 py-1 flex items-center gap-2 bg-bg-secondary/50 border-b border-border-default/50">
                <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wider">{role}</span>
                <span className="text-[9px] text-text-tertiary font-mono ml-auto">
                  {/* P2-1 修复（audit-2026-05-15）：原代码 `{planner?1:0}{count}` 会拼成 "01"。
                      改用真实计数文案（与本地化一致）。*/}
                  {planner ? `1 planner · ` : ''}
                  {taskEntries.reduce((n, [, as]) => n + as.length, 0)} {t('teamHierarchy.agents', 'agents')}
                </span>
              </div>

              {/* Planner */}
              {planner && (
                <div className="border-b border-border-default/50">
                  <div className="px-4 py-1.5 flex items-center gap-2">
                    <ChevronRight size={10} className="text-text-tertiary/40 shrink-0" />
                    <span className="text-[10px] font-mono text-text-tertiary truncate flex-1">planner</span>
                    <TaskDisplayBadge state={normalizeAgentStatus(planner.status) === 'running' ? 'running' : 'completed'} />
                  </div>
                  <div className="px-6 pb-1.5">
                    <AgentDot conv={planner} />
                  </div>
                </div>
              )}

              {/* Tasks */}
              {taskEntries.map(([taskId, convs]) => (
                <TaskRow key={taskId} task={taskMap[taskId] || { id: taskId }} agents={convs} />
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
