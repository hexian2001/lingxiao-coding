/**
 * Animation module — 凌霄块字 logo 的多层光场动画（呼吸环 + 扫光）。
 */
export {
  LINGXIAO_GLYPH,
  GLYPH_WIDTH,
  GLYPH_HEIGHT,
  GLYPH_CENTER,
  GLYPH_VARIANTS,
  DEFAULT_GLYPH,
  pickGlyph,
  isLitCell,
  topOn,
  bottomOn,
  type GlyphVariant,
} from './glyph/lingxiaoGlyph.js';
export {
  SWORD_GLYPH,
  composeWithSword,
  type ComposeSwordOptions,
} from './glyph/swordGlyph.js';
export {
  clamp01,
  ease,
  noise,
  buildIdleState,
  sampleIdle,
  sampleSweep,
  sampleBrightness,
  shimmerForGlyph,
  DEFAULT_SHIMMER,
  DEFAULT_SWEEP,
  type ShimmerConfig,
  type SweepConfig,
} from './LightField.js';
export {
  brightnessToColor,
  pickPalette,
  PALETTES,
  DEFAULT_PALETTE,
  LINGXIAO_GOLD_PALETTE,
  QI_BASE,
  QI_ACCENT,
  QI_PEAK,
  QI_INACTIVE,
  type Palette,
} from './ColorGradient.js';
export { useAnimation, FRAME_INTERVAL_MS, type UseAnimationResult } from './useAnimation.js';
