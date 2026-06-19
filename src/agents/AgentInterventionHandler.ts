import type { BusMessage, MessageBus, MessagePriority } from '../core/MessageBus.js';

type LoggerLike = {
  info?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
};

type PriorityEventSource = {
  subscribe: (event: 'message:bus:priority', handler: (data: unknown) => void) => () => void;
};

export interface AgentInterventionHandlerDeps {
  bus?: MessageBus;
  agentId: string;
  busName?: string;
  logger?: LoggerLike;
  events?: PriorityEventSource;
}

export class AgentInterventionHandler {
  private readonly bus?: MessageBus;
  private readonly agentId: string;
  private readonly busName?: string;
  private readonly logger?: LoggerLike;
  private readonly events?: PriorityEventSource;
  private abortController: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: AgentInterventionHandlerDeps) {
    this.bus = deps.bus;
    this.agentId = deps.agentId;
    this.busName = deps.busName;
    this.logger = deps.logger;
    this.events = deps.events;
  }

  attach(abortController: AbortController): void {
    this.detach();
    this.abortController = abortController;
    if (!this.events) {
      return;
    }
    this.unsubscribe = this.events.subscribe('message:bus:priority', (data) => {
      if (this.shouldAbort(data as BusMessage)) {
        this.logger?.info?.(`[Intervention] aborting LLM for agent ${this.agentId}`);
        this.abortController?.abort('agent intervention');
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.abortController = null;
  }

  shouldAbort(message: (Partial<BusMessage> & { priority?: MessagePriority | number }) | undefined): boolean {
    if (!message) {
      return false;
    }
    if (message.priority !== undefined && message.priority !== 0) {
      return false;
    }
    const isAction = message.type === 'user_intervention' || message.type === 'force_terminate';
    if (!isAction) {
      return false;
    }
    if (!this.busName) {
      return true;
    }
    return message.to === this.busName;
  }

  pollForIntervention(): BusMessage[] {
    if (!this.bus || !this.busName) {
      return [];
    }
    return this.bus.poll(this.busName).filter((msg) => this.shouldAbort(msg));
  }
}

export default AgentInterventionHandler;
