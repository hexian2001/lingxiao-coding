/**
 * OfficeEngine — PixiJS Application 生命周期管理
 */
import { Application, Container } from 'pixi.js';
import { Camera } from './Camera';
import { TileMap } from './TileMap';
import { InputManager } from './InputManager';
import { MovementSystem } from '../systems/MovementSystem';
import { AnimationSystem } from '../systems/AnimationSystem';
import { InteractionSystem } from '../systems/InteractionSystem';
import { ParticleSystem } from './ParticleSystem';
import { OFFICE_THEMES } from '../assets/themeColors';
import type { AgentSprite } from '../sprites/AgentSprite';

export class OfficeEngine {
  app!: Application; camera!: Camera; tileMap!: TileMap; inputManager!: InputManager;
  backgroundLayer!: Container; tileMapLayer!: Container; furnitureLayer!: Container;
  agentLayer!: Container; effectsLayer!: Container; uiLayer!: Container;
  movementSystem!: MovementSystem; animationSystem!: AnimationSystem; interactionSystem!: InteractionSystem;
  particleSystem!: ParticleSystem;
  agents: Map<string, AgentSprite> = new Map();

  private _container: HTMLElement | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _destroyed = false;
  private _theme: 'dark' | 'light' = 'dark';

  async init(container: HTMLElement, theme: 'dark' | 'light' = 'dark'): Promise<void> {
    this._container = container; this._theme = theme;
    const bgColor = OFFICE_THEMES[theme].background;

    this.app = new Application();
    await this.app.init({
      background: bgColor, resizeTo: container,
      antialias: true, roundPixels: false,
      resolution: Math.min(2, typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1),
      autoDensity: true,
    });
    container.appendChild(this.app.canvas as HTMLCanvasElement);

    this.backgroundLayer = new Container(); this.tileMapLayer = new Container();
    this.furnitureLayer = new Container(); this.agentLayer = new Container();
    this.effectsLayer = new Container(); this.uiLayer = new Container();
    this.app.stage.addChild(this.backgroundLayer, this.tileMapLayer, this.furnitureLayer, this.agentLayer, this.effectsLayer, this.uiLayer);

    this.tileMap = new TileMap(this.tileMapLayer, this.furnitureLayer, this._theme);
    await this.tileMap.init();

    this.camera = new Camera(this.app, this.tileMapLayer, this.tileMap.width, this.tileMap.height);
    this.inputManager = new InputManager(this.app, this.camera);
    this.movementSystem = new MovementSystem(this);
    this.animationSystem = new AnimationSystem(this);
    this.interactionSystem = new InteractionSystem(this);
    this.particleSystem = new ParticleSystem(this.effectsLayer, this._theme);

    this.app.ticker.add((ticker) => {
      if (this._destroyed) return;
      const dt = ticker.deltaTime;
      this.movementSystem.update(dt); this.animationSystem.update(dt); this.particleSystem.update(dt);
    });

    this._resizeObserver = new ResizeObserver(() => { if (!this._destroyed) { this.app.resize(); this.camera.onResize(); } });
    this._resizeObserver.observe(container);
  }

  getAgentLayer(): Container { return this.agentLayer; }

  setTheme(theme: 'dark' | 'light'): void {
    if (this._theme === theme) return;
    this._theme = theme;
    this.app.renderer.background.color = OFFICE_THEMES[theme].background;
    this.tileMap.rerender(theme);
    this.particleSystem.setTheme(theme);
  }

  addAgent(id: string, sprite: AgentSprite): void {
    this.agents.set(id, sprite); this.agentLayer.addChild(sprite.container);
  }
  removeAgent(id: string): void {
    const sprite = this.agents.get(id);
    if (sprite) { this.agentLayer.removeChild(sprite.container); sprite.destroy(); this.agents.delete(id); }
  }
  destroy(): void {
    this._destroyed = true;
    this._resizeObserver?.disconnect(); this._resizeObserver = null;
    this.interactionSystem.destroy();
    this.particleSystem.destroy();
    this.agents.forEach(s => s.destroy()); this.agents.clear();
    this.app.destroy(true, { children: true });
    if (this._container) { this._container.innerHTML = ''; this._container = null; }
  }
}
