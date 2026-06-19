/**
 * MCP Forge 核心类型定义
 *
 * 契约: contract:mcp-forge-core v1 §1
 */

// ── 状态枚举 ──────────────────────────────────────────────────────────────

export type ForgeJobState =
  | 'pending'
  | 'analyzing'
  | 'analyzed'
  | 'generating'
  | 'generated'
  | 'validating'
  | 'validation_skipped'
  | 'validated'
  | 'registering'
  | 'registered'
  | 'completed'
  | 'analysis_failed'
  | 'generation_failed'
  | 'validation_failed'
  | 'registration_failed'
  | 'cancelled';

export const TERMINAL_STATES: ReadonlySet<ForgeJobState> = new Set([
  'completed',
  'analysis_failed',
  'generation_failed',
  'validation_failed',
  'registration_failed',
  'cancelled',
]);

// ── 用户请求 ──────────────────────────────────────────────────────────────

export interface ForgeOptions {
  transport?: 'stdio' | 'streamable-http';
  skipValidation?: boolean;
  skipInspector?: boolean;
  sandboxTimeoutMs?: number;
  llmModel?: string;
  customEnv?: Record<string, string>;
  autoRegister?: boolean;
}

export interface ForgeRequest {
  description: string;
  serverName: string;
  templateId?: string;
  options?: ForgeOptions;
}

// ── 需求分析 ──────────────────────────────────────────────────────────────

export interface ForgeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ForgeAnalysis {
  templateId: 'python-fastmcp-stdio' | 'nodejs-stdio' | 'http-api-wrapper';
  serverName: string;
  serverId: string;
  tools: ForgeToolSpec[];
  resources?: Array<{ uri: string; name: string; description?: string }>;
  transport: 'stdio' | 'streamable-http';
  summary: string;
  rawResponse?: string;
}

// ── 生成代码 ──────────────────────────────────────────────────────────────

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedCode {
  files: GeneratedFile[];
  outputDir: string;
  entryPoint: string;
  language: 'python' | 'typescript';
  templateId: string;
}

// ── 验证结果 ──────────────────────────────────────────────────────────────

export interface InspectorToolResult {
  name: string;
  description?: string;
  callSuccess: boolean;
  callResult?: string;
  callError?: string;
}

export interface ValidationResult {
  sandboxCompiled: boolean;
  sandboxStarted: boolean;
  inspectorConnected: boolean;
  toolsDiscovered: InspectorToolResult[];
  errors: string[];
  warnings: string[];
  duration: number;
}

// ── 注册结果 ──────────────────────────────────────────────────────────────

export interface RegisteredServer {
  serverId: string;
  transport: 'stdio' | 'streamable-http';
  config: Record<string, unknown>;
  registeredAt: number;
}

// ── 错误 ──────────────────────────────────────────────────────────────────

export interface ForgeErrorData {
  code: string;
  message: string;
  phase?: ForgeJobState;
  detail?: string;
  retryable: boolean;
}

// ── 步骤历史 ──────────────────────────────────────────────────────────────

export interface ForgeStepRecord {
  state: ForgeJobState;
  timestamp: number;
  success: boolean;
  detail?: string;
}

// ── ForgeJob ──────────────────────────────────────────────────────────────

export interface ForgeJob {
  id: string;
  state: ForgeJobState;
  request: ForgeRequest;
  analysis?: ForgeAnalysis;
  generatedCode?: GeneratedCode;
  validationResult?: ValidationResult;
  registeredServer?: RegisteredServer;
  error?: ForgeErrorData;
  createdAt: number;
  updatedAt: number;
  progress: number;
  stepHistory: ForgeStepRecord[];
}

// ── 事件 ──────────────────────────────────────────────────────────────────

export interface ForgeEvent {
  jobId: string;
  type: 'state_change' | 'progress' | 'log' | 'error';
  state?: ForgeJobState;
  progress?: number;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type ForgeEventListener = (event: ForgeEvent) => void;

// ── 模板库类型 ─────────────────────────────────────────────────────────────

export type TemplateId = 'python-fastmcp-stdio' | 'nodejs-stdio' | 'http-api-wrapper';

export interface TemplatePlaceholder {
  name: string;
  required: boolean;
  defaultValue?: string;
  pattern?: string;
  maxLength?: number;
  description: string;
}

export interface TemplateFileSpec {
  path: string;
  content: string;
}

export interface TemplateMetadata {
  id: TemplateId;
  name: string;
  language: 'python' | 'typescript';
  transport: 'stdio' | 'streamable-http';
  framework: string;
  description: string;
  placeholders: TemplatePlaceholder[];
  files: TemplateFileSpec[];
  entryPoint: string;
  registrationConfig: {
    command?: string;
    args?: string[];
    urlPattern?: string;
  };
}

// ── 沙箱结果 ──────────────────────────────────────────────────────────────

export interface SandboxRunResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
}
