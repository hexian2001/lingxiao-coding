/**
 * swordGlyph — 「凌霄」块字上的斜贯青锋。
 *
 * 设计目标：剑不再作为独立小图贴在右侧，而是在同一张 half-block 画布上
 * 从左上角贯穿到右下角。剑轨会先切开字面，再覆盖剑身、锋尖与护手；
 * HomeScreen / 退出横幅 / 首次引导仍走同一套 LightField，整把剑一起发光。
 *
 * 确定性：纯几何 + 纯函数合成，不读时钟、不随机。
 */

import type { GlyphVariant } from './lingxiaoGlyph.js';
import { isLitCell, topOn, bottomOn } from './lingxiaoGlyph.js';

const FULL = '\u2588';
const UPPER = '\u2580';
const LOWER = '\u2584';
const EMPTY = ' ';

type PixelGrid = boolean[][];

export interface ComposeSwordOptions {
  /** 画布左右额外留白，避免剑尖贴边；默认 4。 */
  paddingX?: number;
  /** 画布上下额外留白；默认 0，保持与原字形同高。 */
  paddingY?: number;
  /** 剑身半宽（子像素），默认 1.35。 */
  bladeRadius?: number;
  /** 切开字面的留白半宽（子像素），默认 2.15。 */
  cutRadius?: number;
  /** 是否绘制护手，默认 true。 */
  guard?: boolean;
}

function makeGrid(width: number, height: number): PixelGrid {
  return Array.from({ length: height }, () => Array<boolean>(width).fill(false));
}

function rowsToPixels(rows: readonly string[]): PixelGrid {
  const width = rows[0]?.length ?? 0;
  const grid = makeGrid(width, rows.length * 2);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (!isLitCell(ch)) continue;
      if (topOn(ch)) grid[r * 2][c] = true;
      if (bottomOn(ch)) grid[r * 2 + 1][c] = true;
    }
  }
  return grid;
}

function pixelsToRows(grid: PixelGrid): string[] {
  const rows: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    let row = '';
    for (let x = 0; x < grid[y].length; x++) {
      const top = grid[y][x];
      const bottom = grid[y + 1]?.[x] ?? false;
      row += top && bottom ? FULL : top ? UPPER : bottom ? LOWER : EMPTY;
    }
    rows.push(row);
  }
  return rows;
}

function centroid(rows: readonly string[]): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (!isLitCell(ch)) continue;
      if (topOn(ch)) {
        sx += c + 0.5;
        sy += r * 2;
        n++;
      }
      if (bottomOn(ch)) {
        sx += c + 0.5;
        sy += r * 2 + 1;
        n++;
      }
    }
  }
  if (n === 0) return { x: rows[0]?.length / 2 || 0, y: rows.length };
  return { x: sx / n, y: sy / n };
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; along: number } {
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq === 0) return { distance: Math.hypot(px - ax, py - ay), along: 0 };
  const raw = ((px - ax) * vx + (py - ay) * vy) / lenSq;
  const along = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const qx = ax + vx * along;
  const qy = ay + vy * along;
  return { distance: Math.hypot(px - qx, py - qy), along };
}

function withinDiamond(px: number, py: number, cx: number, cy: number, rx: number, ry: number): boolean {
  return Math.abs(px - cx) / rx + Math.abs(py - cy) / ry <= 1;
}

function drawDiagonalSword(grid: PixelGrid, opts: Required<ComposeSwordOptions>): void {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  if (width === 0 || height === 0) return;

  const ax = 0.4;
  const ay = 0.2;
  const bx = width - 1.4;
  const by = height - 1.2;
  const vx = bx - ax;
  const vy = by - ay;
  const len = Math.hypot(vx, vy) || 1;
  const nx = -vy / len;
  const ny = vx / len;

  const guardT = 0.58;
  const guardCx = ax + vx * guardT;
  const guardCy = ay + vy * guardT;
  const guardHalfLength = Math.max(5, Math.min(10, Math.round(width * 0.105)));
  const guardHalfWidth = 1.6;
  const pommelT = 0.74;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const hit = distanceToSegment(px, py, ax, ay, bx, by);

      if (hit.distance <= opts.cutRadius) {
        grid[y][x] = false;
      }

      const tipWidth = hit.along < 0.1 ? Math.max(0.15, hit.along / 0.1) : 1;
      const tailFade = hit.along > 0.95 ? Math.max(0.25, (1 - hit.along) / 0.05) : 1;
      const bladeWidth = opts.bladeRadius * Math.min(tipWidth, tailFade);
      const isBlade = hit.distance <= bladeWidth;
      const isRidge = hit.distance <= 0.48 && hit.along > 0.08 && hit.along < 0.94;
      if (isBlade || isRidge) {
        grid[y][x] = true;
      }

      if (opts.guard) {
        const guardDx = (px - guardCx) * nx + (py - guardCy) * ny;
        const guardDy = (px - guardCx) * (vx / len) + (py - guardCy) * (vy / len);
        if (Math.abs(guardDx) <= guardHalfLength && Math.abs(guardDy) <= guardHalfWidth) {
          grid[y][x] = true;
        }
      }

      const pommelCx = ax + vx * pommelT;
      const pommelCy = ay + vy * pommelT;
      if (withinDiamond(px, py, pommelCx, pommelCy, 3.4, 2.4)) {
        grid[y][x] = true;
      }
    }
  }
}

/**
 * 独立「剑」字形保留给调试/外部使用。主视觉不再拼接它，而由 composeWithSword()
 * 按目标字形动态生成斜贯剑。
 */
export const SWORD_GLYPH: GlyphVariant = {
  slug: 'sword-diagonal',
  name: '斜贯青锋',
  desc: '从左上贯穿到右下的青锋轨迹',
  rows: [
    '▄        ',
    ' █▄      ',
    '  ██▄    ',
    '   ██▄   ',
    '    ███  ',
    '  ▄█████▄',
    '     ███ ',
    '      ██▄',
    '       ██',
  ],
  width: 9,
  height: 9,
  center: { x: 4.95, y: 9.7 },
};

/**
 * 在「凌霄」同一画布里生成左上 → 右下的斜贯剑。
 */
export function composeWithSword(
  glyph: GlyphVariant,
  opts: ComposeSwordOptions = {},
): GlyphVariant {
  const options: Required<ComposeSwordOptions> = {
    paddingX: opts.paddingX ?? 4,
    paddingY: opts.paddingY ?? 0,
    bladeRadius: opts.bladeRadius ?? 1.35,
    cutRadius: opts.cutRadius ?? 2.15,
    guard: opts.guard ?? true,
  };

  const glyphPixels = rowsToPixels(glyph.rows);
  const width = glyph.width + options.paddingX * 2;
  const heightPixels = glyph.height * 2 + options.paddingY * 2;
  const canvas = makeGrid(width, heightPixels);

  for (let y = 0; y < glyphPixels.length; y++) {
    for (let x = 0; x < glyph.width; x++) {
      if (glyphPixels[y][x]) {
        canvas[y + options.paddingY][x + options.paddingX] = true;
      }
    }
  }

  drawDiagonalSword(canvas, options);

  const rows = pixelsToRows(canvas);

  return {
    slug: `${glyph.slug}+diagonal-sword`,
    name: `${glyph.name}·斜贯青锋`,
    desc: `${glyph.name} 与左上至右下贯穿剑合成画布，同一光场点亮`,
    rows,
    width: rows[0]?.length ?? 0,
    height: rows.length,
    center: centroid(rows),
  };
}
