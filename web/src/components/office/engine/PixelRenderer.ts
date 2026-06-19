/**
 * PixelRenderer — Canvas 2D 像素艺术背景纹理生成器
 * 每个 16×16 tile 用像素级图案绘制，整体预渲染为单张纹理
 * 高质感像素艺术：砖纹墙壁、棋盘格地板、菱形地毯、木纹门、灵脉走廊
 */
import { Texture, Sprite } from 'pixi.js';
import { OFFICE_LAYOUT, TileType, type OfficeArea } from '../assets/officeLayout';
import { OFFICE_THEMES, type OfficeThemeColors } from '../assets/themeColors';

export const TILE = 16;

export function generatePixelBackground(theme: 'dark' | 'light'): Sprite {
  const c = OFFICE_THEMES[theme];
  const { width, height, tiles, areas } = OFFICE_LAYOUT;
  const canvasW = width * TILE;
  const canvasH = height * TILE;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // 整体底色
  ctx.fillStyle = hex(c.background);
  ctx.fillRect(0, 0, canvasW, canvasH);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = tiles[y][x];
      const px = x * TILE;
      const py = y * TILE;
      const area = getAreaAt(areas, x, y);

      switch (tile) {
        case TileType.WALL:
          drawPixelWall(ctx, px, py, x, y, c, area);
          break;
        case TileType.FLOOR:
          drawPixelFloor(ctx, px, py, x, y, c, area);
          break;
        case TileType.CARPET:
          drawPixelCarpet(ctx, px, py, x, y, c, area);
          break;
        case TileType.DOOR:
          drawPixelDoor(ctx, px, py, x, y, c);
          break;
      }
    }
  }

  // 区域边框辉光（4层外辉光 + 内边框 + 四角灵光）
  drawAreaBorders(ctx, areas, c);

  // 走廊灵脉线
  drawCorridorSpiritVeins(ctx, c);

  const texture = Texture.from({ resource: canvas, scaleMode: 'nearest' });
  const sprite = new Sprite(texture);
  return sprite;
}

function getAreaAt(areas: OfficeArea[], x: number, y: number): OfficeArea | undefined {
  return areas.find(a => x >= a.bounds.x && x < a.bounds.x + a.bounds.w && y >= a.bounds.y && y < a.bounds.y + a.bounds.h);
}

// === 像素墙壁：双边框 + 砖块纹理 + 明暗面光照 ===
function drawPixelWall(ctx: CanvasRenderingContext2D, px: number, py: number, tx: number, ty: number, c: OfficeThemeColors, area?: OfficeArea): void {
  // 底色
  ctx.fillStyle = hex(c.wall);
  ctx.fillRect(px, py, TILE, TILE);

  // 砖块纹理 — 交错砖缝
  const brickRow = ty % 4;
  const offset = (brickRow < 2) ? 0 : 8;

  // 水平砖缝（每4像素一条）
  ctx.fillStyle = rgba(c.wallShadow, 0.6);
  ctx.fillRect(px, py + 7, TILE, 1);
  ctx.fillRect(px, py + 15, TILE, 1);

  // 垂直砖缝（交错排列）
  const vx1 = (tx * TILE + offset) % TILE;
  ctx.fillStyle = rgba(c.wallShadow, 0.5);
  ctx.fillRect(px + vx1, py, 1, 8);
  ctx.fillRect(px + ((vx1 + 8) % TILE), py + 8, 1, 8);

  // 左上高光面（模拟光照）
  ctx.fillStyle = rgba(c.wallHighlight, 0.25);
  ctx.fillRect(px, py, TILE, 1);
  ctx.fillRect(px, py, 1, TILE);

  // 右下阴影面
  ctx.fillStyle = rgba(c.wallShadow, 0.35);
  ctx.fillRect(px + TILE - 1, py, 1, TILE);
  ctx.fillRect(px, py + TILE - 1, TILE, 1);

  // 砖面微纹理（随机明暗像素点）
  const seed = tx * 31 + ty * 17;
  if (seed % 7 === 0) {
    ctx.fillStyle = rgba(c.wallHighlight, 0.12);
    ctx.fillRect(px + (seed % 12) + 2, py + ((seed * 3) % 12) + 2, 2, 2);
  }
  if (seed % 11 === 0) {
    ctx.fillStyle = rgba(c.wallShadow, 0.15);
    ctx.fillRect(px + ((seed * 5) % 10) + 3, py + ((seed * 7) % 10) + 3, 2, 1);
  }

  // 区域色调染色
  if (area) {
    const areaColor = getAreaBaseColor(c, area);
    ctx.fillStyle = rgba(areaColor, 0.08);
    ctx.fillRect(px, py, TILE, TILE);
  }
}

// === 像素地板：棋盘格微纹理 + 区域色底 + 砖缝 ===
function drawPixelFloor(ctx: CanvasRenderingContext2D, px: number, py: number, tx: number, ty: number, c: OfficeThemeColors, area: OfficeArea | undefined): void {
  const baseColor = getFloorColor(c, area);
  ctx.fillStyle = hex(baseColor);
  ctx.fillRect(px, py, TILE, TILE);

  // 棋盘格微纹理（每 2×2 像素交替明暗）
  for (let dy = 0; dy < TILE; dy += 2) {
    for (let dx = 0; dx < TILE; dx += 2) {
      if ((dx + dy) % 4 === 0) {
        ctx.fillStyle = rgba(c.floorGrid, 0.2);
        ctx.fillRect(px + dx, py + dy, 2, 2);
      }
    }
  }

  // 砖缝线（每 tile 边缘）
  ctx.fillStyle = rgba(c.floorGrid, 0.4);
  ctx.fillRect(px, py, 1, TILE);
  ctx.fillRect(px, py, TILE, 1);

  // 交叉砖缝（中间位置，模拟大砖块）
  if (tx % 2 === 0) {
    ctx.fillStyle = rgba(c.floorGrid, 0.2);
    ctx.fillRect(px + 8, py, 1, TILE);
  }
  if (ty % 2 === 0) {
    ctx.fillStyle = rgba(c.floorGrid, 0.2);
    ctx.fillRect(px, py + 8, TILE, 1);
  }

  // 随机纹理点（增加手绘感）
  const seed = tx * 37 + ty * 13;
  if (seed % 5 === 0) {
    ctx.fillStyle = rgba(c.floorDither, 0.25);
    ctx.fillRect(px + (seed % 13) + 1, py + ((seed * 3) % 13) + 1, 1, 1);
  }
  if (seed % 9 === 0) {
    ctx.fillStyle = rgba(c.floorGrid, 0.15);
    ctx.fillRect(px + ((seed * 7) % 12) + 2, py + ((seed * 11) % 12) + 2, 2, 1);
  }

  // 区域辉光微点缀（灵气散点）
  if (area && (tx + ty) % 6 === 0) {
    const glow = getGlowColor(c, area);
    ctx.fillStyle = rgba(glow, 0.08);
    ctx.fillRect(px + 6, py + 6, 3, 3);
    ctx.fillStyle = rgba(glow, 0.15);
    ctx.fillRect(px + 7, py + 7, 1, 1);
  }
}

// === 像素地毯：菱形图案 + 边框装饰 + 区域辉光 ===
function drawPixelCarpet(ctx: CanvasRenderingContext2D, px: number, py: number, tx: number, ty: number, c: OfficeThemeColors, area: OfficeArea | undefined): void {
  const baseColor = area ? getAreaBaseColor(c, area) : c.carpet;
  ctx.fillStyle = hex(baseColor);
  ctx.fillRect(px, py, TILE, TILE);

  // 地毯底纹（比地板更柔和的格子）
  for (let dy = 0; dy < TILE; dy += 2) {
    for (let dx = 0; dx < TILE; dx += 2) {
      if ((dx + dy) % 4 === 2) {
        ctx.fillStyle = rgba(c.carpetGrid, 0.15);
        ctx.fillRect(px + dx, py + dy, 2, 2);
      }
    }
  }

  // 菱形图案（每 3 tile 一个）
  if ((tx + ty) % 3 === 0) {
    const glow = getGlowColor(c, area);
    // 菱形外框
    ctx.fillStyle = rgba(glow, 0.12);
    ctx.fillRect(px + 7, py + 2, 2, 1);  // 上
    ctx.fillRect(px + 7, py + 13, 2, 1); // 下
    ctx.fillRect(px + 2, py + 7, 1, 2);  // 左
    ctx.fillRect(px + 13, py + 7, 1, 2); // 右
    // 菱形对角线
    ctx.fillRect(px + 5, py + 4, 1, 1);
    ctx.fillRect(px + 4, py + 5, 1, 1);
    ctx.fillRect(px + 10, py + 4, 1, 1);
    ctx.fillRect(px + 11, py + 5, 1, 1);
    ctx.fillRect(px + 5, py + 11, 1, 1);
    ctx.fillRect(px + 4, py + 10, 1, 1);
    ctx.fillRect(px + 10, py + 11, 1, 1);
    ctx.fillRect(px + 11, py + 10, 1, 1);
    // 菱形中心辉光
    ctx.fillStyle = rgba(glow, 0.2);
    ctx.fillRect(px + 7, py + 7, 2, 2);
  }

  // 地毯边框装饰（tile 边缘）
  ctx.fillStyle = rgba(c.carpetGrid, 0.3);
  ctx.fillRect(px, py, TILE, 1);
  ctx.fillRect(px, py, 1, TILE);

  // 区域辉光微点缀
  if (area && (tx * 3 + ty * 7) % 8 === 0) {
    const glow = getGlowColor(c, area);
    ctx.fillStyle = rgba(glow, 0.06);
    ctx.fillRect(px + 3, py + 3, 4, 4);
  }
}

// === 像素门：木纹纹理 + 金色把手 + 高光 ===
function drawPixelDoor(ctx: CanvasRenderingContext2D, px: number, py: number, tx: number, ty: number, c: OfficeThemeColors): void {
  // 门框（深色）
  ctx.fillStyle = rgba(c.wallShadow, 0.7);
  ctx.fillRect(px, py, TILE, TILE);

  // 门板（暖棕色）
  ctx.fillStyle = hex(c.door);
  ctx.fillRect(px + 2, py + 1, TILE - 4, TILE - 2);

  // 木纹纹理（至少 4 条水平木纹线，不同深浅）
  ctx.fillStyle = rgba(0x5a4830, 0.3);
  ctx.fillRect(px + 3, py + 3, 9, 1);
  ctx.fillStyle = rgba(0x3a2818, 0.25);
  ctx.fillRect(px + 4, py + 6, 7, 1);
  ctx.fillStyle = rgba(0x5a4830, 0.2);
  ctx.fillRect(px + 3, py + 9, 8, 1);
  ctx.fillStyle = rgba(0x3a2818, 0.3);
  ctx.fillRect(px + 4, py + 12, 6, 1);

  // 门板面板凹槽
  ctx.fillStyle = rgba(c.wallShadow, 0.2);
  ctx.fillRect(px + 4, py + 2, 8, 5);
  ctx.fillStyle = rgba(c.wallShadow, 0.15);
  ctx.fillRect(px + 4, py + 9, 8, 4);

  // 金色门把手
  ctx.fillStyle = hex(c.doorHandle);
  ctx.fillRect(px + TILE - 5, py + 7, 2, 3);

  // 把手高光
  ctx.fillStyle = rgba(0xffffff, 0.5);
  ctx.fillRect(px + TILE - 5, py + 7, 1, 1);

  // 把手阴影
  ctx.fillStyle = rgba(0x000000, 0.3);
  ctx.fillRect(px + TILE - 3, py + 9, 1, 1);
}

// === 区域边框辉光（4层外辉光 + 内边框 + 四角灵光标记）===
function drawAreaBorders(ctx: CanvasRenderingContext2D, areas: OfficeArea[], c: OfficeThemeColors): void {
  for (const area of areas) {
    const glow = getGlowColor(c, area);
    const bx = area.bounds.x * TILE;
    const by = area.bounds.y * TILE;
    const bw = area.bounds.w * TILE;
    const bh = area.bounds.h * TILE;

    // 4 层外辉光（alpha 递减 0.12→0.04）
    const alphas = [0.12, 0.09, 0.06, 0.04];
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = rgba(glow, alphas[i]);
      ctx.lineWidth = 1;
      ctx.strokeRect(bx - (i + 1), by - (i + 1), bw + (i + 1) * 2, bh + (i + 1) * 2);
    }

    // 内边框（alpha 0.18）
    ctx.strokeStyle = rgba(glow, 0.18);
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);

    // 四角灵光标记（L 形角标）
    ctx.fillStyle = rgba(glow, 0.25);
    // 左上
    ctx.fillRect(bx + 2, by + 2, 6, 1);
    ctx.fillRect(bx + 2, by + 2, 1, 6);
    // 右上
    ctx.fillRect(bx + bw - 8, by + 2, 6, 1);
    ctx.fillRect(bx + bw - 3, by + 2, 1, 6);
    // 左下
    ctx.fillRect(bx + 2, by + bh - 3, 6, 1);
    ctx.fillRect(bx + 2, by + bh - 8, 1, 6);
    // 右下
    ctx.fillRect(bx + bw - 8, by + bh - 3, 6, 1);
    ctx.fillRect(bx + bw - 3, by + bh - 8, 1, 6);

    // 角标亮点
    ctx.fillStyle = rgba(glow, 0.4);
    ctx.fillRect(bx + 2, by + 2, 2, 2);
    ctx.fillRect(bx + bw - 4, by + 2, 2, 2);
    ctx.fillRect(bx + 2, by + bh - 4, 2, 2);
    ctx.fillRect(bx + bw - 4, by + bh - 4, 2, 2);
  }
}

// === 走廊灵脉线（周期性亮点 + 方向箭头）===
function drawCorridorSpiritVeins(ctx: CanvasRenderingContext2D, c: OfficeThemeColors): void {
  // 水平走廊灵脉点（y=30-31 区域）
  for (let x = 3; x < 68; x += 2) {
    const px = x * TILE + 7;
    const py = 30 * TILE + 12;
    // 灵脉亮点
    ctx.fillStyle = rgba(c.spiritVein, 0.12);
    ctx.fillRect(px - 1, py - 1, 3, 3);
    ctx.fillStyle = rgba(c.spiritVein, 0.25);
    ctx.fillRect(px, py, 1, 1);
  }

  // 水平走廊方向箭头（每 6 tile 一个）
  for (let x = 5; x < 65; x += 6) {
    const px = x * TILE + 4;
    const py = 31 * TILE + 6;
    ctx.fillStyle = rgba(c.spiritVein, 0.08);
    // 右箭头 ▶
    ctx.fillRect(px, py + 1, 1, 3);
    ctx.fillRect(px + 1, py + 2, 1, 1);
    ctx.fillRect(px + 2, py + 1, 1, 3);
    ctx.fillRect(px + 3, py + 2, 1, 1);
  }

  // 垂直走廊灵脉点（x=33-36 区域）
  for (let y = 3; y < 30; y += 2) {
    const px = 34 * TILE + 12;
    const py = y * TILE + 7;
    ctx.fillStyle = rgba(c.spiritVein, 0.12);
    ctx.fillRect(px - 1, py - 1, 3, 3);
    ctx.fillStyle = rgba(c.spiritVein, 0.25);
    ctx.fillRect(px, py, 1, 1);
  }

  // 垂直走廊方向箭头（每 5 tile 一个）
  for (let y = 4; y < 28; y += 5) {
    const px = 35 * TILE + 6;
    const py = y * TILE + 4;
    ctx.fillStyle = rgba(c.spiritVein, 0.08);
    // 下箭头 ▼
    ctx.fillRect(px + 1, py, 3, 1);
    ctx.fillRect(px + 2, py + 1, 1, 1);
    ctx.fillRect(px + 1, py + 2, 3, 1);
    ctx.fillRect(px + 2, py + 3, 1, 1);
  }

  // 右侧水平走廊灵脉（y=15-17）
  for (let x = 38; x < 67; x += 2) {
    const px = x * TILE + 7;
    const py = 16 * TILE + 7;
    ctx.fillStyle = rgba(c.spiritVein, 0.1);
    ctx.fillRect(px - 1, py - 1, 3, 3);
    ctx.fillStyle = rgba(c.spiritVein, 0.2);
    ctx.fillRect(px, py, 1, 1);
  }
}

// === 颜色工具 ===
function getFloorColor(c: OfficeThemeColors, area: OfficeArea | undefined): number {
  if (!area) return c.corridor;
  return getAreaBaseColor(c, area);
}

function getAreaBaseColor(c: OfficeThemeColors, area: OfficeArea | undefined): number {
  if (!area) return c.corridor;
  const m: Record<string, number> = {
    lobby: c.lobby, coding: c.coding, planning: c.planning,
    tooling: c.tooling, review: c.review, observability: c.observability,
  };
  return m[area.kind] || c.floor;
}

function getGlowColor(c: OfficeThemeColors, area: OfficeArea | undefined): number {
  if (!area) return c.spiritVein;
  const m: Record<string, number> = {
    lobby: c.glowWood, coding: c.glowWater, planning: c.glowMetal,
    tooling: c.glowEarth, review: c.glowFire, observability: c.glowSpirit,
  };
  return m[area.kind] || c.spiritVein;
}

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

function rgba(c: number, a: number): string {
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  return `rgba(${r},${g},${b},${a})`;
}
