/**
 * StreamingStatusLine — 一体化流式状态条
 *
 * 对齐 CodeBuddy LoadingBox：在同一行紧凑显示
 * `✸ Calculating… (3s · writing file · ↓ 1.2k tokens · esc to interrupt)`
 *
 * 组成部分：
 * - Spinner 动画
 * - Loading phrase（随机轮播）
 * - Timer（从请求开始计时）
 * - Phase label（writing file / editing / running tool）
 * - Token 计数（↓ N tokens）
 * - Interrupt hint（esc to interrupt）
 */
import { Box, Text } from 'ink';
import { useState, useEffect, useRef } from 'react';
import { tuiTheme } from '../theme.js';
import { t, getList } from '../../i18n.js';
import {
  INK_SPINNER_FRAMES,
  INK_SPINNER_INTERVAL_MS,
  PROGRESS_FILLED,
  PROGRESS_EMPTY,
} from '../design/iconography.js';

const SPINNER_FRAMES = INK_SPINNER_FRAMES;
const SPINNER_INTERVAL_MS = INK_SPINNER_INTERVAL_MS;

const PHRASE_ROTATE_MS = 5000;

/** 工具名 → 人类友好文案（TUI 端，与 web/src/utils/toolPhaseLabels.ts 对齐） */
function getToolLabel(toolName?: string): string {
  if (!toolName) return '';
  const key = 'tui.stream.tool.' + toolName.toLowerCase();
  const label = t(key);
  // t() 对未命中的 key 原样返回 key 自身，据此回退到默认文案
  return label === key ? t('tui.stream.tool.default', toolName) : label;
}

function formatToken(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function clampPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 6;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function chunkPercent(progress?: StreamingStatusLineProps['compactingProgress']): number {
  if (!progress) return 6;
  const explicit = clampPercent(progress.percent);
  if (typeof progress.percent === 'number') return explicit;
  if (progress.chunkTotal && progress.chunkTotal > 0 && progress.chunkIndex) {
    return Math.max(12, Math.min(92, Math.round((progress.chunkIndex / progress.chunkTotal) * 76 + 14)));
  }
  if (progress.stage === 'finalizing') return 94;
  if (progress.stage === 'llm_summary') return 18;
  return 6;
}

function renderProgressBar(percent: number, width = 44): { filled: string; empty: string } {
  const filledCount = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return {
    filled: PROGRESS_FILLED.repeat(filledCount),
    empty: PROGRESS_EMPTY.repeat(width - filledCount),
  };
}

export interface StreamingStatusLineProps {
  /** 是否正在活跃（控制显示/隐藏） */
  active: boolean;
  /** 当前阶段（model_requesting / streaming / tool_executing 等） */
  phase?: string;
  /** 正在流式生成参数的工具名 */
  streamingToolName?: string;
  /** 正在执行的工具名 */
  toolName?: string;
  /** 工具入参实时构建中的 partialJson 预览 */
  partialJson?: string;
  /** 实时 output token 估算 */
  outputTokens: number;
  /** 请求开始时间戳（用于计时） */
  startedAt?: number;
  /** 上下文压缩进度（phase === compacting 时显示块状进度条） */
  compactingProgress?: {
    stage?: string;
    chunkIndex?: number;
    chunkTotal?: number;
    percent?: number;
    oldTokens?: number;
    newTokens?: number;
    threshold?: number;
    messageCount?: number;
    label?: string;
  };
}

export function StreamingStatusLine({
  active,
  phase,
  streamingToolName,
  toolName,
  partialJson,
  outputTokens,
  startedAt,
  compactingProgress,
}: StreamingStatusLineProps) {
  const phrases = getList('tui.stream.phrases');
  const [phraseIndex, setPhraseIndex] = useState(() => Math.floor(Math.random() * (phrases.length || 1)));
  const [elapsed, setElapsed] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Spinner 动画
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);

  // 轮播 loading phrase
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setPhraseIndex(i => (i + 1) % (phrases.length || 1));
    }, PHRASE_ROTATE_MS);
    return () => clearInterval(id);
  }, [active]);

  // 计时器
  useEffect(() => {
    if (!active || !startedAt) {
      setElapsed(0);
      return;
    }
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [active, startedAt]);

  // Phase label（每次渲染求值，确保语言切换即时生效）
  const phaseLabel = (() => {
    if (streamingToolName) return getToolLabel(streamingToolName);
    if (phase === 'tool_executing' && toolName) return t('tui.stream.phase.tool_executing', toolName);
    if (phase === 'model_requesting') return t('tui.stream.phase.waiting_model');
    if (phase === 'retrying') return t('tui.stream.phase.retrying');
    // 压缩进行中：LLM 分层摘要阶段把分块进度（toolName 形如 "summary 2/5"）一并展示。
    if (phase === 'compacting') return t('tui.stream.phase.compacting', toolName);
    if (phase === 'streaming') return t('tui.stream.phase.streaming');
    return '';
  })();

  if (!active) return null;

  if (phase === 'compacting') {
    const percent = chunkPercent(compactingProgress);
    const { filled, empty } = renderProgressBar(percent);
    const chunkSuffix = compactingProgress?.chunkTotal
      ? ` · ${t('tui.stream.chunk', compactingProgress.chunkIndex ?? '?', compactingProgress.chunkTotal)}`
      : '';
    const tokenLabel = typeof compactingProgress?.oldTokens === 'number'
      ? ` · ${t('tui.stream.tokens_up', formatToken(compactingProgress.oldTokens))}`
      : '';
    const label = compactingProgress?.label || t('tui.stream.llm_summary', toolName);

    return (
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <Box>
          <Text color={tuiTheme.semantic.text.accent}>{t('tui.stream.compacting_conversation')}</Text>
          <Text color={tuiTheme.semantic.text.secondary}>
            {` (${formatElapsed(elapsed)} · ${label}${chunkSuffix}${tokenLabel})`}
          </Text>
        </Box>
        <Box marginLeft={2}>
          <Text color={tuiTheme.semantic.text.accent}>{filled}</Text>
          <Text color={tuiTheme.semantic.diff.context}>{empty}</Text>
          <Text color={tuiTheme.semantic.text.secondary}>{` ${percent}%`}</Text>
        </Box>
      </Box>
    );
  }

  const spinner = SPINNER_FRAMES[spinnerFrame];
  const isToolExecuting = phase === 'tool_executing' && toolName;
  const phrase = isToolExecuting ? t('tui.stream.phase.tool_executing', toolName) : (phrases[phraseIndex] ?? '');
  const parts: string[] = [];
  if (elapsed > 0) parts.push(`${elapsed}s`);
  if (phaseLabel) parts.push(phaseLabel);
  if (outputTokens > 0) parts.push(t('tui.stream.tokens_down', formatToken(outputTokens)));
  parts.push(t('tui.stream.esc_interrupt'));

  // partialJson 超过 80 字符截断
  const truncatedJson = partialJson && partialJson.length > 80
    ? `${partialJson.slice(0, 77)}…`
    : partialJson;

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Box>
        <Text color={tuiTheme.semantic.text.accent}>
          {`${spinner} ${isToolExecuting ? '⚙ ' : ''}${phrase}…`}
        </Text>
        <Text color={tuiTheme.semantic.text.secondary}>
          {` (${parts.join(' · ')})`}
        </Text>
      </Box>
      {truncatedJson && (
        <Box marginLeft={2}>
          <Text color={tuiTheme.semantic.text.secondary} wrap="truncate-end">
            {t('tui.stream.building_params', truncatedJson)}
          </Text>
        </Box>
      )}
    </Box>
  );
}
