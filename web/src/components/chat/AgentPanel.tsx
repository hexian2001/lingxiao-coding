/**
 * AgentPanel — 右侧子Agent独立面板
 *
 * 展示每个运行中/已完成的子Agent对话：
 * - 顶部Tab栏切换不同Agent
 * - 每个Agent显示：状态、文本输出、思考过程、工具调用
 * - 用户可在此查看Agent的完整工作过程
 */

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import SafeMarkdown from '../ui/SafeMarkdown';
import PreCopyButton from './PreCopyButton';
import {
  X, Cpu, ChevronDown, ChevronRight, CheckCircle2, XCircle,
  Loader2, Brain, Wrench, Activity, Maximize2, Minimize2, ArrowRight, Zap,
  Terminal, Search, FilePlus2, PencilLine, Files, Network, GitBranch, Square,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useSessionStore, type AgentConversation, type AgentMessage } from '../../stores/sessionStore';
import { useArtifactStore } from '../../stores/artifactStore';
import { isToolCallOpenStatus, normalizeAgentStatus, normalizeToolCallStatus, type NormalizedAgentStatus } from '../../stores/sessionStoreHelpers.ts';
import { formatFileChangeSummary } from '../../utils/fileChangeSummary';
import { classifyTool, type ToolUiKind } from './toolClassification';
import ToolOutputView from './ToolOutputView';
import { inferInputLanguage, inferOutputLanguage } from './toolOutputFormat';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

const statusConfig = {
  idle:      { color: 'text-text-tertiary', bg: 'bg-bg-secondary border-border-default', icon: <Activity size={14} className="text-text-tertiary" />, labelKey: 'agent.status.idle' },
  running:   { color: 'text-accent-brand', bg: 'bg-accent-brand/10 border-accent-brand/20', icon: <Loader2 size={14} className="text-accent-brand animate-spin" />, labelKey: 'agent.status.running' },
  recovering: { color: 'text-accent-blue', bg: 'bg-accent-blue/10 border-accent-blue/20', icon: <Loader2 size={14} className="text-accent-blue animate-spin" />, labelKey: 'agent.status.recovering' },
  completed: { color: 'text-accent-green', bg: 'bg-accent-green/10 border-accent-green/20', icon: <CheckCircle2 size={14} className="text-accent-green" />, labelKey: 'agent.status.completed' },
  failed:    { color: 'text-accent-red', bg: 'bg-accent-red/10 border-accent-red/20', icon: <XCircle size={14} className="text-accent-red" />, labelKey: 'agent.status.failed' },
  interrupted: { color: 'text-accent-yellow', bg: 'bg-accent-yellow/10 border-accent-yellow/20', icon: <XCircle size={14} className="text-accent-yellow" />, labelKey: 'agent.status.interrupted' },
};

function compactPath(path?: string, max = 54): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  if (normalized.length <= max) return normalized;
  const parts = normalized.split('/').filter(Boolean);
  const tail = parts.slice(-3).join('/');
  return tail.length < max ? `.../${tail}` : `...${normalized.slice(-(max - 3))}`;
}

// 性能优化 (T-8)：用 memo 包裹，当 onClose/onExpandChange 未变且内部 store 状态
// 未变时跳过 re-render，避免 ChatView 每次 setState 导致 AgentPanel 级联重渲。
function AgentPanel({ onClose, onExpandChange }: { onClose: () => void; onExpandChange?: (expanded: boolean) => void }) {
  const { t } = useTranslation();
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const stopAgent = useSessionStore((s) => s.stopAgent);
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  // 正在停止的 agentId：DELETE 进行中显示 spinner，避免重复点击。
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const handleStopAgent = useCallback(async (agentId: string) => {
    setStoppingId(agentId);
    try {
      await stopAgent(agentId);
    } finally {
      setStoppingId(null);
    }
  }, [stopAgent]);
  const handleSetExpanded = (v: boolean) => { setIsExpanded(v); onExpandChange?.(v); };
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Get agent list from both runtime state and conversation history.
  // 会话切换/重连时这两路数据可能短暂只到一边：只要任一侧存在，就应能打开面板。
  const agentList = useMemo(() => {
    const byId = new Map<string, {
      agentId: string;
      agentName: string;
      role: string;
      status: string;
      spawnedAt?: number;
      normalizedStatus: NormalizedAgentStatus;
      conv: AgentConversation;
    }>();

    for (const agent of agents) {
      const conv = agentConversations[agent.agentId];
      byId.set(agent.agentId, {
        agentId: agent.agentId,
        agentName: agent.agentName || conv?.agentName || agent.agentId,
        role: agent.role || conv?.role || 'worker',
        status: agent.status || conv?.status || 'running',
        spawnedAt: agent.spawnedAt,
        normalizedStatus: normalizeAgentStatus(agent.status || conv?.status || 'running'),
        conv: conv || {
          agentId: agent.agentId,
          agentName: agent.agentName || agent.agentId,
          role: agent.role || 'worker',
          status: normalizeAgentStatus(agent.status || 'running') as AgentConversation['status'],
          taskId: agent.taskId,
          workingDirectory: agent.workingDirectory,
          writeScope: agent.writeScope,
          backend: agent.backend,
          externalSessionId: agent.externalSessionId,
          pid: agent.pid,
          messages: [],
        },
      });
    }

    for (const conv of Object.values(agentConversations)) {
      const existing = byId.get(conv.agentId);
      if (existing) {
        byId.set(conv.agentId, {
          ...existing,
          agentName: existing.agentName || conv.agentName,
          role: existing.role || conv.role || 'worker',
          status: existing.status || conv.status,
          normalizedStatus: normalizeAgentStatus(existing.status || conv.status),
          conv,
        });
        continue;
      }
      byId.set(conv.agentId, {
        agentId: conv.agentId,
        agentName: conv.agentName || conv.agentId,
        role: conv.role || 'worker',
        status: conv.status || 'completed',
        spawnedAt: conv.messages[0]?.timestamp,
        normalizedStatus: normalizeAgentStatus(conv.status || 'completed'),
        conv,
      });
    }

    return Array.from(byId.values())
      // 稳定排序：按首次出现时间升序，避免 tab 顺序随 SSE 事件到达序抖动
      .sort((a, b) => (a.spawnedAt ?? 0) - (b.spawnedAt ?? 0));
  }, [agents, agentConversations]);

  const runningCount = useMemo(() =>
    agentList.filter(a => a.normalizedStatus === 'running').length,
    [agentList]
  );
  const completedCount = useMemo(() =>
    agentList.filter(a => a.normalizedStatus === 'completed').length,
    [agentList]
  );

  // Auto-select first running agent, or first agent
  useEffect(() => {
    if (activeAgentId && agentList.find((a) => a.agentId === activeAgentId)) return;
    const running = agentList.find((a) => a.normalizedStatus === 'running');
    if (running) setActiveAgentId(running.agentId);
    else if (agentList.length > 0) setActiveAgentId(agentList[0].agentId);
  }, [agentList, activeAgentId]);

  // Auto-scroll: Virtuoso's followOutput sticks to the bottom while streaming; on
  // agent switch we jump to the bottom of the newly-selected conversation.
  const activeAgent = activeAgentId ? agentList.find((a) => a.agentId === activeAgentId) : null;
  useEffect(() => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
  }, [activeAgentId]);

  if (agentList.length === 0) {
    return (
      <div className="agent-panel-shell flex flex-col h-full border-l border-border-default">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-accent-purple" />
            <span className="text-xs font-medium text-text-primary">{t('agent.panel')}</span>
          </div>
          <button onClick={onClose} className="p-1 text-text-tertiary hover:text-text-primary transition-colors"><X size={14} /></button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Cpu size={28} className="text-text-tertiary/30 mx-auto mb-2" />
            <p className="text-text-tertiary text-xs">{t('agent.noActive')}</p>
            <p className="text-text-tertiary/60 text-[10px] mt-1">{t('agent.autoShow')}</p>
          </div>
        </div>
      </div>
    );
  }

  const activeConv = activeAgent?.conv ?? null;
  // Grouped agent messages, memoized (groupAgentMessages was recomputed on every
  // render before) and windowed by Virtuoso so a chatty agent's full log no longer
  // creates one DOM node per message.
  const groupedMessages = useMemo(
    () => groupAgentMessages(activeConv?.messages ?? []),
    [activeConv?.messages],
  );
  return (
    <div className="agent-panel-shell w-full flex flex-col h-full border-l border-border-default">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted shrink-0">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-accent-purple" />
          <span className="text-sm font-semibold text-text-primary">{t('agent.panel')}</span>
          {runningCount > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-info-bg text-accent-brand text-[10px] font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-brand animate-pulse" />
              {runningCount}
            </span>
          )}
          {completedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success-bg text-accent-green text-[10px] font-mono">
              <CheckCircle2 size={10} /> {completedCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleSetExpanded(!isExpanded)}
            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
            title={isExpanded ? t('agent.collapse') : t('agent.expand')}
          >
            {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button onClick={onClose} className="p-1 text-text-tertiary hover:text-text-primary transition-colors"><X size={14} /></button>
        </div>
      </div>

      {/* Agent tabs */}
      <div className="flex overflow-x-auto border-b border-border-muted shrink-0 scrollbar-none bg-bg-secondary/60 px-2 pt-2">
        {agentList.length === 0 && (
          <div className="text-sm text-text-tertiary p-4">{t('agent.noRunning')}</div>
        )}
        {agentList.map((a) => {
          const isActive = a.agentId === activeAgentId;
          const canStopTab = a.normalizedStatus === 'running' || a.normalizedStatus === 'recovering';
          const tabStopping = stoppingId === a.agentId;
          return (
            <div key={a.agentId} className="flex items-stretch">
            <button
              onClick={() => setActiveAgentId(a.agentId)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs border-b-2 rounded-t-md transition-colors whitespace-nowrap ${
                isActive
                  ? 'border-accent-brand text-text-primary bg-bg-card'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {a.normalizedStatus === 'running'
                ? <Loader2 size={11} className="text-accent-brand animate-spin" />
                : a.normalizedStatus === 'completed'
                  ? <CheckCircle2 size={11} className="text-accent-green" />
                  : a.normalizedStatus === 'failed'
                    ? <XCircle size={11} className="text-accent-red" />
                    : a.normalizedStatus === 'interrupted'
                      ? <XCircle size={11} className="text-accent-yellow" />
                      : <Activity size={11} className="text-text-tertiary" />
              }
              <span className="truncate max-w-[80px] font-medium">{a.agentName}</span>
              {a.conv?.backend && a.conv.backend !== 'worker_process' && (
                <span className={`px-1 py-0.5 rounded text-[8px] font-mono ${a.conv.backend === 'claude' ? 'bg-accent-purple/10 text-accent-purple' : 'bg-accent-blue/10 text-accent-blue'}`}>
                  {a.conv.backend}
                </span>
              )}
              {a.conv && a.conv.messages.length > 0 && (
                <span className={`text-[9px] ${isActive ? 'text-accent-brand/60' : 'text-text-tertiary/60'}`}>{a.conv.messages.length}</span>
              )}
            </button>
            {canStopTab && (
              <button
                onClick={() => handleStopAgent(a.agentId)}
                disabled={tabStopping}
                title={t('agent.stop.title')}
                aria-label={t('agent.stop.title')}
                className="flex items-center self-center mr-1 px-1.5 py-1 rounded-md text-accent-red/70 hover:text-accent-red hover:bg-accent-red/10 disabled:opacity-50 transition-colors"
              >
                {tabStopping
                  ? <Loader2 size={11} className="animate-spin" />
                  : <Square size={11} className="fill-current" />}
              </button>
            )}
            </div>
          );
        })}
      </div>

      {/* Active agent content */}
      {activeConv && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Agent header card */}
          <div className="shrink-0 max-h-[45%] overflow-y-auto px-4 py-3 border-b border-border-muted bg-bg-secondary/50">
            <div className="flex items-center gap-2.5">
              {(() => {
                const activeStatus = normalizeAgentStatus(activeConv.status);
                const cfg = statusConfig[activeStatus];
                return (
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center border ${cfg.bg}`}>
                <Cpu size={16} className={cfg.color} />
              </div>
                );
              })()}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary truncate">{activeConv.agentName}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${statusConfig[normalizeAgentStatus(activeConv.status)].bg} ${statusConfig[normalizeAgentStatus(activeConv.status)].color}`}>
                    {t(statusConfig[normalizeAgentStatus(activeConv.status)].labelKey)}
                  </span>
                  {activeConv.backend && (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${activeConv.backend === 'worker_process' ? 'bg-bg-tertiary text-text-tertiary border-border-default' : activeConv.backend === 'claude' ? 'bg-accent-purple/10 text-accent-purple border-accent-purple/20' : 'bg-accent-blue/10 text-accent-blue border-accent-blue/20'}`}>
                      {activeConv.backend}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-0.5">
                  {activeConv.role && (
                    <span className="text-[10px] text-text-tertiary font-mono">{activeConv.role}</span>
                  )}
                  {activeConv.externalSessionId && (
                    <span className="text-[10px] text-text-tertiary font-mono">{t('agent.external.session')} {activeConv.externalSessionId.slice(0, 12)}</span>
                  )}
                  {activeConv.pid && (
                    <span className="text-[10px] text-text-tertiary font-mono">{t('agent.external.pid')} {activeConv.pid}</span>
                  )}
                  {activeConv.messages.length > 0 && (
                    <span className="text-[10px] text-text-tertiary">{t('agent.messageCount', { count: activeConv.messages.length })}</span>
                  )}
                </div>
                {activeConv.workingDirectory && (
                  <button
                    type="button"
                    onClick={() => openArtifact({ path: activeConv.workingDirectory!, name: activeConv.workingDirectory! })}
                    className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-accent-green/80 hover:text-accent-green font-mono transition-colors"
                    title={activeConv.workingDirectory}
                  >
                    <GitBranch size={10} className="shrink-0" />
                    <span className="truncate underline-offset-2 hover:underline">{compactPath(activeConv.workingDirectory)}</span>
                  </button>
                )}
                {(activeConv.logPath || activeConv.recovery?.recoveryAction || activeConv.diagnostics?.stderrTail?.length || activeConv.diagnostics?.stdoutTail?.length) && (
                  <div className="mt-2 rounded-md border border-border-default/40 bg-bg-primary/60 px-2 py-1.5 space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary">
                      <Terminal size={10} />
                      <span className="font-medium text-text-secondary">{t('agent.external.diagnostics')}</span>
                      {activeConv.recovery?.recoveryAction && (
                        <span className={activeConv.recovery.recoverable ? 'text-accent-yellow' : 'text-accent-red'}>
                          {activeConv.recovery.recoveryAction}
                        </span>
                      )}
                    </div>
                    {activeConv.logPath && (
                      <button
                        type="button"
                        onClick={() => openArtifact({ path: activeConv.logPath!, name: activeConv.logPath! })}
                        className="flex w-full min-w-0 items-center gap-1 text-[10px] text-text-tertiary hover:text-accent-brand font-mono transition-colors"
                        title={activeConv.logPath}
                      >
                        <span className="shrink-0">{t('agent.external.log')}</span>
                        <span className="truncate underline-offset-2 hover:underline">{activeConv.logPath}</span>
                      </button>
                    )}
                    {activeConv.diagnostics?.stderrTail?.slice(-2).map((line, index) => (
                      <div key={`stderr-${index}`} className="text-[10px] text-accent-red/80 font-mono truncate">{t('agent.external.stderr')} {line}</div>
                    ))}
                    {activeConv.diagnostics?.stdoutTail?.slice(-2).map((line, index) => (
                      <div key={`stdout-${index}`} className="text-[10px] text-text-tertiary font-mono truncate">{t('agent.external.stdout')} {line}</div>
                    ))}
                  </div>
                )}
                {/* Token stats */}
                {activeConv.tokenUsage && activeConv.tokenUsage.total > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <div className="flex items-center gap-1 text-text-tertiary">
                        <Zap size={9} className="text-accent-yellow" />
                        <span className="font-mono">
                          {t('agent.tokens.total', { count: activeConv.tokenUsage.total })}
                        </span>
                        <span className="text-text-tertiary/50">
                          {t('agent.tokens.io', { input: activeConv.tokenUsage.prompt.toLocaleString(), output: activeConv.tokenUsage.completion.toLocaleString() })}
                        </span>
                      </div>
                      {activeConv.contextRatio != null && (
                        <span className={`font-mono text-[10px] ${
                          activeConv.contextRatio > 0.85 ? 'text-accent-red' :
                          activeConv.contextRatio > 0.65 ? 'text-accent-yellow' :
                          'text-text-tertiary'
                        }`}>
                          {Math.round(activeConv.contextRatio * 100)}%
                        </span>
                      )}
                    </div>
                    {/* Context window bar */}
                    {activeConv.contextRatio != null && (
                      <div className="h-1 w-full bg-border-default rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            activeConv.contextRatio > 0.85 ? 'bg-accent-red' :
                            activeConv.contextRatio > 0.65 ? 'bg-accent-yellow' :
                            'bg-accent-brand'
                          }`}
                          style={{ width: `${Math.min(activeConv.contextRatio * 100, 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
              {(() => {
                const activeStatus = normalizeAgentStatus(activeConv.status);
                const canStopHeader = activeStatus === 'running' || activeStatus === 'recovering';
                const headerStopping = stoppingId === activeConv.agentId;
                if (!canStopHeader) return null;
                return (
                  <button
                    onClick={() => handleStopAgent(activeConv.agentId)}
                    disabled={headerStopping}
                    className="shrink-0 self-start mt-0.5 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-accent-red border border-accent-red/30 hover:bg-accent-red/10 disabled:opacity-50 transition-colors"
                    title={t('agent.stop.title')}
                  >
                    {headerStopping
                      ? <Loader2 size={11} className="animate-spin" />
                      : <Square size={11} className="fill-current" />}
                    <span>{headerStopping ? t('agent.stop.busy') : t('agent.stop')}</span>
                  </button>
                );
              })()}
            </div>
          </div>

          {/* Messages */}
          <div className="agent-message-list flex-1 min-h-0 px-2">
            {groupedMessages.length === 0 ? (
              <div className="text-xs text-text-tertiary px-8 py-2">{t('agent.started')}</div>
            ) : (
              <Virtuoso
                ref={virtuosoRef}
                className="h-full"
                data={groupedMessages}
                followOutput={(atBottom) => atBottom}
                increaseViewportBy={{ top: 200, bottom: 200 }}
                components={{
                  Footer: () =>
                    normalizeAgentStatus(activeConv.status) === 'running' ? (
                      <div className="agent-message-item pl-7 flex items-center gap-1.5 px-2 py-2 text-xs text-accent-brand/70">
                        <Loader2 size={12} className="animate-spin" />
                        <span>{t('agent.executing')}</span>
                      </div>
                    ) : null,
                }}
                itemContent={(_index, item) => {
                  if (item.kind === 'single') {
                    const msg = item.msg;
                    return (
                      <div
                        className={`agent-message-item pl-7 ${
                          msg.isStreaming || (msg.type === 'tool_call' && isAgentToolOpenStatus(msg.toolStatus)) ? 'is-running' : ''
                        }`}
                      >
                        <AgentMessageView msg={msg} />
                      </div>
                    );
                  }
                  const call = item.call;
                  return (
                    <div
                      className={`agent-message-item pl-7 ${
                        call.isStreaming || isAgentToolOpenStatus(call.toolStatus) ? 'is-running' : ''
                      }`}
                    >
                      <AgentMessageView msg={call} result={item.result} />
                    </div>
                  );
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 性能优化 (T-8)：memo 包装减少 ChatView re-render 时的级联更新。
// AgentPanel 的 props（onClose/onExpandChange）在 ChatView 中是稳定引用，
// 内部状态来自 zustand store 订阅，只有实际变化时才重渲。
export default memo(AgentPanel);

function formatAgentElapsedShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function parseAgentMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function summarizeAgentMetaTool(tool: string | undefined, content: unknown): string | null {
  const args = parseAgentMaybeJsonObject(content);
  if (tool === 'create_task') {
    return `创建任务：${typeof args?.subject === 'string' ? args.subject : '未命名任务'}`;
  }
  if (tool === 'dispatch_agent') {
    const agentName = typeof args?.agent_name === 'string' ? args.agent_name : 'agent';
    const taskId = typeof args?.task_id === 'string' ? args.task_id : '任务';
    return `派发 ${agentName} 执行 ${taskId}`;
  }
  if (tool === 'team_manage') {
    const action = typeof args?.action === 'string' ? args.action : 'status';
    const teamName = typeof args?.team_name === 'string' ? args.team_name : '团队';
    if (action === 'create') {
      const members = Array.isArray(args?.members) ? args.members.length : 0;
      return `创建团队 ${teamName}，成员 ${members} 个`;
    }
    if (action === 'delete') return `清理团队 ${teamName}`;
    if (action === 'edit') return `更新团队名册：${teamName}`;
    if (action === 'list_members') return `查看团队成员：${teamName}`;
    if (action === 'task_board') return '查看团队任务板';
    return `查看团队状态：${teamName}`;
  }
  if (tool === 'team_message') {
    const target = typeof args?.target === 'string' ? args.target : '团队成员';
    return `发送团队消息：${target}`;
  }
  if (tool === 'team_inbox') {
    return '读取团队收件箱';
  }
  return null;
}

function stringifyAgentCompact(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pickAgentStringField(value: unknown, keys: string[]): string | null {
  const parsed = parseAgentMaybeJsonObject(value);
  if (!parsed) return null;
  for (const key of keys) {
    const raw = parsed[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
}

function agentBasename(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\\/g, '/').split('/').filter(Boolean).pop() || value;
}

function countAgentArrayFields(value: unknown, keys: string[]): number {
  const parsed = parseAgentMaybeJsonObject(value);
  if (!parsed) return 0;
  for (const key of keys) {
    const raw = parsed[key];
    if (Array.isArray(raw)) return raw.length;
  }
  return 0;
}

function countAgentFileRefs(...values: unknown[]): number {
  const text = values.map(stringifyAgentCompact).join('\n');
  const matches = text.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|css|json|md|py|go|rs|java|html|yml|yaml|toml|sql|sh|mjs|cjs)/g);
  return matches ? new Set(matches).size : 0;
}

function agentStatusVerb(status: AgentMessage['toolStatus'] | undefined, verb: string): string {
  const normalized = normalizeToolCallStatus(status);
  if (status === 'streaming_input') return `正在准备${verb}`;
  if (normalized === 'pending' || normalized === 'running') return `正在${verb}`;
  if (normalized === 'failed') return `${verb}失败`;
  return `已${verb}`;
}

function isAgentToolOpenStatus(status: AgentMessage['toolStatus'] | undefined, isStreaming = false): boolean {
  return isStreaming || (status !== undefined && isToolCallOpenStatus(status));
}

function agentIconForToolKind(kind: ToolUiKind): ReactNode {
  switch (kind) {
    case 'search':
      return <Search size={12} />;
    case 'shell':
      return <Terminal size={12} />;
    case 'orchestration':
      return <Network size={12} />;
    case 'file_create':
      return <FilePlus2 size={12} />;
    case 'file_edit':
      return <PencilLine size={12} />;
    case 'read':
      return <Files size={12} />;
    default:
      return <Wrench size={12} />;
  }
}

function agentToolIcon(msg: AgentMessage): ReactNode {
  const normalized = normalizeToolCallStatus(msg.toolStatus);
  if (isAgentToolOpenStatus(msg.toolStatus, msg.isStreaming)) return <Loader2 size={12} className="animate-spin" />;
  if (normalized === 'failed') return <XCircle size={12} className="text-accent-red" />;
  return agentIconForToolKind(classifyTool(msg.tool, { content: msg.content }).kind);
}

function describeAgentToolEvent(msg: AgentMessage): { title: string; detail: string; meta: string } {
  const classification = classifyTool(msg.tool, { content: msg.content });
  const fileName = agentBasename(pickAgentStringField(msg.content, ['path', 'file', 'filePath', 'targetPath', 'filename']));
  const command = pickAgentStringField(msg.content, ['command', 'cmd']);
  const query = pickAgentStringField(msg.content, ['query', 'pattern', 'search']);
  const isStreamingInput = msg.toolStatus === 'streaming_input' || msg.isStreaming === true;
  const elapsedFrom = isStreamingInput ? msg.firstDeltaAt : msg.startedAt;
  const elapsedTo = isAgentToolOpenStatus(msg.toolStatus, msg.isStreaming) ? Date.now() : msg.endedAt;
  const elapsedMs = elapsedFrom && elapsedTo ? Math.max(0, elapsedTo - elapsedFrom) : null;
  const elapsed = elapsedMs !== null ? formatAgentElapsedShort(elapsedMs) : '';

  switch (classification.kind) {
    case 'orchestration':
      return {
        title: agentStatusVerb(msg.toolStatus, '编排'),
        detail: summarizeAgentMetaTool(msg.tool, msg.content) || msg.tool || '任务',
        meta: elapsed,
      };
    case 'shell':
      return {
        title: agentStatusVerb(msg.toolStatus, '运行'),
        detail: command ? command.replace(/\s+/g, ' ').slice(0, 80) : '1 条命令',
        meta: elapsed,
      };
    case 'search': {
      const files = countAgentArrayFields(msg.content, ['files', 'matches', 'results']) || countAgentFileRefs(msg.content);
      return {
        title: agentStatusVerb(msg.toolStatus, '探索'),
        detail: [files > 0 ? `${files} 个文件` : '', query ? '1 次搜索' : ''].filter(Boolean).join(' · ') || query || msg.tool || '工具',
        meta: elapsed,
      };
    }
    case 'read': {
      const files = countAgentArrayFields(msg.content, ['files', 'entries', 'items']) || countAgentFileRefs(msg.content);
      return {
        title: agentStatusVerb(msg.toolStatus, '探索'),
        detail: files > 0 ? `${files} 个文件` : (fileName || msg.tool || '文件'),
        meta: elapsed,
      };
    }
    case 'file_create':
      return {
        title: agentStatusVerb(msg.toolStatus, '创建'),
        detail: [fileName || msg.tool || '文件', formatFileChangeSummary(msg.content, null, 'create')].filter(Boolean).join(' '),
        meta: elapsed,
      };
    case 'file_edit':
      return {
        title: agentStatusVerb(msg.toolStatus, '编辑'),
        detail: [fileName || `${countAgentFileRefs(msg.content) || 1} 个文件`, formatFileChangeSummary(msg.content, null, 'edit')].filter(Boolean).join(' '),
        meta: elapsed,
      };
    default:
      break;
  }
  return {
    title: agentStatusVerb(msg.toolStatus, '调用'),
    detail: msg.tool || '工具',
    meta: elapsed,
  };
}

type AgentMessageDisplayFields = AgentMessage & {
  displayStatus?: string;
  settleReason?: 'idle' | 'interrupted' | 'runtime_idle';
  settleDetail?: string;
};

function isAgentLeaderSyntheticToolSettle(value: unknown): boolean {
  const parsed = parseAgentMaybeJsonObject(value);
  if (parsed?.kind === 'leader_tool_settle') return true;
  if (typeof value !== 'string') return false;
  return value.startsWith('Leader became idle before this tool produced a final result:')
    || value.startsWith('Runtime snapshot reported idle before this tool produced a final result:');
}

function agentSettleStatus(value: unknown): string {
  if (!isAgentLeaderSyntheticToolSettle(value)) return '';
  const parsed = parseAgentMaybeJsonObject(value);
  if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  return typeof value === 'string' ? value : '';
}

function agentDisplayStatus(msg: AgentMessage): string {
  const status = (msg as AgentMessageDisplayFields).displayStatus;
  if (typeof status === 'string' && status.trim()) return status.trim();
  return agentSettleStatus(msg.content);
}

// ─── tool_call / tool_result 配对(确定性时序:一个 tool_result 归属最近一个尚未收结果的 tool_call) ───
type GroupedAgentItem =
  | { kind: 'single'; msg: AgentMessage }
  | { kind: 'tool'; call: AgentMessage; result?: AgentMessage };

function groupAgentMessages(messages: AgentMessage[]): GroupedAgentItem[] {
  const items: GroupedAgentItem[] = [];
  const pending: number[] = []; // FIFO:items[] 下标,等待 result 的 tool_call(按发出顺序)
  for (const msg of messages) {
    if (msg.type === 'tool_call') {
      items.push({ kind: 'tool', call: msg });
      pending.push(items.length - 1);
    } else if (msg.type === 'tool_result') {
      const idx = pending.shift();
      if (idx === undefined) {
        items.push({ kind: 'single', msg }); // 无对应 tool_call 的孤立结果
      } else {
        const target = items[idx];
        if (target.kind === 'tool') target.result = msg;
      }
    } else {
      items.push({ kind: 'single', msg });
    }
  }
  return items;
}

// ─── Single agent message ───

function AgentMessageView({ msg, result }: { msg: AgentMessage; result?: AgentMessage }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // tool_call running 期间每秒重渲染计时
  const [, setTick] = useState(0);
  const isToolCall = msg.type === 'tool_call';
  const isToolRunning = isToolCall && isAgentToolOpenStatus(msg.toolStatus, msg.isStreaming);
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!isToolRunning) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [isToolRunning]);
  // 流式输出自动滚动到底（对齐 leader MessageBubble.tsx:630）
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [msg.streamingOutput]);

  if (msg.type === 'status') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary rounded-md text-xs border border-border-muted">
        <Activity size={11} className="text-text-tertiary shrink-0" />
        <span className="text-text-tertiary">{msg.content}</span>
      </div>
    );
  }

  if (msg.type === 'thinking') {
    return (
      <div className="px-1 py-0.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[11px] text-accent-brand/60 hover:text-accent-brand transition-colors"
        >
          <Brain size={11} />
          <span>{t('message.thinking')}</span>
          <span className="text-[9px] text-text-tertiary/50">{msg.content.length} chars</span>
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {expanded && (
          <div className="message-thought mt-1 px-2.5 py-2 rounded-md text-xs text-text-tertiary max-h-40 overflow-y-auto font-mono whitespace-pre-wrap leading-5 break-all overflow-x-hidden">
            {msg.content}
          </div>
        )}
      </div>
    );
  }

  if (msg.type === 'tool_call') {
    const inputStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const metaSummary = summarizeAgentMetaTool(msg.tool, msg.content);
    const displayStatus = agentDisplayStatus(msg);
    const resultStr = result ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content)) : '';
    const resultStatus = result ? agentDisplayStatus(result) : '';
    const resultPreview = result ? (resultStatus || (resultStr.length > 120 ? resultStr.slice(0, 120) + '...' : resultStr)) : '';
    const preview = result ? resultPreview : (displayStatus || metaSummary || (inputStr.length > 80 ? inputStr.slice(0, 80) + '...' : inputStr));
    const isStreamingInput = msg.toolStatus === 'streaming_input' || msg.isStreaming === true;
    const event = describeAgentToolEvent(msg);
    const kind = classifyTool(msg.tool, { content: msg.content }).kind;
    return (
      <div data-kind={kind} className={`agent-event-card ${
        isToolRunning ? 'is-running' : 'is-completed'
      } ${expanded ? 'is-expanded' : ''}`}>
        <div className="agent-event-header text-[11px]">
          <span className="agent-event-icon">{agentToolIcon(msg)}</span>
          <span className="agent-event-title">
            <strong>{event.title}</strong>{event.detail ? ` ${event.detail}` : ''}
          </span>
          {isStreamingInput && msg.inputCharCount !== undefined && msg.inputCharCount > 0 && (
            <span className="agent-status-chip font-mono text-accent-yellow tabular-nums">
              {msg.inputCharCount} chars
            </span>
          )}
          {isToolRunning && <span className="codex-live-dot" />}
          {event.meta && <span className="agent-status-chip font-mono tabular-nums">{event.meta}</span>}
          <button onClick={() => setExpanded(!expanded)} className="text-text-tertiary hover:text-text-secondary transition-colors ml-auto" aria-expanded={expanded}>
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        </div>
        {expanded ? (
          <div className="agent-detail-block space-y-2">
            <div className="flex justify-end mb-0.5"><PreCopyButton text={inputStr} /></div>
            {isStreamingInput ? (
              <pre className="agent-code-block text-[10px]">{inputStr}</pre>
            ) : (
              <ToolOutputView text={inputStr} language={inferInputLanguage(msg.tool, kind, msg.content)} variant="agent" />
            )}
            {/* 执行期间流式输出（Shell/Python stdout/stderr）—— 对齐 leader MessageBubble.tsx:714 */}
            {msg.streamingOutput && isToolRunning && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-text-tertiary">Output</span>
                  <PreCopyButton text={msg.streamingOutput} />
                </div>
                <pre ref={outputRef} className="agent-code-block text-[10px] max-h-40 overflow-y-auto">{msg.streamingOutput}</pre>
              </div>
            )}
            {/* 非流式输出工具的心跳进度（如 "web_fetch 已运行 8s..."）—— 对齐 leader MessageBubble.tsx:725 */}
            {!msg.streamingOutput && msg.progressMessage && isToolRunning && (
              <div className="text-[10px] text-text-tertiary italic">{msg.progressMessage}</div>
            )}
            {displayStatus && <div className="text-[10px] text-text-tertiary italic">{displayStatus}</div>}
            {result && (
              <div className="agent-result-block pt-2 border-t border-border-muted/40 space-y-1">
                <div className="flex items-center gap-1.5">
                  <ArrowRight size={10} className="text-text-tertiary shrink-0" />
                  <span className="text-[10px] text-text-tertiary font-medium uppercase tracking-wide">
                    {resultStatus || t('agent.result')}
                  </span>
                  <span className="ml-auto"><PreCopyButton text={resultStr} /></span>
                </div>
                {resultStatus ? (
                  <div className="text-[10px] text-text-tertiary/80 italic">{resultStatus}</div>
                ) : (
                  <ToolOutputView text={resultStr} language={inferOutputLanguage(msg.tool, kind, msg.content, resultStr)} variant="agent" />
                )}
              </div>
            )}
          </div>
        ) : (
          preview && <div className={`px-3 pb-2 text-[10px] truncate ${metaSummary ? 'text-text-secondary' : 'text-text-tertiary/70 font-mono'}`}>{preview}</div>
        )}
      </div>
    );
  }

  if (msg.type === 'tool_result') {
    const resultStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const kind = classifyTool(msg.tool, { content: msg.content }).kind;
    const displayStatus = agentDisplayStatus(msg);
    const preview = displayStatus || (resultStr.length > 120 ? resultStr.slice(0, 120) + '...' : resultStr);
    return (
      <div className="px-2 py-1.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
        >
          <ArrowRight size={10} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <span>{displayStatus ? 'Status' : t('agent.result')}</span>
        </button>
        {expanded && displayStatus ? (
          <div className="agent-code-block mt-1 text-[10px] text-text-tertiary italic">
            {displayStatus}
          </div>
        ) : expanded ? (
          <div>
            <div className="flex justify-end mt-1 mb-0.5"><PreCopyButton text={resultStr} /></div>
            <ToolOutputView text={resultStr} language={inferOutputLanguage(msg.tool, kind, msg.content, resultStr)} variant="agent" />
          </div>
        ) : (
          <div className="mt-0.5 text-[10px] text-text-tertiary/60 truncate font-mono">{preview}</div>
        )}
      </div>
    );
  }

  // type === 'text'
  return (
    <div className="px-2 py-1.5 text-xs text-text-secondary leading-relaxed break-words agent-markdown">
      <SafeMarkdown>{msg.content}</SafeMarkdown>
      {msg.isStreaming && <span className="agent-typing-caret ml-0.5" />}
    </div>
  );
}
