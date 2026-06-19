/**
 * TasksView — 统一编排图可视化面板
 *
 * TaskBoard 的 blocked_by/blocks 是编排节点依赖图；orchestration metadata 承载
 * node kind、stage、contract、evaluation、evidence、verdict 和 generation。
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ListTodo, Clock, Plus, Trash2, RefreshCw,
  CheckCircle2, XCircle, Loader2, AlertTriangle,
  MessageSquare, GitBranch, BarChart2, Target, FileText, X, CircleSlash,
} from 'lucide-react';
import { useSessionStore, subscribeTaskUpdates } from '../../stores/sessionStore';
import { getServerToken } from '../../api/headers';
import { ArtifactsView } from '../artifacts/ArtifactsView';
import { normalizeTaskDisplayState } from '../../stores/sessionStoreHelpers.ts';
import { useArtifactStore } from '../../stores/artifactStore';
import { useViewStore } from '../../stores/viewStore';
import { useDeliveryContextStore, type DeliveryContext } from '../../stores/deliveryContextStore';
import { collectEvidenceReferences } from '../../utils/evidenceReferences';
import { buildDeliveryEvidence, type DeliveryEvidenceArtifactRef, type DeliveryEvidenceViewModel } from '../../utils/deliveryEvidence';
import TaskDetailDrawer from './TaskDetailDrawer';

// ─── Types ───

type TaskDisplayState =
  | 'pending'
  | 'dispatchable'
  | 'blocked'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface OrchestrationMetadata {
  orchestrationRunId?: string;
  nodeKind?: string;
  generation?: number;
  stage?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN' | string;
  contract?: unknown;
  evaluationPolicy?: unknown;
  acceptance?: {
    status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';
    summary?: string;
    criteria?: string[];
    evidenceTaskIds?: string[];
    artifactRefs?: Array<{ path: string; label?: string; kind?: string }>;
    evaluatedAt?: number;
  };
  blockedReason?: string;
  nextAction?: string;
  explainReason?: string;
  mainPathRank?: number;
}

interface Task {
  id: string;
  session_id: string;
  subject: string;
  description: string | object;
  status: string;
  /** 后端派生的展示态，前端只读这个字段 */
  displayState?: TaskDisplayState;
  exitReason?: 'completed' | 'failed' | 'cancelled' | 'timeout';
  agent_type: string;
  blocked_by: string[];
  blocks: string[];
  assigned_agent: string;
  working_directory?: string;
  write_scope?: string[];
  result?: string | object;
  orchestration?: OrchestrationMetadata;
  created_at: number;
  updated_at: number;
}

type TaskUpdateCallback = Parameters<typeof subscribeTaskUpdates>[0];
type TaskUpdatePayload = Parameters<TaskUpdateCallback>[0];
type TaskUpdateAction = Parameters<TaskUpdateCallback>[1];

interface ScheduledTask {
  id: string;
  session_id?: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  enabled?: boolean;
  task_type?: ScheduledTaskType;
  intensity?: ScheduledTaskIntensity;
  audience?: ScheduledTaskAudience;
  workflow_id?: string | null;
  workflow_input?: Record<string, unknown> | null;
  last_execution_id?: string | null;
  last_error?: string | null;
  last_run_at?: number | null;
  next_run_at?: number | null;
  created_at?: number;
}

type ScheduledTaskType = 'prompt' | 'workflow';
type ScheduledTaskIntensity = 'gentle' | 'normal' | 'aggressive' | 'critical';
type ScheduledTaskAudience = 'personal' | 'team' | 'ops' | 'customer';

interface ScheduledTaskCreateRequest {
  cron: string;
  prompt?: string;
  taskType: ScheduledTaskType;
  intensity: ScheduledTaskIntensity;
  audience: ScheduledTaskAudience;
  workflowId?: string;
  workflowInput?: Record<string, unknown>;
  recurring: boolean;
  durable: boolean;
  sessionId: string;
}

interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  workspace: string | null;
  updatedAt: number;
}

// ─── API helpers ───

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const message = typeof body.error === 'string'
      ? body.error
      : body.error?.message || body.error?.code || res.statusText;
    throw new Error(message || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Display state config ───
//
// 前端不再读 task.status / task.exitReason 这种状态机内部值；
// 后端 deriveTaskDisplayState 已派生 displayState，UI 全部走它。
// 历史值（in_progress / executing / done / blocked / error）已清除。

interface DisplayCfg {
  label: string;
  icon: React.ReactNode;
  color: string;
  bg: string;
  border: string;
  dot: string;
}

const DISPLAY_STATE: Record<TaskDisplayState, DisplayCfg> = {
  pending:      { label: '待派发', icon: <Clock size={12}/>,                                 color: 'text-text-tertiary', bg: 'bg-bg-tertiary',           border: 'border-border-muted',          dot: 'var(--color-text-tertiary)' },
  dispatchable: { label: '可派发', icon: <Clock size={12}/>,                                 color: 'text-accent-yellow', bg: 'bg-accent-yellow/10',      border: 'border-accent-yellow/30',      dot: 'var(--color-accent-yellow)' },
  blocked:      { label: '等待依赖', icon: <AlertTriangle size={12}/>,                        color: 'text-accent-yellow', bg: 'bg-accent-yellow/10',      border: 'border-accent-yellow/30',      dot: 'var(--color-accent-yellow)' },
  running:      { label: '进行中', icon: <Loader2 size={12} className="animate-spin"/>,      color: 'text-accent-brand',  bg: 'bg-accent-brand/10',       border: 'border-accent-brand/30',       dot: 'var(--color-accent-brand)' },
  completed:    { label: '已完成', icon: <CheckCircle2 size={12}/>,                          color: 'text-accent-green',  bg: 'bg-accent-green/10',       border: 'border-accent-green/30',       dot: 'var(--color-accent-green)' },
  failed:       { label: '失败',   icon: <XCircle size={12}/>,                               color: 'text-accent-red',    bg: 'bg-accent-red/10',         border: 'border-accent-red/30',         dot: 'var(--color-accent-red)' },
  cancelled:    { label: '已取消', icon: <XCircle size={12}/>,                               color: 'text-text-tertiary', bg: 'bg-bg-tertiary',           border: 'border-border-muted',          dot: 'var(--color-text-tertiary)' },
};

const DEFAULT_DISPLAY: DisplayCfg = DISPLAY_STATE.pending;

function compactPath(path?: string, max = 58): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  if (normalized.length <= max) return normalized;
  const parts = normalized.split('/').filter(Boolean);
  const tail = parts.slice(-3).join('/');
  return tail.length < max ? `.../${tail}` : `...${normalized.slice(-(max - 3))}`;
}

function hasIsolatedWorkdir(task: Pick<Task, 'working_directory' | 'write_scope'>): boolean {
  const wd = task.working_directory || '';
  return wd.includes('/worktrees/') || (task.write_scope || []).some((entry) => entry.includes('/worktrees/'));
}

/** 所有任务展示态统一从核心状态语义派生。 */
function getDisplayState(task: Pick<Task, 'displayState' | 'status' | 'exitReason' | 'assigned_agent'>): TaskDisplayState {
  return normalizeTaskDisplayState(task) as TaskDisplayState;
}

const cronPresets = [
  { label: '5m', value: '*/5 * * * *' },
  { label: '30m', value: '*/30 * * * *' },
  { label: '1h', value: '0 * * * *' },
  { label: '1d', value: '0 0 * * *' },
  { label: '1w', value: '0 0 * * 0' },
];

const intensityOptions: Array<{ value: ScheduledTaskIntensity; label: string }> = [
  { value: 'gentle', label: 'Gentle' },
  { value: 'normal', label: 'Normal' },
  { value: 'aggressive', label: 'Aggressive' },
  { value: 'critical', label: 'Critical' },
];

const audienceOptions: Array<{ value: ScheduledTaskAudience; label: string }> = [
  { value: 'personal', label: 'Personal' },
  { value: 'team', label: 'Team' },
  { value: 'ops', label: 'Ops' },
  { value: 'customer', label: 'Customer' },
];

function formatScheduleTimestamp(value?: number | null): string | null {
  if (!value) return null;
  const ms = value > 100_000_000_000 ? value : value * 1000;
  return new Date(ms).toLocaleString();
}

function readUpdateTimestamp(value: unknown): number {
  return Number(value ?? 0);
}

function getScheduledTaskTitle(task: ScheduledTask, workflows: WorkflowSummary[]): string {
  if (task.task_type === 'workflow') {
    const wf = workflows.find((item) => item.id === task.workflow_id);
    return wf?.name || task.workflow_id || 'Workflow';
  }
  return task.prompt || task.id;
}

function uniqueStrings(...lists: Array<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function deliveryEvidenceForTask(task: Task, items: DeliveryEvidenceViewModel[]): DeliveryEvidenceViewModel[] {
  const assigned = (task.assigned_agent || '').toLowerCase();
  const agentType = (task.agent_type || '').toLowerCase();
  return items.filter((item) => {
    if (item.taskId && item.taskId === task.id) return true;
    const agentName = (item.agentName || item.agentId || '').toLowerCase();
    return Boolean(assigned && agentName === assigned) || Boolean(agentType && agentName === agentType);
  });
}

function buildTaskDeliveryContext(
  task: Task,
  evidenceItems: DeliveryEvidenceViewModel[],
  fallbackSessionId: string | null,
): Omit<DeliveryContext, 'updatedAt'> {
  const relatedEvidence = deliveryEvidenceForTask(task, evidenceItems);
  const acceptanceArtifactRefs = (task.orchestration?.acceptance?.artifactRefs ?? []).map((ref) => ({
    path: ref.path,
    label: ref.label || ref.path,
    kind: ref.kind || 'acceptance',
  }));

  return {
    sourceView: 'tasks',
    sessionId: task.session_id || fallbackSessionId || undefined,
    taskId: task.id,
    taskTitle: task.subject,
    agentName: task.assigned_agent || undefined,
    agentType: task.agent_type || undefined,
    workspace: task.working_directory || undefined,
    writeScope: task.write_scope || [],
    filesCreated: uniqueStrings(relatedEvidence.flatMap((item) => item.filesCreated)),
    filesModified: uniqueStrings(relatedEvidence.flatMap((item) => item.filesModified)),
    evidenceRefs: uniqueStrings(relatedEvidence.flatMap((item) => item.evidenceRefs)),
    artifactRefs: [
      ...acceptanceArtifactRefs,
      ...relatedEvidence.flatMap((item) => item.artifactRefs),
    ],
    verificationCount: relatedEvidence.reduce((count, item) => count + item.verification.length, 0),
  };
}

// ─── DAG layout helpers ───

interface DAGNode { task: Task; level: number; col: number; x: number; y: number; readiness?: string; }

interface DAGSnapshotNodeMetadata {
  id?: unknown;
  readiness?: unknown;
}

interface DAGSnapshotEdgeMetadata {
  from: string;
  to: string;
  type?: string;
}

interface DAGSnapshotMetadata {
  nodes?: DAGSnapshotNodeMetadata[];
  edges?: DAGSnapshotEdgeMetadata[];
}

const NODE_W = 180;
const NODE_H = 60;
const H_GAP = 40;
const V_GAP = 36;

function buildDAGLayout(tasks: Task[], snapshot?: DAGSnapshotMetadata | null): { nodes: DAGNode[]; edges: DAGSnapshotEdgeMetadata[] } {
  if (tasks.length === 0) return { nodes: [], edges: [] };

  // Assign levels via topological sort
  const idMap: Record<string, Task> = {};
  for (const t of tasks) idMap[t.id] = t;

  const levels: Record<string, number> = {};
  const visited = new Set<string>();

  function getLevel(id: string): number {
    if (id in levels) return levels[id];
    if (visited.has(id)) return 0;
    visited.add(id);
    const task = idMap[id];
    if (!task || !task.blocked_by?.length) { levels[id] = 0; return 0; }
    const maxPred = Math.max(...task.blocked_by.map(getLevel));
    levels[id] = maxPred + 1;
    return levels[id];
  }

  for (const t of tasks) getLevel(t.id);

  // Group by level
  const byLevel: Record<number, Task[]> = {};
  for (const t of tasks) {
    const lv = levels[t.id] ?? 0;
    (byLevel[lv] = byLevel[lv] || []).push(t);
  }

  const maxLevel = Math.max(...Object.keys(byLevel).map(Number));

  const nodes: DAGNode[] = [];
  for (let lv = 0; lv <= maxLevel; lv++) {
    const row = byLevel[lv] || [];
    row.forEach((task, col) => {
      nodes.push({
        task,
        level: lv,
        col,
        x: col * (NODE_W + H_GAP),
        y: lv * (NODE_H + V_GAP),
      });
    });
  }

  // Center each level
  const levelWidths: Record<number, number> = {};
  for (const n of nodes) {
    levelWidths[n.level] = Math.max(levelWidths[n.level] || 0, (n.col + 1) * (NODE_W + H_GAP) - H_GAP);
  }
  const maxW = Math.max(...Object.values(levelWidths));
  for (const n of nodes) {
    const rowW = levelWidths[n.level];
    n.x += (maxW - rowW) / 2;
  }

  const readinessById = new Map<string, string>();
  for (const node of snapshot?.nodes ?? []) {
    if (typeof node.id === 'string' && typeof node.readiness === 'string') readinessById.set(node.id, node.readiness);
  }
  for (const node of nodes) node.readiness = readinessById.get(node.task.id);

  const snapshotEdges = (snapshot?.edges ?? []).filter((edge) => idMap[edge.from] && idMap[edge.to]);
  if (snapshotEdges.length > 0) return { nodes, edges: snapshotEdges };

  // Edges from blocked_by
  const edges: DAGSnapshotEdgeMetadata[] = [];
  for (const t of tasks) {
    for (const dep of (t.blocked_by || [])) {
      if (idMap[dep]) edges.push({ from: dep, to: t.id, type: 'depends_on' });
    }
  }

  return { nodes, edges };
}

// ─── DAG SVG component ───

function DAGCanvas({ tasks, snapshot, selectedId, onSelect }: {
  tasks: Task[];
  snapshot?: DAGSnapshotMetadata | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => buildDAGLayout(tasks, snapshot), [tasks, snapshot]);
  if (nodes.length === 0) return null;

  const nodeById: Record<string, DAGNode> = {};
  for (const n of nodes) nodeById[n.task.id] = n;

  const PADDING = 16;
  const svgW = Math.max(...nodes.map(n => n.x + NODE_W)) + PADDING * 2;
  const svgH = Math.max(...nodes.map(n => n.y + NODE_H)) + PADDING * 2;

  return (
    <div className="overflow-auto">
      <svg
        width={svgW + PADDING * 2}
        height={svgH + PADDING * 2}
        className="block"
        style={{ minWidth: svgW + PADDING * 2 }}
      >
        <defs>
          <marker id="arrow-blue" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="color-mix(in srgb, var(--color-accent-brand) 50%, transparent)" />
          </marker>
          <marker id="arrow-green" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="color-mix(in srgb, var(--color-accent-green) 50%, transparent)" />
          </marker>
          <marker id="arrow-default" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="color-mix(in srgb, var(--color-text-tertiary) 40%, transparent)" />
          </marker>
          <filter id="glow-blue" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feComposite in="SourceGraphic" in2="blur" operator="over"/>
          </filter>
        </defs>

        {/* Edges */}
        {edges.map(({ from, to, type }) => {
          const src = nodeById[from];
          const dst = nodeById[to];
          if (!src || !dst) return null;
          const x1 = src.x + NODE_W / 2 + PADDING;
          const y1 = src.y + NODE_H + PADDING;
          const x2 = dst.x + NODE_W / 2 + PADDING;
          const y2 = dst.y + PADDING;
          const cy = (y1 + y2) / 2;
          const srcState = getDisplayState(src.task);
          const dstState = getDisplayState(dst.task);
          const isActive = srcState === 'running' || dstState === 'running';
          const isDone = srcState === 'completed';
          const strokeColor = isActive ? 'color-mix(in srgb, var(--color-accent-brand) 38%, transparent)' : isDone ? 'color-mix(in srgb, var(--color-accent-green) 38%, transparent)' : 'var(--color-border-default)';
          const markerId = isActive ? 'arrow-blue' : isDone ? 'arrow-green' : 'arrow-default';
          const dash = type === 'evidence_for' ? '2 3' : isActive ? undefined : '4 3';
          return (
            <path
              key={`${from}-${to}`}
              d={`M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`}
              fill="none"
              stroke={strokeColor}
              strokeWidth={isActive ? 1.5 : 1}
              strokeDasharray={dash}
              markerEnd={`url(#${markerId})`}
              className={isActive ? 'dag-edge-animated' : ''}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map(({ task, x, y, readiness }) => {
          const state = getDisplayState(task);
          const cfg = DISPLAY_STATE[state] || DEFAULT_DISPLAY;
          const isSelected = selectedId === task.id;
          const isRunning = state === 'running';
          const readinessLabel = readiness && readiness !== state ? readiness : undefined;
          const truncSubject = task.subject.length > 20 ? task.subject.slice(0, 19) + '…' : task.subject;

          return (
            <g
              key={task.id}
              transform={`translate(${x + PADDING},${y + PADDING})`}
              onClick={() => onSelect(task.id)}
              style={{ cursor: 'pointer' }}
            >
              {/* Glow for running nodes */}
              {isRunning && (
                <rect
                  x={-2} y={-2}
                  width={NODE_W + 4} height={NODE_H + 4}
                  rx={8}
                  fill="none"
                  stroke="var(--color-accent-brand)"
                  strokeWidth={1}
                  opacity={0.3}
                  className="animate-pulse"
                />
              )}
              {/* Node body */}
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={isSelected ? 'var(--color-bg-tertiary)' : 'var(--color-bg-secondary)'}
                stroke={isSelected ? 'var(--color-accent-brand)' : 'color-mix(in srgb, ' + cfg.dot + ' 38%, transparent)'}
                strokeWidth={isSelected ? 1.5 : 1}
              />
              {/* Status bar left */}
              <rect
                x={0} y={0}
                width={3} height={NODE_H}
                rx={3}
                fill={cfg.dot}
                opacity={0.8}
              />
              {/* Status dot */}
              <circle
                cx={NODE_W - 14}
                cy={16}
                r={4}
                fill={cfg.dot}
                className={isRunning ? 'animate-pulse' : ''}
              />
              {/* Task ID badge */}
              <text
                x={10}
                y={18}
                fontSize={9}
                fill="var(--color-text-muted)"
                fontFamily="monospace"
              >
                #{task.id.slice(0, 6)}
              </text>
              {/* Subject */}
              <text
                x={10}
                y={36}
                fontSize={11}
                fill={isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)'}
                fontWeight={isSelected ? 600 : 400}
                fontFamily="system-ui, sans-serif"
              >
                {truncSubject}
              </text>
              {hasIsolatedWorkdir(task) && (
                <GitBranch
                  size={10}
                  x={NODE_W - 28}
                  y={11}
                  color="var(--color-accent-green)"
                />
              )}
              {/* Orchestration metadata */}
              {task.orchestration?.nodeKind && (
                <text
                  x={10}
                  y={52}
                  fontSize={9}
                  fill={task.orchestration.verdict === 'FAIL' ? 'var(--color-accent-red)' : task.orchestration.verdict === 'PASS' ? 'var(--color-accent-green)' : 'color-mix(in srgb, var(--color-accent-brand) 50%, transparent)'}
                  fontFamily="monospace"
                >
                  {task.orchestration.nodeKind}{readinessLabel ? ` · ${readinessLabel}` : ''}{task.orchestration.stage ? ` · ${task.orchestration.stage}` : ''}{task.orchestration.verdict ? ` · ${task.orchestration.verdict}` : ''}
                </text>
              )}
              {/* Agent */}
              {!task.orchestration?.nodeKind && task.assigned_agent && (
                <text
                  x={10}
                  y={52}
                  fontSize={9}
                  fill="color-mix(in srgb, var(--color-accent-brand) 50%, transparent)"
                  fontFamily="monospace"
                >
                  @{task.assigned_agent.slice(0, 16)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Stats bar ───

function StatsBar({ tasks }: { tasks: Task[] }) {
  const { t } = useTranslation();
  const total = tasks.length;
  const done = tasks.filter(t => getDisplayState(t) === 'completed').length;
  const running = tasks.filter(t => getDisplayState(t) === 'running').length;
  const blocked = tasks.filter(t => t.blocked_by?.length > 0 && getDisplayState(t) !== 'completed' && getDisplayState(t) !== 'running').length;
  const failed = tasks.filter(t => { const s = getDisplayState(t); return s === 'failed' || s === 'cancelled'; }).length;
  const successRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const stats = [
    { label: t('tasks.stats.nodes'), value: total, icon: <ListTodo size={13}/>, color: 'text-text-secondary' },
    { label: t('tasks.stats.success'), value: `${successRate}%`, icon: <Target size={13}/>, color: 'text-accent-green' },
    { label: t('tasks.stats.running'), value: running, icon: <Loader2 size={13} className={running > 0 ? 'animate-spin' : ''}/>, color: 'text-accent-brand' },
    { label: t('tasks.stats.blocked'), value: blocked, icon: <AlertTriangle size={13}/>, color: 'text-accent-yellow' },
    { label: t('tasks.stats.failed'), value: failed, icon: <XCircle size={13}/>, color: failed > 0 ? 'text-accent-red' : 'text-text-tertiary' },
  ];

  return (
    <div className="flex items-center gap-0 border-b border-border-default bg-bg-secondary/60 shrink-0">
      {stats.map((s, i) => (
        <div
          key={s.label}
          className={`flex-1 flex flex-col items-center justify-center py-2.5 ${i < stats.length - 1 ? 'border-r border-border-default' : ''}`}
        >
          <div className={`flex items-center gap-1 ${s.color} mb-0.5`}>
            {s.icon}
            <span className="text-[13px] font-bold font-mono">{s.value}</span>
          </div>
          <span className="text-[9px] text-text-muted uppercase tracking-wide font-medium">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main ───

export default function TasksView() {
  const { t } = useTranslation();
  const currentSessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const dagSnapshot = useSessionStore((s) => s.dagSnapshot);
  const runExplanation = useSessionStore((s) => s.runExplanation);
  const messages = useSessionStore((s) => s.messages);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const setMainView = useViewStore((s) => s.setMainView);
  const setDeliveryContext = useDeliveryContextStore((s) => s.setContext);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(currentSessionId);
  const [activeTab, setActiveTab] = useState<'tasks' | 'scheduled' | 'artifacts'>('tasks');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showDAG, setShowDAG] = useState(true);
  const selectedSessionRef = useRef<string | null>(selectedSessionId);

  // Scheduled task form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTaskType, setNewTaskType] = useState<ScheduledTaskType>('prompt');
  const [newCron, setNewCron] = useState('*/5 * * * *');
  const [newPrompt, setNewPrompt] = useState('');
  const [newIntensity, setNewIntensity] = useState<ScheduledTaskIntensity>('normal');
  const [newAudience, setNewAudience] = useState<ScheduledTaskAudience>('personal');
  const [newWorkflowId, setNewWorkflowId] = useState('');
  const [newWorkflowInput, setNewWorkflowInput] = useState('{}');
  const [newRecurring, setNewRecurring] = useState(true);
  const [newDurable, setNewDurable] = useState(false);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);
  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    setSelectedSessionId(currentSessionId || null);
    selectedSessionRef.current = currentSessionId || null;
    setTasks([]);
    setScheduledTasks([]);
    setSelectedTaskId(null);
    setError(null);
    setIsLoading(Boolean(currentSessionId));
  }, [currentSessionId]);

  const fetchTasks = useCallback(async () => {
    const requestSessionId = selectedSessionId;
    if (!requestSessionId) return;
    setIsLoading(true); setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(requestSessionId)}/tasks`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (selectedSessionRef.current !== requestSessionId) return;
      setTasks(Array.isArray(data) ? data : []);
    } catch (err) {
      if (selectedSessionRef.current !== requestSessionId) return;
      setError(err instanceof Error ? err.message : t('tasks.error.failed'));
    } finally {
      if (selectedSessionRef.current === requestSessionId) setIsLoading(false);
    }
  }, [selectedSessionId, t]);

  const fetchScheduledTasks = useCallback(async () => {
    const requestSessionId = selectedSessionId;
    if (!requestSessionId) return;
    setIsLoading(true); setError(null);
    try {
      const data = await apiFetch<{ data: ScheduledTask[] }>(`/scheduled-tasks?sessionId=${encodeURIComponent(requestSessionId)}`);
      if (selectedSessionRef.current !== requestSessionId) return;
      setScheduledTasks(data.data || []);
    } catch (err) {
      if (selectedSessionRef.current !== requestSessionId) return;
      setError(err instanceof Error ? err.message : t('tasks.error.failed'));
    }
    finally {
      if (selectedSessionRef.current === requestSessionId) setIsLoading(false);
    }
  }, [selectedSessionId, t]);

  const fetchWorkflowsForSchedule = useCallback(async () => {
    try {
      const data = await apiFetch<WorkflowSummary[]>('/workflows');
      setWorkflows(data);
      setNewWorkflowId((current) => current || data[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tasks.error.failed'));
    }
  }, [t]);

  useEffect(() => {
    if (activeTab === 'tasks') {
      fetchTasks();
    } else {
      fetchScheduledTasks();
      fetchWorkflowsForSchedule();
    }
  }, [activeTab, fetchTasks, fetchScheduledTasks, fetchWorkflowsForSchedule]);

  // 订阅实时任务状态更新，避免依赖手动刷新
  useEffect(() => {
    if (activeTab !== 'tasks') return;
    const unsub = subscribeTaskUpdates((updatedTask: TaskUpdatePayload, action: TaskUpdateAction) => {
      const taskSessionId = updatedTask.session_id || updatedTask.sessionId;
      if (!selectedSessionId || taskSessionId !== selectedSessionId) return;
      setTasks(prev => {
        if (action === 'deleted') {
          if (selectedTaskId === updatedTask.id) setSelectedTaskId(null);
          return prev.filter(t => t.id !== updatedTask.id);
        }
        const idx = prev.findIndex(t => t.id === updatedTask.id);
        if (idx === -1) return [...prev, updatedTask];
        const previousTask = prev[idx];
        if (!previousTask) return prev;
        const prevUpdatedAt = readUpdateTimestamp(previousTask.updated_at);
        const nextUpdatedAt = readUpdateTimestamp(updatedTask.updated_at);
        if (prevUpdatedAt && nextUpdatedAt && nextUpdatedAt < prevUpdatedAt) return prev;
        const next = [...prev];
        next[idx] = updatedTask;
        return next;
      });
    });
    return unsub;
  }, [activeTab, selectedSessionId, selectedTaskId]);

  const selectedTask = tasks.find(t => t.id === selectedTaskId) || null;
  const selectedIsCurrentSession = selectedSessionId === currentSessionId;
  const visibleRunExplanation = selectedIsCurrentSession ? runExplanation : null;
  const visibleDagSnapshot = selectedIsCurrentSession ? dagSnapshot : null;
  const evidenceReferences = useMemo(() => (
    selectedSessionId && selectedSessionId === currentSessionId
      ? collectEvidenceReferences(messages)
      : []
  ), [currentSessionId, messages, selectedSessionId]);
  const deliveryEvidence = useMemo(() => (
    selectedSessionId && selectedSessionId === currentSessionId
      ? buildDeliveryEvidence({
          sessionId: selectedSessionId,
          messages,
          agentConversations,
          evidenceReferences,
          limit: 12,
        })
      : []
  ), [agentConversations, currentSessionId, evidenceReferences, messages, selectedSessionId]);

  const openEvidenceArtifact = useCallback((ref: DeliveryEvidenceArtifactRef) => {
    if (ref.path) {
      openArtifact({
        name: ref.label || ref.path,
        path: ref.path,
      });
      setMainView('artifact');
    } else if (ref.url) {
      window.open(ref.url, '_blank', 'noopener,noreferrer');
    }
  }, [openArtifact, setMainView]);

  const pinSelectedTaskContext = useCallback(() => {
    if (!selectedTask) return null;
    const context = buildTaskDeliveryContext(selectedTask, deliveryEvidence, selectedSessionId);
    setDeliveryContext(context);
    return context;
  }, [deliveryEvidence, selectedSessionId, selectedTask, setDeliveryContext]);

  const openTaskAgent = useCallback(() => {
    pinSelectedTaskContext();
    setMainView('chat');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('lingxiao:open-agent-panel', {
        detail: {
          taskId: selectedTask?.id,
          agentName: selectedTask?.assigned_agent,
        },
      }));
    }, 0);
  }, [pinSelectedTaskContext, selectedTask?.assigned_agent, selectedTask?.id, setMainView]);

  const openTaskReview = useCallback(() => {
    const context = pinSelectedTaskContext();
    setMainView('chat');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('lingxiao:open-workbench-review', {
        detail: {
          taskId: selectedTask?.id,
          deliveryContext: context,
        },
      }));
    }, 0);
  }, [pinSelectedTaskContext, selectedTask?.id, setMainView]);

  const openTaskChanges = useCallback(() => {
    pinSelectedTaskContext();
    setMainView('changes');
  }, [pinSelectedTaskContext, setMainView]);

  const openTaskGit = useCallback(() => {
    pinSelectedTaskContext();
    setMainView('git');
  }, [pinSelectedTaskContext, setMainView]);

  const handleCreateScheduled = async () => {
    if (!selectedSessionId) return;
    if (newTaskType === 'prompt' && !newPrompt.trim()) return;
    if (newTaskType === 'workflow' && !newWorkflowId) {
      setError('workflow is required');
      return;
    }
    try {
      let workflowInput: Record<string, unknown> | undefined;
      if (newTaskType === 'workflow') {
        const raw = newWorkflowInput.trim();
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('workflow input must be a JSON object');
        }
        workflowInput = parsed as Record<string, unknown>;
      }
      const payload: ScheduledTaskCreateRequest = {
        cron: newCron,
        prompt: newPrompt.trim() || undefined,
        taskType: newTaskType,
        intensity: newIntensity,
        audience: newAudience,
        workflowId: newTaskType === 'workflow' ? newWorkflowId : undefined,
        workflowInput,
        recurring: newRecurring,
        durable: newDurable,
        sessionId: selectedSessionId,
      };
      await apiFetch('/scheduled-tasks', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setNewPrompt('');
      setNewWorkflowInput('{}');
      setShowCreateForm(false);
      fetchScheduledTasks();
    } catch (err) { setError(err instanceof Error ? err.message : t('tasks.error.failed')); }
  };

  const handleDeleteScheduled = async (id: string) => {
    try {
      await apiFetch(`/scheduled-tasks/${id}?sessionId=${encodeURIComponent(selectedSessionId!)}`, { method: 'DELETE' });
      fetchScheduledTasks();
    } catch (err) { setError(err instanceof Error ? err.message : t('tasks.error.failed')); }
  };

  return (
    <div className="flex flex-col h-full text-text-primary">
      {/* Header */}
      <div className="codex-topbar flex items-center gap-2 px-5 py-3 border-b border-border-muted shrink-0 backdrop-blur-2xl">
        {/* Tab buttons */}
        <button
          onClick={() => setActiveTab('tasks')}
          className={`codex-chip flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${activeTab === 'tasks' ? 'text-text-primary' : 'text-text-tertiary'}`}
        >
          <GitBranch size={12}/> Orchestration
        </button>
        <button
          onClick={() => setActiveTab('scheduled')}
          className={`codex-chip flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${activeTab === 'scheduled' ? 'text-text-primary' : 'text-text-tertiary'}`}
        >
          <Clock size={12}/> Scheduled
        </button>
        <button
          onClick={() => setActiveTab('artifacts')}
          className={`codex-chip flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${activeTab === 'artifacts' ? 'text-text-primary' : 'text-text-tertiary'}`}
        >
          <FileText size={12}/> Artifacts
        </button>
        <div className="flex-1" />
        {activeTab === 'tasks' && tasks.length > 0 && (
          <button
            onClick={() => setShowDAG(!showDAG)}
            className={`codex-chip flex items-center gap-1 px-2.5 py-1 text-xs transition-colors ${showDAG ? 'text-text-primary' : 'text-text-tertiary'}`}
            title="Toggle orchestration graph"
          >
            <BarChart2 size={12}/> {showDAG ? 'Graph' : 'List'}
          </button>
        )}
        <button
          className="codex-icon-btn !h-8 !min-w-8"
          onClick={activeTab === 'tasks' ? fetchTasks : fetchScheduledTasks}
        >
          <RefreshCw size={13}/>
        </button>
      </div>

      {/* Session selector */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-default bg-bg-secondary/40 shrink-0">
        <MessageSquare size={11} className="text-text-muted shrink-0"/>
        <select
          className="flex-1 rounded border border-border-input bg-bg-input px-1.5 py-0.5 text-[11px] text-text-secondary focus:outline-none cursor-pointer"
          value={selectedSessionId || ''}
          onChange={(e) => { setSelectedSessionId(e.target.value); setSelectedTaskId(null); }}
        >
          {sessions.length === 0 && <option value="">{t('chat.noSessions')}</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id} className="bg-bg-primary">
              {s.name || s.id.slice(0, 8)}{s.isActive ? ' ●' : ''}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="px-3 py-1.5 bg-accent-red/10 text-accent-red text-xs flex items-center gap-2 border-b border-accent-red/20">
          <AlertTriangle size={11} className="shrink-0"/>
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-accent-red/60 hover:text-accent-red"><X size={12} /></button>
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-accent-brand/60"/>
        </div>
      ) : activeTab === 'tasks' ? (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* Stats bar */}
            {tasks.length > 0 && <StatsBar tasks={tasks}/>}
            {visibleRunExplanation && (
              <div className="px-3 py-2 border-b border-border-default bg-bg-secondary/50 text-[11px] text-text-secondary flex flex-wrap gap-2 items-center">
                <span className="text-accent-brand font-semibold">{visibleRunExplanation.state}</span>
                <span>{visibleRunExplanation.reason}</span>
                {visibleRunExplanation.nextAction && <span className="text-accent-yellow/80">next: {visibleRunExplanation.nextAction}</span>}
                {visibleDagSnapshot && <span className="text-text-tertiary">DAG: {visibleDagSnapshot.ready.length} ready · {visibleDagSnapshot.blocked.length} blocked · {visibleDagSnapshot.running.length} running</span>}
              </div>
            )}

            {/* Orchestration graph */}
            {tasks.length > 0 && showDAG && (
              <div className="border-b border-border-default overflow-auto p-3 bg-bg-secondary/30 shrink-0" style={{ maxHeight: '280px' }}>
                <div className="text-[9px] text-text-muted uppercase tracking-widest mb-2 font-medium">Live Orchestration Graph</div>
                <DAGCanvas tasks={tasks} snapshot={visibleDagSnapshot} selectedId={selectedTaskId} onSelect={setSelectedTaskId}/>
              </div>
            )}

            {/* Task list */}
            {tasks.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-text-muted bg-bg-secondary">
                <GitBranch size={28} className="mb-2 opacity-40"/>
                <p className="text-xs">{t('tasks.empty')}</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto bg-bg-secondary">
                <div className="divide-y divide-border-default/60">
                  {tasks.map((task) => {
                    const state = getDisplayState(task);
                    const cfg = DISPLAY_STATE[state] || DEFAULT_DISPLAY;
                    const isSelected = selectedTaskId === task.id;
                    const isRunning = state === 'running';
                    const isolated = hasIsolatedWorkdir(task);
                    return (
                      <button
                        key={task.id}
                        className={`w-full px-3 py-2.5 flex items-center gap-2.5 text-left transition-colors ${isSelected ? 'bg-accent-brand/10' : 'hover:bg-bg-hover'}`}
                        onClick={() => setSelectedTaskId(isSelected ? null : task.id)}
                      >
                        {/* Status dot */}
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: cfg.dot, boxShadow: isRunning ? `0 0 6px ${cfg.dot}` : 'none' }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] text-text-primary truncate leading-tight">{task.subject}</div>
                          <div className="text-[9px] text-text-muted font-mono mt-0.5">
                            #{task.id.slice(0, 6)}
                            {task.assigned_agent && <span className="text-accent-brand/50 ml-1">@{task.assigned_agent}</span>}
                            {task.blocked_by?.length > 0 && <span className="text-accent-yellow/50 ml-1 inline-flex items-center gap-0.5"><CircleSlash size={11} /> blocked</span>}
                            {task.orchestration?.nodeKind && <span className="text-accent-purple/60 ml-1">{task.orchestration.nodeKind}</span>}
                            {task.orchestration?.stage && <span className="text-accent-blue/60 ml-1">{task.orchestration.stage}</span>}
                            {task.orchestration?.verdict && <span className="text-accent-yellow/60 ml-1">{task.orchestration.verdict}</span>}
                            {isolated && <span className="text-accent-green/60 ml-1">wt:{compactPath(task.working_directory, 24)}</span>}
                          </div>
                        </div>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium border ${cfg.border} ${cfg.color} ${cfg.bg} shrink-0`}>
                          {cfg.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <TaskDetailDrawer
            task={selectedTask}
            state={selectedTask ? getDisplayState(selectedTask) : 'pending'}
            display={selectedTask ? (DISPLAY_STATE[getDisplayState(selectedTask)] || DEFAULT_DISPLAY) : DEFAULT_DISPLAY}
            deliveryEvidence={deliveryEvidence}
            onClose={() => setSelectedTaskId(null)}
            onOpenAgent={openTaskAgent}
            onOpenReview={openTaskReview}
            onOpenArtifacts={() => setActiveTab('artifacts')}
            onOpenChanges={openTaskChanges}
            onOpenGit={openTaskGit}
            onOpenArtifactRef={openEvidenceArtifact}
            onSelectTask={setSelectedTaskId}
          />
        </div>
      ) : activeTab === 'artifacts' ? (
        /* Artifacts Tab */
        <div className="flex-1 overflow-y-auto bg-bg-secondary p-3">
          <ArtifactsView/>
        </div>
      ) : (
        /* Scheduled Tab */
        <div className="flex-1 overflow-y-auto bg-bg-secondary">
          <div className="p-3">
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-accent-brand hover:bg-accent-brand/10 rounded border border-accent-brand/20 transition-colors"
              onClick={() => setShowCreateForm(!showCreateForm)}
            >
              <Plus size={12}/> {t('tasks.createScheduled')}
            </button>
          </div>

          {showCreateForm && (
            <div className="mx-3 mb-3 p-3 bg-bg-secondary border border-border-default rounded-lg space-y-3">
              <div>
                <label className="text-[10px] text-text-tertiary block mb-1 uppercase tracking-wide">Type</label>
                <div className="grid grid-cols-2 gap-1">
                  {(['prompt', 'workflow'] as ScheduledTaskType[]).map((type) => (
                    <button
                      key={type}
                      className={`px-2 py-1.5 text-[10px] rounded border transition-colors ${newTaskType === type ? 'bg-accent-brand/20 text-accent-brand border-accent-brand/30' : 'bg-bg-tertiary text-text-tertiary hover:text-text-secondary border-border-muted'}`}
                      onClick={() => setNewTaskType(type)}
                    >
                      {type === 'prompt' ? 'Prompt' : 'Workflow'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-text-tertiary block mb-1 uppercase tracking-wide">Cron</label>
                <div className="flex gap-1 mb-2">
                  {cronPresets.map((p) => (
                    <button key={p.value}
                      className={`px-2 py-1 text-[10px] rounded font-mono ${newCron === p.value ? 'bg-accent-brand/20 text-accent-brand border border-accent-brand/30' : 'bg-bg-tertiary text-text-tertiary hover:text-text-secondary border border-border-muted'}`}
                      onClick={() => setNewCron(p.value)}
                    >{p.label}</button>
                  ))}
                </div>
                <input
                  type="text" value={newCron} onChange={(e) => setNewCron(e.target.value)}
                  className="w-full px-2 py-1.5 text-[11px] bg-bg-tertiary border border-border-muted rounded text-text-primary font-mono focus:outline-none focus:border-accent-brand/60"
                  placeholder="*/5 * * * *"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-text-tertiary block mb-1 uppercase tracking-wide">Intensity</label>
                  <select
                    value={newIntensity}
                    onChange={(e) => setNewIntensity(e.target.value as ScheduledTaskIntensity)}
                    className="w-full px-2 py-1.5 text-[11px] bg-bg-tertiary border border-border-muted rounded text-text-primary focus:outline-none focus:border-accent-brand/60"
                  >
                    {intensityOptions.map((option) => (
                      <option key={option.value} value={option.value} className="bg-bg-primary">{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-text-tertiary block mb-1 uppercase tracking-wide">Audience</label>
                  <select
                    value={newAudience}
                    onChange={(e) => setNewAudience(e.target.value as ScheduledTaskAudience)}
                    className="w-full px-2 py-1.5 text-[11px] bg-bg-tertiary border border-border-muted rounded text-text-primary focus:outline-none focus:border-accent-brand/60"
                  >
                    {audienceOptions.map((option) => (
                      <option key={option.value} value={option.value} className="bg-bg-primary">{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {newTaskType === 'workflow' ? (
                <>
                  <div>
                    <label className="text-[10px] text-text-tertiary block mb-1 uppercase tracking-wide">Workflow</label>
                    <select
                      value={newWorkflowId}
                      onChange={(e) => setNewWorkflowId(e.target.value)}
                      className="w-full px-2 py-1.5 text-[11px] bg-bg-tertiary border border-border-muted rounded text-text-primary focus:outline-none focus:border-accent-brand/60"
                    >
                      {workflows.length === 0 && <option value="" className="bg-bg-primary">No workflows</option>}
                      {workflows.map((workflow) => (
                        <option key={workflow.id} value={workflow.id} className="bg-bg-primary">
                          {workflow.name || workflow.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-text-tertiary block mb-1 uppercase tracking-wide">Input JSON</label>
                    <textarea
                      value={newWorkflowInput}
                      onChange={(e) => setNewWorkflowInput(e.target.value)}
                      className="w-full px-2 py-1.5 text-[11px] bg-bg-tertiary border border-border-muted rounded text-text-primary resize-none focus:outline-none focus:border-accent-brand/60 font-mono"
                      rows={3}
                      spellCheck={false}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-tertiary block mb-1 uppercase tracking-wide">Note</label>
                    <textarea value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)}
                      className="w-full px-2 py-1.5 text-[11px] bg-bg-tertiary border border-border-muted rounded text-text-primary resize-none focus:outline-none focus:border-accent-brand/60 font-sans"
                      rows={2}
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="text-[10px] text-text-tertiary block mb-1 uppercase tracking-wide">Prompt</label>
                  <textarea value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)}
                    className="w-full px-2 py-1.5 text-[11px] bg-bg-tertiary border border-border-muted rounded text-text-primary resize-none focus:outline-none focus:border-accent-brand/60 font-sans"
                    rows={2} placeholder={t('tasks.promptPlaceholder')}
                  />
                </div>
              )}

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
                    <input type="checkbox" checked={newRecurring} onChange={(e) => setNewRecurring(e.target.checked)} className="accent-accent-brand"/>
                    {t('tasks.recurring')}
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer" title={t('tasks.durableHint')}>
                    <input type="checkbox" checked={newDurable} onChange={(e) => setNewDurable(e.target.checked)} className="accent-accent-brand"/>
                    {t('scheduled.durable')}
                  </label>
                </div>
                <div className="flex gap-2">
                  <button className="px-3 py-1 text-[11px] text-text-tertiary hover:text-text-secondary" onClick={() => setShowCreateForm(false)}>{t('app.cancel')}</button>
                  <button className="px-3 py-1 text-[11px] bg-accent-brand/20 text-accent-brand border border-accent-brand/30 rounded hover:bg-accent-brand/30 disabled:opacity-40"
                    disabled={newTaskType === 'prompt' ? !newPrompt.trim() : !newWorkflowId}
                    onClick={handleCreateScheduled}>{t('app.confirm')}</button>
                </div>
              </div>
            </div>
          )}

          {scheduledTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted bg-bg-secondary">
              <Clock size={24} className="mb-2 opacity-40"/>
              <p className="text-xs">{t('tasks.noScheduled')}</p>
            </div>
          ) : (
            <div className="divide-y divide-border-default/60">
              {scheduledTasks.map((st) => {
                const type = st.task_type ?? 'prompt';
                const title = getScheduledTaskTitle(st, workflows);
                const nextRun = formatScheduleTimestamp(st.next_run_at);
                const lastRun = formatScheduleTimestamp(st.last_run_at);
                return (
                  <div key={st.id} className="px-3 py-2.5 flex items-center gap-2.5">
                    {type === 'workflow' ? (
                      <GitBranch size={12} className="text-accent-brand/70 shrink-0"/>
                    ) : (
                      <Clock size={12} className="text-accent-brand/60 shrink-0"/>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-text-primary truncate">
                        {title}
                        {st.enabled === false && <span className="ml-2 text-text-muted">paused</span>}
                      </div>
                      <div className="text-[9px] text-text-muted font-mono mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>{st.cron}</span>
                        <span className={type === 'workflow' ? 'text-accent-brand/70' : 'text-text-tertiary'}>{type}</span>
                        <span className="text-accent-yellow/70">{st.intensity ?? 'normal'}</span>
                        <span className="text-accent-blue/70">{st.audience ?? 'personal'}</span>
                        {st.recurring && <span className="text-accent-green/60">recurring</span>}
                        {st.durable && <span className="text-accent-blue/60">durable</span>}
                        {nextRun && <span>next {nextRun}</span>}
                        {lastRun && <span>last {lastRun}</span>}
                        {st.last_execution_id && <span className="text-accent-green/70">exec {st.last_execution_id.slice(0, 8)}</span>}
                        {st.last_error && <span className="text-accent-red/80 truncate max-w-[220px]">{st.last_error}</span>}
                      </div>
                    </div>
                    <button className="text-text-muted hover:text-accent-red transition-colors" onClick={() => handleDeleteScheduled(st.id)}>
                      <Trash2 size={12}/>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes dagFlow {
          0% { stroke-dashoffset: 20; }
          100% { stroke-dashoffset: 0; }
        }
        .dag-edge-animated {
          stroke-dasharray: 6 3;
          animation: dagFlow 1.2s linear infinite;
        }
      `}</style>
    </div>
  );
}
