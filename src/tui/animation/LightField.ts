/**
 * LightField — 多层光场，移植自 mimo logo.tsx 的 idle 呼吸环 + sweep 扫光。
 *
 * 设计目标：把"整块 logo 在呼吸发光 + 周期扫光掠过"的视觉，提炼成一组
 * 纯函数。输入归一化时间与子像素坐标，输出 0..1+ 的亮度强度，由渲染层
 * 把强度映射成 dim→accent→white 的颜色。
 *
 * 确定性铁律：噪声用 sin 哈希（与 mimo 同构），不使用 Math.random / Date.now，
 * 同一 (x, y, t) 永远得到同一结果——便于快照与单测。
 */

import { GLYPH_CENTER, GLYPH_WIDTH, GLYPH_HEIGHT, type GlyphVariant } from './glyph/lingxiaoGlyph.js';

/** clamp 到 [0,1] */
export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** smoothstep 缓动 */
export function ease(t: number): number {
  const p = clamp01(t);
  return p * p * (3 - 2 * p);
}

/**
 * 确定性噪声 — sin 哈希取小数部分，落在 [0,1)。
 * 与 mimo 的 noise() 同构：稳定、无状态、可复现。
 */
export function noise(x: number, y: number, t: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + t * 0.043) * 43758.5453;
  return n - Math.floor(n);
}

/** idle 呼吸环配置（节选自 mimo shimmerConfig，按 Ink/单字 logo 调参） */
export interface ShimmerConfig {
  /** 一次呼吸的周期（ms） */
  period: number;
  /** 同时存在的环数（相位错开，形成连绵呼吸） */
  rings: number;
  /** 亮核高斯宽度 */
  coreWidth: number;
  /** 亮核幅度 */
  coreAmp: number;
  /** 柔光高斯宽度 */
  softWidth: number;
  /** 柔光幅度 */
  softAmp: number;
  /** 尾迹长度 */
  tail: number;
  /** 尾迹幅度 */
  tailAmp: number;
  /** 常亮底光（保证字在波谷也可见） */
  breathBase: number;
  /** 噪声扰动幅度（让边缘呼吸不死板） */
  noise: number;
  /** 环心 x（子像素坐标） */
  originX: number;
  /** 环心 y（子像素坐标） */
  originY: number;
  /** 字形宽（cells），决定环要扩多远覆盖全字 */
  glyphWidth: number;
  /** 字形高（cells），同上 */
  glyphHeight: number;
}

export const DEFAULT_SHIMMER: ShimmerConfig = {
  period: 7200,
  rings: 2,
  coreWidth: 1.6,
  coreAmp: 1.4,
  softWidth: 11,
  softAmp: 1.3,
  tail: 6,
  tailAmp: 0.55,
  breathBase: 0.22,
  noise: 0.05,
  originX: GLYPH_CENTER.x,
  originY: GLYPH_CENTER.y,
  glyphWidth: GLYPH_WIDTH,
  glyphHeight: GLYPH_HEIGHT,
};

/**
 * 为指定字形变体派生一套 shimmer 配置——光场几何（环心、覆盖范围）随字体走，
 * 其余呼吸参数沿用 base（默认 DEFAULT_SHIMMER）。换字体时光不会偏出字外。
 */
export function shimmerForGlyph(
  glyph: GlyphVariant,
  base: ShimmerConfig = DEFAULT_SHIMMER,
): ShimmerConfig {
  return {
    ...base,
    originX: glyph.center.x,
    originY: glyph.center.y,
    glyphWidth: glyph.width,
    glyphHeight: glyph.height,
  };
}

/** 单帧 idle 状态：若干个错相扩散的环 */
interface IdleRing {
  /** 当前扩散半径 */
  head: number;
  /** 包络强度（正弦呼吸，0→1→0） */
  eased: number;
}

interface IdleState {
  cfg: ShimmerConfig;
  reach: number;
  rings: number;
  active: IdleRing[];
}

/** 由 logo 四角到环心的最大距离，决定环要扩多远才覆盖全字 */
function computeReach(cfg: ShimmerConfig): number {
  const w = cfg.glyphWidth;
  const h = cfg.glyphHeight * 2;
  const corners: Array<[number, number]> = [
    [0, 0], [w, 0], [0, h], [w, h],
  ];
  let max = 0;
  for (const [cx, cy] of corners) {
    const d = Math.hypot(cx - cfg.originX, cy - cfg.originY);
    if (d > max) max = d;
  }
  return max + cfg.tail * 2;
}

/** 构建当前时刻的 idle 环集合（相位错开） */
export function buildIdleState(t: number, cfg: ShimmerConfig = DEFAULT_SHIMMER): IdleState {
  const reach = computeReach(cfg);
  const rings = Math.max(1, Math.floor(cfg.rings));
  const active: IdleRing[] = [];
  for (let i = 0; i < rings; i++) {
    const offset = i / rings;
    const phase = (t / cfg.period + offset) % 1;
    const envelope = Math.sin(phase * Math.PI);
    const eased = envelope * envelope * (3 - 2 * envelope);
    active.push({ head: phase * reach, eased });
  }
  return { cfg, reach, rings, active };
}

/**
 * 采样 idle 呼吸光强 — 在 (x, pixelY) 处叠加所有环的贡献。
 * 返回 0..N 的强度（未 clamp，渲染层再压）。
 */
export function sampleIdle(
  x: number,
  pixelY: number,
  state: IdleState,
): number {
  const cfg = state.cfg;
  const dx = x + 0.5 - cfg.originX;
  const dy = pixelY - cfg.originY;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  // 多频扰动，让波前不是完美圆
  const wob = (noise(x * 0.3, pixelY * 0.25, state.active[0]?.head ?? 0) - 0.5) * 0.55
    + Math.sin(angle * 3) * 0.3 * 0.18;
  const traveled = dist + wob * cfg.noise;

  let glow = 0;
  let peak = 0;
  for (const ring of state.active) {
    const delta = traveled - ring.head;
    const core = Math.exp(-(Math.abs(delta / cfg.coreWidth) ** 1.8));
    const soft = Math.exp(-(Math.abs(delta / cfg.softWidth) ** 1.6));
    const tailRange = cfg.tail * 2.6;
    const tail = delta < 0 && delta > -tailRange
      ? (1 + delta / tailRange) ** 2.6
      : 0;
    glow += (soft * cfg.softAmp + tail * cfg.tailAmp) * ring.eased;
    peak += core * cfg.coreAmp * ring.eased;
  }
  return cfg.breathBase + (glow + peak) / state.rings;
}

/** sweep 扫光配置 */
export interface SweepConfig {
  /** 两次扫光的间隔（ms） */
  interval: number;
  /** 单次扫光持续（ms） */
  duration: number;
  /** 扫光带宽（柔边高斯宽度） */
  band: number;
  /** 扫光亮核宽度 */
  coreWidth: number;
  /** 扫光幅度 */
  amp: number;
  /** 首次扫光前的延迟（ms） */
  startDelay: number;
}

export const DEFAULT_SWEEP: SweepConfig = {
  interval: 12000,
  duration: 2600,
  band: 5.5,
  coreWidth: 1.8,
  amp: 1.4,
  startDelay: 1500,
};

/**
 * 采样 sweep 扫光光强 — 一条从左掠到右的高光带。
 * t 为单调时钟（ms）。返回 0..amp 的强度。
 */
export function sampleSweep(
  x: number,
  pixelY: number,
  t: number,
  cfg: SweepConfig = DEFAULT_SWEEP,
  glyphWidth: number = GLYPH_WIDTH,
): number {
  if (t < cfg.startDelay) return 0;
  const since = t - cfg.startDelay;
  const phase = since % cfg.interval;
  if (phase > cfg.duration) return 0;
  const p = phase / cfg.duration;
  const width = glyphWidth;
  // 头部从 -3 扫到 width+3
  const head = -3 + (width + 6) * ease(p);
  const dx = x + 0.5 - head;
  const band = Math.exp(-((dx / cfg.band) ** 2));
  const core = Math.exp(-((dx / cfg.coreWidth) ** 2)) * 1.7;
  const env = Math.sin(p * Math.PI); // 进出场淡入淡出
  const wobble = 1 + 0.08 * Math.sin(pixelY * 0.9 + p * 6);
  return (band * 0.7 + core) * env * cfg.amp * wobble;
}

/**
 * 综合亮度 — idle 呼吸 + sweep 扫光叠加。
 * 这是渲染层每个子像素调用的主入口。
 */
export function sampleBrightness(
  x: number,
  pixelY: number,
  t: number,
  idle: IdleState,
  sweepCfg: SweepConfig = DEFAULT_SWEEP,
): number {
  return sampleIdle(x, pixelY, idle) + sampleSweep(x, pixelY, t, sweepCfg, idle.cfg.glyphWidth);
}
