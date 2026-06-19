/**
 * TerminalRoutes — 交互式终端 WebSocket 路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { ServerAuth } from './ServerAuth.js';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import { killProcess, resolveInteractiveShell } from '../utils/platform.js';
import { serverLogger } from '../core/Log.js';
import { allowArbitraryTerminalCwd, shouldFilterChildEnv, filterEnv } from '../core/HardeningPolicy.js';
import { withToolProxyEnv } from '../core/ProxyConfig.js';
import path from 'path';

function isPathInside(parent: string, target: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

interface TerminalProcessHandle {
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface TerminalPtyProcess extends TerminalProcessHandle {
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}

interface TerminalPtyModule {
  spawn(file: string, args: string[], options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): TerminalPtyProcess;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInputMessage(value: unknown): value is { type: 'input'; data: string } {
  return isRecord(value) && value.type === 'input' && typeof value.data === 'string';
}

function isResizeMessage(value: unknown): value is { type: 'resize'; cols: number; rows: number } {
  return isRecord(value)
    && value.type === 'resize'
    && typeof value.cols === 'number'
    && typeof value.rows === 'number'
    && Boolean(value.cols)
    && Boolean(value.rows);
}

export function registerTerminalRoutes(
  fastify: FastifyInstance,
  deps: { serverAuth: ServerAuth; repos?: DatabaseRepositoryAdapter },
): void {
  const { serverAuth, repos } = deps;

  fastify.get('/api/v1/terminal/ws', { websocket: true }, async (socket, request) => {
    if (!serverAuth.validate(request)) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    const query = request.query as { cwd?: string; sessionId?: string };
    // 加固模式 cwd 约束：cwd 必须落在 session workspace root 内（复用 root 包含校验，带分隔符边界），
    //   越界回退 workspace root。默认关闭时保持现状：query.cwd 任意指定。
    let cwd = query.cwd || process.cwd();
    if (!allowArbitraryTerminalCwd()) {
      const workspaceRoot = path.resolve(
        (query.sessionId && repos?.sessions.get(query.sessionId)?.workspace) || process.cwd(),
      );
      const requested = path.resolve(cwd);
      cwd = isPathInside(workspaceRoot, requested) ? requested : workspaceRoot;
    }

    // 加固模式 env 脱敏：用 filterEnv(process.env) 剔除密钥/LINGXIAO_* 内部变量后注入终端 shell。
    //   默认关闭时保持现状：透传完整 process.env。两处（pty / 回退 spawn）共用同一基底。
    const shellBaseEnv: NodeJS.ProcessEnv = withToolProxyEnv(shouldFilterChildEnv() ? filterEnv(process.env) : { ...process.env });

    let ptyProc: TerminalProcessHandle | null = null;
    let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
    let onStdout: ((data: Buffer) => void) | null = null;
    let onStderr: ((data: Buffer) => void) | null = null;
    let onClose: ((code: number | null) => void) | null = null;

    try {
      const { getPty } = await import('../utils/getPty.js');
      const ptyImpl = await getPty();
      const shell = resolveInteractiveShell();

      if (ptyImpl) {
        const ptyModule: TerminalPtyModule = ptyImpl.module;
        const spawnedPty = ptyModule.spawn(shell.executable, shell.args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd,
          env: { ...shellBaseEnv, TERM: 'xterm-256color' },
        });
        ptyProc = spawnedPty;

        spawnedPty.onData((data: string) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'output', data }));
          }
        });

        spawnedPty.onExit(({ exitCode }: { exitCode: number }) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'exit', exitCode }));
            socket.close();
          }
        });
      } else {
        const { spawn } = await import('child_process');
        const fallbackChild = spawn(shell.executable, shell.args, {
          cwd,
          env: { ...shellBaseEnv, TERM: 'xterm-256color' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child = fallbackChild;

        onStdout = (data: Buffer) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'output', data: data.toString('utf-8') }));
          }
        };
        onStderr = (data: Buffer) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'output', data: `\x1b[31m${data.toString('utf-8')}\x1b[0m` }));
          }
        };
        onClose = (code: number | null) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'exit', exitCode: code }));
            socket.close();
          }
        };

        fallbackChild.stdout.on('data', onStdout);
        fallbackChild.stderr.on('data', onStderr);
        fallbackChild.on('close', onClose);

        ptyProc = {
          kill: () => {
            if (fallbackChild.pid) {
              void killProcess(fallbackChild.pid, undefined, { tree: true, graceMs: 1_000 });
            } else {
              fallbackChild.kill();
            }
          },
          write: (data: string) => {
            fallbackChild.stdin.write(data);
          },
          resize: () => {},
        };
      }

      socket.on('message', (raw: Buffer) => {
        try {
          const msg: unknown = JSON.parse(raw.toString());
          if (isInputMessage(msg)) {
            if (ptyProc) {
              ptyProc.write(msg.data);
            }
          } else if (isResizeMessage(msg)) {
            if (ptyProc?.resize) {
              try { ptyProc.resize(msg.cols, msg.rows); } catch (err) { serverLogger.debug('[Terminal WS] Failed to resize PTY', { error: String(err) }); }
            }
          }
        } catch (err) {
          serverLogger.debug('[Terminal WS] Ignored invalid terminal message', { error: String(err) });
        }
      });

      socket.on('close', () => {
        try { ptyProc?.kill(); } catch (err) { serverLogger.warn('[Terminal WS] Failed to kill PTY during close', { error: String(err) }); }
        // 清理 child 进程监听器
        if (child) {
          if (onStdout) child.stdout.removeListener('data', onStdout);
          if (onStderr) child.stderr.removeListener('data', onStderr);
          if (onClose) child.removeListener('close', onClose);
        }
      });
    } catch (err) {
      serverLogger.error('[Terminal WS] Failed to create PTY: ' + String(err));
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'error', error: 'Failed to create terminal' }));
        socket.close();
      }
    }
  });
}
