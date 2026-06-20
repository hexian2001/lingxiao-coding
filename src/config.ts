import { homedir } from 'os';
import { IS_WINDOWS } from './utils/platform.js';
import { join, resolve } from 'path';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { watch } from 'chokidar';
import { z } from 'zod';
import { setLanguage, t } from './i18n.js';
import * as D from './config/defaults.js';
import { configLogger } from './core/Log.js';
import { isLingxiaoDefaultUserAgent, isValidUserAgent } from './version.js';

/**
 * 配置系统 v3
 *
 * 核心原则：
 * - 所有模型通过 model_providers 管理，每个 id 全局唯一
 * - leader_model / agent_model 必须是 model_providers 里存在的 id
 * - 不再有全局 provider 凭据/地址回退
 * - credentials 存放 envKey → apiKey 映射
 *
 * settings.json 格式（v3）：
 * {
 *   "version": 3,
 *   "credentials": { "mykey": "sk-xxx" },
 *   "llm": {
 *     "leader_model": "my-model-id",
 *     "agent_model": "my-model-id",
 *     "model_providers": {
 *       "openai": [{ "id": "my-model-id", "envKey": "mykey", "baseUrl": "https://...", "provider": "openai" }]
 *     }
 *   }
 * }
 */

// ═══════════════════════════════════════════════════════════════
// 配置目录与文件
// ═══════════════════════════════════════════════════════════════

export const CONFIG_DIR = resolve(join(homedir(), '.lingxiao'));
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
export const CACHE_DIR = join(CONFIG_DIR, D.PATHS.CACHE_DIR_NAME);
export const GLOBAL_SKILLS_DIR = join(CONFIG_DIR, D.PATHS.SKILLS_DIR_NAME);

if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
if (!existsSync(GLOBAL_SKILLS_DIR)) mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });

export type LLMProvider = 'openai' | 'anthropic' | 'auto';

// ═══════════════════════════════════════════════════════════════
// Model Provider 类型
// ═══════════════════════════════════════════════════════════════

export interface ModelCapabilities {
  thinking_mode?: string;
  param_name?: string;
  param_value?: unknown;
  contextWindowSize?: number;
  max_output_tokens?: number;
  modalities?: import('./llm/types.js').InputModalities;
}

export interface ModelGenerationConfig {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout?: number;
  maxRetries?: number;
  extra_body?: Record<string, unknown>;
}

export interface ModelPricingConfig {
  inputPerMToken: number;
  outputPerMToken: number;
  cacheReadPerMToken?: number;
  cacheCreationPerMToken?: number;
}

export interface ModelProviderConfig {
  id: string;
  name?: string;
  /** 实际发送给 API 的模型名（如 deepseek-v4-pro），未设置时回退到 id */
  model?: string;
  description?: string;
  apiKey: string;
  envKey?: string;
  baseUrl: string;
  provider: 'openai' | 'anthropic';
  /** OpenAI-compatible wire protocol for external Codex/Responses drivers. */
  wireApi?: 'chat' | 'responses';
  /** Codex/OpenAI Responses: disable server-side response storage. */
  disableResponseStorage?: boolean;
  /** Codex CLI network access policy passthrough. */
  networkAccess?: 'enabled' | 'disabled' | 'restricted';
  /** 上下文窗口大小（token 数），默认 200K（200000） */
  contextWindowSize?: number;
  generationConfig?: ModelGenerationConfig;
  capabilities?: ModelCapabilities;
  pricing?: ModelPricingConfig;
}

export type ModelProvidersConfig = {
  [provider: string]: ModelProviderConfig[];
};

export interface RuntimeModelSnapshot {
  snapshotId: string;
  provider: 'openai' | 'anthropic';
  modelId: string;
  /** 实际发送给 API 的模型名（如 deepseek-v4-pro），未设置时回退到 modelId */
  model?: string;
  apiKey: string;
  baseUrl: string;
  generationConfig?: ModelGenerationConfig;
  capabilities?: ModelCapabilities;
  pricing?: ModelPricingConfig;
}

type ModelProviderKind = ModelProviderConfig['provider'];

const ModelProviderKindSchema = z.enum(['openai', 'anthropic']);
const InputModalitiesSchema = z.object({
  image: z.boolean().optional(),
  pdf: z.boolean().optional(),
  audio: z.boolean().optional(),
  video: z.boolean().optional(),
}).passthrough();
const ModelCapabilitiesSchema = z.object({
  thinking_mode: z.string().optional(),
  param_name: z.string().optional(),
  param_value: z.unknown().optional(),
  contextWindowSize: z.number().optional(),
  max_output_tokens: z.number().optional(),
  modalities: InputModalitiesSchema.optional(),
}).passthrough();
const ModelGenerationConfigSchema = z.object({
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  timeout: z.number().optional(),
  maxRetries: z.number().optional(),
  extra_body: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const ModelPricingConfigSchema: z.ZodType<ModelPricingConfig> = z.object({
  inputPerMToken: z.number().positive(),
  outputPerMToken: z.number().positive(),
  cacheReadPerMToken: z.number().nonnegative().optional(),
  cacheCreationPerMToken: z.number().nonnegative().optional(),
}).strict();
const ModelProviderConfigSchema: z.ZodType<ModelProviderConfig> = z.object({
  id: z.string(),
  name: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  apiKey: z.string().default(''),
  envKey: z.string().optional(),
  baseUrl: z.string(),
  provider: ModelProviderKindSchema,
  wireApi: z.enum(['chat', 'responses']).optional(),
  disableResponseStorage: z.boolean().optional(),
  networkAccess: z.enum(['enabled', 'disabled', 'restricted']).optional(),
  contextWindowSize: z.number().optional(),
  generationConfig: ModelGenerationConfigSchema.optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  pricing: ModelPricingConfigSchema.optional(),
}).strict();

const ModelProvidersConfigSchema = z.record(z.string(), z.array(ModelProviderConfigSchema));

export type ConfigSourceType = 'modelProvider' | 'env' | 'settings' | 'default';
export type ConfigSourceOld = 'default' | 'env' | 'file' | 'override';

export interface ConfigSource {
  type: ConfigSourceType;
  path: string;
  value: unknown;
}

export type ConfigSources = Record<string, ConfigSource>;

// ModelCapability — widened version of canonical ModelCapabilitySpec for runtime config
// Uses string for thinking_mode to allow arbitrary values from user config files.
// Canonical ModelCapabilitySpec is the strict union-typed version for internal use.
export interface ModelCapability {
  thinking_mode: string;
  param_name: string;
  param_value: unknown;
}

// ═══════════════════════════════════════════════════════════════
// ConfigSchema v3
// ═══════════════════════════════════════════════════════════════

const LlmGroupSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'auto']).default('auto'),
  leader_model: z.string().default(''),
  agent_model: z.string().default(''),
  model_providers: ModelProvidersConfigSchema.default({}),
  gateway_routes: z.record(z.string(), z.object({
    primary: z.string().optional(),
    fallbacks: z.array(z.string()).default([]),
    require: z.object({
      thinking: z.boolean().optional(),
      vision: z.boolean().optional(),
      longContextTokens: z.number().positive().optional(),
    }).default({}),
    max_cost_per_mtoken: z.number().positive().optional(),
    data_policy: z.enum(['standard', 'local_only', 'zdr_required', 'redact_sensitive']).optional(),
  })).default({}),
  gateway_fallback_models: z.array(z.string()).default([]),
  request_timeout_s: z.number().default(D.LLM.REQUEST_TIMEOUT_S),
  connect_timeout_s: z.number().default(D.LLM.CONNECT_TIMEOUT_S),
  max_retries: z.number().default(D.LLM.MAX_RETRIES),
  backoff_base_ms: z.number().default(D.LLM.BACKOFF_BASE_MS),
  first_token_timeout_s: z.number().default(D.LLM.FIRST_TOKEN_TIMEOUT_S),
  first_token_timeout_thinking_s: z.number().default(D.LLM.FIRST_TOKEN_THINKING_TIMEOUT_S),
  context_max_tokens: z.number().default(D.LLM.CONTEXT_MAX_TOKENS),
  capped_max_tokens: z.number().default(D.LLM.CAPPED_MAX_TOKENS),
  escalated_max_tokens: z.number().default(D.LLM.ESCALATED_MAX_TOKENS),
  thinking_budget_tokens: z.number().default(D.LLM.THINKING_BUDGET_TOKENS),
  enable_streaming: z.boolean().default(true),
  // 默认展示思考/推理链(TUI/Web 均以折叠卡片呈现,点击或 Ctrl+E 展开),
  // 让用户能观察到模型的推理过程;无推理输出的模型不会产生 thinking 数据,无副作用。
  show_thinking_content: z.boolean().default(true),
  enable_thinking_instruction: z.boolean().default(true),
  enable_extended_thinking: z.boolean().default(true),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive']).default('high'),
  /**
   * 推理/编排/判定类 LLM 调用的采样温度。默认 0 = 确定性解码，最大化降低漂移
   * (任务分解、工具选择、续跑判定等"要可靠不要创意"的调用必须走 0)。
   * 记忆生成类(Dream/Distill/Checkpoint)不经过此配置，各自硬编码发散温度。
   * 取 1 可立即恢复旧行为(走 provider 默认随机)。
   */
  reasoning_temperature: z.number().min(0).max(1).default(D.LLM.REASONING_TEMPERATURE),
  wiki_model: z.string().optional(),
}).strict();

const LlmGatewayGroupSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['openai', 'anthropic']).default('openai'),
  model: z.string().default(''),
  /** 网关专用监听器绑定地址（默认仅 loopback；网关走 sk- 鉴权且 CORS 为 *，不应暴露公网） */
  host: z.string().default(D.LLM_GATEWAY.HOST),
  /** 网关专用固定端口 —— 不再随 Web 服务器漂移；EADDRINUSE 时 fail-loud 而非随机回退 */
  port: z.number().int().min(1).max(65535).default(D.LLM_GATEWAY.PORT),
  inject_env: z.boolean().default(true),
  override_existing_env: z.boolean().default(false),
  api_key: z.string().default(''),
  virtual_keys: z.array(z.object({
    id: z.string().min(1).max(100),
    key: z.string().min(1).max(400),
    label: z.string().max(200).optional(),
    enabled: z.boolean().default(true),
    model: z.string().optional(),
    provider: z.enum(['openai', 'anthropic']).optional(),
    rpm: z.number().int().positive().optional(),
    tpm: z.number().int().positive().optional(),
    daily_token_budget: z.number().int().positive().optional(),
    expires_at: z.number().int().positive().optional(),
  })).default([]),
  default_rpm: z.number().int().positive().default(60),
  default_tpm: z.number().int().positive().default(200_000),
  default_daily_token_budget: z.number().int().positive().default(2_000_000),
  trace_enabled: z.boolean().default(true),
});

const AgentsGroupSchema = z.object({
  max_concurrent: z.number().default(D.AGENT.MAX_CONCURRENT),
  max_iterations: z.number().default(D.AGENT.MAX_ITERATIONS),
  max_runtime_minutes: z.number().default(D.AGENT.MAX_RUNTIME_MINUTES),
  permission_timeout_ms: z.number().default(D.AGENT.PERMISSION_TIMEOUT_MS),
  tool_result_max_chars: z.number().default(D.AGENT.TOOL_RESULT_MAX_CHARS),
  max_conversation_messages: z.number().default(D.AGENT.MAX_CONVERSATION_MESSAGES),
  max_agent_messages: z.number().default(D.AGENT.MAX_AGENT_MESSAGES),
  max_continuation_depth: z.number().default(D.AGENT.MAX_CONTINUATION_DEPTH),
  worker_completion_judge_enabled: z.boolean().default(false),
  external_agents_enabled: z.boolean().default(D.AGENT.EXTERNAL_AGENTS_ENABLED),
});

const VerificationGroupSchema = z.object({
  completion_gate_enabled: z.boolean().default(true),
  typecheck: z.boolean().default(true),
  build: z.boolean().default(true),
  affected_tests: z.boolean().default(true),
  full_tests: z.boolean().default(false),
  self_repair_budget: z.number().int().nonnegative().default(3),
  build_timeout_ms: z.number().int().positive().default(120_000),
  test_timeout_ms: z.number().int().positive().default(120_000),
  /** B4: 有契约 allowedScope 的实现型任务强制开语义 judge(契约存在=高信任要求);无契约任务不调 judge 省 token。默认 true。 */
  judge_gated_by_contract: z.boolean().default(true),
});

const LeaderGroupSchema = z.object({
  max_tool_rounds: z.number().default(D.LEADER.MAX_TOOL_ROUNDS),
  max_runtime_minutes: z.number().default(D.LEADER.MAX_RUNTIME_MINUTES),
  probe_silence_seconds: z.number().default(D.LEADER.PROBE_SILENCE_SECONDS),
  probe_max_interval_seconds: z.number().default(D.LEADER.PROBE_MAX_INTERVAL_SECONDS),
  probe_backoff_multiplier: z.number().default(D.LEADER.PROBE_BACKOFF_MULTIPLIER),
  idle_warning_seconds: z.number().default(D.LEADER.IDLE_WARNING_SECONDS),
  idle_probe_max_wait_ms: z.number().default(D.LEADER.IDLE_PROBE_MAX_WAIT_MS),
  idle_probe_backoff_base_ms: z.number().default(D.LEADER.IDLE_PROBE_BACKOFF_BASE_MS),
  stream_buffer_flush_threshold: z.number().int().positive().default(D.LEADER.STREAM_BUFFER_FLUSH_THRESHOLD),
  agent_report_max_chars: z.number().default(D.LEADER.AGENT_REPORT_MAX_CHARS),
  plan_review_enabled: z.boolean().default(true),
});

const HealthGroupSchema = z.object({
  poll_interval_seconds: z.number().default(D.HEALTH.POLL_INTERVAL_SECONDS),
  stall_threshold_seconds: z.number().default(D.HEALTH.STALL_THRESHOLD_SECONDS),
  stuck_threshold_seconds: z.number().default(D.HEALTH.STUCK_THRESHOLD_SECONDS),
  runaway_threshold_seconds: z.number().default(D.HEALTH.RUNAWAY_THRESHOLD_SECONDS),
  nudge_cooldown_seconds: z.number().default(D.HEALTH.NUDGE_COOLDOWN_SECONDS),
  max_nudge_before_escalation: z.number().default(D.HEALTH.MAX_NUDGE_BEFORE_ESCALATION),
});

const ContextGroupSchema = z.object({
  // token_limit 未设（默认）时跟随模型真实上下文窗口；显式设置则作为「有效工作上限」
  // 优先于模型窗口，压缩在其 ~80% 触发。详见 ContextManager.resolveEffectiveContextLimit。
  token_limit: z.number().positive().optional(),
  autocompact_enabled: z.boolean().default(true),
  max_output_tokens_for_summary: z.number().default(D.CONTEXT.MAX_OUTPUT_TOKENS_FOR_SUMMARY),
  autocompact_buffer_tokens: z.number().default(D.CONTEXT.AUTOCOMPACT_BUFFER_TOKENS),
  autocompact_ratio: z.number().min(0).max(1.0).default(D.CONTEXT.AUTOCOMPACT_RATIO),
  autocompact_model_ratio_overrides: z.record(z.string(), z.number().min(0).max(1.0)).default(D.CONTEXT.AUTOCOMPACT_MODEL_RATIO_OVERRIDES),
  compact_llm_timeout_ms: z.number().default(D.CONTEXT.COMPACT_LLM_TIMEOUT_MS),
  max_consecutive_failures: z.number().default(D.CONTEXT.MAX_CONSECUTIVE_FAILURES),
  max_request_bytes: z.number().default(D.CONTEXT.MAX_REQUEST_BYTES),
  max_single_message_bytes: z.number().default(D.CONTEXT.MAX_SINGLE_MESSAGE_BYTES),
});

const TruncationGroupSchema = z.object({
  shell_stdout_max: z.number().default(D.TRUNCATION.SHELL_STDOUT_MAX),
  shell_stderr_max: z.number().default(D.TRUNCATION.SHELL_STDERR_MAX),
  python_max_output: z.number().default(D.TRUNCATION.PYTHON_MAX_OUTPUT),
  tool_result_preview: z.number().default(D.TRUNCATION.TOOL_RESULT_PREVIEW),
  webfetch_markdown_max: z.number().default(D.TRUNCATION.WEBFETCH_MARKDOWN_MAX),
});

const WebApiGroupSchema = z.object({
  prompt_enhance_max_chars: z.number().int().positive().default(D.WEB_API.PROMPT_ENHANCE_MAX_CHARS),
});

const TimeoutsGroupSchema = z.object({
  graceful_shutdown_ms: z.number().default(D.TIMEOUT.GRACEFUL_SHUTDOWN_MS),
  hook_default_ms: z.number().default(D.TIMEOUT.HOOK_DEFAULT_MS),
  hook_timeout_ms: z.number().default(D.TIMEOUT.HOOK_TIMEOUT_MS),
  permission_sync_timeout_ms: z.number().default(D.TIMEOUT.PERMISSION_SYNC_TIMEOUT_MS),
  heartbeat_interval_ms: z.number().default(D.TIMEOUT.HEARTBEAT_INTERVAL_MS),
  browser_goto_ms: z.number().default(D.TIMEOUT.BROWSER_GOTO_MS),
  browser_text_max: z.number().int().positive().default(D.TIMEOUT.BROWSER_TEXT_MAX),
  browser_html_max: z.number().int().positive().default(D.TIMEOUT.BROWSER_HTML_MAX),
  worker_spawn_ms: z.number().default(D.TIMEOUT.WORKER_SPAWN_MS),
  worker_heartbeat_timeout_ms: z.number().default(D.TIMEOUT.WORKER_HEARTBEAT_TIMEOUT_MS),
  worker_max_runtime_ms: z.number().default(D.TIMEOUT.WORKER_MAX_RUNTIME_MS),
});

const PathsGroupSchema = z.object({
  db_path: z.string().default(''),
  log_dir: z.string().default(''),
  skills_dir: z.string().default(''),
  chrome_path: z.string().default(''),
  bundled_skills_dir: z.string().default(''),
  global_skills_dir: z.string().default(''),
});

const SkillsGroupSchema = z.object({
  disabled_names: z.array(z.string()).default([]),
  disabled_refs: z.array(z.string()).default([]),
});

const PluginsGroupSchema = z.object({
  disabled_ids: z.array(z.string()).default(() => [...D.PLUGINS.DEFAULT_DISABLED]),
  dirs: z.array(z.string()).default([]),
});

const MarketplaceSourceSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200).optional(),
  type: z.enum(['mcp_registry', 'skill_index', 'plugin_index']),
  url: z.string().url().optional(),
  enabled: z.boolean().default(true),
  official: z.boolean().default(false),
});

const MarketplacesGroupSchema = z.object({
  sources: z.array(MarketplaceSourceSchema).default([
    {
      id: 'skills-local',
      title: 'Local Skills',
      type: 'skill_index',
      enabled: true,
      official: true,
    },
    {
      id: 'skills-official',
      title: 'OpenAI Skills',
      type: 'skill_index',
      url: 'https://api.github.com/repos/openai/skills/git/trees/main?recursive=1',
      enabled: true,
      official: true,
    },
    {
      id: 'plugins-local',
      title: 'Local Plugins',
      type: 'plugin_index',
      enabled: true,
      official: true,
    },
    {
      id: 'mcp-official',
      title: 'Official MCP Registry',
      type: 'mcp_registry',
      url: 'https://registry.modelcontextprotocol.io',
      enabled: true,
      official: true,
    },
  ]),
});

const McpHeaderSchema = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(4000),
});

const McpOriginSchema = z.object({
  plugin_id: z.string().max(100).optional(),
  plugin_version: z.string().max(100).optional(),
  plugin_path: z.string().max(2000).optional(),
}).optional();

const McpRemoteServerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  name: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  transport: z.literal('streamable-http'),
  url: z.string().url(),
  headers: z.array(McpHeaderSchema).default([]),
  registry: z.object({
    source_id: z.string().max(100).optional(),
    server_name: z.string().max(200).optional(),
    version: z.string().max(100).optional(),
  }).optional(),
  origin: McpOriginSchema,
  installed_at: z.number().int().nonnegative().optional(),
  updated_at: z.number().int().nonnegative().optional(),
});

const McpStdioServerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  name: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  transport: z.literal('stdio'),
  command: z.string().min(1).max(2000),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().max(2000).optional(),
  registry: z.object({
    source_id: z.string().max(100).optional(),
    server_name: z.string().max(200).optional(),
    version: z.string().max(100).optional(),
  }).optional(),
  origin: McpOriginSchema,
  installed_at: z.number().int().nonnegative().optional(),
  updated_at: z.number().int().nonnegative().optional(),
});

const McpServerConfigSchema = z.discriminatedUnion('transport', [
  McpRemoteServerSchema,
  McpStdioServerSchema,
]);

const McpGroupSchema = z.object({
  enabled: z.boolean().default(true),
  servers: z.array(McpServerConfigSchema).default([]),
  tool_timeout_ms: z.number().int().positive().max(600_000).default(60_000),
});

export type MarketplaceSourceConfig = z.infer<typeof MarketplaceSourceSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ── 用户自定义工具 schema ──────────────────────────────────────────────
const HttpToolKindSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']).default('GET'),
  url: z.string().min(1).max(2048),
  headers: z.record(z.string(), z.string()).optional(),
  body_template: z.string().max(8192).optional(),
  json_template: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
});

const ShellToolKindSchema = z.object({
  command: z.string().min(1).max(8192),
  cwd: z.string().max(1024).optional(),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
});

const PythonToolKindSchema = z.object({
  code: z.string().min(1).max(16_384),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
});

const UserToolParameterSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,49}$/),
  type: z.enum(['string', 'number', 'boolean']).default('string'),
  description: z.string().max(500).optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const UserToolSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/, {
    message: 'name 必须以小写字母开头，仅含 a-z0-9_，长度 2-50',
  }),
  description: z.string().min(1).max(500),
  kind: z.enum(['http', 'shell', 'python']),
  enabled: z.boolean().default(true),
  parameters: z.array(UserToolParameterSchema).default([]),
  http: HttpToolKindSchema.optional(),
  shell: ShellToolKindSchema.optional(),
  python: PythonToolKindSchema.optional(),
  created_at: z.number().int().nonnegative().optional(),
  updated_at: z.number().int().nonnegative().optional(),
}).superRefine((spec, ctx) => {
  // kind 与 *_config 字段一致性校验
  if (spec.kind === 'http' && !spec.http) {
    ctx.addIssue({ code: 'custom', message: 'kind=http 时必须提供 http 字段', path: ['http'] });
  }
  if (spec.kind === 'shell' && !spec.shell) {
    ctx.addIssue({ code: 'custom', message: 'kind=shell 时必须提供 shell 字段', path: ['shell'] });
  }
  if (spec.kind === 'python' && !spec.python) {
    ctx.addIssue({ code: 'custom', message: 'kind=python 时必须提供 python 字段', path: ['python'] });
  }
});

export type UserToolSpec = z.infer<typeof UserToolSpecSchema>;
export type UserToolParameter = z.infer<typeof UserToolParameterSchema>;

const ToolsGroupSchema = z.object({
  user_defined: z.array(UserToolSpecSchema).default([]),
  disabled_names: z.array(z.string()).default([]),
  execution_timeout_ms: z.number().int().positive().max(600_000).default(D.TOOLS.EXECUTION_TIMEOUT_MS),
});

const ServerGroupSchema = z.object({
  host: z.string().default(D.SERVER.HOST),
  port: z.number().default(D.SERVER.PORT),
  random_port: z.boolean().default(false),
});

const BrowserProxySchema = z.object({
  server: z.string().default(''),
  username: z.string().optional(),
  password: z.string().optional(),
  bypass: z.string().optional(),
});

const BrowserGroupSchema = z.object({
  /**
   * Daemon 模式：浏览器跨工具调用长期驻留，不再 idle 自动关闭。
   * 也可通过环境变量 LINGXIAO_BROWSER_DAEMON=1 临时启用。
   */
  daemon: z.boolean().default(false),
  /**
   * Idle 关闭超时（毫秒）。daemon=false 且超过此时长无调用时关闭浏览器。
   * 0 / 不设置时使用代码默认 5 分钟。
   */
  idle_ms: z.number().int().nonnegative().optional(),
  /**
   * 全局代理：影响 BrowserManager.launch 时的 chromium proxy。
   * 优先级：per-call 入参 > runtimeConfig（这里）> env LINGXIAO_BROWSER_PROXY/HTTPS_PROXY。
   */
  proxy: BrowserProxySchema.optional(),
});

const DEFAULT_NETWORK_PROXY = {
  protocol: 'http' as const,
  host: '',
  port: 0,
  username: '',
  password: '',
  no_proxy: '',
  url: '',
  llm_enabled: false,
  tools_enabled: false,
};

const NetworkProxySchema = z.object({
  protocol: z.enum(['http', 'socks5']).default('http'),
  host: z.string().default(''),
  port: z.number().int().nonnegative().default(0),
  username: z.string().default(''),
  password: z.string().default(''),
  no_proxy: z.string().default(''),
  url: z.string().default(''),
  llm_enabled: z.boolean().default(false),
  tools_enabled: z.boolean().default(false),
}).default(DEFAULT_NETWORK_PROXY);

const NetworkGroupSchema = z.object({
  user_agent: z.string()
    .refine(isValidUserAgent, 'User-Agent supports printable ASCII characters and must be at most 512 characters')
    .default(D.NETWORK.USER_AGENT),
  proxy: NetworkProxySchema,
});

const SecurityGroupSchema = z.object({
  permission_mode: z.enum(['strict', 'dev', 'networked', 'yolo']).default('yolo'),
  auto_allow_bash_if_sandboxed: z.boolean().default(true),
  dangerous_command_guard: z.boolean().default(false),
  block_private_network: z.boolean().default(false),
  /**
   * 身份/系统提示探测的 LLM 二次判定。默认关闭，避免每次模糊安全判定额外消耗
   * 一次模型请求；关闭时仅使用硬规则拦截明确的系统提示/隐藏指令探测。
   */
  identity_judge_llm_enabled: z.boolean().default(false),
  /**
   * 企业内网加固模式总开关（默认 false，现状零改动）。
   * 开启后一键收紧子进程 env 透传、沙箱绑定、SSRF/私网防护、危险命令守卫、
   * 限流豁免、token 来源、写入隔离、artifact root 校验等多个加固项。
   * 判定一律经 src/core/HardeningPolicy.ts 的纯函数（不直读本字段），
   * 并与 dangerous_command_guard / block_private_network 取 OR。
   * 可由部署环境变量 LINGXIAO_HARDENED_MODE 单向强制开启（不能经 UI 关闭）。
   */
  hardened_mode: z.boolean().default(false),
  /**
   * 加固模式下子进程 / 终端透传的环境变量白名单（变量名精确匹配）。
   * 仅在 hardened_mode=true 时生效；为空数组时使用内置最小默认集
   * （见 HardeningPolicy.DEFAULT_ENV_ALLOWLIST）。
   */
  env_allowlist: z.array(z.string()).default([]),
});

const MemoryGroupSchema = z.object({
  enabled: z.boolean().default(true),
  auto_memory_enabled: z.boolean().default(true),
  intuition_enabled: z.boolean().default(true),
  tacit_mode_enabled: z.boolean().default(true),
  intuition_profile: z.enum(['balanced', 'low_interrupt', 'autonomous_partner']).default('autonomous_partner'),
  // FTS5/BM25 索引与检索行为
  reconcile_on_search: z.boolean().default(true),
  // BM25 分数下限 = topScore * 该比例（保留 #1 命中，过滤弱相关），见 MemoryFTS。
  search_score_floor: z.number().min(0).max(1).default(0.15),
  // /dream 巩固：会话回溯天数、自动触发间隔、输出体积上限。
  dream: z.object({
    enabled: z.boolean().default(true),
    auto_interval_days: z.number().int().positive().default(7),
    session_lookback_days: z.number().int().positive().default(7),
    max_lines: z.number().int().positive().default(200),
    max_bytes: z.number().int().positive().default(10 * 1024),
  }).default({
    enabled: true,
    auto_interval_days: 7,
    session_lookback_days: 7,
    max_lines: 200,
    max_bytes: 10 * 1024,
  }),
  // /distill 资产提炼：会话回溯天数、独立自动触发间隔（mimo=30天）。
  distill: z.object({
    enabled: z.boolean().default(true),
    auto_interval_days: z.number().int().positive().default(30),
    session_lookback_days: z.number().int().positive().default(14),
  }).default({
    enabled: true,
    auto_interval_days: 30,
    session_lookback_days: 14,
  }),
  // P1: Embedding 向量检索配置
  embedding: z.object({
    enabled: z.boolean().default(false),
    model: z.string().default('text-embedding-3-small'),
    dimensions: z.number().int().positive().default(256),
    hybrid_weight_fts: z.number().min(0).max(1).default(0.7),
    hybrid_weight_vector: z.number().min(0).max(1).default(0.3),
  }).default({
    enabled: false,
    model: 'text-embedding-3-small',
    dimensions: 256,
    hybrid_weight_fts: 0.7,
    hybrid_weight_vector: 0.3,
  }),
  // P2: TTL/过期/GC 配置
  gc: z.object({
    enabled: z.boolean().default(false),
    dry_run: z.boolean().default(false),
    max_deletions: z.number().int().positive().default(50),
    interval_days: z.number().int().positive().default(1),
    protected_types: z.array(z.string()).default(['user']),
  }).default({
    enabled: false,
    dry_run: false,
    max_deletions: 50,
    interval_days: 1,
    protected_types: ['user'],
  }),
});

const CheckpointGroupSchema = z.object({
  file_checkpointing_enabled: z.boolean().default(true),
});

const UiGroupSchema = z.object({
  language: z.enum(['zh', 'en']).default('zh'),
  include_co_authored_by: z.boolean().default(true),
  prompt_suggestion_enabled: z.boolean().default(true),
});

const AdvancedGroupSchema = z.object({
  cleanup_period_days: z.number().default(30),
  image_history_retain_rounds: z.number().min(1).default(2),
  defer_tool_loading: z.boolean().default(false),
  ignore_gitignore: z.boolean().default(false),
  hook_output_collapsed: z.boolean().default(true),
  env: z.record(z.string(), z.string()).default({}),
});

const MessageBusGroupSchema = z.object({
  warning_threshold: z.number().default(D.MESSAGE_BUS.WARNING_THRESHOLD),
  critical_threshold: z.number().default(D.MESSAGE_BUS.CRITICAL_THRESHOLD),
});

const LangfuseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default('https://cloud.langfuse.com'),
  secretKey: z.string().default(''),
  publicKey: z.string().default(''),
  traceLlmCalls: z.boolean().default(true),
  traceToolCalls: z.boolean().default(false),
  traceAgentLifecycle: z.boolean().default(true),
  sampleRate: z.number().min(0).max(1).default(1.0),
  maskSensitive: z.boolean().default(true),
}).default({
  enabled: false,
  baseUrl: 'https://cloud.langfuse.com',
  secretKey: '',
  publicKey: '',
  traceLlmCalls: true,
  traceToolCalls: false,
  traceAgentLifecycle: true,
  sampleRate: 1.0,
  maskSensitive: true,
});

const ObservabilityGroupSchema = z.object({
  tracing: z.object({
    enabled: z.boolean().default(true),
    persist: z.boolean().default(false),
    maxSpans: z.number().int().positive().default(1000),
  }).default({
    enabled: true,
    persist: false,
    maxSpans: 1000,
  }),
  metrics: z.object({
    enabled: z.boolean().default(true),
  }).default({
    enabled: true,
  }),
  langfuse: LangfuseConfigSchema,
});

const TaskPriorityGroupSchema = z.object({
  weights: z.record(z.string(), z.number()).default({}),
});

const ScalingGroupSchema = z.object({
  remoteWorkers: z.object({
    enabled: z.boolean().default(false),
    listenPort: z.number().int().positive().default(9800),
  }).default({
    enabled: false,
    listenPort: 9800,
  }),
});

const GitGroupSchema = z.object({
  platform: z.enum(['github', 'gitlab', 'gitea', 'none']).default('none'),
  token: z.string().default(''),
  api_url: z.string().default(''),
  default_target_branch: z.string().default('main'),
  auto_detect_remote: z.boolean().default(true),
});

const BlackboardGroupSchema = z.object({
  enabled: z.boolean().default(D.BLACKBOARD.ENABLED),
  max_nodes: z.number().int().positive().default(D.BLACKBOARD.MAX_GRAPH_NODES),
  max_edges: z.number().int().positive().default(D.BLACKBOARD.MAX_GRAPH_EDGES),
});

/**
 * Roles group — Agent 角色与工具配置
 *
 * 所有内置角色默认带"基础工具集"（read/write/搜索/python/shell/structured_patch）。
 * 这里允许用户细化：
 *   - basic_tools_enabled: false 时关闭所有角色的基础工具补齐（角色 tools 退回每个 profile 自身定义）
 *   - overrides[name].tools_added / tools_removed：在最终 tools 上加 / 减
 *
 * 历史背景：用户反馈 ux_designer 派活时缺 file_create 被迫重派，
 * 决定全角色统一基础工具集，并把这一开关搬到 settings.json 让 leader 统一感知。
 */
const RoleOverrideSchema = z.object({
  tools_added: z.array(z.string()).default([]),
  tools_removed: z.array(z.string()).default([]),
});
const RolesGroupSchema = z.object({
  basic_tools_enabled: z.boolean().default(true),
  overrides: z.record(z.string(), RoleOverrideSchema).default({}),
});

export type RoleOverrideConfig = z.infer<typeof RoleOverrideSchema>;
export type RolesGroupConfig = z.infer<typeof RolesGroupSchema>;

const CONFIG_DEFAULT_GROUPS = [
  'llm',
  'llm_gateway',
  'agents',
  'verification',
  'leader',
  'health',
  'context',
  'truncation',
  'timeouts',
  'paths',
  'skills',
  'plugins',
  'marketplaces',
  'mcp',
  'tools',
  'roles',
  'server',
  'network',
  'security',
  'memory',
  'checkpoint',
  'ui',
  'message_bus',
  'observability',
  'taskPriority',
  'scaling',
  'blackboard',
] as const;

function withDefaultConfigGroups(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = { ...(input as Record<string, unknown>) };
  normalizeCodexStyleRootConfig(raw);
  for (const group of CONFIG_DEFAULT_GROUPS) {
    if (!raw[group]) raw[group] = {};
  }
  normalizeRawModelProviders(raw);
  return raw;
}

function normalizeCodexStyleRootConfig(raw: Record<string, unknown>): void {
  const hasCodexRoot =
    typeof raw.model === 'string' ||
    typeof raw.review_model === 'string' ||
    typeof raw.model_reasoning_effort === 'string' ||
    typeof raw.model_provider === 'string';
  if (!hasCodexRoot) return;

  const llm = raw.llm && typeof raw.llm === 'object' && !Array.isArray(raw.llm)
    ? { ...(raw.llm as Record<string, unknown>) }
    : {};

  if (typeof raw.model === 'string' && !llm.leader_model) llm.leader_model = raw.model;
  if (typeof raw.model === 'string' && !llm.agent_model) llm.agent_model = raw.model;
  if (typeof raw.model_reasoning_effort === 'string' && !llm.reasoning_effort) {
    llm.reasoning_effort = raw.model_reasoning_effort;
  }

  const rootProviders = raw.model_providers;
  if (rootProviders && typeof rootProviders === 'object' && !Array.isArray(rootProviders) && !llm.model_providers) {
    llm.model_providers = rootProviders;
  }

  raw.llm = llm;
}

function normalizeRawAdvancedConfig(raw: Record<string, unknown>): void {
  const advanced = raw.advanced;
  if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) return;
  const record = advanced as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'image_history_retain_rounds')) return;
  const value = Number(record.image_history_retain_rounds);
  if (Number.isFinite(value) && value < 1) {
    record.image_history_retain_rounds = 1;
  }
}

export const ConfigSchema = z.preprocess(withDefaultConfigGroups, z.object({
  version: z.number().default(3),
  llm: LlmGroupSchema,
  llm_gateway: LlmGatewayGroupSchema.default({
    enabled: false,
    provider: 'openai',
    model: '',
    host: D.LLM_GATEWAY.HOST,
    port: D.LLM_GATEWAY.PORT,
    inject_env: true,
    override_existing_env: false,
    api_key: '',
    virtual_keys: [],
    default_rpm: 60,
    default_tpm: 200_000,
    default_daily_token_budget: 2_000_000,
    trace_enabled: true,
  }),
  agents: AgentsGroupSchema,
  verification: VerificationGroupSchema,
  leader: LeaderGroupSchema,
  health: HealthGroupSchema,
  context: ContextGroupSchema,
  truncation: TruncationGroupSchema,
  timeouts: TimeoutsGroupSchema,
  web_api: WebApiGroupSchema.default({ prompt_enhance_max_chars: D.WEB_API.PROMPT_ENHANCE_MAX_CHARS }),
  paths: PathsGroupSchema,
  skills: SkillsGroupSchema.default({ disabled_names: [], disabled_refs: [] }),
  plugins: PluginsGroupSchema.default(() => ({ disabled_ids: [...D.PLUGINS.DEFAULT_DISABLED], dirs: [] })),
  marketplaces: MarketplacesGroupSchema.default({
    sources: [
      {
        id: 'skills-local',
        title: 'Local Skills',
        type: 'skill_index',
        enabled: true,
        official: true,
      },
      {
        id: 'skills-official',
        title: 'OpenAI Skills',
        type: 'skill_index',
        url: 'https://api.github.com/repos/openai/skills/git/trees/main?recursive=1',
        enabled: true,
        official: true,
      },
      {
        id: 'plugins-local',
        title: 'Local Plugins',
        type: 'plugin_index',
        enabled: true,
        official: true,
      },
      {
        id: 'mcp-official',
        title: 'Official MCP Registry',
        type: 'mcp_registry',
        url: 'https://registry.modelcontextprotocol.io',
        enabled: true,
        official: true,
      },
    ],
  }),
  mcp: McpGroupSchema.default({ enabled: true, servers: [], tool_timeout_ms: 60_000 }),
  tools: ToolsGroupSchema.default({ user_defined: [], disabled_names: [], execution_timeout_ms: D.TOOLS.EXECUTION_TIMEOUT_MS }),
  roles: RolesGroupSchema.default({ basic_tools_enabled: true, overrides: {} }),
  server: ServerGroupSchema,
  network: NetworkGroupSchema.default({ user_agent: D.NETWORK.USER_AGENT, proxy: DEFAULT_NETWORK_PROXY }),
  browser: BrowserGroupSchema.default({ daemon: false }),
  security: SecurityGroupSchema,
  memory: MemoryGroupSchema,
  checkpoint: CheckpointGroupSchema,
  ui: UiGroupSchema,
  message_bus: MessageBusGroupSchema,
  observability: ObservabilityGroupSchema,
  taskPriority: TaskPriorityGroupSchema,
  scaling: ScalingGroupSchema,
  git: GitGroupSchema.default(() => ({
    platform: 'none' as const,
    token: '',
    api_url: '',
    default_target_branch: 'main',
    auto_detect_remote: true,
  })),
  blackboard: BlackboardGroupSchema,
  advanced: AdvancedGroupSchema.default({
    cleanup_period_days: 30,
    image_history_retain_rounds: 2,
    defer_tool_loading: false,
    ignore_gitignore: false,
    hook_output_collapsed: true,
    env: {},
  }),
  credentials: z.record(z.string(), z.string()).default({}),
  initialized: z.boolean().default(false),
}));

export type Config = z.infer<typeof ConfigSchema>;

// ═══════════════════════════════════════════════════════════════
// 环境变量加载
// ═══════════════════════════════════════════════════════════════

interface EnvMapping {
  env: string;
  path: string;
  type: 'string' | 'number' | 'boolean';
}

const ENV_OVERRIDE_MAP: EnvMapping[] = [
  { env: 'LINGXIAO_LLM_PROVIDER', path: 'llm.provider', type: 'string' },
  { env: 'LINGXIAO_LEADER_MODEL', path: 'llm.leader_model', type: 'string' },
  { env: 'LINGXIAO_AGENT_MODEL', path: 'llm.agent_model', type: 'string' },
  { env: 'LINGXIAO_MAX_CONCURRENT_AGENTS', path: 'agents.max_concurrent', type: 'number' },
  { env: 'LINGXIAO_AGENT_MAX_ITERATIONS', path: 'agents.max_iterations', type: 'number' },
  { env: 'LINGXIAO_AGENT_MAX_RUNTIME_MINUTES', path: 'agents.max_runtime_minutes', type: 'number' },
  { env: 'LINGXIAO_WORKER_COMPLETION_JUDGE', path: 'agents.worker_completion_judge_enabled', type: 'boolean' },
  { env: 'LINGXIAO_VERIFICATION_COMPLETION_GATE', path: 'verification.completion_gate_enabled', type: 'boolean' },
  { env: 'LINGXIAO_VERIFICATION_TYPECHECK', path: 'verification.typecheck', type: 'boolean' },
  { env: 'LINGXIAO_VERIFICATION_BUILD', path: 'verification.build', type: 'boolean' },
  { env: 'LINGXIAO_VERIFICATION_AFFECTED_TESTS', path: 'verification.affected_tests', type: 'boolean' },
  { env: 'LINGXIAO_VERIFICATION_FULL_TESTS', path: 'verification.full_tests', type: 'boolean' },
  { env: 'LINGXIAO_EXTERNAL_AGENTS_ENABLED', path: 'agents.external_agents_enabled', type: 'boolean' },
  { env: 'LINGXIAO_TOOL_EXECUTION_TIMEOUT_MS', path: 'tools.execution_timeout_ms', type: 'number' },
  { env: 'LINGXIAO_REMOTE_WORKERS_ENABLED', path: 'scaling.remoteWorkers.enabled', type: 'boolean' },
  { env: 'LINGXIAO_LEADER_MAX_TOOL_ROUNDS', path: 'leader.max_tool_rounds', type: 'number' },
  { env: 'LINGXIAO_LEADER_MAX_RUNTIME_MINUTES', path: 'leader.max_runtime_minutes', type: 'number' },
  { env: 'LINGXIAO_LEADER_PROBE_SILENCE_SECONDS', path: 'leader.probe_silence_seconds', type: 'number' },
  { env: 'LINGXIAO_LEADER_PROBE_MAX_INTERVAL_SECONDS', path: 'leader.probe_max_interval_seconds', type: 'number' },
  { env: 'LINGXIAO_LEADER_PROBE_BACKOFF_MULTIPLIER', path: 'leader.probe_backoff_multiplier', type: 'number' },
  { env: 'LINGXIAO_LEADER_IDLE_WARNING_SECONDS', path: 'leader.idle_warning_seconds', type: 'number' },
  { env: 'LINGXIAO_ENABLE_STREAMING', path: 'llm.enable_streaming', type: 'boolean' },
  { env: 'LINGXIAO_REASONING_TEMPERATURE', path: 'llm.reasoning_temperature', type: 'number' },
  { env: 'LINGXIAO_WIKI_MODEL', path: 'llm.wiki_model', type: 'string' },
  { env: 'LINGXIAO_DB_PATH', path: 'paths.db_path', type: 'string' },
  { env: 'LINGXIAO_CHROME_PATH', path: 'paths.chrome_path', type: 'string' },
  { env: 'CHROME_PATH', path: 'paths.chrome_path', type: 'string' },
  { env: 'CHROME_BIN', path: 'paths.chrome_path', type: 'string' },
  { env: 'LINGXIAO_BUNDLED_SKILLS_DIR', path: 'paths.bundled_skills_dir', type: 'string' },
  { env: 'LINGXIAO_GLOBAL_SKILLS_DIR', path: 'paths.global_skills_dir', type: 'string' },
  { env: 'LINGXIAO_WORKER_SPAWN_TIMEOUT_MS', path: 'timeouts.worker_spawn_ms', type: 'number' },
  { env: 'LINGXIAO_LANGUAGE', path: 'ui.language', type: 'string' },
  { env: 'LINGXIAO_WEB_PORT', path: 'server.port', type: 'number' },
  { env: 'LINGXIAO_WEB_HOST', path: 'server.host', type: 'string' },
  { env: 'LINGXIAO_BLACKBOARD', path: 'blackboard.enabled', type: 'boolean' },
  { env: 'LINGXIAO_PROXY_URL', path: 'network.proxy.url', type: 'string' },
  { env: 'LINGXIAO_PROXY_LLM', path: 'network.proxy.llm_enabled', type: 'boolean' },
  { env: 'LINGXIAO_PROXY_TOOLS', path: 'network.proxy.tools_enabled', type: 'boolean' },
  { env: 'LINGXIAO_USER_AGENT', path: 'network.user_agent', type: 'string' },
  { env: 'LINGXIAO_IDENTITY_JUDGE_LLM', path: 'security.identity_judge_llm_enabled', type: 'boolean' },
  // 企业部署：运维可经 env 单向强制开启加固模式（不能经 Web UI 关闭，锁定逻辑见 HardeningPolicy）
  { env: 'LINGXIAO_HARDENED_MODE', path: 'security.hardened_mode', type: 'boolean' },
];

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current) || typeof current[keys[i]] !== 'object' || current[keys[i]] === null) {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  for (const mapping of ENV_OVERRIDE_MAP) {
    const val = process.env[mapping.env];
    if (val === undefined) continue;
    let converted: string | number | boolean;
    switch (mapping.type) {
      case 'number':
        converted = parseFloat(val);
        if (isNaN(converted as number)) continue;
        break;
      case 'boolean':
        converted = ['true', '1', 'yes'].includes(val.toLowerCase());
        break;
      default:
        converted = val;
    }
    setNestedValue(raw, mapping.path, converted);
  }
  return raw;
}

function normalizeRawUserAgentDefault(raw: Record<string, unknown>): void {
  const network = raw.network;
  if (!network || typeof network !== 'object' || Array.isArray(network)) return;
  const networkRaw = network as Record<string, unknown>;
  const value = networkRaw.user_agent;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '' || isLingxiaoDefaultUserAgent(trimmed)) {
    delete networkRaw.user_agent;
  }
}

// ═══════════════════════════════════════════════════════════════
// 验证
// ═══════════════════════════════════════════════════════════════

export function validateModelProvidersConfig(
  modelProviders: ModelProvidersConfig,
  credentials?: Record<string, string>,
): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const [provider, models] of Object.entries(modelProviders)) {
    if (!Array.isArray(models)) {
      errors.push(`Provider '${provider}' 的配置必须是数组`);
      continue;
    }
    for (const model of models) {
      if (!model.id) {
        errors.push(`Provider '${provider}' 的某个模型缺少 id 字段`);
        continue;
      }
      // 全局唯一 ID
      if (seenIds.has(model.id)) {
        errors.push(`模型 id '${model.id}' 重复，所有 model_providers 中的 id 必须全局唯一`);
      }
      seenIds.add(model.id);

      // apiKey 或 envKey 必须有一个
      if (!model.apiKey && !model.envKey) {
        errors.push(`模型 '${model.id}' 的 apiKey 或 envKey 不能为空`);
      }
      // envKey 必须在 credentials 中存在
      if (model.envKey && credentials && !credentials[model.envKey]) {
        errors.push(`模型 '${model.id}' 的 envKey '${model.envKey}' 在 credentials 中未找到`);
      }
      if (!model.baseUrl) {
        errors.push(`模型 '${model.id}' 的 baseUrl 不能为空`);
      }
      if (!model.provider) {
        errors.push(`模型 '${model.id}' 缺少 provider 字段`);
      } else if (model.provider !== provider) {
        errors.push(`模型 '${model.id}' 的 provider 字段 '${model.provider}' 与配置键 '${provider}' 不匹配`);
      }
      if (model.generationConfig) {
        const gc = model.generationConfig;
        if (gc.temperature !== undefined && (gc.temperature < 0 || gc.temperature > 1)) {
          errors.push(`模型 '${model.id}' 的 temperature 必须在 0-1 之间`);
        }
        if (gc.max_tokens !== undefined && gc.max_tokens <= 0) {
          errors.push(`模型 '${model.id}' 的 max_tokens 必须为正整数`);
        }
      }
    }
  }
  return errors;
}

// ═══════════════════════════════════════════════════════════════
// 加载配置
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Sanitize：自愈历史脏数据
// ═══════════════════════════════════════════════════════════════

const DEFAULT_MARKETPLACE_SOURCES: MarketplaceSourceConfig[] = [
  {
    id: 'skills-local',
    title: 'Local Skills',
    type: 'skill_index',
    enabled: true,
    official: true,
  },
  {
    id: 'skills-official',
    title: 'OpenAI Skills',
    type: 'skill_index',
    url: 'https://api.github.com/repos/openai/skills/git/trees/main?recursive=1',
    enabled: true,
    official: true,
  },
  {
    id: 'plugins-local',
    title: 'Local Plugins',
    type: 'plugin_index',
    enabled: true,
    official: true,
  },
  {
    id: 'mcp-official',
    title: 'Official MCP Registry',
    type: 'mcp_registry',
    url: 'https://registry.modelcontextprotocol.io',
    enabled: true,
    official: true,
  },
];

export function normalizeRawModelProviders(raw: Record<string, unknown>): void {
  const llm = raw.llm;
  if (!llm || typeof llm !== 'object' || Array.isArray(llm)) return;
  const group = llm as Record<string, unknown>;
  const providers = group.model_providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return;

  const globalReasoningEffort = typeof group.reasoning_effort === 'string' ? group.reasoning_effort : undefined;
  const normalizedProviders: Record<string, unknown[]> = {};
  for (const [providerKey, rawEntries] of Object.entries(providers as Record<string, unknown>)) {
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const model = { ...(entry as Record<string, unknown>) };
      const rawVendor = String(model.vendor ?? model.provider ?? providerKey).trim().toLowerCase();
      const provider = rawVendor === 'anthropic' ? 'anthropic' : 'openai';
      model.provider = provider;
      if (typeof model.id !== 'string' || !model.id.trim()) {
        const inferredId = typeof model.model === 'string' && model.model.trim()
          ? model.model
          : typeof model.name === 'string' && model.name.trim()
            ? model.name
            : providerKey;
        model.id = inferredId;
      }
      if (typeof model.url === 'string' && typeof model.baseUrl !== 'string') {
        model.baseUrl = model.url;
      }
      if (typeof model.base_url === 'string' && typeof model.baseUrl !== 'string') {
        model.baseUrl = model.base_url;
      }
      if (typeof model.api_key === 'string' && typeof model.apiKey !== 'string') {
        model.apiKey = model.api_key;
      }
      if (typeof model.env_key === 'string' && typeof model.envKey !== 'string') {
        model.envKey = model.env_key;
      }
      if (typeof model.wire_api === 'string' && typeof model.wireApi !== 'string') {
        model.wireApi = model.wire_api;
      }
      if (typeof model.disable_response_storage === 'boolean' && typeof model.disableResponseStorage !== 'boolean') {
        model.disableResponseStorage = model.disable_response_storage;
      }
      if (typeof model.network_access === 'string' && typeof model.networkAccess !== 'string') {
        model.networkAccess = model.network_access;
      }
      delete model.vendor;
      delete model.url;
      delete model.base_url;
      delete model.api_key;
      delete model.env_key;
      delete model.wire_api;
      delete model.requires_openai_auth;
      delete model.disable_response_storage;
      delete model.network_access;

      if (typeof model.maxInputTokens === 'number' && typeof model.contextWindowSize !== 'number') {
        model.contextWindowSize = model.maxInputTokens;
      }
      const capabilities = model.capabilities && typeof model.capabilities === 'object' && !Array.isArray(model.capabilities)
        ? { ...(model.capabilities as Record<string, unknown>) }
        : {};
      const explicitReasoningEffort = typeof model.model_reasoning_effort === 'string'
        ? model.model_reasoning_effort
        : globalReasoningEffort;
      const shouldEnableReasoning = model.supportsReasoning === true || Boolean(explicitReasoningEffort) || model.wireApi === 'responses';
      if (shouldEnableReasoning && !capabilities.thinking_mode) {
        capabilities.thinking_mode = provider === 'anthropic' ? 'thinking_block' : 'reasoning_effort';
        capabilities.param_name = provider === 'anthropic' ? 'thinking' : 'reasoning_effort';
        capabilities.param_value = provider === 'anthropic' ? { type: 'enabled', budget_tokens: 32_000 } : (explicitReasoningEffort || 'high');
      }
      if (model.supportsImages === true) {
        capabilities.modalities = { ...(capabilities.modalities as Record<string, unknown> | undefined), image: true };
      }
      if (typeof model.maxInputTokens === 'number' && typeof capabilities.contextWindowSize !== 'number') {
        capabilities.contextWindowSize = model.maxInputTokens;
      }
      if (typeof model.maxOutputTokens === 'number' && typeof capabilities.max_output_tokens !== 'number') {
        capabilities.max_output_tokens = model.maxOutputTokens;
      }
      if (Object.keys(capabilities).length > 0) model.capabilities = capabilities;

      const generationConfig = model.generationConfig && typeof model.generationConfig === 'object' && !Array.isArray(model.generationConfig)
        ? { ...(model.generationConfig as Record<string, unknown>) }
        : {};
      if (typeof model.temperature === 'number' && typeof generationConfig.temperature !== 'number') {
        generationConfig.temperature = model.temperature;
      }
      if (Object.keys(generationConfig).length > 0) model.generationConfig = generationConfig;

      delete model.supportsReasoning;
      delete model.supportsToolCall;
      delete model.supportsImages;
      delete model.maxInputTokens;
      delete model.maxOutputTokens;
      delete model.temperature;
      delete model.model_reasoning_effort;

      normalizedProviders[provider] = [...(normalizedProviders[provider] || []), model];
    }
  }
  group.model_providers = normalizedProviders;
}

export function normalizeMarketplaceSources(sources: MarketplaceSourceConfig[] | undefined): MarketplaceSourceConfig[] {
  const byId = new Map<string, MarketplaceSourceConfig>();
  for (const source of DEFAULT_MARKETPLACE_SOURCES) {
    byId.set(source.id, source);
  }
  for (const source of sources || []) {
    if (!source?.id) continue;
    byId.set(source.id, { ...byId.get(source.id), ...source });
  }
  return Array.from(byId.values());
}

export function loadSettings(): Config {
  let raw: Record<string, unknown> = {};

  if (existsSync(SETTINGS_FILE)) {
    try {
      raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch (e) {
      // P0-9 fix: 配置文件损坏时备份并回退默认配置，而非静默忽略
      configLogger.warn(`[Config] 加载 ${SETTINGS_FILE} 失败: ${e}`);
      try {
        const backupPath = SETTINGS_FILE + '.corrupt.' + Date.now();
        copyFileSync(SETTINGS_FILE, backupPath);
        configLogger.warn(`[Config] 损坏的配置文件已备份到 ${backupPath}，将使用默认配置`);
      } catch (backupErr) {
        configLogger.error(`[Config] 备份损坏配置文件失败: ${backupErr}`);
      }
      // raw 保持为空对象，后续合并默认值后使用默认配置
    }
  }

  // 确保新增分组存在
  for (const group of ['context', 'truncation', 'timeouts', 'memory', 'checkpoint', 'llm', 'blackboard', 'network', 'marketplaces', 'mcp', 'plugins', 'tools']) {
    if (!raw[group]) raw[group] = {};
  }

  // 环境变量覆盖
  raw = applyEnvOverrides(raw);
  normalizeRawUserAgentDefault(raw);
  normalizeRawAdvancedConfig(raw);
  normalizeRawModelProviders(raw);

  // 解析 schema
  let config = ConfigSchema.parse(raw);

  config.marketplaces.sources = normalizeMarketplaceSources(config.marketplaces.sources);

  // 填充路径默认值
  if (!config.paths.db_path) config.paths.db_path = join(CONFIG_DIR, D.PATHS.DB_NAME);
  if (!config.paths.log_dir) config.paths.log_dir = join(CONFIG_DIR, D.PATHS.LOG_DIR_NAME);
  if (!config.paths.skills_dir) config.paths.skills_dir = join(CONFIG_DIR, D.PATHS.SKILLS_DIR_NAME);

  // 初始化语言
  setLanguage(config.ui.language);

  // 确保日志目录存在
  if (!existsSync(config.paths.log_dir)) {
    mkdirSync(config.paths.log_dir, { recursive: true });
  }

  return config;
}

// ═══════════════════════════════════════════════════════════════
// 保存配置
// ═══════════════════════════════════════════════════════════════

function serializeSettings(cfg: Config): string {
  const network = { ...cfg.network };
  if (!network.user_agent || isLingxiaoDefaultUserAgent(network.user_agent)) {
    delete (network as Partial<Config['network']>).user_agent;
  }
  const ordered = {
    version: cfg.version,
    credentials: cfg.credentials,
    llm: cfg.llm,
    llm_gateway: cfg.llm_gateway,
    agents: cfg.agents,
    verification: cfg.verification,
    leader: cfg.leader,
    health: cfg.health,
    context: cfg.context,
    truncation: cfg.truncation,
    timeouts: cfg.timeouts,
    web_api: cfg.web_api,
    paths: cfg.paths,
    skills: cfg.skills,
    plugins: cfg.plugins,
    marketplaces: cfg.marketplaces,
    mcp: cfg.mcp,
    tools: cfg.tools,
    roles: cfg.roles,
    server: cfg.server,
    network,
    browser: cfg.browser,
    security: cfg.security,
    memory: cfg.memory,
    checkpoint: cfg.checkpoint,
    ui: cfg.ui,
    message_bus: cfg.message_bus,
    observability: cfg.observability,
    taskPriority: cfg.taskPriority,
    scaling: cfg.scaling,
    blackboard: cfg.blackboard,
    advanced: cfg.advanced,
    git: cfg.git,
    initialized: cfg.initialized,
  };
  return JSON.stringify(ordered, null, 4);
}

export function saveSettings(cfg: Config): void {
  try {
    if (cfg.llm.model_providers && Object.keys(cfg.llm.model_providers).length > 0) {
      const errors = validateModelProvidersConfig(cfg.llm.model_providers, cfg.credentials);
      if (errors.length > 0) {
        configLogger.error('[Config] ❌ modelProviders 配置验证失败: ' + errors.map(e => `  - ${e}`).join('; '));
        throw new Error(t('error.config_validation') + ': ' + errors.join('; '));
      }
    }
    writeFileSync(SETTINGS_FILE, serializeSettings(cfg), 'utf-8');
    if (!IS_WINDOWS) {
      chmodSync(SETTINGS_FILE, 0o600);
    }
    configLogger.info('[Config] ✓ 配置已保存');
  } catch (e) {
    configLogger.error(`[Config] 保存配置文件失败: ${e}`);
    throw e;
  }
}

export function generateDefaultSettings(): void {
  if (existsSync(SETTINGS_FILE)) {
    configLogger.info(`[Config] settings.json 已存在，跳过自动生成 (${SETTINGS_FILE})`);
    return;
  }
  const defaults = ConfigSchema.parse({});
  if (!defaults.paths.db_path) defaults.paths.db_path = join(CONFIG_DIR, D.PATHS.DB_NAME);
  if (!defaults.paths.log_dir) defaults.paths.log_dir = join(CONFIG_DIR, D.PATHS.LOG_DIR_NAME);
  if (!defaults.paths.skills_dir) defaults.paths.skills_dir = join(CONFIG_DIR, D.PATHS.SKILLS_DIR_NAME);
  defaults.initialized = false;
  saveSettings(defaults);
  configLogger.info(`[Config] ✓ 已生成默认配置: ${SETTINGS_FILE}`);
}

// ═══════════════════════════════════════════════════════════════
// 全局配置实例
// ═══════════════════════════════════════════════════════════════

export const config = loadSettings();

export function refreshRuntimeConfig(): Config {
  const latest = loadSettings();
  // 深拷贝避免嵌套对象引用不一致
  const fresh = structuredClone(latest);
  for (const key of Object.keys(config) as (keyof Config)[]) {
    delete config[key];
  }
  Object.assign(config, fresh);
  // 同步派生常量：export let 变量在模块加载时从 config 快照赋值，
  // refreshRuntimeConfig 原地更新 config 对象后必须显式同步这些 let 变量，
  // 否则消费方仍读到启动时的旧值。
  syncDerivedConstants();
  return config;
}

// ═══════════════════════════════════════════════════════════════
// Settings 文件热加载（chokidar）
// ═══════════════════════════════════════════════════════════════

let settingsWatcher: ReturnType<typeof watch> | null = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const RELOAD_DEBOUNCE_MS = 500;

// 配置热加载回调：让 ModelManager 等下游模块在 settings.json 变更后自行同步状态，
// 避免在 config.ts 里直接 import 反向依赖造成循环。
type ConfigReloadHandler = (cfg: Config) => void;
const configReloadHandlers: Set<ConfigReloadHandler> = new Set();

export function onConfigReload(handler: ConfigReloadHandler): () => void {
  configReloadHandlers.add(handler);
  return () => configReloadHandlers.delete(handler);
}

export function fireConfigReload(): void {
  for (const handler of configReloadHandlers) {
    try {
      handler(config);
    } catch (e) {
      configLogger.warn(`[Config] 热加载回调异常: ${e}`);
    }
  }
}

export function startSettingsWatcher(): void {
  if (settingsWatcher) return; // 已启动

  settingsWatcher = watch(SETTINGS_FILE, {
    persistent: false,    // 不阻塞进程退出
    ignoreInitial: true,  // 启动时不触发
    awaitWriteFinish: {   // 等写入完成再触发
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  settingsWatcher.on('change', () => {
    // 防抖：短时间内多次写入只触发一次
    if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = setTimeout(() => {
      reloadDebounceTimer = null;
      try {
        refreshRuntimeConfig();
        // 通知下游模块 (ModelManager 等) 同步派生状态，
        // 避免下一次读取仍走启动时缓存的旧值。
        fireConfigReload();
        configLogger.info('[Config] ✓ settings.json 热加载完成');
      } catch (e) {
        configLogger.warn(`[Config] settings.json 热加载失败: ${e}`);
      }
    }, RELOAD_DEBOUNCE_MS);
  });

  settingsWatcher.on('error', (err) => {
    configLogger.warn(`[Config] settings watcher 错误: ${err}`);
  });

  configLogger.info(`[Config] ✓ settings.json 热加载已启动 (${SETTINGS_FILE})`);
}

export function stopSettingsWatcher(): void {
  if (reloadDebounceTimer) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = null;
  }
  if (settingsWatcher) {
    settingsWatcher.close();
    settingsWatcher = null;
    configLogger.info('[Config] settings.json 热加载已停止');
  }
}

export let AGENT_MAX_ITERATIONS = config.agents.max_iterations;
export let AGENT_MAX_RUNTIME_MINUTES = config.agents.max_runtime_minutes;
export let LEADER_MAX_TOOL_ROUNDS = config.leader.max_tool_rounds;
export let LEADER_MAX_RUNTIME_MINUTES = config.leader.max_runtime_minutes;
export let LEADER_PROBE_SILENCE_SECONDS = config.leader.probe_silence_seconds;
export let LEADER_PROBE_MAX_INTERVAL_SECONDS = config.leader.probe_max_interval_seconds;
export let LEADER_PROBE_BACKOFF_MULTIPLIER = config.leader.probe_backoff_multiplier;
export let LEADER_IDLE_WARNING_SECONDS = config.leader.idle_warning_seconds;
export let PLAN_REVIEW_ENABLED = config.leader.plan_review_enabled;
export let ENABLE_STREAMING = config.llm.enable_streaming;
export let ENABLE_THINKING_INSTRUCTION = config.llm.enable_thinking_instruction;
export let MAX_CONVERSATION_MESSAGES = config.agents.max_conversation_messages;
export let MAX_AGENT_MESSAGES = config.agents.max_agent_messages;
export let HEALTH_POLL_INTERVAL_SECONDS = config.health.poll_interval_seconds;
export let HEALTH_STALL_THRESHOLD_SECONDS = config.health.stall_threshold_seconds;
export let HEALTH_STUCK_THRESHOLD_SECONDS = config.health.stuck_threshold_seconds;
export let HEALTH_RUNAWAY_THRESHOLD_SECONDS = config.health.runaway_threshold_seconds;
export let HEALTH_NUDGE_COOLDOWN_SECONDS = config.health.nudge_cooldown_seconds;
export let HEALTH_MAX_NUDGE_BEFORE_ESCALATION = config.health.max_nudge_before_escalation;

/**
 * 同步派生常量：将 config 对象的最新值写回 export let 变量。
 *
 * 这些变量在模块加载时从 config 快照赋值，之后 config 对象可能被
 * refreshRuntimeConfig() 原地更新。调用此函数让所有派生常量与
 * 最新 config 保持一致，确保消费方读到热加载后的新值。
 */
export function syncDerivedConstants(): void {
  AGENT_MAX_ITERATIONS = config.agents.max_iterations;
  AGENT_MAX_RUNTIME_MINUTES = config.agents.max_runtime_minutes;
  LEADER_MAX_TOOL_ROUNDS = config.leader.max_tool_rounds;
  LEADER_MAX_RUNTIME_MINUTES = config.leader.max_runtime_minutes;
  LEADER_PROBE_SILENCE_SECONDS = config.leader.probe_silence_seconds;
  LEADER_PROBE_MAX_INTERVAL_SECONDS = config.leader.probe_max_interval_seconds;
  LEADER_PROBE_BACKOFF_MULTIPLIER = config.leader.probe_backoff_multiplier;
  LEADER_IDLE_WARNING_SECONDS = config.leader.idle_warning_seconds;
  PLAN_REVIEW_ENABLED = config.leader.plan_review_enabled;
  ENABLE_STREAMING = config.llm.enable_streaming;
  ENABLE_THINKING_INSTRUCTION = config.llm.enable_thinking_instruction;
  MAX_CONVERSATION_MESSAGES = config.agents.max_conversation_messages;
  MAX_AGENT_MESSAGES = config.agents.max_agent_messages;
  HEALTH_POLL_INTERVAL_SECONDS = config.health.poll_interval_seconds;
  HEALTH_STALL_THRESHOLD_SECONDS = config.health.stall_threshold_seconds;
  HEALTH_STUCK_THRESHOLD_SECONDS = config.health.stuck_threshold_seconds;
  HEALTH_RUNAWAY_THRESHOLD_SECONDS = config.health.runaway_threshold_seconds;
  HEALTH_NUDGE_COOLDOWN_SECONDS = config.health.nudge_cooldown_seconds;
  HEALTH_MAX_NUDGE_BEFORE_ESCALATION = config.health.max_nudge_before_escalation;
}

function hasNestedValue(obj: Record<string, unknown>, path: string): boolean {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

function loadRawSettingsForSource(): Record<string, unknown> {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {/* expected: data unavailable */
    return {};
  }
}

export function getConfigSource(path: string): ConfigSourceOld {
  if (ENV_OVERRIDE_MAP.some((mapping) => mapping.path === path && process.env[mapping.env] !== undefined)) {
    return 'env';
  }

  const raw = loadRawSettingsForSource();
  if (hasNestedValue(raw, path)) {
    return 'file';
  }

  return 'default';
}

export function getConfigValue(path: string): unknown {
  const keys = path.split('.');
  let current: unknown = config;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setConfigValue(path: string, value: unknown): void {
  const keys = path.split('.');
  let current: unknown = config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') return;
    current = (current as Record<string, unknown>)[keys[i]];
  }
  if (current !== null && current !== undefined && typeof current === 'object') {
    (current as Record<string, unknown>)[keys[keys.length - 1]] = value;
  }
}
