/**
 * WorkerProcessRunner - 专用 Worker 进程运行器
 *
 * 为每个 delegated worker 启动独立 OS 子进程，具备：
 * 1. 结构化父/子生命周期协议
 * 2. IPC 或结构化 stdout/stderr 控制通道
 * 3. 超时、退出码、心跳与回收管理
 * 4. Worker 崩溃不污染 Leader 主进程
 */

import { spawn, execSync, ChildProcess, Serializable } from 'child_process';
import { EventEmitter } from 'events';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { platform } from 'os';
import type { BusMessage } from './MessageBus.js';
import type { WorkerContractComplianceProof } from './AgentProtocol.js';
import type { SpeculativeOrchestrationPlan } from './SpeculativeOrchestrationPlanner.js';
import type { SpeculativeWinnerEvidence } from './SpeculativeExecutionController.js';
import type { ContractPack } from './ContractPack.js';
import type { ContractAllowedScope } from './ContractAllowedScope.js';
import { coreLogger } from './Log.js';
import { t } from '../i18n.js';
import { killProcess, readProcessStartMs } from '../utils/platform.js';
import {
  isCoreWorkerActiveStatus,
  isCoreWorkerTerminalStatus,
  normalizeAgentStatus,
  type CoreWorkerStatus,
} from './StateSemantics.js';
import { registerProtectedPid, unregisterProtectedPid } from './ProcessSelfProtection.js';
import { PidRegistry, isOrphanedEntry } from './PidRegistry.js';
import { IPCDrainQueue } from './ipc/IPCDrainQueue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type WorkerStatus = CoreWorkerStatus;

export interface WorkerTaskPayload {
  taskId: string;
  sessionId: string;
  agentName: string;
  agentId: string;
  roleType: string;
  systemPrompt: string;
  toolNames: string[];
  skillNames?: string[];
  taskSubject: string;
  taskDescription: string;
  workingDirectory: string;
  writeScope: string[];
  model?: string;
  workspace: string;
  maxIterations?: number;
  maxRuntimeMinutes?: number;
  /** Leader context summary from latest compression — gives workers background on what leader has done */
  leaderContextSummary?: string;
  /** Task context injected by Leader — includes prior task notes from blocked_by dependencies */
  taskContext?: string;
  /** Explicit Contract Pack metadata for remote/external workers; systemPrompt remains the authoritative rendered protocol. */
  contractPack?: Pick<ContractPack, 'sessionId' | 'contractsDir' | 'generatedAt' | 'entries'>;
  /** Deterministic speculative branch plan derived from orchestration metadata and trace memory. */
  speculativePlan?: SpeculativeOrchestrationPlan;
  /** @deprecated v1.0.4: adaptive strategy removed, kept for payload compat */
  adaptiveStrategy?: { strategy: string; params: { maxRounds: number; timeoutMs: number; parallelToolCalls: boolean }; signals: Record<string, unknown> };
  /** Prior conversation history for respawn — full agent conversation from DB */
  conversationHistory?: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string; thinking?: unknown[]; timestamp?: number }>;
  /**
   * 继承历史的语义：
   *   - 'resume'：复活同一任务（追问 / team 复活），历史即完整基底，不再注入任务指令。
   *   - 'new_task'（默认）：复用同名 worker 跑新任务，历史作背景 + 追加新任务指令。
   */
  inheritHistoryMode?: 'resume' | 'new_task';
  /** Agent type for task type inference (bootstrap/reason/explore/generic) */
  agentType?: string;
  /** 契约结构化允许面(已对多契约 intersect)——写工具 intersect 硬校验的依据。undefined=无契约。 */
  contractAllowedScope?: ContractAllowedScope;
  /** Per-role git author identity for commit attribution in team workflows. */
  gitIdentity?: { name: string; email: string };
}

export interface WorkerMessage {
  type: 'started' | 'progress' | 'complete' | 'failed' | 'heartbeat' | 'bus_message' | 'event' | 'usage' | 'error';
  timestamp: number;
  payload?: unknown;
}

export interface WorkerCompletionPayload {
  result: string;
  /** evaluator/review 任务的验收结论（可选）。普通实现任务不填。 */
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  stats?: {
    iterations?: number;
    toolCalls?: number;
  };
  tokenUsage?: {
    total?: number;
    prompt?: number;
    completion?: number;
  };
  /**
   * worker 通过 attempt_completion 声明的结构化收尾字段（可选）。
   * Leader 用它 + toolTrace 渲染多区块验收上下文。
   */
  summary?: string;
  artifacts?: {
    files_created?: string[];
    files_modified?: string[];
    commands_run?: string[];
  };
  verification?: Array<{ kind: string; detail: string; passed?: boolean }>;
  next_steps?: string[];
  blocked_by_discovery?: string[];
  needs_leader_coordination?: boolean;
  evidence_refs?: string[];
  contract_compliance?: WorkerContractComplianceProof;
  /** 框架自动采集的工具产物轨迹（与 artifacts 在 Leader 端按路径去重合并） */
  toolTrace?: {
    files_created?: string[];
    files_modified?: string[];
    commands_run?: string[];
  };
  /** If this completion accepts a speculative branch winner, it must include passed Goal-7 verification evidence. */
  speculativeWinner?: SpeculativeWinnerEvidence;
}

export interface WorkerBusEnvelope {
  from: string;
  to: string;
  type: string;
  payload: unknown;
}

export interface WorkerEventEnvelope {
  eventName: string;
  data: unknown;
}

export interface WorkerUsageEnvelope {
  agentId?: string;
  modelName?: string;
  usage: {
    prompt: number;
    completion: number;
    total: number;
    cache_read?: number;
    cache_creation?: number;
  };
}

export interface WorkerParentMessage {
  type: 'deliver_message';
  payload: BusMessage;
}

export interface WorkerHandle {
  agentId: string;
  agentName: string;
  taskId: string;
  process: ChildProcess;
  payloadPath: string;
  status: WorkerStatus;
  startTime: number;
  endTime?: number;
  exitCode?: number | null;
  error?: Error;
  lastHeartbeat: number;
  result?: string;
  recentStdout: string[];
  recentStderr: string[];
  timeoutReason?: 'spawn_timeout' | 'heartbeat_timeout' | 'max_runtime' | 'zombie_detected';
  /** 进程退出后延迟 GC 该条目的定时器；复用同名时需先取消，避免误删新 worker。 */
  cleanupTimer?: NodeJS.Timeout;
}

export interface WorkerProcessDiagnostics {
  workerId: string;
  agentId: string;
  agentName: string;
  taskId: string;
  pid?: number;
  status: WorkerStatus;
  exitCode?: number | null;
  exitSignal?: string | null;
  timeoutReason?: WorkerHandle['timeoutReason'];
  error?: string;
  stderrTail: string[];
  stdoutTail: string[];
  startTime: number;
  endTime?: number;
  lastHeartbeat: number;
}

export interface WorkerProcessRunnerOptions {
  heartbeatTimeoutMs?: number;
  spawnTimeoutMs?: number;
  maxRuntimeMs?: number;
  debug?: boolean;
  workerScriptPath?: string;
  heartbeatMonitorIntervalMs?: number;
}

const DEFAULT_OPTIONS: Required<WorkerProcessRunnerOptions> = {
  heartbeatTimeoutMs: 90000,  // 3x heartbeat interval (30s) — 容忍偶尔延迟
  spawnTimeoutMs: 30000,
  maxRuntimeMs: 480 * 60 * 1000, // 8 hours — 与 defaults.ts WORKER_MAX_RUNTIME_MS 一致
  debug: false,
  workerScriptPath: resolve(__dirname, '../agents/WorkerProcessEntry.js'),
  heartbeatMonitorIntervalMs: 5000,
};

/**
 * WorkerProcessRunner - 管理 Worker 子进程生命周期
 */
export class WorkerProcessRunner extends EventEmitter {
  private workers: Map<string, WorkerHandle> = new Map();
  private options: Required<WorkerProcessRunnerOptions>;
  private heartbeatInterval?: NodeJS.Timeout;
  private payloadCleanupInterval?: NodeJS.Timeout;
  private shutdown = false;
  private killTimers: Map<string, NodeJS.Timeout> = new Map();
  /**
   * IPC 异步消费队列：child.on('message') 仅 O(1) push，drain 按 P0→P3 优先级分批异步消费，
   * 让出 event loop。避免单个 worker 的事件风暴（progress/heartbeat/text_chunk）在同步
   * listener 里阻塞 IPC 接收 → 反压 worker 端 process.send → 心跳延迟被误判超时杀活进程，
   * 或 pipe 满时 complete 投递失败被丢。complete/failed/error 为 P0 永不丢。
   */
  private ipcQueue: IPCDrainQueue;

  constructor(options: WorkerProcessRunnerOptions = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.ipcQueue = new IPCDrainQueue({
      consume: (workerId, msg) => this.handleWorkerMessage(workerId, msg),
    });
    this.startHeartbeatMonitor();
    this.startPayloadCleanup();
  }

  /**
   * 启动 Worker 子进程
   */
  async spawnWorker(
    payload: WorkerTaskPayload,
    env: Record<string, string> = {}
  ): Promise<WorkerHandle> {
    const workerId = payload.agentName;

    const existing = this.workers.get(workerId);
    if (existing) {
      // 同名 worker 仍处于活跃态（starting/running）→ 真冲突，拒绝。
      // register() 上游已拦截运行中的同名 agent，这里是二次防御。
      // 终态解释统一走 StateSemantics，避免 Runner 自己维护 completed/failed/timeout/crashed 集合。
      const isTerminal = existing.endTime !== undefined || isCoreWorkerTerminalStatus(existing.status);
      if (!isTerminal) {
        throw new Error(`Worker ${workerId} already exists`);
      }
      // 复用同名 slot：上一轮 worker 已终态，仅因 handleWorkerExit 的 5s 延迟 GC
      // 仍滞留在 map 里。取消 pending GC、摘掉旧进程监听（防其 late exit/僵尸检测
      // 改写即将创建的新 handle 状态）、清旧 payload，再移除旧条目，让新进程接管。
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
      }
      // 二次防御：取消上一代残留的 kill 升级定时器（handleWorkerExit 已清，
      // 此处兜底极端时序，防升级回调误杀即将创建的新同名进程）。
      const reuseKillTimer = this.killTimers.get(workerId);
      if (reuseKillTimer) {
        clearTimeout(reuseKillTimer);
        this.killTimers.delete(workerId);
      }
      try {
        existing.process.removeAllListeners();
        // 正常路径下旧进程已自行退出；极端情况（crashed/timeout 后僵尸残留）
        // 仍 connected 时主动收尸，避免遗留子进程。
        if (existing.process.connected || existing.process.exitCode === null) {
          if (existing.process.pid) {
            void killProcess(existing.process.pid, 'SIGKILL', { tree: true });
          } else {
            existing.process.kill('SIGKILL');
          }
        }
      } catch {
        // 进程可能已销毁，忽略
      }
      this.cleanupPayloadFile(workerId);
      this.workers.delete(workerId);
      coreLogger.debug(`[WorkerProcessRunner] 复用同名 slot：移除已终态旧 worker ${workerId} (status=${existing.status})`);
    }

    // 创建临时 payload 文件（避免命令行参数过长）
    const payloadPath = this.writePayloadFile(payload);

    // 构建环境变量
    const childEnv = {
      ...process.env,
      ...env,
      LINGXIAO_WORKER_PAYLOAD: payloadPath,
      LINGXIAO_WORKER_ID: workerId,
      LINGXIAO_WORKER_SESSION: payload.sessionId,
    };

    // 启动子进程
    const child = spawn(process.execPath, [this.options.workerScriptPath], {
      cwd: process.cwd(),  // 确保工作目录正确
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: false,
    });

    const handle: WorkerHandle = {
      agentId: payload.agentId,
      agentName: payload.agentName,
      taskId: payload.taskId,
      process: child,
      payloadPath,
      status: 'starting',
      startTime: Date.now(),
      lastHeartbeat: Date.now(),
      recentStdout: [],
      recentStderr: [],
    };

    this.workers.set(workerId, handle);

    // 注册 worker PID 到进程保护集（防止被其他 agent shell 命令误杀）
    if (child.pid) {
      registerProtectedPid(child.pid);
      // 持久化注册到 PidRegistry：父进程（本进程）崩溃后，下次启动的
      // killOrphanWorkers 可据此回收孤儿 worker（跨平台，不依赖 /proc）。
      PidRegistry.register({
        pid: child.pid,
        sessionId: payload.sessionId,
        cwd: process.cwd(),
        startedAt: Date.now(),
        kind: 'worker',
        name: workerId,
        agentId: payload.agentId,
        agentName: payload.agentName,
        taskId: payload.taskId,
        backend: 'worker_process',
        parentPid: process.pid,
        parentStartedAt: readProcessStartMs(process.pid) ?? Date.now(),
      });
    }

    // 设置 IPC 消息处理：仅 O(1) 入队，drain 异步分批消费（防事件风暴反压心跳/丢 complete）
    child.on('message', (msg: WorkerMessage) => {
      this.ipcQueue.push(workerId, msg);
    });

    // 设置 stdout/stderr 日志
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.appendRecentOutput(handle.recentStdout, text);
      if (this.options.debug) {
        coreLogger.debug(`[Worker ${workerId}] ${text.trim()}`);
      }
      this.emit('worker:stdout', { workerId, data: text });
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.appendRecentOutput(handle.recentStderr, text);
      if (this.options.debug) {
        console.error(`[Worker ${workerId} stderr] ${text.trim()}`);
      }
      this.emit('worker:stderr', { workerId, data: text });
    });

    // 设置进程退出处理
    child.on('exit', (code, signal) => {
      this.handleWorkerExit(workerId, code, signal);
    });

    child.on('error', (error) => {
      this.handleWorkerError(workerId, error);
    });

    // 等待启动确认或超时
    await this.waitForWorkerStart(workerId);

    return handle;
  }

  /**
   * 等待 Worker 启动确认
   */
  private waitForWorkerStart(workerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const handle = this.workers.get(workerId);
      if (!handle) {
        reject(new Error(`Worker ${workerId} not found`));
        return;
      }

      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('worker:started', onStarted);
        this.off('worker:error', onError);
        this.off('worker:exit', onExit);
      };

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const timeout = setTimeout(() => {
        this.markWorkerTimeout(workerId, 'spawn_timeout', `spawn timeout after ${this.options.spawnTimeoutMs}ms`);
        this.killWorker(workerId, 'spawn timeout');
        settleReject(this.createStartupError(workerId, `spawn timeout after ${this.options.spawnTimeoutMs}ms`));
      }, this.options.spawnTimeoutMs);

      const onStarted = (startedId: string) => {
        if (startedId === workerId) {
          settleResolve();
        }
      };

      const onError = (erroredId: string, error: unknown) => {
        if (erroredId === workerId) {
          settleReject(this.createStartupError(workerId, this.describeWorkerError(error)));
        }
      };

      const onExit = (
        exitedId: string,
        code: number | null,
        signal: NodeJS.Signals | null,
        status: WorkerStatus,
      ) => {
        if (exitedId !== workerId) {
          return;
        }

        const parts = [`exited before startup completed (status=${status}`];
        if (code !== null) {
          parts.push(`code=${code}`);
        }
        if (signal) {
          parts.push(`signal=${signal}`);
        }
        parts.push(')');

        settleReject(this.createStartupError(workerId, parts.join(', ')));
      };

      this.on('worker:started', onStarted);
      this.on('worker:error', onError);
      this.on('worker:exit', onExit);
    });
  }

  /**
   * 处理 Worker IPC 消息
   */
  private handleWorkerMessage(workerId: string, msg: WorkerMessage): void {
    const handle = this.workers.get(workerId);
    if (!handle) return;

    handle.lastHeartbeat = Date.now();

    switch (msg.type) {
      case 'started':
        if (!isCoreWorkerActiveStatus(handle.status)) {
          return;
        }
        handle.status = 'running';
        this.emit('worker:started', workerId, msg.payload);
        break;

      case 'progress':
        this.emit('worker:progress', workerId, msg.payload);
        break;

      case 'complete':
        if (!isCoreWorkerActiveStatus(handle.status)) {
          coreLogger.warn(`Ignoring late worker complete from ${workerId}: current status=${handle.status}`);
          return;
        }
        handle.status = 'completed';
        handle.result = this.extractCompletionResult(msg.payload);
        handle.endTime = Date.now();
        this.emit('worker:complete', workerId, msg.payload);
        break;

      case 'failed':
        if (!isCoreWorkerActiveStatus(handle.status)) {
          coreLogger.warn(`Ignoring late worker failed from ${workerId}: current status=${handle.status}`);
          return;
        }
        handle.status = 'failed';
        handle.endTime = Date.now();
        this.emit('worker:failed', workerId, msg.payload);
        break;

      case 'heartbeat':
        this.emit('worker:heartbeat', workerId, msg.payload);
        break;

      case 'bus_message':
        this.emit('worker:bus_message', workerId, msg.payload);
        break;

      case 'event': {
        const event = msg.payload as WorkerEventEnvelope | undefined;
        this.emit('worker:event', workerId, event);
        if (event?.eventName === 'agent:text_chunk') {
          this.emit('agent:text_chunk', workerId, event.data);
        }
        break;
      }

      case 'usage':
        this.emit('worker:usage', workerId, msg.payload);
        break;

      case 'error':
        if (!isCoreWorkerActiveStatus(handle.status)) {
          coreLogger.warn(`Ignoring late worker error from ${workerId}: current status=${handle.status}`);
          return;
        }
        handle.status = 'failed';
        handle.error = msg.payload instanceof Error ? msg.payload : new Error(String(msg.payload ?? 'Unknown worker error'));
        this.emit('worker:error', workerId, handle.error);
        break;
    }
  }

  /**
   * 处理 Worker 进程退出
   */
  private markWorkerTimeout(workerId: string, reason: NonNullable<WorkerHandle['timeoutReason']>, detail: string): void {
    const handle = this.workers.get(workerId);
    if (!handle || !isCoreWorkerActiveStatus(handle.status)) return;
    handle.timeoutReason = reason;
    handle.status = 'timeout';
    handle.endTime = Date.now();
    const error = new Error(`worker timeout: ${workerId}: ${detail}`);
    handle.error = error;
    this.emit('worker:timeout', workerId, error, reason);
  }

  private handleWorkerExit(
    workerId: string,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const handle = this.workers.get(workerId);
    if (!handle) return;

    // 从进程保护集注销，并从持久化注册表移除（worker 正常退出，不再是孤儿候选）
    if (handle.process.pid) {
      unregisterProtectedPid(handle.process.pid);
      PidRegistry.unregister(handle.process.pid);
    }

    handle.exitCode = code;
    handle.endTime = Date.now();

    // 进程已退出：取消待决的 SIGTERM→SIGKILL 升级定时器（killWorker 设的 5s 定时器）。
    // 否则同名 worker 在升级窗口内被 respawn 复用 slot 时，残留定时器回调会取到
    // 「新 handle」（无 endTime）并误杀新进程——真 bug。退出即清是根因修复。
    const pendingKill = this.killTimers.get(workerId);
    if (pendingKill) {
      clearTimeout(pendingKill);
      this.killTimers.delete(workerId);
    }

    // 退出前同步排干该 worker 的 IPC 队列：进程 'exit' 可能在最后一条 'complete' 被
    // 异步 drain 前触发，先排干保证 complete 被处理（置位 completionReceived），再清队列，
    // 避免 pending complete 被丢弃、worker:exit 误判崩溃重复恢复重派。
    this.ipcQueue.drainAllSync(workerId);
    this.ipcQueue.remove(workerId);

    // 清理 payload 文件
    this.cleanupPayloadFile(workerId);

    // 只有仍处于 active 口径的 worker 才能被进程退出事件改写为失败态；
    // 已经 completed/failed/timeout/crashed 的 handle 不能被 late exit 再覆盖。
    if (isCoreWorkerActiveStatus(handle.status)) {
      // 非正常退出
      if (code === null && signal) {
        handle.status = signal === 'SIGTERM' ? 'terminated' : 'crashed';
      } else if (code !== 0) {
        handle.status = 'crashed';
      }
    }

    // Include crash diagnostics so callers can inspect stderr/stdout
    if (normalizeAgentStatus(handle.status) === 'failed') {
      const stderrTail = handle.recentStderr.slice(-5).join('\n').trim();
      const stdoutTail = handle.recentStdout.slice(-5).join('\n').trim();
      if (stderrTail || stdoutTail) {
        const diag = stderrTail || stdoutTail;
        handle.error = handle.error || new Error(`Worker ${workerId} ${handle.status}: ${diag}`);
      }
    }

    this.emit('worker:exit', workerId, code, signal, handle.status);

    // Delayed cleanup — tracked on the handle so a same-name reuse (spawnWorker)
    // can cancel it, and destroy() can clear it.
    const cleanupTimer = setTimeout(() => {
      this.workers.delete(workerId);
    }, 5000);
    // Prevent timer from keeping the process alive
    if (cleanupTimer.unref) cleanupTimer.unref();
    handle.cleanupTimer = cleanupTimer;
  }

  /**
   * 处理 Worker 进程错误
   */
  private handleWorkerError(workerId: string, error: Error): void {
    const handle = this.workers.get(workerId);
    if (!handle) return;

    // EPIPE / ECONNRESET on IPC channel after child exit is benign —
    // the exit handler already processes the real failure.
    // Without this guard, the async 'error' event from a dead pipe
    // would mark the worker as failed and emit session.agent.failed,
    // even though handleWorkerExit has already (or will) handle it.
    const errMsg = (error.message || '').toLowerCase();
    const isPipeError = /epipe|econnreset|ipc channel closed/i.test(errMsg) ||
      (error as NodeJS.ErrnoException).code === 'EPIPE' ||
      (error as NodeJS.ErrnoException).code === 'ECONNRESET';
    if (isPipeError && (handle.endTime !== undefined || handle.process.exitCode !== null || !handle.process.connected)) {
      coreLogger.debug(`[WorkerProcessRunner] Benign ${(error as NodeJS.ErrnoException).code || ''} pipe error on dead worker ${workerId}, ignoring`);
      return;
    }

    handle.error = error;
    if (!isCoreWorkerActiveStatus(handle.status)) {
      return;
    }
    handle.status = 'failed';
    this.emit('worker:error', workerId, error);
  }

  /**
   * 启动心跳监控
   */
  private startHeartbeatMonitor(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [workerId, handle] of this.workers) {
        if (handle.status !== 'running') continue;

        // 僵尸检测：进程已退出(exitCode !== null)但 'exit' 事件因 IPC 断开等竞态尚未触发。
        // 这种「运行中突然消失、无完成回执」本质等同 crash，必须走 worker:exit(crashed)
        // 可恢复路径（worker:exit 处理器 → markAgentRecovering → 重派 LLM）。
        //
        // 历史缺陷：此处曾发裸 new Error 的 worker:failed，而 parseWorkerFailurePayload 对
        // 任何 Error 实例一律判 recoverable:false → markAgentFailed 永久失败，任务永不复活
        // （用户现象：「zombie detected 直接 exit，不重派 LLM 请求」）。
        // 改为合成 worker:exit(crashed)，与 heartbeat_timeout / crashed 走同一条恢复管线。
        try {
          const exitCode = handle.process.exitCode;
          if (exitCode !== null) {
            handle.status = 'crashed';
            handle.exitCode = exitCode;
            handle.endTime = Date.now();
            handle.timeoutReason = 'zombie_detected';
            coreLogger.warn(`Worker ${workerId} 僵尸检测：进程已退出 (code=${exitCode}) 但 exit 事件未触发，按 crash 走恢复重派`);
            // 合成 worker:exit(crashed)：路由到 worker:exit 处理器的 crashed 分支 →
            // recordCrash + markAgentRecovering + emit agent:crashed(recoverable)。
            // 后续真实 'exit' 事件即便再触发，handle 此时 status='crashed' 已非 active，
            // handleWorkerExit 不改写状态；worker:exit 处理器见 AgentHandle 已 stopped
            // (markAgentRecovering→forceStopAgent) early-return，不重复恢复。
            this.emit('worker:exit', workerId, exitCode, null, 'crashed');
            continue;
          }
        } catch {
          // exitCode 访问失败，继续心跳检查
        }

        const elapsed = now - handle.lastHeartbeat;
        if (elapsed > this.options.heartbeatTimeoutMs) {
          const stderrTail = handle.recentStderr.slice(-5).join('\n').trim();
          const stdoutTail = handle.recentStdout.slice(-5).join('\n').trim();
          coreLogger.warn(`Worker ${workerId} heartbeat timeout: elapsed=${elapsed}ms timeout=${this.options.heartbeatTimeoutMs}ms lastHeartbeat=${new Date(handle.lastHeartbeat).toISOString()} status=${handle.status}${stderrTail ? ` stderrTail=${stderrTail}` : ''}${stdoutTail ? ` stdoutTail=${stdoutTail}` : ''}`);
          this.markWorkerTimeout(workerId, 'heartbeat_timeout', `heartbeat timeout after ${elapsed}ms`);
          this.killWorker(workerId, 'heartbeat timeout');
        }

        // 检查最大运行时间
        const runtime = now - handle.startTime;
        if (runtime > this.options.maxRuntimeMs) {
          coreLogger.warn(`Worker ${workerId} max runtime exceeded`);
          this.markWorkerTimeout(workerId, 'max_runtime', `max runtime exceeded after ${runtime}ms`);
          this.killWorker(workerId, 'max runtime exceeded');
        }
      }
    }, this.options.heartbeatMonitorIntervalMs);
    // Don't let heartbeat monitor keep the process alive during shutdown
    if (this.heartbeatInterval.unref) this.heartbeatInterval.unref();
  }

  /**
   * 定期清理 SIGKILL 后遗留的 payload 文件
   */
  private startPayloadCleanup(): void {
    this.payloadCleanupInterval = setInterval(() => {
      this.cleanupStalePayloadFiles();
    }, 10 * 60 * 1000); // 10 分钟
    if (this.payloadCleanupInterval.unref) this.payloadCleanupInterval.unref();
  }

  private cleanupStalePayloadFiles(): void {
    const dir = join(tmpdir(), 'lingxiao', 'worker_payloads');
    if (!existsSync(dir)) return;
    const now = Date.now();
    try {
      for (const file of readdirSync(dir)) {
        const filePath = join(dir, file);
        try {
          const stat = statSync(filePath);
          if (now - stat.mtimeMs > 60 * 60 * 1000) { // 超过 1h
            unlinkSync(filePath);
          }
        } catch {
          // 单文件清理失败不影响其他文件
        }
      }
    } catch {
      // 目录读取失败不崩溃
    }
  }

  /**
   * 终止指定 Worker
   */
  killWorker(workerId: string, reason: string): boolean {
    const handle = this.workers.get(workerId);
    if (!handle) return false;

    coreLogger.warn(`Killing worker ${workerId}: ${reason}`);

    try {
      if (handle.process.pid) {
        void killProcess(handle.process.pid, 'SIGTERM', { tree: true });
      } else {
        handle.process.kill('SIGTERM');
      }

      // 优雅关闭超时后强制终止 — unref so it doesn't keep process alive
      const existingKillTimer = this.killTimers.get(workerId);
      if (existingKillTimer) {
        clearTimeout(existingKillTimer);
      }
      const killTimer = setTimeout(() => {
        this.killTimers.delete(workerId);
        const currentHandle = this.workers.get(workerId);
        if (!currentHandle || currentHandle.endTime) {
          return;
        }

        try {
          if (currentHandle.process.pid) {
            void killProcess(currentHandle.process.pid, 'SIGKILL', { tree: true });
          } else {
            currentHandle.process.kill('SIGKILL');
          }
        } catch {
          // 忽略二次终止失败
        }
      }, 5000);
      if (killTimer.unref) killTimer.unref();
      this.killTimers.set(workerId, killTimer);

      return true;
    } catch (error) {
      console.error(`[WorkerProcessRunner] Failed to kill worker ${workerId}:`, error);
      return false;
    }
  }

  /**
   * 终止所有 Worker
   */
  killAllWorkers(reason: string): void {
    for (const workerId of this.workers.keys()) {
      this.killWorker(workerId, reason);
    }
  }

  sendToWorker(workerId: string, message: WorkerParentMessage): boolean {
    const handle = this.workers.get(workerId);
    if (!handle || !handle.process.connected || typeof handle.process.send !== 'function') {
      return false;
    }

    try {
      handle.process.send(message as unknown as Serializable);
      return true;
    } catch (error) {
      console.error(`[WorkerProcessRunner] Failed to send message to worker ${workerId}:`, error);
      return false;
    }
  }

  /**
   * 等待指定 worker 进程退出（respawn 前确认上一代已真正死亡，避免新旧同名进程短暂并存）。
   *
   * - worker 未被跟踪（不在 map）→ 已彻底回收，立即 resolve。
   * - handle.endTime 已置位 → 'exit' 事件已触发、进程已死，立即 resolve。
   * - 否则进程仍存活：监听一次性 'worker:exit'（匹配 workerId），或超时 timeoutMs 后强制 resolve。
   *
   * 超时后 resolve 而非 reject：调用方（respawnAgent）超时仍可继续，由后续 spawnWorker
   * 的同名复用路径兜底（旧进程若仍未退则 SIGKILL 收尸）。
   */
  async awaitWorkerExit(workerId: string, timeoutMs = 3000): Promise<void> {
    const handle = this.workers.get(workerId);
    if (!handle || handle.endTime !== undefined) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const onExit = (exitedId: string) => {
        if (exitedId !== workerId) return;
        if (timer) clearTimeout(timer);
        this.off('worker:exit', onExit);
        resolve();
      };
      timer = setTimeout(() => {
        this.off('worker:exit', onExit);
        resolve();
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.on('worker:exit', onExit);
    });
  }

  /**
   * 获取 Worker 状态
   */
  getWorker(workerId: string): WorkerHandle | undefined {
    return this.workers.get(workerId);
  }

  /**
   * 获取 Worker 最近退出/失败诊断。
   *
   * AgentPool/TUI/Web/Leader 都走这一份事实源，避免只显示
   * "process crashed" 却丢失 exit code、signal 和 stderr tail。
   */
  getWorkerDiagnostics(workerId: string): WorkerProcessDiagnostics | undefined {
    const handle = this.workers.get(workerId);
    if (!handle) return undefined;
    return this.buildWorkerDiagnostics(workerId, handle);
  }

  /**
   * 获取所有 Worker
   */
  getAllWorkers(): WorkerHandle[] {
    return Array.from(this.workers.values());
  }

  /**
   * 获取运行中的 Worker
   */
  getRunningWorkers(): WorkerHandle[] {
    return Array.from(this.workers.values()).filter(w => isCoreWorkerActiveStatus(w.status));
  }

  /**
   * 写入 Payload 文件
   */
  private writePayloadFile(payload: WorkerTaskPayload): string {
    const payloadDir = join(tmpdir(), 'lingxiao', 'worker_payloads');
    try {
      mkdirSync(payloadDir, { recursive: true });
    } catch {
      // 目录可能已存在或权限问题，继续尝试写入
    }

    const payloadPath = join(payloadDir, `${payload.agentName}_${Date.now()}.json`);
    try {
      writeFileSync(payloadPath, JSON.stringify(payload), 'utf-8');
    } catch (err) {
      throw new Error(t('error.worker_write_failed', payloadPath, err instanceof Error ? err.message : String(err)));
    }
    return payloadPath;
  }

  /**
   * 清理 Payload 文件
   */
  private cleanupPayloadFile(workerId: string): void {
    try {
      const payloadPath = this.workers.get(workerId)?.payloadPath;
      if (payloadPath && existsSync(payloadPath)) {
        unlinkSync(payloadPath);
      }
    } catch {
      // 忽略清理错误
    }
  }

  /**
   * 销毁 Runner
   */
  destroy(): void {
    this.shutdown = true;
    this.killAllWorkers('runner destroyed');
    for (const handle of this.workers.values()) {
      try {
        if (handle.process.pid) {
          void killProcess(handle.process.pid, 'SIGKILL', { tree: true });
        } else {
          handle.process.kill('SIGKILL');
        }
      } catch {
        // 进程可能已退出，忽略
      }
    }
    for (const timer of this.killTimers.values()) {
      clearTimeout(timer);
    }
    this.killTimers.clear();
    for (const [workerId, handle] of this.workers.entries()) {
      if (handle.cleanupTimer) {
        clearTimeout(handle.cleanupTimer);
        handle.cleanupTimer = undefined;
      }
      if (handle.process.pid) {
        unregisterProtectedPid(handle.process.pid);
        PidRegistry.unregister(handle.process.pid);
      }
      this.cleanupPayloadFile(workerId);
      handle.process.removeAllListeners();
    }
    this.workers.clear();
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.payloadCleanupInterval) {
      clearInterval(this.payloadCleanupInterval);
      this.payloadCleanupInterval = undefined;
    }
    this.ipcQueue.destroy();
    this.removeAllListeners();
  }

  /**
   * 扫描并终止孤儿 Worker 进程（父进程崩溃后遗留的子进程）。
   *
   * 实现策略（跨平台，确定性，无启发式）：
   *   1. 主路径 —— 枚举持久化注册表（PidRegistry）中所有 worker 条目。
   *      - 指定 sessionId（会话收尾）：清掉该会话的全部残留 worker。
   *      - 未指定 sessionId（启动 / 全局孤儿回收）：仅回收 isOrphanedEntry 判定为真孤儿
   *        的 worker —— 即派生它的父进程已死。绝不误杀当前 daemon 仍在管理的活 worker。
   *      注册表在每个平台都可用，不再依赖 /proc。
   *   2. Linux 补充网 —— 旧版本遗留、无注册表条目的孤儿仍可通过 /proc environ 标记兜底回收
   *      （新 spawn 的 worker 已在注册表内，由主路径处理，补充网会跳过它们，避免重复计数）。
   *
   * @param sessionId 如果指定，只清理该 session 的 Worker；否则只清理真孤儿
   * @returns 清理的进程数
   */
  static async killOrphanWorkers(sessionId?: string): Promise<number> {
    let cleaned = 0;

    // 主路径：持久化注册表，全平台可用。
    try {
      const candidates = PidRegistry.listAll().filter(e => e.kind === 'worker');
      for (const entry of candidates) {
        if (sessionId) {
          if (entry.sessionId !== sessionId) continue;
        } else if (!isOrphanedEntry(entry)) {
          // 无 sessionId 维度：仅回收真孤儿，保护当前 daemon 的活 worker。
          continue;
        }
        try {
          await killProcess(entry.pid, 'SIGTERM', { tree: true });
          cleaned++;
          PidRegistry.unregister(entry.pid);
          coreLogger.info(`[WorkerProcessRunner] Sent SIGTERM to orphan worker PID ${entry.pid} (session=${entry.sessionId})`);
        } catch {
          // 进程可能已退出
        }
      }
    } catch (error) {
      coreLogger.warn(`[WorkerProcessRunner] Registry orphan scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Linux 补充网：回收旧版本遗留、未进注册表的孤儿 worker。
    if (platform() === 'linux') {
      cleaned += await WorkerProcessRunner.scanProcForOrphanWorkers(sessionId);
    }

    return cleaned;
  }

  /**
   * Linux /proc 兜底扫描：找出 environ 中带 LINGXIAO_WORKER_ID 但不在注册表内的进程
   * （旧版本遗留孤儿）。已在注册表内的 worker 由主路径处理，这里跳过避免重复计数/误杀。
   */
  private static async scanProcForOrphanWorkers(sessionId?: string): Promise<number> {
    let cleaned = 0;
    try {
      const pids = readdirSync('/proc').filter(d => /^\d+$/.test(d));
      for (const pid of pids) {
        try {
          const envPath = `/proc/${pid}/environ`;
          if (!existsSync(envPath)) continue;
          const envContent = readFileSync(envPath, 'utf-8');
          if (!envContent.includes('LINGXIAO_WORKER_ID=')) continue;
          if (sessionId) {
            const sessionMatch = envContent.match(/LINGXIAO_WORKER_SESSION=([^\x00]+)/);
            if (sessionMatch && sessionMatch[1] !== sessionId) continue;
          }
          const pidNum = parseInt(pid, 10);
          // 已被注册表管辖 → 交主路径处理，避免重复。
          if (PidRegistry.findByPid(pidNum)) continue;
          try {
            await killProcess(pidNum, 'SIGTERM', { tree: true });
            cleaned++;
            coreLogger.info(`[WorkerProcessRunner] /proc fallback: Sent SIGTERM to legacy orphan worker PID ${pidNum}`);
          } catch {
            // 进程可能已退出
          }
        } catch {
          // /proc/<pid>/environ 可能无权限读取，跳过
        }
      }
    } catch (error) {
      coreLogger.warn(`[WorkerProcessRunner] /proc fallback scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return cleaned;
  }

  private appendRecentOutput(buffer: string[], chunk: string): void {
    const normalized = chunk.trim();
    if (!normalized) {
      return;
    }

    buffer.push(normalized);
    if (buffer.length > 20) {
      buffer.splice(0, buffer.length - 20);
    }
  }

  private describeWorkerError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
    return 'reported an unknown startup error';
  }

  private createStartupError(workerId: string, reason: string): Error {
    const handle = this.workers.get(workerId);
    const recentStderr = handle?.recentStderr.join('\n').trim();
    const recentStdout = handle?.recentStdout.join('\n').trim();
    const details = [reason];

    if (recentStderr) {
      details.push(`stderr: ${recentStderr}`);
    } else if (recentStdout) {
      details.push(`stdout: ${recentStdout}`);
    }

    return new Error(`Worker ${workerId} ${details.join(' | ')}`);
  }

  private buildWorkerDiagnostics(workerId: string, handle: WorkerHandle): WorkerProcessDiagnostics {
    return {
      workerId,
      agentId: handle.agentId,
      agentName: handle.agentName,
      taskId: handle.taskId,
      pid: handle.process.pid,
      status: handle.status,
      exitCode: handle.exitCode,
      exitSignal: handle.process.signalCode,
      timeoutReason: handle.timeoutReason,
      error: handle.error?.message,
      stderrTail: handle.recentStderr.slice(-5),
      stdoutTail: handle.recentStdout.slice(-5),
      startTime: handle.startTime,
      endTime: handle.endTime,
      lastHeartbeat: handle.lastHeartbeat,
    };
  }

  private extractCompletionResult(payload: unknown): string {
    if (
      payload &&
      typeof payload === 'object' &&
      'result' in payload &&
      typeof (payload as WorkerCompletionPayload).result === 'string'
    ) {
      return (payload as WorkerCompletionPayload).result;
    }
    return String(payload ?? '');
  }
}

export default WorkerProcessRunner;
