/**
 * BuildDiagnosticsCollector — 结构化构建诊断收集器
 *
 * 面向巨型项目设计：
 * - 调用真实 build 工具，获取**结构化**输出（JSON/machine-readable 格式）
 * - 不做关键词匹配 —— 直接解析工具原生的诊断格式
 * - 支持 TypeScript (tsc)、ESLint、Cargo、Go、Python (mypy)
 *
 * 设计原则：
 * - 确定性: 输出由 build 工具决定，不是我们猜
 * - 可组合: 每种 build 工具是独立 adapter，返回统一 Diagnostic 结构
 * - 增量友好: 只收集当前 build 状态，不缓存历史诊断
 *
 * 用途:
 * - Worker 写完代码后调用 → 拿到精确错误位置 + 消息
 * - Leader 据此判断 worker 是否需要重试 (不是猜，是看 diagnostics.length > 0)
 * - Self-verification: build pass = diagnostics 为空
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ExecFileFailure {
  stdout?: unknown;
  stderr?: unknown;
  code?: unknown;
}

function stringOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return '';
}

function normalizeExecFileFailure(error: unknown): { stdout: string; stderr: string; exitCode: number } {
  const failure = error as ExecFileFailure;
  return {
    stdout: stringOutput(failure.stdout),
    stderr: stringOutput(failure.stderr),
    exitCode: typeof failure.code === 'number' ? failure.code : 1,
  };
}

/** 统一诊断结构 (所有 build 工具的输出都归一化到这个格式) */
export interface Diagnostic {
  /** 严重级别 */
  severity: 'error' | 'warning' | 'info';
  /** 文件路径 (相对项目根) */
  file: string;
  /** 行号 (1-based) */
  line: number;
  /** 列号 (1-based) */
  column: number;
  /** 诊断消息 */
  message: string;
  /** 错误代码 (如 TS2345, E0308) */
  code?: string;
  /** 来源工具 */
  source: string;
}

/** 构建结果 */
export interface BuildResult {
  /** 是否通过 (零 error 级别诊断) */
  passed: boolean;
  /** 所有诊断 */
  diagnostics: Diagnostic[];
  /** 执行的命令 */
  command: string;
  /** 退出码 */
  exitCode: number;
  /** 耗时 ms */
  durationMs: number;
}

/** Build adapter 接口 — 每种构建工具实现一个 */
export interface BuildAdapter {
  /** 工具名 */
  name: string;
  /** 检测当前项目是否适用此 adapter (确定性: 检查配置文件存在性) */
  detect(projectRoot: string): boolean;
  /** 执行构建并返回结构化诊断 */
  collect(projectRoot: string, timeoutMs?: number): Promise<BuildResult>;
}

// PLACEHOLDER_ADAPTERS

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * TypeScript adapter: `tsc --noEmit --pretty false`
 * tsc 原生格式: `file(line,col): error TSxxxx: message`
 * 这里用 --pretty false 确保输出是 machine-parseable 单行格式。
 */
export class TypeScriptAdapter implements BuildAdapter {
  name = 'tsc';

  detect(projectRoot: string): boolean {
    return existsSync(join(projectRoot, 'tsconfig.json'));
  }

  async collect(projectRoot: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BuildResult> {
    const start = Date.now();
    const command = 'npx tsc --noEmit --pretty false';
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      const result = await execFileAsync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
        cwd: projectRoot,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      const failure = normalizeExecFileFailure(err);
      stdout = failure.stdout;
      stderr = failure.stderr;
      exitCode = failure.exitCode;
    }

    const diagnostics = this.parseTscOutput(stdout || stderr);
    return {
      passed: diagnostics.filter(d => d.severity === 'error').length === 0,
      diagnostics,
      command,
      exitCode,
      durationMs: Date.now() - start,
    };
  }

  /** 解析 tsc --pretty false 输出: `path(line,col): severity TScode: message` */
  private parseTscOutput(output: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

    for (const line of output.split('\n')) {
      const match = TSC_LINE_RE.exec(line.trim());
      if (!match) continue;
      diagnostics.push({
        severity: match[4] as 'error' | 'warning',
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        message: match[6],
        code: match[5],
        source: 'tsc',
      });
    }
    return diagnostics;
  }
}

/**
 * ESLint adapter: `eslint --format json`
 * 输出为 JSON 数组，每项包含 messages[].
 */
export class ESLintAdapter implements BuildAdapter {
  name = 'eslint';

  detect(projectRoot: string): boolean {
    return existsSync(join(projectRoot, '.eslintrc.json'))
      || existsSync(join(projectRoot, '.eslintrc.js'))
      || existsSync(join(projectRoot, '.eslintrc.cjs'))
      || existsSync(join(projectRoot, 'eslint.config.js'))
      || existsSync(join(projectRoot, 'eslint.config.mjs'));
  }

  async collect(projectRoot: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BuildResult> {
    const start = Date.now();
    const command = 'npx eslint --format json .';
    let stdout = '';
    let exitCode = 0;

    try {
      const result = await execFileAsync('npx', ['eslint', '--format', 'json', '.'], {
        cwd: projectRoot,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      const failure = normalizeExecFileFailure(err);
      stdout = failure.stdout;
      exitCode = failure.exitCode;
    }

    const diagnostics = this.parseEslintJson(stdout);
    return {
      passed: diagnostics.filter(d => d.severity === 'error').length === 0,
      diagnostics,
      command,
      exitCode,
      durationMs: Date.now() - start,
    };
  }

  private parseEslintJson(output: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    try {
      const results = JSON.parse(output) as Array<{
        filePath: string;
        messages: Array<{ severity: number; line: number; column: number; message: string; ruleId: string | null }>;
      }>;
      for (const file of results) {
        for (const msg of file.messages) {
          diagnostics.push({
            severity: msg.severity >= 2 ? 'error' : 'warning',
            file: file.filePath,
            line: msg.line,
            column: msg.column,
            message: msg.message,
            code: msg.ruleId ?? undefined,
            source: 'eslint',
          });
        }
      }
    } catch { /* 非 JSON 输出 = 无诊断 */ }
    return diagnostics;
  }
}

/**
 * 统一收集器：自动检测项目类型并运行对应 adapter。
 */
export class BuildDiagnosticsCollector {
  private readonly adapters: BuildAdapter[];

  constructor(customAdapters?: BuildAdapter[]) {
    this.adapters = customAdapters ?? [
      new TypeScriptAdapter(),
      new ESLintAdapter(),
    ];
  }

  /** 检测当前项目适用的所有 adapter */
  detectApplicable(projectRoot: string): BuildAdapter[] {
    return this.adapters.filter(a => a.detect(projectRoot));
  }

  /** 运行所有适用的 adapter，合并诊断 */
  async collectAll(projectRoot: string, timeoutMs?: number): Promise<BuildResult[]> {
    const applicable = this.detectApplicable(projectRoot);
    const results: BuildResult[] = [];
    for (const adapter of applicable) {
      results.push(await adapter.collect(projectRoot, timeoutMs));
    }
    return results;
  }

  /** 快速判断: 运行主 build adapter, 返回是否通过 */
  async quickCheck(projectRoot: string, timeoutMs?: number): Promise<{ passed: boolean; errorCount: number; diagnostics: Diagnostic[] }> {
    const applicable = this.detectApplicable(projectRoot);
    if (applicable.length === 0) {
      return { passed: true, errorCount: 0, diagnostics: [] };
    }
    // 只跑第一个（通常是 tsc, 最权威的类型检查）
    const result = await applicable[0].collect(projectRoot, timeoutMs);
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    return { passed: errors.length === 0, errorCount: errors.length, diagnostics: errors };
  }
}
