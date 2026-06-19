/**
 * StateSync — Zustand → Pixi 场景状态同步桥
 */
import { useSessionStore } from '../../../stores/sessionStore';
import type { OfficeEngine } from '../engine/OfficeEngine';
import { AgentSprite, AgentAnimState } from '../sprites/AgentSprite';
import { OFFICE_LAYOUT } from '../assets/officeLayout';
import { roleMatchesAnyAffinity } from '../assets/roleAffinity';
import { findPath } from '../engine/pathfinding';

export class StateSync {
  private engine: OfficeEngine;
  private unsubscribers: Array<() => void> = [];
  private assignedWs: Map<string, string> = new Map();
  private usedWs: Set<string> = new Set();

  constructor(engine: OfficeEngine) { this.engine = engine; }

  bind(): void {
    this.unsubscribers.push(useSessionStore.subscribe((state) => {
      this.syncAgents(state.agents, state.agentConversations);
    }));
    const st = useSessionStore.getState();
    this.syncAgents(st.agents, st.agentConversations);
  }

  unbind(): void { this.unsubscribers.forEach(fn => fn()); this.unsubscribers = []; }

  private syncAgents(
    agents: Array<{ agentId: string; agentName: string; role: string; status: string }>,
    conversations: Record<string, { status: string }>,
  ): void {
    const curIds = new Set(agents.map(a => a.agentId));
    for (const [id] of this.engine.agents) {
      if (!curIds.has(id)) {
        this.engine.removeAgent(id); const ws = this.assignedWs.get(id);
        if (ws) { this.usedWs.delete(ws); this.assignedWs.delete(id); }
      }
    }
    for (const agent of agents) {
      const e = this.engine.agents.get(agent.agentId);
      if (!e) this.spawnAgent(agent);
      else this.updateAgentState(e, conversations[agent.agentId]?.status || agent.status);
    }
  }

  private spawnAgent(agent: { agentId: string; agentName: string; role: string }): void {
    const s = new AgentSprite(agent.agentId, agent.agentName, agent.role);
    const sp = OFFICE_LAYOUT.spawnPoint; s.setTilePosition(sp.x, sp.y);
    this.engine.addAgent(agent.agentId, s);
    const ws = this.assignWorkstation(agent.agentId, agent.role);
    if (ws) {
      const path = findPath(this.engine.tileMap, sp.x, sp.y, ws.tileX, ws.tileY);
      if (path?.length) { s.path = path; s.pathIndex = 0; s.setState(AgentAnimState.WALKING); }
      else { s.setTilePosition(ws.tileX, ws.tileY); s.setState(AgentAnimState.WORKING); }
    } else s.setState(AgentAnimState.IDLE);
  }

  private assignWorkstation(agentId: string, role?: string): { tileX: number; tileY: number } | null {
    const available = OFFICE_LAYOUT.workstations.filter(w => !this.usedWs.has(w.id));
    if (!available.length) return null;
    if (role) {
      const m = available.find(w => roleMatchesAnyAffinity(role, w.roleAffinity));
      if (m) { this.usedWs.add(m.id); this.assignedWs.set(agentId, m.id); return { tileX: m.tileX, tileY: m.tileY }; }
    }
    const w = available[0];
    this.usedWs.add(w.id); this.assignedWs.set(agentId, w.id);
    return { tileX: w.tileX, tileY: w.tileY };
  }

  private updateAgentState(sprite: AgentSprite, status: string): void {
    switch (status) {
      case 'running': if (sprite.animState !== AgentAnimState.WALKING) sprite.setState(AgentAnimState.WORKING); break;
      case 'completed': sprite.setState(AgentAnimState.COMPLETED); break;
      case 'failed': case 'crashed': case 'timeout': case 'terminated': sprite.setState(AgentAnimState.FAILED); break;
      case 'interrupted': case 'paused': case 'stalled': sprite.setState(AgentAnimState.THINKING); break;
      default: if (sprite.path.length === 0) sprite.setState(AgentAnimState.IDLE);
    }
  }
}
