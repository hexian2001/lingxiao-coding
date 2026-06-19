/**
 * ColorGradient — 把光场亮度映射成颜色。
 *
 * 移植自 mimo 的 tint/shade：低亮度停在暗底色，中亮度向 accent 主色推进，
 * 高亮度向近白 peak 收敛——这就是"流光掠过时字会发亮"的观感来源。
 *
 * 支持多套命名调色板（剑域配色）；凌霄品牌字形统一使用固定金色调。
 */

interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 一套三段渐变配色：base（暗底）→ accent（呼吸主色）→ peak（亮核高光） */
export interface Palette {
  /** 中文调名 */
  name: string;
  base: RGB;
  accent: RGB;
  peak: RGB;
  /** 非点亮单元背景色（极暗，几乎隐入面板） */
  inactive: string;
  /** 副标题/强调用的 accent hex（供 HomeScreen 标题取色） */
  accentHex: string;
}

/** 剑域配色表 — 每套一种意境 */
export const PALETTES: readonly Palette[] = [
  {
    name: '青锋紫',
    base: { r: 0x3a, g: 0x2a, b: 0x3a },
    accent: { r: 0xc5, g: 0x86, b: 0xc0 },
    peak: { r: 0xff, g: 0xf2, b: 0xff },
    inactive: '#2a1f2a',
    accentHex: '#c586c0',
  },
  {
    name: '赤霄',
    base: { r: 0x3a, g: 0x20, b: 0x1c },
    accent: { r: 0xe0, g: 0x6c, b: 0x55 },
    peak: { r: 0xff, g: 0xf0, b: 0xe6 },
    inactive: '#2a1715',
    accentHex: '#e06c55',
  },
  {
    name: '玄冰',
    base: { r: 0x1c, g: 0x2e, b: 0x3a },
    accent: { r: 0x5c, g: 0xbd, b: 0xe0 },
    peak: { r: 0xe8, g: 0xf8, b: 0xff },
    inactive: '#152230',
    accentHex: '#5cbde0',
  },
  {
    name: '流金',
    base: { r: 0x68, g: 0x4a, b: 0x24 },
    accent: { r: 0xf2, g: 0xc6, b: 0x73 },
    peak: { r: 0xff, g: 0xf8, b: 0xe0 },
    inactive: '#2f2a1c',
    accentHex: '#f2c673',
  },
  {
    name: '墨竹',
    base: { r: 0x1e, g: 0x32, b: 0x28 },
    accent: { r: 0x5c, g: 0xc9, b: 0x8c },
    peak: { r: 0xe8, g: 0xff, b: 0xf0 },
    inactive: '#152620',
    accentHex: '#5cc98c',
  },
  {
    name: '霜天青',
    base: { r: 0x20, g: 0x30, b: 0x3a },
    accent: { r: 0x9c, g: 0xdc, b: 0xfe },
    peak: { r: 0xf0, g: 0xfa, b: 0xff },
    inactive: '#18242e',
    accentHex: '#9cdcfe',
  },
  {
    name: '胭脂',
    base: { r: 0x3a, g: 0x1e, b: 0x2c },
    accent: { r: 0xe8, g: 0x6a, b: 0x9c },
    peak: { r: 0xff, g: 0xec, b: 0xf4 },
    inactive: '#2a1620',
    accentHex: '#e86a9c',
  },
];

/** 凌霄品牌固定金色调。 */
export const LINGXIAO_GOLD_PALETTE: Palette =
  PALETTES.find((p) => p.name === '流金') ?? PALETTES[0];

/** 默认调色板使用凌霄固定金色，向后兼容未显式传 palette 的调用方。 */
export const DEFAULT_PALETTE: Palette = LINGXIAO_GOLD_PALETTE;

/** 旧常量别名，保持向后兼容 */
export const QI_BASE = DEFAULT_PALETTE.base;
export const QI_ACCENT = DEFAULT_PALETTE.accent;
export const QI_PEAK = DEFAULT_PALETTE.peak;
export const QI_INACTIVE = DEFAULT_PALETTE.inactive;

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    r: lerpChannel(a.r, b.r, k),
    g: lerpChannel(a.g, b.g, k),
    b: lerpChannel(a.b, b.b, k),
  };
}

function toHex(c: RGB): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * 亮度 → 颜色（指定调色板）。
 * 0..1 段：base → accent。1..2 段：accent → peak。>2 截顶在 peak。
 * 这样常态呼吸在主色区间流动，只有亮核/扫光才打到近白。
 */
export function brightnessToColor(n: number, palette: Palette = DEFAULT_PALETTE): string {
  if (n <= 0) return toHex(palette.base);
  if (n <= 1) return toHex(mix(palette.base, palette.accent, n));
  return toHex(mix(palette.accent, palette.peak, n - 1));
}

/**
 * 随机选一套调色板。
 * 入参 seed 为 [0,1) 的随机数（由调用方注入，便于测试与确定性控制）；
 * 不传时退回默认调色板（保持确定性，不在此处调用 Math.random）。
 */
export function pickPalette(seed: number): Palette {
  const i = Math.floor(seed * PALETTES.length) % PALETTES.length;
  return PALETTES[i < 0 ? 0 : i];
}
