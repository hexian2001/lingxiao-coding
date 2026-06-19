/**
 * AnimationSystem — 动画帧更新
 */
import type { OfficeEngine } from '../engine/OfficeEngine';
export class AnimationSystem { private engine: OfficeEngine; constructor(engine: OfficeEngine) { this.engine = engine; } update(dt: number): void { for (const [, agent] of this.engine.agents) agent.updateAnimation(dt); } }
