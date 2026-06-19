/**
 * 首次运行引导横幅 —— 复用 TUI 的光场动画（呼吸 + 扫光）在 console 上演一段
 * 「青锋出鞘」开场：用块字「凌霄」做幕布，让一道高光横扫掠过字面——那道扫光
 * 就是被抽出的剑（来把剑）。静态字画动不了也不发光，比不过 TUI 动画，所以这里
 * 直接把 HomeScreen 用的同一套 LightField 搬到 console，用 ANSI 光标原地重绘成帧。
 *
 * 纯运行时层：用墙钟驱动帧时间 t，再交给 LightField 的纯函数采样——采样本身仍
 * 是确定性的 sin 哈希，不依赖随机。非 TTY / NO_COLOR / 窄屏自动降级为静态末帧。
 */
import { Chalk, type ChalkInstance } from 'chalk';
import { VERSION } from './version.js';
import { t } from './i18n.js';
import {
  GLYPH_VARIANTS,
  isLitCell,
  type GlyphVariant,
} from './tui/animation/glyph/lingxiaoGlyph.js';
import { composeWithSword } from './tui/animation/glyph/swordGlyph.js';
import {
  buildIdleState,
  sampleBrightness,
  shimmerForGlyph,
  type SweepConfig,
} from './tui/animation/LightField.js';
import { brightnessToColor, LINGXIAO_GOLD_PALETTE, type Palette } from './tui/animation/ColorGradient.js';

// 楷锋：文鼎楷体，撇捺出锋、剑气凌冽——最贴「来把剑」的笔意。
// 字面合成一柄左上贯穿到右下的斜剑，与字同处一张画布、由同一光场点亮。
const BLADE_GLYPH: GlyphVariant = composeWithSword(
  GLYPH_VARIANTS.find((g) => g.slug === 'kai') ?? GLYPH_VARIANTS[0],
);

// 流金：凌霄品牌固定金色调，扫光掠过时有金锋出鞘的质感。
const BLADE_PALETTE: Palette = LINGXIAO_GOLD_PALETTE;

// 开场扫光：相较 HomeScreen 的常驻慢扫，这里只扫一刀——延迟短、刀身窄、亮核近白，
// 一道横掠就是「出鞘」的那一下。interval 拉到极大，确保整场只走这一刀。
const BLADE_SWEEP: SweepConfig = {
  interval: 1_000_000,
  duration: 1300,
  band: 4.2,
  coreWidth: 1.3,
  amp: 1.9,
  startDelay: 260,
};

const PAD = '  ';
const FRAME_INTERVAL_MS = 55;
const TOTAL_MS = 1980;

const ESC = '\x1b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_EOL = `${ESC}K`;

function makeInk(color: boolean): ChalkInstance | null {
  // 强制 truecolor，避免 chalk 在管道/重定向下吞色；色彩开关交给调用方判定。
  return color ? new Chalk({ level: 3 }) : null;
}

/** 渲染单帧：逐 cell 采样光场亮度，整格按亮度取色。返回多行字符串（不含 PAD 外缩进）。 */
function renderGlyphFrame(
  time: number,
  glyph: GlyphVariant,
  palette: Palette,
  ink: ChalkInstance | null,
): string {
  const idle = buildIdleState(time, shimmerForGlyph(glyph));
  const lines: string[] = [];
  for (let r = 0; r < glyph.rows.length; r++) {
    const row = glyph.rows[r];
    let out = '';
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (!isLitCell(ch)) {
        out += ' ';
        continue;
      }
      if (!ink) {
        out += ch;
        continue;
      }
      const b = sampleBrightness(x, r * 2 + 0.5, time, idle, BLADE_SWEEP);
      out += ink.hex(brightnessToColor(b, palette))(ch);
    }
    lines.push(PAD + out);
  }
  return lines.join('\n');
}

/** 标题副行：题字 + 版本 + motto，颜色恒定（与字面光场同色系）。 */
function renderTitleBlock(palette: Palette, ink: ChalkInstance | null): string {
  const accent = (s: string) => (ink ? ink.hex(palette.accentHex).bold(s) : s);
  const dim = (s: string) => (ink ? ink.hex('#5a6b80')(s) : s);
  const tag = t('tui.welcome.tagline');
  const motto = t('tui.welcome.motto');
  return [
    '',
    PAD + accent(tag) + dim(`   v${VERSION}`),
    PAD + dim(motto) + dim('  ·  ') + dim('LingXiao multi-agent CLI'),
  ].join('\n');
}

/** 合成一整屏（字面 + 标题），行数恒定，便于原地重绘。 */
function composeFrame(
  time: number,
  glyph: GlyphVariant,
  palette: Palette,
  ink: ChalkInstance | null,
): string {
  return renderGlyphFrame(time, glyph, palette, ink) + '\n' + renderTitleBlock(palette, ink);
}

/** 把一屏写到 stdout：首帧直印，后续帧先光标上移再逐行清行重绘。 */
function makePainter(write: (s: string) => void) {
  let printed = 0;
  return (block: string) => {
    const rows = block.split('\n');
    let s = printed > 0 ? `${ESC}${printed}A` : '';
    for (let i = 0; i < rows.length; i++) {
      s += '\r' + CLEAR_EOL + rows[i];
      s += '\n';
    }
    write(s);
    printed = rows.length;
  };
}

export interface InitIntroOptions {
  width?: number;
  /** 注入式时钟，便于测试；默认 Date.now。 */
  now?: () => number;
  /** 注入式 stdout，便于测试。 */
  out?: (s: string) => void;
  /** 是否启用动画（默认依 TTY 判定）。 */
  animate?: boolean;
  /** 是否着色（默认依 TTY && !NO_COLOR 判定）。 */
  color?: boolean;
}

/**
 * 演一段「青锋出鞘」开场动画，然后把末帧留在屏上。
 * 非 TTY / 关动画时只印一帧静态末态。窄于字宽时退回纯标题（不画字面）。
 */
export async function playInitIntro(opts: InitIntroOptions = {}): Promise<void> {
  const width = opts.width ?? process.stdout.columns ?? 80;
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const color = opts.color ?? (Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null);
  const animate =
    opts.animate ?? (Boolean(process.stdout.isTTY) && process.env.LINGXIAO_NO_ANIM == null);
  const ink = makeInk(color);

  // 窄屏：字面会折行，破坏原地重绘——退回纯标题。
  if (width < BLADE_GLYPH.width + PAD.length + 1) {
    out('\n' + renderTitleBlock(BLADE_PALETTE, ink) + '\n');
    return;
  }

  // 静态降级：只印末帧（扫光已掠过、呼吸归位的一帧）。
  if (!animate) {
    out('\n' + composeFrame(TOTAL_MS, BLADE_GLYPH, BLADE_PALETTE, ink) + '\n');
    return;
  }

  const now = opts.now ?? (() => Date.now());
  const paint = makePainter(out);
  out('\n' + HIDE_CURSOR);
  const start = now();
  try {
    await new Promise<void>((resolve) => {
      const tick = () => {
        const time = now() - start;
        const clamped = time >= TOTAL_MS ? TOTAL_MS : time;
        paint(composeFrame(clamped, BLADE_GLYPH, BLADE_PALETTE, ink));
        if (time >= TOTAL_MS) {
          resolve();
          return;
        }
        setTimeout(tick, FRAME_INTERVAL_MS);
      };
      tick();
    });
  } finally {
    out(SHOW_CURSOR + '\n');
  }
}

// ── 引导步骤的小装饰行（保持轻量，与开场动画同色系）─────────────────────────

const NOTICE: readonly [number, number, number] = [150, 170, 205];
const STEP_ACCENT: readonly [number, number, number] = [156, 220, 254];
const STEP_INDEX: readonly [number, number, number] = [214, 170, 92];

function rgb(c: readonly [number, number, number]): (s: string) => string {
  const ink = new Chalk({ level: 3 });
  return (s: string) => ink.rgb(c[0], c[1], c[2])(s);
}

export function renderInitNotice(message: string): string {
  return rgb(NOTICE)('  ◈ ') + rgb([176, 196, 224])(message);
}

export function renderInitStep(index: number, total: number, title: string): string {
  const marker = rgb(STEP_ACCENT)('❯');
  const idx = rgb(STEP_INDEX)(`${index}`) + rgb(NOTICE)(`/${total}`);
  const head = rgb([156, 220, 254])(title);
  return `\n  ${marker} ${idx}  ${head}`;
}
