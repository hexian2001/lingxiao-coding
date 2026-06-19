/**
 * HardeningPolicy — 企业内网加固模式的统一判定入口
 *
 * 设计契约见 scratchpad/design_hardened_mode.md §2。
 *
 * 设计要点：
 * - **单一只读策略**：所有加固点（PermissionSystem / 工具执行层 / web-server 中间件）
 *   只问这里"我该不该收紧"，绝不自行 `getConfigValue('security.hardened_mode')`，
 *   避免语义漂移（有的地方忘了 OR 现有开关、有的漏了 env 覆盖）。
 * - **纯函数 + 无状态**：每次调用实时读 `getConfigValue`（config.ts 已有热刷新
 *   `refreshRuntimeConfig`），不缓存，确保 PUT 改配置后立即生效。
 * - **env 单向锁定**：`LINGXIAO_HARDENED_MODE` 为真时 `isHardenedMode()` 恒 true，
 *   优先级高于 settings.json，且不能经 Web UI 关闭（PUT 拒绝逻辑见 SettingsRoutes）。
 *
 * 本模块只提供判定，不实现各加固项的收紧逻辑——那些在 T-17 / T-18 的消费点接入。
 */

import { getConfigValue } from '../config.js';

/**
 * 加固模式下子进程 / 终端透传的内置最小环境变量白名单。
 * 当 `security.env_allowlist` 为空数组时使用此默认集。
 *
 * 务必排除任何 `LINGXIAO_*` 内部变量与凭据类变量
 * （`*_API_KEY` / `*_TOKEN` / `*_SECRET` / `*_KEY` / `*_PASSWORD`）。
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PYTHONPATH',
  'PYTHONUNBUFFERED',
  'NODE_PATH',
  'SHELL',
  'TERM',
  'COMSPEC',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'USERNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'NUMBER_OF_PROCESSORS',
];

/**
 * 凭据类变量名后缀（大小写不敏感）。即使出现在白名单里，加固模式下也应被剔除，
 * 防止误配把密钥透传给子进程。供 `filterEnv` 二次过滤使用。
 */
const CREDENTIAL_SUFFIXES: readonly string[] = [
  '_API_KEY',
  '_APIKEY',
  '_TOKEN',
  '_SECRET',
  '_KEY',
  '_PASSWORD',
  '_PASSWD',
  '_CREDENTIAL',
  '_CREDENTIALS',
];

/**
 * 是否被部署环境变量 `LINGXIAO_HARDENED_MODE` 强制锁定。
 * 锁定时 UI 的加固 Toggle 应禁用，PUT `hardenedMode=false` 应被拒绝。
 */
export function isHardenedModeLocked(): boolean {
  const env = process.env.LINGXIAO_HARDENED_MODE;
  return env === '1' || env === 'true';
}

/**
 * 总判定：env 覆盖 > config 文件。单向锁定——env 为真时恒 true。
 */
export function isHardenedMode(): boolean {
  if (isHardenedModeLocked()) return true;
  return getConfigValue('security.hardened_mode') === true;
}

/**
 * 私网 / SSRF 防护有效值：加固总开关与独立开关 `block_private_network` 取 OR。
 * 消费点（WebCommon.ts 等）应读这里而非直接读 config。
 */
export function effectiveBlockPrivateNetwork(): boolean {
  return isHardenedMode() || getConfigValue('security.block_private_network') === true;
}

/**
 * 危险命令守卫有效值：加固总开关与独立开关 `dangerous_command_guard` 取 OR。
 */
export function effectiveDangerousCommandGuard(): boolean {
  return isHardenedMode() || getConfigValue('security.dangerous_command_guard') === true;
}

/**
 * 是否对子进程 / 终端的环境变量做白名单过滤（加固时启用）。
 */
export function shouldFilterChildEnv(): boolean {
  return isHardenedMode();
}

/**
 * 当前生效的 env 透传白名单。
 * 用户配了 `security.env_allowlist`（非空）则用用户的，否则用内置最小默认集。
 */
export function getChildEnvAllowlist(): string[] {
  const user = getConfigValue('security.env_allowlist');
  if (Array.isArray(user) && user.length > 0) {
    return user.filter((v): v is string => typeof v === 'string');
  }
  return [...DEFAULT_ENV_ALLOWLIST];
}

/** 变量名是否命中凭据后缀（大小写不敏感）。 */
function isCredentialName(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/**
 * 按当前白名单过滤一个 env 对象，返回**新对象**（不修改入参）。
 *
 * 规则：
 * - 仅保留出现在白名单中的变量名；
 * - 即使在白名单中，命中凭据后缀（`*_API_KEY` 等）的一律剔除（防误配）；
 * - 任何 `LINGXIAO_*` 内部变量一律剔除；
 * - 值为 `undefined` 的键跳过。
 *
 * 注意：本函数无条件执行过滤，调用方需先用 `shouldFilterChildEnv()` 判断是否启用。
 * PythonExec 与 ExecutionSandbox 都应调用本函数，避免过滤逻辑分叉。
 */
export function filterEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowlist = new Set(getChildEnvAllowlist());
  const allowlistUpper = new Set([...allowlist].map((name) => name.toUpperCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name.toUpperCase().startsWith('LINGXIAO_')) continue;
    if (isCredentialName(name)) continue;
    if (!allowlist.has(name) && !allowlistUpper.has(name.toUpperCase())) continue;
    result[name] = value;
  }
  return result;
}

/** 加固时强制 allowlisted 网络模式校验 allowedHosts（不再静默放行）。 */
export function shouldEnforceAllowedHosts(): boolean {
  return isHardenedMode();
}

/** 加固时 bubblewrap 改为最小化绑定白名单，而非 `--ro-bind / /` 整盘可读。 */
export function shouldMinimizeSandboxBind(): boolean {
  return isHardenedMode();
}

/** 当前内置强隔离 sandbox backend 的平台支持情况。 */
export function supportsStrongExecutionSandboxPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux';
}

/** Linux 加固时执行类工具必须使用强隔离 sandbox backend（当前为 bubblewrap）。 */
export function shouldRequireStrongExecutionSandbox(): boolean {
  return isHardenedMode() && supportsStrongExecutionSandboxPlatform();
}

/** 需要强隔离的平台禁止从强隔离 backend 静默回退到 app-guard。 */
export function allowSandboxBackendFallback(): boolean {
  return !shouldRequireStrongExecutionSandbox();
}

/** 加固时 artifact 读写强制 root 包含校验。 */
export function shouldEnforceArtifactRoot(): boolean {
  return isHardenedMode();
}

/** 加固时恢复 taskWriteScope 写入隔离的实质校验。 */
export function shouldEnforceTaskWriteScope(): boolean {
  return isHardenedMode();
}

/** 加固时终端 cwd 必须落在 workspace root 内（取反：非加固才允许任意 cwd）。 */
export function allowArbitraryTerminalCwd(): boolean {
  return !isHardenedMode();
}

/** 加固时不再完全豁免 localhost 的限流（取反：非加固才豁免）。 */
export function rateLimitExemptLocalhost(): boolean {
  return !isHardenedMode();
}

/** 加固时 token 只接受 header，拒绝 `?token=` query。 */
export function requireTokenInHeaderOnly(): boolean {
  return isHardenedMode();
}
