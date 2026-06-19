import type { ChildProcess } from 'child_process';
import type { CoreExternalAgentStatus } from '../../contracts/adapters/StatusAdapter.js';

export type ExternalBackend = 'claude' | 'codex';

export interface ExternalArtifactTrace {
  files_created?: string[];
  files_modified?: string[];
  commands_run?: string[];
}

export interface ExternalModelConfig {
  id: string;
  apiModel: string;
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  envKey: string;
  apiKey: string;
  wireApi?: 'chat' | 'responses';
  reasoningEffort?: string;
  disableResponseStorage?: boolean;
  networkAccess?: 'enabled' | 'disabled' | 'restricted';
}

export interface ExternalAgentInput {
  agentId: string;
  agentName: string;
  sessionId: string;
  taskId: string;
  prompt: string;
  systemPrompt: string;
  workingDirectory: string;
  workspace: string;
  writeScope: string[];
  model: ExternalModelConfig;
  timeoutMs: number;
  idleTimeoutMs: number;
  extraArgs?: string[];
  extraEnv?: Record<string, string>;
  logDir: string;
}

export type ExternalEvent =
  | { kind: 'started'; sessionId: string }
  | { kind: 'status'; phase: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'text_full'; text: string }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'tool_call'; toolCallId: string; name: string; input?: unknown }
  | { kind: 'tool_result'; toolCallId: string; tool?: string; output: string; isError?: boolean }
  | { kind: 'usage'; prompt: number; completion: number; total: number; cacheRead?: number; cacheCreation?: number }
  | { kind: 'complete'; result: string; durationMs?: number; modelUsage?: Record<string, unknown> }
  | { kind: 'error'; message: string; fatal: boolean };

export interface ExternalExecutionPlan {
  command: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  sessionIdHint?: string;
}

export interface ExternalDriver {
  readonly type: ExternalBackend;
  buildExecute(input: ExternalAgentInput): ExternalExecutionPlan;
  parseStdoutLine(line: string): ExternalEvent[];
  parseStderrLine(line: string): ExternalEvent[];
  finalizeResult(events: ExternalEvent[], exitCode: number | null, signal: NodeJS.Signals | null): string;
}

export interface ExternalAgentProcessHandle {
  agentId: string;
  agentName: string;
  taskId: string;
  backend: ExternalBackend;
  process: ChildProcess;
  startTime: number;
  endTime?: number;
  status: CoreExternalAgentStatus;
  externalSessionId?: string;
  pid?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  result?: string;
  error?: Error;
  logPath?: string;
  stderrLogPath?: string;
  lastEventAt: number;
  recentStdoutTail: string[];
  recentStderrTail: string[];
}

export interface ExternalRunResult {
  result: string;
  backend: ExternalBackend;
  externalSessionId?: string;
  pid?: number;
  logPath?: string;
  stderrLogPath?: string;
  stdoutTail: string[];
  stderrTail: string[];
  tokenUsage?: { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number };
  toolTrace?: ExternalArtifactTrace;
}
