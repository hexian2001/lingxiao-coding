/**
 * Camera — 相机控制
 */
import { Application, Container } from 'pixi.js';
import { TILE_SIZE } from './TileMap';

export class Camera {
  private app: Application;
  private world: Container;
  private mapWidth: number; private mapHeight: number;

  x = 0; y = 0; zoom = 1.25; minZoom = 0.5; maxZoom = 4;

  constructor(app: Application, world: Container, mapWTiles: number, mapHTiles: number) {
    this.app = app; this.world = world;
    this.mapWidth = mapWTiles * TILE_SIZE; this.mapHeight = mapHTiles * TILE_SIZE;
    this.applyTransform();
  }

  pan(dx: number, dy: number): void { this.x += dx; this.y += dy; this.clampPosition(); this.applyTransform(); }
  setPosition(x: number, y: number): void { this.x = x; this.y = y; this.clampPosition(); this.applyTransform(); }
  setZoom(zoom: number): void { this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom)); this.applyTransform(); }

  zoomAt(delta: number, screenX: number, screenY: number): void {
    const oldZoom = this.zoom;
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * (1 - delta * 0.001)));
    const worldX = (screenX - this.x * oldZoom) / oldZoom;
    const worldY = (screenY - this.y * oldZoom) / oldZoom;
    this.zoom = newZoom;
    this.x = (screenX - worldX * newZoom) / newZoom;
    this.y = (screenY - worldY * newZoom) / newZoom;
    this.applyTransform();
  }

  screenToWorld(sx: number, sy: number) { return { x: (sx / this.zoom) - this.x, y: (sy / this.zoom) - this.y }; }
  worldToScreen(wx: number, wy: number) { return { x: (wx + this.x) * this.zoom, y: (wy + this.y) * this.zoom }; }

  centerOn(worldX: number, worldY: number): void {
    const sw = this.app.screen.width, sh = this.app.screen.height;
    this.x = (sw / 2 / this.zoom) - worldX;
    this.y = (sh / 2 / this.zoom) - worldY;
    this.applyTransform();
  }

  fitMap(): void {
    const sw = this.app.screen.width, sh = this.app.screen.height;
    const fzx = sw / this.mapWidth, fzy = sh / this.mapHeight;
    this.zoom = Math.max(this.minZoom, Math.min(fzx, fzy));
    this.x = (sw / 2 / this.zoom) - this.mapWidth / 2;
    this.y = (sh / 2 / this.zoom) - this.mapHeight / 2;
    this.applyTransform();
  }

  onResize(): void { this.applyTransform(); }

  private clampPosition(): void {
    const maxOverscroll = this.mapWidth * 0.3;
    this.x = Math.max(-maxOverscroll, Math.min(maxOverscroll + this.app.screen.width / this.zoom, this.x));
    this.y = Math.max(-maxOverscroll, Math.min(maxOverscroll + this.app.screen.height / this.zoom, this.y));
  }

  private applyTransform(): void {
    this.world.scale.set(this.zoom); this.world.position.set(this.x * this.zoom, this.y * this.zoom);
    const parent = this.world.parent;
    if (parent) {
      for (const child of parent.children) {
        if (child !== parent.children[0] && child !== parent.children[parent.children.length - 1]) {
          child.scale.set(this.zoom); child.position.set(this.x * this.zoom, this.y * this.zoom);
        }
      }
    }
  }
}
