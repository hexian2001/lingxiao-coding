import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import type { WriteStream } from 'fs';
import { join } from 'path';
import type { EventEmitter } from '../../core/EventEmitter.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { DatabaseManager } from '../../core/Database.js';
import type { TokenTracker } from '../BaseAgentRuntime.js';
import type { Task as BoardTask, TaskBoard } from '../../core/TaskBoard.js';
import type { AgentRole } from '../RoleRegistry.js';
import type { RecoveryFaultClass } from '../../core/RecoveryRecords.js';
import type { AgentHandle } from '../AgentPoolRuntime.js';
import type { StructuredCompletionPayload } from '../pool/AgentPoolCompletionPayload.js';
import { PidRegistry } from '../../core/PidRegistry.js';
import { agentLogger } from '../../core/Log.js';
import { buildLocalLlmGatewayEnv } from '../../core/LocalLlmGateway.js';
import { withToolProxyEnv } from '../../core/ProxyConfig.js';
import { t } from '../../i18n.js';
import { hiddenSpawnOpts, killProcess, readProcessStartMs } from '../../utils/platform.js';
import { createLineReader } from './lineReader.js';
import type { ExternalAgentInput, ExternalAgentProcessHandle, ExternalArtifactTrace, ExternalDriver, ExternalEvent, ExternalRunResult } from './types.js';
import { isCoreExternalAgentActiveStatus, isCoreExternalAgentTerminalStatus, type CoreExternalAgentStatus } from '../../contracts/adapters/StatusAdapter.js';
import { assertExternalAgentAvailable } from './availability.js';
import { buildExternalPrompt } from './promptBuilder.js';
import { parseExternalCompletionReport, type ExternalCompletionReport } from './completionReport.js';
import { resolveExternalModel } from './modelResolver.js';
import { ClaudeCodeDriver } from './drivers/ClaudeCodeDriver.js';
import { CodexDriver } from './drivers/CodexDriver.js';
import type { ExternalBackend } from './types.js';
import type { WorkerTaskPayload } from '../../core/WorkerProcessRunner.js';
import { createTaskCompletePayload } from '../../core/AgentProtocol.js';
import type { WorkerFailureDiagnostics } from '../../core/AgentProtocol.js';
import { emitAgentSpawned as emitAgentSpawnedEvent } from '../pool/AgentPoolEvents.js';

export interface ExternalAgentRunnerDeps {
  emitter: EventEmitter;
  bus: MessageBus;
  db: DatabaseManager;
  sessionId: string;
  leaderBusName: string;
  sp: (name: string) => string;
  tokenTracker: TokenTracker;
  onHandle?: (handle: ExternalAgentProcessHandle) => void;
}

function appendTail(buffer: string[], line: string, limit = 20): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  buffer.push(trimmed);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
}

function redact(value: string, secrets: string[]): string {
  let next = value;
  for (const secret of secrets) {
    if (secret) next = next.split(secret).join('[REDACTED]');
  }
  return next;
}

function safeClose(stream: WriteStream | undefined): void {
  try {
    stream?.end();
  } catch {
    // ignore
  }
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function getStringField(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function getStringListField(value: unknown, keys: string[]): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const out: string[] = [];
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      out.push(candidate.trim());
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === 'string' && item.trim()) out.push(item.trim());
      }
    }
  }
  return uniqueStrings(out);
}

function extractPathsFromPatchSummary(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const matches = [...text.matchAll(/(?:^|\n)(?:\s*(?:M|A|D)\s+|(?:\+\+\+|---)\s+(?:a\/|b\/)?)([^\n\r\t]+)/g)];
  return uniqueStrings(matches.map((match) => match[1]?.trim()).filter((item): item is string => Boolean(item)));
}

class ExternalToolTraceCollector {
  private readonly calls = new Map<string, { name: string; input?: unknown }>();
  private readonly filesCreated = new Set<string>();
  private readonly filesModified = new Set<string>();
  private readonly commandsRun: string[] = [];

  recordCall(event: Extract<ExternalEvent, { kind: 'tool_call' }>): void {
    this.calls.set(event.toolCallId, { name: event.name, input: event.input });
    this.recordCommand(event.name, event.input);
  }

  recordResult(event: Extract<ExternalEvent, { kind: 'tool_result' }>): void {
    if (event.isError) return;
    const call = this.calls.get(event.toolCallId);
    const toolName = event.tool || call?.name || '';
    this.recordFileMutation(toolName, call?.input, event.output);
  }

  snapshot(): Required<ExternalArtifactTrace> {
    const created = uniqueStrings(this.filesCreated);
    const createdSet = new Set(created);
    const modified = uniqueStrings(this.filesModified).filter((file) => !createdSet.has(file));
    return {
      files_created: created,
      files_modified: modified,
      commands_run: uniqueStrings(this.commandsRun),
    };
  }

  private recordCommand(toolName: string, input: unknown): void {
    const normalized = toolName.toLowerCase();
    if (!['shell', 'bash', 'exec', 'exec_command'].includes(normalized)) return;
    const command = getStringField(input, ['command', 'cmd', 'script']);
    if (command) {
      this.commandsRun.push(command);
    }
  }

  private recordFileMutation(toolName: string, input: unknown, output: unknown): void {
    const normalized = toolName.toLowerCase();
    if (['write', 'create', 'file_create', 'write_file'].includes(normalized)) {
      for (const path of getStringListField(input, ['file_path', 'path', 'filename'])) {
        this.filesCreated.add(path);
      }
      return;
    }
    if (['edit', 'multiedit', 'structured_patch', 'apply_patch', 'patch'].includes(normalized)) {
      for (const path of [
        ...getStringListField(input, ['file_path', 'path', 'filename', 'files']),
        ...extractPathsFromPatchSummary(output),
      ]) {
        this.filesModified.add(path);
      }
    }
  }
}

/** Mutable context shared across the private helpers during a single run(). */
interface RunContext {
  input: ExternalAgentInput;
  plan: ReturnType<ExternalDriver['buildExecute']>;
  child: ChildProcess;
  handle: ExternalAgentProcessHandle;
  stdoutLogPath: string;
  stderrLogPath: string;
  stdoutLog: WriteStream;
  stderrLog: WriteStream;
  secrets: string[];
  events: ExternalEvent[];
  toolTrace: ExternalToolTraceCollector;
  tokenUsage: ExternalRunResult['tokenUsage'];
}

export class ExternalAgentRunner {
  constructor(
    private readonly driver: ExternalDriver,
    private readonly deps: ExternalAgentRunnerDeps,
  ) {}

  async run(input: ExternalAgentInput): Promise<ExternalRunResult> {
    const ctx = this.spawnProcess(input);
    this.feedStdin(ctx);
    this.setupStreamHandlers(ctx);
    const { timeoutTimer, idleTimer } = this.setupTimers(ctx);
    return this.handleProcessCompletion(ctx, timeoutTimer, idleTimer);
  }

  // --- private helpers ---

  private spawnProcess(input: ExternalAgentInput): RunContext {
    const plan = this.driver.buildExecute(input);
    mkdirSync(input.logDir, { recursive: true });
    const stdoutLogPath = join(input.logDir, `${input.agentId}.stdout.jsonl`);
    const stderrLogPath = join(input.logDir, `${input.agentId}.stderr.log`);
    const stdoutLog = createWriteStream(stdoutLogPath, { flags: 'a' });
    const stderrLog = createWriteStream(stderrLogPath, { flags: 'a' });
    const secrets = [input.model.apiKey, ...(Object.values(input.extraEnv || {}))];
    const inheritedEnv = withToolProxyEnv({
      ...process.env,
      ...plan.env,
      ...input.extraEnv,
    });
    const gatewayEnv = buildLocalLlmGatewayEnv(inheritedEnv);

    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: {
        ...inheritedEnv,
        ...gatewayEnv,
        LINGXIAO_EXTERNAL_AGENT_SESSION: input.sessionId,
        LINGXIAO_EXTERNAL_AGENT_ID: input.agentId,
        LINGXIAO_EXTERNAL_AGENT_NAME: input.agentName,
        LINGXIAO_EXTERNAL_AGENT_BACKEND: this.driver.type,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      ...hiddenSpawnOpts(),
    });

    const handle: ExternalAgentProcessHandle = {
      agentId: input.agentId,
      agentName: input.agentName,
      taskId: input.taskId,
      backend: this.driver.type,
      process: child,
      startTime: Date.now(),
      status: 'starting',
      externalSessionId: plan.sessionIdHint,
      pid: child.pid,
      logPath: stdoutLogPath,
      stderrLogPath,
      lastEventAt: Date.now(),
      recentStdoutTail: [],
      recentStderrTail: [],
    };
    this.deps.onHandle?.(handle);

    if (child.pid) {
      PidRegistry.register({
        pid: child.pid,
        sessionId: input.sessionId,
        cwd: input.workingDirectory,
        startedAt: Date.now(),
        kind: 'external-agent',
        name: input.agentName,
        logPath: stdoutLogPath,
        agentId: input.agentId,
        agentName: input.agentName,
        backend: this.driver.type,
        taskId: input.taskId,
        externalSessionId: handle.externalSessionId,
        // 记录父进程，供 killExternalAgentOrphans 在无 sessionId 维度判定真孤儿（跨平台）。
        parentPid: process.pid,
        parentStartedAt: readProcessStartMs(process.pid) ?? Date.now(),
      });
    }

    return {
      input,
      plan,
      child,
      handle,
      stdoutLogPath,
      stderrLogPath,
      stdoutLog,
      stderrLog,
      secrets,
      events: [],
      toolTrace: new ExternalToolTraceCollector(),
      tokenUsage: undefined,
    };
  }

  private feedStdin(ctx: RunContext): void {
    try {
      ctx.child.stdin?.write(ctx.plan.stdin);
      ctx.child.stdin?.end();
    } catch (error) {
      ctx.handle.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  private terminateChild(ctx: RunContext, status: Extract<CoreExternalAgentStatus, 'terminated' | 'timeout'>, reason: string): boolean {
    const { handle, child } = ctx;
    if (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'crashed') return false;
    handle.status = status;
    handle.error = new Error(reason);
    try {
      if (child.pid) {
        void killProcess(child.pid, undefined, { tree: true, graceMs: 5_000 });
      } else {
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          if (!child.killed && child.exitCode === null) {
            try { child.kill('SIGKILL'); } catch {/* expected: process may already be dead */}
          }
        }, 5_000);
        killTimer.unref?.();
      }
      return true;
    } catch {/* expected: operation may fail */
      return false;
    }
  }

  private handleExternalEvent(ctx: RunContext, event: ExternalEvent): void {
    const { input, handle, child } = ctx;
    ctx.events.push(event);
    handle.lastEventAt = Date.now();
    switch (event.kind) {
      case 'started':
        handle.status = 'running';
        handle.externalSessionId = event.sessionId;
        this.deps.emitter.emit('agent:started', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          name: input.agentName,
          taskId: input.taskId,
          backend: this.driver.type,
          externalSessionId: event.sessionId,
          pid: child.pid,
          logPath: ctx.stdoutLogPath,
        });
        break;
      case 'status':
        this.deps.emitter.emit('agent:status', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          agentName: input.agentName,
          status: event.phase,
          backend: this.driver.type,
          externalSessionId: handle.externalSessionId,
          pid: child.pid,
        });
        break;
      case 'text_delta':
        this.deps.emitter.emit('agent:text_chunk', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          agentName: input.agentName,
          chunk: event.text,
          backend: this.driver.type,
          externalSessionId: handle.externalSessionId,
        });
        break;
      case 'text_full':
        this.deps.emitter.emit('agent:text', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          agentName: input.agentName,
          content: event.text,
          backend: this.driver.type,
          externalSessionId: handle.externalSessionId,
        });
        break;
      case 'thinking_delta':
        this.deps.emitter.emit('agent:thinking_chunk', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          agentName: input.agentName,
          chunk: event.text,
          backend: this.driver.type,
          externalSessionId: handle.externalSessionId,
        });
        break;
      case 'tool_call':
        ctx.toolTrace.recordCall(event);
        this.deps.emitter.emit('agent:tool_call', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          agentName: input.agentName,
          taskId: input.taskId,
          callId: event.toolCallId,
          tool: event.name,
          input: event.input,
          backend: this.driver.type,
          externalSessionId: handle.externalSessionId,
        });
        break;
      case 'tool_result':
        ctx.toolTrace.recordResult(event);
        this.deps.emitter.emit('agent:tool_result', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          agentName: input.agentName,
          taskId: input.taskId,
          callId: event.toolCallId,
          tool: event.tool || 'external_tool',
          result: event.output,
          error: event.isError,
          backend: this.driver.type,
          externalSessionId: handle.externalSessionId,
        });
        break;
      case 'usage':
        ctx.tokenUsage = {
          prompt: event.prompt,
          completion: event.completion,
          total: event.total,
          cache_read: event.cacheRead,
          cache_creation: event.cacheCreation,
        };
        this.deps.tokenTracker.addUsage(input.agentId, ctx.tokenUsage, input.model.id);
        break;
      case 'complete':
        handle.status = 'completed';
        handle.result = event.result;
        break;
      case 'error':
        this.deps.emitter.emit('agent:error', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          error: new Error(event.message),
          backend: this.driver.type,
          externalSessionId: handle.externalSessionId,
        });
        if (event.fatal && !handle.error) {
          handle.error = new Error(event.message);
        }
        break;
    }
  }

  private setupStreamHandlers(ctx: RunContext): void {
    const { child, secrets, stdoutLog, stderrLog, handle } = ctx;

    child.stdout && createLineReader(child.stdout).on('line', (line: string) => {
      const clean = redact(line, secrets);
      stdoutLog.write(`${clean}\n`);
      appendTail(handle.recentStdoutTail, clean);
      for (const event of this.driver.parseStdoutLine(line)) this.handleExternalEvent(ctx, event);
    });

    child.stderr && createLineReader(child.stderr).on('line', (line: string) => {
      const clean = redact(line, secrets);
      stderrLog.write(`${clean}\n`);
      appendTail(handle.recentStderrTail, clean);
      for (const event of this.driver.parseStderrLine(line)) this.handleExternalEvent(ctx, event);
    });
  }

  private setupTimers(ctx: RunContext): { timeoutTimer: ReturnType<typeof setTimeout>; idleTimer: ReturnType<typeof setInterval> } {
    const { input, handle } = ctx;

    const timeoutTimer = setTimeout(() => {
      if (!isCoreExternalAgentTerminalStatus(handle.status)) {
        this.terminateChild(ctx, 'timeout', t('external_agent.timeout', this.driver.type, input.timeoutMs));
      }
    }, input.timeoutMs);
    timeoutTimer.unref?.();

    const idleTimer = setInterval(() => {
      if (isCoreExternalAgentActiveStatus(handle.status) && Date.now() - handle.lastEventAt > input.idleTimeoutMs) {
        this.terminateChild(ctx, 'timeout', t('external_agent.idle_timeout', this.driver.type, input.idleTimeoutMs));
      }
    }, Math.min(30_000, Math.max(1000, input.idleTimeoutMs / 3)));
    idleTimer.unref?.();

    return { timeoutTimer, idleTimer };
  }

  private handleProcessCompletion(
    ctx: RunContext,
    timeoutTimer: ReturnType<typeof setTimeout>,
    idleTimer: ReturnType<typeof setInterval>,
  ): Promise<ExternalRunResult> {
    const { child, handle, stdoutLog, stderrLog, input } = ctx;

    return new Promise<ExternalRunResult>((resolve, reject) => {
      child.on('error', (error) => {
        clearTimeout(timeoutTimer);
        clearInterval(idleTimer);
        handle.status = 'failed';
        handle.error = error;
        safeClose(stdoutLog);
        safeClose(stderrLog);
        if (child.pid) PidRegistry.unregister(child.pid);
        reject(error);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        clearInterval(idleTimer);
        handle.endTime = Date.now();
        handle.exitCode = code;
        handle.exitSignal = signal;
        safeClose(stdoutLog);
        safeClose(stderrLog);
        if (child.pid) PidRegistry.unregister(child.pid);

        const result = handle.result ?? this.driver.finalizeResult(ctx.events, code, signal);
        if (handle.status === 'terminated') {
          reject(handle.error || new Error(t('external_agent.terminated', this.driver.type)));
          return;
        }
        if (handle.error && code !== 0) {
          handle.status = handle.status === 'timeout' ? 'timeout' : 'failed';
          reject(handle.error);
          return;
        }
        if (code !== 0) {
          handle.status = handle.status === 'timeout' ? 'timeout' : 'crashed';
          reject(new Error(t('external_agent.exit_nonzero', this.driver.type, code, signal || 'none', handle.recentStderrTail.slice(-3).join(' | '))));
          return;
        }
        handle.status = 'completed';
        handle.result = result;
        resolve({
          result,
          backend: this.driver.type,
          externalSessionId: handle.externalSessionId,
          pid: handle.pid,
          logPath: ctx.stdoutLogPath,
          stderrLogPath: ctx.stderrLogPath,
          stdoutTail: [...handle.recentStdoutTail],
          stderrTail: [...handle.recentStderrTail],
          tokenUsage: ctx.tokenUsage,
          toolTrace: ctx.toolTrace.snapshot(),
        });
      });
    }).finally(() => {
      agentLogger.debug(`[ExternalAgentRunner] ${this.driver.type} agent ${input.agentName} finished status=${handle.status}`);
    });
  }
}

/**
 * ExternalAgentProtocolError：完成报告未通过 worker completion 契约。
 * faultClass 固定为 'external_agent_protocol'，供恢复分类确定性判定。
 */
export class ExternalAgentProtocolError extends Error {
  readonly faultClass: RecoveryFaultClass = 'external_agent_protocol';

  constructor(reason: string | undefined, feedback: string) {
    const detail = feedback.trim() || 'completion report did not satisfy the Lingxiao worker completion contract';
    super(`external worker completion rejected${reason ? ` (${reason})` : ''}: ${detail}`);
    this.name = 'ExternalAgentProtocolError';
  }
}

function getPositiveIntFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** runExternalAgent 执行体所需的最小结构化上下文。pool 自身满足该结构。 */
export interface ExternalAgentRunContext {
  readonly sessionId: string;
  readonly workspace: string;
  readonly tracker: TokenTracker;
  readonly db: DatabaseManager;
  readonly emitter: EventEmitter;
  readonly bus: MessageBus;
  readonly taskBoard: TaskBoard;
  readonly leaderBusName: string;

  sp(name: string): string;
  transitionAgentStatus(handle: AgentHandle, newStatus: AgentHandle['status']): void;
  getTaskRunGeneration(handle: AgentHandle): number;
  emitAgentEvent<T extends string>(handle: AgentHandle, event: T, payload: Record<string, unknown>): void;
  emitInteractiveRuntimeState(handle: AgentHandle): void;
  clearRecoveryRecordAndNotify(taskId: string): void;
  scheduleHandleCleanup(name: string): void;
  buildWorkerPayload(handle: AgentHandle, task: BoardTask, role: AgentRole): Promise<WorkerTaskPayload>;
  assertExternalCompletionAccepted(
    task: BoardTask,
    role: AgentRole,
    completionReport: ExternalCompletionReport,
    modelId: string,
  ): Promise<void>;
  recordTaskResultPendingAcceptance(
    handle: AgentHandle,
    result: string,
    completionPayload: StructuredCompletionPayload,
  ): void;
  applyWorkerOutputToBlackboard(taskId: string, result: string): void;
  sendCriticalBusMessageToLeader(to: string, type: 'task_complete' | 'task_failed' | 'worker_recovery', payload: unknown): void;
  markAgentRecovering(
    handle: AgentHandle,
    faultClass: RecoveryFaultClass,
    reason: string,
    diagnostics?: WorkerFailureDiagnostics,
  ): { status: string; recoveryAction?: string };
}

/**
 * 从 AgentPool.runExternalAgent 下沉的外部 backend agent 执行体。
 * 选 driver → 构造 ExternalAgentRunner → run → 解析完成报告 → 校验 → 状态机收尾。
 * public 接口签名不变，原类方法改为薄委托。
 */
export async function runExternalAgent(
  ctx: ExternalAgentRunContext,
  handle: AgentHandle,
  role: AgentRole,
  task: BoardTask,
): Promise<string> {
  const backend = role.worker_backend as ExternalBackend;
  assertExternalAgentAvailable(backend);
  const driver = backend === 'claude' ? new ClaudeCodeDriver() : new CodexDriver();
  const payload = await ctx.buildWorkerPayload(handle, task, role);
  const model = resolveExternalModel(backend, role, payload);
  const timeoutMs = role.worker_config?.timeout_ms
    || payload.adaptiveStrategy?.params?.timeoutMs
    || getPositiveIntFromEnv('LINGXIAO_EXTERNAL_AGENTS_TIMEOUT_MS', 30 * 60 * 1000);
  const idleTimeoutMs = role.worker_config?.idle_timeout_ms || getPositiveIntFromEnv('LINGXIAO_EXTERNAL_AGENTS_IDLE_TIMEOUT_MS', 3 * 60 * 1000);
  const logDir = join(ctx.workspace, '.lingxiao', 'sessions', ctx.sessionId, 'external');

  handle.workerBackend = backend;
  handle.interactiveRuntime?.setStatus('running');
  ctx.emitInteractiveRuntimeState(handle);
  ctx.clearRecoveryRecordAndNotify(handle.taskId);
  emitAgentSpawnedEvent({ emitter: ctx.emitter, sessionId: ctx.sessionId, taskBoard: ctx.taskBoard, handle });

  const runner = new ExternalAgentRunner(driver, {
    emitter: ctx.emitter,
    bus: ctx.bus,
    db: ctx.db,
    sessionId: ctx.sessionId,
    leaderBusName: ctx.leaderBusName,
    sp: (name) => ctx.sp(name),
    tokenTracker: ctx.tracker,
    onHandle: (externalHandle: ExternalAgentProcessHandle) => {
      handle.externalPid = externalHandle.pid;
      handle.externalSessionId = externalHandle.externalSessionId;
      handle.externalDiagnostics = {
        logPath: externalHandle.logPath,
        stderrLogPath: externalHandle.stderrLogPath,
        stderrTail: externalHandle.recentStderrTail,
        stdoutTail: externalHandle.recentStdoutTail,
        lastEventAt: externalHandle.lastEventAt,
      };
      handle.externalStop = (reason: string) => {
        try {
          if (externalHandle.pid) {
            void killProcess(externalHandle.pid, undefined, { tree: true, graceMs: 5_000 });
          } else {
            externalHandle.process.kill('SIGTERM');
            const killTimer = setTimeout(() => {
              if (externalHandle.process.exitCode === null) {
                try { externalHandle.process.kill('SIGKILL'); } catch {/* expected: process may already be dead */}
              }
            }, 5_000);
            killTimer.unref?.();
          }
          return true;
        } catch {/* expected: operation may fail */
          return false;
        }
      };
    },
  });

  try {
    ctx.transitionAgentStatus(handle, 'running');
    const result = await runner.run({
      agentId: handle.agentId,
      agentName: handle.name,
      sessionId: ctx.sessionId,
      taskId: task.id,
      prompt: buildExternalPrompt(payload),
      systemPrompt: payload.systemPrompt,
      workingDirectory: payload.workingDirectory,
      workspace: ctx.workspace,
      writeScope: payload.writeScope,
      model,
      timeoutMs,
      idleTimeoutMs,
      extraArgs: role.worker_config?.extra_args,
      extraEnv: role.worker_config?.env,
      logDir,
    });

    handle.externalSessionId = result.externalSessionId;
    handle.externalPid = result.pid;
    handle.externalDiagnostics = {
      logPath: result.logPath,
      stderrLogPath: result.stderrLogPath,
      stderrTail: result.stderrTail,
      stdoutTail: result.stdoutTail,
      lastEventAt: Date.now(),
    };
    handle.externalStop = undefined;

    const completionReport = parseExternalCompletionReport(result.result);
    await ctx.assertExternalCompletionAccepted(task, role, completionReport, model.id || model.apiModel);

    ctx.transitionAgentStatus(handle, 'stopped');
    handle.exitReason = 'completed';
    handle.endTime = Date.now();
    handle.interactiveRuntime?.setStatus('completed');
    handle.interactiveRuntime?.clearQueuedMessages();
    handle.interactiveRuntime?.clearAllToolOutputs();
    ctx.emitInteractiveRuntimeState(handle);

    const completionPayload: StructuredCompletionPayload = {
      summary: completionReport.summary || `${backend} external worker completed ${task.id}`,
      ...(completionReport.verdict ? { verdict: completionReport.verdict } : {}),
      ...(completionReport.artifacts ? { artifacts: completionReport.artifacts } : {}),
      ...(completionReport.verification ? { verification: completionReport.verification } : {}),
      ...(completionReport.next_steps ? { next_steps: completionReport.next_steps } : {}),
      ...(completionReport.blocked_by_discovery ? { blocked_by_discovery: completionReport.blocked_by_discovery } : {}),
      ...(completionReport.needs_leader_coordination ? { needs_leader_coordination: completionReport.needs_leader_coordination } : {}),
      ...(completionReport.evidence_refs ? { evidence_refs: completionReport.evidence_refs } : {}),
      ...(completionReport.contract_compliance ? { contract_compliance: completionReport.contract_compliance } : {}),
      ...(result.toolTrace ? { toolTrace: result.toolTrace } : {}),
      ...(completionReport.speculativeWinner ? { speculativeWinner: completionReport.speculativeWinner } : {}),
      taskRunGeneration: ctx.getTaskRunGeneration(handle),
    };
    ctx.recordTaskResultPendingAcceptance(handle, completionReport.result, completionPayload);
    ctx.clearRecoveryRecordAndNotify(handle.taskId);
    ctx.applyWorkerOutputToBlackboard(handle.taskId, completionReport.result);
    ctx.sendCriticalBusMessageToLeader(ctx.sp(handle.name), 'task_complete', createTaskCompletePayload(handle.taskId, completionReport.result, completionPayload));
    ctx.emitAgentEvent(handle, 'agent:completed', {
      result: completionReport.result,
      stats: { iterations: 1, toolCalls: 0 },
      tokenUsage: result.tokenUsage,
      backend,
      externalSessionId: result.externalSessionId,
      pid: result.pid,
      logPath: result.logPath,
    });
    ctx.scheduleHandleCleanup(handle.name);
    return completionReport.result;
  } catch (error) {
    const runtimeError = error instanceof Error ? error : new Error(String(error));
    const message = runtimeError.message;
    const faultClass: RecoveryFaultClass = runtimeError instanceof ExternalAgentProtocolError
      ? runtimeError.faultClass
      : /timeout/i.test(message)
        ? 'external_agent_timeout'
        : /api key|unauthorized|forbidden|auth/i.test(message)
          ? 'external_agent_auth'
          : /model|配置|baseurl|enoent|not found/i.test(message)
            ? 'external_agent_config'
            : 'external_agent_crashed';
    handle.externalDiagnostics = {
      ...handle.externalDiagnostics,
      stderrTail: handle.externalDiagnostics?.stderrTail,
      stdoutTail: handle.externalDiagnostics?.stdoutTail,
    };
    const recovery = ctx.markAgentRecovering(handle, faultClass, message);
    ctx.emitAgentEvent(handle, 'agent:failed', {
      error: message,
      source: 'external_agent',
      backend,
      externalSessionId: handle.externalSessionId,
      pid: handle.externalPid,
      logPath: handle.externalDiagnostics?.logPath,
      recoverable: recovery.status === 'recovering',
      recoveryAction: recovery.recoveryAction,
      stderrTail: handle.externalDiagnostics?.stderrTail,
      stdoutTail: handle.externalDiagnostics?.stdoutTail,
    });
    throw runtimeError;
  }
}
