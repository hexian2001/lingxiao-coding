/**
 * RewindDialog — 交互式检查点回退对话框（三阶段）。
 *
 * 视图镜像 CommandArgPicker（PanelFrame + 过滤列表 + footer help），但按 stage 分三种布局：
 *  - pick    检查点时间线 + 工作区未提交伪条目（可过滤、数字直达）
 *  - scope   差异/影响预览 + 跨会话警告 + 范围选择（code/conversation/all，db-only 仅 conversation）
 *  - confirm 精确执行计划 + 确认/取消
 *
 * 纯视图：所有键处理在 useRewindDialogKeyHandler；所有异步在 dispatcher.handleRewindCommand。
 * 图标一律取自 design/iconography.ts（方寸系统），禁止 emoji。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { truncateDisplayText } from './utils.js';
import { t } from '../i18n.js';
import { EmptyState, PanelFrame, SelectedLine } from './components/PanelFrame.js';
import { STATUS_ICON, PRIORITY_ICON } from './design/iconography.js';
import {
  getRewindStageRows,
  type RewindDialogState,
} from './runtime/keyHandlers/useRewindDialogKeyHandler.js';
import type { RewindCheckpointSummary } from '../commands/types.js';

const MAX_VISIBLE = 10;

interface RewindDialogProps {
  state: RewindDialogState;
  width?: number;
}

function clampCursor(cursor: number, count: number): number {
  return Math.min(Math.max(0, cursor), Math.max(0, count - 1));
}

function fmtAgo(ts: number): string {
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return t('tui.rewind.just_now');
  if (diff < 3600) return t('tui.rewind.minutes_ago', Math.floor(diff / 60));
  if (diff < 86400) return t('tui.rewind.hours_ago', Math.floor(diff / 3600));
  return t('tui.rewind.days_ago', Math.floor(diff / 86400));
}

function checkpointGlyph(type: RewindCheckpointSummary['type']): string {
  switch (type) {
    case 'session_start': return STATUS_ICON.completed; // ◉ baseline
    case 'turn': return PRIORITY_ICON.critical;          // ◆ milestone
    case 'tool': return STATUS_ICON.running;             // ◐
    case 'revert': return STATUS_ICON.interrupted;       // ◓
    default: return PRIORITY_ICON.normal;                 // ◇ manual
  }
}

function statsText(add: number, del: number, fileCount: number): string {
  return ` +${add} -${del} · ${fileCount}${t('tui.rewind.files_unit')}`;
}

export const RewindDialog: React.FC<RewindDialogProps> = ({ state, width = 76 }) => {
  const contentWidth = Math.max(24, width - 6);
  const rows = getRewindStageRows(state);
  const cursor = clampCursor(state.cursor, rows.length);

  const help =
    state.stage === 'pick' ? t('tui.rewind.help_pick')
      : state.stage === 'scope' ? t('tui.rewind.help_scope')
        : t('tui.rewind.help_confirm');

  return (
    <PanelFrame
      title={t('tui.rewind.title')}
      meta={t('tui.picker.showing', rows.length === 0 ? 0 : 1, rows.length, rows.length)}
      width={width}
      border
      focused
      paddingX={1}
      paddingY={1}
      help={help}
    >
      {state.stage === 'pick' && <PickView state={state} rows={rows} cursor={cursor} contentWidth={contentWidth} />}
      {state.stage === 'scope' && <ScopeView state={state} rows={rows} cursor={cursor} contentWidth={contentWidth} />}
      {state.stage === 'confirm' && <ConfirmView state={state} rows={rows} cursor={cursor} contentWidth={contentWidth} />}
    </PanelFrame>
  );
};

RewindDialog.displayName = 'RewindDialog';

// ─── Stage: pick ─────────────────────────────────────────────────────────────

const PickView: React.FC<{
  state: RewindDialogState;
  rows: ReturnType<typeof getRewindStageRows>;
  cursor: number;
  contentWidth: number;
}> = ({ state, rows, cursor, contentWidth }) => {
  if (state.filter !== '') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={tuiTheme.semantic.text.secondary}>{t('tui.cmdpicker.filter')} </Text>
          <Text color={tuiTheme.semantic.text.primary}>{state.filter}</Text>
          <Text color={tuiTheme.semantic.text.secondary}>{' ·'}</Text>
          <Text color={tuiTheme.semantic.panel.help}> {t('tui.cmdpicker.filter_hint')}</Text>
        </Box>
        {rows.length === 0
          ? <EmptyState text={t('tui.rewind.empty')} width={contentWidth} />
          : <PickList state={state} rows={rows} cursor={cursor} contentWidth={contentWidth} />}
      </Box>
    );
  }
  if (rows.length === 0) return <EmptyState text={t('tui.rewind.empty')} width={contentWidth} />;
  return <PickList state={state} rows={rows} cursor={cursor} contentWidth={contentWidth} />;
};

const PickList: React.FC<{
  state: RewindDialogState;
  rows: ReturnType<typeof getRewindStageRows>;
  cursor: number;
  contentWidth: number;
}> = ({ state, rows, cursor, contentWidth }) => {
  const visibleStart = Math.max(0, cursor - Math.floor(MAX_VISIBLE / 2));
  const visibleEnd = Math.min(rows.length, visibleStart + MAX_VISIBLE);
  const visible = rows.slice(visibleStart, visibleEnd);
  const nameCol = 22;
  return (
    <Box flexDirection="column">
      {visible.map((row, vi) => {
        const realIndex = visibleStart + vi;
        const selected = realIndex === cursor;
        let glyph: string;
        let label: string;
        let desc: string;
        if (row.id === 'working' && state.workingChangesSummary) {
          const w = state.workingChangesSummary;
          glyph = PRIORITY_ICON.important; // ◈
          label = t('tui.rewind.working_label');
          desc = ` ${w.fileCount}${t('tui.rewind.files_unit')}${statsText(w.additions, w.deletions, w.fileCount)}`;
        } else {
          const cp = state.checkpoints.find((c) => c.id === row.id);
          if (!cp) return null;
          glyph = checkpointGlyph(cp.type);
          label = cp.label.replace(/\s+/g, ' ').trim();
          desc = ` ${fmtAgo(cp.timestamp)}${statsText(cp.additions, cp.deletions, cp.fileCount)}`;
        }
        const text = `${glyph} ${truncateDisplayText(label, nameCol)}${truncateDisplayText(desc, contentWidth - nameCol - 4)}`;
        return <SelectedLine key={row.id} selected={selected} text={text} width={contentWidth} color={tuiTheme.semantic.text.secondary} />;
      })}
    </Box>
  );
};

// ─── Stage: scope ────────────────────────────────────────────────────────────

const ScopeView: React.FC<{
  state: RewindDialogState;
  rows: ReturnType<typeof getRewindStageRows>;
  cursor: number;
  contentWidth: number;
}> = ({ state, rows, cursor, contentWidth }) => {
  const cp = state.checkpoints[0];
  const preview = state.preview;
  const codeFiles = cp ? cp.fileCount : (preview?.files.length ?? 0);
  const codeAdd = cp ? cp.additions : 0;
  const codeDel = cp ? cp.deletions : 0;
  const messagesAfter = preview?.messagesAfter ?? 0;
  return (
    <Box flexDirection="column">
      {cp && (
        <Box marginBottom={1}>
          <Text color={tuiTheme.semantic.text.secondary}>{t('tui.rewind.target')} </Text>
          <Text color={tuiTheme.semantic.text.primary}>{checkpointGlyph(cp.type)} {truncateDisplayText(cp.label, contentWidth - 12)}</Text>
          <Text color={tuiTheme.semantic.text.secondary}> ({fmtAgo(cp.timestamp)})</Text>
        </Box>
      )}
      <Box marginBottom={1} flexDirection="column">
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.rewind.impact_title')}</Text>
        <Text>  <Text color={tuiTheme.semantic.status.success}>{t('tui.rewind.code_label')}</Text> {codeFiles}{t('tui.rewind.files_unit')} (+{codeAdd} -{codeDel})</Text>
        <Text>  <Text color={tuiTheme.semantic.status.warning}>{t('tui.rewind.conv_label')}</Text> {messagesAfter > 0 ? t('tui.rewind.messages_to_delete', messagesAfter) : t('tui.rewind.no_messages')}</Text>
      </Box>
      {state.crossSession?.hasOtherSessionChanges && (
        <Box marginBottom={1}>
          <Text color={tuiTheme.semantic.status.error}>{PRIORITY_ICON.critical} {t('tui.rewind.cross_session_warn', state.crossSession.otherSessionIds.join(', '))}</Text>
        </Box>
      )}
      {state.isDbOnly && (
        <Box marginBottom={1}>
          <Text color={tuiTheme.semantic.status.warning}>{t('tui.rewind.db_only_hint')}</Text>
        </Box>
      )}
      <ScopeRows rows={rows} cursor={cursor} contentWidth={contentWidth} />
    </Box>
  );
};

const ScopeRows: React.FC<{
  rows: ReturnType<typeof getRewindStageRows>;
  cursor: number;
  contentWidth: number;
}> = ({ rows, cursor, contentWidth }) => {
  const nameCol = 18;
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const selected = i === cursor;
        let label: string;
        let desc: string;
        if (row.id === 'all') { label = t('tui.rewind.scope_all'); desc = t('tui.rewind.scope_all_desc'); }
        else if (row.id === 'code') { label = t('tui.rewind.scope_code'); desc = t('tui.rewind.scope_code_desc'); }
        else { label = t('tui.rewind.scope_conversation'); desc = t('tui.rewind.scope_conversation_desc'); }
        const text = `${PRIORITY_ICON.normal} ${label}${' '.repeat(Math.max(1, nameCol - label.length - 2))}${desc}`;
        return <SelectedLine key={row.id} selected={selected} text={truncateDisplayText(text, contentWidth)} width={contentWidth} color={tuiTheme.semantic.text.secondary} />;
      })}
    </Box>
  );
};

// ─── Stage: confirm ──────────────────────────────────────────────────────────

const ConfirmView: React.FC<{
  state: RewindDialogState;
  rows: ReturnType<typeof getRewindStageRows>;
  cursor: number;
  contentWidth: number;
}> = ({ state, rows, cursor, contentWidth }) => {
  const scope = state.selectedScope;
  const touchesCode = scope === 'code' || scope === 'all';
  const touchesConv = scope === 'conversation' || scope === 'all';
  const cp = state.checkpoints[0];
  const messagesAfter = state.preview?.messagesAfter ?? 0;
  const willInterrupt = Boolean(state.leaderBusy && touchesConv);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.rewind.confirm_plan')}</Text>
        {touchesCode && cp && (
          <Text>  {STATUS_ICON.running} {t('tui.rewind.plan_code', cp.fileCount)}</Text>
        )}
        {touchesConv && (
          <Text>  {STATUS_ICON.interrupted} {messagesAfter > 0 ? t('tui.rewind.plan_conv', messagesAfter) : t('tui.rewind.plan_conv_none')}</Text>
        )}
        {willInterrupt && (
          <Text color={tuiTheme.semantic.status.warning}>  {PRIORITY_ICON.critical} {t('tui.rewind.will_interrupt')}</Text>
        )}
      </Box>
      {state.crossSession?.hasOtherSessionChanges && (
        <Box marginBottom={1}>
          <Text color={tuiTheme.semantic.status.error}>{PRIORITY_ICON.critical} {t('tui.rewind.cross_session_warn', state.crossSession.otherSessionIds.join(', '))}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        {rows.map((row, i) => {
          const selected = i === cursor;
          const text = row.id === 'confirm'
            ? `${STATUS_ICON.completed} ${t('tui.rewind.confirm_label')}`
            : `${STATUS_ICON.cancelled} ${t('tui.rewind.cancel')}`;
          return <SelectedLine key={row.id} selected={selected} text={truncateDisplayText(text, contentWidth)} width={contentWidth} color={tuiTheme.semantic.text.secondary} />;
        })}
      </Box>
    </Box>
  );
};
