/**
 * Structured Logging System
 *
 * Features:
 * - JSON lines file output (~/.lingxiao/logs/lingxiao.log)
 * - Human-readable console output (stderr)
 * - Simple file rotation (10MB max, 3 files)
 * - Structured context fields
 * - Environment variable override: LINGXIAO_LOG_LEVEL
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

const LEVEL_ORDER: LogLevel[] = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  setLevel(level: LogLevel): void;
}

// ─── Sinks ───

interface LogEntry {
  ts: string;
  level: LogLevel;
  logger: string;
  msg: string;
  [key: string]: unknown;
}

interface LogSink {
  write(entry: LogEntry): void;
}

class ConsoleSink implements LogSink {
  write(entry: LogEntry): void {
    const { ts, level, logger, msg, ...rest } = entry;
    const ctxStr = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    const line = `[${ts}] [${logger}] ${level.toUpperCase()}: ${msg}${ctxStr}\n`;
    process.stderr.write(line);
  }
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 2; // .1, .2

class FileSink implements LogSink {
  private filePath: string;
  private writeCount = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  write(entry: LogEntry): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
      this.writeCount++;
      if (this.writeCount % 100 === 0) this.maybeRotate();
    } catch {
      // Best-effort file logging
    }
  }

  private maybeRotate(): void {
    try {
      const stat = statSync(this.filePath);
      if (stat.size < MAX_FILE_SIZE) return;
      for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
        const from = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
        const to = `${this.filePath}.${i}`;
        if (existsSync(from)) renameSync(from, to);
      }
    } catch {
      // Rotation failure is non-fatal
    }
  }
}

// ─── Logger Implementation ───

class StructuredLogger implements Logger {
  private name: string;
  private level: LogLevel = LogLevel.WARN;

  constructor(name: string) {
    this.name = name;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(this.level);
  }

  private emit(level: LogLevel, msg: string, args: unknown[]): void {
    if (!this.shouldLog(level)) return;
    let ctxObj: Record<string, unknown> | undefined;
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      ctxObj = args[0] as Record<string, unknown>;
    } else if (args.length > 0) {
      ctxObj = { args };
    }
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      logger: this.name,
      msg,
      ...ctxObj,
    };
    for (const sink of _sinks) {
      sink.write(entry);
    }
  }

  debug(msg: string, ...args: unknown[]): void { this.emit(LogLevel.DEBUG, msg, args); }
  info(msg: string, ...args: unknown[]): void { this.emit(LogLevel.INFO, msg, args); }
  warn(msg: string, ...args: unknown[]): void { this.emit(LogLevel.WARN, msg, args); }
  error(msg: string, ...args: unknown[]): void { this.emit(LogLevel.ERROR, msg, args); }
}

// ─── Global State ───

let _sinks: LogSink[] = [new ConsoleSink()];
let _allLoggers: StructuredLogger[] = [];

// ─── Public API ───

export const leaderLogger = _createAndTrack('lingxiao.leader');
export const agentLogger = _createAndTrack('lingxiao.agent');
export const sessionLogger = _createAndTrack('lingxiao.session');
export const coreLogger = _createAndTrack('lingxiao.core');
export const serverLogger = _createAndTrack('lingxiao.server');
export const configLogger = _createAndTrack('lingxiao.config');
const wikiLogger = _createAndTrack('lingxiao.wiki');
export const llmLogger = _createAndTrack('lingxiao.llm');

function _createAndTrack(name: string): StructuredLogger {
  const logger = new StructuredLogger(name);
  _allLoggers.push(logger);
  return logger;
}

function createLogger(name: string, level: LogLevel = LogLevel.WARN): Logger {
  const logger = new StructuredLogger(name);
  logger.setLevel(level);
  _allLoggers.push(logger);
  return logger;
}

function setGlobalLogLevel(level: LogLevel): void {
  for (const logger of _allLoggers) {
    logger.setLevel(level);
  }
}

export interface LogConfig {
  level?: LogLevel;
  file?: string | boolean;
  /**
   * 是否启用 ConsoleSink（直接写 process.stderr）。默认 true。
   * TUI 模式必须传 false：ConsoleSink 绕过 console.* 直写 stderr，会污染 Ink
   * 的渲染区、打乱 log-update 的光标行数计算，导致状态行无法原地更新而反复刷屏。
   */
  console?: boolean;
}

export function configureLogging(config: LogConfig): void {
  const level = config.level
    ?? (process.env.LINGXIAO_LOG_LEVEL as LogLevel | undefined)
    ?? LogLevel.WARN;

  setGlobalLogLevel(level);

  _sinks = config.console === false ? [] : [new ConsoleSink()];

  if (config.file) {
    const filePath = typeof config.file === 'string'
      ? config.file
      : join(homedir(), '.lingxiao', 'logs', 'lingxiao.log');
    _sinks.push(new FileSink(filePath));
  }
}
