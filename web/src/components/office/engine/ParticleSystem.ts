/**
 * ParticleSystem — 像素粒子特效
 * 数据粒子流、灵气流动、霓虹脉冲
 */
import { Container, Graphics } from 'pixi.js';
import { OFFICE_LAYOUT } from '../assets/officeLayout';
import { OFFICE_THEMES, type OfficeThemeColors } from '../assets/themeColors';

const TILE = 16;

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: number; size: number;
}

export class ParticleSystem {
  private layer: Container;
  private particles: Particle[] = [];
  private pulseGfx: Graphics;
  private particleGfx: Graphics;
  private pulseTimers: Map<string, number> = new Map();
  private theme: 'dark' | 'light' = 'dark';
  private tick = 0;

  constructor(layer: Container, theme: 'dark' | 'light' = 'dark') {
    this.layer = layer;
    this.theme = theme;
    this.pulseGfx = new Graphics();
    this.particleGfx = new Graphics();
    this.layer.addChild(this.pulseGfx);
    this.layer.addChild(this.particleGfx);
  }

  setTheme(theme: 'dark' | 'light'): void { this.theme = theme; }

  update(dt: number): void {
    const c = OFFICE_THEMES[this.theme];
    this.tick += dt;

    // 更新脉冲计时器
    for (const area of OFFICE_LAYOUT.areas) {
      if (!this.pulseTimers.has(area.id)) {
        this.pulseTimers.set(area.id, Math.random() * Math.PI * 2);
      }
      const t = this.pulseTimers.get(area.id)!;
      this.pulseTimers.set(area.id, t + 0.03 * dt);
    }

    // 生成数据粒子（编码区）
    if (Math.random() < 0.12 * dt) {
      const area = OFFICE_LAYOUT.areas.find(a => a.kind === 'coding');
      if (area) {
        const x = (area.bounds.x + 2 + Math.random() * (area.bounds.w - 4)) * TILE;
        const y = (area.bounds.y + area.bounds.h - 1) * TILE;
        this.particles.push({
          x, y, vx: (Math.random() - 0.5) * 0.4, vy: -0.6 - Math.random() * 0.6,
          life: 1, maxLife: 1, color: c.green, size: 1,
        });
      }
    }

    // 生成灵脉粒子（走廊中心）
    if (Math.random() < 0.06 * dt) {
      this.particles.push({
        x: 34 * TILE + 4 + Math.random() * 4,
        y: (15 + Math.random() * 15) * TILE,
        vx: (Math.random() - 0.5) * 0.2, vy: -0.3 - Math.random() * 0.3,
        life: 1, maxLife: 1, color: c.spiritVein, size: 1,
      });
    }

    // 更新粒子位置并清理
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= 0.015 * dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }

    // 限制粒子数量
    if (this.particles.length > 50) {
      this.particles.splice(0, this.particles.length - 50);
    }

    // 渲染辉光脉冲
    this.renderPulses(c);
    // 渲染粒子
    this.renderParticles(c);
  }

  private renderPulses(c: OfficeThemeColors): void {
    this.pulseGfx.clear();
    for (const area of OFFICE_LAYOUT.areas) {
      const timer = this.pulseTimers.get(area.id) || 0;
      const alpha = 0.04 + Math.sin(timer) * 0.03;
      const glow = getGlowForArea(area, c);
      const bx = area.bounds.x * TILE, by = area.bounds.y * TILE;
      const bw = area.bounds.w * TILE, bh = area.bounds.h * TILE;
      this.pulseGfx.rect(bx - 2, by - 2, bw + 4, bh + 4)
        .stroke({ color: glow, alpha: Math.max(0, alpha), width: 1 });
    }
  }

  private renderParticles(c: OfficeThemeColors): void {
    this.particleGfx.clear();
    for (const p of this.particles) {
      const alpha = p.life * 0.7;
      this.particleGfx.rect(p.x, p.y, p.size, p.size)
        .fill({ color: p.color, alpha });
    }
  }

  destroy(): void {
    this.pulseGfx.destroy();
    this.particleGfx.destroy();
    this.particles = [];
    this.pulseTimers.clear();
  }
}

function getGlowForArea(area: typeof OFFICE_LAYOUT.areas[0], c: OfficeThemeColors): number {
  const m: Record<string, number> = {
    lobby: c.glowWood, coding: c.glowWater, planning: c.glowMetal,
    tooling: c.glowEarth, review: c.glowFire, observability: c.glowSpirit,
  };
  return m[area.kind] || c.spiritVein;
}
