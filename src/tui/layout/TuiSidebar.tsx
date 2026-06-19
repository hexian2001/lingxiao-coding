/**
 * TuiSidebar — 可点击的侧栏导航面板 + 底部实时状态面板
 *
 * 对标 Claude Code TUI 的侧栏: 固定宽度, 列出可切换的面板项,
 * 支持鼠标点击 + 数字键快捷切换。
 *
 * 导航项之下用弹性 spacer 将「实时状态面板」钉到底部: 控制模式、
 * 活跃智能体数、上下文占用条、Token 总量、当前模型。状态面板不参与
 * 点击行映射（仅导航项可点击），故 getSidebarItemAtRow 行号逻辑不受影响。
 */
import { Box, Text } from 'ink';
import { tuiTheme } from '../theme.js';
import { t } from '../../i18n.js';
import { formatCost } from '../../llm/CostService.js';
import { renderCloudBand, renderCloudDivider } from './cloudPattern.js';

export interface SidebarItem {
  id: string;
  label: string;
  shortcut?: string;  // 显示的快捷键提示 (如 "1", "2")
  badge?: number;     // 右侧数字徽章 (如未读消息数)
}

/** 侧栏底部实时状态。全部字段可选——缺省即不渲染对应行。 */
export interface SidebarStatus {
  /** 控制模式: chat / plan / agent */
  mode?: 'chat' | 'plan' | 'agent';
  /** 当前活跃（运行中）的智能体数 */
  activeWorkers?: number;
  /** 已注册的智能体总数 */
  totalWorkers?: number;
  /** leader 运行时是否在驱动 */
  leaderActive?: boolean;
  /** 上下文已用 token */
  contextTokens?: number;
  /** 上下文上限 token */
  contextLimit?: number;
  /** 上下文占用比例 0..1（若给定优先于 tokens/limit 推算） */
  contextPct?: number;
  /** 会话累计 token */
  totalTokens?: number;
  /** 会话累计费用 ($) —— host 经 calculateSessionCost 算出注入 */
  cost?: number;
  /** 当前模型名 */
  modelName?: string;
  /** dream/distill 维护状态摘要 */
  memory?: {
    activeKind?: 'dream' | 'distill';
    dreamDue?: boolean;
    distillDue?: boolean;
    assets?: number;
    memoryLines?: number;
  };
}

interface TuiSidebarProps {
  items: SidebarItem[];
  activeItem: string;
  width: number;
  onSelect: (id: string) => void;
  status?: SidebarStatus;
}

export const SIDEBAR_HEADER_ROWS = 4;

export function getSidebarItemRowRanges(items: SidebarItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    map.set(items[i].id, i + SIDEBAR_HEADER_ROWS);
  }
  return map;
}

export function getSidebarItemAtRow(items: SidebarItem[], rowInSidebar: number): SidebarItem | undefined {
  const itemIndex = rowInSidebar - SIDEBAR_HEADER_ROWS;
  return itemIndex >= 0 && itemIndex < items.length ? items[itemIndex] : undefined;
}

/** 紧凑 token 计数: 1234 -> 1.2k, 1200000 -> 1.2M */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 控制模式 -> 显示标签 + 语义色 */
function modeChip(mode: SidebarStatus['mode']): { label: string; color: string } {
  switch (mode) {
    case 'plan':
      return { label: t('tui.sidebar.mode_plan'), color: tuiTheme.semantic.runtime.leader };
    case 'agent':
      return { label: t('tui.sidebar.mode_agent'), color: tuiTheme.semantic.text.accent };
    case 'chat':
    default:
      return { label: t('tui.sidebar.mode_chat'), color: tuiTheme.semantic.status.completed };
  }
}

/**
 * 渲染一条占用比例条: 用块字符 ▰▱ 画 8 段，按比例上色。
 * 满 70% 转 warning，满 90% 转 error。
 */
function renderUsageBar(pct: number, segments: number): { text: string; color: string } {
  const finite = Number.isFinite(pct) ? pct : 0;
  const clamped = finite < 0 ? 0 : finite > 1 ? 1 : finite;
  const filled = Math.round(clamped * segments);
  const bar = '▰'.repeat(filled) + '▱'.repeat(Math.max(0, segments - filled));
  const color = clamped >= 0.9
    ? tuiTheme.semantic.status.error
    : clamped >= 0.7
      ? tuiTheme.semantic.status.warning
      : tuiTheme.semantic.status.completed;
  return { text: bar, color };
}

export function formatContextPercentLabel(pct: number): string {
  const finite = Number.isFinite(pct) ? pct : 0;
  return finite > 1 ? '100%+' : `${Math.round(Math.max(0, finite) * 100)}%`;
}

/** 底部状态面板。无任何可显示字段时返回 null。 */
function StatusPanel({ status, innerWidth }: { status: SidebarStatus; innerWidth: number }) {
  const hasMode = !!status.mode;
  const hasWorkers = status.totalWorkers !== undefined && status.totalWorkers > 0;
  const ctxPct = status.contextPct !== undefined
    ? status.contextPct
    : (status.contextTokens !== undefined && status.contextLimit && status.contextLimit > 0
      ? status.contextTokens / status.contextLimit
      : undefined);
  const hasCtx = ctxPct !== undefined;
  const hasTokens = status.totalTokens !== undefined && status.totalTokens > 0;
  const hasCost = status.cost !== undefined && status.cost > 0;
  const hasModel = !!status.modelName;
  const hasMemory = !!status.memory;

  if (!hasMode && !hasWorkers && !hasCtx && !hasTokens && !hasCost && !hasModel && !hasMemory) return null;

  const labelColor = tuiTheme.semantic.panel.help;
  const valueColor = tuiTheme.semantic.text.secondary;
  const barSegments = Math.max(4, Math.min(8, innerWidth - 6));

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* 顶部分隔线 + 标题 */}
      <Text color={tuiTheme.semantic.panel.border}>{renderCloudDivider(Math.max(0, innerWidth - 2))}</Text>
      <Text color={labelColor} bold>{'☁ '}{t('tui.sidebar.status')}</Text>

      {hasMode && (() => {
        const chip = modeChip(status.mode);
        return (
          <Box>
            <Text color={labelColor}>{`${t('tui.sidebar.mode')} `}</Text>
            <Text color={chip.color} bold>{chip.label}</Text>
            {status.leaderActive && <Text color={tuiTheme.semantic.status.running}>{' ●'}</Text>}
          </Box>
        );
      })()}

      {hasWorkers && (
        <Box>
          <Text color={labelColor}>{`${t('tui.sidebar.workers')} `}</Text>
          <Text color={(status.activeWorkers ?? 0) > 0 ? tuiTheme.semantic.status.running : valueColor} bold>
            {`${status.activeWorkers ?? 0}`}
          </Text>
          <Text color={labelColor}>{`/${status.totalWorkers}`}</Text>
        </Box>
      )}

      {hasCtx && (() => {
        const bar = renderUsageBar(ctxPct!, barSegments);
        const pctText = formatContextPercentLabel(ctxPct!);
        return (
          <Box flexDirection="column">
            <Text color={labelColor}>{`${t('tui.sidebar.context')} ${pctText}`}</Text>
            <Text color={bar.color}>{bar.text}</Text>
          </Box>
        );
      })()}

      {hasTokens && (
        <Box>
          <Text color={labelColor}>{`${t('tui.sidebar.tokens')} `}</Text>
          <Text color={valueColor}>{formatCompactTokens(status.totalTokens!)}</Text>
        </Box>
      )}

      {hasCost && (
        <Box>
          <Text color={labelColor}>{`${t('tui.sidebar.cost')} `}</Text>
          <Text color={tuiTheme.semantic.status.completed}>{formatCost(status.cost!)}</Text>
        </Box>
      )}

      {hasModel && (
        <Box flexDirection="column">
          <Text color={labelColor}>{t('tui.sidebar.model')}</Text>
          <Text color={tuiTheme.semantic.text.accent} wrap="truncate-end">{status.modelName}</Text>
        </Box>
      )}

      {hasMemory && (
        <Box flexDirection="column">
          <Text color={labelColor}>{t('tui.sidebar.memory')}</Text>
          <Text color={status.memory?.activeKind ? tuiTheme.semantic.status.running : valueColor} wrap="truncate-end">
            {status.memory?.activeKind
              ? `${status.memory.activeKind} ${t('tui.sidebar.memory_running')}`
              : `M${status.memory?.memoryLines ?? 0} · A${status.memory?.assets ?? 0}`}
          </Text>
          {(status.memory?.dreamDue || status.memory?.distillDue) && (
            <Text color={tuiTheme.semantic.status.warning} wrap="truncate-end">
              {[
                status.memory.dreamDue ? 'dream' : '',
                status.memory.distillDue ? 'distill' : '',
              ].filter(Boolean).join('/')} {t('tui.sidebar.memory_due')}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

export function TuiSidebar({ items, activeItem, width, onSelect: _onSelect, status }: TuiSidebarProps) {
  const innerWidth = width - 1; // 减去右侧边框线
  const brandCloud = renderCloudBand(Math.max(0, innerWidth - 4));
  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle="single" borderRight borderTop={false} borderLeft={false} borderBottom={false} borderColor={tuiTheme.semantic.panel.borderMuted}>
      {/* Logo / brand */}
      <Box paddingLeft={1} paddingTop={0} flexDirection="column">
        <Text bold color={tuiTheme.semantic.text.accent}>{t('tui.sidebar.brand')}</Text>
        <Text color={tuiTheme.semantic.panel.border}>{brandCloud[0]}</Text>
        <Text color={tuiTheme.semantic.panel.borderMuted}>{brandCloud[1]}</Text>
      </Box>
      {/* Divider */}
      <Box paddingLeft={1}>
        <Text color={tuiTheme.semantic.panel.border}>{renderCloudDivider(Math.max(0, innerWidth - 2))}</Text>
      </Box>
      {/* Items */}
      {items.map((item) => {
        const isActive = item.id === activeItem;
        return (
          <Box key={item.id} paddingLeft={0}>
            <Text color={isActive ? tuiTheme.semantic.text.accent : tuiTheme.semantic.panel.border}>
              {isActive ? ' ▍' : '  '}
            </Text>
            <Text
              bold={isActive}
              color={isActive ? tuiTheme.semantic.text.primary : tuiTheme.semantic.text.secondary}
              backgroundColor={isActive ? tuiTheme.semantic.selection.background : undefined}
              wrap="truncate-end"
            >
              {' '}{item.shortcut ? `${item.shortcut} ` : ''}{item.label}
            </Text>
            {item.badge !== undefined && item.badge > 0 && (
              <Text color={tuiTheme.semantic.status.warning} bold>{` [${item.badge}]`}</Text>
            )}
          </Box>
        );
      })}
      {/* 弹性 spacer: 把状态面板推到底部 */}
      {status && (
        <>
          <Box flexGrow={1} />
          <StatusPanel status={status} innerWidth={innerWidth} />
        </>
      )}
    </Box>
  );
}
