import { existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { getSessionScopePaths, resolveTaskWorkingDirectory } from './utils.js';
import { IS_LINUX, getShellCommand, resolveCommandPath } from '../../utils/platform.js';
import { getConfigValue } from '../../config.js';
import { buildLocalLlmGatewayEnv } from '../../core/LocalLlmGateway.js';
import {
  effectiveDangerousCommandGuard,
  shouldMinimizeSandboxBind,
  shouldEnforceAllowedHosts,
  shouldFilterChildEnv,
  filterEnv,
  shouldRequireStrongExecutionSandbox,
} from '../../core/HardeningPolicy.js';
import { withToolProxyEnv } from '../../core/ProxyConfig.js';
import { validateCommandForProcessKill } from '../../core/ProcessSelfProtection.js';
import { coreLogger } from '../../core/Log.js';

export type SandboxNetworkMode = 'inherit' | 'disabled' | 'allowlisted';
export type SandboxBackend = 'app-guard' | 'bubblewrap';

export interface ExecutionSandboxPolicy {
  workspace: string;
  sessionId?: string;
  cwd?: string;
  command: string;
  networkMode: SandboxNetworkMode;
  allowedHosts: string[];
  backend?: SandboxBackend;
  taskId?: string;
  taskWorkingDirectory?: string;
  taskWriteScope?: string[];
}

export interface SandboxCapabilities {
  bubblewrapAvailable: boolean;
  bubblewrapPath?: string;
  bubblewrapSupportsNetworkIsolation: boolean;
}

export interface ExecutionPlan {
  mode: 'shell' | 'execFile';
  command: string;
  args?: string[];
}

export interface ExecutionSandboxResult {
  ok: boolean;
  error?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  plan?: ExecutionPlan;
  metadata?: {
    mode: SandboxBackend;
    networkMode: SandboxNetworkMode;
    visibleRoots: string[];
    sessionDir?: string;
    networkRequested?: SandboxNetworkMode;
    networkEnforced?: boolean;
    networkIsolation?: 'enforced' | 'not_enforced' | 'not_requested';
    networkIsolationReason?: string;
    allowedHostsEnforced?: boolean;
    /**
     * 加固模式下 allowlisted 网络因无 host 级出网控制而 fail-closed（整体禁网）时为 true。
     * 用于让上层/前端知晓"请求了 allowlisted 但实际被降级为 disabled"。
     */
    allowedHostsFailClosed?: boolean;
    sandboxFallbackReason?: string;
  };
}

const DANGEROUS_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  '> /dev/sda',
  'dd if=/dev/zero',
  'mkfs.',
  'chmod -r 777 /',
  'chown -r',
  'mv /* /dev/null',
];

let capabilitiesCache: SandboxCapabilities | null = null;

function commandIncludesToken(command: string, token: string): boolean {
  const escaped = token
    .trim()
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const boundary = '(?:^|[;&|()\\s])';
  return new RegExp(`${boundary}${escaped}(?:$|[;&|()\\s])`, 'i').test(command.toLowerCase());
}

export function validateDangerousCommand(command: string): string | null {
  // 加固模式（§3.8）：读 effectiveDangerousCommandGuard()（与独立开关 dangerous_command_guard
  // 取 OR），加固开启时自动启用危险命令软守卫。关闭时（默认且独立开关未开）保持现状放行。
  const enabled = effectiveDangerousCommandGuard();
  if (!enabled) return null;

  const normalized = command.toLowerCase();

  // 1. 检查危险命令（仅在用户显式开启 dangerous_command_guard 时作为软守卫生效）
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (commandIncludesToken(command, dangerous)) {
      return 'ERROR: 检测到潜在危险命令，已由 sandbox policy 拦截。';
    }
  }

  // 2. 检查危险的重定向目标
  const dangerousRedirectPatterns = [
    /\>\s*\/dev\/sd[a-z]/,
    /\>\s*\/dev\/nvme/,
    /\>\s*\/dev\/hd[a-z]/,
    /\>\s*\/dev\/mapper/,
  ];
  for (const pattern of dangerousRedirectPatterns) {
    if (pattern.test(normalized)) {
      return 'ERROR: 检测到潜在危险重定向，已由 sandbox policy 拦截。';
    }
  }

  // 3. 检查沙箱逃逸尝试
  const sandboxEscapePatterns = [
    /\bchroot\b/,
    /\bunshare\b/,
    /\bcapsh\b/,
    /\bsetcap\b/,
    /\bprctl\b.*PR_SET_NO_NEW_PRIVS/,
  ];
  for (const pattern of sandboxEscapePatterns) {
    if (pattern.test(normalized)) {
      return 'ERROR: 检测到潜在沙箱逃逸尝试，已由 sandbox policy 拦截。';
    }
  }

  // 4. 检查权限提升
  if (/\bsu\s/.test(normalized) || /\bsu\t/.test(normalized) || /\bsu;/.test(normalized)) {
    return 'ERROR: 检测到潜在权限提升尝试，已由 sandbox policy 拦截。';
  }

  // 5. 检查编码绕过尝试
  const encodingBypassPatterns = [
    /\bbase64\s+(-d|--decode)\b/,                    // base64 -d (解码执行)
    /\$'\x5c?x[0-9a-f]{2}/i,                         // $'\x72\x6d' hex 转义
    /\bprintf\s+.*\\x[0-9a-f]/i,                     // printf 十六进制
    /\becho\s+.*\|\s*(sh|bash|zsh|dash)\b/,          // echo ... | sh
  ];
  for (const pattern of encodingBypassPatterns) {
    if (pattern.test(normalized)) {
      return 'ERROR: 检测到编码绕过尝试，已由 sandbox policy 拦截。';
    }
  }

  // 6. 检查递归删除整个文件系统
  const recursiveDestroyPatterns = [
    /\bfind\s+\/\s+.*-delete\b/,                     // find / -delete
    /\bfind\s+\/\s+.*-exec\s+rm\b/,                 // find / -exec rm
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,    // fork bomb :(){ :|:& };:
    /\bdd\b.*\bof=\/dev\/[snm]/,                     // dd of=/dev/sda
  ];
  for (const pattern of recursiveDestroyPatterns) {
    if (pattern.test(normalized)) {
      return 'ERROR: 检测到潜在系统破坏命令，已由 sandbox policy 拦截。';
    }
  }

  // 7. Windows cmd 高危命令
  const windowsCmdDangerPatterns = [
    /\bdel\b(?=.*(?:^|\s)\/(?:f|s|q)\b)(?=.*(?:[a-z]:\\|[a-z]:\b|\\))/i,
    /\b(?:rd|rmdir)\b(?=.*(?:^|\s)\/s\b)(?=.*(?:[a-z]:\\|[a-z]:\b|\\))/i,
    /\bformat\s+[a-z]:(?:\s|$)/i,
    /\bshutdown\s+\/(?:s|r|p)\b/i,
    /\btakeown\b(?=.*(?:^|\s)\/r\b)(?=.*(?:^|\s)\/f\b)/i,
  ];
  for (const pattern of windowsCmdDangerPatterns) {
    if (pattern.test(normalized)) {
      return 'ERROR: 检测到 Windows cmd 高危命令，已由 sandbox policy 拦截。';
    }
  }

  // 8. Windows PowerShell 高危命令
  const powerShellDangerPatterns = [
    /\bremove-item\b(?=.*\s-recurse\b)(?=.*\s-force\b)/i,
    /\bstop-computer\b/i,
    /\brestart-computer\b/i,
    /\bformat-volume\b/i,
    /\bclear-disk\b/i,
  ];
  for (const pattern of powerShellDangerPatterns) {
    if (pattern.test(normalized)) {
      return 'ERROR: 检测到 PowerShell 高危命令，已由 sandbox policy 拦截。';
    }
  }

  // 9. PowerShell 删除命令短名（rm/del/erase）
  const powerShellAliasDangerPatterns = [
    /\b(?:rm|del|erase)\b(?=.*\s-(?:recurse|force)\b)/i,
  ];
  for (const pattern of powerShellAliasDangerPatterns) {
    if (pattern.test(normalized)) {
      return 'ERROR: 检测到 PowerShell 删除命令短名的高危用法，已由 sandbox policy 拦截。';
    }
  }

  // 注：广播式进程杀灭（pkill/killall/kill $(pgrep...)）已由始终启用的
  // validateCommandForProcessKill（prepareExecutionSandbox 第一道门禁）统一拦截，
  // 此处不再重复——否则只在 hardened mode 开启时生效，默认安装下形同虚设。

  return null;
}

function findExecutable(name: string): string | undefined {
  // bubblewrap is Linux-only; skip the lookup on other platforms
  if (!IS_LINUX) return undefined;
  return resolveCommandPath(name);
}

export function detectSandboxCapabilities(): SandboxCapabilities {
  if (capabilitiesCache) {
    return capabilitiesCache;
  }

  // bubblewrap is a Linux-only kernel namespace tool; unavailable on Windows/macOS
  if (!IS_LINUX) {
    capabilitiesCache = {
      bubblewrapAvailable: false,
      bubblewrapSupportsNetworkIsolation: false,
    };
    return capabilitiesCache;
  }

  const bubblewrapPath = findExecutable('bwrap');
  capabilitiesCache = {
    bubblewrapAvailable: Boolean(bubblewrapPath),
    bubblewrapPath,
    bubblewrapSupportsNetworkIsolation: false,
  };
  return capabilitiesCache;
}

function buildSessionTmpDir(sessionDir: string): string {
  const tmpDir = join(sessionDir, 'sandbox-tmp');
  mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function ensureSessionsDir(workspace: string): string {
  const sessionsDir = join(workspace, '.lingxiao', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  return sessionsDir;
}

/**
 * 加固模式下的最小化系统路径绑定白名单（§3.5）。
 *
 * 设计：只绑定运行常见命令（sh/git/npm/python/node 及其动态库、CA 证书、DNS 解析）
 * 所需的系统目录，逐条 `--ro-bind` 且仅当路径存在时绑定（不同发行版布局不同，
 * 绑定不存在的路径会让 bwrap 直接失败）。明确**不**绑定 `/root` `/home` `/etc/shadow`
 * `/etc/sudoers` 等敏感路径——这些在最小集外，自然被遮蔽。
 *
 * 风险：极简洁的命令可能因缺库失败；如遇到，运维可在后续 schema v2 增加
 * "额外绑定路径"配置扩展点（本版不做）。
 */
const HARDENED_SANDBOX_BIND_PATHS: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/lib32',
  '/libx32',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/ssl/certs',
  '/etc/resolv.conf',
  '/etc/nsswitch.conf',
  '/etc/hosts',
  '/etc/localtime',
  '/opt',
];

/**
 * 构造根文件系统绑定参数。
 * - 加固模式（shouldMinimizeSandboxBind）：仅绑定 HARDENED_SANDBOX_BIND_PATHS 中存在的路径。
 * - 非加固（默认）：整盘 `--ro-bind / /`，保持现状（只防写不防读）。
 */
function buildRootBindArgs(): string[] {
  if (!shouldMinimizeSandboxBind()) {
    return ['--ro-bind', '/', '/'];
  }
  const out: string[] = [];
  for (const p of HARDENED_SANDBOX_BIND_PATHS) {
    if (existsSync(p)) {
      out.push('--ro-bind', p, p);
    }
  }
  return out;
}

function buildBubblewrapArgs(policy: ExecutionSandboxPolicy, cwd: string, capabilities: SandboxCapabilities, effectiveNetworkMode: SandboxNetworkMode): string[] {
  if (!capabilities.bubblewrapPath || !policy.sessionId) {
    return [];
  }

  const scope = getSessionScopePaths(policy.workspace, policy.sessionId);
  const sessionsDir = ensureSessionsDir(policy.workspace);
  const sessionDir = scope.sessionDir!;
  const sessionTmpDir = buildSessionTmpDir(sessionDir);
  const contextDir = join(sessionDir, 'context');
  const workspaceLingxiaoDir = join(policy.workspace, '.lingxiao');
  const procDir = '/proc';
  const devDir = '/dev';

  const args = [
    '--die-with-parent',
    '--new-session',
    // 加固模式（§3.5）：最小化绑定白名单，遮蔽 /root /home /etc/shadow .ssh 等敏感路径，
    // 而非整盘 `--ro-bind / /`（只防写不防读，沙箱内可 cat /etc/passwd、读 /root/.ssh）。
    // 关闭时（默认）保持现状整盘只读绑定，避免缺库导致命令失败。
    ...buildRootBindArgs(),
    '--proc', procDir,
    '--dev', devDir,
    '--bind', policy.workspace, policy.workspace,
    '--tmpfs', sessionsDir,
    '--bind', sessionDir, sessionDir,
    '--bind', sessionTmpDir, '/tmp',
    '--chdir', cwd,
  ];

  // Network isolation: bubblewrap default = isolated; add --share-net to allow network
  // 加固模式（§3.6）：allowlisted 模式因无 host 级过滤机制而 fail-closed（见下方 effectiveNetworkMode
  // 计算），此处只看 effectiveNetworkMode——为 'disabled' 时不加 --share-net（完全隔离）。
  if (effectiveNetworkMode !== 'disabled') {
    args.push('--share-net');
  }

  if (existsSync(workspaceLingxiaoDir) && statSync(workspaceLingxiaoDir).isDirectory()) {
    const skillsDir = join(workspaceLingxiaoDir, 'skills');
    if (existsSync(skillsDir)) {
      args.push('--ro-bind', skillsDir, skillsDir);
    }
  }

  if (existsSync(contextDir)) {
    args.push('--bind', contextDir, contextDir);
  }

  // bubblewrap expects: bwrap [bwrap-args...] <executable> [exec-args...]
  // Use the platform shell so it works on any Unix variant (sh is POSIX-guaranteed)
  const sh = getShellCommand(policy.command);
  args.push(sh.executable, ...sh.args);
  return args;
}

function buildFallbackError(policy: ExecutionSandboxPolicy, capabilities: SandboxCapabilities): string {
  if (!capabilities.bubblewrapAvailable) {
    return 'ERROR: 请求的 sandbox backend=bubblewrap 当前不可用，且已禁用回退。';
  }

  if (!policy.sessionId) {
    return 'ERROR: bubblewrap backend 需要 sessionId 才能建立会话级隔离，且已禁用回退。';
  }

  return 'ERROR: 请求的 sandbox backend 无法按当前策略执行，且已禁用回退。';
}

function buildRequiredStrongSandboxError(capabilities: SandboxCapabilities, hasSessionId: boolean): string {
  if (!capabilities.bubblewrapAvailable) {
    return 'ERROR: 企业加固模式要求强隔离 sandbox backend=bubblewrap，但当前系统未找到 bwrap。请安装 bubblewrap，或关闭企业加固模式后重试。';
  }
  if (!hasSessionId) {
    return 'ERROR: 企业加固模式要求绑定 sessionId 才能建立会话级强隔离沙盒。请在会话上下文中执行，或关闭企业加固模式后重试。';
  }
  return 'ERROR: 企业加固模式要求强隔离 sandbox backend=bubblewrap，当前策略无法满足。';
}

export function prepareExecutionSandbox(policy: ExecutionSandboxPolicy): ExecutionSandboxResult {
  // 进程自杀防护 — 始终启用，不依赖 hardened mode
  const processKillError = validateCommandForProcessKill(policy.command);
  if (processKillError) {
    return { ok: false, error: processKillError };
  }

  const dangerousError = validateDangerousCommand(policy.command);
  if (dangerousError) {
    return { ok: false, error: dangerousError };
  }

  let workDir: string;
  try {
    workDir = resolveTaskWorkingDirectory(
      policy.workspace,
      policy.cwd,
      policy.sessionId,
      policy.taskWorkingDirectory,
      policy.taskWriteScope,
    );
  } catch (error) {
    return {
      ok: false,
      error: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const scope = getSessionScopePaths(policy.workspace, policy.sessionId);
  const requireStrongSandbox = shouldRequireStrongExecutionSandbox();
  const requestedBackend = requireStrongSandbox ? 'bubblewrap' : policy.backend || 'app-guard';
  const capabilities = detectSandboxCapabilities();
  let selectedBackend: SandboxBackend = requestedBackend;
  let sandboxFallbackReason: string | undefined;
  if (requireStrongSandbox && (!capabilities.bubblewrapAvailable || !policy.sessionId)) {
    return {
      ok: false,
      error: buildRequiredStrongSandboxError(capabilities, Boolean(policy.sessionId)),
    };
  }

  if (
    requestedBackend === 'bubblewrap' &&
    (
      !capabilities.bubblewrapAvailable ||
      !policy.sessionId
    )
  ) {
    // 默认关闭硬沙盒/允许 guardrails-only 执行：bubblewrap 是 Linux-only，macOS/Windows
    // 或无 sessionId 场景不应因为显式/历史参数 sandbox_backend=bubblewrap 直接失败。
    // 只有 enterprise hardening(requireStrongSandbox) 才 fail-closed；普通模式降级到 app-guard。
    selectedBackend = 'app-guard';
    sandboxFallbackReason = buildFallbackError(policy, capabilities).replace(/^ERROR:\s*/, '');
    coreLogger.warn(`[Sandbox] bubblewrap unavailable; falling back to app-guard: ${sandboxFallbackReason}`);
  }

  // 读取用户配置的环境变量
  const userEnv = getConfigValue('advanced.env') as Record<string, string> | undefined;

  // Linux 强隔离模式（§3.6）：allowlisted 网络模式的真实 host 级出网控制需要 netns + 防火墙规则，
  // bubblewrap 的 --share-net 是"全有或全无"，无法按 host 过滤。因此只有在当前平台要求强隔离
  // 且可由 bubblewrap 执行时，allowlisted 才 fail-closed 为 disabled。
  // Windows/macOS 不强制 Docker/VM，本地 hardened 继续运行 guardrails-only：权限层审批、env/cwd
  // 收紧仍生效，但 metadata 明确标注 host allowlist 未由 OS 级沙盒强制。
  const allowedHostsFailClosed =
    shouldEnforceAllowedHosts() && policy.networkMode === 'allowlisted' && requireStrongSandbox;
  const allowedHostsRequestedWithoutEnforcement =
    shouldEnforceAllowedHosts() && policy.networkMode === 'allowlisted' && !allowedHostsFailClosed;
  const effectiveNetworkMode: SandboxNetworkMode = allowedHostsFailClosed
    ? 'disabled'
    : policy.networkMode;

  // 加固模式（§3.2）：对子进程 env 做统一白名单过滤，剔除凭据类与 LINGXIAO_* 内部变量。
  // 过滤必须覆盖 process.env、advanced.env 与工具代理 env；否则 advanced.env/proxy 会成为密钥旁路。
  // 关闭时（默认）注入完整 env 并继续注入本地 LLM gateway env，保持现状。
  const rawInheritedEnv: NodeJS.ProcessEnv = withToolProxyEnv({
    ...process.env,
    ...userEnv,
  });
  const inheritedEnv: NodeJS.ProcessEnv = shouldFilterChildEnv()
    ? filterEnv(rawInheritedEnv)
    : rawInheritedEnv;
  const gatewayEnv = shouldFilterChildEnv() ? {} : buildLocalLlmGatewayEnv(inheritedEnv);
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    ...gatewayEnv,
    LINGXIAO_SESSION_ID: policy.sessionId || '',
    LINGXIAO_SESSION_DIR: scope.sessionDir || '',
    LINGXIAO_SCRATCHPAD_DIR: scope.scratchpadDir || '',
    LINGXIAO_CONTEXT_DIR: scope.contextDir || '',
    LINGXIAO_SANDBOX_MODE: selectedBackend,
    LINGXIAO_NETWORK_MODE: effectiveNetworkMode,
    LINGXIAO_ALLOWED_HOSTS: policy.allowedHosts.join(','),
    LINGXIAO_TASK_ID: policy.taskId || '',
    LINGXIAO_TASK_CWD: policy.taskWorkingDirectory || '',
    LINGXIAO_TASK_WRITE_SCOPE: (policy.taskWriteScope || []).join(':'),
  };

  const networkEnforced = selectedBackend === 'bubblewrap' && effectiveNetworkMode === 'disabled';
  const metadata = {
    mode: selectedBackend,
    networkMode: effectiveNetworkMode,
    networkRequested: policy.networkMode,
    networkEnforced,
    networkIsolation: effectiveNetworkMode === 'disabled'
      ? (networkEnforced ? 'enforced' : 'not_enforced')
      : (allowedHostsRequestedWithoutEnforcement ? 'not_enforced' : 'not_requested'),
    networkIsolationReason: effectiveNetworkMode === 'disabled' && !networkEnforced
      ? `${selectedBackend} backend does not enforce network isolation`
      : (allowedHostsFailClosed
        ? 'hardened mode: allowlisted network has no host-level enforcement, failing closed to disabled'
        : (allowedHostsRequestedWithoutEnforcement
          ? 'hardened mode: current platform/backend cannot enforce execution host allowlists; relying on permission-layer approval and env/cwd guardrails'
          : undefined)),
    // 加固模式（§3.6）：allowlisted 经 fail-closed 降级为 disabled 后，allowedHostsEnforced 反映
    // "已通过禁网真正强制"（bubblewrap）。非加固时保持现状恒 false（不强制）。
    allowedHostsEnforced: allowedHostsFailClosed && selectedBackend === 'bubblewrap',
    allowedHostsFailClosed,
    sandboxFallbackReason,
    visibleRoots: [policy.workspace, scope.sessionDir || ''].filter(Boolean),
    sessionDir: scope.sessionDir,
  } as const;

  if (selectedBackend === 'bubblewrap') {
    const args = buildBubblewrapArgs(policy, workDir, capabilities, effectiveNetworkMode);
    return {
      ok: true,
      cwd: workDir,
      env,
      plan: {
        mode: 'execFile',
        command: capabilities.bubblewrapPath!,
        args,
      },
      metadata,
    };
  }

  // Warn: app-guard mode does NOT isolate network or filesystem
  if (policy.networkMode === 'disabled') {
    coreLogger.warn('[Sandbox] WARNING: app-guard backend does NOT enforce network isolation. ' +
      'Use bubblewrap backend for true sandbox isolation.');
  }

  return {
    ok: true,
    cwd: workDir,
    env,
    plan: {
      mode: 'shell',
      command: policy.command,
    },
    metadata,
  };
}
