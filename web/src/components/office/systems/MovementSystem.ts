/**
 * MovementSystem — 角色移动
 */
import type { OfficeEngine } from '../engine/OfficeEngine';
import { AgentAnimState } from '../sprites/AgentSprite';
import { TILE_SIZE } from '../engine/TileMap';

export class MovementSystem {
  private engine: OfficeEngine;
  constructor(engine: OfficeEngine) { this.engine = engine; }

  update(_dt: number): void {
    for (const sprite of this.engine.agents.values()) {
      if (sprite.isDragging) continue;
      if (sprite.path.length > 0 && sprite.pathIndex < sprite.path.length) {
        const target = sprite.path[sprite.pathIndex];
        const tx = target.x * TILE_SIZE + TILE_SIZE / 2;
        const ty = target.y * TILE_SIZE + TILE_SIZE;
        const dx = tx - sprite.worldX, dy = ty - sprite.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.5) {
          sprite.pathIndex++;
          if (sprite.pathIndex >= sprite.path.length) {
            sprite.path = []; sprite.pathIndex = 0;
            if (sprite.animState !== AgentAnimState.COMPLETED && sprite.animState !== AgentAnimState.FAILED) {
              sprite.setState(AgentAnimState.WORKING);
            }
          }
        } else {
          const step = Math.min(dist, sprite.speed);
          sprite.setPosition(sprite.worldX + (dx / dist) * step, sprite.worldY + (dy / dist) * step);
        }
      }
    }
  }
}
