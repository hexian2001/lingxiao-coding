/**
 * DAGPanel — Stunning Terminal DAG Visualization
 *
 * Layout:
 *   ┌─ Stats Bar ──────────────────────────────────────────┐
 *   │  TOTAL  RUNNING  DONE  BLOCKED  FAILED  SUCCESS%     │
 *   └──────────────────────────────────────────────────────┘
 *   ┌─ Level 0 ─┐   ┌─ Level 1 ─┐   ┌─ Level 2 ─┐
 *   │ ▶ task-1  │──▶│ ✓ task-2  │──▶│ ○ task-4  │
 *   │   coding  │   │   review  │   │   verify  │
 *   └───────────┘   └───────────┘   └───────────┘
 *
 * Key bindings:
 *   ↑/↓   Navigate nodes
 *   ←/→   Switch pages
 *   Enter  Jump to agent channel
 *   Esc    Close panel
 *   Ctrl+X Toggle panel
 */

import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { truncateDisplayText } from './utils.js';
import type { TaskDisplayState } from '../core/TaskDisplayState.js';
import {
  getRoleVisual,
  getTaskStatusVisual,
  getTaskVisualStatus,
  type TaskVisualStatus,
} from './design/visuals.js';
import { Divider, EmptyState, HelpLine, PanelFrame } from './components/PanelFrame.js';
import { PROGRESS_FILLED, PROGRESS_EMPTY } from './design/iconography.js';
import { t } from '../i18n.js';

// ── Types ──

interface DAGTask {
  id: string;
  subject: string;
  status: 'dispatchable' | 'running' | 'terminal' | 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  displayState?: TaskDisplayState;
  exitReason?: string;
  exit_reason?: string;
  agent_type?: string;
  assigned_agent?: string;
  blocked_by?: string[];
  progress?: number;
  started_at?: string;
  completed_at?: string;
}

interface DAGAgent {
  name: string;
  role: string;
  taskId?: string;
  avatar?: string;
}

interface DAGPanelProps {
  tasks: DAGTask[];
  agents: DAGAgent[];
  width?: number;
  cursor?: number;
}

interface Edge {
  from: string;
  to: string;
}

// ── Config ──

function getDisplayStatus(task: DAGTask): TaskVisualStatus {
  return getTaskVisualStatus(task);
}

const STATUS_CONFIG: Record<
  TaskVisualStatus,
  { icon: string; color: string; labelKey: string; barChar: string }
> = {
  completed: { ...getTaskStatusVisual('completed'), labelKey: 'tui.dag.status.completed' },
  in_progress: { ...getTaskStatusVisual('in_progress'), labelKey: 'tui.dag.status.in_progress' },
  pending: { ...getTaskStatusVisual('pending'), labelKey: 'tui.dag.status.pending' },
  blocked: { ...getTaskStatusVisual('blocked'), labelKey: 'tui.dag.status.blocked' },
  failed: { ...getTaskStatusVisual('failed'), labelKey: 'tui.dag.status.failed' },
  cancelled: { ...getTaskStatusVisual('cancelled'), labelKey: 'tui.dag.status.cancelled' },
};

const PAGE_SIZE = 10;
const NODE_W = 26; // inner content width (excl. border chars)

// ── DAG Build ──

function buildDAG(tasks: DAGTask[]): {
  levels: Map<number, string[]>;
  edges: Edge[];
  taskMap: Map<string, DAGTask>;
  levelOrder: number[];
} {
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const edges: Edge[] = [];
  const children = new Map<string, string[]>();

  for (const task of tasks) {
    for (const dep of task.blocked_by || []) {
      if (taskMap.has(dep)) {
        edges.push({ from: dep, to: task.id });
        const list = children.get(dep) || [];
        list.push(task.id);
        children.set(dep, list);
      }
    }
  }

  // Topological level assignment
  const inDeg = new Map<string, number>(tasks.map(t => [t.id, 0]));
  for (const e of edges) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);

  const queue = tasks.filter(t => inDeg.get(t.id) === 0).map(t => t.id);
  const levels = new Map<number, string[]>();
  let lv = 0;

  while (queue.length > 0) {
    const size = queue.length;
    levels.set(lv, []);
    for (let i = 0; i < size; i++) {
      const id = queue.shift()!;
      levels.get(lv)!.push(id);
      for (const child of children.get(id) || []) {
        inDeg.set(child, (inDeg.get(child) || 0) - 1);
        if (inDeg.get(child) === 0) queue.push(child);
      }
    }
    lv++;
  }

  // Catch cycles
  for (const task of tasks) {
    const alreadyPlaced = [...levels.values()].some(ids => ids.includes(task.id));
    if (!alreadyPlaced) {
      const l0 = levels.get(0) || [];
      l0.push(task.id);
      levels.set(0, l0);
    }
  }

  const levelOrder = [...levels.keys()].sort((a, b) => a - b);
  return { levels, edges, taskMap, levelOrder };
}

// ── Selectable Items ──

export type DAGSelectableItem =
  | { kind: 'task'; task: DAGTask; agentName?: string }
  | { kind: 'agent'; agent: DAGAgent };

export function getDAGSelectableItems(tasks: DAGTask[], agents: DAGAgent[]): DAGSelectableItem[] {
  const { levels, levelOrder } = buildDAG(tasks);
  const items: DAGSelectableItem[] = [];

  for (const lv of levelOrder) {
    for (const id of levels.get(lv) || []) {
      const task = tasks.find(t => t.id === id);
      if (task) items.push({ kind: 'task', task, agentName: task.assigned_agent });
    }
  }
  for (const agent of agents) {
    items.push({ kind: 'agent', agent });
  }
  return items;
}

// ── Mini Stats Bar ──

function StatsBar({ tasks, width }: { tasks: DAGTask[]; width: number }) {
  const total      = tasks.length;
  const running    = tasks.filter(t => getDisplayStatus(t) === 'in_progress').length;
  const done       = tasks.filter(t => getDisplayStatus(t) === 'completed').length;
  const blocked    = tasks.filter(t => getDisplayStatus(t) === 'blocked').length;
  const failed     = tasks.filter(t => getDisplayStatus(t) === 'failed' || getDisplayStatus(t) === 'cancelled').length;
  const successPct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Mini progress bar
  const barLen = Math.min(20, width - 50);
  const filledLen = Math.max(0, Math.round((successPct / 100) * barLen));
  const emptyLen  = Math.max(0, barLen - filledLen);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Top border */}
      <Text color={tuiTheme.semantic.panel.border}>
        {'┌' + '─'.repeat(width - 2) + '┐'}
      </Text>
      {/* Stats row */}
      <Box flexDirection="row">
        <Text color={tuiTheme.semantic.panel.border}>{'│ '}</Text>
        {/* Total */}
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.dag.stat_total')}</Text>
        <Text bold color={tuiTheme.semantic.text.primary}>{String(total).padEnd(3)}</Text>
        <Text color={tuiTheme.semantic.panel.border}>{'  │  '}</Text>
        {/* Running */}
        <Text color={tuiTheme.semantic.status.info}>{'◐ '}</Text>
        <Text bold color={tuiTheme.semantic.status.info}>{String(running).padEnd(2)}</Text>
        <Text color={tuiTheme.semantic.panel.border}>{'  '}</Text>
        {/* Done */}
        <Text color={tuiTheme.semantic.status.completed}>{'◉ '}</Text>
        <Text bold color={tuiTheme.semantic.status.completed}>{String(done).padEnd(2)}</Text>
        <Text color={tuiTheme.semantic.panel.border}>{'  '}</Text>
        {/* Blocked */}
        <Text color={tuiTheme.semantic.status.blocked}>{'◇ '}</Text>
        <Text bold color={tuiTheme.semantic.status.blocked}>{String(blocked).padEnd(2)}</Text>
        <Text color={tuiTheme.semantic.panel.border}>{'  '}</Text>
        {/* Failed */}
        <Text color={tuiTheme.semantic.status.failed}>{'✕ '}</Text>
        <Text bold color={tuiTheme.semantic.status.failed}>{String(failed).padEnd(2)}</Text>
        <Text color={tuiTheme.semantic.panel.border}>{'  │  '}</Text>
        {/* Success rate + bar */}
        <Text color={successPct >= 80 ? tuiTheme.semantic.status.completed : successPct >= 50 ? tuiTheme.semantic.status.blocked : tuiTheme.semantic.text.secondary}>
          {String(successPct).padStart(3)}{'% '}
        </Text>
        {barLen > 0 && (
          <>
            <Text color={tuiTheme.semantic.status.completed}>{PROGRESS_FILLED.repeat(filledLen)}</Text>
            <Text color={tuiTheme.semantic.panel.borderMuted}>{PROGRESS_EMPTY.repeat(emptyLen)}</Text>
          </>
        )}
        <Text color={tuiTheme.semantic.panel.border}>{' │'}</Text>
      </Box>
      {/* Bottom border */}
      <Text color={tuiTheme.semantic.panel.border}>
        {'└' + '─'.repeat(width - 2) + '┘'}
      </Text>
    </Box>
  );
}

// ── Node Box ──

interface NodeBoxProps {
  task: DAGTask;
  agentMap: Map<string, DAGAgent>;
  isFocused: boolean;
  isLast: boolean; // last in column → └ else ├
}

function NodeBox({ task, agentMap, isFocused, isLast }: NodeBoxProps) {
  const displayStatus = getDisplayStatus(task);
  const cfg = STATUS_CONFIG[displayStatus];
  const agent = task.assigned_agent ? agentMap.get(task.assigned_agent) : undefined;
  const roleCfg = agent ? getRoleVisual(agent.role) : null;

  const borderColor = isFocused
    ? (roleCfg?.color || cfg.color)
    : cfg.color;
  const dimColor = tuiTheme.semantic.panel.border;

  // connector char
  const connChar = isLast ? '└─' : '├─';

  // truncated subject
  const subject = truncateDisplayText(task.subject, NODE_W - 2);
  // short id
  const shortId = task.id.length > 10 ? task.id.slice(0, 10) : task.id;

  // progress bar (if available)
  const prog = task.progress;
  const progBarLen = NODE_W - 6;
  const progFilled = prog !== undefined ? Math.round((prog / 100) * progBarLen) : 0;
  const progEmpty  = prog !== undefined ? progBarLen - progFilled : 0;

  return (
    <Box flexDirection="row" marginBottom={0}>
      {/* Connector */}
      <Text color={dimColor}>{connChar}</Text>

      {/* Node box */}
      <Box flexDirection="column">
        {/* Top border */}
        <Text color={borderColor}>
          {'┌' + '─'.repeat(NODE_W) + '┐'}
        </Text>

        {/* Status + ID row */}
        <Box flexDirection="row">
          {/* Left accent strip */}
          <Text color={cfg.color}>{'│'}</Text>
          <Text color={cfg.color}>{' ' + cfg.icon + ' '}</Text>
          <Text bold={isFocused} color={isFocused ? tuiTheme.semantic.panel.title : tuiTheme.semantic.text.primary}>
            {shortId.padEnd(10)}
          </Text>
          {roleCfg && (
            <>
              <Text color={tuiTheme.semantic.panel.border}>{'│'}</Text>
              <Text color={roleCfg.color}>{' ' + roleCfg.abbr}</Text>
            </>
          )}
          {!roleCfg && <Text color={dimColor}>{'    '}</Text>}
          <Text color={borderColor}>{'│'}</Text>
        </Box>

        {/* Subject row */}
        <Box flexDirection="row">
          <Text color={borderColor}>{'│ '}</Text>
          <Text color={isFocused ? tuiTheme.semantic.text.primary : tuiTheme.semantic.text.secondary}>
            {subject.padEnd(NODE_W - 2)}
          </Text>
          <Text color={borderColor}>{'│'}</Text>
        </Box>

        {/* Agent row */}
        {agent && (
          <Box flexDirection="row">
            <Text color={borderColor}>{'│ '}</Text>
            <Text color={roleCfg?.color || tuiTheme.semantic.text.secondary}>
              {'@' + truncateDisplayText(agent.name, NODE_W - 3)}
            </Text>
            <Text color={borderColor}>{'│'}</Text>
          </Box>
        )}

        {/* Progress row */}
        {prog !== undefined && (
          <Box flexDirection="row">
            <Text color={borderColor}>{'│ '}</Text>
            <Text color={cfg.color}>{PROGRESS_FILLED.repeat(progFilled)}</Text>
            <Text color={tuiTheme.semantic.panel.borderMuted}>{PROGRESS_EMPTY.repeat(progEmpty)}</Text>
            <Text color={tuiTheme.semantic.text.secondary}>{' ' + String(prog) + '%'}</Text>
            <Text color={borderColor}>{'│'}</Text>
          </Box>
        )}

        {/* Bottom border */}
        <Text color={borderColor}>
          {'└' + '─'.repeat(NODE_W) + '┘'}
        </Text>
      </Box>
    </Box>
  );
}

// ── Level Column ──

interface LevelColumnProps {
  levelIdx: number;
  taskIds: string[];
  tasks: DAGTask[];
  agentMap: Map<string, DAGAgent>;
  cursorIdx: number;
  selectableItems: DAGSelectableItem[];
  pageStart: number;
  pageEnd: number;
  hasNext: boolean; // whether there's a next level (draw edge arrow)
}

function LevelColumn({
  levelIdx,
  taskIds,
  tasks,
  agentMap,
  cursorIdx,
  selectableItems,
  pageStart,
  pageEnd,
  hasNext,
}: LevelColumnProps) {
  const labelColor = tuiTheme.semantic.panel.help;

  return (
    <Box flexDirection="column">
      {/* Level label */}
      <Box flexDirection="row" marginBottom={0}>
        <Text color={labelColor}>{'  L'}</Text>
        <Text bold color={labelColor}>{String(levelIdx)}</Text>
        <Text color={labelColor}>{' '}</Text>
      </Box>

      {/* Nodes */}
      {taskIds.map((taskId, idx) => {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return null;

        const selectIdx = selectableItems.findIndex(
          item => item.kind === 'task' && item.task.id === taskId
        );
        if (selectIdx < pageStart || selectIdx >= pageEnd) return null;

        const isFocused = cursorIdx === selectIdx;
        const isLast = idx === taskIds.length - 1;

        return (
          <NodeBox
            key={taskId}
            task={task}
            agentMap={agentMap}
            isFocused={isFocused}
            isLast={isLast}
          />
        );
      })}
    </Box>
  );
}

// ── Main Component ──

export const DAGPanel: FunctionComponent<DAGPanelProps> = ({
  tasks,
  agents,
  width = (process.stdout.columns || 100) - 8,
  cursor = 0,
}) => {
  const contentWidth = Math.max(60, width);

  // Empty state
  if (tasks.length === 0 && agents.length === 0) {
    return (
      <PanelFrame title={t('tui.dag.title')} width={contentWidth}>
        <EmptyState text={t('tui.dag.empty')} width={contentWidth - 4} />
      </PanelFrame>
    );
  }

  const agentMap = new Map(agents.map(a => [a.name, a]));
  const { levels, edges, taskMap, levelOrder } = buildDAG(tasks);
  const selectableItems = getDAGSelectableItems(tasks, agents);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(selectableItems.length / PAGE_SIZE));
  const cursorIdx = Math.min(cursor, selectableItems.length - 1);
  const currentPage = Math.min(Math.floor(cursorIdx / PAGE_SIZE), totalPages - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, selectableItems.length);

  const selectedItem = selectableItems[cursorIdx];

  // ── Render ──

  return (
    <PanelFrame
      title={t('tui.dag.title')}
      meta={t('tui.dag.meta', tasks.length, levelOrder.length, agents.length, totalPages > 1 ? ` · ${currentPage + 1}/${totalPages}` : '')}
      width={contentWidth}
    >

      {/* ── Stats Bar ── */}
      <StatsBar tasks={tasks} width={Math.min(contentWidth, 72)} />

      {/* ── DAG Levels (horizontal layout) ── */}
      <Box flexDirection="row" alignItems="flex-start">
        {levelOrder.map((lv, lvIdx) => {
          const taskIds = levels.get(lv) || [];
          const hasNext = lvIdx < levelOrder.length - 1;
          return (
            <Box key={`level-${lv}`} flexDirection="row" alignItems="center">
              <LevelColumn
                levelIdx={lv}
                taskIds={taskIds}
                tasks={tasks}
                agentMap={agentMap}
                cursorIdx={cursorIdx}
                selectableItems={selectableItems}
                pageStart={pageStart}
                pageEnd={pageEnd}
                hasNext={hasNext}
              />
              {hasNext && (
                <Box flexDirection="column" justifyContent="center" paddingX={1}>
                  <Text color={tuiTheme.semantic.panel.borderMuted}>{'-->'}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* ── Agent Roster ── */}
      {agents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Divider width={Math.min(contentWidth - 2, 60)} />
          <Box flexDirection="row" flexWrap="wrap" marginTop={0}>
            {agents.map(agent => {
              const roleCfg = getRoleVisual(agent.role);
              const agentSelectIdx = selectableItems.findIndex(
                item => item.kind === 'agent' && item.agent.name === agent.name
              );
              const isFocused = cursorIdx === agentSelectIdx;

              return (
                <Box key={`agent-${agent.name}`} flexDirection="row" marginRight={3} marginTop={0}>
                  <Text color={isFocused ? tuiTheme.semantic.border.focused : tuiTheme.semantic.panel.border}>{isFocused ? '> ' : '  '}</Text>
                  <Text color={roleCfg.color} bold={isFocused}>{`[${roleCfg.abbr}] `}</Text>
                  <Text color={isFocused ? tuiTheme.semantic.panel.title : tuiTheme.semantic.text.primary}>{agent.name}</Text>
                  {agent.taskId && (
                    <Text color={tuiTheme.semantic.status.info}>{` -> ${agent.taskId}`}</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {/* ── Selected Detail ── */}
      {selectedItem?.kind === 'task' && (
        <Box flexDirection="column" marginTop={1}>
          <Divider width={Math.min(contentWidth - 2, 60)} />
          <Box flexDirection="row" marginTop={0}>
            <Text bold color={tuiTheme.semantic.panel.title}>{'> '}</Text>
            <Text bold color={STATUS_CONFIG[getDisplayStatus(selectedItem.task)].color}>
              {STATUS_CONFIG[getDisplayStatus(selectedItem.task)].icon + '  '}
            </Text>
            <Text bold color={tuiTheme.semantic.panel.title}>{selectedItem.task.id}</Text>
          </Box>
          <Box flexDirection="column" marginLeft={4}>
            <Text color={tuiTheme.semantic.text.primary}>{selectedItem.task.subject}</Text>
            {selectedItem.task.assigned_agent && (() => {
              const roleVisual = getRoleVisual(agentMap.get(selectedItem.task.assigned_agent)?.role);
              return (
                <Text color={roleVisual.color}>
                  {'@' + selectedItem.task.assigned_agent}
                </Text>
              );
            })()}
            {selectedItem.task.blocked_by && selectedItem.task.blocked_by.length > 0 && (
              <Text>
                <Text color={tuiTheme.semantic.text.secondary}>{t('tui.dag.dependency')}</Text>
                <Text color={tuiTheme.semantic.status.blocked}>{selectedItem.task.blocked_by.join(', ')}</Text>
              </Text>
            )}
            {selectedItem.task.progress !== undefined && (
              <Text>
                <Text color={tuiTheme.semantic.text.secondary}>{t('tui.dag.progress')}</Text>
                <Text color={tuiTheme.semantic.status.info}>{selectedItem.task.progress + '%'}</Text>
              </Text>
            )}
          </Box>
        </Box>
      )}

      {/* ── Help ── */}
      <HelpLine text={t('tui.dag.help')} width={contentWidth - 4} />

    </PanelFrame>
  );
};

export default DAGPanel;
