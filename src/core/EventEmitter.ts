import { EventEmitter as NodeEventEmitter } from 'events';
import type { Task } from './TaskBoard.js';
import type { OrchestrationTaskMetadata, OrchestrationVerdict } from './OrchestrationTypes.js';
import type { EdgeDefinition, ExecutionLog, NodeDefinition, WorkflowDefinition } from './workflow/types.js';
import type { BusMessage, MessagePriority } from './MessageBus.js';
import type { DAGSnapshot, RunExplanation } from './OrchestrationTypes.js';
import type { WorkNote } from './WorkNoteManager.js';
import type { MessageContent, ThinkingBlock, ToolCall } from '../llm/types.js';
import type { BlackboardEvent, BlackboardDelta } from './blackboard/types.js';
import type { LlmInputManifest } from './LlmInputManifest.js';
import type { SessionRuntimeState } from './SessionRuntimeState.js';
import type { InteractionTurnState } from './TurnCoordinator.js';
import type { TransportEnvelope } from './transport/Transport.js';
import type { WorkerRecoveryPayload } from './AgentProtocol.js';
import { coreLogger } from './Log.js';

export type LeaderStatusKind = 'active' | 'idle' | 'waiting' | 'interrupted' | 'completed';

// 事件类型定义
export interface EventMap {
  'leader:status': {
    sessionId: string;
    status: string;
    statusKind?: LeaderStatusKind;
    pollCount?: number;
    runningAgents?: string[];
  };
  'leader:route': {
    sessionId: string;
    mode: 'direct' | 'hybrid' | 'delegate';
    reason: string;
    /** A4 可审查 trace：路由触发来源（确定性，可选） */
    trigger?: string | null;
    /** A4 可审查 trace：决策时刻工作快照（结构化确定性字段，可选） */
    workSnapshot?: {
      dispatchableCount: number;
      runningAgentsCount: number;
      sessionTotalTokens: number;
    } | null;
  };
  'permission:mode_changed': {
    sessionId: string;
    mode: 'strict' | 'dev' | 'networked' | 'yolo';
    summary: string;
  };
  'leader:control_mode_changed': {
    sessionId: string;
    mode: 'manual' | 'eternal';
    previousMode: 'manual' | 'eternal';
  };
  'leader:blueprint_updated': {
    sessionId: string;
    blueprint: unknown;
    coverage?: unknown;
  };
  'session:collaboration_mode_changed': {
    sessionId: string;
    mode: 'solo' | 'team';
  };
  'session:execution_route_changed': {
    sessionId: string;
    mode: 'auto' | 'direct' | 'hybrid' | 'delegate';
  };
  'eternal:goal_changed': {
    sessionId: string;
    goal: unknown | null;
    action: 'set' | 'pause' | 'resume' | 'clear';
  };
  'permission:request': {
    sessionId: string;
    requestId: string;
    source: 'leader' | 'worker';
    toolName: string;
    reason: string;
    requestedMode?: 'strict' | 'dev' | 'networked' | 'yolo';
    requestedHosts?: string[];
    workerName?: string;
  };
  'permission:resolved': {
    sessionId: string;
    requestId: string;
    decision: 'approved' | 'rejected' | 'allowAll';
    workerName?: string;
    toolName: string;
  };
  'leader:tool_call': { sessionId: string; tool: string; input: string; callId?: string };
  /**
   * 工具入参流式增量。
   * 在 LLM 仍在生成 tool 参数 JSON 时按 chunk 触发；leader:tool_call 在该 tool_call
   * 流式完成时一次性触发，两者顺序：tool_call_delta(*N) → tool_call(1)。
   */
  'leader:tool_call_delta': {
    sessionId: string;
    index: number;
    callId?: string;
    tool?: string;
    partialJson: string;
  };
  'leader:tool_result': { sessionId: string; tool: string; result: MessageContent | object; callId?: string; error?: boolean };
  'leader:text': { sessionId: string; content: string; reasoningContent?: string };
  'leader:llm_retry': {
    sessionId: string;
    attempt: number;
    message: string;
    errorKind?: string;
    retryable?: boolean;
  };
  'conversation:message_saved': {
    sessionId: string;
    id: number;
    role: string;
    content: MessageContent | object;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    /** 结构化 thinking blocks（替代 reasoningContent，多轮回传时必需） */
    thinking?: ThinkingBlock[];
    timestamp: number;
    source?: string;
  };
  'leader:text_chunk': { sessionId: string; chunk: string };
  'leader:thinking_chunk': { sessionId: string; chunk: string };
  /**
   * Leader 阶段变更事件。
   * 对齐 CodeBuddy SessionRunStateMachine 的 phaseSubject 推送：
   * preparing → model_requesting → streaming → tool_executing → idle 等。
   */
  'leader:phase_change': {
    sessionId: string;
    phase: string;
    /** 当前执行的工具名称（仅 tool_executing 阶段） */
    toolName?: string;
    /** 正在流式输出参数的工具名称（仅 streaming 阶段，用于 "writing file" 等文案） */
    streamingToolName?: string;
  };
  'context:runtime_updated': {
    sessionId: string;
    owner: 'leader' | 'agent';
    ownerName?: string;
    state: unknown;
  };
  'llm:input_manifest': {
    sessionId?: string;
    actor: LlmInputManifest['actor'];
    actorLabel: string;
    manifest: LlmInputManifest;
  };
  'assumption:declared': { assumption: unknown };
  'assumption:verified': { assumptionId: string; evidence: string };
  'assumption:falsified': { assumptionId: string; evidence: string; dependents: string[]; assumption: unknown };
  'leader:plan_approved': { sessionId: string };
  'leader:plan_rejected': { sessionId: string; feedback?: string };
  'leader:error': { sessionId: string; error: Error };
  'agent:start': { agentId: string; name: string; role: string };
  'agent:started': { sessionId?: string; agentId: string; name: string; taskId?: string; backend?: 'worker_process' | 'claude' | 'codex' | 'remote'; externalSessionId?: string; pid?: number; logPath?: string };
  'agent:spawned': {
    sessionId: string;
    agentId: string;
    name: string;
    role: string;
    taskId: string;
    workingDirectory?: string;
    writeScope?: string[];
    baselineRole?: string;
    skillNames?: string[];
    droppedTools?: string[];
    tools?: string[];
    workerBackend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    externalSessionId?: string;
    externalPid?: number;
    pid?: number;
    logPath?: string;
  };
  'agent:stop': { agentId: string; name: string; sessionId?: string };
  'agent:message': { agentId: string; message: string };
  'agent:progress': { agentId: string; name: string; sessionId?: string; taskId: string; message: string };
  'agent:heartbeat': {
    agentId: string;
    agentName: string;
    sessionId?: string;
    taskId: string;
    phase?: string;
    timestamp?: number;
  };
  'agent:status': { agentId: string; agentName: string; sessionId?: string; status: string; backend?: 'worker_process' | 'claude' | 'codex' | 'remote'; externalSessionId?: string; pid?: number; logPath?: string; recoveryAction?: string; recoverable?: boolean };
  'agent:thinking': { agentId: string; agentName: string; sessionId?: string; iteration: number };
  'agent:context_updated': {
    sessionId?: string;
    agentId: string;
    agentName: string;
    tokens: number;
    maxTokens?: number;
  };
  'agent:text': {
    agentId: string;
    agentName: string;
    sessionId?: string;
    content: string;
    reasoningContent?: string;
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    externalSessionId?: string;
  };
  'agent:llm_retry': {
    sessionId?: string;
    agentId: string;
    agentName: string;
    attempt: number;
    message: string;
    errorKind?: string;
    retryable?: boolean;
  };
  'agent:text_chunk': {
    agentId: string;
    agentName: string;
    sessionId?: string;
    chunk: string;
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    externalSessionId?: string;
  };
  'agent:thinking_chunk': {
    agentId: string;
    agentName: string;
    sessionId?: string;
    chunk: string;
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    externalSessionId?: string;
  };
  'agent:tool_call': {
    agentId: string;
    agentName?: string;
    sessionId?: string;
    taskId?: string;
    callId?: string;
    tool: string;
    input: unknown;
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    externalSessionId?: string;
  };
  /** Worker 工具入参流式增量（与 leader:tool_call_delta 对称） */
  'agent:tool_call_delta': {
    agentId: string;
    agentName?: string;
    sessionId?: string;
    index: number;
    callId?: string;
    tool?: string;
    partialJson: string;
  };
  'agent:tool_result': {
    agentId: string;
    agentName?: string;
    sessionId?: string;
    taskId?: string;
    callId?: string;
    tool: string;
    result: unknown;
    error?: boolean;
    isError?: boolean;
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    externalSessionId?: string;
  };
  /**
   * 长工具心跳事件。Shell 已经有更细粒度的 agent:tool_output / agent:shell_state，
   * 这里专门面向 WebFetch / FileRead / Glob / Agent dispatch / HttpRequest / Python
   * 等长跑但本身没有内部 progress 的工具，每 N 秒推一帧让前端 UI 不至于完全静默。
   */
  'agent:tool_progress': {
    agentId?: string;
    agentName?: string;
    sessionId?: string;
    taskId?: string;
    callId?: string;
    tool: string;
    /** 累计已执行毫秒数 */
    elapsedMs: number;
    /** 给前端的简短状态文案（如"WebFetch 已运行 12s"） */
    message: string;
  };
  /** Leader 工具心跳（与 agent:tool_progress 对称） */
  'leader:tool_progress': {
    sessionId: string;
    callId?: string;
    tool: string;
    elapsedMs: number;
    message: string;
  };
  'agent:tool_output': {
    agentId: string;
    agentName?: string;
    sessionId?: string;
    taskId?: string;
    callId?: string;
    tool: string;
    chunk: string;
    stream: 'stdout' | 'stderr';
    pid?: number;
  };
  'agent:shell_state': {
    agentId: string;
    agentName?: string;
    sessionId?: string;
    taskId?: string;
    callId?: string;
    tool: string;
    pid?: number;
    status: 'started' | 'completed' | 'failed' | 'killed';
  };
  'terminal:output': {
    terminalId: string;
    sessionId?: string;
    agentId: string;
    agentName?: string;
    taskId?: string;
    chunk: string;
    stream: 'stdout' | 'stderr';
    pid?: number;
  };
  'terminal:state': {
    terminalId: string;
    sessionId?: string;
    agentId: string;
    agentName?: string;
    taskId?: string;
    pid?: number;
    status: 'started' | 'running' | 'suspended' | 'resumed' | 'completed' | 'failed' | 'killed';
    exitCode?: number | null;
    exitSignal?: string | null;
  };
  'agent:interactive_state': {
    agentId: string;
    agentName: string;
    sessionId?: string;
    taskId?: string;
    state: unknown;
  };
  'agent:completed': {
    sessionId?: string;
    agentId: string;
    agentName: string;
    taskId: string;
    result: string;
    stats: { iterations: number; toolCalls: number };
    tokenUsage?: { total?: number; prompt?: number; completion?: number };
    reason?: string;
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    externalSessionId?: string;
    pid?: number;
    logPath?: string;
    exitCode?: number | null;
    exitSignal?: string | null;
  };
  'agent:error': {
    sessionId?: string;
    agentId: string;
    agentName?: string;
    taskId?: string;
    error: Error;
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    externalSessionId?: string;
  };
  'agent:crashed': {
    sessionId?: string;
    agentId: string;
    agentName?: string;
    taskId?: string;
    name: string;
    exitCode?: number;
    signal?: string;
    status?: string;
    recoverable?: boolean;
    recoveryAction?: string;
    pid?: number;
    backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
    error?: string;
    timeoutReason?: string;
    stderrTail?: string[];
    stdoutTail?: string[];
  };
  'agent:failed': { sessionId?: string; agentId: string; agentName: string; error: string; taskId?: string; source?: string; errorDetail?: string; backend?: 'worker_process' | 'claude' | 'codex' | 'remote'; externalSessionId?: string; pid?: number; logPath?: string; recoverable?: boolean; recoveryAction?: string; stderrTail?: string[]; stdoutTail?: string[] };
  'runtime_recovery:changed': {
    sessionId: string;
    action: 'saved' | 'cleared' | 'auto_retry_started' | 'auto_retry_failed';
    taskId?: string;
    record?: WorkerRecoveryPayload;
    reason?: string;
  };
  'agent:intervention': { sessionId: string; agentId: string; agentName: string; taskId?: string; message_type: string; content: string };
  'agent:terminated': {
    sessionId?: string;
    agentId: string;
    agentName: string;
    taskId?: string;
    status: string;
    reason?: string;
  };
  'task:created': { task: Task };
  'task:updated': { task: Task };
  'task:deleted': { taskId: string; task?: Task };
  'task:assigned': { task: Task; agentId: string };
  'task:completed': { taskId: string; result: unknown; task?: Task };
  'task:failed': { taskId: string; reason: string; task?: Task };
  'task:cancelled': { taskId: string; reason?: string; task?: Task };
  'orchestration:run_state': {
    sessionId: string;
    runId: string;
    status: 'idle' | 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
    generation: number;
    totalNodes: number;
    completedNodes: number;
    failedNodes: number;
    blockedNodes: number;
    activeNodeIds: string[];
    currentNodeId: string | null;
    bottleneck?: string;
    summary: string;
    eventCount: number;
  };
  'orchestration:node_update': {
    sessionId: string;
    runId: string;
    eventType?: string;
    task: Task;
    metadata: OrchestrationTaskMetadata;
    displayState?: string;
  };
  'orchestration:event_applied': {
    sessionId: string;
    runId: string;
    eventId: string;
    eventType: string;
    taskId?: string;
    nodeKind?: string;
    generation?: number;
    verdict?: OrchestrationVerdict;
  };
  'orchestration:event_rejected': {
    sessionId: string;
    runId: string;
    eventId: string;
    eventType: string;
    reason: string;
    taskId?: string;
  };
  'session:created': { sessionId: string; workspace?: string; createdAt?: number };
  'session:failed': { sessionId: string; error: string };
  'session:completed': { sessionId: string; summary?: string };
  'session:renamed': { sessionId: string; name: string };
  'session:soul_extracted': { sessionId: string; soulPath?: string; entryCount: number };
  'session:interrupted': { sessionId: string; stoppedAgents?: number };
  'session:deleted': { sessionId: string };
  /** Web UI 切换会话时通知同进程 TUI 同步 */
  'session:focus': { sessionId: string; status?: 'active' | 'completed' | 'failed' | 'interrupted'; workspace?: string };
  'user:input_needed': {
    sessionId: string;
    question: string;
    options?: Array<{ value: string; label?: string }>;
    multiSelect?: boolean;
    /** Multi-question wizard */
    questions?: Array<{ question: string; options?: Array<{ value: string; label?: string }>; multiSelect?: boolean }>;
  };
  /** Emitted when user answer is received (e.g. from Web UI) — TUI should dismiss its question dialog */
  'user:question_answered': { sessionId: string; answer?: string };

  'session:runtime_state': {
    sessionId: string;
    runtimeState: SessionRuntimeState;
    turn: InteractionTurnState;
    reason?: string;
    source?: string;
    at: number;
  };
  'skills:loaded': { sessionId: string; skills: Array<{ name: string; source?: string; summary?: string }> };
  'skill:invoked': { skills: Array<{ name: string; source?: string; summary?: string }> };
  'notification:new': {
    sessionId?: string;
    id: string;
    type: string;
    priority: 'critical' | 'important' | 'normal' | string;
    title: string;
    message: string;
    timestamp: number;
    read: boolean;
    taskId?: string;
    notification?: { sessionId?: string };
  };
  'notification:mark_read': { notificationId?: string };
  'plan:submitted': { sessionId: string; plan: unknown };
  'plan:updated': { sessionId: string; plan: unknown; reason?: string };
  'plan:finalized': { sessionId: string; planId: string; finalStatus: string; summary?: string };
  'token:usage': { sessionId: string; agentId: string; ts: number; usage: { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }; persisted?: boolean; persistError?: string };
  'token:usage:persist_failed': { sessionId: string; agentId: string; ts: number; usage: { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }; persisted: false; persistError?: string };
  'agent:llm_call': { agentId: string; agentName: string; iteration: number };
  'context:compressed': {
    sessionId: string;
    oldTokens: number;
    newTokens: number;
    messageCount: number;
    compactType: string;
    archivePath?: string;
    owner?: 'leader' | 'agent';
    ownerName?: string;
    threshold?: number;
    historyCount?: number;
  };
  /**
   * 压缩「进行中」事件（区别于终态 context:compressed）。
   * 让 Web/TUI 在 LLM 分层摘要期间显示进度，避免长压缩时界面看起来卡死。
   */
  'context:compacting': {
    sessionId: string;
    owner?: 'leader' | 'agent';
    ownerName?: string;
    /** 当前阶段：准备 / LLM 分层摘要 / 收尾 */
    stage: 'preparing' | 'llm_summary' | 'finalizing' | 'algorithmic';
    /** 生命周期：开始 / 进行中 / 结束 */
    phase: 'start' | 'progress' | 'end';
    /** LLM 分层摘要时的分块进度（从 1 计） */
    chunkIndex?: number;
    /** LLM 分层摘要时的分块总数 */
    chunkTotal?: number;
    /** 整体压缩进度百分比（0-100） */
    percent?: number;
    /** 压缩前 token 数 */
    oldTokens?: number;
    /** 压缩后 token 数（通常 end 才有） */
    newTokens?: number;
    /** 当前压缩阈值 */
    threshold?: number;
    /** 当前候选消息数 */
    messageCount?: number;
    /** UI 可显示的短标签 */
    label?: string;
  };
  'context:overflow': {
    sessionId: string;
    tokens: number;
    threshold: number;
    owner: 'leader' | 'agent';
    agentId?: string;
    agentName?: string;
  };
  'message:bus:priority': BusMessage & { priority: MessagePriority };
  'message:bus:handler_failed': {
    messageId: string;
    to: string;
    handlerRecipient: string;
    type: string;
    error: string;
    timestamp: number;
  };
  'bus:dead_letter': {
    sessionId: string;
    from: string;
    to: string;
    type: string;
    payload: unknown;
    error: string;
    attempts: number;
    timestamp: number;
  };
  'message:bus:stale_p0p1_preserved': {
    recipient: string;
    p0: number;
    p1: number;
    clearedP2: number;
    clearedP3: number;
    ageMs: number;
    timestamp: number;
  };
  'work_note:written': {
    sessionId: string;
    agentId: string;
    note: WorkNote;
  };
  'work_note:requested': {
    sessionId: string;
    requesterAgentId: string;
    targetAgentId: string;
  };
  'blackboard:event': BlackboardEvent;
  /** 聚合后的黑板增量事件 — LeaderBlackboard 在 trailing-coalesce 窗口结束时发出，
   *  携带完整的 changedNodes/changedEdges/humanSummary，由 SseBridge / TUI / AgentPool
   *  共享同一份结构化数据，避免订阅方各自查图重算。 */
  'blackboard:delta': BlackboardDelta & { sessionId: string };
  /** 黑板初始化结果 — 成功 enabled=true；初始化异常时 enabled=false。
   *  TUI / Web UI 可借此同步 graphEnabled 状态，而非依赖静态 config。 */
  'blackboard:initialized': { sessionId: string; enabled: boolean; reason?: string };
  'orchestration:dag_updated': { sessionId: string; snapshot: DAGSnapshot };
  'run:explanation_updated': { sessionId: string; explanation: RunExplanation };
  'team:message_sent': {
    sessionId?: string;
    message: unknown;
    toTeam: string;
    isBroadcast: boolean;
  };
  'team:message_read': {
    sessionId?: string;
    memberName: string;
    messageIds: string[];
  };
  'shutdown': { reason: string };
  /** Leader 进度停滞检测 — 连续 N 轮哈希不变 */
  'leader:progress_stagnant': {
    sessionId: string;
    consecutiveStagnantRounds: number;
    progressHash: string;
  };
  /** Watchdog 告警 — Leader 超过阈值时间无进度 */
  'leader:watchdog_alert': {
    sessionId: string;
    elapsedMs: number;
    thresholdMs: number;
    intervention: string;
  };
  'leader:round_complete': { sessionId: string; trigger: string };
  'leader:message_queued': { sessionId: string; queueLength: number };
  'leader:message_dequeued': { sessionId: string; queueLength: number };
  // Wiki 事件
  'wiki:generation_started': { sessionId?: string; projectPath: string; lang: string };
  'wiki:generation_progress': { sessionId?: string; projectPath: string; lang: string; phase: string; progress: number; detail: string };
  'wiki:generation_stream': { sessionId?: string; projectPath: string; lang: string; sectionId: string; sectionTitle: string; chunk: string };
  'wiki:generation_completed': { sessionId?: string; projectPath: string; lang: string; result: unknown };
  'wiki:generation_failed': { sessionId?: string; projectPath: string; lang: string; error: string };
  // 记忆维护（dream/distill）生命周期 — 驱动 TUI 状态行 + Web 右下角浮层动画
  'memory:maintenance_started': { sessionId?: string; kind: 'dream' | 'distill' };
  'memory:maintenance_progress': { sessionId?: string; kind: 'dream' | 'distill'; phase: string; progress: number; detail: string };
  'memory:maintenance_completed': { sessionId?: string; kind: 'dream' | 'distill'; summary: string };
  'memory:maintenance_failed': { sessionId?: string; kind: 'dream' | 'distill'; error: string };
  // 用户消息跨端同步（source 标识发送方：'tui' | 'web'）
  'chat:user_message': { sessionId: string; role: 'user'; content: string; timestamp: number; source?: string };
  'plugin:toggled': { pluginId: string; enabled: boolean; sessionId?: string; toolNames?: readonly string[]; toolCount?: number };
  /** roles 配置变更（settings.roles.basic_tools_enabled / overrides 任一更新都广播） */
  'roles:changed': { action: string; name?: string };

  // Workflow 事件
  'workflow:created': { workflow: WorkflowDefinition; workflowId: string; sessionId?: string };
  'workflow:updated': { workflowId: string; workflow: WorkflowDefinition; updates: Partial<WorkflowDefinition>; sessionId?: string };
  'workflow:deleted': { workflowId: string; sessionId?: string };
  'workflow:node_added': { workflowId: string; sessionId?: string; node: NodeDefinition };
  'workflow:node_updated': { workflowId: string; sessionId?: string; nodeId: string; node: NodeDefinition; updates: Partial<NodeDefinition> };
  'workflow:node_deleted': { workflowId: string; sessionId?: string; nodeId: string; deletedEdges?: string[] };
  'workflow:edge_added': { workflowId: string; sessionId?: string; edge: EdgeDefinition };
  'workflow:edge_updated': { workflowId: string; sessionId?: string; edgeId: string; edge: EdgeDefinition; updates: Partial<EdgeDefinition> };
  'workflow:edge_deleted': { workflowId: string; sessionId?: string; edgeId: string };
  'workflow:execution_started': { workflowId: string; executionId: string; sessionId: string; [key: string]: unknown };
  'workflow:execution_completed': { workflowId: string; executionId: string; sessionId?: string; duration?: number; [key: string]: unknown };
  'workflow:execution_failed': { workflowId?: string; executionId: string; sessionId?: string; timeoutMs?: number; error?: string; reason?: string; [key: string]: unknown };
  'workflow:execution_cancelled': { executionId: string; sessionId?: string; [key: string]: unknown };
  'workflow:execution_paused': { executionId: string; sessionId?: string; [key: string]: unknown };
  'workflow:execution_resumed': { executionId: string; sessionId?: string; [key: string]: unknown };
  'workflow:execution_progress': { workflowId?: string; executionId: string; sessionId?: string; [key: string]: unknown };
  'workflow:node_started': { nodeId: string; executionId: string; sessionId?: string; [key: string]: unknown };
  'workflow:node_completed': { nodeId: string; executionId: string; sessionId?: string; result?: unknown; log?: ExecutionLog; [key: string]: unknown };
  'workflow:node_failed': { nodeId: string; executionId: string; sessionId?: string; error?: string; [key: string]: unknown };
  'workflow:node_retrying': { nodeId: string; executionId: string; sessionId?: string; attempt?: number; [key: string]: unknown };
  'workflow:node_skipped': { nodeId: string; executionId: string; sessionId?: string; [key: string]: unknown };

  // WorkerProcessRunner 低层事件（用于诊断桥接）
  'worker:started': { workerId: string; sessionId?: string; payload?: unknown };
  'worker:progress': { workerId: string; sessionId?: string; payload?: unknown };
  'worker:heartbeat': { workerId: string; sessionId?: string; payload?: unknown };
  'worker:complete': { workerId: string; sessionId?: string; payload?: unknown };
  'worker:failed': { workerId: string; sessionId?: string; payload?: unknown };
  'worker:error': { workerId: string; sessionId?: string; error?: unknown; payload?: unknown };
  'worker:exit': { workerId: string; sessionId?: string; code?: number | null; signal?: string | null; status?: string; payload?: unknown };
  'worker:stdout': { workerId: string; sessionId?: string; data?: string; payload?: unknown };
  'worker:stderr': { workerId: string; sessionId?: string; data?: string; payload?: unknown };
  'worker:usage': { workerId: string; sessionId?: string; payload?: unknown };
  'worker:bus_message': { workerId: string; sessionId?: string; payload?: unknown };
  'worker:event': { workerId: string; sessionId?: string; payload?: unknown };
  'transport:envelope': TransportEnvelope;
  'permission:audit': {
    sessionId: string;
    timestamp: number;
    actor: string;
    source: string;
    mode: string;
    toolName?: string;
    reason: string;
    requestId?: string;
    workerName?: string;
  };
  'collaboration:review_recorded': {
    sessionId: string;
    message: unknown;
  };
  'collaboration:decision_recorded': {
    sessionId: string;
    message: unknown;
  };
  'collaboration:coordination_recorded': {
    sessionId: string;
    message: unknown;
  };
  'tools:changed': {
    action: string;
    name: string;
  };
  'langfuse:trace': {
    sessionId: string;
    trace: {
      id: string;
      timestamp: string;
      actor: string;
      model: string;
      status: 'ok' | 'error';
      latencyMs: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      errorKind?: string;
      agentId?: string;
      taskId?: string;
    };
  };
  'session:resync_failed': {
    sessionId: string;
    reason: string;
    attempts: number;
  };
  'git:activity': {
    sessionId: string;
    agentId: string;
    agentName: string;
    taskId?: string;
    action: 'commit' | 'push' | 'pull' | 'branch_create' | 'branch_switch' | 'merge_mr' | 'create_mr';
    success: boolean;
    timestamp: number;
    /** Commit-specific fields */
    commitHash?: string;
    commitMessage?: string;
    author?: { name: string; email: string };
    branch?: string;
    /** Pre-commit gate result */
    gateResult?: {
      passed: boolean;
      enabled: boolean;
      diagnostics: string[];
    };
    /** Error message on failure */
    error?: string;
  };
}

export type EventName = keyof EventMap;
export type EventHandler<T extends EventName> = (data: EventMap[T]) => void | Promise<void>;

/**
 * 类型安全的事件发射器
 * 参考 Claude Code 的事件系统设计
 */
export class EventEmitter {
  private emitter: NodeEventEmitter;

  constructor() {
    this.emitter = new NodeEventEmitter();
    // 设置最大监听器数量
    this.emitter.setMaxListeners(100);
  }

  /**
   * 订阅事件
   */
  on<T extends EventName>(event: T, handler: EventHandler<T>): this;
  on(event: string, handler: (data: unknown) => void | Promise<void>): this;
  on(event: EventName | string, handler: EventHandler<EventName> | ((data: unknown) => void | Promise<void>)): this {
    this.emitter.on(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  /**
   * 订阅事件，返回取消订阅函数
   */
  subscribe<T extends EventName>(event: T, handler: EventHandler<T>): () => void;
  subscribe(event: string, handler: (data: unknown) => void | Promise<void>): () => void;
  subscribe(event: EventName | string, handler: EventHandler<EventName> | ((data: unknown) => void | Promise<void>)): () => void {
    const wrappedHandler = handler as (...args: unknown[]) => void;
    this.emitter.on(event as string, wrappedHandler);

    // 泄漏检测：单事件监听器超过 50 时告警
    const count = this.emitter.listenerCount(event as string);
    if (count > 50) {
      coreLogger.warn(`[EventEmitter] Event "${event}" has ${count} listeners (possible leak)`);
    }

    return () => {
      this.emitter.off(event as string, wrappedHandler);
    };
  }

  /**
   * 订阅一次性事件
   */
  once<T extends EventName>(event: T, handler: EventHandler<T>): this;
  once(event: string, handler: (data: unknown) => void | Promise<void>): this;
  once(event: EventName | string, handler: EventHandler<EventName> | ((data: unknown) => void | Promise<void>)): this {
    this.emitter.once(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  /**
   * 取消订阅事件
   */
  off<T extends EventName>(event: T, handler: EventHandler<T>): this;
  off(event: string, handler: (data: unknown) => void | Promise<void>): this;
  off(event: EventName | string, handler: EventHandler<EventName> | ((data: unknown) => void | Promise<void>)): this {
    this.emitter.off(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  /**
   * 发射事件
   */
  emit<T extends EventName>(event: T, data: EventMap[T]): boolean;
  emit(event: string, data: unknown): boolean;
  emit(event: EventName | string, data: EventMap[EventName] | unknown): boolean {
    try {
      return this.emitter.emit(event as string, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[EventEmitter] handler threw on "' + String(event) + '": ' + msg);
      return false;
    }
  }

  /**
   * 移除所有监听器
   */
  removeAllListeners(event?: EventName): this {
    if (event) {
      this.emitter.removeAllListeners(event as string);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  /**
   * 获取监听器数量
   */
  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event as string);
  }
}

let defaultEmitter: EventEmitter | undefined;

export function createEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export function getEventEmitter(): EventEmitter {
  defaultEmitter ??= createEventEmitter();
  return defaultEmitter;
}

export default EventEmitter;
