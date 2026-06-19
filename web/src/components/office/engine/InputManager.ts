/**
 * InputManager — 鼠标/触摸事件
 */
import { Application } from 'pixi.js';
import { Camera } from './Camera';

export class InputManager {
  private app: Application; private camera: Camera;
  private isDragging = false; private lastX = 0; private lastY = 0;
  isDraggingAgent = false;

  private _onWheel: (e: WheelEvent) => void;
  private _onPointerDown: (e: PointerEvent) => void;
  private _onPointerMove: (e: PointerEvent) => void;
  private _onPointerUp: (e: PointerEvent) => void;

  constructor(app: Application, camera: Camera) {
    this.app = app; this.camera = camera;
    const canvas = app.canvas as HTMLCanvasElement;
    this._onWheel = this.onWheel.bind(this);
    this._onPointerDown = this.onPointerDown.bind(this);
    this._onPointerMove = this.onPointerMove.bind(this);
    this._onPointerUp = this.onPointerUp.bind(this);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointerleave', this._onPointerUp);
  }

  private onWheel(e: WheelEvent): void { e.preventDefault(); this.camera.zoomAt(e.deltaY, e.offsetX, e.offsetY); }

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 1 || e.button === 2 || e.button === 0) {
      this.isDragging = true; this.lastX = e.clientX; this.lastY = e.clientY;
      if (e.button !== 0) e.preventDefault();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.isDragging || this.isDraggingAgent) return;
    const dx = (e.clientX - this.lastX) / this.camera.zoom;
    const dy = (e.clientY - this.lastY) / this.camera.zoom;
    this.camera.pan(dx, dy);
    this.lastX = e.clientX; this.lastY = e.clientY;
  }

  private onPointerUp(): void { this.isDragging = false; }

  destroy(): void {
    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.removeEventListener('wheel', this._onWheel); canvas.removeEventListener('pointerdown', this._onPointerDown);
    canvas.removeEventListener('pointermove', this._onPointerMove); canvas.removeEventListener('pointerup', this._onPointerUp);
    canvas.removeEventListener('pointerleave', this._onPointerUp);
  }
}
