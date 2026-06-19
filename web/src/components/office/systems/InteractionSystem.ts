/**
 * InteractionSystem — 点击/悬停/拖拽交互（支持角色 + 家具）
 */
import type { OfficeEngine } from '../engine/OfficeEngine';
import type { AgentSprite } from '../sprites/AgentSprite';
import { OFFICE_LAYOUT, TileType, type FurnitureItem } from '../assets/officeLayout';
import { TILE_SIZE } from '../engine/TileMap';

export type InteractionCallback = (targetId: string, event: 'click' | 'dragend' | 'furniture') => void;
export type HoverCallback = (agentId: string | null, screenX: number, screenY: number) => void;
export type FurnitureCallback = (furniture: FurnitureItem) => void;
export type AreaClickCallback = (areaId: string) => void;
export type AgentContextMenuCallback = (agentId: string, screenX: number, screenY: number) => void;

const DRAG_THRESHOLD = 5, LONG_PRESS_MS = 200;

export class InteractionSystem {
  private engine: OfficeEngine;
  private selectedAgent: AgentSprite | null = null;
  private onInteraction: InteractionCallback | null = null;
  private onHover: HoverCallback | null = null;
  private dragAgent: AgentSprite | null = null;
  private dragStartX = 0; private dragStartY = 0;
  private isDragMode = false;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerDownAgent: AgentSprite | null = null;
  private hoveredAgent: AgentSprite | null = null;

  private _onPointerDown: (e: PointerEvent) => void;
  private _onPointerMove: (e: PointerEvent) => void;
  private _onPointerUp: (e: PointerEvent) => void;
  private _onContextMenu: (e: MouseEvent) => void;

  constructor(engine: OfficeEngine) {
    this.engine = engine;
    this._onPointerDown = this.handlePointerDown.bind(this);
    this._onPointerMove = this.handlePointerMove.bind(this);
    this._onPointerUp = this.handlePointerUp.bind(this);
    this._onContextMenu = this.handleContextMenu.bind(this);
    const canvas = engine.app.canvas as HTMLCanvasElement;
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointerleave', this._onPointerUp);
    canvas.addEventListener('contextmenu', this._onContextMenu);
  }

  setCallback(cb: InteractionCallback): void { this.onInteraction = cb; }
  setHoverCallback(cb: HoverCallback): void { this.onHover = cb; }
  setFurnitureCallback(cb: FurnitureCallback): void { this.onFurnitureClick = cb; }
  setAreaCallback(cb: AreaClickCallback): void { this.onAreaClick = cb; }
  setAgentContextMenuCallback(cb: AgentContextMenuCallback): void { this.onAgentContextMenu = cb; }

  getSelectedAgent(): AgentSprite | null { return this.selectedAgent; }

  private onFurnitureClick: FurnitureCallback | null = null;
  private onAreaClick: AreaClickCallback | null = null;
  private onAgentContextMenu: AgentContextMenuCallback | null = null;

  private hitTestArea(worldX: number, worldY: number): string | null {
    const tx = Math.floor(worldX / TILE_SIZE), ty = Math.floor(worldY / TILE_SIZE);
    const t = OFFICE_LAYOUT.tiles[ty]?.[tx];
    if (t === undefined || t === TileType.WALL) return null;
    for (const area of OFFICE_LAYOUT.areas) {
      if (tx >= area.bounds.x && tx < area.bounds.x + area.bounds.w && ty >= area.bounds.y && ty < area.bounds.y + area.bounds.h) return area.id;
    }
    return null;
  }

  private hitTestFurniture(worldX: number, worldY: number): FurnitureItem | null {
    for (const item of OFFICE_LAYOUT.furniture) {
      const fx = item.x * TILE_SIZE, fy = item.y * TILE_SIZE;
      let w = TILE_SIZE, h = TILE_SIZE;
      switch (item.type) {
        case 'desk': w = TILE_SIZE * 2; break;
        case 'conference_table': w = TILE_SIZE * 4; h = TILE_SIZE * 2; break;
        case 'dashboard': w = TILE_SIZE * 3; h = TILE_SIZE * 2; break;
        case 'sofa': w = TILE_SIZE * 3; break;
        case 'elevator': w = TILE_SIZE * 2; h = TILE_SIZE * 2; break;
        case 'terminal': case 'toolbench': case 'hologram': case 'whiteboard': w = TILE_SIZE * 2; break;
        case 'bookshelf': h = TILE_SIZE * 2; break;
      }
      if (worldX >= fx && worldX < fx + w && worldY >= fy && worldY < fy + h) return item;
    }
    return null;
  }

  private hitTest(sx: number, sy: number): AgentSprite | null {
    const world = this.engine.camera.screenToWorld(sx, sy);
    for (const [, agent] of this.engine.agents) {
      const b = agent.getBounds();
      if (world.x >= b.x && world.x <= b.x + b.width && world.y >= b.y && world.y <= b.y + b.height) return agent;
    }
    return null;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const canvas = this.engine.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = this.hitTest(sx, sy);
    if (hit) {
      this.pointerDownAgent = hit; this.dragStartX = e.clientX; this.dragStartY = e.clientY;
      this.longPressTimer = setTimeout(() => this.enterDragMode(hit), LONG_PRESS_MS);
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    const canvas = this.engine.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (this.isDragMode && this.dragAgent) {
      const world = this.engine.camera.screenToWorld(sx, sy);
      this.dragAgent.setPosition(world.x, world.y); return;
    }
    if (this.pointerDownAgent && !this.isDragMode) {
      const dx = Math.abs(e.clientX - this.dragStartX), dy = Math.abs(e.clientY - this.dragStartY);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) { this.clearLongPressTimer(); this.enterDragMode(this.pointerDownAgent); return; }
    }
    const hit = this.hitTest(sx, sy);
    if (hit !== this.hoveredAgent) { this.hoveredAgent = hit; this.onHover?.(hit?.agentId ?? null, e.clientX, e.clientY); }
    else if (hit) this.onHover?.(hit.agentId, e.clientX, e.clientY);
  }

  private handleContextMenu(e: MouseEvent): void {
    const canvas = this.engine.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = this.hitTest(sx, sy);
    if (!hit) return;
    e.preventDefault();
    this.clearLongPressTimer();
    this.pointerDownAgent = null;
    this.onAgentContextMenu?.(hit.agentId, e.clientX, e.clientY);
  }

  private handlePointerUp(e: PointerEvent): void {
    this.clearLongPressTimer();
    if (this.isDragMode && this.dragAgent) { this.finishDrag(e); return; }
    if (this.pointerDownAgent && !this.isDragMode) {
      const canvas = this.engine.app.canvas as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const hit = this.hitTest(sx, sy);
      if (this.selectedAgent && this.selectedAgent !== hit) this.selectedAgent.setSelected(false);
      if (hit) { hit.setSelected(true); this.selectedAgent = hit; this.onInteraction?.(hit.agentId, 'click'); }
      else {
        // Click on empty space — check for furniture first, then area
        const world = this.engine.camera.screenToWorld(sx, sy);
        const furniture = this.hitTestFurniture(world.x, world.y);
        if (furniture) { this.onFurnitureClick?.(furniture); }
        else {
          const areaId = this.hitTestArea(world.x, world.y);
          if (areaId) this.onAreaClick?.(areaId);
        }
      }
    } else if (!this.pointerDownAgent) {
      // Clicked on empty space directly — check furniture then area
      const canvas = this.engine.app.canvas as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const world = this.engine.camera.screenToWorld(sx, sy);
      const furniture = this.hitTestFurniture(world.x, world.y);
      if (furniture) { this.onFurnitureClick?.(furniture); }
      else { const areaId = this.hitTestArea(world.x, world.y); if (areaId) this.onAreaClick?.(areaId); }
    }
    this.pointerDownAgent = null;
  }

  private enterDragMode(agent: AgentSprite): void {
    this.isDragMode = true; this.dragAgent = agent; agent.isDragging = true;
    agent.container.alpha = 0.7; this.engine.inputManager.isDraggingAgent = true;
  }

  private finishDrag(e: PointerEvent): void {
    if (!this.dragAgent) return;
    const canvas = this.engine.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const world = this.engine.camera.screenToWorld(sx, sy);
    const tile = this.engine.tileMap.worldToTile(world.x, world.y);
    const target = this.findNearestWalkable(tile.x, tile.y);
    this.dragAgent.setTilePosition(target.x, target.y);
    this.dragAgent.isDragging = false; this.dragAgent.container.alpha = 1;
    this.onInteraction?.(this.dragAgent.agentId, 'dragend');
    this.engine.inputManager.isDraggingAgent = false;
    this.isDragMode = false; this.dragAgent = null; this.pointerDownAgent = null;
  }

  private findNearestWalkable(tx: number, ty: number): { x: number; y: number } {
    if (this.engine.tileMap.isWalkable(tx, ty)) return { x: tx, y: ty };
    const visited = new Set<string>(), queue: Array<{ x: number; y: number }> = [{ x: tx, y: ty }];
    visited.add(`${tx},${ty}`);
    while (queue.length > 0) {
      const c = queue.shift()!;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = c.x + dx, ny = c.y + dy, k = `${nx},${ny}`;
        if (visited.has(k)) continue; visited.add(k);
        if (this.engine.tileMap.isWalkable(nx, ny)) return { x: nx, y: ny };
        queue.push({ x: nx, y: ny });
      }
      if (visited.size > 100) break;
    }
    return { x: tx, y: ty };
  }

  private clearLongPressTimer(): void { if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; } }

  destroy(): void {
    this.clearLongPressTimer();
    const canvas = this.engine.app.canvas as HTMLCanvasElement;
    canvas.removeEventListener('pointerdown', this._onPointerDown); canvas.removeEventListener('pointermove', this._onPointerMove);
    canvas.removeEventListener('pointerup', this._onPointerUp); canvas.removeEventListener('pointerleave', this._onPointerUp);
    canvas.removeEventListener('contextmenu', this._onContextMenu);
  }
}
