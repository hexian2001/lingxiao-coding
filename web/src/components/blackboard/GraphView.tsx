/**
 * GraphView — 黑板知识图谱卡片视图
 *
 * 卡片样式，与 TasksView 风格一致。
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Target, Flag, FileText, Compass, Lightbulb,
  CheckCircle2, Loader2, AlertTriangle, XCircle,
  Network, RefreshCw, ChevronDown, ChevronRight,
  Clock, Zap, X,
} from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import {
  useBlackboardStore,
  type GraphNode as BNode,
  type GraphEdge,
} from '../../stores/blackboardStore';
import { getServerToken } from '../../api/headers';

// ─── Kind theme ───

const KIND_THEME: Record<string, { icon: React.ReactNode; color: string; bg: string; border: string; dot: string; label: string }> = {
  origin: { icon: <Target size={12}/>, color: 'text-accent-green', bg: 'bg-accent-green/10', border: 'border-accent-green/30', dot: 'var(--color-accent-green)', label: 'Origin' },
  goal:   { icon: <Flag size={12}/>, color: 'text-accent-orange', bg: 'bg-accent-orange/10', border: 'border-accent-orange/30', dot: 'var(--color-accent-orange)', label: 'Goal' },
  fact:   { icon: <FileText size={12}/>, color: 'text-accent-blue-400', bg: 'bg-accent-blue-400/10', border: 'border-accent-blue-400/30', dot: 'var(--color-accent-blue-400, #7aa2f7)', label: 'Fact' },
  intent: { icon: <Compass size={12}/>, color: 'text-accent-orange', bg: 'bg-accent-orange/10', border: 'border-accent-orange/30', dot: 'var(--color-accent-orange)', label: 'Intent' },
  hint:   { icon: <Lightbulb size={12}/>, color: 'text-accent-purple', bg: 'bg-accent-purple/10', border: 'border-accent-purple/30', dot: 'var(--color-accent-purple)', label: 'Hint' },
};
const DEFAULT_THEME = KIND_THEME.fact;

const CONFIDENCE: Record<string, { color: string; label: string }> = {
  confirmed: { color: 'text-accent-green', label: 'confirmed' },
  likely:    { color: 'text-accent-orange', label: 'likely' },
  tentative: { color: 'text-accent-orange/60', label: 'tentative' },
};

const INTENT_STATUS: Record<string, { color: string; label: string }> = {
  open:      { color: 'text-accent-orange', label: 'open' },
  exploring: { color: 'text-accent-blue-400', label: 'exploring' },
  resolved:  { color: 'text-accent-green', label: 'resolved' },
  abandoned: { color: 'text-text-tertiary', label: 'abandoned' },
};

// ─── Stats bar ───

function StatsBar({ nodes }: { nodes: BNode[] }) {
  const facts = nodes.filter(n => n.kind === 'fact').length;
  const intents = nodes.filter(n => n.kind === 'intent').length;
  const hints = nodes.filter(n => n.kind === 'hint').length;
  const openIntents = nodes.filter(n => n.kind === 'intent' && (n.intentStatus === 'open' || !n.intentStatus)).length;
  const confirmed = nodes.filter(n => n.confidence === 'confirmed').length;

  const stats = [
    { label: 'Total', value: nodes.length, icon: <Network size={13}/>, color: 'text-text-secondary' },
    { label: 'Facts', value: facts, icon: <FileText size={13}/>, color: 'text-accent-blue-400' },
    { label: 'Intents', value: intents, icon: <Compass size={13}/>, color: 'text-accent-orange' },
    { label: 'Hints', value: hints, icon: <Lightbulb size={13}/>, color: 'text-accent-purple' },
    { label: 'Confirmed', value: confirmed, icon: <CheckCircle2 size={13}/>, color: 'text-accent-green' },
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

// ─── Node card ───

function NodeCard({ node, isSelected, edges, onClick }: {
  node: BNode;
  isSelected: boolean;
  edges: GraphEdge[];
  onClick: () => void;
}) {
  const theme = KIND_THEME[node.kind] ?? DEFAULT_THEME;
  const relatedEdges = edges.filter(e => e.fromNodeId === node.id || e.toNodeId === node.id);

  return (
    <button
      className={`w-full px-3 py-2.5 flex items-start gap-2.5 text-left transition-colors ${isSelected ? 'bg-accent-brand/10' : 'hover:bg-bg-hover'}`}
      onClick={onClick}
    >
      {/* Kind dot */}
      <span
        className="w-2 h-2 rounded-full shrink-0 mt-1.5"
        style={{ backgroundColor: theme.dot }}
      />
      <div className="flex-1 min-w-0">
        {/* Header row */}
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={theme.color}>{theme.icon}</span>
          <span className="text-[9px] font-mono text-text-muted">{node.id}</span>
          <span className={`text-[9px] px-1 py-0 rounded border ${theme.border} ${theme.color} ${theme.bg}`}>
            {theme.label}
          </span>
          {node.confidence && (
            <span className={`text-[9px] ${CONFIDENCE[node.confidence]?.color ?? ''}`}>
              {CONFIDENCE[node.confidence]?.label}
            </span>
          )}
          {node.intentStatus && (
            <span className={`text-[9px] ${INTENT_STATUS[node.intentStatus]?.color ?? ''}`}>
              {INTENT_STATUS[node.intentStatus]?.label}
            </span>
          )}
          {relatedEdges.length > 0 && (
            <span className="text-[9px] text-text-muted ml-auto">{relatedEdges.length} edges</span>
          )}
        </div>
        {/* Title */}
        <div className="text-[11px] text-text-primary truncate leading-tight">{node.title}</div>
        {/* Content preview */}
        {node.content && (
          <div className="text-[10px] text-text-tertiary truncate mt-0.5 leading-tight">
            {node.content.slice(0, 120)}
          </div>
        )}
        {/* Tags */}
        {node.tags && node.tags.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {node.tags.map((tag, i) => (
              <span key={i} className="text-[8px] px-1 py-0 rounded bg-bg-tertiary text-text-muted border border-border-muted">
                {tag}
              </span>
            ))}
          </div>
        )}
        {/* Created by */}
        <div className="text-[9px] text-text-muted font-mono mt-0.5">
          by {node.createdBy}
          {node.supersededBy && <span className="text-accent-red/60 ml-1">superseded</span>}
        </div>
      </div>
    </button>
  );
}

// ─── Detail panel ───

function DetailPanel({ node, edges, onClose }: { node: BNode; edges: GraphEdge[]; onClose: () => void }) {
  const theme = KIND_THEME[node.kind] ?? DEFAULT_THEME;
  const relatedEdges = edges.filter(e => e.fromNodeId === node.id || e.toNodeId === node.id);

  return (
    <div className="border-l border-border-default bg-bg-secondary/60 overflow-y-auto" style={{ width: 320, minWidth: 280 }}>
      <div className="p-3">
        {/* Header */}
        <div className="flex items-start gap-2 mb-3">
          <span className={theme.color}>{theme.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-text-primary">{node.title}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[9px] font-mono text-text-muted">{node.id}</span>
              <span className={`text-[9px] px-1 py-0 rounded border ${theme.border} ${theme.color} ${theme.bg}`}>
                {theme.label}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary shrink-0"><X size={14} /></button>
        </div>

        {/* Confidence / Status */}
        {(node.confidence || node.intentStatus) && (
          <div className="flex gap-2 mb-2">
            {node.confidence && (
              <span className={`text-[10px] ${CONFIDENCE[node.confidence]?.color}`}>
                confidence: {CONFIDENCE[node.confidence]?.label}
              </span>
            )}
            {node.intentStatus && (
              <span className={`text-[10px] ${INTENT_STATUS[node.intentStatus]?.color}`}>
                status: {INTENT_STATUS[node.intentStatus]?.label}
              </span>
            )}
          </div>
        )}

        {/* Content */}
        {node.content && (
          <div className="mb-3">
            <div className="text-[9px] text-text-muted uppercase tracking-wide mb-1">Content</div>
            <div className="text-[11px] text-text-secondary leading-4 whitespace-pre-wrap bg-bg-secondary border border-border-default rounded p-2 max-h-48 overflow-y-auto">
              {node.content}
            </div>
          </div>
        )}

        {/* Tags */}
        {node.tags && node.tags.length > 0 && (
          <div className="mb-3">
            <div className="text-[9px] text-text-muted uppercase tracking-wide mb-1">Tags</div>
            <div className="flex gap-1 flex-wrap">
              {node.tags.map((tag, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary border border-border-muted">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Evidence */}
        {node.evidence && node.evidence.length > 0 && (
          <div className="mb-3">
            <div className="text-[9px] text-text-muted uppercase tracking-wide mb-1">Evidence</div>
            {node.evidence.map((ev, i) => (
              <div key={i} className="text-[10px] text-text-tertiary mb-1 font-mono">
                {ev.type}: {ev.ref}{ev.location ? ` @ ${ev.location}` : ''}
                {ev.snippet && <div className="text-text-muted mt-0.5 truncate">"{ev.snippet}"</div>}
              </div>
            ))}
          </div>
        )}

        {/* Related edges */}
        {relatedEdges.length > 0 && (
          <div className="mb-3">
            <div className="text-[9px] text-text-muted uppercase tracking-wide mb-1">Edges ({relatedEdges.length})</div>
            {relatedEdges.map((e) => {
              const isOutgoing = e.fromNodeId === node.id;
              return (
                <div key={e.id} className="text-[10px] text-text-tertiary font-mono mb-0.5">
                  {isOutgoing ? '→' : '←'} <span className="text-text-secondary">{e.edgeType}</span> {isOutgoing ? e.toNodeId : e.fromNodeId}
                  <span className="text-text-muted ml-1">by {e.createdBy}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Metadata */}
        <div className="text-[9px] text-text-muted font-mono space-y-0.5">
          <div>created: {new Date(node.createdAt).toLocaleString()}</div>
          <div>by: {node.createdBy}</div>
          {node.priority != null && <div>priority: {node.priority}</div>}
          {node.supersededBy && <div className="text-accent-red/60">superseded by: {node.supersededBy}</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Main ───

export default function GraphView() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const { nodes, edges, loading, error, selectedNodeId, fetchGraph, fetchAnalysis, selectNode, reset, setSubscribed } = useBlackboardStore();

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(sessionId);
  const [filterKind, setFilterKind] = useState<string | null>(null);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);
  useEffect(() => {
    setSelectedSessionId(sessionId || null);
    setFilterKind(null);
    selectNode(null);
    reset();
  }, [reset, selectNode, sessionId]);

  // NOTE: 不再自动切换到其他会话 — 始终显示当前选中会话的数据

  useEffect(() => {
    if (selectedSessionId) {
      fetchGraph(selectedSessionId);
      fetchAnalysis(selectedSessionId);
    }
  }, [selectedSessionId, fetchGraph, fetchAnalysis]);

  // 订阅态门控:挂载时订阅 delta,卸载时退订 + 清空图。
  // Blackboard 未打开(GraphView 未挂载)时 applyDelta 不累积,避免单例 store 跨整会话无限增长(#4)。
  useEffect(() => {
    setSubscribed(true);
    return () => {
      setSubscribed(false);
      reset();
    };
  }, [setSubscribed, reset]);

  const filteredNodes = useMemo(() => {
    if (!filterKind) return nodes;
    return nodes.filter(n => n.kind === filterKind);
  }, [nodes, filterKind]);

  const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);

  const handleRefresh = useCallback(() => {
    if (selectedSessionId) fetchGraph(selectedSessionId);
  }, [selectedSessionId, fetchGraph]);

  return (
    <div className="flex flex-col h-full bg-bg-secondary text-text-primary font-mono">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 bg-bg-secondary">
        <Network size={14} className="text-accent-brand"/>
        <span className="text-[11px] font-mono tracking-wider text-accent-brand/70 uppercase">Blackboard</span>
        <div className="flex-1"/>
        {/* Kind filter */}
        {nodes.length > 0 && (
          <div className="flex gap-1">
            {[null, 'fact', 'intent', 'hint', 'origin', 'goal'].map(kind => {
              const theme = kind ? KIND_THEME[kind] : null;
              const count = kind ? nodes.filter(n => n.kind === kind).length : nodes.length;
              return (
                <button
                  key={kind ?? 'all'}
                  onClick={() => setFilterKind(kind)}
                  className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                    filterKind === kind
                      ? 'bg-accent-brand/20 text-accent-brand border-accent-brand/30'
                      : 'text-text-tertiary border-border-muted hover:text-text-secondary'
                  }`}
                >
                  {kind ? theme?.label : 'All'} {count}
                </button>
              );
            })}
          </div>
        )}
        {loading && <Loader2 size={12} className="animate-spin text-accent-brand"/>}
        <button
          className="p-1.5 text-text-muted hover:text-text-secondary transition-colors rounded hover:bg-bg-hover"
          onClick={handleRefresh}
        >
          <RefreshCw size={13}/>
        </button>
      </div>

      {/* Session selector */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-default bg-bg-secondary/40 shrink-0">
        <span className="text-[9px] text-text-muted shrink-0">Session:</span>
        <select
          className="flex-1 rounded border border-border-input bg-bg-input px-1.5 py-0.5 text-[11px] text-text-secondary focus:outline-none cursor-pointer"
          value={selectedSessionId || ''}
          onChange={(e) => {
            setSelectedSessionId(e.target.value);
            setFilterKind(null);
            selectNode(null);
            reset();
          }}
        >
          {sessions.length === 0 && <option value="">No sessions</option>}
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
          <button onClick={() => useBlackboardStore.setState({ error: null })} className="text-accent-red/60 hover:text-accent-red"><X size={12} /></button>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-accent-brand/60"/>
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Stats */}
          {nodes.length > 0 && <StatsBar nodes={nodes}/>}

          {/* Content */}
          {nodes.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-text-muted bg-bg-secondary">
              <Network size={28} className="mb-2 opacity-40"/>
              <p className="text-xs">{t('blackboard.empty')}</p>
              <p className="text-[10px] text-text-muted/60 mt-1">{t('blackboard.emptyHint')}</p>
            </div>
          ) : (
            <div className="flex-1 flex min-h-0">
              {/* Node list */}
              <div className="flex-1 overflow-y-auto bg-bg-secondary">
                {/* Selected node detail (inline) */}
                {selectedNode && (
                  <div className="border-b border-border-default p-3 bg-bg-secondary/60">
                    <div className="flex items-start gap-2 mb-2">
                      <span className={KIND_THEME[selectedNode.kind]?.color ?? 'text-text-secondary'}>
                        {KIND_THEME[selectedNode.kind]?.icon ?? <FileText size={12}/>}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-text-primary mb-1">{selectedNode.title}</div>
                        <div className="flex flex-wrap gap-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${KIND_THEME[selectedNode.kind]?.border ?? ''} ${KIND_THEME[selectedNode.kind]?.color ?? ''} ${KIND_THEME[selectedNode.kind]?.bg ?? ''}`}>
                            {selectedNode.kind}
                          </span>
                          {selectedNode.confidence && (
                            <span className={`text-[10px] ${CONFIDENCE[selectedNode.confidence]?.color ?? ''}`}>
                              {CONFIDENCE[selectedNode.confidence]?.label}
                            </span>
                          )}
                          {selectedNode.intentStatus && (
                            <span className={`text-[10px] ${INTENT_STATUS[selectedNode.intentStatus]?.color ?? ''}`}>
                              {INTENT_STATUS[selectedNode.intentStatus]?.label}
                            </span>
                          )}
                        </div>
                      </div>
                      <button onClick={() => selectNode(null)} className="text-text-muted hover:text-text-secondary shrink-0"><X size={14} /></button>
                    </div>
                    {selectedNode.content && (
                      <pre className="text-[10px] text-text-secondary bg-bg-secondary border border-border-default rounded p-2 overflow-auto max-h-32 font-mono whitespace-pre-wrap">
                        {selectedNode.content.slice(0, 500)}
                      </pre>
                    )}
                  </div>
                )}

                {/* Node rows */}
                <div className="divide-y divide-border-default/60">
                  {filteredNodes.map((node) => (
                    <NodeCard
                      key={node.id}
                      node={node}
                      isSelected={selectedNodeId === node.id}
                      edges={edges}
                      onClick={() => selectNode(selectedNodeId === node.id ? null : node.id)}
                    />
                  ))}
                </div>
              </div>

              {/* Detail side panel */}
              {selectedNode && (
                <DetailPanel node={selectedNode} edges={edges} onClose={() => selectNode(null)}/>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
