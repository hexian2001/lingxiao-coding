/**
 * MaintenanceStatusLine — TUI 输入框下方记忆维护进度条。
 *
 * 位于 Composer 输入框与快捷键提示之间，用紧凑的 block-char 进度条
 * + spinner + 计时 + 阶段描述呈现 dream/distill 实时进展。
 * 视觉层级：accent bar + secondary 文字，不抢输入焦点。
 */
import { Box, Text } from 'ink';
import { useState, useEffect } from 'react';
import { tuiTheme } from '../theme.js';
import { t } from '../../i18n.js';
import {
  INK_SPINNER_FRAMES,
  INK_SPINNER_INTERVAL_MS,
  PROGRESS_FILLED,
  PROGRESS_EMPTY,
} from '../design/iconography.js';

const SPINNER_FRAMES = INK_SPINNER_FRAMES;
const SPINNER_INTERVAL_MS = INK_SPINNER_INTERVAL_MS;
const BAR_WIDTH = 16;

export interface MaintenanceStatusLineProps {
  kind: 'dream' | 'distill';
  stage: string;
  /** 0..1 */
  progress: number;
  detail: string;
  startedAt: number;
}

const KIND_ICON: Record<'dream' | 'distill', string> = {
  dream: '✦',
  distill: '◈',
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m${seconds % 60}s`;
}

function renderBar(progress: number): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(1, progress));
  const filledCount = Math.round(clamped * BAR_WIDTH);
  return {
    filled: PROGRESS_FILLED.repeat(filledCount),
    empty: PROGRESS_EMPTY.repeat(BAR_WIDTH - filledCount),
  };
}

export function MaintenanceStatusLine({ kind, stage, progress, detail, startedAt }: MaintenanceStatusLineProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
    const clock = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => { clearInterval(spin); clearInterval(clock); };
  }, [startedAt]);

  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const bar = renderBar(progress);
  const icon = KIND_ICON[kind];
  const label = t('tui.memory.kind.' + kind);
  const info = [stage, detail].filter(Boolean).join(' · ');

  return (
    <Box>
      <Text color={tuiTheme.semantic.text.accent}>{SPINNER_FRAMES[frame]} {icon} </Text>
      <Text color={tuiTheme.semantic.text.primary}>{label} </Text>
      <Text color={tuiTheme.semantic.text.accent}>{bar.filled}</Text>
      <Text color={tuiTheme.semantic.panel.divider}>{bar.empty}</Text>
      <Text color={tuiTheme.semantic.text.primary}> {pct}%</Text>
      <Text color={tuiTheme.semantic.text.secondary}> {formatElapsed(elapsed)}</Text>
      {info && <Text color={tuiTheme.semantic.panel.help}> {info}</Text>}
    </Box>
  );
}
