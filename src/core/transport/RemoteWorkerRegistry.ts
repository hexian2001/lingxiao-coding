export interface RemoteWorkerDescriptor {
  id: string;
  endpoint: string;
  capabilities: string[];
  maxConcurrency: number;
  currentLoad: number;
  region?: string;
  lastHeartbeat: number;
}

export interface RemoteWorkerRequirements {
  tools?: string[];
  preferLocal?: boolean;
}

export class RemoteWorkerRegistry {
  private readonly workers = new Map<string, RemoteWorkerDescriptor>();

  register(descriptor: RemoteWorkerDescriptor): void {
    this.workers.set(descriptor.id, {
      ...descriptor,
      capabilities: [...descriptor.capabilities],
      currentLoad: Math.max(0, descriptor.currentLoad),
      maxConcurrency: Math.max(1, descriptor.maxConcurrency),
      lastHeartbeat: descriptor.lastHeartbeat || Date.now(),
    });
  }

  deregister(workerId: string): void {
    this.workers.delete(workerId);
  }

  findWorker(requirements: RemoteWorkerRequirements): RemoteWorkerDescriptor | null {
    if (requirements.preferLocal) return null;
    const required = new Set(requirements.tools ?? []);
    const candidates = this.getAliveWorkers()
      .filter((worker) => worker.currentLoad < worker.maxConcurrency)
      .filter((worker) => {
        if (required.size === 0) return true;
        const caps = new Set(worker.capabilities);
        for (const tool of required) {
          if (!caps.has(tool)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const loadA = a.currentLoad / a.maxConcurrency;
        const loadB = b.currentLoad / b.maxConcurrency;
        if (loadA !== loadB) return loadA - loadB;
        return b.lastHeartbeat - a.lastHeartbeat;
      });
    return candidates[0] ?? null;
  }

  getAliveWorkers(maxAge = 60_000): RemoteWorkerDescriptor[] {
    const cutoff = Date.now() - maxAge;
    return Array.from(this.workers.values())
      .filter((worker) => worker.lastHeartbeat >= cutoff)
      .map((worker) => ({ ...worker, capabilities: [...worker.capabilities] }));
  }

  markHeartbeat(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) worker.lastHeartbeat = Date.now();
  }

  markAssigned(workerId: string): RemoteWorkerDescriptor | null {
    const worker = this.workers.get(workerId);
    if (!worker) return null;
    worker.currentLoad = Math.min(worker.maxConcurrency, worker.currentLoad + 1);
    return { ...worker, capabilities: [...worker.capabilities] };
  }

  markReleased(workerId: string): RemoteWorkerDescriptor | null {
    const worker = this.workers.get(workerId);
    if (!worker) return null;
    worker.currentLoad = Math.max(0, worker.currentLoad - 1);
    return { ...worker, capabilities: [...worker.capabilities] };
  }

  pruneStale(maxAge: number): string[] {
    const cutoff = Date.now() - maxAge;
    const pruned: string[] = [];
    for (const [id, worker] of this.workers.entries()) {
      if (worker.lastHeartbeat < cutoff) {
        this.workers.delete(id);
        pruned.push(id);
      }
    }
    return pruned;
  }
}
