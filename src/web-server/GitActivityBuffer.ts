/**
 * GitActivityBuffer — in-memory ring buffer for git:activity events.
 *
 * Listens to the EventEmitter for 'git:activity' and retains the last N events
 * per session. Exposes a REST API at /api/v1/git/activity/:sessionId so the
 * frontend can fetch history on connect / session switch instead of losing
 * everything when the SSE store is cleared.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EventEmitter } from '../core/EventEmitter.js';

export interface GitActivityRecord {
  id?: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  taskId?: string;
  action: 'commit' | 'push' | 'pull' | 'branch_create' | 'branch_switch' | 'merge_mr' | 'create_mr';
  success: boolean;
  timestamp: number;
  commitHash?: string;
  commitMessage?: string;
  author?: { name: string; email: string };
  branch?: string;
  gateResult?: { passed: boolean; enabled: boolean; diagnostics: string[] };
  error?: string;
}

const MAX_EVENTS_PER_SESSION = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export class GitActivityBuffer {
  /** sessionId → events array (most recent last) */
  private store = new Map<string, GitActivityRecord[]>();
  private unsub: (() => void) | null = null;

  start(emitter: EventEmitter): void {
    if (this.unsub) return;
    this.unsub = emitter.subscribe('git:activity', (data) => {
      this.addEvent(data as GitActivityRecord);
    });
  }

  stop(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  private addEvent(rec: GitActivityRecord): void {
    const sid = rec.sessionId;
    if (!sid) return;
    const arr = this.store.get(sid) ?? [];
    arr.push({ ...rec });
    // cap
    if (arr.length > MAX_EVENTS_PER_SESSION) {
      arr.splice(0, arr.length - MAX_EVENTS_PER_SESSION);
    }
    // prune old
    const cutoff = Date.now() - MAX_AGE_MS;
    while (arr.length > 0 && arr[0].timestamp < cutoff) {
      arr.shift();
    }
    this.store.set(sid, arr);
  }

  getEvents(sessionId: string): GitActivityRecord[] {
    return [...(this.store.get(sessionId) ?? [])].map((rec, i) => ({
      ...rec,
      id: rec.id ?? `${rec.sessionId}-${rec.timestamp}-${i}`,
    }));
  }

  registerRoutes(
    fastify: FastifyInstance,
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => boolean,
  ): void {
    // GET /api/v1/git/activity/:sessionId — fetch buffered git activity events
    fastify.get('/api/v1/git/activity/:sessionId', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { sessionId } = request.params as { sessionId: string };
      if (!sessionId) {
        reply.status(400).send({ error: 'sessionId is required' });
        return;
      }
      return { data: this.getEvents(sessionId) };
    });
  }
}
