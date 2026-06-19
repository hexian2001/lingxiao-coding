import { Box, Text } from 'ink';
import { PanelFrame } from './components/PanelFrame.js';
import { STATUS_ICON, ROLE_HANZI, PROGRESS_FILLED, PROGRESS_EMPTY, DEFAULT_ROLE_HANZI } from './design/iconography.js';
import { computeBlueprintCoverage, getReadySubsystems, type ProjectBlueprint, type BlueprintSubsystemEntry } from '../core/ProjectBlueprint.js';

function entryIcon(entry: BlueprintSubsystemEntry): string {
  if (entry.status === 'defer') return STATUS_ICON.paused; // ◓
  if (entry.status === 'not_applicable') return STATUS_ICON.cancelled; // ◌
  return entry.taskIds.length === 0 ? STATUS_ICON.blocked : STATUS_ICON.completed; // ◇缺口 / ◉
}

function entryColor(entry: BlueprintSubsystemEntry): string {
  if (entry.status === 'implement' && entry.taskIds.length === 0) return 'red';
  if (entry.status === 'defer') return 'yellow';
  if (entry.status === 'not_applicable') return 'gray';
  return 'green';
}

/**
 * 项目蓝图 TUI 面板:子系统行矩阵 + 覆盖进度条头。
 * 复用方寸图标(STATUS_ICON 状态符 + ROLE_HANZI 角色字 + PROGRESS ━/─),与 TeamView/DAGPanel 同语言。
 */
export function BlueprintPanel({ blueprint, width }: { blueprint: ProjectBlueprint | null; width?: number }) {
  if (!blueprint) {
    return (
      <PanelFrame title="项目蓝图" meta="未定义" help="Esc 关闭" width={width}>
        <Text color="gray">尚未定义项目蓝图。</Text>
        <Text color="gray">Leader 调用 define_project_blueprint 自主列出本项目全部子系统,</Text>
        <Text color="gray">把「完整项目」展开成可见清单——防止规划坍缩成 MVP、介入后退回自己干。</Text>
      </PanelFrame>
    );
  }
  const coverage = computeBlueprintCoverage(blueprint);
  const readySubs = getReadySubsystems(blueprint, coverage);
  const readySet = new Set(readySubs);
  const total = blueprint.subsystems.length;
  const implementedCount = coverage.implemented.length;
  const pct = total > 0 ? implementedCount / total : 0;
  const segs = 10;
  const filled = Math.round(pct * segs);
  const bar = PROGRESS_FILLED.repeat(filled) + PROGRESS_EMPTY.repeat(segs - filled);
  const canDispatch = coverage.readyToDispatch;
  const readyMeta = readySubs.length > 0 ? ` · 可推进${readySubs.length}` : '';
  const meta = `${implementedCount}/${total} ${bar} ${canDispatch ? '✓可派发' : `⚠${coverage.uncovered.length}缺口`}${readyMeta}`;

  return (
    <PanelFrame title="项目蓝图" meta={`${blueprint.subsystems.length} 子系统 · ${meta}`} help="define_project_blueprint 修改 · Esc 关闭" width={width}>
      <Box flexDirection="column">
        {blueprint.subsystems.map((entry) => {
          const name = entry.name;
          const role = entry.agentType ?? '';
          const roleChar = (role && ROLE_HANZI[role]) || DEFAULT_ROLE_HANZI;
          const isGap = entry.status === 'implement' && entry.taskIds.length === 0;
          const taskPart = entry.taskIds.length > 0 ? `[${entry.taskIds.join(',')}]` : (isGap ? '✗缺任务' : '');
          const isReady = entry.status === 'implement' && readySet.has(entry.subsystemId);
          const depPart = entry.dependsOn && entry.dependsOn.length > 0 ? `←${entry.dependsOn.join(',')}` : '';
          return (
            <Box key={entry.subsystemId} flexDirection="row">
              <Text color={entryColor(entry)}>{` ${entryIcon(entry)} `}</Text>
              <Text color="cyan">{`${roleChar} `}</Text>
              <Text bold>{name}</Text>
              <Text color="gray">{` (${entry.subsystemId})`}</Text>
              <Text color={isGap ? 'red' : 'gray'}>{taskPart ? ` ${taskPart}` : ''}</Text>
              {isReady && <Text color="green"> ◉可推进</Text>}
              {depPart && <Text color="gray">{` ${depPart}`}</Text>}
            </Box>
          );
        })}
        {!canDispatch && (
          <Box flexDirection="row" marginTop={1}>
            <Text color="red">⚠ dispatch 拦截:为缺口建 create_task(subsystem=&lt;id&gt;),或在 define_project_blueprint 标 defer/na。</Text>
          </Box>
        )}
      </Box>
    </PanelFrame>
  );
}
