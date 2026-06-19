/**
 * ExecutionPanel — 画布节点执行输出面板
 *
 * 显示节点执行结果：
 * - 每个节点的运行状态和输出
 * - 实时 SSE 事件流
 * - 可展开查看详情
 */

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  X, ChevronDown, ChevronRight, Play, CheckCircle2, XCircle,
  Info, ArrowRight, ArrowLeft, BrainCircuit,
  Clock, Terminal, Cpu, Bot, Wrench, Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { acpClient } from '../../api/AcpClient';
import type { NodeExecution } from '../../stores/canvasStore';
import { isWorkflowNodeActiveStatus, normalizeWorkflowNodeStatus } from '@contracts/adapters/StatusAdapter';

interface ExecutionPanelProps {
  executions: NodeExecution[];
  onClear: () => void;
  onClose: () => void;
}

const statusIcon: Record<string, React.ReactNode> = {
  running: <div className="w-2.5 h-2.5 rounded-full bg-accent-brand animate-pulse" />,
  completed: <CheckCircle2 size={14} className="text-accent-green" />,
  failed: <XCircle size={14} className="text-accent-red" />,
  skipped: <Clock size={14} className="text-text-tertiary" />,
  cancelled: <XCircle size={14} className="text-accent-yellow" />,
};

const nodeIcon: Record<string, React.ReactNode> = {
  leader: <Bot size={12} className="text-accent-blue" />,
  agent: <Cpu size={12} className="text-accent-purple" />,
  tool: <Wrench size={12} className="text-accent-green" />,
  input: <Terminal size={12} className="text-accent-blue" />,
  output: <Zap size={12} className="text-accent-red" />,
};

const logStyle: Record<string, { color: string; prefix: ReactNode }> = {
  info: { color: 'text-text-tertiary', prefix: <Info size={10} /> },
  tool_call: { color: 'text-accent-green', prefix: <ArrowRight size={10} /> },
  tool_result: { color: 'text-accent-green', prefix: <ArrowLeft size={10} /> },
  text: { color: 'text-text-primary', prefix: '' },
  error: { color: 'text-accent-red', prefix: <XCircle size={10} /> },
  thinking: { color: 'text-accent-purple', prefix: <BrainCircuit size={10} /> },
};

export default function ExecutionPanel({ executions, onClear, onClose }: ExecutionPanelProps) {
  const { t } = useTranslation();
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-expand running nodes, auto-scroll
  useEffect(() => {
    const running = executions.filter((e) => isWorkflowNodeActiveStatus(e.status)).map((e) => e.nodeId);
    if (running.length > 0) {
      setExpandedNodes((prev) => {
        const hasNew = running.some(id => !prev.has(id));
        if (hasNew) {
          return new Set([...prev, ...running]);
        }
        return prev;
      });
    }
  }, [executions]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      const shouldScroll = scrollRef.current.scrollHeight - scrollRef.current.scrollTop - scrollRef.current.clientHeight < 100;
      if (shouldScroll) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
  }, [executions]);

  const toggleNode = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
      return next;
    });
  };

  const statusCounts = executions.reduce((counts, exec) => {
    const status = normalizeWorkflowNodeStatus(exec.status);
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const running = executions.filter((e) => isWorkflowNodeActiveStatus(e.status)).length;
  const completed = statusCounts.completed || 0;
  const skipped = statusCounts.skipped || 0;
  const failed = statusCounts.failed || 0;
  const total = executions.length;
  const progressPercentage = total > 0 ? Math.round(((completed + skipped) / total) * 100) : 0;

  return (
    <div className="flex flex-col h-full bg-bg-primary border-t border-border-default">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-border-default shrink-0">
        <Terminal size={13} className="text-accent-brand/60" />
        <span className="text-[11px] font-mono tracking-wider text-accent-brand/50 uppercase">{t('canvas.execution.title')}</span>
        <div className="flex-1" />
        {running > 0 && <span className="text-[10px] text-accent-brand font-mono">{running} {t('canvas.execution.running')}</span>}
        {completed > 0 && <span className="text-[10px] text-accent-green font-mono">{completed} {t('canvas.execution.completed')}</span>}
        {skipped > 0 && <span className="text-[10px] text-text-tertiary font-mono">{skipped} skipped</span>}
        {failed > 0 && <span className="text-[10px] text-accent-red font-mono">{failed} {t('canvas.execution.failed')}</span>}
        <button className="p-1 text-text-tertiary hover:text-text-primary text-[10px]" onClick={onClear}>
          {t('canvas.execution.clear')}
        </button>
        <button className="p-1 text-text-tertiary hover:text-text-primary" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="px-3 py-2 bg-bg-secondary/50 border-b border-border-default/30">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] text-text-tertiary font-mono">{t('canvas.execution.progress.title')}</span>
            <div className="flex-1 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
              <div 
                className="h-full bg-accent-brand transition-all duration-300"
                style={{ width: `${progressPercentage}%` }}
              />
            </div>
            <span className="text-[10px] text-text-tertiary font-mono">{progressPercentage}%</span>
          </div>
          <div className="text-[9px] text-text-tertiary">
            {completed + skipped} / {total} {t('canvas.execution.progress.completed')}
            {running > 0 && ` • ${running} ${t('canvas.execution.running')}`}
            {failed > 0 && ` • ${failed} ${t('canvas.execution.failed')}`}
          </div>
        </div>
      )}

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {executions.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-tertiary text-xs">
            {t('canvas.execution.empty')}
          </div>
        ) : (
          <div className="divide-y divide-border-default/30">
            {executions.map((exec) => {
              const isExpanded = expandedNodes.has(exec.nodeId);
              const normalizedStatus = normalizeWorkflowNodeStatus(exec.status);
              const duration = exec.completedAt
                ? `${((exec.completedAt - exec.startedAt) / 1000).toFixed(1)}s`
                : isWorkflowNodeActiveStatus(exec.status)
                  ? `${((Date.now() - exec.startedAt) / 1000).toFixed(0)}s...`
                  : '--';

              return (
                <div key={exec.nodeId}>
                  {/* Node header */}
                  <div
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover cursor-pointer"
                    onClick={() => toggleNode(exec.nodeId)}
                  >
                    {isExpanded ? <ChevronDown size={12} className="text-text-tertiary" /> : <ChevronRight size={12} className="text-text-tertiary" />}
                    {statusIcon[normalizedStatus]}
                    {nodeIcon[exec.nodeType] || <Cpu size={12} className="text-text-tertiary" />}
                    <span className="text-xs text-text-primary flex-1 truncate">{exec.nodeLabel}</span>
                    <Clock size={10} className="text-text-tertiary" />
                    <span className="text-[10px] font-mono text-text-tertiary">{duration}</span>
                  </div>

                  {/* Expanded logs */}
                  {isExpanded && (
                    <div className="px-6 pb-2 space-y-0.5">
                      {exec.logs.length === 0 && (
                        <div className="text-[10px] text-text-tertiary italic py-1">No logs yet...</div>
                      )}
                      {exec.logs.map((log, i) => {
                        const style = logStyle[log.type] || logStyle.info;
                        const time = new Date(log.timestamp).toLocaleTimeString('en-US', { 
                          hour12: false, 
                          hour: '2-digit', 
                          minute: '2-digit', 
                          second: '2-digit' 
                        });
                        return (
                          <div key={i} className={`text-[11px] font-mono ${style.color} leading-relaxed flex gap-2`}>
                            <span className="text-text-tertiary/50 shrink-0">{time}</span>
                            <div className="flex-1">
                              {style.prefix && <span className="mr-1">{style.prefix}</span>}
                              {log.tool && <span className="text-accent-green/80 mr-1">[{log.tool}]</span>}
                              <span className="whitespace-pre-wrap break-all">{log.content}</span>
                            </div>
                          </div>
                        );
                      })}
                      {exec.output && (
                        <div className="mt-1.5 p-2 bg-accent-green/5 border border-accent-green/20 rounded">
                          <div className="text-[9px] text-accent-green/80 font-mono mb-1">{t('canvas.execution.result.output').toUpperCase()}</div>
                          <div className="text-xs text-text-primary font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">
                            {exec.output}
                          </div>
                        </div>
                      )}
                      {exec.error && (
                        <div className="mt-1.5 p-2 bg-accent-red/5 border border-accent-red/20 rounded">
                          <div className="text-[9px] text-accent-red/80 font-mono mb-1">{t('canvas.execution.result.error').toUpperCase()}</div>
                          <div className="text-xs text-accent-red font-mono whitespace-pre-wrap break-all">
                            {exec.error}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
