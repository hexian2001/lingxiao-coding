/**
 * TileMap — 像素艺术瓦片地图（v3 重制）
 * 使用 Canvas 2D 预生成背景纹理 + 像素精灵家具，替代逐瓦片 Graphics.rect
 */
import { Container, Graphics, Text, Sprite, AnimatedSprite } from 'pixi.js';
import { OFFICE_LAYOUT, TileType, type OfficeArea } from '../assets/officeLayout';
import { generatePixelBackground } from './PixelRenderer';
import { createFurnitureSprite, createAnimatedFurniture } from './PixelSprites';
import { OFFICE_THEMES, type OfficeThemeColors } from '../assets/themeColors';

export const TILE_SIZE = 16;

export class TileMap {
  private tileLayer: Container;
  private furnitureLayer: Container;
  private colors: OfficeThemeColors;
  private backgroundSprite: Sprite | null = null;
  private furnitureSprites: (Sprite | AnimatedSprite)[] = [];
  private labelObjects: (Graphics | Text)[] = [];
  private theme: 'dark' | 'light' = 'dark';

  width = 0;
  height = 0;

  constructor(tileLayer: Container, furnitureLayer: Container, theme: 'dark' | 'light' = 'dark') {
    this.tileLayer = tileLayer;
    this.furnitureLayer = furnitureLayer;
    this.theme = theme;
    this.colors = OFFICE_THEMES[theme];
  }

  async init(): Promise<void> {
    this.width = OFFICE_LAYOUT.width;
    this.height = OFFICE_LAYOUT.height;
    this.renderBackground();
    this.renderFurniture();
    this.renderLabels();
  }

  rerender(theme: 'dark' | 'light'): void {
    this.theme = theme;
    this.colors = OFFICE_THEMES[theme];
    this.backgroundSprite?.destroy({ children: true, texture: true });
    for (const sprite of this.furnitureSprites) sprite.destroy({ children: true, texture: true });
    for (const label of this.labelObjects) label.destroy();
    this.tileLayer.removeChildren();
    this.furnitureLayer.removeChildren();
    this.furnitureSprites = [];
    this.labelObjects = [];
    this.backgroundSprite = null;
    this.renderBackground();
    this.renderFurniture();
    this.renderLabels();
  }

  isWalkable(tileX: number, tileY: number): boolean {
    if (tileX < 0 || tileX >= this.width || tileY < 0 || tileY >= this.height) return false;
    const t = OFFICE_LAYOUT.tiles[tileY]?.[tileX];
    return t === TileType.FLOOR || t === TileType.CARPET || t === TileType.DOOR;
  }

  getTileAt(tileX: number, tileY: number): TileType {
    if (tileX < 0 || tileX >= this.width || tileY < 0 || tileY >= this.height) return TileType.WALL;
    return OFFICE_LAYOUT.tiles[tileY][tileX];
  }

  tileToWorld(tileX: number, tileY: number): { x: number; y: number } {
    return { x: tileX * TILE_SIZE + TILE_SIZE / 2, y: tileY * TILE_SIZE + TILE_SIZE / 2 };
  }

  worldToTile(worldX: number, worldY: number): { x: number; y: number } {
    return { x: Math.floor(worldX / TILE_SIZE), y: Math.floor(worldY / TILE_SIZE) };
  }

  private renderBackground(): void {
    this.backgroundSprite = generatePixelBackground(this.theme);
    this.tileLayer.addChild(this.backgroundSprite);
  }

  private renderFurniture(): void {
    const c = this.colors;

    for (const item of OFFICE_LAYOUT.furniture) {
      const px = item.x * TILE_SIZE;
      const py = item.y * TILE_SIZE;
      const W = getItemWidth(item.type) * TILE_SIZE;
      const H = getItemHeight(item.type) * TILE_SIZE;

      // 尝试生成动画精灵
      const anim = createAnimatedFurniture(item, this.theme);
      if (anim) {
        anim.position.set(px, py);
        this.furnitureLayer.addChild(anim);
        this.furnitureSprites.push(anim);
        continue;
      }

      // 静态家具精灵
      const sprite = createFurnitureSprite(item, this.theme) as Sprite;
      sprite.position.set(px, py);
      this.furnitureLayer.addChild(sprite);
      this.furnitureSprites.push(sprite);
    }
  }

  private renderLabels(): void {
    const c = this.colors;

    // 区域标签 — 像素风格
    for (const area of OFFICE_LAYOUT.areas) {
      const labelBg = new Graphics();
      const textW = area.name.length * 8;
      const cx = (area.bounds.x + area.bounds.w / 2) * TILE_SIZE;
      const cy = (area.bounds.y + 1) * TILE_SIZE;

      // 标签背景
      labelBg.roundRect(cx - textW / 2 - 4, cy - 1, textW + 8, 14, 3);
      labelBg.fill({ color: c.areaLabelBg, alpha: 0.75 });
      labelBg.stroke({ color: c.areaLabel, alpha: 0.5, width: 1 });
      this.furnitureLayer.addChild(labelBg);
      this.labelObjects.push(labelBg);

      // 标签文字
      const label = new Text({
        text: area.name,
        style: {
          fontSize: 9,
          fontFamily: '"Courier New", "Consolas", monospace',
          fill: c.areaLabel,
          align: 'center',
          fontWeight: 'bold',
        },
      });
      label.anchor.set(0.5, 0);
      label.position.set(cx, cy + 1);
      this.furnitureLayer.addChild(label);
      this.labelObjects.push(label);
    }

    // 工位标签
    for (const ws of OFFICE_LAYOUT.workstations) {
      if (!ws.label) continue;
      const x = ws.tileX * TILE_SIZE + TILE_SIZE / 2;
      const y = ws.tileY * TILE_SIZE + TILE_SIZE;
      const textW = ws.label.length * 5;
      const labelBg = new Graphics();
      labelBg.roundRect(x - textW / 2 - 3, y - 9, textW + 6, 9, 2);
      labelBg.fill({ color: c.areaLabelBg, alpha: 0.48 });
      labelBg.stroke({ color: c.gold, alpha: 0.28, width: 1 });
      this.furnitureLayer.addChild(labelBg);
      this.labelObjects.push(labelBg);

      const label = new Text({
        text: ws.label,
        style: {
          fontSize: 7,
          fontFamily: '"Courier New", "Consolas", monospace',
          fill: c.gold,
          align: 'center',
        },
      });
      label.alpha = 0.86;
      label.anchor.set(0.5, 1);
      label.position.set(x, y - 1);
      this.furnitureLayer.addChild(label);
      this.labelObjects.push(label);
    }
  }
}

function getItemWidth(type: string): number {
  const w: Record<string, number> = {
    desk: 2, chair: 1, plant: 1, server: 1, whiteboard: 2,
    coffee: 1, elevator: 2, terminal: 2, dashboard: 3,
    conference_table: 4, toolbench: 2, sofa: 3, bookshelf: 1, hologram: 2,
  };
  return w[type] || 1;
}

function getItemHeight(type: string): number {
  const h: Record<string, number> = {
    desk: 1, chair: 1, plant: 1, server: 1, whiteboard: 1,
    coffee: 1, elevator: 2, terminal: 1, dashboard: 2,
    conference_table: 2, toolbench: 1, sofa: 1, bookshelf: 2, hologram: 2,
  };
  return h[type] || 1;
}
