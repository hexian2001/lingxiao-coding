/**
 * TUI 首次启动 LLM 配置引导（与 Web UI OnboardingWizard 对齐）
 *
 * 当 initialized=false 时，TUI 启动时自动进入引导模式。
 * 引导完成后设置 initialized=true，与 Web UI 共享同一个标志。
 *
 * 不走 HTTP API，直接在进程内操作 config（setConfigValue + saveSettings）。
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { config, setConfigValue, saveSettings, refreshRuntimeConfig, SETTINGS_FILE } from '../config.js';
import type { ModelProviderConfig, ModelProvidersConfig } from '../config.js';
import { getCommonModels } from '../cli_model_suggestions.js';

// ── Web UI 同步轮询 ───────────────────────────────────────────────

/**
 * 后台轮询检测 Web UI 是否已完成配置。
 * 在 inquirer prompt 等待用户输入期间，步骤边界的 isAlreadyInitialized() 无法触发。
 * 此函数用 Promise.race 让 prompt 与定时轮询竞争，一旦检测到 initialized=true
 * 立即返回 sentinel，调用方据此跳过后续引导步骤。
 */
const WEB_UI_POLL_INTERVAL_MS = 2000;

/** Sentinel 标记 Web UI 已完成配置 */
const WEB_UI_COMPLETED = '__WEB_UI_COMPLETED__' as const;

/**
 * 包装 inquirer.prompt，加入后台轮询：如果 Web UI 已完成配置则提前返回 sentinel。
 * 返回值可能是真实 prompt 结果或 { __webUiCompleted: true }。
 */
/**
 * 包装 inquirer.prompt，加入后台轮询：如果 Web UI 已完成配置则提前返回 sentinel。
 * 返回值可能是真实 prompt 结果或 { __webUiCompleted: true }。
 */
async function promptWithWebUiCheck<T extends Record<string, unknown>>(
  // inquirer v13 的 Question 类型与 v12 不同，用宽松类型避免类型冲突
  questions: readonly Record<string, unknown>[],
): Promise<T & { __webUiCompleted?: true }> {
  let timer: ReturnType<typeof setInterval> | null = null;

  // Start inquirer prompt — keep reference to .ui for abort/cleanup
  const promptPromise = inquirer.prompt(questions as any) as Promise<T> & {
    ui?: { close: () => void };
  };

  // Wrap to suppress AbortPromptError when we abort after web UI detection;
  // re-throw genuine errors (Ctrl+C → ExitPromptError, etc.)
  const handledPrompt = promptPromise.catch((e: unknown) => {
    if (e instanceof Error && e.name === 'AbortPromptError') return null as unknown as T;
    throw e;
  });

  const webUiDetected = new Promise<T & { __webUiCompleted: true }>((resolve) => {
    timer = setInterval(() => {
      refreshRuntimeConfig();
      if (config.initialized === true) {
        if (timer) { clearInterval(timer); timer = null; }
        resolve({ __webUiCompleted: true } as T & { __webUiCompleted: true });
      }
    }, WEB_UI_POLL_INTERVAL_MS);
  });

  try {
    const result = await Promise.race([
      handledPrompt,
      webUiDetected,
    ]);

    if ((result as Record<string, unknown>).__webUiCompleted) {
      // Web UI won — abort inquirer prompt to trigger its terminal cleanup
      // (cursor show, output unmute, readline close)
      try { promptPromise.ui?.close(); } catch {}
      // Clear residual prompt text on the terminal line, move to fresh line
      process.stdout.write('\x1b[2K\r\n');
    }

    return result;
  } finally {
    if (timer) { clearInterval(timer); timer = null; }
  }
}

// ── 常量 ───────────────────────────────────────────────────────────

const DEFAULT_MODEL_BASE_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
};

const PROVIDER_CHOICES = [
  { name: 'OpenAI', value: 'openai' },
  { name: 'Anthropic', value: 'anthropic' },
];

// ── 类型 ───────────────────────────────────────────────────────────

interface OnboardingConfig {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  baseUrl: string;
  model: string;
  workspace: string;
}

// ── 核心引导流程 ───────────────────────────────────────────────────

/**
 * 运行 TUI 首次启动引导流程。
 *
 * 6 步交互式引导：
 * 1. 选择 Provider（OpenAI / Anthropic）
 * 2. 输入 API Key
 * 3. 输入 Base URL（带默认值）
 * 4. 输入 Model name（带推荐值）
 * 5. 输入 Workspace 路径（默认 cwd）
 * 6. 确认配置 → 写入 config
 *
 * 与 Web UI OnboardingWizard 的 handleComplete 逻辑对齐：
 * - 创建 model provider 条目 → config.llm.model_providers
 * - 设置 leader_model 和 agent_model
 * - 设置 initialized = true
 */
/**
 * 检查是否已被 Web UI 完成配置（initialized 被另一端设为 true）。
 * 如果是，则跳过 TUI 引导。
 */
function isAlreadyInitialized(): boolean {
  refreshRuntimeConfig();
  return config.initialized === true;
}

export async function runOnboarding(): Promise<void> {
  console.log();
  console.log(chalk.cyan.bold('═══════════════════════════════════════════════════════'));
  console.log(chalk.cyan.bold('  🗡️  凌霄首次配置引导'));
  console.log(chalk.cyan.bold('═══════════════════════════════════════════════════════'));
  console.log(chalk.dim('  检测到首次启动，请完成 LLM 配置以开始使用。'));
  console.log(chalk.dim('  配置完成后可随时通过 `lingxiao init` 重新配置。'));
  console.log(chalk.dim('  💡 你也可以在浏览器 Web UI 中完成配置，TUI 会自动检测。'));
  console.log();

  if (isAlreadyInitialized()) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }

  // Step 1: 选择 Provider
  const step1 = await promptWithWebUiCheck<{ provider: 'openai' | 'anthropic' }>([{
    type: 'list',
    name: 'provider',
    message: 'Step 1/5: 选择 LLM Provider',
    choices: PROVIDER_CHOICES,
    default: 'openai',
  }]);
  if (step1.__webUiCompleted) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }
  const { provider } = step1;

  const defaultBaseUrl = DEFAULT_MODEL_BASE_URL[provider] || DEFAULT_MODEL_BASE_URL.openai;
  const defaultModel = PROVIDER_DEFAULT_MODELS[provider] || '';

  if (isAlreadyInitialized()) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }

  // Step 2: 输入 API Key
  const step2 = await promptWithWebUiCheck<{ apiKey: string }>([{
    type: 'password',
    name: 'apiKey',
    message: 'Step 2/5: 输入 API Key',
    mask: '*',
    validate: (input: string) => {
      if (!input || !input.trim()) return 'API Key 不能为空';
      return true;
    },
  }]);
  if (step2.__webUiCompleted) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }
  const { apiKey } = step2;

  if (isAlreadyInitialized()) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }

  // Step 3: 输入 Base URL
  const step3 = await promptWithWebUiCheck<{ baseUrl: string }>([{
    type: 'input',
    name: 'baseUrl',
    message: 'Step 3/5: 输入 Base URL（可选，回车使用默认值）',
    default: defaultBaseUrl,
  }]);
  if (step3.__webUiCompleted) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }
  const { baseUrl } = step3;

  const resolvedBaseUrl = baseUrl.trim() || defaultBaseUrl;

  if (isAlreadyInitialized()) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }

  // Step 4: 输入 Model name
  const commonModels = getCommonModels(provider, resolvedBaseUrl);
  const modelChoices = [
    ...commonModels.map((m) => ({ name: m, value: m })),
    new inquirer.Separator(),
    { name: '✏️  自定义输入', value: '__custom__' },
  ];

  const step4 = await promptWithWebUiCheck<{ modelChoice: string }>([{
    type: 'list',
    name: 'modelChoice',
    message: 'Step 4/5: 选择 Model name',
    choices: modelChoices,
    default: defaultModel,
  }]);
  if (step4.__webUiCompleted) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }
  const { modelChoice } = step4;

  let model: string;
  if (modelChoice === '__custom__') {
    const step4b = await promptWithWebUiCheck<{ customModel: string }>([{
      type: 'input',
      name: 'customModel',
      message: '请输入 Model name:',
      default: defaultModel,
      validate: (input: string) => {
        if (!input || !input.trim()) return 'Model name 不能为空';
        return true;
      },
    }]);
    if (step4b.__webUiCompleted) {
      console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
      return;
    }
    model = step4b.customModel.trim();
  } else {
    model = modelChoice;
  }

  if (isAlreadyInitialized()) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }

  // Step 5: 输入 Workspace 路径
  const step5 = await promptWithWebUiCheck<{ workspace: string }>([{
    type: 'input',
    name: 'workspace',
    message: 'Step 5/5: 输入 Workspace 路径（可选，回车使用当前目录）',
    default: process.cwd(),
  }]);
  if (step5.__webUiCompleted) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }
  const { workspace } = step5;

  const resolvedWorkspace = workspace.trim() || process.cwd();

  const onboardingConfig: OnboardingConfig = {
    provider,
    apiKey: apiKey.trim(),
    baseUrl: resolvedBaseUrl,
    model,
    workspace: resolvedWorkspace,
  };

  // Step 6: 确认配置
  console.log();
  console.log(chalk.cyan('── 配置确认 ──'));
  console.log(`  Provider:  ${chalk.bold(onboardingConfig.provider)}`);
  console.log(`  API Key:   ${'*'.repeat(8)}...`);
  console.log(`  Base URL:  ${onboardingConfig.baseUrl}`);
  console.log(`  Model:     ${chalk.bold(onboardingConfig.model)}`);
  console.log(`  Workspace: ${onboardingConfig.workspace}`);
  console.log();

  const step6 = await promptWithWebUiCheck<{ confirm: boolean }>([{
    type: 'confirm',
    name: 'confirm',
    message: '确认以上配置并保存？',
    default: true,
  }]);
  if (step6.__webUiCompleted) {
    console.log(chalk.green('✓ 检测到配置已完成（来自 Web UI），跳过 TUI 引导。'));
    return;
  }
  const { confirm } = step6;

  if (!confirm) {
    console.log(chalk.yellow('配置已取消。请重新运行 `lingxiao` 或 `lingxiao init` 完成配置。'));
    process.exit(0);
  }

  // 保存配置（与 Web UI handleComplete 逻辑对齐）
  await saveOnboardingConfig(onboardingConfig);

  console.log();
  console.log(chalk.green.bold(`✓ 配置已保存: ${SETTINGS_FILE}`));
  console.log(chalk.dim('  下次启动将跳过引导，直接进入 TUI 主界面。'));
  console.log();
}

// ── 配置保存逻辑 ───────────────────────────────────────────────────

/**
 * 将引导配置写入 config，与 Web UI OnboardingWizard.handleComplete 对齐。
 *
 * 对应 Web UI 的 4 个 API 调用：
 * 1. POST /settings/model-provider → 创建 provider 条目
 * 2. PUT /settings/general { key: 'model', value: modelId } → llm.leader_model
 * 3. PUT /settings/general { key: 'agentModel', value: modelId } → llm.agent_model
 * 4. PUT /settings/general { key: 'initialized', value: true } → initialized
 */
async function saveOnboardingConfig(cfg: OnboardingConfig): Promise<void> {
  // 深拷贝当前 config 避免引用问题
  const userSettings = { ...config };
  userSettings.llm = { ...config.llm };
  userSettings.llm.model_providers = { ...config.llm.model_providers };

  // 1. 创建 model provider 条目（对应 POST /settings/model-provider）
  const modelId = cfg.model;
  const providerConfig: ModelProviderConfig = {
    id: modelId,
    name: modelId,
    model: modelId,
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
  };

  const existingProviders = (userSettings.llm.model_providers || {}) as ModelProvidersConfig;
  const providerList = existingProviders[cfg.provider]
    ? [...existingProviders[cfg.provider]]
    : [];

  // 去重：如果已存在相同 id 的条目，先移除
  const filteredList = providerList.filter((m) => m.id !== modelId);
  filteredList.push(providerConfig);

  const nextProviders: ModelProvidersConfig = {
    ...existingProviders,
    [cfg.provider]: filteredList,
  };

  setConfigValue('llm.model_providers', nextProviders);
  setConfigValue('llm.provider', cfg.provider);

  // 2. 设置 leader_model（对应 PUT /settings/general { key: 'model', value: modelId }）
  setConfigValue('llm.leader_model', modelId);

  // 3. 设置 agent_model（对应 PUT /settings/general { key: 'agentModel', value: modelId }）
  setConfigValue('llm.agent_model', modelId);

  // 4. 设置 initialized = true（对应 PUT /settings/general { key: 'initialized', value: true }）
  setConfigValue('initialized', true);

  // 持久化并刷新运行时配置
  saveSettings(config);
  refreshRuntimeConfig();
}
