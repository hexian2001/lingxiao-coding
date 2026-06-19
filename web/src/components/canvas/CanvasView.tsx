/**
 * CanvasView — 专业工作流可视化编辑器 (session-independent)
 *
 * 功能：
 * - 右键画布：添加节点
 * - 右键节点：编辑/删除/复制/运行
 * - 左键点击节点：打开编辑面板（Dify 风格）
 * - 拖拽连线、缩放平移
 * - 实时状态同步
 * - 独立于会话的工作流执行
 */

import { useCallback, useEffect, useState, useRef, type CSSProperties } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  getBezierPath,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type EdgeProps,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Bot, Cpu, Wrench, GitBranch, Zap, Play, Square, Pause, Plus,
  Trash2, Copy, ArrowRight, Edit3, Terminal, Eye, Workflow,
  Save, FolderOpen, FilePlus, ChevronDown, RotateCcw, Clock,
  Search, RefreshCw, CheckCircle2, AlertTriangle, ListChecks,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkflowStore } from '../../stores/workflowStore';
import { useCanvasStore } from '../../stores/canvasStore';
import type { CanvasActionContext } from '../../stores/canvasStore';
import { acpClient } from '../../api/AcpClient';
import { getServerToken } from '../../api/headers';
import NodeEditPanel from './NodeEditPanel';
import ExecutionPanel from './ExecutionPanel';
import CtxMenuComp from './CtxMenuComp';
import type { CtxMenu } from './canvasTypes';
import i18n from '../../i18n';
import {
  WORKFLOW_REALTIME_EVENT_NAMES,
  normalizeWorkflowRealtimeEvent,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
  type NodeStatus,
  type WorkflowProjectionEvent,
  type WorkflowRealtimeEventName,
} from '../../types/workflow';
import { isWorkflowNodeActiveStatus, normalizeWorkflowNodeStatus } from '@contracts/adapters/StatusAdapter';

export type NodeType =
  | 'start'
  | 'leader'
  | 'agent'
  | 'tool'
  | 'template'
  | 'variable_assigner'
  | 'variable_aggregator'
  | 'list_operator'
  | 'http_request'
  | 'json_extractor'
  | 'condition'
  | 'loop'
  | 'parallel'
  | 'schedule_trigger'
  | 'input'
  | 'output';

export interface WorkflowNodeConfig {
  agentRole?: string;
  agentModel?: string;
  systemPrompt?: string;
  toolName?: string;
  toolArgs?: unknown;
  expression?: string;
  conditionType?: 'expression' | 'llm';
  llmPrompt?: string;
  conditionAgentRole?: string;
  conditionModel?: string;
  loopType?: 'count' | 'while' | 'foreach';
  loopCount?: number;
  loopCondition?: string;
  loopItems?: string;
  parallelBranches?: string[];
  scheduleCron?: string;
  scheduleSessionId?: string;
  schedulePrompt?: string;
  scheduleRecurring?: boolean;
  scheduleDurable?: boolean;
  scheduleEnabled?: boolean;
  scheduleIntensity?: 'gentle' | 'normal' | 'aggressive' | 'critical';
  scheduleAudience?: 'personal' | 'team' | 'ops' | 'customer';
  scheduleWorkflowInput?: Record<string, unknown>;
  template?: string;
  assignments?: unknown;
  httpRequest?: { url?: string };
  [key: string]: unknown;
}

export interface WorkflowNodeData {
  label: string;
  type: NodeType;
  status: NodeStatus;
  description?: string;
  config?: WorkflowNodeConfig;
  agentId?: string;
  agentModel?: string;
  agentPrompt?: string;
  model?: string;
  prompt?: string;
  toolName?: string;
  toolParams?: unknown;
  conditionExpr?: string;
  expression?: string;
  trueTarget?: string;
  falseTarget?: string;
  inputSource?: string;
  outputFormat?: string;
  [key: string]: unknown;
}

const nodeTheme: Record<NodeType, {
  bg: string; border: string; text: string; icon: React.ReactNode; glow: string;
}> = {
  start:     { bg: '#0a1a10', border: '#00ffaa', text: '#00ffaa', icon: <Play size={13}/>, glow: '#00ffaa30' },
  leader:    { bg: '#0a0a1a', border: '#7aa2f7', text: '#7aa2f7', icon: <Bot size={13}/>, glow: '#7aa2f730' },
  agent:     { bg: '#150a1a', border: '#bb9af7', text: '#bb9af7', icon: <Cpu size={13}/>, glow: '#bb9af730' },
  tool:      { bg: '#0a1a12', border: '#9ece6a', text: '#9ece6a', icon: <Wrench size={13}/>, glow: '#9ece6a30' },
  template:  { bg: '#111827', border: '#89ddff', text: '#89ddff', icon: <Terminal size={13}/>, glow: '#89ddff30' },
  variable_assigner:   { bg: '#0f1a14', border: '#73daca', text: '#73daca', icon: <Wrench size={13}/>, glow: '#73daca30' },
  variable_aggregator: { bg: '#141520', border: '#c3e88d', text: '#c3e88d', icon: <GitBranch size={13}/>, glow: '#c3e88d30' },
  list_operator: { bg: '#17130c', border: '#ffcb6b', text: '#ffcb6b', icon: <RotateCcw size={13}/>, glow: '#ffcb6b30' },
  http_request: { bg: '#0d1520', border: '#82aaff', text: '#82aaff', icon: <Wrench size={13}/>, glow: '#82aaff30' },
  json_extractor: { bg: '#1a1020', border: '#c792ea', text: '#c792ea', icon: <Terminal size={13}/>, glow: '#c792ea30' },
  condition: { bg: '#1a150a', border: '#e0af68', text: '#e0af68', icon: <GitBranch size={13}/>, glow: '#e0af6830' },
  loop:      { bg: '#1a0a15', border: '#c678dd', text: '#c678dd', icon: <RotateCcw size={13}/>, glow: '#c678dd30' },
  parallel:  { bg: '#0a151a', border: '#56b6c2', text: '#56b6c2', icon: <GitBranch size={13}/>, glow: '#56b6c230' },
  schedule_trigger: { bg: '#101410', border: '#d7ba7d', text: '#d7ba7d', icon: <Clock size={13}/>, glow: '#d7ba7d30' },
  input:     { bg: '#0a151a', border: '#7dcfff', text: '#7dcfff', icon: <Terminal size={13}/>, glow: '#7dcfff30' },
  output:    { bg: '#1a0a0a', border: '#f7768e', text: '#f7768e', icon: <Zap size={13}/>, glow: '#f7768e30' },
};

const statusDot: Record<string, { color: string; anim: string }> = {
  idle: { color: '#414868', anim: '' },
  running: { color: '#00ffaa', anim: 'animate-pulse' },
  completed: { color: '#9ece6a', anim: '' },
  failed: { color: '#f7768e', anim: '' },
  paused: { color: '#e0af68', anim: '' },
};

// ─── Context Menu ───
// Types and UI component extracted to canvasTypes.tsx + CtxMenuComp.tsx

// ─── Custom Edge ───

function WorkflowEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style = {} } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <path d={path} fill="none" stroke="#1a1a2e" strokeWidth={2} />
      <path d={path} fill="none" stroke={style.stroke as string || '#333'} strokeWidth={1.5} strokeDasharray="6 3" />
    </>
  );
}

// ─── Custom Node ───

function WorkflowNodeComp({ data, selected }: NodeProps) {
  const d = data as unknown as WorkflowNodeData;
  const theme = nodeTheme[d.type] || nodeTheme.tool;
  const normalizedStatus = normalizeWorkflowNodeStatus(d.status);
  const st = statusDot[normalizedStatus] || statusDot.idle;
  const running = normalizedStatus === 'running';

  return (
    <div className="group relative">
      {d.type !== 'start' && d.type !== 'input' && d.type !== 'schedule_trigger' && (
        <Handle type="target" position={Position.Top}
          className="!w-2.5 !h-2.5 !bg-bg-hover !border-2 !border-border-default hover:!border-accent-brand transition-colors" />
      )}
      <div className="px-4 py-2.5 rounded-lg min-w-[150px] max-w-[220px] cursor-grab active:cursor-grabbing transition-all"
        style={{
          background: theme.bg,
          border: `1.5px solid ${selected ? '#00ffaa' : running ? theme.border : '#1a1a2e'}`,
          boxShadow: selected ? '0 0 0 1px #00ffaa40, 0 0 20px #00ffaa20' : running ? `0 0 20px ${theme.glow}` : 'none',
        }}>
        <div className="flex items-center gap-2 mb-0.5">
          <span style={{ color: theme.text }} className="shrink-0">{theme.icon}</span>
          <span className="text-[11px] font-mono font-medium truncate" style={{ color: theme.text }}>{d.label}</span>
          <span className={`ml-auto w-2 h-2 rounded-full shrink-0 ${st.anim}`} style={{ backgroundColor: st.color }} />
        </div>
        {d.description && <div className="text-[9px] text-text-tertiary font-mono truncate pl-5">{d.description}</div>}
        <div className="mt-1.5 pl-5 flex items-center gap-1">
          <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm tracking-wider uppercase"
            style={{ color: theme.text + '80', background: theme.border + '15' }}>{d.type}</span>
          {running && <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm text-accent-brand bg-accent-brand/15 animate-pulse">RUN</span>}
        </div>
      </div>
      {d.type !== 'output' && (
        <Handle type="source" position={Position.Bottom}
          className="!w-2.5 !h-2.5 !bg-bg-hover !border-2 !border-border-default hover:!border-accent-brand transition-colors" />
      )}
    </div>
  );
}

const nodeTypes = { workflow: WorkflowNodeComp };
const edgeTypes = { workflow: WorkflowEdge };
const reactFlowProOptions = { hideAttribution: true };
const reactFlowDefaultEdgeOptions = { type: 'workflow', style: { stroke: '#333' } };

// ─── Default canvas state ───

const defaultNodes: Node[] = [
  { id: 'start', type: 'workflow', position: { x: 320, y: 40 }, data: { label: 'START', type: 'start', status: 'idle' } },
  { id: 'leader', type: 'workflow', position: { x: 300, y: 170 }, data: { label: 'Leader', type: 'leader', status: 'idle', description: i18n.t('canvas.leaderDescription') } },
  { id: 'output', type: 'workflow', position: { x: 320, y: 700 }, data: { label: 'OUTPUT', type: 'output', status: 'idle' } },
];

const defaultEdges: Edge[] = [
  { id: 'e-start-leader', source: 'start', target: 'leader', type: 'workflow', style: { stroke: '#00ffaa40' } },
];

interface WorkflowAuditPayload {
  workflowId: string;
  valid: boolean;
  analysis?: {
    issues?: Array<{
      severity: 'error' | 'warning' | 'info';
      type: string;
      message: string;
      nodeId?: string;
      edgeId?: string;
    }>;
    summary?: {
      nodeCount?: number;
      edgeCount?: number;
      maxDepth?: number;
      layerCount?: number;
    };
  };
  scheduleTasks?: Array<{
    id: string;
    cron: string;
    enabled: boolean;
    next_run_at: number | null;
    intensity?: string;
    audience?: string;
    source_node_id?: string | null;
    last_error?: string | null;
  }>;
}

function formatWorkflowTime(value?: number | null): string {
  if (!value) return 'never';
  const ms = value > 100_000_000_000 ? value : value * 1000;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return 'invalid';
  }
}

function getNodeConfig(node: Node): WorkflowNodeConfig {
  const data = node.data as unknown as WorkflowNodeData;
  return data.config || {};
}

function workflowExecutionId(scope: 'workflow' | 'node', id?: string | null): string {
  return `${scope}-${id || 'local'}-${Date.now()}`;
}

function workflowReduceMessages(t: ReturnType<typeof useTranslation>['t']) {
  return {
    workflowStarted: (executionId: string) => t('canvas.exec.workflowStarted', { executionId }),
    workflowCompleted: t('canvas.exec.workflowCompleted'),
    workflowFailed: t('canvas.exec.workflowFailed'),
    workflowCancelled: 'Workflow cancelled by user',
    nodeStarted: (label: string) => t('canvas.exec.startRunning', { label }),
    nodeCompleted: (duration?: string) => duration ? `${t('canvas.exec.nodeCompleted')} (${duration})` : t('canvas.exec.nodeCompleted'),
    nodeFailed: t('canvas.exec.nodeFailed'),
    nodeSkipped: 'skipped by condition branch',
  };
}

function applyWorkflowProjectionEvent(
  event: WorkflowProjectionEvent,
  t: ReturnType<typeof useTranslation>['t'],
  nodes: Node[],
  edges: Edge[],
  preserveNodeId?: string | null,
) {
  return useCanvasStore.getState().applyWorkflowEvent(event, {
    defaultNodes: nodes as unknown as WorkflowCanvasNode[],
    defaultEdges: edges as unknown as WorkflowCanvasEdge[],
    preserveNodeId,
    messages: workflowReduceMessages(t),
  });
}

// ─── Inner Flow ───

function canvasStateSignature(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({ nodes, edges });
}

function FlowCanvas({ onCtxMenu, onNodeClick, onCanvasChange, onActionHandlerReady, onWorkflowEvent, initialNodes, initialEdges }: {
  onCtxMenu: (m: CtxMenu | null) => void;
  onNodeClick: (nodeId: string) => void;
  onCanvasChange?: (nodes: Node[], edges: Edge[]) => void;
  onActionHandlerReady?: (handler: (action: string, ctx: CanvasActionContext) => void) => void;
  onWorkflowEvent: (event: WorkflowProjectionEvent) => void;
  initialNodes: Node[];
  initialEdges: Edge[];
}) {
  const rf = useReactFlow();
  const { t } = useTranslation();
  const connectFromNodeId = useCanvasStore((s) => s.connectFromNodeId);

  // ReactFlow owns interaction state; saved workflow selection replaces it without echoing back.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);
  const onCanvasChangeRef = useRef(onCanvasChange);
  const lastAppliedPropsSignatureRef = useRef(canvasStateSignature(initialNodes, initialEdges));
  const skipNextCanvasChangeRef = useRef(false);

  useEffect(() => {
    onCanvasChangeRef.current = onCanvasChange;
  }, [onCanvasChange]);

  useEffect(() => {
    const nextSignature = canvasStateSignature(initialNodes, initialEdges);
    if (nextSignature === lastAppliedPropsSignatureRef.current) return;
    lastAppliedPropsSignatureRef.current = nextSignature;
    skipNextCanvasChangeRef.current = true;
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Trigger auto-save when users edit ReactFlow state, not when props are applied from saved workflows/SSE.
  useEffect(() => {
    if (skipNextCanvasChangeRef.current) {
      skipNextCanvasChangeRef.current = false;
      return;
    }
    onCanvasChangeRef.current?.(nodes, edges);
  }, [nodes, edges]);

  const onConnect = useCallback((p: Connection) => setEdges((e) => addEdge({ ...p, type: 'workflow', style: { stroke: '#333' } }, e)), [setEdges]);

  const onNodeCtx = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    onCtxMenu({ x: e.clientX, y: e.clientY, type: 'node', nodeId: node.id });
  }, [onCtxMenu]);

  const onEdgeCtx = useCallback((e: React.MouseEvent, edge: Edge) => {
    e.preventDefault();
    onCtxMenu({ x: e.clientX, y: e.clientY, type: 'edge', edgeId: edge.id });
  }, [onCtxMenu]);

  const onPaneCtx = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    onCtxMenu({ x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY, type: 'canvas' });
  }, [onCtxMenu]);

  // Handle context menu actions — operate directly on ReactFlow state
  const handleAction = useCallback((action: string, ctxMenu: CanvasActionContext) => {
    if (action.startsWith('add-')) {
      if (ctxMenu.x == null || ctxMenu.y == null) return;
      const nt = action.replace('add-', '') as NodeType;
      const pos = rf.screenToFlowPosition({ x: ctxMenu.x, y: ctxMenu.y });
      const id = `${nt}-${Date.now()}`;
      const labels: Record<string, string> = {
        leader: 'Leader',
        agent: 'New Agent',
        tool: 'New Tool',
        template: 'Template',
        variable_assigner: 'Assign Variable',
        variable_aggregator: 'Aggregate Variables',
        list_operator: 'List Operator',
        http_request: 'HTTP Request',
        json_extractor: 'JSON Extractor',
        condition: 'Condition',
        loop: 'Loop',
        parallel: 'Parallel',
        schedule_trigger: 'Schedule',
        input: 'Input',
        output: 'Output',
      };
      const config: Record<string, unknown> = {};
      if (nt === 'loop') { config.loopType = 'count'; config.loopCount = 3; }
      if (nt === 'parallel') { config.parallelBranches = []; config.waitAll = true; }
      if (nt === 'condition') { config.conditionType = 'expression'; }
      if (nt === 'template') { config.template = 'Hello ${input.name}'; config.templateFormat = 'text'; }
      if (nt === 'variable_assigner') { config.assignments = { value: '${input.value}' }; }
      if (nt === 'variable_aggregator') { config.aggregate = {}; }
      if (nt === 'list_operator') { config.listSource = '${input.items}'; config.listOperation = 'length'; }
      if (nt === 'http_request') { config.httpRequest = { method: 'GET', url: 'https://example.com' }; }
      if (nt === 'json_extractor') { config.jsonSource = '${input.text}'; config.extractPaths = { value: '.' }; }
      if (nt === 'schedule_trigger') {
        config.scheduleCron = '0 9 * * *';
        config.scheduleRecurring = true;
        config.scheduleDurable = true;
        config.scheduleEnabled = true;
        config.scheduleIntensity = 'normal';
        config.scheduleAudience = 'personal';
        config.scheduleWorkflowInput = {};
      }
      setNodes((n) => [...n, { id, type: 'workflow', position: pos, data: { label: labels[nt] || 'Node', type: nt, status: 'idle', config } }]);
    }
    if (action === 'fit-view') rf.fitView({ padding: 0.2 });
    if (action === 'reset') {
      setNodes(defaultNodes);
      setEdges(defaultEdges);
    }
    if (action === 'node-delete' && ctxMenu.nodeId) {
      setNodes((ns) => ns.filter((n) => n.id !== ctxMenu.nodeId));
      setEdges((es) => es.filter((e) => e.source !== ctxMenu.nodeId && e.target !== ctxMenu.nodeId));
    }
    if (action === 'node-duplicate' && ctxMenu.nodeId) {
      setNodes((ns) => {
        const orig = ns.find((n) => n.id === ctxMenu.nodeId);
        if (!orig) return ns;
        const nid = `${(orig.data as WorkflowNodeData).type}-${Date.now()}`;
        const dup = { ...orig, id: nid, position: { x: orig.position.x + 40, y: orig.position.y + 40 }, data: { ...orig.data, label: (orig.data as WorkflowNodeData).label + ' (copy)' } };
        return [...ns, dup];
      });
    }
    if (action === 'node-edit' && ctxMenu.nodeId) {
      onNodeClick(ctxMenu.nodeId);
    }
    if (action === 'node-connect' && ctxMenu.nodeId) {
      useCanvasStore.getState().setConnectFromNodeId(ctxMenu.nodeId);
    }
    if (action === 'node-run' && ctxMenu.nodeId) {
      runNode(ctxMenu.nodeId);
    }
    if (action === 'edge-delete' && ctxMenu.edgeId) {
      setEdges((es) => es.filter((e) => e.id !== ctxMenu.edgeId));
    }
    if (ctxMenu.edgeId && action.startsWith('edge-') && action !== 'edge-delete') {
      setEdges((es) => es.map((e) => {
        if (e.id !== ctxMenu.edgeId) return e;
        const data = { ...(e.data || {}) };
        const style: CSSProperties = { ...(e.style || {}) };
        if (action === 'edge-sequence') { data.type = 'sequence'; delete data.conditionValue; style.stroke = '#333'; style.strokeDasharray = undefined; }
        if (action === 'edge-loop') { data.type = 'loop'; delete data.conditionValue; style.stroke = '#c678dd'; style.strokeDasharray = '6 3'; }
        if (action === 'edge-data') { data.type = 'data'; delete data.conditionValue; data.dataMapping = data.dataMapping || {}; style.stroke = '#7dcfff'; style.strokeDasharray = '4 4'; }
        if (action === 'edge-condition-true') { data.type = 'condition'; data.conditionValue = true; style.stroke = '#9ece6a'; style.strokeDasharray = undefined; }
        if (action === 'edge-condition-false') { data.type = 'condition'; data.conditionValue = false; style.stroke = '#f7768e'; style.strokeDasharray = undefined; }
        return { ...e, data, style };
      }));
    }
  }, [rf, setNodes, setEdges, onNodeClick]);

  // Run a single node — creates session if needed
  const runNode = useCallback(async (nodeId: string) => {
    const node = rf.getNode(nodeId);
    if (!node) return;
    const data = node.data as WorkflowNodeData;
    const workflowId = useWorkflowStore.getState().currentWorkflowId ?? undefined;
    const executionId = workflowExecutionId('node', nodeId);
    const startTime = Date.now();

    onWorkflowEvent({
      type: 'workflow:execution_started',
      executionId,
      workflowId,
      startTime,
      summaryLabel: data.label || nodeId,
      receivedAt: startTime,
    });
    onWorkflowEvent({
      type: 'workflow:node_started',
      executionId,
      workflowId,
      nodeId,
      startTime,
      receivedAt: startTime,
    });

    const failNodeRun = (error: string) => {
      const endTime = Date.now();
      onWorkflowEvent({
        type: 'workflow:node_failed',
        executionId,
        workflowId,
        nodeId,
        error,
        startTime,
        endTime,
        duration: endTime - startTime,
        receivedAt: endTime,
      });
      onWorkflowEvent({
        type: 'workflow:execution_failed',
        executionId,
        workflowId,
        error,
        endTime,
        receivedAt: endTime,
      });
    };

    // Ensure we have a session
    let sessionId = useSessionStore.getState().sessionId;
    if (!sessionId) {
      try {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
          body: JSON.stringify({ user_request: '', idle: true }),
        });
        if (res.ok) {
          const sessionData = await res.json();
          sessionId = sessionData.id || sessionData.sessionId;
          if (sessionId) {
            await useSessionStore.getState().fetchSessions();
          }
        }
      } catch (e) {
        console.error('Failed to create session for workflow execution:', e);
      }
    }

    if (!sessionId) {
      failNodeRun(t('canvas.exec.createSessionFailed'));
      return;
    }

    try {
      const res = await fetch('/api/v1/workflows/execute-node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
        body: JSON.stringify({
          sessionId,
          workflowId,
          nodeId,
          nodeType: data.type,
          label: data.label,
          prompt: data.description || data.label,
          systemPrompt: typeof data.systemPrompt === 'string' ? data.systemPrompt : undefined,
          model: typeof data.agentModel === 'string' ? data.agentModel : undefined,
        }),
      });
      const result = await res.json();
      const endTime = Date.now();
      if (res.ok && result?.success) {
        onWorkflowEvent({
          type: 'workflow:node_completed',
          executionId,
          workflowId,
          nodeId,
          result,
          startTime,
          endTime,
          duration: endTime - startTime,
          receivedAt: endTime,
        });
        onWorkflowEvent({
          type: 'workflow:execution_completed',
          executionId,
          workflowId,
          output: result,
          endTime,
          receivedAt: endTime,
        });
        return;
      }
      failNodeRun(typeof result?.error === 'string' ? result.error : t('canvas.exec.nodeFailed'));
    } catch {
      failNodeRun(t('canvas.exec.nodeFailed'));
    }
  }, [onWorkflowEvent, rf, t]);

  // Handle node click: if in connect mode, create edge; otherwise open edit panel
  const handleNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    const store = useCanvasStore.getState();
    if (store.connectFromNodeId && store.connectFromNodeId !== node.id) {
      const fromId = store.connectFromNodeId;
      setEdges((es) => [...es, {
        id: `e-${fromId}-${node.id}`,
        source: fromId,
        target: node.id,
        type: 'workflow',
        style: { stroke: '#333' }
      } as Edge]);
      store.setConnectFromNodeId(null);
    } else {
      store.setConnectFromNodeId(null);
      onNodeClick(node.id);
    }
  }, [onNodeClick, setEdges]);

  // Expose action handler to parent
  useEffect(() => {
    onActionHandlerReady?.(handleAction);
  }, [handleAction, onActionHandlerReady]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeContextMenu={onNodeCtx} onPaneContextMenu={onPaneCtx} onEdgeContextMenu={onEdgeCtx}
      onNodeClick={handleNodeClick}
      nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      fitView
      className="bg-bg-primary"
      proOptions={reactFlowProOptions}
      defaultEdgeOptions={reactFlowDefaultEdgeOptions}
      deleteKeyCode={['Backspace', 'Delete']}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={0.8} color="#1a1a2e" />
      <Controls className="!bg-bg-secondary !border-border-muted !rounded-lg [&>button]:!bg-bg-secondary [&>button]:!border-border-muted [&>button]:!text-text-tertiary [&>button:hover]:!bg-bg-hover [&>button]:!rounded !shadow-none" />
      <MiniMap
        nodeColor={(n) => nodeTheme[(n.data as WorkflowNodeData)?.type]?.border || '#333'}
        className="bg-bg-secondary border border-border-muted rounded-lg"
        maskColor="#0a0a0f90" pannable zoomable
      />
    </ReactFlow>
  );
}

// ─── Main Export ───

export default function CanvasView() {
  const { t } = useTranslation();
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const lastCtxRef = useRef<CtxMenu | null>(null);
  const [workflowSearch, setWorkflowSearch] = useState('');
  const [audit, setAudit] = useState<WorkflowAuditPayload | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [execPanelHeight, setExecPanelHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('lingxiao_exec_panel_height');
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      return Number.isFinite(parsed) && parsed >= 120 && parsed <= 900 ? parsed : 240;
    } catch { return 240; }
  });

  const editingNodeId = useCanvasStore((s) => s.editingNodeId);
  const setEditingNodeId = useCanvasStore((s) => s.setEditingNodeId);
  const showExecPanel = useCanvasStore((s) => s.showExecPanel);
  const setShowExecPanel = useCanvasStore((s) => s.setShowExecPanel);
  const executions = useCanvasStore((s) => s.executions);
  const isExecuting = useCanvasStore((s) => s.isExecuting);

  const currentWfId = useWorkflowStore((s) => s.currentWorkflowId);
  const workflows = useWorkflowStore((s) => s.workflows);
  const workflowError = useWorkflowStore((s) => s.error);
  const isWorkflowLoading = useWorkflowStore((s) => s.isLoading);
  const fetchWorkflows = useWorkflowStore((s) => s.fetchWorkflows);
  const createWorkflow = useWorkflowStore((s) => s.createWorkflow);
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);
  const saveWorkflow = useWorkflowStore((s) => s.saveWorkflow);
  const executeWorkflow = useWorkflowStore((s) => s.executeWorkflow);
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow);
  const setCurrentWorkflowId = useWorkflowStore((s) => s.setCurrentWorkflowId);

  // Store current workflow nodes/edges for saving
  const [currentNodes, setCurrentNodes] = useState<Node[]>(defaultNodes);
  const [currentEdges, setCurrentEdges] = useState<Edge[]>(defaultEdges);
  const currentNodesRef = useRef<Node[]>(currentNodes);
  const currentEdgesRef = useRef<Edge[]>(currentEdges);
  const editingNodeIdRef = useRef<string | null>(editingNodeId);
  useEffect(() => { currentNodesRef.current = currentNodes; }, [currentNodes]);
  useEffect(() => { currentEdgesRef.current = currentEdges; }, [currentEdges]);
  useEffect(() => { editingNodeIdRef.current = editingNodeId; }, [editingNodeId]);

  const applyCanvasWorkflowEvent = useCallback((event: WorkflowProjectionEvent) => {
    const canvasProjection = applyWorkflowProjectionEvent(
      event,
      t,
      currentNodesRef.current,
      currentEdgesRef.current,
      editingNodeIdRef.current,
    );
    setCurrentNodes((canvasProjection.nodes.length > 0 ? canvasProjection.nodes : currentNodesRef.current) as Node[]);
    setCurrentEdges((canvasProjection.edges.length > 0 ? canvasProjection.edges : currentEdgesRef.current) as Edge[]);
    return canvasProjection;
  }, [t]);

  // Track execution output from SSE events
  useEffect(() => {
    let isMounted = true;
    const ensureCanvasProjectionSeeded = () => {
      const store = useCanvasStore.getState();
      if (store.workflowProjection.nodes.length === 0 && currentNodesRef.current.length > 0) {
        store.setWorkflowCanvas(
          currentWfId,
          currentNodesRef.current as unknown as WorkflowCanvasNode[],
          currentEdgesRef.current as unknown as WorkflowCanvasEdge[],
        );
      }
      return useCanvasStore.getState();
    };
    const workflowUnsubscribers = WORKFLOW_REALTIME_EVENT_NAMES.map((eventName) =>
      acpClient.on(eventName, (data: unknown) => {
        if (!isMounted) return;
        const event = normalizeWorkflowRealtimeEvent(eventName as WorkflowRealtimeEventName, data);
        if (!event) return;

        const canvasProjection = applyCanvasWorkflowEvent(event);
        const directoryResult = useWorkflowStore.getState().applyWorkflowEvent(event);
        if (directoryResult.refreshWorkflows) void fetchWorkflows();

        if (event.type === 'workflow:created') {
          localStorage.setItem('lingxiao_current_workflow_id', event.workflowId);
        } else if (event.type === 'workflow:deleted' && !canvasProjection.currentWorkflowId) {
          localStorage.removeItem('lingxiao_current_workflow_id');
        }
      })
    );

    return () => {
      isMounted = false;
      workflowUnsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [applyCanvasWorkflowEvent, currentWfId, fetchWorkflows]);

  // Load workflows on mount, then restore the last-used workflow
  useEffect(() => {
    fetchWorkflows().then(() => {
      const savedId = localStorage.getItem('lingxiao_current_workflow_id');
      if (savedId) {
        loadWorkflow(savedId).then((wf) => {
          if (wf) {
            const nodes = (Array.isArray(wf.nodes) ? wf.nodes : []) as Node[];
            const edges = (Array.isArray(wf.edges) ? wf.edges : []) as Edge[];
            setCurrentNodes(nodes.length > 0 ? nodes : defaultNodes);
            setCurrentEdges(edges.length > 0 ? edges : defaultEdges);
          }
        });
      }
    });
  }, [fetchWorkflows, loadWorkflow]);

  // Auto-save debounce
  const triggerAutoSave = useCallback(() => {
    if (!currentWfId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (currentWfId) {
        const serializedNodes = currentNodesRef.current.map((n) => ({
          id: n.id, type: n.type, position: n.position, data: n.data,
        }));
        const serializedEdges = currentEdgesRef.current.map((e) => ({
          id: e.id, source: e.source, target: e.target, type: e.type, style: e.style, data: e.data,
        }));
        saveWorkflow(currentWfId, { nodes: serializedNodes, edges: serializedEdges });
        localStorage.setItem('lingxiao_current_workflow_id', currentWfId);
      }
    }, 2000);
  }, [currentWfId, saveWorkflow]);

  const handleCtxMenu = useCallback((m: CtxMenu | null) => {
    if (m) lastCtxRef.current = m;
    setCtxMenu(m);
  }, []);

  const handleAction = useCallback((action: string, actionHandler: (action: string, ctx: CanvasActionContext) => void) => {
    if (lastCtxRef.current) {
      actionHandler(action, lastCtxRef.current);
    }
    triggerAutoSave();
  }, [triggerAutoSave]);

  const handleNodeClick = useCallback((nodeId: string) => {
    setEditingNodeId(nodeId);
  }, [setEditingNodeId]);

  // New workflow
  const handleNewWorkflow = useCallback(async () => {
    const name = `Workflow ${workflows.length + 1}`;
    const wf = await createWorkflow(name);
    setCurrentNodes(defaultNodes);
    setCurrentEdges(defaultEdges);
    if (wf) {
      localStorage.setItem('lingxiao_current_workflow_id', wf.id);
    }
  }, [createWorkflow, workflows.length]);

  const refreshAudit = useCallback(async (workflowId: string | null = currentWfId) => {
    if (!workflowId) {
      setAudit(null);
      setAuditError(null);
      return;
    }
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await fetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}/audit`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setAudit(await res.json());
    } catch (error) {
      setAudit(null);
      setAuditError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuditLoading(false);
    }
  }, [currentWfId]);

  useEffect(() => {
    void refreshAudit(currentWfId);
  }, [currentWfId, refreshAudit]);

  // Save workflow
  const handleSaveWorkflow = useCallback(async () => {
    const serializedNodes = currentNodes ? currentNodes.map((n) => ({
      id: n.id, type: n.type, position: n.position, data: n.data,
    })) : [];
    const serializedEdges = currentEdges ? currentEdges.map((e) => ({
      id: e.id, source: e.source, target: e.target, type: e.type, style: e.style, data: e.data,
    })) : [];

    if (!currentWfId) {
      // No workflow yet, create one first
      const name = `Workflow ${workflows.length + 1}`;
      const wf = await createWorkflow(name);
      if (wf) {
        await saveWorkflow(wf.id, { nodes: serializedNodes, edges: serializedEdges });
        localStorage.setItem('lingxiao_current_workflow_id', wf.id);
        await refreshAudit(wf.id);
      }
      return;
    }
    await saveWorkflow(currentWfId, { nodes: serializedNodes, edges: serializedEdges });
    localStorage.setItem('lingxiao_current_workflow_id', currentWfId);
    await refreshAudit(currentWfId);
  }, [currentWfId, createWorkflow, saveWorkflow, refreshAudit, workflows.length, currentNodes, currentEdges]);

  // Load workflow
  const handleLoadWorkflow = useCallback(async (id: string) => {
    const wf = await loadWorkflow(id);
    if (wf && wf.nodes && wf.edges) {
      const nodes = (Array.isArray(wf.nodes) ? wf.nodes : []) as Node[];
      const edges = (Array.isArray(wf.edges) ? wf.edges : []) as Edge[];
      setCurrentNodes(nodes.length > 0 ? nodes : defaultNodes);
      setCurrentEdges(edges.length > 0 ? edges : defaultEdges);
    }
    localStorage.setItem('lingxiao_current_workflow_id', id);
    await refreshAudit(id);
  }, [loadWorkflow, refreshAudit]);

  // Delete workflow
  const handleDeleteWorkflow = useCallback(async (id: string) => {
    await deleteWorkflow(id);
    if (localStorage.getItem('lingxiao_current_workflow_id') === id) {
      localStorage.removeItem('lingxiao_current_workflow_id');
      setCurrentNodes(defaultNodes);
      setCurrentEdges(defaultEdges);
      setAudit(null);
    }
  }, [deleteWorkflow]);

  const ensureExecutionSessionId = useCallback(async (): Promise<string | null> => {
    let sessionId = useSessionStore.getState().sessionId;
    if (sessionId) {
      try { await acpClient.connect(sessionId); } catch (error) { console.warn('[CanvasView] ACP connect failed:', error); }
      return sessionId;
    }

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
        body: JSON.stringify({ user_request: '', idle: true }),
      });
      if (!res.ok) return null;
      const sessionData = await res.json();
      sessionId = sessionData.id || sessionData.sessionId;
      if (sessionId) {
        await useSessionStore.getState().fetchSessions();
        try { await acpClient.connect(sessionId); } catch (error) { console.warn('[CanvasView] ACP connect failed:', error); }
      }
      return sessionId || null;
    } catch {
      return null;
    }
  }, []);

  // Run entire workflow through backend WorkflowEngine
  const handleRunWorkflow = useCallback(async () => {
    const store = useCanvasStore.getState();
    store.clearExecutions();
    store.setShowExecPanel(true);

    const serializedNodes = currentNodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
    }));
    const serializedEdges = currentEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
      style: e.style,
      data: e.data,
    }));

    let workflowId = currentWfId;
    if (!workflowId) {
      const wf = await createWorkflow(`Workflow ${workflows.length + 1}`);
      workflowId = wf?.id || null;
      if (workflowId) localStorage.setItem('lingxiao_current_workflow_id', workflowId);
    }
    if (!workflowId) {
      const executionId = workflowExecutionId('workflow');
      const now = Date.now();
      applyCanvasWorkflowEvent({
        type: 'workflow:execution_started',
        executionId,
        startTime: now,
        summaryLabel: t('canvas.toolbar.runWorkflow'),
        receivedAt: now,
      });
      applyCanvasWorkflowEvent({
        type: 'workflow:execution_failed',
        executionId,
        error: t('canvas.exec.createWorkflowFailed'),
        endTime: now,
        receivedAt: now,
      });
      return;
    }

    const sessionId = await ensureExecutionSessionId();
    if (!sessionId) {
      const executionId = workflowExecutionId('workflow', workflowId);
      const now = Date.now();
      applyCanvasWorkflowEvent({
        type: 'workflow:execution_started',
        executionId,
        workflowId,
        startTime: now,
        summaryLabel: t('canvas.toolbar.runWorkflow'),
        receivedAt: now,
      });
      applyCanvasWorkflowEvent({
        type: 'workflow:execution_failed',
        executionId,
        workflowId,
        error: t('canvas.exec.createSessionFailed'),
        endTime: now,
        receivedAt: now,
      });
      return;
    }

    await saveWorkflow(workflowId, {
      nodes: serializedNodes,
      edges: serializedEdges,
      config: { sessionId },
    });
    localStorage.setItem('lingxiao_current_workflow_id', workflowId);

    const result = await executeWorkflow(workflowId);
    if (!result) {
      const executionId = workflowExecutionId('workflow', workflowId);
      const now = Date.now();
      applyCanvasWorkflowEvent({
        type: 'workflow:execution_started',
        executionId,
        workflowId,
        startTime: now,
        summaryLabel: t('canvas.toolbar.runWorkflow'),
        receivedAt: now,
      });
      applyCanvasWorkflowEvent({
        type: 'workflow:execution_failed',
        executionId,
        workflowId,
        error: t('canvas.exec.startWorkflowFailed'),
        endTime: now,
        receivedAt: now,
      });
      return;
    }

    applyCanvasWorkflowEvent({
      type: 'workflow:execution_started',
      executionId: result.executionId,
      workflowId,
      startTime: Date.now(),
      summaryLabel: t('canvas.toolbar.runWorkflow'),
      receivedAt: Date.now(),
    });
  }, [applyCanvasWorkflowEvent, currentNodes, currentEdges, currentWfId, createWorkflow, executeWorkflow, ensureExecutionSessionId, saveWorkflow, workflows.length, t]);

  const handleStopWorkflow = useCallback(async () => {
    const executionId = useCanvasStore.getState().currentExecutionId;
    if (!executionId) {
      return;
    }
    try {
      await fetch(`/api/v1/workflows/executions/${encodeURIComponent(executionId)}/cancel`, {
        method: 'POST',
        headers: { 'x-lingxiao-token': getServerToken() },
      });
    } catch (e) {
      console.error('cancel workflow failed:', e);
    } finally {
      applyCanvasWorkflowEvent({
        type: 'workflow:execution_cancelled',
        executionId,
        workflowId: currentWfId ?? undefined,
        reason: 'Workflow cancelled by user',
        endTime: Date.now(),
        receivedAt: Date.now(),
      });
    }
  }, [applyCanvasWorkflowEvent, currentWfId]);

  const handlePauseWorkflow = useCallback(async () => {
    const executionId = useCanvasStore.getState().currentExecutionId;
    if (!executionId) return;
    try {
      await fetch(`/api/v1/workflows/executions/${encodeURIComponent(executionId)}/pause`, {
        method: 'POST',
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      applyCanvasWorkflowEvent({
        type: 'workflow:execution_paused',
        executionId,
        workflowId: currentWfId ?? undefined,
        receivedAt: Date.now(),
      });
    } catch (e) {
      console.error('pause workflow failed:', e);
    }
  }, [applyCanvasWorkflowEvent, currentWfId]);

  // Get current workflow name
  const currentWf = workflows.find((w) => w.id === currentWfId);

  // Find the editing node from current nodes
  const editingNode = editingNodeId ? currentNodes.find((n) => n.id === editingNodeId) : null;

  // Callback to update nodes/edges from FlowCanvas
  const handleNodesEdgesChange = useCallback((nodes: Node[], edges: Edge[]) => {
    setCurrentNodes(nodes);
    setCurrentEdges(edges);
  }, []);

  // Callback to update node data from NodeEditPanel
  const handleNodeUpdate = useCallback((nodeId: string, data: Partial<WorkflowNodeData>) => {
    setCurrentNodes((ns) => {
      const next = ns.map((n) => n.id === nodeId
        ? { ...n, data: { ...n.data, ...data, config: { ...((n.data as WorkflowNodeData).config || {}), ...(data.config || {}) } } }
        : n
      );
      currentNodesRef.current = next;
      return next;
    });
    triggerAutoSave();
  }, [triggerAutoSave]);

  // Callback to run node from NodeEditPanel
  const handleNodeRun = useCallback((nodeId: string) => {
    if (actionHandlerRef.current) {
      actionHandlerRef.current('node-run', { nodeId });
    }
  }, []);

  // Action handler that gets passed to FlowCanvas
  const actionHandlerRef = useRef<((action: string, ctx: CanvasActionContext) => void) | null>(null);

  const filteredWorkflows = workflows.filter((wf) => {
    const needle = workflowSearch.trim().toLowerCase();
    if (!needle) return true;
    return [wf.name, wf.description, wf.workspace, ...(wf.tags || [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
  const scheduleTriggerNodes = currentNodes
    .filter((node) => ((node.data as unknown as WorkflowNodeData)?.type) === 'schedule_trigger')
    .map((node) => {
      const data = node.data as unknown as WorkflowNodeData;
      const config = getNodeConfig(node);
      return {
        id: node.id,
        label: data.label || node.id,
        cron: String(config.scheduleCron || ''),
        enabled: config.scheduleEnabled ?? true,
        intensity: String(config.scheduleIntensity || 'normal'),
        audience: String(config.scheduleAudience || 'personal'),
      };
    });
  const activeExecutionCount = executions.filter((e) => isWorkflowNodeActiveStatus(e.status)).length;
  const auditIssues = audit?.analysis?.issues || [];
  const auditErrorCount = auditIssues.filter((issue) => issue.severity === 'error').length;
  const auditWarningCount = auditIssues.filter((issue) => issue.severity === 'warning').length;
  const scheduleTaskByNode = new Map((audit?.scheduleTasks || []).map((task) => [task.source_node_id || '', task]));

  return (
    <div className="flex h-full bg-bg-primary relative overflow-hidden">
      <aside className="w-[310px] shrink-0 border-r border-border-default bg-bg-secondary flex flex-col min-h-0">
        <div className="px-3 py-3 border-b border-border-default">
          <div className="flex items-center gap-2">
            <Workflow size={15} className="text-accent-brand" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-mono tracking-widest text-accent-brand/70 uppercase">Workflow Ops</div>
              <div className="text-[10px] text-text-tertiary truncate">{currentWf?.name || t('canvas.toolbar.unnamed')}</div>
            </div>
            <button
              className="p-1.5 text-text-tertiary hover:text-accent-brand hover:bg-bg-hover rounded border border-border-default"
              onClick={() => { void fetchWorkflows(); void refreshAudit(currentWfId); }}
              title="Refresh"
            >
              <RefreshCw size={13} className={isWorkflowLoading || auditLoading ? 'animate-spin' : ''} />
            </button>
            <button
              className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded border border-border-default"
              onClick={handleNewWorkflow}
              title={t('canvas.toolbar.newWorkflow')}
            >
              <FilePlus size={13} />
            </button>
          </div>
          <div className="relative mt-3">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              value={workflowSearch}
              onChange={(event) => setWorkflowSearch(event.target.value)}
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-primary border border-border-input rounded text-text-primary placeholder:text-text-tertiary"
              placeholder="Search workflows"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-3 py-2 flex items-center justify-between border-b border-border-default/60">
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">Library</span>
            <span className="text-[10px] font-mono text-text-tertiary">{filteredWorkflows.length}/{workflows.length}</span>
          </div>
          {workflowError && (
            <div className="mx-3 mt-2 px-2 py-1.5 text-[10px] text-accent-red border border-accent-red/30 bg-accent-red/10 rounded">
              {workflowError}
            </div>
          )}
          {filteredWorkflows.length === 0 ? (
            <div className="px-3 py-6 text-xs text-text-tertiary">{t('canvas.toolbar.noWorkflows')}</div>
          ) : (
            <div className="py-1">
              {filteredWorkflows.map((wf) => {
                const selected = wf.id === currentWfId;
                return (
                  <div
                    key={wf.id}
                    className={`mx-2 my-1 rounded border transition-colors ${
                      selected
                        ? 'border-accent-brand/50 bg-accent-brand/10'
                        : 'border-transparent hover:border-border-default hover:bg-bg-hover'
                    }`}
                  >
                    <button
                      className="w-full text-left px-2 py-2"
                      onClick={() => handleLoadWorkflow(wf.id)}
                    >
                      <div className="flex items-center gap-2">
                        <Workflow size={12} className={selected ? 'text-accent-brand' : 'text-text-tertiary'} />
                        <span className={`min-w-0 flex-1 truncate text-xs ${selected ? 'text-text-primary' : 'text-text-secondary'}`}>
                          {wf.name}
                        </span>
                        {wf.scheduleTriggerCount ? (
                          <span className="text-[9px] font-mono text-accent-yellow bg-accent-yellow/10 px-1.5 py-0.5 rounded">
                            {wf.scheduleTriggerCount}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[9px] font-mono text-text-tertiary">
                        <span>{wf.nodeCount ?? 0}N</span>
                        <span>{wf.edgeCount ?? 0}E</span>
                        <span className="ml-auto truncate">{formatWorkflowTime(wf.updatedAt)}</span>
                      </div>
                    </button>
                    <div className="px-2 pb-2 flex items-center justify-between gap-2">
                      <span className="text-[9px] text-text-tertiary truncate">{wf.description || wf.workspace || wf.id}</span>
                      <button
                        className="p-1 text-text-tertiary hover:text-accent-red rounded hover:bg-accent-red/10"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (window.confirm(`Delete workflow "${wf.name}"?`)) void handleDeleteWorkflow(wf.id);
                        }}
                        title={t('canvas.toolbar.delete')}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border-default p-3 space-y-3">
          <section>
            <div className="flex items-center gap-2 mb-2">
              <ListChecks size={13} className="text-text-tertiary" />
              <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">Current</span>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {[
                ['Nodes', currentNodes.length],
                ['Edges', currentEdges.length],
                ['Triggers', scheduleTriggerNodes.length],
                ['Running', activeExecutionCount],
              ].map(([label, value]) => (
                <div key={label} className="bg-bg-primary border border-border-default rounded px-2 py-1.5">
                  <div className="text-[14px] font-mono text-text-primary leading-none">{value}</div>
                  <div className="mt-1 text-[8px] font-mono uppercase text-text-tertiary">{label}</div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-2">
              <Clock size={13} className="text-accent-yellow" />
              <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">Schedule Triggers</span>
            </div>
            {scheduleTriggerNodes.length === 0 ? (
              <div className="text-[10px] text-text-tertiary border border-dashed border-border-default rounded px-2 py-2">
                Right-click canvas to add a Schedule node.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                {scheduleTriggerNodes.map((trigger) => {
                  const task = scheduleTaskByNode.get(trigger.id);
                  return (
                    <button
                      key={trigger.id}
                      className="w-full text-left border border-border-default bg-bg-primary rounded px-2 py-1.5 hover:border-accent-brand/50"
                      onClick={() => setEditingNodeId(trigger.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${trigger.enabled ? 'bg-accent-green' : 'bg-text-tertiary'}`} />
                        <span className="text-[11px] text-text-primary truncate flex-1">{trigger.label}</span>
                        {task ? <CheckCircle2 size={12} className="text-accent-green" /> : <AlertTriangle size={12} className="text-accent-yellow" />}
                      </div>
                      <div className="mt-1 text-[9px] font-mono text-text-tertiary truncate">{trigger.cron || 'missing cron'}</div>
                      <div className="mt-1 flex gap-1 text-[8px] font-mono uppercase">
                        <span className="text-accent-brand bg-accent-brand/10 px-1 rounded">{trigger.intensity}</span>
                        <span className="text-text-tertiary bg-bg-hover px-1 rounded">{trigger.audience}</span>
                        {task?.next_run_at ? <span className="ml-auto text-text-tertiary normal-case">{formatWorkflowTime(task.next_run_at)}</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {audit?.valid ? <CheckCircle2 size={13} className="text-accent-green" /> : <AlertTriangle size={13} className="text-accent-yellow" />}
                <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">Audit</span>
              </div>
              <button
                className="p-1 text-text-tertiary hover:text-accent-brand rounded hover:bg-bg-hover"
                onClick={() => { void refreshAudit(currentWfId); }}
                title="Run audit"
              >
                <RefreshCw size={12} className={auditLoading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="bg-bg-primary border border-border-default rounded px-2 py-2">
              {!currentWfId ? (
                <div className="text-[10px] text-text-tertiary">Save or select a workflow to audit.</div>
              ) : auditError ? (
                <div className="text-[10px] text-accent-red">{auditError}</div>
              ) : auditLoading ? (
                <div className="text-[10px] text-text-tertiary">Auditing...</div>
              ) : audit ? (
                <>
                  <div className="flex items-center gap-2 text-[10px] font-mono">
                    <span className={audit.valid ? 'text-accent-green' : 'text-accent-yellow'}>{audit.valid ? 'VALID' : 'NEEDS WORK'}</span>
                    <span className="text-text-tertiary">{auditErrorCount} errors</span>
                    <span className="text-text-tertiary">{auditWarningCount} warnings</span>
                    <span className="ml-auto text-text-tertiary">{audit.scheduleTasks?.length || 0} tasks</span>
                  </div>
                  {auditIssues.length > 0 && (
                    <div className="mt-2 space-y-1 max-h-28 overflow-y-auto pr-1">
                      {auditIssues.slice(0, 4).map((issue, idx) => (
                        <div key={`${issue.type}-${idx}`} className="text-[9px] text-text-tertiary leading-snug">
                          <span className={issue.severity === 'error' ? 'text-accent-red' : issue.severity === 'warning' ? 'text-accent-yellow' : 'text-accent-brand'}>
                            {issue.severity}
                          </span>
                          {issue.nodeId ? <span className="font-mono"> {issue.nodeId}</span> : null}
                          <span>: {issue.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-[10px] text-text-tertiary">No audit data yet.</div>
              )}
            </div>
          </section>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col bg-bg-primary">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-muted bg-bg-secondary shrink-0">
          <Workflow size={14} className="text-accent-brand/60" />
          <span className="text-[11px] font-mono tracking-widest text-accent-brand/50 uppercase">Canvas</span>
          <span className="text-xs text-text-primary truncate max-w-[280px]">{currentWf?.name || t('canvas.toolbar.unnamed')}</span>
          <div className="flex-1" />

          {isExecuting ? (
            <>
              <button
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors text-accent-yellow hover:bg-accent-yellow/10"
                onClick={handlePauseWorkflow}
                title={t('canvas.workflow.pause', 'Pause')}
              >
                <Pause size={13} />
                <span>{t('canvas.workflow.pause', 'Pause')}</span>
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors text-accent-red hover:bg-accent-red/10"
                onClick={handleStopWorkflow}
                title={t('canvas.workflow.stop')}
              >
                <Square size={13} />
                <span>{t('canvas.workflow.stop')}</span>
              </button>
            </>
          ) : (
            <button
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors text-accent-brand hover:bg-accent-brand/10"
              onClick={handleRunWorkflow}
              title={t('canvas.toolbar.runWorkflow')}
            >
              <Play size={13} />
              <span>{t('canvas.toolbar.run')}</span>
            </button>
          )}

          <div className="w-px h-4 bg-border-default mx-1" />
          <button
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            onClick={handleNewWorkflow}
            title={t('canvas.toolbar.newWorkflow')}
          >
            <FilePlus size={13} />
            <span>{t('canvas.toolbar.new')}</span>
          </button>
          <button
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-tertiary hover:text-accent-brand hover:bg-bg-hover rounded transition-colors"
            onClick={handleSaveWorkflow}
            title={t('canvas.toolbar.saveWorkflow')}
          >
            <Save size={13} />
            <span>{t('canvas.toolbar.save')}</span>
          </button>
          <button
            className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
              showExecPanel ? 'text-accent-brand bg-accent-brand/10' : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
            }`}
            onClick={() => setShowExecPanel(!showExecPanel)}
            title={t('canvas.toolbar.execOutput')}
          >
            <Terminal size={13} />
            <span>{t('canvas.toolbar.output')}</span>
            {activeExecutionCount > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent-brand animate-pulse" />
            )}
          </button>
          <div className="w-px h-4 bg-border-default mx-1" />
          <span className="text-[9px] font-mono text-text-tertiary">{t('canvas.toolbar.hint')}</span>
        </div>

        <div className={`flex-1 min-h-0 relative flex ${showExecPanel ? 'flex-col' : ''}`}>
          <div className={`relative ${showExecPanel ? 'flex-1 min-h-0' : 'flex-1 min-h-0'}`}>
            <ReactFlowProvider key={currentWfId || 'default'}>
              <FlowCanvas
                initialNodes={currentNodes}
                initialEdges={currentEdges}
                onCtxMenu={handleCtxMenu}
                onNodeClick={handleNodeClick}
                onCanvasChange={(nodes, edges) => {
                  setCurrentNodes(nodes);
                  setCurrentEdges(edges);
                  triggerAutoSave();
                }}
                onActionHandlerReady={(handler) => {
                  actionHandlerRef.current = handler;
                }}
                onWorkflowEvent={applyCanvasWorkflowEvent}
              />
              {editingNodeId && editingNode && (
                <NodeEditPanel
                  node={editingNode}
                  onClose={() => setEditingNodeId(null)}
                  onUpdate={handleNodeUpdate}
                  onRun={handleNodeRun}
                />
              )}
            </ReactFlowProvider>
          </div>
          {showExecPanel && (
            <div className="shrink-0 relative" style={{ height: execPanelHeight }}>
              <div
                className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-10 hover:bg-accent-brand/30"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = execPanelHeight;
                  const onMove = (ev: MouseEvent) => {
                    const next = Math.max(120, Math.min(900, startH + (startY - ev.clientY)));
                    setExecPanelHeight(next);
                  };
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    try { localStorage.setItem('lingxiao_exec_panel_height', String(execPanelHeight)); } catch (error) { console.warn('[CanvasView] Failed to persist execution panel height:', error); }
                  };
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                }}
                title={t('canvas.execution.resize', 'Drag to resize')}
              />
              <ExecutionPanel
                executions={executions}
                onClear={() => useCanvasStore.getState().clearExecutions()}
                onClose={() => setShowExecPanel(false)}
              />
            </div>
          )}
        </div>
      </main>
      {ctxMenu && <CtxMenuComp menu={ctxMenu} onClose={() => setCtxMenu(null)} onAction={(action) => {
        if (actionHandlerRef.current) {
          handleAction(action, actionHandlerRef.current);
        }
      }} />}
    </div>
  );
}
