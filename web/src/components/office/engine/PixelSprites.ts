/**
 * PixelSprites — Canvas 2D 像素艺术家具精灵生成器
 * 为每种家具生成带有像素细节和霓虹装饰的精灵纹理
 */
import { Texture, Sprite, AnimatedSprite } from 'pixi.js';
import { OFFICE_THEMES, type OfficeThemeColors } from '../assets/themeColors';
import type { FurnitureItem } from '../assets/officeLayout';

const TILE = 16;

type CanvasBundle = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

export function createFurnitureSprite(item: FurnitureItem, theme: 'dark' | 'light'): Sprite {
  const c = OFFICE_THEMES[theme];
  const w = getItemWidth(item.type) * TILE;
  const h = getItemHeight(item.type) * TILE;
  const { canvas, ctx } = createCanvas(w, h);

  drawFurniture(ctx, item.type, w, h, c);
  return new Sprite(textureFromCanvas(canvas));
}

export function createAnimatedFurniture(item: FurnitureItem, theme: 'dark' | 'light'): AnimatedSprite | null {
  switch (item.type) {
    case 'server': return createServerBlink(item, theme);
    case 'coffee': return createCoffeeBubble(item, theme);
    case 'terminal': return createTerminalFlow(item, theme);
    case 'dashboard': return createDashboardWave(item, theme);
    case 'plant': return createPlantBreath(item, theme);
    default: return null;
  }
}

function drawFurniture(ctx: CanvasRenderingContext2D, type: FurnitureItem['type'], w: number, h: number, c: OfficeThemeColors): void {
  switch (type) {
    case 'desk': drawDesk(ctx, w, h, c); break;
    case 'chair': drawChair(ctx, w, h, c); break;
    case 'plant': drawPlant(ctx, w, h, c, 0); break;
    case 'server': drawServer(ctx, w, h, c, 0); break;
    case 'whiteboard': drawWhiteboard(ctx, w, h, c); break;
    case 'coffee': drawCoffee(ctx, w, h, c, 0); break;
    case 'elevator': drawElevator(ctx, w, h, c); break;
    case 'terminal': drawTerminal(ctx, w, h, c, 0); break;
    case 'dashboard': drawDashboard(ctx, w, h, c, 0); break;
    case 'conference_table': drawConfTable(ctx, w, h, c); break;
    case 'toolbench': drawToolbench(ctx, w, h, c); break;
    case 'sofa': drawSofa(ctx, w, h, c); break;
    case 'bookshelf': drawBookshelf(ctx, w, h, c); break;
    case 'hologram': drawHologram(ctx, w, h, c); break;
  }
}

function getItemWidth(type: FurnitureItem['type']): number {
  const w: Record<FurnitureItem['type'], number> = {
    desk: 2, chair: 1, plant: 1, server: 1, whiteboard: 2,
    coffee: 1, elevator: 2, terminal: 2, dashboard: 3,
    conference_table: 4, toolbench: 2, sofa: 3, bookshelf: 1, hologram: 2,
  };
  return w[type];
}

function getItemHeight(type: FurnitureItem['type']): number {
  const h: Record<FurnitureItem['type'], number> = {
    desk: 1, chair: 1, plant: 1, server: 1, whiteboard: 1,
    coffee: 1, elevator: 2, terminal: 1, dashboard: 2,
    conference_table: 2, toolbench: 1, sofa: 1, bookshelf: 2, hologram: 2,
  };
  return h[type];
}

function createCanvas(w: number, h: number): CanvasBundle {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

function textureFromCanvas(canvas: HTMLCanvasElement): Texture {
  return Texture.from({ resource: canvas, scaleMode: 'nearest' });
}

function hex(c: number): string { return '#' + c.toString(16).padStart(6, '0'); }
function rgba(c: number, a: number): string { return `rgba(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff},${a})`; }
function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
function px(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void { rect(ctx, x, y, 1, 1, color); }

function drawPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, outer: number, inner: number, shine: number): void {
  rect(ctx, x, y, w, h, hex(outer));
  rect(ctx, x + 1, y + 1, w - 2, h - 2, hex(inner));
  rect(ctx, x + 1, y + 1, w - 2, 1, rgba(shine, 0.22));
  rect(ctx, x + 1, y + 1, 1, h - 2, rgba(shine, 0.14));
  rect(ctx, x + w - 2, y + 1, 1, h - 2, rgba(0x000000, 0.28));
  rect(ctx, x + 1, y + h - 2, w - 2, 1, rgba(0x000000, 0.32));
}

function drawDesk(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 0, h - 7, w, 6, 0x080b16, 0x151b2c, c.glowWater);
  rect(ctx, 2, h - 5, w - 4, 1, rgba(c.gold, 0.08));
  for (let x = 4; x < w - 4; x += 6) rect(ctx, x, h - 3, 3, 1, rgba(c.spiritVein, 0.08));
  rect(ctx, 2, h - 3, 3, 3, hex(0x090d18));
  rect(ctx, w - 5, h - 3, 3, 3, hex(0x090d18));

  const mx = Math.floor(w / 2) - 8;
  drawPanel(ctx, mx, 0, 16, 10, 0x050712, 0x080f1b, c.glowWater);
  rect(ctx, mx + 2, 2, 12, 6, rgba(0x000814, 1));
  rect(ctx, mx + 3, 3, 9, 1, rgba(c.glowWater, 0.65));
  rect(ctx, mx + 3, 5, 6, 1, rgba(c.green, 0.5));
  rect(ctx, mx + 10, 5, 3, 1, rgba(c.amber, 0.45));
  px(ctx, mx + 13, 7, rgba(c.spiritVein, 0.8));
  rect(ctx, Math.floor(w / 2) - 1, 10, 2, 3, hex(0x222a3d));
  rect(ctx, Math.floor(w / 2) - 5, 13, 10, 2, hex(0x101522));
  rect(ctx, Math.floor(w / 2) - 7, h - 2, 14, 2, hex(0x0a0f18));
  for (let x = Math.floor(w / 2) - 6; x <= Math.floor(w / 2) + 5; x += 2) px(ctx, x, h - 2, rgba(c.spiritVein, 0.22));
}

function drawChair(ctx: CanvasRenderingContext2D, _w: number, _h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 2, 1, 12, 7, 0x080b14, 0x151a2a, c.glowEarth);
  rect(ctx, 4, 3, 8, 1, rgba(c.glowEarth, 0.1));
  rect(ctx, 3, 6, 10, 1, rgba(0x000000, 0.18));
  drawPanel(ctx, 1, 8, 14, 6, 0x080b14, 0x1a2031, c.glowWater);
  rect(ctx, 4, 9, 8, 1, rgba(c.gold, 0.08));
  rect(ctx, 3, 13, 2, 3, hex(0x070a12));
  rect(ctx, 11, 13, 2, 3, hex(0x070a12));
  px(ctx, 4, 10, rgba(c.spiritVein, 0.18));
  px(ctx, 11, 11, rgba(c.spiritVein, 0.12));
}

function drawPlant(ctx: CanvasRenderingContext2D, _w: number, _h: number, c: OfficeThemeColors, frame: number): void {
  const sway = frame % 4 === 1 ? -1 : frame % 4 === 3 ? 1 : 0;
  drawPanel(ctx, 3, 10, 10, 5, 0x16100d, 0x332017, c.amber);
  rect(ctx, 2, 9, 12, 2, hex(0x4a2d1e));
  rect(ctx, 5, 14, 6, 1, rgba(0x000000, 0.35));
  const dark = hex(0x0b3518);
  const mid = hex(0x147a34);
  const hi = rgba(c.glowWood, 0.62);
  rect(ctx, 7 + sway, 2, 2, 8, dark);
  rect(ctx, 5 + sway, 4, 3, 4, mid);
  rect(ctx, 9 + sway, 3, 3, 5, mid);
  rect(ctx, 4 + sway, 6, 4, 3, hex(0x0f5f2a));
  rect(ctx, 8 + sway, 1, 3, 5, hex(0x1d9a46));
  rect(ctx, 6 + sway, 0, 2, 5, hex(0x16833b));
  px(ctx, 9 + sway, 2, hi);
  px(ctx, 6 + sway, 5, hi);
  px(ctx, 11 + sway, 5, rgba(c.glowWood, 0.45));
}

function drawServer(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors, frame: number): void {
  drawPanel(ctx, 0, 0, w, h, 0x040611, 0x0b1020, c.spiritVein);
  for (let y = 2; y < h - 2; y += 4) {
    rect(ctx, 2, y, w - 4, 1, rgba(0xffffff, 0.05));
    rect(ctx, 2, y + 2, 7, 1, rgba(0x000000, 0.55));
    rect(ctx, 10, y + 2, 2, 1, rgba(0x000000, 0.45));
  }
  const leds = [c.green, c.spiritVein, c.amber, c.red];
  for (let i = 0; i < 4; i++) {
    const on = ((frame + i) % 4) < 2;
    const color = on ? leds[i] : 0x17202c;
    rect(ctx, w - 4, 3 + i * 3, 2, 1, hex(color));
    if (on) px(ctx, w - 3, 3 + i * 3, rgba(color, 0.8));
  }
}

function drawWhiteboard(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 0, 0, w, h, 0x657083, 0x172132, c.gold);
  rect(ctx, 3, 3, w - 6, h - 6, hex(0x202a38));
  rect(ctx, 5, 5, 9, 1, rgba(c.glowWater, 0.52));
  rect(ctx, 6, 8, 17, 1, rgba(c.gold, 0.35));
  rect(ctx, 5, 11, 7, 1, rgba(c.red, 0.38));
  rect(ctx, 19, 5, 6, 1, rgba(c.green, 0.42));
  px(ctx, 24, 10, rgba(c.spiritVein, 0.5));
  rect(ctx, w - 8, h - 3, 5, 1, rgba(c.gold, 0.55));
}

function drawCoffee(ctx: CanvasRenderingContext2D, _w: number, _h: number, c: OfficeThemeColors, frame: number): void {
  drawPanel(ctx, 1, 4, 14, 11, 0x09090d, 0x22232a, c.gold);
  rect(ctx, 3, 6, 10, 2, hex(0x30323c));
  rect(ctx, 4, 1, 3, 2, hex(frame % 3 === 1 ? c.red : 0x61202a));
  rect(ctx, 9, 1, 3, 2, hex(frame % 3 === 2 ? c.green : 0x1b4a2d));
  rect(ctx, 7, 3, 3, 4, hex(0x11141b));
  rect(ctx, 8, 7, 1, 3, rgba(c.amber, frame === 0 ? 0.2 : 0.55));
  rect(ctx, 5, 11, 6, 3, hex(0x0c0e13));
  rect(ctx, 6, 10, 4, 1, rgba(0xffffff, 0.25));
  if (frame > 0) {
    px(ctx, 6 + frame * 2, 3 - frame, rgba(0xffffff, 0.35));
    px(ctx, 11 - frame, 2, rgba(c.gold, 0.28));
  }
}

function drawElevator(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 0, 0, w, h, 0x050712, 0x0c1224, c.spiritVein);
  rect(ctx, 3, 5, w / 2 - 4, h - 8, hex(0x10192a));
  rect(ctx, w / 2 + 1, 5, w / 2 - 4, h - 8, hex(0x0b1322));
  rect(ctx, w / 2 - 1, 4, 2, h - 6, rgba(c.spiritVein, 0.42));
  rect(ctx, w / 2 - 5, 1, 10, 3, hex(0x1c1d18));
  rect(ctx, w / 2 - 2, 2, 4, 1, hex(c.gold));
  rect(ctx, w - 5, 12, 2, 4, rgba(c.gold, 0.65));
  px(ctx, w / 2, 8, rgba(c.spiritVein, 0.8));
  rect(ctx, w / 2 - 1, 9, 3, 1, rgba(c.spiritVein, 0.8));
}

function drawTerminal(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors, frame: number): void {
  drawPanel(ctx, 0, 0, w, h, 0x050710, 0x0a0f18, c.green);
  rect(ctx, 2, 2, w - 4, h - 4, hex(0x00100b));
  const rows = [4, 6, 8, 10];
  for (let i = 0; i < rows.length; i++) {
    const y = rows[(i + frame) % rows.length];
    const len = 7 + ((i + frame) % 4) * 4;
    rect(ctx, 4, y, len, 1, rgba(i % 2 ? c.spiritVein : c.green, 0.4 + i * 0.1));
  }
  rect(ctx, 4, 12, 3, 1, rgba(c.gold, 0.45));
  if (frame % 2 === 0) rect(ctx, 11 + frame, 12, 2, 1, rgba(c.green, 0.9));
}

function drawDashboard(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors, frame: number): void {
  drawPanel(ctx, 0, 0, w, h, 0x040611, 0x0a0f1d, c.glowWater);
  rect(ctx, 3, 3, 13, 12, hex(0x001426));
  const bars = [4, 7, 5];
  const barColors = [c.glowWater, c.spiritVein, c.glowEarth];
  for (let i = 0; i < 3; i++) {
    const bh = bars[i] + ((frame + i) % 3);
    rect(ctx, 5 + i * 4, 13 - bh, 2, bh, hex(barColors[i]));
  }
  rect(ctx, 19, 3, w - 23, 12, hex(0x001426));
  for (let i = 0; i < w - 28; i++) {
    const y = 9 + Math.round(Math.sin((i + frame * 1.4) * 0.65) * 3);
    px(ctx, 22 + i, y, rgba(c.glowWater, 0.72));
  }
  for (let i = 0; i < 8; i++) px(ctx, 6 + i * 5, 20 + (i % 2), rgba(i % 3 === 0 ? c.amber : c.green, 0.42));
  rect(ctx, 4, h - 6, w - 8, 1, rgba(c.spiritVein, 0.18));
}

function drawConfTable(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 3, 5, w - 6, h - 10, 0x080914, 0x191523, c.gold);
  for (let x = 8; x < w - 8; x += 6) rect(ctx, x, 8, 1, h - 16, rgba(c.gold, 0.08));
  rect(ctx, 7, 9, w - 14, 1, rgba(0xffffff, 0.05));
  const seats = 6;
  for (let i = 0; i < seats; i++) {
    const x = 7 + i * Math.floor((w - 14) / (seats - 1));
    rect(ctx, x - 3, 1, 6, 3, rgba(c.glowEarth, 0.28));
    rect(ctx, x - 3, h - 4, 6, 3, rgba(c.glowEarth, 0.28));
  }
  rect(ctx, 2, 13, 3, 6, rgba(c.glowEarth, 0.22));
  rect(ctx, w - 5, 13, 3, 6, rgba(c.glowEarth, 0.22));
}

function drawToolbench(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 0, 3, w, h - 4, 0x08090c, 0x22201a, c.gold);
  rect(ctx, 2, 2, w - 4, 3, hex(0x3a2b18));
  rect(ctx, 4, 6, 5, 3, rgba(c.gold, 0.32));
  rect(ctx, 11, 6, 4, 1, rgba(c.spiritVein, 0.46));
  rect(ctx, 13, 7, 1, 4, rgba(c.spiritVein, 0.38));
  rect(ctx, 19, 5, 6, 2, rgba(c.red, 0.28));
  rect(ctx, 20, 8, 4, 1, rgba(c.green, 0.42));
  px(ctx, 27, 7, rgba(c.amber, 0.7));
}

function drawSofa(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 1, 5, w - 2, 9, 0x120814, 0x2a1430, c.glowEarth);
  rect(ctx, 0, 4, 4, h - 7, hex(0x1f0e24));
  rect(ctx, w - 4, 4, 4, h - 7, hex(0x1f0e24));
  rect(ctx, 4, 2, w - 8, 6, hex(0x1a0d20));
  rect(ctx, 5, 3, w - 10, 1, rgba(c.glowEarth, 0.12));
  for (let i = 0; i < 3; i++) {
    const x = 7 + i * Math.floor((w - 14) / 2);
    rect(ctx, x, 8, 7, 4, rgba(i === 1 ? c.gold : c.glowFire, 0.16));
    rect(ctx, x + 1, 9, 5, 1, rgba(0xffffff, 0.06));
  }
  rect(ctx, 4, 14, w - 8, 1, rgba(0x000000, 0.28));
}

function drawBookshelf(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 0, 0, w, h, 0x10090a, 0x241515, c.gold);
  const colors = [c.glowWater, c.glowWood, c.glowFire, c.glowEarth, c.spiritVein, c.gold];
  for (let row = 0; row < 4; row++) {
    const y = 3 + row * 7;
    rect(ctx, 2, y + 5, w - 4, 1, hex(0x3a2418));
    for (let i = 0; i < 5; i++) {
      const x = 3 + i * 2;
      const bh = 3 + ((row + i) % 3);
      rect(ctx, x, y + 5 - bh, 1, bh, rgba(colors[(row + i) % colors.length], 0.55));
      rect(ctx, x + 1, y + 5 - bh, 1, bh, rgba(colors[(row + i + 2) % colors.length], 0.35));
    }
  }
}

function drawHologram(ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors): void {
  drawPanel(ctx, 5, h - 8, w - 10, 7, 0x030611, 0x0b1120, c.spiritVein);
  rect(ctx, w / 2 - 2, h - 10, 4, 3, rgba(c.spiritVein, 0.42));
  rect(ctx, w / 2 - 1, 8, 2, h - 18, rgba(c.spiritVein, 0.08));
  const cx = Math.floor(w / 2), cy = 14;
  const rings = [12, 9, 6, 3];
  for (const r of rings) {
    const a = 0.07 + (12 - r) * 0.015;
    rect(ctx, cx - r, cy - 1, r * 2, 2, rgba(r % 2 ? c.glowWater : c.spiritVein, a));
    rect(ctx, cx - 1, cy - r, 2, r * 2, rgba(c.spiritVein, a * 0.7));
    px(ctx, cx - r, cy, rgba(c.spiritVein, a + 0.08));
    px(ctx, cx + r - 1, cy, rgba(c.spiritVein, a + 0.08));
    px(ctx, cx, cy - r, rgba(c.glowWater, a + 0.08));
    px(ctx, cx, cy + r - 1, rgba(c.glowWater, a + 0.08));
  }
  rect(ctx, cx - 1, cy - 1, 2, 2, hex(c.spiritVein));
  px(ctx, cx + 5, cy - 5, rgba(c.gold, 0.65));
  px(ctx, cx - 6, cy + 4, rgba(c.glowWater, 0.5));
}

function makeFrames(item: FurnitureItem, theme: 'dark' | 'light', count: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number, c: OfficeThemeColors, frame: number) => void): Texture[] {
  const c = OFFICE_THEMES[theme];
  const w = getItemWidth(item.type) * TILE;
  const h = getItemHeight(item.type) * TILE;
  const textures: Texture[] = [];
  for (let frame = 0; frame < count; frame++) {
    const { canvas, ctx } = createCanvas(w, h);
    draw(ctx, w, h, c, frame);
    textures.push(textureFromCanvas(canvas));
  }
  return textures;
}

function animated(textures: Texture[], fps: number): AnimatedSprite {
  const sprite = new AnimatedSprite(textures);
  sprite.animationSpeed = fps / 60;
  sprite.play();
  return sprite;
}

function createServerBlink(item: FurnitureItem, theme: 'dark' | 'light'): AnimatedSprite {
  return animated(makeFrames(item, theme, 4, drawServer), 10);
}

function createCoffeeBubble(item: FurnitureItem, theme: 'dark' | 'light'): AnimatedSprite {
  return animated(makeFrames(item, theme, 3, drawCoffee), 8);
}

function createTerminalFlow(item: FurnitureItem, theme: 'dark' | 'light'): AnimatedSprite {
  return animated(makeFrames(item, theme, 4, drawTerminal), 10);
}

function createDashboardWave(item: FurnitureItem, theme: 'dark' | 'light'): AnimatedSprite {
  return animated(makeFrames(item, theme, 8, drawDashboard), 12);
}

function createPlantBreath(item: FurnitureItem, theme: 'dark' | 'light'): AnimatedSprite {
  return animated(makeFrames(item, theme, 4, drawPlant), 8);
}
