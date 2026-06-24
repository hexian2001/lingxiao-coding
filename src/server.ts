import Fastify, { type FastifyError, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as netCreateServer, type AddressInfo } from 'net';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { DatabaseManager } from './core/Database.js';
import { SessionManager } from './core/SessionManager.js';
import { DatabaseRepositoryAdapter } from './core/DatabaseRepositories.js';
import { createEventEmitter, createMessageBus, registerCleanup, gracefulShutdown } from './core/index.js';
import { WorkerProcessRunner } from './core/WorkerProcessRunner.js';
import { coreLogger } from './core/Log.js';
import { ScheduledTaskManager } from './core/ScheduledTaskManager.js';
import { ResourceBudgetService } from './core/ResourceBudgetService.js';
import { UpdateChecker } from './core/UpdateChecker.js';
import { tempDownloadRegistry } from './core/TempDownloadRegistry.js';
import { config as runtimeConfig, getConfigValue, startSettingsWatcher, stopSettingsWatcher } from './config.js';
import { installProcessRuntimeGuards } from './core/RuntimeGuards.js';
import { ConnectionManager, SseBridge, AcpHandler, StorageApi, FileChangesApi, WikiApi, ServerAuth } from './web-server/index.js';
import { GitIntegrationApi } from './web-server/GitIntegrationApi.js';
import { GitActivityBuffer } from './web-server/GitActivityBuffer.js';
import { AgentActivityBuffer } from './web-server/AgentActivityBuffer.js';
import { registerSessionRoutes } from './web-server/SessionRoutes.js';
import { registerSettingsRoutes } from './web-server/SettingsRoutes.js';
import { registerFileSystemRoutes } from './web-server/FileSystemRoutes.js';
import { registerArtifactPreviewRoutes } from './web-server/ArtifactPreviewRoutes.js';
import { registerTempDownloadRoutes } from './web-server/TempDownloadRoutes.js';
import { registerWikiRoutes } from './web-server/WikiRoutes.js';
import { registerContractRoutes } from './web-server/ContractRoutes.js';
import { registerDaemonRoutes } from './web-server/DaemonRoutes.js';
import { registerStatsRoutes } from './web-server/StatsRoutes.js';
import { registerWorkflowRoutes } from './web-server/WorkflowRoutes.js';
import { registerPluginRoutes } from './web-server/PluginRoutes.js';
import { registerToolsRoutes } from './web-server/ToolsRoutes.js';
import { registerRolesRoutes } from './web-server/RolesRoutes.js';
import { registerCommandsRoutes } from './web-server/CommandsRoutes.js';
import { registerWorkerRoutes } from './web-server/WorkerRoutes.js';
import { registerFileChangesRoutes } from './web-server/FileChangesRoutes.js';
import { registerMiscRoutes } from './web-server/MiscRoutes.js';
import { registerWorkspaceRoutes } from './web-server/WorkspaceRoutes.js';
import { registerLangfuseRoutes } from './web-server/LangfuseRoutes.js';
import { initLangfuse, shutdownLangfuse, readLangfuseConfig, setLangfuseEmitter } from './core/LangfuseIntegration.js';
import { onConfigReload } from './config.js';
import { reconcileToolRegistryFromConfig } from './tools/index.js';
import { registerAcpRoutes } from './web-server/AcpRoutes.js';
import { registerTerminalRoutes } from './web-server/TerminalRoutes.js';
import { registerScheduledTaskRoutes } from './web-server/ScheduledTaskRoutes.js';
import { registerWorkbenchRoutes } from './web-server/WorkbenchRoutes.js';
import { registerWorktreeRoutes } from './web-server/WorktreeRoutes.js';
import { registerMcpShareRoutes } from './web-server/McpShareRoutes.js';
import { registerDesignMarketRoutes } from './web-server/DesignMarketRoutes.js';
import { registerBrowserRoutes } from './web-server/BrowserRoutes.js';
import { registerOfficeRoutes } from './web-server/OfficeRoutes.js';
import { createLlmGuard } from './agents/LlmGuard.js';
import { getExternalAgentAvailability } from './agents/external/availability.js';

const defaultEmitter = createEventEmitter();
const defaultMessageBus = createMessageBus(1000, defaultEmitter);
import { startLocalLlmGatewayServer } from './core/LocalLlmGatewayServer.js';
import { BrowserRuntime } from './core/BrowserRuntime.js';
import { ActiveSessionCoordinator } from './core/ActiveSessionCoordinator.js';
import ws from '@fastify/websocket';
import { FILE_PARSER } from './config/defaults.js';
import { configureLogging } from './core/Log.js';
import { writeWatchdog } from './core/EternalSupervisor.js';
import { rateLimitExemptLocalhost, isHardenedMode } from './core/HardeningPolicy.js';
import { processExists } from './utils/platform.js';

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function mediaTypeFromHeader(contentType: unknown): string | null {
  if (typeof contentType !== 'string') return null;
  const [mediaType] = contentType.split(';', 1);
  const normalized = mediaType.trim().toLowerCase();
  return normalized || null;
}

type StaticSetHeadersResponse = {
  getHeader: FastifyReply['getHeader'];
  setHeader: FastifyReply['header'];
  readonly filename: string;
  statusCode: number;
};

/**
 * 安装独立运行模式下的进程级信号处理。
 *
 * 关键：只能在 server.ts 作为独立入口直接运行时调用（见文件底部）。
 * 当 CLI 交互模式 `import('./server.js')` 时，模块顶层若注册这些 handler，
 * 会与 cli.ts 自己的 handler 叠加 —— 一个信号触发两套 cleanup，
 * 把交互式长跑会话连同 worker agent 一起拆掉（即"自杀"现象）。
 */
function installStandaloneSignalHandlers(): void {
  installProcessRuntimeGuards();

  process.on('SIGTERM', async () => {
    console.log('[Server] Received SIGTERM, shutting down gracefully...');
    await gracefulShutdown(0, 10000);
  });
  process.on('SIGINT', async () => {
    console.log('[Server] Received SIGINT, shutting down gracefully...');
    await gracefulShutdown(0, 10000);
  });
  process.on('SIGHUP', async () => {
    console.log('[Server] Received SIGHUP, shutting down gracefully...');
    await gracefulShutdown(0, 10000);
  });
}

/**
 * 判断某请求是否应豁免限流。
 *
 * - **进程内自调用**（fastify.inject / 无 remoteAddress）：始终豁免，避免内部代理/SSE 桥自伤。
 * - **localhost**：非加固模式豁免（前端同源 + daemon 代理）；加固模式不豁免——
 *   daemon 代理 / 反代下源 IP 恒为 127.0.0.1，无条件豁免会使限流整体失效。
 *
 * @param ip          request.ip
 * @param hasRemoteAddress 是否有真实远端地址（false = 进程内自调用）
 * @param exemptLocalhost  是否豁免 localhost（= HardeningPolicy.rateLimitExemptLocalhost()）
 */
export function shouldExemptFromRateLimit(
  ip: string | undefined,
  hasRemoteAddress: boolean,
  exemptLocalhost: boolean,
): boolean {
  // 进程内自调用：fastify.inject 不带 socket.remoteAddress，始终豁免。
  if (!hasRemoteAddress) return true;
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return isLocalhost && exemptLocalhost;
}

/**
 * 绑定非 localhost 且未开启加固模式时打印强警告。
 * 这条不门控、始终生效：把服务直接暴露到 0.0.0.0 / LAN 地址而未加固，
 * 等于把宿主任意文件读写 / 终端 / 子进程能力暴露给同网段任意人。
 *
 * @returns 是否打印了告警（便于测试）
 */
export function warnIfInsecureHostBinding(host: string, hardened: boolean): boolean {
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (isLoopback || hardened) return false;
  console.warn(
    '\n[SECURITY] ⚠ 凌霄 Web Server 正绑定到非 localhost 地址 (' + host + ')，但「企业内网加固模式」未开启。\n' +
    '  此时持有 server token 者可经网络读写宿主任意文件、开终端、跑子进程。\n' +
    '  若部署在企业内网 / 多用户环境，强烈建议开启加固模式：\n' +
    '    · 设置环境变量 LINGXIAO_HARDENED_MODE=1（部署期单向锁定），或\n' +
    '    · 在 Web UI 设置 → 安全沙箱中打开「企业内网加固模式」。\n',
  );
  return true;
}

/**
 * 创建 Fastify 服务器（独立运行模式，自建 db/sessionManager）
 */
export async function createServer() {
  // 清理上次崩溃/非正常退出遗留的孤儿 Worker 进程（全量扫描 /proc，本进程的 Worker 尚未生成）。
  await WorkerProcessRunner.killOrphanWorkers();

  configureLogging({ file: true });
  const db = new DatabaseManager(runtimeConfig.paths.db_path);
  db.init();

  registerCleanup(() => db.close(), 10);
  // 在 DB 关闭前终止所有 Worker 子进程（优先级 9.5 < 10，升序排序下先于 db.close 执行）。
  // 进程全量清理是单机单 daemon 的设计约定。
  registerCleanup(async () => { await WorkerProcessRunner.killOrphanWorkers(); }, 9.5);

  // 退出兜底：gracefulShutdown 超时强退时 runAllCleanups 可能未跑到 db.close，
  // process('exit') 是同步退出的最后窗口，幂等调用确保 WAL checkpoint + 锁释放。
  process.on('exit', () => {
    try { db.close(); } catch { /* tolerate — already closed */ }
  });

  const sessionManager = new SessionManager(db, defaultEmitter);
  const activeSessionCoordinator = new ActiveSessionCoordinator(undefined, 'server');

  return createServerWithDeps(db, sessionManager, { logger: true, activeSessionCoordinator });
}

/**
 * 创建 Fastify 服务器（复用已有的 db/sessionManager，适用于 TUI 集成模式）
 *
 * @param activeSessionCoordinator 可选协调器，作为 Web/TUI/路由共同的当前会话来源
 */
export async function createServerWithDeps(
  db: DatabaseManager,
  sessionManager: SessionManager,
  options?: {
    logger?: boolean;
    activeSessionCoordinator?: ActiveSessionCoordinator;
    isDaemon?: boolean;
    emitter?: ReturnType<typeof createEventEmitter>;
    messageBus?: ReturnType<typeof createMessageBus>;
  },
) {
  const __t0 = process.hrtime.bigint();
  const eventEmitter = options?.emitter ?? defaultEmitter;
  const bus = options?.messageBus
    ?? (eventEmitter === defaultEmitter ? defaultMessageBus : createMessageBus(1000, eventEmitter));
  const repos = new DatabaseRepositoryAdapter(db);
  const fastify = Fastify({
    logger: options?.logger ?? false,
    bodyLimit: Math.ceil(FILE_PARSER.MAX_UPLOAD_TOTAL_BYTES * 1.4),
  });

  // 注册 CORS — 同源策略，前后端同服务器
  await fastify.register(cors, {
    origin: false,
  });

  // 注册 WebSocket 支持（用于交互式终端）
  await fastify.register(ws);

  // 初始化 Web UI 基础设施
  const serverAuth = new ServerAuth();
  const connectionManager = new ConnectionManager();
  const sseBridge = new SseBridge(eventEmitter, connectionManager);
  // 同进程只有一个“当前会话”。Web 切换、TUI 输入、/active、文件/产物等默认会话路由
  // 全部读写这一个 coordinator，避免 Web/TUI 各自按最近 active 会话猜测导致提交目标割裂。
  const activeSessionCoordinator = options?.activeSessionCoordinator
    ?? new ActiveSessionCoordinator(undefined, 'startup');
  const getActiveSessionId = () => activeSessionCoordinator.getActiveSessionId();
  const acpHandler = new AcpHandler(sessionManager, db, connectionManager, (sessionId: string) => {
    activeSessionCoordinator.setActiveSessionId(sessionId, 'web');
  }, eventEmitter);
  const storageApi = new StorageApi(repos.sessionState);
  const fileChangesApi = new FileChangesApi(repos);
  const gitIntegrationApi = new GitIntegrationApi();
  const gitActivityBuffer = new GitActivityBuffer();
  gitActivityBuffer.start(eventEmitter);
  registerCleanup(() => gitActivityBuffer.stop(), 8);
  const agentActivityBuffer = new AgentActivityBuffer();
  agentActivityBuffer.start(eventEmitter);
  registerCleanup(() => agentActivityBuffer.stop(), 8);
  const wikiApi = new WikiApi(eventEmitter, repos);
  const browserRuntime = new BrowserRuntime();
  const scheduledTaskManager = new ScheduledTaskManager(db, bus, eventEmitter, sessionManager);
  scheduledTaskManager.start();
  registerCleanup(() => scheduledTaskManager.stop(), 9);
  acpHandler.setScheduledTaskManager(scheduledTaskManager);
  sessionManager.setScheduledTaskManager(scheduledTaskManager);

  // 优雅拆除所有 session 的 AgentPool：release 每个活跃 session → pool.destroy() →
  // workerRunner.destroy()（SIGKILL 已跟踪的 worker 子进程 + 销毁 IPC 队列 + 清 kill/cleanup
  // 定时器 + removeAllListeners）。优先级 9.4 介于 scheduledTask(9) 与 killOrphanWorkers(9.5)
  // 之间：先按 pool 句柄精确收尸，再让 killOrphanWorkers 经持久化注册表（PidRegistry）
  // 回收「pool 丢失跟踪的」残留进程（全平台；Linux 另有 /proc 兜底），最后 db.close(10)。createServerWithDeps 是 server/cli-daemon/cli-tui 三入口的
  // 公共尾部，在此注册一次即覆盖全部启动路径。
  registerCleanup(() => sessionManager.destroy(), 9.4);

  // ── 资源预算服务（24/7 长跑磁盘清理） ──────────────────────────
  // 定期统计 .lingxiao/sessions/、logs/，清理 terminal/scratchpad 临时数据，并触发 SQLite WAL checkpoint。
  // 修剪高写入量 DB 审计/日志表(agent_logs/token_usage/messages/llm_gateway_requests/execution_trace_events)，
  // 但不触碰会话 resume 源(leader_conversation/agent_conversation)与会话产物/Agent 日志磁盘目录(只统计)。
  const resourceBudget = new ResourceBudgetService(process.cwd(), {
    dbPath: db.getPath(),
    getActiveSessionIds: () => sessionManager.getActiveSessionIds(),
    walCheckpoint: () => {
      try {
        db.getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (err) {
        // 数据库可能已关闭，吞掉避免循环里抛
        void err;
      }
    },
    pruneDatabaseRecords: (maxAgeHours) => {
      try {
        return db.pruneOldRecords(maxAgeHours);
      } catch (err) {
        // DB 可能已关闭，吞掉避免清理循环里抛
        void err;
        return 0;
      }
    },
  });
  // Deferred to post-listen: non-critical background service
  setImmediate(() => {
    try { resourceBudget.start(); } catch (err) {
      console.error('[Server] ResourceBudget start failed:', err instanceof Error ? err.message : String(err));
    }
  });
  registerCleanup(() => {
    resourceBudget.stop();
  }, 8);
  // ── 启动后自动检查版本更新 ──────────────────────────────────────
  // 延迟 10s 异步检查 GitHub releases，发现新版本时通过 notification:new
  // 推送到 TUI / WebUI；每 24h 定期检查；不阻塞启动。
  const updateChecker = new UpdateChecker(eventEmitter, () => sessionManager.getActiveSessionIds());
  // Deferred to post-listen: already delays 10s internally before first check
  setImmediate(() => {
    try { updateChecker.start(); } catch (err) {
      console.error('[Server] UpdateChecker start failed:', err instanceof Error ? err.message : String(err));
    }
  });
  registerCleanup(() => updateChecker.stop(), 8);

  /**
   * 验证 server token — 替代原 requireServerToken
   * 检查 x-lingxiao-token header 或 ?token= query param
   */
  function requireServerToken(request: { headers: Record<string, string | string[] | undefined>; query?: unknown }, reply: { status: (c: number) => { send: (b: unknown) => void } }): boolean {
    if (!serverAuth.validate(request)) {
      reply.status(401).send({ error: 'Unauthorized: invalid or missing server token' });
      return false;
    }
    return true;
  }

  // --- 速率限制（简易内存实现，200 req/min/IP）---
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  // 定期清理过期条目，防止内存无限增长
  const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  }, 5 * 60_000);
  rateLimitCleanup.unref();
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const ip = request.ip;
    // 加固模式不再无条件豁免 localhost（daemon 代理/反代下源 IP 恒为 127.0.0.1 会使限流整体失效）；
    // 进程内自调用（fastify.inject，无 socket.remoteAddress）始终豁免。默认关闭时保持现状：豁免 localhost。
    const hasRemoteAddress = Boolean(request.raw.socket.remoteAddress);
    if (shouldExemptFromRateLimit(ip, hasRemoteAddress, rateLimitExemptLocalhost())) return;
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
      return;
    }
    entry.count++;
    if (entry.count > 200) {
      throw Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 });
    }
  });

  // --- 安全响应头 ---
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.url.startsWith('/api/v1/artifacts/raw')) {
      reply.header('X-Frame-Options', 'SAMEORIGIN');
    } else {
      reply.header('X-Frame-Options', 'DENY');
    }
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // --- 前端 HTML 注入 server token ---
  // @fastify/static 可能以 string 或 Buffer 发送 index.html，两种都要处理。
  fastify.addHook('onSend', async (_request, reply, payload) => {
    const contentType = mediaTypeFromHeader(reply.getHeader('content-type'));
    if (contentType !== 'text/html') return payload;

    // 统一转 string 处理，兼容 string / Buffer
    let html: string;
    if (typeof payload === 'string') {
      html = payload;
    } else if (Buffer.isBuffer(payload)) {
      html = payload.toString('utf-8');
    } else {
      return payload;
    }

    if (!html.includes('</head>')) return payload;

    const injected = html.replace(
      '</head>',
      `<script>window.__LINGXIAO_TOKEN__ = ${JSON.stringify(serverAuth.token)};</script></head>`,
    );
    reply.header('content-length', Buffer.byteLength(injected));
    return injected;
  });

  // 启动 SSE 事件桥接
  sseBridge.start();

  // 启动 settings.json 热加载（延后到 listen 后）
  setImmediate(() => {
    try { startSettingsWatcher(); } catch (err) {
      console.error('[Server] SettingsWatcher start failed:', err instanceof Error ? err.message : String(err));
    }
  });
  registerCleanup(() => stopSettingsWatcher(), 7);
  // settings.json 热加载后同步活跃 session 的 ToolRegistry：
  // - 直接编辑 settings.tools.user_defined / disabled_names 不再需要重启
  // - 不重建 registry，避免丢失 terminal/node/browser 等状态型工具实例
  const disposeToolRegistryReload = onConfigReload(() => {
    const changedNames = new Set<string>();
    let reconciledSessions = 0;
    for (const sessionId of sessionManager.getActiveSessionIds()) {
      const registry = sessionManager.getSessionToolRegistry(sessionId);
      if (!registry) continue;
      try {
        const result = reconcileToolRegistryFromConfig(registry);
        if (!result.changed) continue;
        reconciledSessions++;
        for (const name of result.changedNames) changedNames.add(name);
      } catch (error) {
        coreLogger.warn(`[Tools] settings hot reload reconcile failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (changedNames.size > 0) {
      for (const name of changedNames) {
        try { eventEmitter.emit('tools:changed', { action: 'reload', name }); } catch { /* ignore listener failures */ }
      }
      coreLogger.info(`[Tools] settings hot reload reconciled ${changedNames.size} tool(s) across ${reconciledSessions} active session(s): ${Array.from(changedNames).join(', ')}`);
    }
  });
  registerCleanup(() => disposeToolRegistryReload(), 7);

  // 初始化 Langfuse 可观测性集成（可选，默认关闭）
  try {
    const langfuseConfig = readLangfuseConfig();
    initLangfuse(langfuseConfig);
    // Wire up emitter for real-time SSE trace push
    setLangfuseEmitter(eventEmitter);
    // 注册热加载回调：配置变更时自动重新初始化或关闭
    onConfigReload((cfg) => {
      const raw = (cfg as any)?.observability?.langfuse ?? {};
      import('./core/LangfuseIntegration.js').then(({ langfuseIntegration }) => {
        langfuseIntegration.onReload({
          enabled: raw.enabled === true,
          baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : 'https://cloud.langfuse.com',
          secretKey: typeof raw.secretKey === 'string' ? raw.secretKey : '',
          publicKey: typeof raw.publicKey === 'string' ? raw.publicKey : '',
          traceLlmCalls: raw.traceLlmCalls !== false,
          traceToolCalls: raw.traceToolCalls === true,
          traceAgentLifecycle: raw.traceAgentLifecycle !== false,
          sampleRate: typeof raw.sampleRate === 'number' ? raw.sampleRate : 1.0,
          maskSensitive: raw.maskSensitive !== false,
          scoreEnabled: raw.scoreEnabled !== false,
        });
      });
    });
    registerCleanup(() => { void shutdownLangfuse(); }, 7);
  } catch {
    // Langfuse init failure must not block server startup
  }

  registerCleanup(() => tempDownloadRegistry.destroy(), 7);
  registerCleanup(() => browserRuntime.destroy(), 7);
  registerCleanup(() => connectionManager.destroy(), 6);
  registerCleanup(() => sseBridge.stop(), 5);

  // ============================================================
  // 路由注册（从独立模块加载）
  // ============================================================

  // 健康检查
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  registerSessionRoutes(fastify, { repos, sessionManager, requireServerToken, getActiveSessionId });
  registerSettingsRoutes(fastify, {
    repos,
    sessionManager,
    requireServerToken,
    getActiveSessionId,
    createLlmGuard,
    getExternalAgentAvailability,
  });
  registerMiscRoutes(fastify, { repos, serverAuth, storageApi, requireServerToken });
  registerWorkspaceRoutes(fastify, { requireServerToken });
  registerContractRoutes(fastify, { requireServerToken });
  registerAcpRoutes(fastify, { sessionManager, connectionManager, acpHandler, requireServerToken });
  registerTerminalRoutes(fastify, { serverAuth, repos });
  gitIntegrationApi.registerRoutes(fastify, requireServerToken);
  gitActivityBuffer.registerRoutes(fastify, requireServerToken);
  agentActivityBuffer.registerRoutes(fastify, requireServerToken);
  registerWorkbenchRoutes(fastify, { repos, sessionManager, requireServerToken, getActiveSessionId });
  registerWorktreeRoutes(fastify, { repos, requireServerToken });
  registerBrowserRoutes(fastify, { requireServerToken, browserRuntime });
  registerOfficeRoutes(fastify, { requireServerToken, getActiveSessionId });
  registerStatsRoutes(fastify, { repos, requireServerToken });
  registerWorkflowRoutes(fastify, { repos, acpHandler, requireServerToken, sessionManager, emitter: eventEmitter, scheduledTaskManager });
  registerPluginRoutes(fastify, { repos, requireServerToken, emitter: eventEmitter });
  registerToolsRoutes(fastify, { requireServerToken, sessionManager, emitter: eventEmitter });
  registerDesignMarketRoutes(fastify, { auth: requireServerToken });
  registerRolesRoutes(fastify, { requireServerToken, sessionManager, emitter: eventEmitter, getExternalAgentAvailability });
  registerCommandsRoutes(fastify, { requireServerToken, sessionManager, emitter: eventEmitter });
  registerWorkerRoutes(fastify, { repos, sessionManager, requireServerToken });
  registerDaemonRoutes(fastify, { requireServerToken, repos, sessionManager, emitter: eventEmitter, serverToken: serverAuth.token, isDaemon: options?.isDaemon });
  registerFileChangesRoutes(fastify, { fileChangesApi, requireServerToken });
  registerWikiRoutes(fastify, { wikiApi, emitter: eventEmitter, requireServerToken });
  registerFileSystemRoutes(fastify, { repos, requireServerToken, getActiveSessionId });
  registerArtifactPreviewRoutes(fastify, { repos, requireServerToken, getActiveSessionId });
  registerLangfuseRoutes(fastify, { requireServerToken });
  registerTempDownloadRoutes(fastify);
  registerScheduledTaskRoutes(fastify, { scheduledTaskManager, requireServerToken });
  registerMcpShareRoutes(fastify, { requireServerToken });

  // ============================================================
  // 静态文件服务（Web UI 前端）
  // ============================================================
  try {
    const { existsSync } = await import('fs');
    const thisDir = path.dirname(fileURLToPath(import.meta.url));

    // 智能查找 Web UI 构建产物：
    // 1) dist/web/        — 编译后 dist/server.js 同级的 web/ 目录
    // 2) web/dist/        — 开发模式下 web/ 子目录下的 dist/
    // 3) web/             — 兜底（可能指向源码目录，仅开发时使用）
    const candidates = [
      path.join(thisDir, 'web'),                       // dist/web/
      path.join(thisDir, '..', 'web', 'dist'),         // web/dist/
      path.join(thisDir, '..', 'web'),                 // web/
    ];
    const staticPath = candidates.find(p => existsSync(path.join(p, 'index.html')));

    if (!staticPath) {
      fastify.log.warn('Web UI static files not found, skipping static file serving');
    } else {
      const { default: fastifyStatic } = await import('@fastify/static');
      await fastify.register(fastifyStatic, {
        root: staticPath,
        prefix: '/',
        setHeaders: (res: StaticSetHeadersResponse, filePath: string) => {
          const normalized = filePath.replace(/\\/g, '/');
          const isHashedAsset = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(normalized);
          if (isHashedAsset) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-store, max-age=0');
          }

          if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          } else if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
          } else if (filePath.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
          } else if (filePath.endsWith('.json')) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
          } else if (filePath.endsWith('.svg')) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
          } else if (filePath.endsWith('.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json');
          }
        },
      });

      // SPA fallback: 未匹配路由返回 index.html
      // 但如果请求路径看起来像静态资源（.js/.css/.map 等），返回 404 而非 index.html
      // 避免浏览器用 text/html MIME 加载 JS 模块导致 "Expected a JavaScript module script" 错误
      fastify.setNotFoundHandler(async (request, reply) => {
        const urlPath = request.url.split('?')[0];
        const hasAssetExtension = /\.(js|mjs|css|map|ico|png|jpg|jpeg|gif|svg|woff2?|ttf|eot|webp|webmanifest|wasm)$/i.test(urlPath);
        if (hasAssetExtension) {
          reply.code(404).header('Cache-Control', 'no-store, max-age=0');
          if (urlPath.endsWith('.js') || urlPath.endsWith('.mjs')) {
            reply.type('application/javascript; charset=utf-8');
          } else if (urlPath.endsWith('.css')) {
            reply.type('text/css; charset=utf-8');
          } else if (urlPath.endsWith('.map') || urlPath.endsWith('.json')) {
            reply.type('application/json; charset=utf-8');
          } else if (urlPath.endsWith('.svg')) {
            reply.type('image/svg+xml');
          } else if (urlPath.endsWith('.webmanifest')) {
            reply.type('application/manifest+json');
          } else {
            reply.type('application/octet-stream');
          }
          return 'Not found';
        }
        reply.header('Cache-Control', 'no-store, max-age=0');
        return reply.type('text/html').send(
          await import('fs').then(fs =>
            fs.promises.readFile(path.join(staticPath, 'index.html'), 'utf-8')
          )
        );
      });
    }
  } catch {/* swallowed: unhandled error */
    fastify.log.warn('Web UI static files not found, skipping static file serving');
  }

  // Global error handler — return JSON instead of raw 500
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    if (reply.sent || reply.raw.headersSent || reply.raw.destroyed) {
      if (fastify.log?.error) {
        fastify.log.error({ err: error, url: request.url, method: request.method }, 'Request error after response sent');
      }
      return;
    }

    const statusCode = error.statusCode || 500;
    if (fastify.log?.error) {
      fastify.log.error({ err: error, url: request.url, method: request.method }, 'Request error');
    }
    reply.status(statusCode).send({
      error: error.message || 'Internal Server Error',
      statusCode,
    });
  });

  // 本地 LLM 网关：进程绑定式随机端口监听器（仅在 llm_gateway.enabled 时启动）。
  // 每个进程自己的网关随进程生灭——不再共享复用，消除僵尸进程死网关问题。
  // 绑定后通过 setRuntimeGatewayEndpoint() 注入实际端口，resolveLocalLlmGateway() 读取。
  try {
    await startLocalLlmGatewayServer({ repos, emitter: eventEmitter, getActiveSessionId, createLlmGuard });
  } catch (err) {
    console.warn(
      `[Server] 本地 LLM 网关启动失败，Web UI 继续启动: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const __tEnd = process.hrtime.bigint();
  const __elapsedMs = Number(__tEnd - __t0) / 1e6;
  if (__elapsedMs > 100) {
    console.log(`[Server] createServerWithDeps took ${__elapsedMs.toFixed(0)}ms`);
  }

  return { fastify, token: serverAuth.token, scheduledTaskManager };
}

// ═══════════════════════════════════════════════════════════════
// 端口发现与回退
// ═══════════════════════════════════════════════════════════════

const PORT_FILE = path.join(homedir(), '.lingxiao', 'port');

/** 查找可用端口 — 如果 startPort 被占用则回退到随机端口 */
export async function findAvailablePort(startPort: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = netCreateServer();
    server.listen(startPort, host, () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // 端口被占用，让 OS 分配随机端口
        const randomServer = netCreateServer();
        randomServer.listen(0, host, () => {
          const port = (randomServer.address() as AddressInfo).port;
          randomServer.close(() => resolve(port));
        });
        randomServer.on('error', reject);
      } else {
        reject(err);
      }
    });
  });
}

export interface PortFileInfo {
  pid: number;
  port: number;
  host: string;
  startedAt: number;
}

export function writePortFile(port: number, host: string): void {
  try {
    writeFileSync(PORT_FILE, JSON.stringify({ pid: process.pid, port, host, startedAt: Date.now() }), 'utf-8');
  } catch (err) {
    console.error(`[Server] 写入端口文件失败 (${PORT_FILE}):`, err instanceof Error ? err.message : String(err));
  }
}

export function readPortFile(): PortFileInfo | null {
  if (!existsSync(PORT_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(PORT_FILE, 'utf-8'));
    // 检查进程是否仍在运行
    if (!processExists(data.pid)) return null;
    return data;
  } catch (err) {
    // 端口文件损坏 / 读取失败不能静默：否则 CLI 会误判 daemon 未运行而重复拉起第二个实例。
    console.warn(`[Server] 读取端口文件失败，按 daemon 未运行处理 (${PORT_FILE}):`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function removePortFile(): void {
  try { unlinkSync(PORT_FILE); } catch { /* 文件不存在时忽略 */ }
}

/**
 * 启动服务器
 */
export async function startServer() {
  const __t0 = process.hrtime.bigint();
  const { fastify: server, token } = await createServer();
  const __t1 = process.hrtime.bigint();
  const webHost = runtimeConfig.server.host;
  const webPort = runtimeConfig.server.port;
  const dbPath = runtimeConfig.paths.db_path;

  warnIfInsecureHostBinding(webHost, isHardenedMode());

  // 端口优先级：显式 LINGXIAO_WEB_PORT 环境变量 > random_port 配置 > config.server.port
  const envPort = process.env.LINGXIAO_WEB_PORT;
  const useRandomPort = getConfigValue('server.random_port') === true;
  const requestedPort = (envPort != null && parseInt(envPort, 10) !== 0)
    ? parseInt(envPort, 10)
    : (useRandomPort ? 0 : webPort);

  let actualPort = requestedPort;
  try {
    await server.listen({ host: webHost, port: requestedPort });
    actualPort = (server.server.address() as AddressInfo | null)?.port ?? requestedPort;
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'EADDRINUSE') {
      actualPort = await findAvailablePort(requestedPort, webHost);
      await server.listen({ host: webHost, port: actualPort });
      console.log(`⚠ 端口 ${requestedPort} 已占用，回退到 ${actualPort}`);
    } else {
      server.log.error(err);
      process.exit(1);
    }
  }

  writePortFile(actualPort, webHost);
  registerCleanup(() => removePortFile(), 2);
  registerCleanup(() => server.close(), 3);
  const __t2 = process.hrtime.bigint();
  console.log(`[Server] Startup: init=${(Number(__t1 - __t0) / 1e6) | 0}ms listen=${(Number(__t2 - __t1) / 1e6) | 0}ms total=${(Number(__t2 - __t0) / 1e6) | 0}ms`);

  // Watchdog heartbeat for EternalSupervisor
  const watchdogTimer = setInterval(() => writeWatchdog(), 10_000);
  watchdogTimer.unref();
  writeWatchdog();

  const displayHost = webHost === '0.0.0.0' ? 'localhost' : webHost;
  console.log(`🚀 凌霄剑域服务器启动完成`);
  console.log(`📊 数据库: ${dbPath}`);
  console.log(`🌐 访问地址: http://${displayHost}:${actualPort}?token=${token}`);
  console.log(`🔑 Token: ${token}`);
  console.log(`🔗 SSE 桥接: 已启动`);

  return server;
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  installStandaloneSignalHandlers();
  startServer();
}
