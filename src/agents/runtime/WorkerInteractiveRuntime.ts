export interface WorkerPendingApproval {
  requestId: string;
  toolName: string;
  reason: string;
  source: 'leader' | 'worker';
  workerName?: string;
  requestedMode?: string;
  updatedAt: number;
}

export interface WorkerLiveOutput {
  key: string;
  toolName: string;
  content: string;
  stream: 'stdout' | 'stderr';
  updatedAt: number;
  pid?: number;
}

export interface TerminalSessionInfo {
  terminalId: string;
  pid?: number;
  status: string;
  command: string;
  lastOutputAt?: number;
}

export interface WorkerInteractiveRuntimeSnapshot {
  agentId: string;
  agentName: string;
  status: string;
  queuedMessages: string[];
  pendingApprovals: WorkerPendingApproval[];
  liveOutputs: WorkerLiveOutput[];
  shellPids: Record<string, number>;
  terminalSessions: TerminalSessionInfo[];
  lastProgressMessage?: string;
  lastProgressAt?: number;
}

export class WorkerInteractiveRuntime {
  private readonly agentId: string;
  private readonly agentName: string;
  private status = 'starting';
  private queuedMessages: string[] = [];
  private pendingApprovals = new Map<string, WorkerPendingApproval>();
  private liveOutputs = new Map<string, WorkerLiveOutput>();
  private shellPids = new Map<string, number>();
  private terminalSessions = new Map<string, TerminalSessionInfo>();
  private lastProgressMessage?: string;
  private lastProgressAt?: number;

  constructor(agentId: string, agentName: string) {
    this.agentId = agentId;
    this.agentName = agentName;
  }

  setStatus(status: string): void {
    this.status = status;
  }

  getStatus(): string {
    return this.status;
  }

  enqueueMessage(message: string): void {
    this.queuedMessages.push(message);
  }

  clearQueuedMessages(): void {
    this.queuedMessages = [];
  }

  noteProgress(message: string): void {
    this.lastProgressMessage = message;
    this.lastProgressAt = Date.now();
  }

  addPendingApproval(input: {
    requestId: string;
    toolName: string;
    reason: string;
    source: 'leader' | 'worker';
    workerName?: string;
    requestedMode?: string;
  }): void {
    this.pendingApprovals.set(input.requestId, {
      ...input,
      updatedAt: Date.now(),
    });
  }

  resolvePendingApproval(requestId: string): void {
    this.pendingApprovals.delete(requestId);
  }

  /** 单个 liveOutput 条目的最大内容长度（1MB） */
  private static readonly MAX_OUTPUT_CONTENT_LENGTH = 1024 * 1024;
  /** liveOutputs Map 的最大条目数 */
  private static readonly MAX_LIVE_OUTPUTS = 100;

  updateToolOutput(input: {
    key: string;
    toolName: string;
    chunk: string;
    stream: 'stdout' | 'stderr';
    pid?: number;
  }): void {
    const existing = this.liveOutputs.get(input.key);
    let nextContent = `${existing?.content || ''}${input.chunk}`;
    // 限制单条内容长度：超出时截断旧内容
    if (nextContent.length > WorkerInteractiveRuntime.MAX_OUTPUT_CONTENT_LENGTH) {
      nextContent = nextContent.slice(-WorkerInteractiveRuntime.MAX_OUTPUT_CONTENT_LENGTH);
    }
    this.liveOutputs.set(input.key, {
      key: input.key,
      toolName: input.toolName,
      content: nextContent,
      stream: input.stream,
      updatedAt: Date.now(),
      pid: input.pid ?? existing?.pid,
    });
    // 限制总条目数：淘汰最旧的条目
    if (this.liveOutputs.size > WorkerInteractiveRuntime.MAX_LIVE_OUTPUTS) {
      const oldest = this.liveOutputs.keys().next().value;
      if (oldest) this.liveOutputs.delete(oldest);
    }
    if (typeof input.pid === 'number') {
      this.shellPids.set(input.key, input.pid);
    }
  }

  setShellPid(key: string, pid?: number): void {
    if (typeof pid === 'number') {
      this.shellPids.set(key, pid);
      const existing = this.liveOutputs.get(key);
      if (existing) {
        this.liveOutputs.set(key, { ...existing, pid, updatedAt: Date.now() });
      }
    }
  }

  clearToolOutput(key: string): void {
    this.liveOutputs.delete(key);
    this.shellPids.delete(key);
  }

  clearAllToolOutputs(): void {
    this.liveOutputs.clear();
    this.shellPids.clear();
  }

  addTerminalSession(session: TerminalSessionInfo): void {
    this.terminalSessions.set(session.terminalId, session);
  }

  updateTerminalSession(terminalId: string, update: { status?: string; pid?: number; lastOutputAt?: number }): void {
    const session = this.terminalSessions.get(terminalId);
    if (!session) return;
    if (update.status !== undefined) session.status = update.status;
    if (update.pid !== undefined) session.pid = update.pid;
    if (update.lastOutputAt !== undefined) session.lastOutputAt = update.lastOutputAt;
  }

  removeTerminalSession(terminalId: string): void {
    this.terminalSessions.delete(terminalId);
  }

  clearAllTerminalSessions(): void {
    this.terminalSessions.clear();
  }

  getSnapshot(): WorkerInteractiveRuntimeSnapshot {
    return {
      agentId: this.agentId,
      agentName: this.agentName,
      status: this.status,
      queuedMessages: [...this.queuedMessages],
      pendingApprovals: [...this.pendingApprovals.values()],
      liveOutputs: [...this.liveOutputs.values()],
      shellPids: Object.fromEntries(this.shellPids.entries()),
      terminalSessions: [...this.terminalSessions.values()],
      lastProgressMessage: this.lastProgressMessage,
      lastProgressAt: this.lastProgressAt,
    };
  }
}
