import type { CommandLogMessage } from '../../commands/types.js';
import type { WorkerBackend } from '../../contracts/types/Agent.js';
import type { AgentRunStatus } from '../../contracts/types/Status.js';

export type UiStreamingState = 'idle' | 'responding' | 'waiting_for_confirmation';

export interface AgentRuntimeDiagnostic {
  lastHeartbeatAt?: number;
  heartbeatPhase?: string;
  lastToolName?: string;
  lastToolAt?: number;
  lastTextAt?: number;
  lastProgressMessage?: string;
  lastProgressAt?: number;
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
  logPath?: string;
  recoverable?: boolean;
  recoveryAction?: string;
  stderrTail?: string[];
  stdoutTail?: string[];
}

export interface ApprovalBannerState {
  requestId?: string;
  source: string;
  workerName?: string;
  toolName: string;
  reason: string;
}

export interface ChannelState {
  name: string;
  role?: string;
  taskId?: string;
  status: AgentRunStatus;
  statusText?: string;
  streamingState: UiStreamingState;
  currentNext?: string;
  messages: CommandLogMessage[];
  currentStream?: string;
  currentThinkingStream?: string;
  stats?: { iterations: number; toolCalls: number };
}
