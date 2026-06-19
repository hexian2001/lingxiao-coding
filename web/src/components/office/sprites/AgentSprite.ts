/**
 * AgentSprite — 32x48 像素角色精灵
 */
import { Container, Sprite, Texture, Text, Graphics } from 'pixi.js';
import { generateCharacterSheet, getColorsForRole, createTexturesFromSheet } from '../assets/generator';
import { TILE_SIZE } from '../engine/TileMap';

export enum AgentAnimState { IDLE='idle', WALKING='walking', WORKING='working', THINKING='thinking', COMPLETED='completed', FAILED='failed' }

const ANIM_FRAMES: Record<AgentAnimState, number[]> = {
  [AgentAnimState.IDLE]: [0, 1], [AgentAnimState.WALKING]: [2, 3], [AgentAnimState.WORKING]: [4, 5],
  [AgentAnimState.THINKING]: [0, 1], [AgentAnimState.COMPLETED]: [0, 0], [AgentAnimState.FAILED]: [0, 0],
};
const ANIM_SPEED: Record<AgentAnimState, number> = {
  [AgentAnimState.IDLE]: 0.02, [AgentAnimState.WALKING]: 0.08, [AgentAnimState.WORKING]: 0.06,
  [AgentAnimState.THINKING]: 0.03, [AgentAnimState.COMPLETED]: 0.01, [AgentAnimState.FAILED]: 0.01,
};

export class AgentSprite {
  container: Container; sprite: Sprite; nameLabel: Text; nameBadge: Graphics; statusBubble: Graphics;
  agentId: string; agentName: string; role: string;
  animState = AgentAnimState.IDLE;
  private textures: Texture[] = []; private frameIndex = 0; private animTimer = 0;

  path: Array<{ x: number; y: number }> = []; pathIndex = 0; speed = 1;
  worldX = 0; worldY = 0; isSelected = false; isDragging = false;
  private chatBubble: Container | null = null; private chatBubbleTimer: number | null = null;

  constructor(agentId: string, agentName: string, role: string) {
    this.agentId = agentId; this.agentName = agentName; this.role = role;
    this.container = new Container(); this.container.eventMode = 'static'; this.container.cursor = 'pointer';

    const colors = getColorsForRole(role);
    const sheet = generateCharacterSheet(colors);
    this.textures = createTexturesFromSheet(sheet);
    this.sprite = new Sprite(this.textures[0]);
    this.sprite.anchor.set(0.5, 1);
    this.container.addChild(this.sprite);

    this.nameLabel = new Text({
      text: this.getDisplayName(),
      style: { fontSize: 10, fontFamily: 'monospace', fill: 0xffffff, align: 'center', fontWeight: 'bold' },
    });
    this.nameLabel.anchor.set(0.5, 0); this.nameLabel.position.set(0, -50);

    this.nameBadge = new Graphics();
    this.nameBadge.roundRect(-this.nameLabel.width / 2 - 2, -51, this.nameLabel.width + 4, this.nameLabel.height + 2, 2).fill({ color: 0x000000, alpha: 0.5 });
    this.container.addChild(this.nameBadge);
    this.container.addChild(this.nameLabel);

    this.statusBubble = new Graphics();
    this.statusBubble.visible = false; this.statusBubble.position.set(8, -54);
    this.container.addChild(this.statusBubble);
  }

  private getDisplayName(): string { return this.agentName.length > 24 ? this.agentName.slice(0, 23) + '…' : this.agentName; }

  setPosition(worldX: number, worldY: number): void { this.worldX = worldX; this.worldY = worldY; this.container.position.set(worldX, worldY); }
  setTilePosition(tileX: number, tileY: number): void { this.setPosition(tileX * TILE_SIZE + TILE_SIZE / 2, tileY * TILE_SIZE + TILE_SIZE); }

  setState(state: AgentAnimState): void {
    if (this.animState === state) return;
    this.animState = state; this.frameIndex = 0; this.animTimer = 0; this.updateStatusBubble();
  }

  updateAnimation(dt: number): void {
    const frames = ANIM_FRAMES[this.animState];
    this.animTimer += ANIM_SPEED[this.animState] * dt;
    if (this.animTimer >= 1) {
      this.animTimer = 0; this.frameIndex = (this.frameIndex + 1) % frames.length;
      const idx = frames[this.frameIndex];
      if (this.textures[idx]) this.sprite.texture = this.textures[idx];
    }
  }

  private updateStatusBubble(): void {
    this.statusBubble.clear();
    switch (this.animState) {
      case AgentAnimState.WORKING: this.statusBubble.circle(0, 0, 3).fill(0x4488cc); this.statusBubble.visible = true; break;
      case AgentAnimState.THINKING: this.statusBubble.circle(0, 0, 3).fill(0xccaa44); this.statusBubble.visible = true; break;
      case AgentAnimState.COMPLETED: this.statusBubble.circle(0, 0, 4).fill(0x44aa66); this.statusBubble.visible = true; break;
      case AgentAnimState.FAILED: this.statusBubble.circle(0, 0, 4).fill(0xcc4444); this.statusBubble.visible = true; break;
      default: this.statusBubble.visible = false;
    }
  }

  showChatBubble(text: string, duration = 3000): void {
    if (this.chatBubble) { this.container.removeChild(this.chatBubble); this.chatBubble.destroy({ children: true }); this.chatBubble = null; }
    if (this.chatBubbleTimer !== null) { clearTimeout(this.chatBubbleTimer); this.chatBubbleTimer = null; }
    const displayText = text.length > 20 ? text.slice(0, 20) + '...' : text;
    const bubble = new Container(), label = new Text({ text: displayText, style: { fontSize: 6, fontFamily: 'monospace', fill: 0x000000, align: 'center' } });
    label.anchor.set(0.5, 0.5);
    const pad = 4, bw = label.width + pad * 2, bh = label.height + pad * 2;
    const bg = new Graphics(); bg.roundRect(-bw / 2, -bh / 2, bw, bh, 3).fill(0xffffff); bg.moveTo(-3, bh / 2).lineTo(0, bh / 2 + 4).lineTo(3, bh / 2).fill(0xffffff);
    bubble.addChild(bg); bubble.addChild(label); bubble.position.set(0, -58);
    this.chatBubble = bubble; this.container.addChild(bubble);
    this.chatBubbleTimer = setTimeout(() => {
      if (this.chatBubble) { this.chatBubble.visible = false; this.container.removeChild(this.chatBubble); this.chatBubble.destroy({ children: true }); this.chatBubble = null; }
      this.chatBubbleTimer = null;
    }, duration) as unknown as number;
  }

  setSelected(selected: boolean): void {
    this.isSelected = selected;
    this.nameBadge.clear();
    if (selected) {
      this.nameLabel.style.fill = 0x44ccff;
      this.nameBadge.roundRect(-this.nameLabel.width / 2 - 2, -51, this.nameLabel.width + 4, this.nameLabel.height + 2, 2).fill({ color: 0x224466, alpha: 0.8 });
    } else {
      this.nameLabel.style.fill = 0xffffff;
      this.nameBadge.roundRect(-this.nameLabel.width / 2 - 2, -51, this.nameLabel.width + 4, this.nameLabel.height + 2, 2).fill({ color: 0x000000, alpha: 0.5 });
    }
  }

  getBounds() { return { x: this.worldX - 16, y: this.worldY - 48, width: 32, height: 48 }; }
  destroy(): void { this.container.destroy({ children: true }); }
}
