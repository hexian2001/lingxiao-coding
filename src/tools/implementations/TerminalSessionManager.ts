/**
 * TerminalSessionManager — 后台终端会话管理器
 *
 * 管理所有后台终端会话的生命周期，包括：
 * - 创建/注册/完成/移除会话
 * - 查询会话状态和输出
 * - 控制会话 (kill/suspend/resume/write)
 * - 孤儿会话清理
 *
 * 设计参考 qwen-code 的 ShellExecutionService，但采用实例化设计以支持多 worker 进程。
 */

import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type { EventEmitter } from '../../core/EventEmitter.js';
import { isTerminalSessionActiveStatus, normalizeTerminalSessionStatus } from '../../core/StateSemantics.js';
import { killProcess, processExists, sendProcessSignal, supportsProcessSuspendResume } from '../../utils/platform.js';
import { TERMINAL } from '../../config/defaults.js';

export type TerminalSessionStatus =
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'killed';

export type TerminalStateEventStatus = TerminalSessionStatus | 'started' | 'resumed';

interface DisposableHandle {
  dispose?: () => void;
}

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtyProcessHandle {
  pid?: number;
  onData(listener: (data: string) => void): DisposableHandle | void;
  onExit(listener: (event: PtyExitEvent) => void): DisposableHandle | void;
  write?: (input: string) => void;
  resize?: (cols: number, rows: number) => void;
  kill?: (signal?: NodeJS.Signals | string) => void;
}

export interface HeadlessTerminalHandle {
  write: (data: string) => void;
  resize?: (cols: number, rows: number) => void;
  dispose?: () => void;
}

export interface TerminalSession {
  terminalId: string;
  pid?: number;
  command: string;
  cwd: string;
  isBackground: boolean;
  status: TerminalSessionStatus;
  exitCode: number | null;
  exitSignal: string | null;

  // Output accumulation
  stdout: string;
  stderr: string;
  outputUpdatedAt: number;

  // Metadata
  agentId?: string;
  agentName?: string;
  taskId?: string;
  callId?: string;
  sessionId?: string;
  startedAt: number;
  completedAt?: number;

  // Process handles (not serialized)
  childProcess?: ChildProcess;
  ptyProcess?: PtyProcessHandle; // IPty-compatible handle from node-pty/@lydell/node-pty
  headlessTerminal?: HeadlessTerminalHandle; // Terminal-compatible handle from @xterm/headless

  // Listener cleanup references
  childListeners?: {
    onStdout?: (data: Buffer) => void;
    onStderr?: (data: Buffer) => void;
    onClose?: (code: number | null, signal: NodeJS.Signals | null) => void;
    onError?: (err: Error) => void;
  };
  ptyListeners?: {
    onData?: (data: string) => void;
    onExit?: (e: PtyExitEvent) => void;
    onDataDisposable?: DisposableHandle;
    onExitDisposable?: DisposableHandle;
  };

  // Sandbox context
  sandboxMode?: string;
  networkMode?: string;
  networkEnforced?: boolean;
  networkIsolation?: string;
}

export interface CreateSessionParams {
  command: string;
  cwd: string;
  isBackground: boolean;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  callId?: string;
  sessionId?: string;
  sandboxMode?: string;
  networkMode?: string;
  networkEnforced?: boolean;
  networkIsolation?: string;
}

export class TerminalSessionManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private emitter?: EventEmitter;
  private orphanCheckInterval?: ReturnType<typeof setInterval>;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  /**
   * 设置事件发射器
   */
  setEmitter(emitter: EventEmitter): void {
    this.emitter = emitter;
  }

  /**
   * 启动定期清理任务
   */
  startCleanup(): void {
    this.orphanCheckInterval = setInterval(
      () => this.cleanupOrphaned(),
      TERMINAL.ORPHAN_CHECK_INTERVAL_MS,
    );
    this.cleanupInterval = setInterval(
      () => this.removeExpiredSessions(),
      TERMINAL.ORPHAN_CHECK_INTERVAL_MS,
    );
  }

  /**
   * 停止定期清理任务
   */
  stopCleanup(): void {
    if (this.orphanCheckInterval) {
      clearInterval(this.orphanCheckInterval);
      this.orphanCheckInterval = undefined;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  // ── 生命周期 ──

  /**
   * 创建新的终端会话
   */
  createSession(params: CreateSessionParams): TerminalSession {
    // 检查最大会话数
    const activeCount = this.getAllActiveSessions().length;
    if (activeCount >= TERMINAL.MAX_SESSIONS) {
      throw new Error(
        `后台终端会话已达上限 (${TERMINAL.MAX_SESSIONS})，请先关闭不需要的会话`,
      );
    }

    const session: TerminalSession = {
      terminalId: randomUUID(),
      pid: undefined,
      command: params.command,
      cwd: params.cwd,
      isBackground: params.isBackground,
      status: 'running',
      exitCode: null,
      exitSignal: null,
      stdout: '',
      stderr: '',
      outputUpdatedAt: Date.now(),
      agentId: params.agentId,
      agentName: params.agentName,
      taskId: params.taskId,
      callId: params.callId,
      sessionId: params.sessionId,
      startedAt: Date.now(),
      sandboxMode: params.sandboxMode,
      networkMode: params.networkMode,
      networkEnforced: params.networkEnforced,
      networkIsolation: params.networkIsolation,
    };

    this.sessions.set(session.terminalId, session);
    this.emitState(session, 'started');
    return session;
  }

  /**
   * 注册子进程到会话
   */
  registerProcess(terminalId: string, child: ChildProcess): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    session.childProcess = child;
    session.pid = child.pid ?? undefined;

    // 监听输出（存储引用用于清理）
    const onStdout = (data: Buffer) => {
      const chunk = data.toString('utf-8');
      this.appendOutput(terminalId, chunk, 'stdout');
    };
    const onStderr = (data: Buffer) => {
      const chunk = data.toString('utf-8');
      this.appendOutput(terminalId, chunk, 'stderr');
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      this.completeSession(terminalId, code, signal);
    };
    const onError = () => {
      this.completeSession(terminalId, 1, undefined);
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('close', onClose);
    child.on('error', onError);

    session.childListeners = { onStdout, onStderr, onClose, onError };
  }

  /**
   * 注册 PTY 进程到会话
   */
  registerPtyProcess(
    terminalId: string,
    ptyProcess: PtyProcessHandle,
    headlessTerminal?: HeadlessTerminalHandle,
  ): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    session.ptyProcess = ptyProcess;
    session.headlessTerminal = headlessTerminal;
    session.pid = ptyProcess.pid;

    // 监听 PTY 输出（存储引用用于清理）
    const onData = (data: string) => {
      this.appendOutput(terminalId, data, 'stdout');
      // 写入 headless terminal 用于渲染
      if (headlessTerminal) {
        headlessTerminal.write(data);
      }
    };
    const onExit = ({ exitCode, signal }: PtyExitEvent) => {
      this.completeSession(terminalId, exitCode, signal ? String(signal) : null);
    };

    const onDataDisposable = ptyProcess.onData(onData) ?? undefined;
    const onExitDisposable = ptyProcess.onExit(onExit) ?? undefined;

    session.ptyListeners = { onData, onExit, onDataDisposable, onExitDisposable };
  }

  /**
   * 完成会话
   */
  completeSession(terminalId: string, exitCode: number | null, signal: string | null | undefined): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    const effectiveExitCode = exitCode ?? (signal ? 1 : 0);
    const effectiveSignal = signal ?? null;

    session.exitCode = effectiveExitCode;
    session.exitSignal = effectiveSignal;
    session.completedAt = Date.now();

    if (normalizeTerminalSessionStatus(session.status) === 'killed') {
      // 已经是 killed 状态，不覆盖
    } else if (effectiveExitCode === 0) {
      session.status = 'completed';
      this.emitState(session, 'completed');
    } else {
      session.status = 'failed';
      this.emitState(session, 'failed');
    }

    this.disposeSessionHandles(session);
  }

  /**
   * 移除会话
   */
  removeSession(terminalId: string): void {
    this.sessions.delete(terminalId);
  }

  // ── 查询 ──

  /**
   * 获取会话
   */
  getSession(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  /**
   * 按 agent 获取会话
   */
  getSessionsByAgent(agentId: string): TerminalSession[] {
    return Array.from(this.sessions.values()).filter(
      session => session.agentId === agentId,
    );
  }

  /**
   * 获取所有活跃会话 (running 或 suspended)
   */
  getAllActiveSessions(): TerminalSession[] {
    return Array.from(this.sessions.values()).filter(
      session => isTerminalSessionActiveStatus(session.status),
    );
  }

  /**
   * 获取会话输出
   */
  getSessionOutput(
    terminalId: string,
    sinceTimestamp?: number,
  ): { stdout: string; stderr: string; hasNew: boolean } | null {
    const session = this.sessions.get(terminalId);
    if (!session) return null;

    if (sinceTimestamp) {
      // 如果时间戳之后有更新，返回全部输出（简化处理，不做增量）
      const hasNew = session.outputUpdatedAt > sinceTimestamp;
      return { stdout: session.stdout, stderr: session.stderr, hasNew };
    }

    return { stdout: session.stdout, stderr: session.stderr, hasNew: true };
  }

  // ── 控制 ──

  /**
   * 杀死会话 (SIGTERM -> 200ms -> SIGKILL)
   */
  async killSession(terminalId: string): Promise<boolean> {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    if (!isTerminalSessionActiveStatus(session.status)) return false;

    const pid = session.pid;
    if (!pid) return false;

    try {
      await this.terminateSessionProcess(session, 'SIGTERM');
      // Allow brief grace period for the process to clean up
      await new Promise(resolve => setTimeout(resolve, TERMINAL.KILL_GRACE_MS));
      await this.terminateSessionProcess(session, 'SIGKILL');

      session.status = 'killed';
      session.exitSignal = 'SIGKILL';
      session.completedAt = Date.now();
      this.disposeSessionHandles(session);
      this.emitState(session, 'killed');
      return true;
    } catch { /* expected: process may already be dead */
      return false;
    }
  }

  /**
   * 挂起会话 (SIGTSTP)
   */
  suspendSession(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || normalizeTerminalSessionStatus(session.status) !== 'running' || !session.pid) return false;

    try {
      if (!supportsProcessSuspendResume()) {
        return false;
      }
      if (!sendProcessSignal(session.pid, 'SIGTSTP', { tree: true })) return false;
      session.status = 'suspended';
      this.emitState(session, 'suspended');
      return true;
    } catch { /* expected: signal delivery may fail if process exited */
      return false;
    }
  }

  /**
   * 恢复会话 (SIGCONT)
   */
  resumeSession(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || normalizeTerminalSessionStatus(session.status) !== 'suspended' || !session.pid) return false;

    try {
      if (!supportsProcessSuspendResume()) {
        return false;
      }
      if (!sendProcessSignal(session.pid, 'SIGCONT', { tree: true })) return false;
      session.status = 'running';
      this.emitState(session, 'resumed');
      return true;
    } catch { /* expected: signal delivery may fail if process exited */
      return false;
    }
  }

  /**
   * 向会话发送输入
   */
  writeToSession(terminalId: string, input: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || !isTerminalSessionActiveStatus(session.status)) return false;

    // PTY 模式
    if (session.ptyProcess && typeof session.ptyProcess.write === 'function') {
      try {
        session.ptyProcess.write(input);
        return true;
      } catch { /* expected: pty may be closed */
        return false;
      }
    }

    // child_process 模式
    if (session.childProcess?.stdin?.writable) {
      try {
        session.childProcess.stdin.write(input);
        return true;
      } catch { /* expected: stdin may be closed */
        return false;
      }
    }

    return false;
  }

  /**
   * 调整 PTY 终端大小 (仅 PTY 模式有效)
   */
  resizeSession(terminalId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || normalizeTerminalSessionStatus(session.status) !== 'running') return false;

    if (session.ptyProcess && typeof session.ptyProcess.resize === 'function') {
      try {
        session.ptyProcess.resize(cols, rows);
        if (session.headlessTerminal && typeof session.headlessTerminal.resize === 'function') {
          session.headlessTerminal.resize(cols, rows);
        }
        return true;
      } catch { /* expected: pty may be in invalid state */
        return false;
      }
    }

    return false; // child_process 不支持 resize
  }

  // ── 清理 ──

  /**
   * 清理孤儿会话 (PID 已死但状态仍是 running/suspended)
   */
  cleanupOrphaned(): void {
    for (const session of this.sessions.values()) {
      if (isTerminalSessionActiveStatus(session.status) && session.pid) {
        if (!processExists(session.pid)) {
          // PID 已死
          session.status = 'failed';
          session.exitCode = session.exitCode ?? -1;
          session.completedAt = Date.now();
          this.emitState(session, 'failed');
          // PID 已死也要释放 stdio/pty/headless 句柄 + 退订 listener(与 completeSession 路径一致,#12)
          try { this.disposeSessionHandles(session); } catch { /* tolerate */ }
        }
      }
    }
  }

  /**
   * 移除已过期完成的会话
   */
  removeExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (
        session.completedAt &&
        now - session.completedAt > TERMINAL.COMPLETED_SESSION_TTL_MS
      ) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * 杀死所有活跃会话
   */
  killAll(): void {
    const activeSessions = this.getAllActiveSessions();
    for (const session of activeSessions) {
      void this.terminateSessionProcess(session, 'SIGTERM');
      session.status = 'killed';
      session.exitSignal = 'SIGTERM';
      session.completedAt = Date.now();
      this.disposeSessionHandles(session);
      this.emitState(session, 'killed');
    }
  }

  /**
   * 完全销毁（进程退出时调用）
   */
  destroy(): void {
    this.stopCleanup();
    this.killAll();
    this.sessions.clear();
  }

  // ── 内部方法 ──

  /**
   * 追加输出到会话
   */
  private appendOutput(terminalId: string, chunk: string, stream: 'stdout' | 'stderr'): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    if (stream === 'stdout') {
      session.stdout += chunk;
      // 缓冲区溢出保护
      if (session.stdout.length > TERMINAL.OUTPUT_BUFFER_MAX) {
        session.stdout = session.stdout.substring(session.stdout.length - TERMINAL.OUTPUT_BUFFER_MAX);
      }
    } else {
      session.stderr += chunk;
      if (session.stderr.length > TERMINAL.OUTPUT_BUFFER_MAX) {
        session.stderr = session.stderr.substring(session.stderr.length - TERMINAL.OUTPUT_BUFFER_MAX);
      }
    }

    session.outputUpdatedAt = Date.now();

    // 发射 terminal:output 事件
    if (this.emitter) {
      this.emitter.emit('terminal:output', {
        terminalId,
        sessionId: session.sessionId,
        agentId: session.agentId || '',
        agentName: session.agentName,
        taskId: session.taskId,
        chunk,
        stream,
        pid: session.pid,
      });
    }
  }

  /**
   * 发射 terminal:state 事件
   */
  private emitState(session: TerminalSession, status: TerminalStateEventStatus): void {
    if (!this.emitter) return;

    this.emitter.emit('terminal:state', {
      terminalId: session.terminalId,
      sessionId: session.sessionId,
      agentId: session.agentId || '',
      agentName: session.agentName,
      taskId: session.taskId,
      pid: session.pid,
      status,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
  }

  private async terminateSessionProcess(session: TerminalSession, signal: NodeJS.Signals): Promise<void> {
    if (session.ptyProcess && typeof session.ptyProcess.kill === 'function') {
      try {
        session.ptyProcess.kill(signal);
        return;
      } catch {
        // Fall back to PID-based termination below.
      }
    }

    const pid = session.pid;
    if (pid) {
      try {
        await killProcess(pid, signal, { tree: true });
      } catch {
        // Process cleanup is best-effort during destroy/reset.
      }
    }
  }

  private disposeSessionHandles(session: TerminalSession): void {
    if (session.childProcess && session.childListeners) {
      const { childProcess, childListeners } = session;
      if (childListeners.onStdout && typeof childProcess.stdout?.removeListener === 'function') {
        childProcess.stdout.removeListener('data', childListeners.onStdout);
      }
      if (childListeners.onStderr && typeof childProcess.stderr?.removeListener === 'function') {
        childProcess.stderr.removeListener('data', childListeners.onStderr);
      }
      if (childListeners.onClose && typeof childProcess.removeListener === 'function') {
        childProcess.removeListener('close', childListeners.onClose);
      }
      if (childListeners.onError && typeof childProcess.removeListener === 'function') {
        childProcess.removeListener('error', childListeners.onError);
      }
    }

    const child = session.childProcess;
    try { child?.stdin?.destroy(); } catch { /* ignore */ }
    try { child?.stdout?.destroy(); } catch { /* ignore */ }
    try { child?.stderr?.destroy(); } catch { /* ignore */ }
    try { child?.unref?.(); } catch { /* ignore */ }

    const ptyListeners = session.ptyListeners;
    try { ptyListeners?.onDataDisposable?.dispose?.(); } catch { /* ignore */ }
    try { ptyListeners?.onExitDisposable?.dispose?.(); } catch { /* ignore */ }
    try { session.headlessTerminal?.dispose?.(); } catch { /* ignore */ }

    session.childProcess = undefined;
    session.ptyProcess = undefined;
    session.headlessTerminal = undefined;
    session.childListeners = undefined;
    session.ptyListeners = undefined;
  }
}

// 每进程单例
let instance: TerminalSessionManager | null = null;

export function getTerminalSessionManager(): TerminalSessionManager {
  if (!instance) {
    instance = new TerminalSessionManager();
    instance.startCleanup();

    // 进程退出时清理
    process.on('exit', () => {
      instance?.destroy();
    });
  }
  return instance;
}

export function resetTerminalSessionManager(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
