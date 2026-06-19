export type JsonSchema = Record<string, unknown>;
export type ToolScope = 'worker' | 'leader' | 'both';

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolServices {
  db?: unknown;
  emitter?: unknown;
  bus?: unknown;
  llm?: unknown;
  blackboard?: unknown;
  assumptionTracker?: unknown;
}

export interface LeaderToolsExecutorContract {
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface ToolContext {
  workspace?: string;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  toolCallId?: string;
  taskId?: string;
  taskWorkingDirectory?: string;
  taskWriteScope?: string[];
  abortSignal?: AbortSignal;
  permissionContext?: unknown;
  model?: string;
  db?: unknown;
  emitter?: unknown;
  bus?: unknown;
  llm?: unknown;
  blackboardGraph?: unknown;
  assumptionTracker?: unknown;
  assumptionFeedback?: unknown;
  leaderToolsExecutor?: LeaderToolsExecutorContract;
  services?: ToolServices;
  [key: string]: unknown;
}

export interface ToolContract {
  readonly name: string;
  readonly description: string;
  readonly scope?: ToolScope;
  readonly schema?: JsonSchema;
  readonly input_schema?: JsonSchema;
  readonly parameters?: unknown;
  getSchema?(): JsonSchema;
  getExecutionTimeoutMs?(args: unknown, context?: ToolContext): number | null | undefined;
  execute(args: unknown, context?: ToolContext): Promise<ToolResult | unknown> | ToolResult | unknown;
}

export interface ToolRegistryContract {
  get(name: string): ToolContract | undefined;
}

export function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as ToolResult).success === 'boolean'
  );
}

export function normalizeToolResult(value: unknown): ToolResult {
  return isToolResult(value) ? value : { success: true, data: value };
}
