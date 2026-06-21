/**
 * /config 命令实现
 *
 * 查看当前生效的配置及其来源（default/env/file）
 * 支持 /config set <key> <value> 修改配置（层级路径）
 * 支持 /config reset <key> 恢复默认值
 */

import {
  saveSettings, config as runtimeConfig,
  ConfigSchema, getConfigValue, setConfigValue,
  SETTINGS_FILE, getConfigSource,
} from '../config.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';

/**
 * 配置分组映射（层级路径）
 */
const CATEGORY_MAP: Record<string, string[]> = {
  'LLM': [
    'llm.provider', 'llm.leader_model', 'llm.agent_model',
    'llm.enable_streaming', 'llm.max_retries',
    'llm.request_timeout_s', 'llm.connect_timeout_s',
    'llm.first_token_timeout_s', 'llm.first_token_timeout_thinking_s',
    'llm.context_max_tokens', 'llm.capped_max_tokens', 'llm.escalated_max_tokens',
    'llm.thinking_budget_tokens', 'llm.reasoning_effort', 'llm.show_thinking_content',
    'llm.enable_thinking_instruction', 'llm.enable_extended_thinking',
  ],
  'Agent': [
    'agents.max_concurrent', 'agents.max_iterations', 'agents.max_runtime_minutes',
    'agents.permission_timeout_ms', 'agents.tool_result_max_chars',
    'agents.max_conversation_messages', 'agents.max_agent_messages',
    'agents.max_continuation_depth',
  ],
  'Leader': [
    'leader.max_tool_rounds', 'leader.max_runtime_minutes', 'leader.round_timeout_ms',
    'leader.probe_silence_seconds', 'leader.probe_max_interval_seconds',
    'leader.probe_backoff_multiplier', 'leader.idle_warning_seconds',
    'leader.idle_probe_max_wait_ms', 'leader.idle_probe_backoff_base_ms',
    'leader.agent_report_max_chars', 'leader.plan_review_enabled',
  ],
  '健康监控': [
    'health.poll_interval_seconds', 'health.stall_threshold_seconds',
    'health.stuck_threshold_seconds', 'health.runaway_threshold_seconds',
    'health.nudge_cooldown_seconds', 'health.max_nudge_before_escalation',
  ],
  '上下文': [
    'context.token_limit', 'context.autocompact_buffer_tokens',
    'context.compact_llm_timeout_ms', 'context.max_consecutive_failures',
    'context.preserved_system_count', 'context.preserved_recent_count',
    'context.max_recent_message_count', 'context.post_compact_token_budget',
    'context.recent_window_token_budget', 'context.max_request_bytes',
    'context.max_single_message_bytes', 'context.autocompact_ratio',
  ],
  '截断': [
    'truncation.shell_stdout_max', 'truncation.shell_stderr_max',
    'truncation.python_max_output', 'truncation.tool_result_preview',
    'truncation.webfetch_markdown_max',
  ],
  '超时': [
    'timeouts.graceful_shutdown_ms', 'timeouts.hook_default_ms',
    'timeouts.hook_timeout_ms', 'timeouts.permission_sync_timeout_ms',
    'timeouts.heartbeat_interval_ms', 'timeouts.browser_goto_ms',
    'timeouts.worker_spawn_ms',
  ],
  '路径': [
    'paths.db_path', 'paths.log_dir', 'paths.skills_dir',
    'paths.chrome_path', 'paths.bundled_skills_dir', 'paths.global_skills_dir',
  ],
  '服务器': ['server.host', 'server.port'],
  'UI': ['ui.language'],
  '消息总线': ['message_bus.warning_threshold', 'message_bus.critical_threshold'],
};

/**
 * 来源标签样式
 */
function sourceLabel(source: string): string {
  switch (source) {
    case 'env': return '[env]';
    case 'file': return '[file]';
    default: return '[default]';
  }
}

/**
 * 格式化 /config 输出
 */
export function formatConfigDisplay(): string {
  const lines: string[] = ['⚙ 当前配置:'];

  for (const [category, keys] of Object.entries(CATEGORY_MAP)) {
    lines.push(`\n━━ ${category} ━━`);
    for (const key of keys) {
      const value = getConfigValue(key);
      if (value === undefined) continue;

      const displayValue = typeof value === 'string' && value.length > 40
        ? value.substring(0, 37) + '...'
        : String(value);

      lines.push(`  ${key}: ${displayValue} ${sourceLabel(getConfigSource(key))}`);
    }
  }

  return lines.join('\n');
}

function resolveConfigKey(key: string): string | null {
  const value = getConfigValue(key);
  if (value !== undefined) return key;
  return null;
}

/**
 * 获取所有已知配置路径
 */
function getAllKnownPaths(): string[] {
  const paths: string[] = [];
  for (const keys of Object.values(CATEGORY_MAP)) {
    paths.push(...keys);
  }
  return paths;
}

/**
 * 处理 /config set <key> <value>
 */
export function handleConfigSet(args: string): string {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    return '用法: /config set <key> <value>\n示例: /config set llm.max_retries 3';
  }

  const rawKey = parts[0];
  const valueStr = parts.slice(1).join(' ');

  // 解析 key
  const resolvedKey = resolveConfigKey(rawKey);
  if (!resolvedKey) {
    const allPaths = getAllKnownPaths();
    const close = allPaths.filter(k => k.includes(rawKey) || rawKey.includes(k)).slice(0, 5);
    return `无效的配置键: "${rawKey}"\n可能的候选: ${close.length > 0 ? close.join(', ') : '见 /config 输出'}`;
  }

  // 类型转换
  const currentValue = getConfigValue(resolvedKey);
  let parsedValue: unknown = valueStr;

  // 布尔值（大小写不敏感）
  if (valueStr.toLowerCase() === 'true') parsedValue = true;
  else if (valueStr.toLowerCase() === 'false') parsedValue = false;
  // JSON 数组/对象
  else if ((valueStr.startsWith('[') && valueStr.endsWith(']')) || (valueStr.startsWith('{') && valueStr.endsWith('}'))) {
    try { parsedValue = JSON.parse(valueStr); } catch { /* 不是合法 JSON，保持字符串 */ }
  }
  // 数字
  else if (typeof currentValue === 'number') {
    const num = Number(valueStr);
    if (!isNaN(num)) parsedValue = num;
  }
  else if (/^\d+$/.test(valueStr)) parsedValue = parseInt(valueStr, 10);
  else if (/^\d+\.\d+$/.test(valueStr)) parsedValue = parseFloat(valueStr);

  // 设置值
  setConfigValue(resolvedKey, parsedValue);

  try {
    // 用 Zod schema 验证整个配置
    ConfigSchema.parse(runtimeConfig);
    saveSettings(runtimeConfig);
    return `✓ ${resolvedKey} = ${valueStr}\n来源: [file] (已持久化)`;
  } catch (e: unknown) {
    // 回滚
    setConfigValue(resolvedKey, currentValue);
    const msg = e instanceof Error ? e.message : '验证失败';
    return `✗ 值验证失败: ${msg}`;
  }
}

/**
 * 处理 /config init [--force]
 * 重置配置为默认值，保留现有 API Key 和模型设置（除非 --clear-keys）
 */
export function handleConfigInit(args: string): string {
  const trimmed = args.trim();
  const force = trimmed.includes('--force');
  const clearKeys = trimmed.includes('--clear-keys');

  if (existsSync(SETTINGS_FILE) && !force) {
    return [
      '配置文件已存在。可用选项:',
      '  /config init --force          重置为默认值（保留 API Key 和模型）',
      '  /config init --force --clear-keys  重置所有配置（含 API Key）',
    ].join('\n');
  }

  // 从 schema 生成干净默认配置
  const defaults = ConfigSchema.parse({});

  // 保留现有 API Key 和模型设置
  if (!clearKeys && existsSync(SETTINGS_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
      const llm = existing?.llm;
      if (llm) {
        if (llm.leader_model) defaults.llm.leader_model = llm.leader_model;
        if (llm.agent_model) defaults.llm.agent_model = llm.agent_model;
        if (llm.provider) defaults.llm.provider = llm.provider;
        if (llm.model_providers) defaults.llm.model_providers = llm.model_providers;
      }
      const existing_credentials = existing?.credentials;
      if (existing_credentials) {
        defaults.credentials = existing_credentials;
      }
    } catch { /* 读取失败则完全使用默认值 */ }
  }

  defaults.initialized = true;
  saveSettings(defaults);

  const note = clearKeys ? '（含 API Key 和模型设置）' : '（已保留 API Key 和模型设置）';
  return `✓ 配置已重置为默认值 ${note}\n配置文件: ${SETTINGS_FILE}`;
}

/**
 * 处理 /config reset-all [--include-keys]
 * 一键重置所有配置为默认值
 */
export function handleConfigResetAll(args: string): string {
  const includeKeys = args.trim() === '--include-keys';
  return handleConfigInit(includeKeys ? '--force --clear-keys' : '--force');
}

/**
 * 处理 /config reset <key>
 */
export function handleConfigReset(args: string): string {
  const rawKey = args.trim();
  if (!rawKey) {
    return '用法: /config reset <key>\n示例: /config reset llm.max_retries';
  }

  const resolvedKey = resolveConfigKey(rawKey);
  if (!resolvedKey) {
    return `无效的配置键: "${rawKey}"`;
  }

  const oldValue = getConfigValue(resolvedKey);

  // 删除 settings.json 中该 key 的值，让默认值生效
  try {
    if (existsSync(SETTINGS_FILE)) {
      const content = readFileSync(SETTINGS_FILE, 'utf-8');
      const settings = JSON.parse(content);
      removeNestedKey(settings, resolvedKey);
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4), 'utf-8');
    }

    return `✓ ${resolvedKey} 已恢复默认值 (原值: ${oldValue})`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '重置失败';
    return `✗ 重置失败: ${msg}`;
  }
}

/**
 * 删除嵌套 key
 */
function removeNestedKey(obj: Record<string, unknown>, path: string): void {
  const keys = path.split('.');
  let current: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') return;
    current = (current as Record<string, unknown>)[keys[i]];
  }
  if (current !== null && current !== undefined && typeof current === 'object') {
    delete (current as Record<string, unknown>)[keys[keys.length - 1]];
  }
}

/**
 * 处理 /config 命令路由
 */
export function handleConfigCommand(args: string): string {
  const trimmed = args.trim();

  if (trimmed.startsWith('set ')) {
    return handleConfigSet(trimmed.slice(4));
  }

  if (trimmed.startsWith('reset-all')) {
    return handleConfigResetAll(trimmed.slice(9));
  }

  if (trimmed.startsWith('reset ')) {
    return handleConfigReset(trimmed.slice(6));
  }

  if (trimmed.startsWith('init')) {
    return handleConfigInit(trimmed.slice(4));
  }

  if (trimmed === 'export') {
    return formatConfigExport();
  }

  return formatConfigDisplay();
}

/**
 * 导出配置（排除 API key）
 */
function formatConfigExport(): string {
  const exportObj: Record<string, unknown> = {};

  for (const [category, keys] of Object.entries(CATEGORY_MAP)) {
    for (const key of keys) {
      const value = getConfigValue(key);
      // 排除 API key
      if (key.includes('api_key')) {
        exportObj[key] = '***';
      } else {
        exportObj[key] = value;
      }
    }
  }

  return JSON.stringify(exportObj, null, 2);
}
