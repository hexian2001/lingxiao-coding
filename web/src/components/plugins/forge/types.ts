/**
 * Forge 前端类型定义
 *
 * 对齐 contract:mcp-forge-core v1 + contract:mcp-forge-api v1
 * 前端精简版类型，仅包含 UI 需要的字段
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

export const FAILED_STATES: ReadonlySet<ForgeJobState> = new Set([
  'analysis_failed',
  'generation_failed',
  'validation_failed',
  'registration_failed',
]);

// ── 请求类型 ──────────────────────────────────────────────────────────────

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

export interface GenerateRequest {
  description: string;
  serverName: string;
  templateId?: string;
  options?: ForgeOptions;
  timeoutMs?: number;
}

// ── 分析结果 ──────────────────────────────────────────────────────────────

export interface ForgeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ForgeAnalysis {
  templateId: string;
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

/** 列表用精简版 */
export interface ForgeJobSummary {
  id: string;
  state: ForgeJobState;
  serverName: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  error?: { code: string; message: string };
}

/** includeCode=false 时的精简代码信息 */
export interface GeneratedCodeSummary {
  outputDir: string;
  entryPoint: string;
  language: 'python' | 'typescript';
  templateId: string;
  fileCount: number;
  totalSize: number;
}

/** 任务详情（generatedCode 可能是精简版或完整版） */
export interface ForgeJobDetail extends Omit<ForgeJob, 'generatedCode'> {
  generatedCode?: GeneratedCode | GeneratedCodeSummary;
}

// ── 模板 ──────────────────────────────────────────────────────────────────

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

/** 模板列表项 */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  language: 'python' | 'typescript';
  transport: 'stdio' | 'streamable-http';
  framework: string;
  placeholders: string[];
}

// ── SSE 事件 ──────────────────────────────────────────────────────────────

export type ForgeEventType = 'state_change' | 'progress' | 'log' | 'error';

export interface ForgeSSEEvent {
  jobId: string;
  timestamp: number;
  progress?: number;
  state?: ForgeJobState;
  step?: ForgeJobState;
  message?: string;
  error?: { message?: string; [key: string]: unknown };
}

// ── API 响应 ──────────────────────────────────────────────────────────────

export interface ForgeApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ForgeErrorData;
}

export interface ForgeApiListResponse<T> {
  success: boolean;
  data?: T[];
  pagination?: {
    total: number;
    limit: number;
    offset: number;
  };
  error?: ForgeErrorData;
}

// ── 状态展示辅助 ──────────────────────────────────────────────────────────

export const STATE_LABELS: Record<ForgeJobState, string> = {
  pending: 'Pending',
  analyzing: 'Analyzing',
  analyzed: 'Analyzed',
  generating: 'Generating',
  generated: 'Generated',
  validating: 'Validating',
  validation_skipped: 'Validation Skipped',
  validated: 'Validated',
  registering: 'Registering',
  registered: 'Registered',
  completed: 'Completed',
  analysis_failed: 'Analysis Failed',
  generation_failed: 'Generation Failed',
  validation_failed: 'Validation Failed',
  registration_failed: 'Registration Failed',
  cancelled: 'Cancelled',
};

/** 状态 → 进度百分比（近似值，实际以 job.progress 为准） */
export const STATE_PROGRESS: Record<ForgeJobState, number> = {
  pending: 0,
  analyzing: 10,
  analyzed: 20,
  generating: 35,
  generated: 50,
  validating: 65,
  validation_skipped: 65,
  validated: 80,
  registering: 90,
  registered: 95,
  completed: 100,
  analysis_failed: 10,
  generation_failed: 35,
  validation_failed: 65,
  registration_failed: 90,
  cancelled: 0,
};

/** 状态 → 颜色类名 */
export function stateColorClass(state: ForgeJobState): string {
  if (state === 'completed') return 'text-accent-green';
  if (FAILED_STATES.has(state)) return 'text-accent-red';
  if (state === 'cancelled') return 'text-text-tertiary';
  if (TERMINAL_STATES.has(state)) return 'text-text-secondary';
  return 'text-accent-brand';
}

/** 状态 → 徽章背景类名 */
export function stateBadgeClass(state: ForgeJobState): string {
  if (state === 'completed') return 'bg-accent-green/20 text-accent-green';
  if (FAILED_STATES.has(state)) return 'bg-accent-red/20 text-accent-red';
  if (state === 'cancelled') return 'bg-bg-tertiary text-text-tertiary';
  if (TERMINAL_STATES.has(state)) return 'bg-bg-tertiary text-text-secondary';
  return 'bg-accent-brand/20 text-accent-brand';
}
