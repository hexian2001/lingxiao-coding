/**
 * iconography.ts — 凌霄「方寸」图标语言（单一事实源）
 *
 * 国风统一笔意，集中所有字形常量。下游禁止再散落 icon 字面量。
 *
 * 设计纪律（用户已批准「混合·朱砂方寸」方向）：
 * - 状态 = 宽1 朱砂几何符（U+25A0–25FF，覆盖广、密集安全、冷静）
 * - 角色 / 阶段 / 黑板图节点 = 单字汉字（双倍宽 = 国风点睛；app 已假设 CJK 字体）
 * - 优先级 = 钻石族按重量递减（宽1）
 * - spinner = 弧线四帧（替代西式盲文点）
 * - 进度 = 朱砂填 ▰ / 暖墨轨 ▱
 * - 朱砂印 = 静态签名（不做闪烁，保「不干扰」）
 *
 * 取色仍在各使用点经 tuiTheme.semantic.* 完成（保留既有 per-bucket 配色细节）；
 * 本文件只提供「形」。颜色仅朱砂印的印章底/前景在此固定（签名专用色）。
 */
import { Chalk } from 'chalk';

// ── 状态符（宽1）── 与 NormalizedRunStatus / NormalizedAgentStatus / TaskDisplayState 对齐 ──
export const STATUS_ICON = {
  pending: '○',
  idle: '○',
  running: '◐',
  in_progress: '◐',
  completed: '◉',
  done: '◉',
  failed: '✕',
  blocked: '◇',
  cancelled: '◌',
  interrupted: '◓',
  paused: '◓',
  waiting: '◔',
} as const;

// ── 角色单字（国风点睛）── key 对齐 tuiTheme.semantic.role 与 roleVisuals ──
export const ROLE_HANZI: Record<string, string> = {
  research: '研',
  coding: '码',
  review: '审',
  verify: '验',
  frontend: '屏',
  backend: '枢',
  qa: '测',
  ux_designer: '韵',
  planning: '谋',
  testing: '试',
  architect: '构',
};
/** 默认角色字（未命中时）。士 = 执事之才，中性典雅。 */
export const DEFAULT_ROLE_HANZI = '士';

/** 取角色字，未命中回退默认。 */
export function roleHanzi(role?: string): string {
  if (role && ROLE_HANZI[role]) return ROLE_HANZI[role];
  return DEFAULT_ROLE_HANZI;
}

// ── 阶段单字（WorkNotes phase）──
export const PHASE_HANZI: Record<string, string> = {
  research: '研',
  coding: '码',
  testing: '试',
  reviewing: '审',
  planning: '谋',
};
export const DEFAULT_PHASE_HANZI = '他';

/** 取阶段字，未命中回退默认。 */
export function phaseHanzi(phase?: string): string {
  if (phase && PHASE_HANZI[phase]) return PHASE_HANZI[phase];
  return DEFAULT_PHASE_HANZI;
}

// ── 优先级钻石族（宽1，按重量递减）──
export const PRIORITY_ICON = {
  critical: '◆',
  important: '◈',
  normal: '◇',
} as const;

// ── 黑板图节点单字 ──
export const GRAPH_NODE_HANZI = {
  origin: '源',
  goal: '归',
  fact: '据',
  intent: '意',
  hint: '示',
} as const;

// ── Spinner：弧线四帧，冷静（替代盲文点 ⠋⠙⠹…）──
export const INK_SPINNER_FRAMES = ['◜', '◝', '◞', '◟'] as const;
/** 帧间隔 140ms（原盲文 80ms 更从容，减闪烁）。 */
export const INK_SPINNER_INTERVAL_MS = 140;

// ── 进度条：墨笔重 / 暖墨轻（宽1）── 统一替代 █/.、#/.、█/░ 三套。
// 用重横 ━ 表「已落墨」、轻横 ─ 表「空轨」，与全站 ─ 分隔线同语言，最国风。──
export const PROGRESS_FILLED = '━';
export const PROGRESS_EMPTY = '─';

// ── 朱砂印签名 ──
// 朱砂底 + 暖金单字，静态（不做闪烁动画，保「不干扰」）。
// 印章专属色在此固定：朱砂与 error 同源、暖金与 accentAlt 同源。
export const SEAL_BG = '#c95a4a'; // 朱砂
export const SEAL_FG = '#f3e3b0'; // 暖金（accentAlt）

/** 印章字符预设（英雄时刻）。 */
export const SEAL_CHAR = {
  ling: '凌', // 开场
  done: '成', // 完成
  farewell: '别', // 告别
} as const;

/**
 * 渲染朱砂印为 ANSI 字符串（非 Ink 上下文，如 farewellBanner 原始串拼接）。
 * 形如「 凌 」三格朱砂底暖金字。useColor=false 时退回纯字符。
 */
export function renderSealString(char: string, useColor = true): string {
  const stamp = ` ${char} `;
  if (!useColor) return stamp;
  // 强制 truecolor，避免管道/重定向下被 chalk 环境探测吞色。
  const ink = new Chalk({ level: 3 });
  return ink.bgHex(SEAL_BG).hex(SEAL_FG)(stamp);
}
