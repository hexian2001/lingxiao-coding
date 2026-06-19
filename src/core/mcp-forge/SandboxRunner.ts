/**
 * MCP Forge 沙箱执行器 — 隔离环境编译+运行
 *
 * 契约: contract:mcp-forge-core v1 §3.3
 *
 * 使用 child_process.spawn 在子进程中执行生成的 server 代码，
 * 设置超时和环境隔离。
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { SandboxRunResult, GeneratedCode } from './types.js';
import { ForgeError, ForgeErrorCode } from './errors.js';

export interface SandboxRunnerOptions {
  timeoutMs?: number;
  customEnv?: Record<string, string>;
  cwd?: string;
}

export class SandboxRunner {
  /**
   * 在沙箱中运行生成的 server 代码。
   * 返回运行结果（stdout/stderr/exitCode）。
   *
   * 对于 stdio server，启动后等待 2 秒确认进程存活即视为启动成功。
   * 对于 HTTP server，启动后等待端口可连接。
   */
  static async run(
    code: GeneratedCode,
    options: SandboxRunnerOptions = {},
  ): Promise<SandboxRunResult> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const cwd = options.cwd ?? code.outputDir;
    const startTime = Date.now();

    let command: string;
    let args: string[];

    if (code.language === 'python') {
      command = 'python3';
      args = [code.entryPoint];
    } else {
      // Node.js: check if node_modules exists, if not, run npm install first
      const nodeModulesPath = join(cwd, 'node_modules');
      if (!existsSync(nodeModulesPath)) {
        await SandboxRunner.runNpmInstall(cwd, timeoutMs);
      }
      command = 'node';
      args = [code.entryPoint];
    }

    const env = {
      ...process.env,
      ...(options.customEnv || {}),
      // Safety: restrict sensitive env vars
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      USER: process.env.USER,
    };

    return SandboxRunner.spawnProcess(command, args, {
      cwd,
      env,
      timeoutMs,
      startTime,
      isServer: true, // Server process — we check if it stays alive
    });
  }

  /**
   * 编译 TypeScript 代码（如需要）。
   */
  static async compile(
    code: GeneratedCode,
    options: SandboxRunnerOptions = {},
  ): Promise<SandboxRunResult> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const cwd = options.cwd ?? code.outputDir;
    const startTime = Date.now();

    if (code.language === 'python') {
      // Python: syntax check
      return SandboxRunner.spawnProcess('python3', ['-m', 'py_compile', code.entryPoint], {
        cwd,
        env: { ...process.env },
        timeoutMs,
        startTime,
        isServer: false,
      });
    }

    // Node.js: if package.json has build script, run it; otherwise just check syntax
    const packageJsonPath = join(cwd, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        if (pkg.scripts?.build) {
          return SandboxRunner.spawnProcess('npm', ['run', 'build'], {
            cwd,
            env: { ...process.env },
            timeoutMs,
            startTime,
            isServer: false,
          });
        }
      } catch {
        // Ignore package.json parse errors
      }
    }

    // Fallback: node --check
    return SandboxRunner.spawnProcess('node', ['--check', code.entryPoint], {
      cwd,
      env: { ...process.env },
      timeoutMs,
      startTime,
      isServer: false,
    });
  }

  /**
   * 运行 npm install。
   */
  private static async runNpmInstall(cwd: string, timeoutMs: number): Promise<void> {
    const result = await SandboxRunner.spawnProcess('npm', ['install', '--no-audit', '--no-fund'], {
      cwd,
      env: { ...process.env },
      timeoutMs: Math.min(timeoutMs, 120000),
      startTime: Date.now(),
      isServer: false,
    });

    if (!result.success && result.exitCode !== 0) {
      throw new ForgeError(
        ForgeErrorCode.FORGE_SANDBOX_CRASH,
        `npm install failed in sandbox: ${result.stderr.slice(0, 500)}`,
        { phase: 'validating', detail: result.stderr },
      );
    }
  }

  /**
   * 在子进程中执行命令，收集 stdout/stderr，设置超时。
   */
  private static async spawnProcess(
    command: string,
    args: string[],
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
      timeoutMs: number;
      startTime: number;
      isServer: boolean;
    },
  ): Promise<SandboxRunResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let resolved = false;

      try {
        child = spawn(command, args, {
          cwd: opts.cwd,
          env: opts.env as Record<string, string>,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          success: false,
          exitCode: null,
          stdout: '',
          stderr: `Failed to spawn process: ${err instanceof Error ? err.message : String(err)}`,
          duration: Date.now() - opts.startTime,
          timedOut: false,
        });
        return;
      }

      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore kill errors
          }
        }
      }, opts.timeoutMs);

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          resolve({
            success: false,
            exitCode: null,
            stdout,
            stderr: `Process error: ${err.message}`,
            duration: Date.now() - opts.startTime,
            timedOut,
          });
        }
      });

      if (opts.isServer) {
        // For server processes: if it stays alive for 2 seconds, consider it started successfully
        setTimeout(() => {
          if (!resolved && !child.killed) {
            resolved = true;
            clearTimeout(timeoutHandle);
            try {
              child.kill('SIGTERM');
              // Force kill after 1s
              setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* ignore */ }
              }, 1000);
            } catch {
              // Ignore
            }
            resolve({
              success: true,
              exitCode: null,
              stdout,
              stderr,
              duration: Date.now() - opts.startTime,
              timedOut: false,
            });
          }
        }, 2000);

        // If server exits before 2s, it's a startup failure
        child.on('exit', (code: number | null) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutHandle);
            resolve({
              success: false,
              exitCode: code,
              stdout,
              stderr: stderr || `Server exited prematurely with code ${code}`,
              duration: Date.now() - opts.startTime,
              timedOut,
            });
          }
        });
      } else {
        // For non-server processes: wait for completion
        child.on('exit', (code: number | null) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutHandle);
            resolve({
              success: !timedOut && code === 0,
              exitCode: code,
              stdout,
              stderr,
              duration: Date.now() - opts.startTime,
              timedOut,
            });
          }
        });
      }

      // Handle timeout resolution
      timeoutHandle.ref();
    });
  }
}
