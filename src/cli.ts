#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, readdirSync, readFileSync, statSync, createReadStream, writeSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { hostname as osHostname } from 'os';
import { CONFIG_DIR, config, getConfigValue, refreshRuntimeConfig, saveSettings, SETTINGS_FILE, generateDefaultSettings } from './config.js';
import { DatabaseManager } from './core/Database.js';
import { SessionManager } from './core/SessionManager.js';
import { createEventEmitter, createMessageBus, registerCleanup, runAllCleanups, gracefulShutdown } from './core/index.js';
import { contentToPlainText, extractAgentMention } from './llm/types.js';
import { buildInitialChannels, buildTuiSnapshot, calibrateTuiSnapshotFromRuntime, toInitialMessages, toInitialTasks } from './cli_snapshot.js';
import { prepareMessage } from './cli_helpers.js';
import { normalizeDefaultStartArgs } from './cli_args.js';
import { dispatchCallbackCommand } from './commands/dispatcher.js';
import {
  buildRuntimeDiagnosticsItems,
  buildRuntimeDiagnosticsPayload,
} from './core/RuntimeDiagnostics.js';
import { normalizeToolPermissionContext, summarizePermissionContextForDisplay } from './core/PermissionSystem.js';
import {
  applyAndPersistPermissionUpdates,
  buildPermissionSurfaceItems,
  describePermissionLayers,
  type PermissionUpdateDestination,
} from './core/PermissionStore.js';
import { getAvailableSkillEntries } from './cli_data.js';
import { runFetchCommand, runSearchCommand } from './cli_web.js';
import { runBootstrapDoctor, formatBootstrapReport } from './core/BootstrapDoctor.js';
import { installProcessRuntimeGuards } from './core/RuntimeGuards.js';
import { toErrorMessage } from './core/errors.js';
import { playInitIntro, renderInitNotice } from './cli_init_banner.js';
import { runUpgrade } from './cli_upgrade.js';
import { runOnboarding } from './tui/OnboardingTui.js';

const emitter = createEventEmitter();
const messageBus = createMessageBus(1000, emitter);
import { openUrlInSystemBrowser } from './core/SystemBrowserOpener.js';
import { t } from './i18n.js';
import { SESSION_KEYS } from './core/SessionStateKeys.js';
import { parseBlueprint } from './core/ProjectBlueprint.js';
import { PidRegistry } from './core/PidRegistry.js';
import { DaemonManager } from './core/DaemonManager.js';
import { WorkerProcessRunner } from './core/WorkerProcessRunner.js';
import { isDaemonActiveStatus, isRunTerminalStatus, isSupervisorGivenUpStatus, isSupervisorStoppedStatus } from './core/StateSemantics.js';
import { ActiveSessionCoordinator, type ActiveSessionSource } from './core/ActiveSessionCoordinator.js';
import { VERSION } from './version.js';
import { killProcess } from './utils/platform.js';
import { registerMainProcess } from './core/ProcessSelfProtection.js';
import {
  AgentDefinitionService,
  type AgentDefinitionRecord,
  type AgentDefinitionScope,
  type AgentWorkerBackend,
  type SaveAgentDefinitionInput,
  validateAgentDefinitionName,
} from './agents/AgentDefinitionService.js';

const DAEMON_DB_PATH = join(CONFIG_DIR, 'daemon', 'daemon.db');

const program = new Command();
program.configureOutput({
  writeOut: (str) => { writeSync(1, str); },
  writeErr: (str) => { writeSync(2, str); },
});
installProcessRuntimeGuards();

// 主进程信号处理
//
// daemon 模式：本就该响应 SIGTERM/SIGHUP 优雅退出（由 DaemonManager / supervisor 管理生命周期）。
// 交互模式：终端断开后进入"有限存活"模式（默认 5 分钟），给 Web UI 重连留窗口。
//   超时后 ProcessIdleGuard 自动 gracefulShutdown。
//   全 idle（无活跃会话/Agent）超过 10 分钟也自动退出，杜绝僵尸累积。
//   显式停止途径：TUI 内 Ctrl+Q、`lingxiao stop`、或 SIGKILL。
import { getProcessIdleGuard } from './core/ProcessIdleGuard.js';
const isDaemonProcess = () => !!process.env.LINGXIAO_DAEMON_MODE;

process.on('SIGTERM', async () => {
  if (isDaemonProcess()) {
    console.log('[CLI] Received SIGTERM, shutting down gracefully...');
    await gracefulShutdown(0, 10000);
  }
  // 交互模式：标记 detached，ProcessIdleGuard 会在 TTL 到期后自动退出
  console.log('\n[CLI] 收到 SIGTERM（终端可能已断开）。进入有限存活模式，Web UI 仍可重连。');
  getProcessIdleGuard().markDetached();
});
process.on('SIGINT', async () => {
  if (isDaemonProcess()) {
    console.log('[CLI] Received SIGINT, shutting down gracefully...');
    await gracefulShutdown(0, 10000);
  }
  // 交互模式：SIGINT(Ctrl+C) 交给 TUI/ink 处理，不在此拆 swarm
});
process.on('SIGHUP', async () => {
  if (isDaemonProcess()) {
    console.log('[CLI] Received SIGHUP, shutting down gracefully...');
    await gracefulShutdown(0, 10000);
  }
  // 交互模式：终端挂断 → 有限存活
  console.log('\n[CLI] 收到 SIGHUP（终端已断开）。进入有限存活模式，Web UI 仍可重连。');
  getProcessIdleGuard().markDetached();
});

program
  .name('lingxiao')
  .description('凌霄剑域 - 动态智能编排系统 (Node.js 版本)')
  .version(VERSION)
  .addHelpText('after', `
Examples:
  lingxiao
  lingxiao --session <session_id>
`);
/**
 * 首次使用引导 — 前置检查 + OnboardingTui 引导流程
 *
 * 保留 generateDefaultSettings、BootstrapDoctor 环境检查和开场动画，
 * 交互部分委托给 runOnboarding()（与 Web UI OnboardingWizard 对齐）。
 */
async function interactiveInit(): Promise<void> {
  generateDefaultSettings();
  const bootstrapReport = runBootstrapDoctor({ workspace: process.cwd(), repair: true });
  const blockingChecks = bootstrapReport.checks.filter((check) => check.status === 'error' && check.name !== 'config');
  if (blockingChecks.length > 0) {
    console.log(formatBootstrapReport(bootstrapReport));
    throw new Error(blockingChecks.map((check) => `${check.name}: ${check.message}`).join('; '));
  }

  const bannerWidth = process.stdout.columns || 80;
  await playInitIntro({ width: bannerWidth });
  console.log(renderInitNotice(t('cli.init_detect_no_config')));

  // 委托给 OnboardingTui.runOnboarding()（与 Web UI OnboardingWizard 对齐）
  await runOnboarding();
}

/**
 * 检查是否已初始化
 */
function checkInitialized(): boolean {
  return config.initialized;
}

function _listAvailableSkills(baseWorkspace: string): string {
  return getAvailableSkillEntries(baseWorkspace)
    .map((entry) => `- $${entry.name} (${entry.source})${entry.desc ? `: ${entry.desc}` : ''}`)
    .reduce((acc, line, index) => {
      if (index === 0) {
      return `${t('cli.available_skills')}:\n${line}`;
      }
      return `${acc}\n${line}`;
    }, '') || t('cli.no_skills');
}

/**
 * 启动 TUI
 */
async function startTUI(sessionId?: string, opts?: { tuiOnly?: boolean }): Promise<void> {
  // Phase 0: 清理同目录旧实例（防止僵尸累积导致 CPU/swap 爆炸）
  const { cleanOrphanInstances } = await import('./core/ProcessOrphanCleaner.js');
  const orphanResult = await cleanOrphanInstances(process.pid, process.cwd());
  if (orphanResult.cleaned.length > 0) {
    console.log(`[StartTUI] 已清理 ${orphanResult.cleaned.length} 个同目录旧实例`);
  }

  // Phase 0.5: 启动进程级 Idle 守卫（daemon 模式由 supervisor 管理，不启动 idle guard）
  const isDaemonModeEarly = !!process.env.LINGXIAO_DAEMON_MODE;
  const idleGuard = getProcessIdleGuard();
  if (!isDaemonModeEarly) {
    idleGuard.start();
  }

  // 清理上一次崩溃/非正常退出遗留的孤儿 Worker 进程（按进程全量扫描 /proc/*/environ）。
  // 必须在任何新 Worker 被创建之前执行，否则同名孤儿会引发"Worker 已存在"/工作区与端口竞态。
  // 不传 sessionId：当前 daemon 自身的 Worker 尚未生成，故清理全部 lingxiao 残留进程。
  await WorkerProcessRunner.killOrphanWorkers();

  // 生成默认配置 + 环境检查（无条件执行——onboarding 延迟到 Web 服务器启动后）
  generateDefaultSettings();
  {
    const bootstrapReport = runBootstrapDoctor({ workspace: process.cwd(), repair: true });
    // 未初始化时 config 检查必然报 error，需排除
    const blockingChecks = bootstrapReport.checks.filter((check) => check.status === 'error' && check.name !== 'config');
    if (blockingChecks.length > 0) {
      console.log(formatBootstrapReport(bootstrapReport));
      throw new Error(blockingChecks.map((check) => `${check.name}: ${check.message}`).join('; '));
    }
  }

  // 初始化数据库 — daemon 模式使用独立数据库
  const isDaemonMode = !!process.env.LINGXIAO_DAEMON_MODE;
  const effectiveDbPath = isDaemonMode ? (process.env.LINGXIAO_DAEMON_DB_PATH || DAEMON_DB_PATH) : config.paths.db_path;
  if (isDaemonMode) {
    const { mkdirSync } = await import('fs');
    const { dirname } = await import('path');
    mkdirSync(dirname(effectiveDbPath), { recursive: true });
  }
  const db = new DatabaseManager(effectiveDbPath);
  db.init();

  registerCleanup(() => db.close(), 10);
  // 在 DB 关闭前终止所有 Worker 子进程（优先级 9.5 < 10，升序排序下先于 db.close 执行）。
  // 进程全量清理是单机单 daemon 的设计约定；graceful shutdown 时父进程若不显式 reap，
  // 这些子进程会沦为孤儿继续持有 DB 句柄/端口/工作区锁。
  registerCleanup(async () => { await WorkerProcessRunner.killOrphanWorkers(); }, 9.5);

  // 退出兜底：gracefulShutdown 的 runAllCleanups 有 10s 超时，若超时强退则 db.close 可能未执行；
  // process('exit') 是同步退出的最后机会，幂等调用 db.close()（已关则 no-op）确保 WAL 锁释放。
  process.on('exit', () => {
    try { db.close(); } catch { /* tolerate — already closed or closing */ }
  });

  // 初始化会话管理器
  const sessionManager = new SessionManager(db, emitter);
  const activeSessionCoordinator = new ActiveSessionCoordinator(undefined, isDaemonMode ? 'daemon' : 'startup');
  const getCurrentSessionId = () => activeSessionCoordinator.getActiveSessionId();
  const setCurrentSessionId = (nextSessionId: string | undefined, source: ActiveSessionSource = 'tui') => {
    activeSessionCoordinator.setActiveSessionId(nextSessionId, source);
  };

  // 注册 Idle Guard 活跃探针：任何会话有 running leader/agent 就算活跃
  idleGuard.registerProbe(() => sessionManager.hasActiveWork());
  // 用户操作事件刷新 idle timer
  emitter.subscribe('user:message', () => idleGuard.touch());
  emitter.subscribe('session:created', () => idleGuard.touch());
  emitter.subscribe('round_complete', () => idleGuard.touch());

  // Daemon 模式：只启动 Web Server + QQ Bot，跳过 TUI/LLM 预热等
  if (isDaemonMode) {
    let webUrl: string | undefined;
    try {
      const { createServerWithDeps, findAvailablePort, writePortFile, readPortFile, warnIfInsecureHostBinding } = await import('./server.js');
      const { isHardenedMode } = await import('./core/HardeningPolicy.js');
      const webHost = config.server.host;
      const webPort = config.server.port;
      warnIfInsecureHostBinding(webHost, isHardenedMode());

      // 继承或创建 daemon 守护会话，并在 Web Server 创建前写入统一 active-session。
      let daemonSessionId: string;
      const requestedSessionId = process.env.LINGXIAO_DAEMON_SESSION_ID;
      const lastSession = requestedSessionId
        ? db.getSession(requestedSessionId)
        : db.getLastActiveSession();

      if (lastSession) {
        daemonSessionId = lastSession.id;
        const resumed = await sessionManager.resumeSession(daemonSessionId);
        if (resumed) {
          console.log(`[Daemon] Resumed session: ${daemonSessionId}`);
        } else {
          // resume 失败，回退到新建
          daemonSessionId = await sessionManager.createSession('', process.cwd(), { idle: true });
          console.log(`[Daemon] Resume failed, created new session: ${daemonSessionId}`);
        }
      } else {
        daemonSessionId = await sessionManager.createSession('', process.cwd(), { idle: true });
        console.log(`[Daemon] Created new session: ${daemonSessionId}`);
      }
      setCurrentSessionId(daemonSessionId, 'daemon');

      const { fastify: webServer, token: serverToken } = await createServerWithDeps(db, sessionManager, {
        logger: false,
        activeSessionCoordinator,
        isDaemon: true,
        emitter,
        messageBus,
      });

      const useRandomPort = getConfigValue('server.random_port') === true;
      const requestedPort = useRandomPort ? 0 : webPort;
      let actualPort = requestedPort;
      try {
        await webServer.listen({ host: webHost, port: requestedPort });
        const addr = webServer.server.address();
        actualPort = (addr && typeof addr === 'object' ? addr.port : null) ?? requestedPort;
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          actualPort = await findAvailablePort(webPort, webHost);
          await webServer.listen({ host: webHost, port: actualPort });
        } else {
          throw err;
        }
      }

      writePortFile(actualPort, webHost);
      DaemonManager.updateDaemonPid(process.pid, actualPort, webHost);

      const displayHost = webHost === '0.0.0.0' ? 'localhost' : webHost;
      webUrl = `http://${displayHost}:${actualPort}`;
      console.log(`[Daemon] Running at ${webUrl}?token=${serverToken}`);

      // Auto-start QQ Bot if configured（绑定到守护会话）
      const { initQQBotInDaemon } = await import('./web-server/DaemonRoutes.js');
      void initQQBotInDaemon(db, sessionManager, daemonSessionId, emitter);

      // ★ 记忆维护：daemon 模式同样按时间闸（dream 7天 / distill 30天）后台触发。
      // Web UI 实际连的就是这个常驻 daemon 进程，必须与 TUI 路径（见下方非 daemon 分支）
      // 保持对等，否则 Web 端会话永远不会自动整理记忆。fire-and-forget，不阻塞。
      //
      // daemon 可连跑数周，单次 fire 无法在时间闸再次到期时复触发，故启动即跑一次、
      // 之后每 6 小时重检。runDueMemoryMaintenance 幂等：未到期 shouldTrigger() 直接 no-op，
      // markExecuted() 仅成功后写时间戳，重复调用安全且廉价。
      {
        const runDaemonMaintenance = () => {
          void (async () => {
            try {
              const { runDueMemoryMaintenance } = await import('./memory/MemoryMaintenance.js');
              const workspace = db.getSession(daemonSessionId)?.workspace || process.cwd();
              runDueMemoryMaintenance({
                workspace,
                projectId: daemonSessionId,
                dbPath: db.getPath(),
                emitter,
                sessionId: daemonSessionId,
              });
            } catch { /* 维护触发失败不阻塞 daemon */ }
          })();
        };
        runDaemonMaintenance();
        const MAINTENANCE_RECHECK_MS = 6 * 60 * 60 * 1000;
        setInterval(runDaemonMaintenance, MAINTENANCE_RECHECK_MS).unref();
      }

      // Keep process alive indefinitely
      await new Promise(() => {});
    } catch (err) {
      console.error('[Daemon] Failed to start:', err);
      process.exit(1);
    }
  }

  // ─── 以下为非 daemon 模式（TUI + Web Server）───
  
  // 创建或恢复会话
  let currentSessionId = sessionId;
  if (currentSessionId) {
    const resumed = await sessionManager.resumeSession(currentSessionId);
    if (!resumed) {
      console.warn(chalk.yellow(`${t('cli.session_not_found')} ${sessionId}`));
      console.warn(chalk.dim(t('cli.session_resume_hint')));
      currentSessionId = undefined;
    } else {
      console.log(`${t('cli.session_resumed')}: ${sessionId}`);
    }
  }

  // TUI 启动时自动创建新会话（idle 模式，不触发 LLM），确保 Web UI 有活跃会话可绑定
  if (!currentSessionId) {
    currentSessionId = await sessionManager.createSession('', process.cwd(), { idle: true });
  }
  setCurrentSessionId(currentSessionId, 'tui');

  // ── --tui-only 模式：跳过 Web Server，仅启动 TUI ──
  const tuiOnly = opts?.tuiOnly || process.env.LINGXIAO_TUI_ONLY === '1';

  // 启动 Web UI 服务器（复用当前 db/sessionManager，传入 TUI 当前会话 ID）
  // ★ 在 Web 服务器启动的同时，后台预热 LLM TCP+TLS 连接，减少首次响应延迟
  //    未初始化时跳过——leader_model 尚未配置
  if (!tuiOnly && checkInitialized()) {
    try {
      const { createLLMClient } = await import('./llm/Client.js');
      const { config: _cfg } = await import('./config.js');
      const _warmupLlm = createLLMClient(_cfg.llm.leader_model);
      if (_warmupLlm.warmup) void _warmupLlm.warmup().catch(() => {});
    } catch { /* 预热失败不阻塞启动 */ }
  }

  // ★ 后台预热 tiktoken WASM encoder，避免首条用户消息时 30 秒卡顿
  void (async () => {
    try {
      const { getEncoding } = await import('js-tiktoken');
      getEncoding('cl100k_base');
    } catch { /* 预热失败不阻塞 */ }
  })();

  // ★ 记忆维护：会话启动时按各自时间闸（dream 7天 / distill 30天）后台触发，
  // fire-and-forget，不阻塞交互。对应 mimo 主会话 step-1 自动整理。
  void (async () => {
    if (!checkInitialized()) return; // 未初始化时跳过——尚无有效会话数据
    try {
      const { runDueMemoryMaintenance } = await import('./memory/MemoryMaintenance.js');
      const workspace = currentSessionId
        ? (db.getSession(currentSessionId)?.workspace || process.cwd())
        : process.cwd();
      runDueMemoryMaintenance({
        workspace,
        projectId: currentSessionId || 'default',
        dbPath: db.getPath(),
        emitter,
        sessionId: currentSessionId,
      });
    } catch { /* 维护触发失败不阻塞启动 */ }
  })();

  let webUrl: string | undefined;
  let scheduledTaskManager: import('./core/ScheduledTaskManager.js').ScheduledTaskManager | undefined;
  if (tuiOnly) {
    // --tui-only 模式：跳过 Web Server，只打印 TUI 模式提示
    console.log(chalk.dim('  TUI-only 模式：Web UI 服务未启动'));
  } else {
  try {
    const { createServerWithDeps, findAvailablePort, writePortFile, readPortFile, removePortFile, warnIfInsecureHostBinding } = await import('./server.js');
    const { isHardenedMode } = await import('./core/HardeningPolicy.js');
    const webHost = config.server.host;
    const webPort = config.server.port;

    // 检测已有实例
    const existing = readPortFile();
    if (existing && !process.env.LINGXIAO_WEB_PORT) {
      console.log(chalk.yellow(t('cli.instance_running', existing.pid, existing.port)));
      console.log(chalk.dim(`  设置 LINGXIAO_WEB_PORT 可启动第二实例（SSE 事件将隔离）`));
    }

    const serverResult = await createServerWithDeps(db, sessionManager, {
      logger: false,
      activeSessionCoordinator,
      emitter,
      messageBus,
    });
    const webServer = serverResult.fastify;
    const serverToken = serverResult.token;
    scheduledTaskManager = serverResult.scheduledTaskManager;

    warnIfInsecureHostBinding(webHost, isHardenedMode());

    // 端口优先级：显式 LINGXIAO_WEB_PORT 环境变量 > random_port 配置 > config.server.port
    const envPort = process.env.LINGXIAO_WEB_PORT;
    const useRandomPort = getConfigValue('server.random_port') === true;
    // 显式指定了非零端口（含 daemon 传 0 表示随机），或 random_port=true 时用 0 让 OS 分配
    const requestedPort = (envPort != null && parseInt(envPort, 10) !== 0)
      ? parseInt(envPort, 10)
      : (useRandomPort ? 0 : webPort);
    let actualPort = requestedPort;
    try {
      await webServer.listen({ host: webHost, port: requestedPort });
      const addr = webServer.server.address();
      actualPort = (addr && typeof addr === 'object' ? addr.port : null) ?? requestedPort;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        actualPort = await findAvailablePort(webPort, webHost);
        await webServer.listen({ host: webHost, port: actualPort });
        console.log(chalk.yellow(t('cli.port_in_use', webPort, actualPort)));
      } else {
        throw err;
      }
    }

    writePortFile(actualPort, webHost);

    // Register this process in the PidRegistry
    const isDaemon = !!process.env.LINGXIAO_DAEMON_MODE;
    const sessionName = process.env.LINGXIAO_SESSION_NAME;
    const logPath = process.env.LINGXIAO_LOG_PATH;
    const displayHostForUrl = webHost === '0.0.0.0' ? 'localhost' : webHost;
    PidRegistry.register({
      pid: process.pid,
      sessionId: currentSessionId || '',
      cwd: process.cwd(),
      startedAt: Date.now(),
      kind: isDaemon ? 'daemon' : 'interactive',
      url: `http://${displayHostForUrl}:${actualPort}`,
      name: sessionName,
      logPath,
      hostname: osHostname(),
    });
    registerMainProcess();
    registerCleanup(() => PidRegistry.unregister(process.pid), 5);

    const displayHost = webHost === '0.0.0.0' ? 'localhost' : webHost;
    webUrl = `http://${displayHost}:${actualPort}`;
    const tokenUrl = serverToken ? `${webUrl}?token=${serverToken}` : webUrl;

    // ── 凌霄启动横幅 ──  ── Qwen Code 风格面板 ──
    const g = chalk.hex('#00ffaa');
    const c = chalk.hex('#4fc1ff');
    const d = chalk.hex('#00aa77');
    const dim = chalk.hex('#555566');
    const w = chalk.white;
    // 可视宽度（CJK=2列）
    const vLen = (s: string) => [...s].reduce((n, ch) => {
      const cp = ch.charCodeAt(0);
      if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)) return n + 2;
      return n + 1;
    }, 0);
    const padV = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - vLen(s)));

    const IW = 49; // panel 内部可视列宽
    console.log('');
    console.log(g('  +-') + c(' 凌霄剑域 ') + g(`v${VERSION} `) + g('-'.repeat(IW - 14)) + g('-+'));
    console.log(g('  |') + padV('  ' + d('动态智能编排系统') + '  ' + c('· 青锋照夜 ·'), IW) + g('|'));
    console.log(g('  |') + ' '.repeat(IW) + g('|'));
    const _cmdLabel = t('tui.welcome.shortcut.cmd').trim().replace(/^\/\s+/, '');
    const _intLabel = t('tui.welcome.shortcut.interrupt').trim().replace(/^Esc\s+/, '');
    const _tabLabel = t('tui.welcome.shortcut.tab').trim().replace(/^Tab\s+/, '');
    console.log(g('  |') + padV('  ' + dim('/') + ` ${_cmdLabel}  ` + dim('Esc') + ` ${_intLabel}  ` + dim('Ctrl+X') + ' DAG  ' + dim('Tab') + ` ${_tabLabel}`, IW) + g('|'));
    console.log(g('  |') + ' '.repeat(IW) + g('|'));
    console.log(g('  |') + padV('  ' + c('Web') + dim(': ') + w(webUrl), IW) + g('|'));
    const cwd = process.cwd();
    const cwdShort = cwd.length > IW - 4 ? '...' + cwd.slice(-(IW - 7)) : cwd;
    console.log(g('  |') + padV('  ' + dim(cwdShort), IW) + g('|'));
    console.log(g('  +' + '-'.repeat(IW) + '+'));
    if (serverToken) {
      console.log(d('  Token: ' + serverToken.slice(0, 12) + '...'));
      console.log(d('  ' + tokenUrl));
    }
    console.log('');

    if (serverToken) {
      const openResult = openUrlInSystemBrowser(tokenUrl);
      if (!openResult.launched && process.env.LINGXIAO_DEBUG_BROWSER_OPEN === '1') {
        console.log(chalk.dim(`  Browser open skipped: ${openResult.plan.diagnostics.join('; ')}`));
      }
    }
  }
  catch (err: unknown) {
    // Web 服务器启动失败不阻塞 TUI
    console.warn(chalk.yellow(`⚠ Web UI 启动失败: ${toErrorMessage(err)}`));
  }
  }

  // ── 首次初始化引导（Web 服务器已启动，TUI + Web UI 同步可用）──
  // 启动顺序调整：先启动 Web 服务器再检查 initialized，
  // 用户可在浏览器或终端任一端完成配置，另一端自动检测并继续。
  if (!checkInitialized()) {
    const bannerWidth = process.stdout.columns || 80;
    await playInitIntro({ width: bannerWidth });
    console.log(renderInitNotice(t('cli.init_detect_no_config')));
    if (webUrl) {
      console.log(chalk.cyan(`\n  ℹ️  Web UI 配置引导已就绪: ${webUrl}`));
      console.log(chalk.dim('  你可以在浏览器中完成配置，或在终端继续 TUI 引导。'));
      console.log(chalk.dim('  无论在哪端完成，另一端会自动检测并继续。\n'));
    }
    await runOnboarding();
  }

  const React = await import('react');
  const { render } = await import('ink');
  const { LingXiaoTUI } = await import('./tui/index.js');
  const sessionInfo = currentSessionId ? db.getSession(currentSessionId) : null;
  const initialTasks = currentSessionId ? toInitialTasks(db.getTasksBySession(currentSessionId)) : [];
  const initialMessages = currentSessionId ? toInitialMessages(db.getConversation(currentSessionId)) : [];
  const initialLeaderMode = currentSessionId ? db.getSessionState(currentSessionId, SESSION_KEYS.LEADER_EXECUTION_MODE) : null;
  const initialLeaderReason = currentSessionId ? db.getSessionState(currentSessionId, SESSION_KEYS.LEADER_EXECUTION_REASON) : null;
  const initialBlueprint = currentSessionId ? parseBlueprint(db.getSessionState(currentSessionId, SESSION_KEYS.PROJECT_BLUEPRINT)) : null;
  const initialPermissionSummary = currentSessionId
    ? summarizePermissionContextForDisplay(normalizeToolPermissionContext(db.getSessionState(currentSessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT)))
    : undefined;
  const initialChannels = currentSessionId
    ? buildInitialChannels(db, currentSessionId)
    : [];
  const initialTokenUsage = currentSessionId
    ? db.getTokenSummary(currentSessionId).reduce((sum, r) => sum + (r.total || 0), 0)
    : 0;
  // TUI 侧栏状态面板的实时费用:查当前会话的分模型用量 → calculateSessionCost。
  // 复用 /cost 命令同款逻辑(dispatcher.ts handleCostCommand),纯查询无副作用。
  const getCostSummary = (): number => {
    try {
      const sid = getCurrentSessionId();
      if (!sid) return 0;
      const { calculateSessionCost } = require('./llm/CostService.js') as typeof import('./llm/CostService.js');
      const summary = db.getTokenSummary(sid);
      if (!summary || summary.length === 0) return 0;
      const costSummary = calculateSessionCost(summary.map((s) => ({
        name: s.agent_name || s.agent_id,
        totalPrompt: s.prompt,
        totalCompletion: s.completion,
        cacheRead: s.cache_read,
        cacheCreation: s.cache_creation,
      })));
      return costSummary.totalCost ?? 0;
    } catch {
      return 0;
    }
  };
  const readProjectBlueprint = (): import('./core/ProjectBlueprint.js').ProjectBlueprint | null => {
    try {
      const sid = getCurrentSessionId();
      if (!sid) return null;
      return parseBlueprint(db.getSessionState(sid, SESSION_KEYS.PROJECT_BLUEPRINT));
    } catch {
      return null;
    }
  };
  const initialAgentTokens = currentSessionId
    ? (() => {
        const nameByAgentId = new Map(initialChannels.flatMap((channel) => (
          channel.agentId ? [[channel.agentId, channel.name] as const] : []
        )));
        return Object.fromEntries(
          db.getTokenSummary(currentSessionId).flatMap((row) => {
            const visibleName = nameByAgentId.get(row.agent_id) || row.agent_name || row.agent_id;
            return [
              [visibleName, row.total || 0],
              [row.agent_id, row.total || 0],
            ];
          })
        );
      })()
    : {};

  const originalConsole = {
    log: console.log,
    debug: console.debug,
    warn: console.warn,
    info: console.info,
    error: console.error,
  };

  const muteConsole = () => {
    console.log = () => {};
    console.debug = () => {};
    console.warn = () => {};
    console.info = () => {};
    console.error = () => {};
  };

  const restoreConsole = () => {
    console.log = originalConsole.log;
    console.debug = originalConsole.debug;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
    console.error = originalConsole.error;
  };

  muteConsole();

  // 关掉 Log.ts 的 ConsoleSink：它直写 process.stderr，绕过 muteConsole（只屏蔽 console.*）。
  // TUI 下任何 WARN/ERROR 日志直写终端会打乱 Ink log-update 的光标行数计算，
  // 使状态行无法原地刷新而反复重印（刷屏根因）。日志改为只落文件。
  const { configureLogging } = await import('./core/Log.js');
  configureLogging({ console: false, file: process.env.LINGXIAO_LOG_PATH || true });

  // 清屏并隐藏光标（标准TUI行为）
  process.stdout.write('\x1b[2J\x1b[H');  // 清屏 + 光标归位
  process.stdout.write('\x1b[?25l');      // 隐藏光标

  // react-reconciler dev build 累积 performance.measure 不清理，定期清除防内存泄漏
  const perfCleanupTimer = setInterval(() => {
    try { performance.clearMeasures(); performance.clearMarks(); } catch { /* expected: performance API may be unavailable */ }
  }, 60_000);
  perfCleanupTimer.unref();

  const app = render(React.createElement(LingXiaoTUI, {
    emitter,
    sessionId: currentSessionId,
    workspace: sessionInfo?.workspace || process.cwd(),
    webUrl,
    initialStatus: sessionInfo ? {
      sessionId: sessionInfo.id,
      workspace: sessionInfo.workspace,
      status: sessionInfo.status,
      createdAt: sessionInfo.created_at * 1000,
      permissionSummary: initialPermissionSummary,
    } : {
      sessionId: currentSessionId || '未创建',
      workspace: process.cwd(),
      status: 'idle',
      permissionSummary: summarizePermissionContextForDisplay(normalizeToolPermissionContext(null)),
    },
    initialTasks,
    initialBlueprint,
    readProjectBlueprint,
    initialMessages,
    initialChannels,
    initialTokenUsage,
    initialAgentTokens,
    getCostSummary,
    initialLeaderStatus: t('tui.leader.awaiting_input'),
    initialLeaderMode: typeof initialLeaderMode === 'string' ? initialLeaderMode as 'direct' | 'hybrid' | 'delegate' : undefined,
    initialLeaderModeReason: typeof initialLeaderReason === 'string' ? initialLeaderReason : '',
    availableSkills: getAvailableSkillEntries(process.cwd()).map(e => e.name),
    onSessionFocus: (focusedSessionId: string) => {
      setCurrentSessionId(focusedSessionId, 'web');
    },
    loadSessionSnapshot: async (focusedSessionId: string) => {
      const snapshot = buildTuiSnapshot(db, focusedSessionId);
      if (!snapshot) return snapshot;
      const runtime = sessionManager.getInteractionRuntimeState(focusedSessionId);
      return calibrateTuiSnapshotFromRuntime(snapshot, {
        runtime,
        processingStatus: t('tui.input.processing'),
      });
    },
    onSubmit: async (input: string, target: string) => {
      let activeSessionId = getCurrentSessionId();
      const baseDir = activeSessionId ? (db.getSession(activeSessionId)?.workspace || process.cwd()) : process.cwd();
      const preparedInput = prepareMessage(input, baseDir);

      // ★ 注意：用户消息已经在 TUI 的 handleSubmit 中通过 appendMessage 显示了
      // 这里不需要再通过 emitter 显示，避免重复

      if (!activeSessionId) {
        // 安全兜底：正常不会进入这里，因为 TUI 启动时已创建会话
        activeSessionId = await sessionManager.createSession(preparedInput, process.cwd());
        setCurrentSessionId(activeSessionId, 'tui');
      } else if (target === 'main') {
        const mention = extractAgentMention(input);
        if (mention) {
          // TUI input is always a plain string, so mention.rest is the string body
          // that prepareMessage expands (e.g. inlining referenced image files).
          const agentMessage = prepareMessage(mention.rest as string, baseDir);
          const result = await sessionManager.sendAgentInput(activeSessionId, mention.agentName, agentMessage);
          if (!result.ok) {
            throw new Error(result.message);
          }
        } else {
          await sessionManager.sendUserInput(activeSessionId, preparedInput, { interrupt: false, source: 'tui' });
        }
      } else {
        const result = await sessionManager.sendAgentInput(activeSessionId, target, preparedInput);
        if (!result.ok) {
          throw new Error(result.message);
        }
      }
    },
    onNudge: async (input: string) => {
      const activeSessionId = getCurrentSessionId();
      if (activeSessionId) {
        const baseDir = db.getSession(activeSessionId)?.workspace || process.cwd();
        const preparedInput = prepareMessage(input, baseDir);
        await sessionManager.sendUserInput(activeSessionId, preparedInput, { interrupt: false, source: 'tui' });
      }
    },
    onCommand: async (commandLine: string) => {
      const [rawCommand, ..._args] = commandLine.trim().split(/\s+/);
      const command = rawCommand.toLowerCase();
      if (command === '/reset') {
        setCurrentSessionId(undefined, 'command');
        return t('tui.command.reset_view');
      }
      return await dispatchCallbackCommand(commandLine, {
        db,
        sessionManager,
        emitter,
        cwd: process.cwd(),
        getCurrentSessionId,
        setCurrentSessionId: (sessionId) => {
          setCurrentSessionId(sessionId, 'command');
        },
        scheduledTaskManager,
      });
    },
    onInterrupt: async () => {
      const activeSessionId = getCurrentSessionId();
      if (!activeSessionId) {
        return false;
      }
      return sessionManager.interruptSession(activeSessionId);
    },
    onStopAgent: async (agentName: string) => {
      const activeSessionId = getCurrentSessionId();
      if (!activeSessionId) {
        return false;
      }
      return sessionManager.stopAgent(activeSessionId, agentName);
    },
    onClearPendingMessages: async () => {
      const activeSessionId = getCurrentSessionId();
      if (!activeSessionId) {
        return;
      }
      await sessionManager.clearPendingMessages(activeSessionId);
    },
  }), { exitOnCtrlC: false });

  // 退出告别横幅：预先加载渲染器，避免与 shutdown 的 process.exit 竞态。
  let farewellPrinted = false;
  const { renderFarewellBanner } = await import('./tui/animation/farewellBanner.js');
  const printFarewell = () => {
    if (farewellPrinted) return;
    farewellPrinted = true;
    try {
      const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
      process.stdout.write(renderFarewellBanner({
        sessionId: getCurrentSessionId(),
        version: VERSION,
        color: useColor,
      }) + '\n');
    } catch { /* farewell banner is best-effort */ }
  };

  // Listen for shutdown signal from TUI to ensure clean process exit
  const unsubShutdown = emitter.subscribe('shutdown', () => {
    void (async () => {
      try {
        await runAllCleanups(5000);
      } catch {
        // ignore cleanup failures on forced shutdown
      }
      restoreConsole();
      printFarewell();
      setTimeout(() => process.exit(0), 25);
    })();
  });

  try {
    await app.waitUntilExit();
  } finally {
    restoreConsole();
    unsubShutdown();
    printFarewell();
  }
}

/**
 * 列出会话
 */
async function listSessions(): Promise<void> {
  const db = new DatabaseManager(config.paths.db_path);
  db.init();

  const sessions = db.listSessions();
  await db.close();

  console.log(t('cli.session_count', sessions.length));
  for (const s of sessions) {
    const status = isRunTerminalStatus(s.status) ? t('cli.session_status_completed') : t('cli.session_status_active');
    const requestPreview = contentToPlainText(s.user_request).slice(0, 50);
    console.log(`  [${status}] ${s.id}: ${requestPreview}...`);
  }
  console.log();
}

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function normalizeCsvOption(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)));
}

function resolveAgentScopeOption(opts: { global?: boolean; project?: boolean }, fallback: AgentDefinitionScope = 'project'): AgentDefinitionScope {
  if (opts.global && opts.project) {
    throw new Error('不能同时指定 --global 和 --project');
  }
  if (opts.global) return 'global';
  if (opts.project) return 'project';
  return fallback;
}

function parseAgentBackend(value: string | undefined): AgentWorkerBackend | undefined {
  if (!value) return undefined;
  if (value === 'worker_process' || value === 'claude' || value === 'codex') return value;
  throw new Error('--backend 仅支持 worker_process | claude | codex');
}

function readAgentPrompt(opts: { prompt?: string; promptFile?: string }, fallback?: string): string {
  if (opts.prompt && opts.promptFile) {
    throw new Error('不能同时指定 --prompt 和 --prompt-file');
  }
  if (opts.promptFile) {
    return readFileSync(opts.promptFile, 'utf-8');
  }
  if (opts.prompt !== undefined) {
    return opts.prompt;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error('需要通过 --prompt 或 --prompt-file 提供 system prompt');
}

function printAgentDefinition(record: AgentDefinitionRecord, json = false): void {
  if (json) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  console.log(chalk.bold(record.name));
  console.log(`  scope       ${record.source}`);
  console.log(`  description ${record.description}`);
  if (record.baseRoleName) console.log(`  baseRole    ${record.baseRoleName}`);
  if (record.model) console.log(`  model       ${record.model}`);
  console.log(`  backend     ${record.worker_backend ?? 'worker_process'}`);
  console.log(`  tools       ${record.tools.length > 0 ? record.tools.join(', ') : '(default worker tools)'}`);
  console.log(`  skills      ${record.skillNames.length > 0 ? record.skillNames.join(', ') : '(none)'}`);
  console.log(`  path        ${record.path}`);
  console.log('');
  console.log(record.systemPrompt);
}

function buildAgentCreateInput(name: string, opts: {
  description?: string;
  prompt?: string;
  promptFile?: string;
  baseRole?: string;
  model?: string;
  backend?: string;
  tool?: string[];
  skill?: string[];
  global?: boolean;
  project?: boolean;
}): SaveAgentDefinitionInput {
  return {
    name,
    description: opts.description ?? '',
    systemPrompt: readAgentPrompt(opts),
    baseRoleName: opts.baseRole,
    model: opts.model,
    worker_backend: parseAgentBackend(opts.backend),
    tools: normalizeCsvOption(opts.tool),
    skillNames: normalizeCsvOption(opts.skill),
    scope: resolveAgentScopeOption(opts),
  };
}

function buildAgentUpdateInput(name: string, current: AgentDefinitionRecord, opts: {
  description?: string;
  prompt?: string;
  promptFile?: string;
  baseRole?: string;
  model?: string;
  backend?: string;
  tool?: string[];
  skill?: string[];
  global?: boolean;
  project?: boolean;
}): SaveAgentDefinitionInput {
  return {
    name,
    description: opts.description ?? current.description,
    systemPrompt: readAgentPrompt(opts, current.systemPrompt),
    baseRoleName: opts.baseRole ?? current.baseRoleName,
    model: opts.model ?? current.model,
    worker_backend: parseAgentBackend(opts.backend) ?? current.worker_backend,
    tools: opts.tool ? normalizeCsvOption(opts.tool) : current.tools,
    skillNames: opts.skill ? normalizeCsvOption(opts.skill) : current.skillNames,
    scope: resolveAgentScopeOption(opts, current.source),
  };
}

function registerAgentsCommands(root: Command): void {
  const agentsCmd = root.command('agents').description('管理自定义 Agent 定义');

  agentsCmd
    .command('list')
    .description('列出自定义 Agent')
    .option('--all', '显示被 project/global 覆盖隐藏的同名定义')
    .option('--json', '输出 JSON')
    .action((opts: { all?: boolean; json?: boolean }) => {
      const service = new AgentDefinitionService({ workspace: process.cwd() });
      const records = service.listDefinitions({ includeShadowed: opts.all === true });
      if (opts.json) {
        console.log(JSON.stringify(records, null, 2));
        return;
      }
      if (records.length === 0) {
        console.log(chalk.dim('暂无自定义 Agent。使用 `lingxiao agents create <name> ...` 创建。'));
        return;
      }
      for (const record of records) {
        const shadow = record.shadowedBy ? chalk.yellow(` shadowed by ${record.shadowedBy}`) : '';
        const backend = record.worker_backend && record.worker_backend !== 'worker_process'
          ? chalk.cyan(` · ${record.worker_backend}`)
          : '';
        console.log(`${chalk.bold(record.name)} ${chalk.dim(`[${record.source}]`)}${backend}${shadow}`);
        console.log(`  ${record.description}`);
        console.log(chalk.dim(`  ${record.path}`));
      }
    });

  agentsCmd
    .command('show <name>')
    .description('查看自定义 Agent 定义')
    .option('--global', '查看全局定义')
    .option('--project', '查看当前项目定义')
    .option('--json', '输出 JSON')
    .action((name: string, opts: { global?: boolean; project?: boolean; json?: boolean }) => {
      const service = new AgentDefinitionService({ workspace: process.cwd() });
      const record = opts.global || opts.project
        ? service.getDefinitionInScope(name, resolveAgentScopeOption(opts))
        : service.getDefinition(name);
      if (!record) {
        throw new Error(`未找到自定义 Agent: ${name}`);
      }
      printAgentDefinition(record, opts.json === true);
    });

  agentsCmd
    .command('create <name>')
    .description('创建自定义 Agent')
    .option('--description <text>', 'Agent 描述')
    .option('--prompt <text>', 'Agent system prompt')
    .option('--prompt-file <path>', '从文件读取 Agent system prompt')
    .option('--base-role <name>', '继承的内置角色基线')
    .option('--model <model>', '该 Agent 默认模型')
    .option('--backend <backend>', 'worker 后端：worker_process | claude | codex')
    .option('--tool <name>', '允许工具，可重复或逗号分隔', collectRepeatedOption)
    .option('--skill <name>', '默认技能，可重复或逗号分隔', collectRepeatedOption)
    .option('--global', '写入全局 ~/.lingxiao/agents')
    .option('--project', '写入当前项目 .lingxiao/agents')
    .option('--json', '输出 JSON')
    .action((name: string, opts: Parameters<typeof buildAgentCreateInput>[1] & { json?: boolean }) => {
      const service = new AgentDefinitionService({ workspace: process.cwd() });
      const input = buildAgentCreateInput(name, opts);
      const existing = service.getDefinitionInScope(input.name, input.scope ?? 'project');
      if (existing) {
        throw new Error(`Agent 已存在: ${input.name} (${existing.source})，请使用 update`);
      }
      const saved = service.saveDefinition(input);
      if (opts.json) {
        console.log(JSON.stringify(saved, null, 2));
        return;
      }
      console.log(chalk.green(`✓ 已创建 Agent ${saved.name} (${saved.source})`));
      console.log(chalk.dim(`  ${saved.path}`));
    });

  agentsCmd
    .command('update <name>')
    .description('更新自定义 Agent')
    .option('--description <text>', 'Agent 描述')
    .option('--prompt <text>', 'Agent system prompt')
    .option('--prompt-file <path>', '从文件读取 Agent system prompt')
    .option('--base-role <name>', '继承的内置角色基线')
    .option('--model <model>', '该 Agent 默认模型')
    .option('--backend <backend>', 'worker 后端：worker_process | claude | codex')
    .option('--tool <name>', '替换允许工具列表，可重复或逗号分隔', collectRepeatedOption)
    .option('--skill <name>', '替换默认技能列表，可重复或逗号分隔', collectRepeatedOption)
    .option('--global', '更新全局定义')
    .option('--project', '更新当前项目定义')
    .option('--json', '输出 JSON')
    .action((name: string, opts: Parameters<typeof buildAgentUpdateInput>[2] & { json?: boolean }) => {
      const service = new AgentDefinitionService({ workspace: process.cwd() });
      const normalized = validateAgentDefinitionName(name);
      const current = opts.global || opts.project
        ? service.getDefinitionInScope(normalized, resolveAgentScopeOption(opts))
        : service.getDefinition(normalized);
      if (!current) {
        throw new Error(`未找到自定义 Agent: ${normalized}`);
      }
      const saved = service.saveDefinition(buildAgentUpdateInput(normalized, current, opts));
      if (opts.json) {
        console.log(JSON.stringify(saved, null, 2));
        return;
      }
      console.log(chalk.green(`✓ 已更新 Agent ${saved.name} (${saved.source})`));
      console.log(chalk.dim(`  ${saved.path}`));
    });

  agentsCmd
    .command('delete <name>')
    .description('删除自定义 Agent')
    .option('--global', '删除全局定义')
    .option('--project', '删除当前项目定义')
    .option('-y, --yes', '跳过确认')
    .action(async (name: string, opts: { global?: boolean; project?: boolean; yes?: boolean }) => {
      const service = new AgentDefinitionService({ workspace: process.cwd() });
      const normalized = validateAgentDefinitionName(name);
      const scope = resolveAgentScopeOption(opts);
      const record = service.getDefinitionInScope(normalized, scope);
      if (!record) {
        console.log(chalk.dim(`未找到 Agent ${normalized} (${scope})`));
        return;
      }
      let confirmed = opts.yes === true;
      if (!confirmed) {
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: `删除 Agent ${normalized} (${scope})？`,
          default: false,
        }]);
        confirmed = answer.confirmed === true;
      }
      if (!confirmed) {
        console.log(chalk.dim('已取消'));
        return;
      }
      const removed = service.deleteDefinition(normalized, scope);
      console.log(removed
        ? chalk.green(`✓ 已删除 Agent ${normalized} (${scope})`)
        : chalk.dim(`未找到 Agent ${normalized} (${scope})`));
    });
}

// 定义命令
program
  .command('start')
  .description(t('cli.command_start'))
  .option('--bg', '后台运行（不显示 TUI，只启动服务）')
  .option('--name <name>', '指定会话名称')
  .option('--output-format <format>', '输出格式 (text | stream-json)', 'text')
  .option('--daemon-mode', '由 DaemonManager 内部使用，不直接调用')
  .option('--worktree [name]', '在隔离的 git worktree 中运行')
  .option('--worktree-branch <branch>', '指定 worktree 创建的分支名')
  .option('--tmux', '使用 tmux 窗格分割（实验性）')
  .option('--tui-only', '仅启动 TUI，不启动 Web UI 服务')
  .option('-s, --session <id>', '指定要恢复的会话 ID')
  .action(async (opts: { bg?: boolean; name?: string; daemonMode?: boolean; worktree?: string | boolean; worktreeBranch?: string; tmux?: boolean; tuiOnly?: boolean; outputFormat?: string; session?: string }) => {
    if (process.env.LINGXIAO_NO_AUTO_START === '1') {
      return;
    }

    // Handle --worktree flag
    if (opts.worktree !== undefined && opts.worktree !== false) {
      const { WorktreeManager } = await import('./core/WorktreeManager.js');
      const cwd = process.cwd();

      if (!await WorktreeManager.isGitRepo(cwd)) {
        console.error(chalk.red('✗ 当前目录不是 git 仓库，无法使用 --worktree 模式'));
        process.exit(1);
      }

      const wtName = typeof opts.worktree === 'string' ? opts.worktree : opts.name || `lx-${Date.now()}`;
      try {
        console.log(chalk.dim(`正在创建 worktree: ${wtName}...`));
        const info = await WorktreeManager.create(cwd, {
          name: wtName,
          branch: opts.worktreeBranch,
        });
        console.log(chalk.green(`✓ Worktree 已创建`));
        console.log(chalk.dim(`  路径  : ${info.path}`));
        console.log(chalk.dim(`  分支  : ${info.branch}`));
        console.log(chalk.dim(`  基于  : ${info.baseBranch}`));

        // 注册退出清理：有未提交变更时询问是否保留 worktree。
        registerCleanup(async () => {
          let changes: { modified: string[]; untracked: string[] };
          try {
            changes = await WorktreeManager.detectChanges(info.path);
          } catch { /* expected: worktree may have been removed externally */
            changes = { modified: [], untracked: [] };
          }
          const totalChanges = changes.modified.length + changes.untracked.length;

          if (totalChanges > 0) {
            console.log(chalk.yellow(`\nWorktree "${info.name}" 有 ${totalChanges} 个文件变更`));
            const { keep } = await inquirer.prompt([{
              type: 'confirm',
              name: 'keep',
              message: `是否保留 worktree 分支 "${info.branch}"（否则将删除分支和目录）？`,
              default: true,
            }]);

            if (!keep) {
              await WorktreeManager.remove(cwd, info.path, true);
              console.log(chalk.dim(`Worktree "${info.name}" 已清除`));
            } else {
              console.log(chalk.dim(`Worktree 已保留在: ${info.path}`));
            }
          } else {
            // No changes — silently remove
            await WorktreeManager.remove(cwd, info.path, true);
          }
        }, 2);

        // Start TUI in worktree directory
        process.chdir(info.path);
        await startTUI(opts.session, { tuiOnly: opts.tuiOnly });
      } catch (err: unknown) {
        console.error(chalk.red(`✗ Worktree 创建失败: ${toErrorMessage(err)}`));
        process.exit(1);
      }
      return;
    }

    if (opts.bg) {
      // Launch detached background session
      const { fileURLToPath } = await import('url');
      const { dirname, join: pathJoin } = await import('path');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const cliPath = pathJoin(__dirname, 'cli.js');

      const name = opts.name || `bg-${Date.now()}`;
      const { CONFIG_DIR: cfgDir } = await import('./config.js');
      const { mkdirSync: mkDir } = await import('fs');
      const logDir = pathJoin(cfgDir, 'logs');
      mkDir(logDir, { recursive: true });
      const logPath = pathJoin(logDir, `${name}.log`);

      const { createWriteStream } = await import('fs');
      const logStream = createWriteStream(logPath, { flags: 'a' });
      const childArgs = [cliPath, 'start', ...(opts.session ? ['--session', opts.session] : [])];
      const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: ['ignore', logStream, logStream],
        env: {
          ...process.env,
          LINGXIAO_SESSION_NAME: name,
          LINGXIAO_LOG_PATH: logPath,
          FORCE_NO_TUI: '1',
          ...(opts.outputFormat ? { LINGXIAO_OUTPUT_FORMAT: opts.outputFormat } : {}),
        },
      });
      child.unref();
      console.log(chalk.green(`✓ 后台会话已启动`));
      console.log(chalk.dim(`  名称: ${name}`));
      console.log(chalk.dim(`  PID: ${child.pid}`));
      console.log(chalk.dim(`  日志: ${logPath}`));
      console.log(chalk.dim(`  使用 lingxiao attach ${name} 查看 Web UI 地址`));
    } else {
      await startTUI(opts.session, { tuiOnly: opts.tuiOnly });
    }
  });

program
  .command('demo')
  .description(t('cli.command_demo'))
  .argument('<session_id>', 'session_id')
  .action(async (sessionId: string) => {
    await startTUI(sessionId);
  });

program
  .command('tui')
  .description('仅启动 TUI 终端界面（不启动 Web UI 服务）')
  .option('-s, --session <id>', '指定要恢复的会话 ID')
  .action(async (opts: { session?: string }) => {
    await startTUI(opts.session, { tuiOnly: true });
  });

program
  .command('list')
  .description(t('cli.command_list'))
  .action(async () => {
    await listSessions();
  });

program
  .command('init')
  .description(t('cli.command_init'))
  .option('--check', '只运行内置环境检测，不进入交互式配置')
  .action(async (opts: { check?: boolean }) => {
    if (opts.check) {
      const report = runBootstrapDoctor({ workspace: process.cwd(), repair: true });
      console.log(formatBootstrapReport(report));
      process.exit(report.ready ? 0 : 1);
    }
    await interactiveInit();
  });

program
  .command('doctor')
  .description(t('cli.command_doctor'))
  .option('--json', 'output JSON report')
  .action(async (options) => {
    const report = runBootstrapDoctor({ workspace: process.cwd() });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatBootstrapReport(report));
    }
    process.exit(report.ready ? 0 : 1);
  });

program
  .command('upgrade')
  .description('检查并升级到最新版本')
  .option('--check', '只检查是否有新版本，不执行升级')
  .action(async (opts: { check?: boolean }) => {
    await runUpgrade(opts);
  });

program
  .command('about')
  .description(t('cli.command_about'))
  .action(() => {
    console.log(`
${chalk.cyan.bold(t('cli.about_title'))}
${t('cli.about_version')} ${VERSION}

${chalk.yellow.bold(t('cli.about_vision_title'))}
${t('cli.about_vision_body')}

${chalk.yellow.bold(t('cli.about_author_title'))}
${t('cli.about_author_body')}

${chalk.yellow.bold(t('cli.about_tech_title'))}
- ${t('cli.about_tech_dynamic')}
- ${t('cli.about_tech_typesafe')}
- ${t('cli.about_tech_session')}
- ${t('cli.about_tech_permission')}
- ${t('cli.about_tech_skills')}

${chalk.yellow.bold(t('cli.about_license_title'))}
${t('cli.about_license_body')}

${chalk.dim(t('cli.about_footer'))}
`);
  });

// ─── Daemon 子命令 ───────────────────────────────────────────────────────────
const daemonCmd = program.command('daemon').description('管理凌霄后台常驻服务');

daemonCmd
  .command('start')
  .description('启动 daemon 服务')
  .option('-p, --port <port>', '端口号（默认随机，显式指定则用指定端口）', '0')
  .option('-H, --host <host>', '监听地址', '127.0.0.1')
  .option('-s, --session <id>', '指定要恢复的会话 ID')
  .option('--supervisor', '启用进程自愈守护（崩溃自动重启）')
  .action(async (opts: { port: string; host: string; session?: string; supervisor?: boolean }) => {
    const port = parseInt(opts.port, 10);
    const host = opts.host;
    if (opts.supervisor) {
      console.log(chalk.dim(`正在启动 daemon + supervisor (${host}:${port})...`));
    } else {
      console.log(chalk.dim(`正在启动 daemon (${host}:${port})...`));
    }
    try {
      let status;
      if (opts.supervisor) {
        status = await DaemonManager.startDaemonWithSupervisor(port, host, undefined, opts.session);
      } else {
        status = await DaemonManager.startDaemon(port, host, 'manual_start', opts.session);
      }
      if (isDaemonActiveStatus(status.status)) {
        console.log(chalk.green(`✓ Daemon 已运行`));
        console.log(chalk.dim(`  PID: ${status.pid}  URL: ${status.url}`));
        if (opts.supervisor) {
          console.log(chalk.green('  Supervisor: 已启用（崩溃自愈）'));
        }
      } else {
        console.log(chalk.yellow('Daemon 启动中，稍后用 lingxiao daemon status 检查'));
      }
    } catch (err: unknown) {
      console.error(chalk.red(`✗ 启动失败: ${toErrorMessage(err)}`));
      process.exit(1);
    }
  });

daemonCmd
  .command('stop')
  .description('停止 daemon 服务')
  .action(async () => {
    const status = DaemonManager.getStatus();
    if (!isDaemonActiveStatus(status.status)) {
      console.log(chalk.yellow('Daemon 未运行'));
      return;
    }
    console.log(chalk.dim(`正在停止 daemon (PID ${status.pid})...`));
    const result = await DaemonManager.stopDaemon();
    if (result.success) {
      console.log(chalk.green('✓ Daemon 已停止'));
    } else {
      console.error(chalk.red(`✗ 停止失败: ${result.error}`));
      process.exit(1);
    }
  });

daemonCmd
  .command('restart')
  .description('重启 daemon 服务')
  .option('-p, --port <port>', '端口号')
  .option('-H, --host <host>', '监听地址')
  .action(async (opts: { port?: string; host?: string }) => {
    const port = opts.port ? parseInt(opts.port, 10) : undefined;
    const host = opts.host;
    console.log(chalk.dim('正在重启 daemon...'));
    try {
      const status = await DaemonManager.restartDaemon(port, host);
      console.log(chalk.green('✓ Daemon 已重启'));
      if (status.pid) console.log(chalk.dim(`  PID: ${status.pid}  URL: ${status.url}`));
    } catch (err: unknown) {
      console.error(chalk.red(`✗ 重启失败: ${toErrorMessage(err)}`));
      process.exit(1);
    }
  });

daemonCmd
  .command('status')
  .description('查看 daemon 状态')
  .action(() => {
    const status = DaemonManager.getStatus();
    if (isDaemonActiveStatus(status.status)) {
      console.log(chalk.green('● Daemon 运行中'));
      console.log(`  PID    : ${status.pid}`);
      console.log(`  URL    : ${status.url}`);
      console.log(`  启动   : ${new Date(status.startedAt!).toLocaleString()}`);
      console.log(`  运行时间: ${Math.floor((status.uptime || 0) / 60)} 分钟`);
    } else {
      console.log(chalk.dim('○ Daemon 未运行'));
    }
    // Also show supervisor status if running
    const sup = DaemonManager.getSupervisorStatus();
    if (sup && !isSupervisorStoppedStatus(sup.status)) {
      console.log('');
      console.log(chalk.dim('Supervisor 状态:'));
      console.log(`  状态    : ${sup.status}`);
      console.log(`  重启次数: ${sup.restartCount}`);
      console.log(`  最后健康: ${new Date(sup.lastHealthyAt).toLocaleString()}`);
    }
  });

daemonCmd
  .command('supervisor-status')
  .description('查看 supervisor 守护状态')
  .action(() => {
    const sup = DaemonManager.getSupervisorStatus();
    if (!sup || isSupervisorStoppedStatus(sup.status)) {
      console.log(chalk.dim('Supervisor 未运行'));
    } else {
      console.log(chalk.green('● Supervisor 运行中'));
      console.log(`  状态       : ${sup.status}`);
      console.log(`  守护 PID   : ${sup.currentPid}`);
      console.log(`  健康检查   : ${sup.currentHealthUrl}/health`);
      console.log(`  重启次数   : ${sup.restartCount}`);
      if (isSupervisorGivenUpStatus(sup.status)) {
        console.log(chalk.red('  ⚠ Supervisor 已放弃（达最大重启次数）'));
      }
    }
  });

daemonCmd
  .command('stop-supervisor')
  .description('停止 supervisor 守护（daemon 进程不受影响）')
  .action(() => {
    const sup = DaemonManager.getSupervisorStatus();
    if (!sup || isSupervisorStoppedStatus(sup.status)) {
      console.log(chalk.dim('Supervisor 未运行'));
      return;
    }
    DaemonManager.stopSupervisor();
    console.log(chalk.green('✓ Supervisor 已停止'));
  });

// ─── ps — 列出所有活跃进程 ──────────────────────────────────────────────────
program
  .command('ps')
  .description('列出所有活跃的凌霄进程')
  .action(() => {
    const entries = PidRegistry.listAll();
    if (entries.length === 0) {
      console.log(chalk.dim('没有活跃的凌霄进程'));
      return;
    }
    console.log(chalk.bold('PID      KIND         NAME / SESSION'));
    console.log(chalk.dim('─'.repeat(60)));
    for (const e of entries) {
      const kind = e.kind.padEnd(12);
      const name = e.name || e.sessionId.slice(0, 16);
      const url = e.url ? chalk.dim(` ${e.url}`) : '';
      console.log(`${String(e.pid).padEnd(9)}${kind} ${name}${url}`);
    }
  });

// ─── logs — 查看后台会话日志 ────────────────────────────────────────────────
program
  .command('logs <name>')
  .description('查看后台会话日志')
  .option('-f, --follow', '持续追踪日志输出')
  .option('-n, --lines <n>', '显示最后 N 行', '50')
  .action(async (name: string, opts: { follow?: boolean; lines: string }) => {
    const entry = PidRegistry.findByName(name);
    if (!entry) {
      // Try to find by checking log dir
      const { CONFIG_DIR: cfgDir } = await import('./config.js');
      const { join: pathJoin } = await import('path');
      const logPath = pathJoin(cfgDir, 'logs', `${name}.log`);
      if (!existsSync(logPath)) {
        console.error(chalk.red(`找不到会话 "${name}" 的日志`));
        process.exit(1);
      }
      // Just read the file
      const lines = parseInt(opts.lines, 10);
      const content = readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n');
      const tail = allLines.slice(-lines).join('\n');
      console.log(tail);
      if (opts.follow) {
        console.log(chalk.dim('─── 持续追踪中 (Ctrl+C 退出) ───'));
        const { createReadStream: crs } = await import('fs');
        const { stat } = await import('fs/promises');
        let size = (await stat(logPath)).size;
        const followTimer = setInterval(async () => {
          try {
            const newSize = (await stat(logPath)).size;
            if (newSize > size) {
              const stream = crs(logPath, { start: size, end: newSize });
              stream.pipe(process.stdout);
              size = newSize;
            }
          } catch { /* expected: log file may be rotated or missing during follow */ }
        }, 500);
        followTimer.unref();
      }
      return;
    }
    const logPath = entry?.logPath;
    if (!logPath || !existsSync(logPath)) {
      console.error(chalk.red(`会话 "${name}" 无日志文件路径`));
      process.exit(1);
    }
    const lines = parseInt(opts.lines, 10);
    const content = readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n');
    console.log(allLines.slice(-lines).join('\n'));
    if (opts.follow) {
      console.log(chalk.dim('─── 持续追踪中 (Ctrl+C 退出) ───'));
      const { stat } = await import('fs/promises');
      let size = (await stat(logPath)).size;
      const followTimer = setInterval(async () => {
        try {
          const newSize = (await stat(logPath)).size;
          if (newSize > size) {
            const stream = createReadStream(logPath, { start: size, end: newSize });
            stream.pipe(process.stdout);
            size = newSize;
          }
        } catch { /* expected: log file may be rotated or missing during follow */ }
      }, 500);
      followTimer.unref();
    }
  });

// ─── kill — 终止后台会话 ────────────────────────────────────────────────────
program
  .command('kill <name>')
  .description('终止指定的后台会话或进程')
  .option('-f, --force', '强制 SIGKILL')
  .action(async (name: string, opts: { force?: boolean }) => {
    const signal = opts.force ? 'SIGKILL' : 'SIGTERM';
    const entry = PidRegistry.findByName(name);
    if (!entry) {
      // Try numeric PID
      const pid = parseInt(name, 10);
      if (!isNaN(pid)) {
        try {
          await killProcess(pid, signal, { tree: true });
          PidRegistry.unregister(pid);
          console.log(chalk.green(`✓ 进程 ${pid} 已终止`));
        } catch (err: unknown) {
          console.error(chalk.red(`✗ 无法终止 PID ${pid}: ${toErrorMessage(err)}`));
          process.exit(1);
        }
      } else {
        console.error(chalk.red(`找不到进程 "${name}"`));
        process.exit(1);
      }
      return;
    }
    try {
      await killProcess(entry.pid, signal, { tree: true });
      PidRegistry.unregister(entry.pid);
      console.log(chalk.green(`✓ 进程 "${name}" (PID ${entry.pid}) 已终止`));
    } catch (err: unknown) {
      console.error(chalk.red(`✗ 无法终止: ${toErrorMessage(err)}`));
      process.exit(1);
    }
  });

// ─── attach — 显示后台会话 Web UI 地址 ─────────────────────────────────────
program
  .command('attach <name>')
  .description('显示后台会话的 Web UI 地址')
  .action((name: string) => {
    const entry = PidRegistry.findByName(name);
    if (!entry) {
      console.error(chalk.red(`找不到进程 "${name}"`));
      process.exit(1);
    }
    if (!entry.url) {
      console.error(chalk.yellow(`进程 "${name}" 尚未暴露 Web UI`));
      process.exit(1);
    }
    console.log(chalk.bold('Web UI:'), entry.url);
    console.log(chalk.dim('在浏览器中打开以上地址来连接到该会话'));
  });

// ─── worktree — Git Worktree 管理 ────────────────────────────────────────────
const worktreeCmd = program.command('worktree').description('管理 Git Worktree');

worktreeCmd
  .command('list')
  .description('列出所有 worktree')
  .action(async () => {
    const { WorktreeManager } = await import('./core/WorktreeManager.js');
    const cwd = process.cwd();
    if (!await WorktreeManager.isGitRepo(cwd)) {
      console.error(chalk.red('当前目录不是 git 仓库'));
      process.exit(1);
    }
    const list = await WorktreeManager.list(cwd);
    if (list.length === 0) {
      console.log(chalk.dim('没有 worktree'));
      return;
    }
    console.log(chalk.bold('路径                                分支'));
    console.log(chalk.dim('─'.repeat(60)));
    for (const w of list) {
      const lock = w.locked ? chalk.red(' [locked]') : '';
      console.log(`${w.path.padEnd(36)} ${w.branch}${lock}`);
    }
  });

worktreeCmd
  .command('remove <name>')
  .description('删除指定 worktree')
  .option('--keep-branch', '保留分支，只删除目录')
  .action(async (name: string, opts: { keepBranch?: boolean }) => {
    const { WorktreeManager } = await import('./core/WorktreeManager.js');
    const cwd = process.cwd();
    try {
      await WorktreeManager.remove(cwd, name, !opts.keepBranch);
      console.log(chalk.green(`✓ Worktree "${name}" 已删除`));
    } catch (err: unknown) {
      console.error(chalk.red(`✗ 删除失败: ${toErrorMessage(err)}`));
      process.exit(1);
    }
  });

worktreeCmd
  .command('prune')
  .description('清理无效的 worktree 引用')
  .action(async () => {
    const { WorktreeManager } = await import('./core/WorktreeManager.js');
    const cwd = process.cwd();
    await WorktreeManager.prune(cwd);
    console.log(chalk.green('✓ Worktree 引用已清理'));
  });

registerAgentsCommands(program);

// 桌面端通过 LINGXIAO_FORCE_COMMAND 环境变量指定命令，绕过 Electron argv 插入问题。
// 无子命令时默认执行 start；顶层启动参数如 `lingxiao -s <id>` 也归一化到 start。
const forceCmd = process.env.LINGXIAO_FORCE_COMMAND;
if (forceCmd) {
  // argv[0]=node, argv[1]=script；保留后续 flags，把命令插到正确位置
  const args = process.argv.slice(2).filter(a => !a.endsWith('cli.js') && a !== forceCmd);
  process.argv = [process.argv[0], process.argv[1], forceCmd, ...args];
} else {
  process.argv = normalizeDefaultStartArgs(process.argv);
}

program.parse();
