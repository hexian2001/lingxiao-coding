import { randomUUID } from 'crypto';
import { PHASE_POLICIES } from './PhasePolicy.js';

// ── Core Types ──

export type ExecutionPhase =
  | 'idle'
  | 'llm_call'
  | 'tool_execution'
  | 'tool_quiet'
  | 'recovering'
  | 'waiting_for_user';

export type Interruptibility = 'immediate' | 'safe_point' | 'not_interruptible';

export interface LeaseMetadata {
  toolName?: string;
  llmModel?: string;
  shellPid?: number;
  roundNumber?: number;
}

export interface ExecutionLease {
  leaseId: string;
  owner: string;
  phase: ExecutionPhase;
  interruptibility: Interruptibility;
  acquiredAt: number;
  expiresAt: number;
  lastMeaningfulEvent: number;
  metadata?: LeaseMetadata;
}

export interface LeaseTransition {
  leaseId: string;
  owner: string;
  from: ExecutionPhase;
  to: ExecutionPhase;
  timestamp: number;
}

// ── LeaseStore ──

export class LeaseStore {
  private leases = new Map<string, ExecutionLease>();
  private ownerIndex = new Map<string, string>(); // owner → leaseId
  private listeners = new Set<(transition: LeaseTransition) => void>();

  acquire(owner: string, phase: ExecutionPhase, ttlMs?: number, metadata?: LeaseMetadata): ExecutionLease {
    // Release existing lease for this owner if any
    const existing = this.ownerIndex.get(owner);
    if (existing) this.release(existing);

    const policy = PHASE_POLICIES[phase];
    const now = Date.now();
    const effectiveTtl = ttlMs ?? policy.defaultTtlMs;

    const lease: ExecutionLease = {
      leaseId: randomUUID(),
      owner,
      phase,
      interruptibility: policy.interruptibility,
      acquiredAt: now,
      expiresAt: effectiveTtl === Infinity ? Infinity : now + effectiveTtl,
      lastMeaningfulEvent: now,
      metadata,
    };

    this.leases.set(lease.leaseId, lease);
    this.ownerIndex.set(owner, lease.leaseId);
    this.notify({ leaseId: lease.leaseId, owner, from: 'idle', to: phase, timestamp: now });
    return lease;
  }
  renew(leaseId: string, ttlMs: number): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    const policy = PHASE_POLICIES[lease.phase];
    if (!policy.renewalAllowed) return false;
    const now = Date.now();
    lease.expiresAt = ttlMs === Infinity ? Infinity : now + ttlMs;
    lease.lastMeaningfulEvent = now;
    return true;
  }

  transition(leaseId: string, newPhase: ExecutionPhase, newTtlMs?: number, metadata?: LeaseMetadata): LeaseTransition | null {
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    const oldPhase = lease.phase;
    if (oldPhase === newPhase) return null;

    const policy = PHASE_POLICIES[newPhase];
    const now = Date.now();
    const effectiveTtl = newTtlMs ?? policy.defaultTtlMs;

    lease.phase = newPhase;
    lease.interruptibility = policy.interruptibility;
    lease.expiresAt = effectiveTtl === Infinity ? Infinity : now + effectiveTtl;
    lease.lastMeaningfulEvent = now;
    if (metadata) lease.metadata = { ...lease.metadata, ...metadata };

    const t: LeaseTransition = { leaseId, owner: lease.owner, from: oldPhase, to: newPhase, timestamp: now };
    this.notify(t);
    return t;
  }

  release(leaseId: string): LeaseTransition | null {
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    const oldPhase = lease.phase;
    this.leases.delete(leaseId);
    this.ownerIndex.delete(lease.owner);
    const t: LeaseTransition = { leaseId, owner: lease.owner, from: oldPhase, to: 'idle', timestamp: Date.now() };
    this.notify(t);
    return t;
  }

  get(owner: string): ExecutionLease | undefined {
    const id = this.ownerIndex.get(owner);
    return id ? this.leases.get(id) : undefined;
  }

  getByLeaseId(leaseId: string): ExecutionLease | undefined {
    return this.leases.get(leaseId);
  }

  getAll(): ExecutionLease[] {
    return [...this.leases.values()];
  }

  getPhase(owner: string): ExecutionPhase {
    return this.get(owner)?.phase ?? 'idle';
  }

  isInterruptible(owner: string): boolean {
    const lease = this.get(owner);
    if (!lease) return true; // no lease = idle = interruptible
    return lease.interruptibility === 'immediate';
  }

  isExpired(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return true;
    if (lease.expiresAt === Infinity) return false;
    return Date.now() > lease.expiresAt;
  }

  getActiveOwners(): string[] {
    return [...this.ownerIndex.keys()];
  }

  onTransition(listener: (transition: LeaseTransition) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Touch lastMeaningfulEvent without changing phase */
  touch(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (lease) lease.lastMeaningfulEvent = Date.now();
  }

  private notify(transition: LeaseTransition): void {
    for (const listener of this.listeners) {
      try { listener(transition); } catch { /* swallow listener errors */ }
    }
  }
}
