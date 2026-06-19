import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  computeBlueprintCoverage,
  roleHanzi,
  BLUEPRINT_GAP_GLYPH,
  type ProjectBlueprint,
  type BlueprintSubsystemEntry,
  type BlueprintSubsystemStatus,
} from '../../types/blueprint';
import { useSessionStore } from '../../stores/sessionStore';
import { getServerToken } from '../../api/headers';

/**
 * 项目蓝图 Web 面板——交互式子系统 DAG + 任务展开 + 契约徽章。
 *
 * 三层合一可视化:
 *  1. 子系统层:按 dependsOn 拓扑分层排列,颜色表示状态(缺口红/已实现绿/延后黄/不适用灰)
 *  2. 任务层:点击子系统展开其下任务,显示任务状态/角色/agent
 *  3. 契约层:子系统节点上显示契约徽章(✓有契约@v2 / ◇无契约)
 *
 * 交互:
 *  - 点击子系统卡片:展开/收起其下任务列表
 *  - 点击缺口子系统:高亮提示建任务
 *  - 悬停依赖边:高亮上下游链路
 */

/** 状态语义:方印题字 + 标签 + 语义色。缺口派生态在调用处覆盖为「缺」+朱砂。 */
const STATUS_META: Record<BlueprintSubsystemStatus, { seal: string; label: string; accent: string; dotClass: string }> = {
  implement: { seal: '成', label: '已实现', accent: 'text-accent-green', dotClass: 'bg-accent-green' },
  defer: { seal: '缓', label: '延后', accent: 'text-accent-yellow', dotClass: 'bg-accent-yellow' },
  not_applicable: { seal: '略', label: '不适用', accent: 'text-text-muted', dotClass: 'bg-text-muted' },
};

/** 契约条目(从 /api/v1/contracts 拉取,只取 surface+version 做徽章)。 */
interface ContractEntry {
  surface: string;
  version?: number;
}

/** 任务条目(从 /api/sessions/:sessionId/tasks 拉取)。 */
interface TaskItem {
  id: string;
  subject: string;
  status: string;
  displayState?: string;
  agent_type?: string;
  assigned_agent?: string;
  blocked_by?: string[];
  orchestration?: { contractBinding?: { surface?: string } };
}

// ─── 拓扑分层(Kahn) ───

function topologicalLevels(entries: readonly BlueprintSubsystemEntry[]): Map<number, string[]> {
  const ids = new Set(entries.map((e) => e.subsystemId));
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const e of entries) {
    inDeg.set(e.subsystemId, 0);
    adj.set(e.subsystemId, []);
  }
  for (const e of entries) {
    for (const dep of e.dependsOn ?? []) {
      if (ids.has(dep)) {
        adj.get(dep)!.push(e.subsystemId);
        inDeg.set(e.subsystemId, (inDeg.get(e.subsystemId) ?? 0) + 1);
      }
    }
  }
  const queue = entries.filter((e) => (inDeg.get(e.subsystemId) ?? 0) === 0).map((e) => e.subsystemId);
  const levels = new Map<number, string[]>();
  let lv = 0;
  while (queue.length > 0) {
    const size = queue.length;
    levels.set(lv, []);
    for (let i = 0; i < size; i++) {
      const id = queue.shift()!;
      levels.get(lv)!.push(id);
      for (const next of adj.get(id) ?? []) {
        inDeg.set(next, (inDeg.get(next) ?? 0) - 1);
        if ((inDeg.get(next) ?? 0) === 0) queue.push(next);
      }
    }
    lv++;
  }
  // 环里的节点放 L0(容错)
  for (const e of entries) {
    const placed = [...levels.values()].some((ids) => ids.includes(e.subsystemId));
    if (!placed) {
      const l0 = levels.get(0) ?? [];
      l0.push(e.subsystemId);
      levels.set(0, l0);
    }
  }
  return levels;
}

// ─── 子系统节点 ───

interface SubsystemNodeProps {
  entry: BlueprintSubsystemEntry;
  contractEntry?: ContractEntry;
  tasks: TaskItem[];
  isExpanded: boolean;
  onToggle: () => void;
  isHighlighted: boolean;
  onHoverDeps: (deps: string[] | null) => void;
  dependentIds: string[];
}

function SubsystemNode({ entry, contractEntry, tasks, isExpanded, onToggle, isHighlighted, onHoverDeps, dependentIds }: SubsystemNodeProps) {
  const isUncovered = entry.status === 'implement' && entry.taskIds.length === 0;
  const meta = STATUS_META[entry.status];
  const seal = isUncovered ? '缺' : meta.seal;
  const accent = isUncovered ? 'text-accent-red' : meta.accent;
  const role = entry.agentType ?? '';
  const desc = entry.description;
  const hasContract = Boolean(contractEntry);
  const contractVersion = contractEntry?.version;

  return (
    <div
      className={`bp-card bp-node p-3 flex flex-col gap-2 cursor-pointer transition-all ${isUncovered ? 'is-gap' : ''} ${isHighlighted ? 'ring-2 ring-accent-brand' : ''}`}
      onClick={onToggle}
      onMouseEnter={() => onHoverDeps([...(entry.dependsOn ?? []), ...dependentIds])}
      onMouseLeave={() => onHoverDeps(null)}
    >
      {/* 行一:角色方寸印 + 宋体题名 + 状态方印 + 契约徽章 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="bp-role-seal" aria-label={`角色 ${role || '未指派'}`}>{roleHanzi(role)}</span>
          <div className="min-w-0">
            <div
              className="text-[15px] leading-tight text-text-primary font-semibold truncate"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {entry.name}
            </div>
            <div className="text-[10px] text-text-tertiary font-mono truncate mt-0.5">
              {entry.subsystemId}{role ? ` · ${role}` : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* 契约徽章 */}
          {entry.status === 'implement' && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono border ${hasContract ? 'bg-accent-green/10 text-accent-green border-accent-green/20' : 'bg-accent-red/10 text-accent-red border-accent-red/20'}`}
              title={hasContract ? `契约 @v${contractVersion ?? '?'}` : '无契约'}
            >
              {hasContract ? `✓@v${contractVersion ?? '?'}` : '◇无契约'}
            </span>
          )}
          <span className={`bp-status-seal ${accent}`} title={isUncovered ? '缺口' : meta.label}>{seal}</span>
        </div>
      </div>

      {/* 行二:描述 */}
      {desc && (
        <div className="text-[11px] text-text-tertiary leading-snug line-clamp-2">{desc}</div>
      )}

      {/* 行三:任务标签 / 缺口提示 / 依赖 */}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {entry.taskIds.length > 0 ? (
          <>
            <span className="text-text-muted">{entry.taskIds.length} 任务</span>
            {entry.dependsOn && entry.dependsOn.length > 0 && (
              <span className="text-text-tertiary">← {entry.dependsOn.join(',')}</span>
            )}
          </>
        ) : isUncovered ? (
          <span className={`${accent} flex items-center gap-1`}>
            <span>{BLUEPRINT_GAP_GLYPH}</span>
            <span>未建任务 · dispatch 拦截</span>
          </span>
        ) : (
          entry.dependsOn && entry.dependsOn.length > 0 && (
            <span className="text-text-tertiary">← {entry.dependsOn.join(',')}</span>
          )
        )}
      </div>

      {/* 展开任务列表 */}
      {isExpanded && tasks.length > 0 && (
        <div className="flex flex-col gap-1 mt-1 pt-2 border-t border-border-muted">
          {tasks.map((t) => {
            const taskStatus = t.displayState ?? t.status;
            const isRunning = taskStatus === 'running' || taskStatus === 'in_progress';
            const isDone = taskStatus === 'completed' || taskStatus === 'terminal';
            const isFailed = taskStatus === 'failed' || taskStatus === 'cancelled';
            const dotColor = isRunning ? 'bg-accent-blue' : isDone ? 'bg-accent-green' : isFailed ? 'bg-accent-red' : 'bg-text-muted';
            return (
              <div key={t.id} className="flex items-center gap-2 text-[11px] py-0.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
                <span className="font-mono text-text-tertiary shrink-0">{t.id}</span>
                <span className="text-text-secondary truncate flex-1">{t.subject}</span>
                {t.assigned_agent && (
                  <span className="text-text-muted shrink-0">@{t.assigned_agent}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* rationale */}
      {entry.rationale && (
        <div className="text-[11px] text-text-tertiary leading-snug line-clamp-2">{entry.rationale}</div>
      )}
    </div>
  );
}

// ─── 依赖边(SVG 叠层) ───

function DependencyEdges({ levels, entryById, containerRef }: {
  levels: Map<number, string[]>;
  entryById: Map<string, BlueprintSubsystemEntry>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  // 纯 CSS 边:用 ← 箭头标注在节点上,SVG 叠层复杂度高且响应式难维护。
  // 此处保留接口供后续升级为 SVG 连线;当前依赖关系在节点内 ← 文本标注。
  void levels; void entryById; void containerRef;
  return null;
}

// ─── 主组件 ───

export default function BlueprintView() {
  const blueprint = useSessionStore((s) => s.blueprint) as ProjectBlueprint | null | undefined;
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);

  const [expandedSubsystem, setExpandedSubsystem] = useState<string | null>(null);
  const [highlightedDeps, setHighlightedDeps] = useState<string[] | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [contracts, setContracts] = useState<ContractEntry[]>([]);
  const [viewMode, setViewMode] = useState<'dag' | 'grid'>('dag');

  // 获取当前 session 的 workspace
  const workspace = useMemo(() => {
    const s = sessions.find((s) => s.id === sessionId);
    return s?.workspace ?? '';
  }, [sessions, sessionId]);

  // 拉取任务列表
  const fetchTasks = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tasks`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) return;
      const data = await res.json();
      setTasks(Array.isArray(data) ? data : (data?.tasks ?? []));
    } catch {
      /* tolerate */
    }
  }, [sessionId]);

  // 拉取契约列表
  const fetchContracts = useCallback(async () => {
    if (!workspace) return;
    try {
      const params = new URLSearchParams({ projectPath: workspace });
      const res = await fetch(`/api/v1/contracts?${params.toString()}`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data?.contracts) ? data.contracts : [];
      setContracts(list.map((c: { surface: string; version?: number }) => ({ surface: c.surface, version: c.version })));
    } catch {
      /* tolerate */
    }
  }, [workspace]);

  useEffect(() => {
    void fetchTasks();
    void fetchContracts();
    const timer = setInterval(() => {
      void fetchTasks();
      void fetchContracts();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTasks, fetchContracts]);

  // 契约 surface → entry 映射
  const contractBySurface = useMemo(() => {
    const m = new Map<string, ContractEntry>();
    for (const c of contracts) m.set(c.surface, c);
    return m;
  }, [contracts]);

  // 任务 id → task 映射
  const taskById = useMemo(() => {
    const m = new Map<string, TaskItem>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  // 子系统 → 契约 surface 映射：通过子系统的任务的 contractBinding.surface 桥接。
  // subsystemId 与 contract surface 是不同命名空间，不能直接匹配。
  const contractSurfaceBySubsystem = useMemo(() => {
    const m = new Map<string, string>();
    if (!blueprint) return m;
    for (const entry of blueprint.subsystems) {
      for (const taskId of entry.taskIds) {
        const task = taskById.get(taskId);
        const surface = task?.orchestration?.contractBinding?.surface;
        if (surface) {
          m.set(entry.subsystemId, surface);
          break; // 取第一个绑定的 surface
        }
      }
    }
    return m;
  }, [blueprint, taskById]);

  // 子系统 → 契约条目映射（通过桥接 surface 查 contractBySurface）
  const contractBySubsystem = useMemo(() => {
    const m = new Map<string, ContractEntry>();
    for (const [subsystemId, surface] of contractSurfaceBySubsystem) {
      const entry = contractBySurface.get(surface);
      if (entry) m.set(subsystemId, entry);
    }
    return m;
  }, [contractSurfaceBySubsystem, contractBySurface]);

  // 反查:哪些子系统依赖某子系统
  const dependentsBySubsystem = useMemo(() => {
    if (!blueprint) return new Map<string, string[]>();
    const m = new Map<string, string[]>();
    for (const e of blueprint.subsystems) {
      for (const dep of e.dependsOn ?? []) {
        const list = m.get(dep) ?? [];
        list.push(e.subsystemId);
        m.set(dep, list);
      }
    }
    return m;
  }, [blueprint]);

  if (!blueprint) {
    return (
      <div className="flex h-full flex-1 items-center justify-center text-text-tertiary">
        <div className="flex flex-col items-center gap-4 text-center max-w-md px-6">
          <div className="codex-empty-seal">凌霄</div>
          <div className="empty-state-slogan text-base text-text-secondary">尚未定义项目蓝图</div>
          <div className="text-xs text-text-tertiary leading-relaxed">
            Leader 调用 <code className="text-accent-brand">define_project_blueprint</code> 自主列出本项目全部子系统后,
            这里展示交互式子系统 DAG 与覆盖状态——把「做一个完整项目」展开成可见的模块清单,防止规划坍缩成 MVP。
          </div>
        </div>
      </div>
    );
  }

  const coverage = computeBlueprintCoverage(blueprint);
  const total = blueprint.subsystems.length;
  const implementedCount = coverage.implemented.length;
  const pct = total > 0 ? Math.round((implementedCount / total) * 100) : 0;
  const ready = coverage.readyToDispatch;
  const segs = 10;
  const filled = total > 0 ? Math.round((implementedCount / total) * segs) : 0;

  const entryById = new Map(blueprint.subsystems.map((e) => [e.subsystemId, e]));
  const levels = topologicalLevels(blueprint.subsystems);
  const levelOrder = [...levels.keys()].sort((a, b) => a - b);
  const highlightSet = highlightedDeps ? new Set(highlightedDeps) : null;

  // 契约覆盖统计
  const implementEntries = blueprint.subsystems.filter((e) => e.status === 'implement');
  const withContract = implementEntries.filter((e) => contractBySubsystem.has(e.subsystemId)).length;
  const withoutContract = implementEntries.length - withContract;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      {/* 仪表盘头:祥云顶栏 */}
      <div className="lingxiao-cloud-line codex-topbar flex flex-col gap-2.5 px-5 py-3 border-b border-border-muted backdrop-blur-2xl shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-text-primary" style={{ fontFamily: 'var(--font-display)' }}>
              项目蓝图
            </span>
            <span className="text-xs text-text-muted truncate">· {blueprint.subsystems.length} 子系统</span>
            {blueprint.notes && (
              <span className="text-[11px] text-text-tertiary truncate hidden md:inline">· {blueprint.notes}</span>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {/* 视图切换 */}
            <div className="flex items-center gap-1 text-[11px]">
              <button
                className={`px-2 py-0.5 rounded ${viewMode === 'dag' ? 'bg-accent-brand/15 text-accent-brand' : 'text-text-muted hover:text-text-secondary'}`}
                onClick={() => setViewMode('dag')}
              >DAG</button>
              <button
                className={`px-2 py-0.5 rounded ${viewMode === 'grid' ? 'bg-accent-brand/15 text-accent-brand' : 'text-text-muted hover:text-text-secondary'}`}
                onClick={() => setViewMode('grid')}
              >网格</button>
            </div>
            {/* 覆盖印章 */}
            {ready ? (
              <div className="flex items-center gap-2">
                <span className="bp-coverage-seal" title="覆盖完整 · 可派发">成</span>
                <span className="text-xs text-accent-green">可派发</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-accent-red">
                <span className="bp-status-seal text-accent-red" title="存在缺口">缺</span>
                <span>{coverage.uncovered.length} 个缺口 · dispatch 拦截中</span>
              </div>
            )}
          </div>
        </div>

        {/* 卷轴进度 + 计数 + 契约覆盖 */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="bp-scroll-track shrink-0" aria-label={`覆盖 ${pct}%`}>
            {Array.from({ length: segs }).map((_, i) => (
              <span key={i} className={`bp-scroll-seg${i < filled ? ' is-filled' : ''}`} />
            ))}
          </span>
          <span className="text-xs text-text-secondary tabular-nums shrink-0 font-medium">
            {implementedCount}/{total} · {pct}%
          </span>
          <span className="text-[11px] text-text-muted shrink-0 hidden sm:flex items-center gap-2">
            <span className="text-accent-yellow">缓 {coverage.deferred.length}</span>
            <span className="text-text-tertiary">略 {coverage.notApplicable.length}</span>
          </span>
          {/* 契约覆盖统计 */}
          {implementEntries.length > 0 && (
            <span className="text-[11px] text-text-muted shrink-0 flex items-center gap-1">
              <span className={withoutContract > 0 ? 'text-accent-red' : 'text-accent-green'}>
                契约 {withContract}/{implementEntries.length}
              </span>
              {withoutContract > 0 && <span className="text-accent-red">· {withoutContract} 缺口</span>}
            </span>
          )}
        </div>

        {/* 缺口 chips(仅未完整) */}
        {!ready && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-accent-red shrink-0">任务缺口:</span>
            {coverage.uncovered.map((s) => (
              <span
                key={s.id}
                className="px-1.5 py-0.5 rounded bg-accent-red/10 text-accent-red border border-accent-red/20 font-mono cursor-pointer hover:bg-accent-red/20"
                onClick={() => setExpandedSubsystem(s.id)}
              >
                {s.id}·{s.name}
              </span>
            ))}
          </div>
        )}
        {/* 契约缺口 chips */}
        {withoutContract > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-accent-red shrink-0">契约缺口:</span>
            {implementEntries
              .filter((e) => !contractBySubsystem.has(e.subsystemId))
              .map((e) => (
                <span
                  key={e.subsystemId}
                  className="px-1.5 py-0.5 rounded bg-accent-red/10 text-accent-red border border-accent-red/20 font-mono"
                >
                  {e.subsystemId}·{e.name}
                </span>
              ))}
          </div>
        )}
      </div>

      {/* 子系统 DAG / 网格 */}
      <div className="flex-1 overflow-auto p-4">
        {viewMode === 'dag' ? (
          <div className="flex flex-col gap-4">
            {/* DAG 分层布局:每层水平排列 */}
            {levelOrder.map((lv) => {
              const ids = levels.get(lv) ?? [];
              return (
                <div key={`level-${lv}`} className="flex items-start gap-3">
                  {/* 层标签 */}
                  <div className="flex items-center gap-1 shrink-0 sticky left-0">
                    <span className="text-[10px] text-text-tertiary font-mono">L{lv}</span>
                  </div>
                  {/* 该层的子系统节点 */}
                  <div className="flex flex-wrap gap-3 flex-1">
                    {ids.map((id) => {
                      const entry = entryById.get(id);
                      if (!entry) return null;
                      const subTasks = entry.taskIds
                        .map((tid) => taskById.get(tid))
                        .filter((t): t is TaskItem => Boolean(t));
                      const contractEntry = contractBySubsystem.get(id);
                      const dependentIds = dependentsBySubsystem.get(id) ?? [];
                      const isHighlighted = Boolean(highlightSet?.has(id));
                      return (
                        <div key={id} className="w-[240px] shrink-0">
                          <SubsystemNode
                            entry={entry}
                            contractEntry={contractEntry}
                            tasks={subTasks}
                            isExpanded={expandedSubsystem === id}
                            onToggle={() => setExpandedSubsystem(expandedSubsystem === id ? null : id)}
                            isHighlighted={isHighlighted}
                            onHoverDeps={setHighlightedDeps}
                            dependentIds={dependentIds}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <DependencyEdges levels={levels} entryById={entryById} containerRef={{ current: null }} />
          </div>
        ) : (
          /* 网格模式(原视图) */
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {blueprint.subsystems.map((entry) => {
              const subTasks = entry.taskIds
                .map((tid) => taskById.get(tid))
                .filter((t): t is TaskItem => Boolean(t));
              const contractEntry = contractBySubsystem.get(entry.subsystemId);
              const dependentIds = dependentsBySubsystem.get(entry.subsystemId) ?? [];
              return (
                <SubsystemNode
                  key={entry.subsystemId}
                  entry={entry}
                  contractEntry={contractEntry}
                  tasks={subTasks}
                  isExpanded={expandedSubsystem === entry.subsystemId}
                  onToggle={() => setExpandedSubsystem(expandedSubsystem === entry.subsystemId ? null : entry.subsystemId)}
                  isHighlighted={Boolean(highlightSet?.has(entry.subsystemId))}
                  onHoverDeps={setHighlightedDeps}
                  dependentIds={dependentIds}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
