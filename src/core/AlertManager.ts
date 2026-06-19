/**
 * AlertManager — 可插拔告警通道
 *
 * 统一告警输出管道。支持 webhook、log 文件、stdout 三种后端，
 * 各后端可独立开关。所有 emit 调用均 fire-and-forget（不阻塞主回路）。
 *
 * 接入点：
 *   EternalSupervisor → AlertManager (进程崩溃/重启/放弃)
 *   EternalLoop → AlertManager (健康分低于阈值/成本超限/阻塞过久)
 *
 * 接口分为：
 *   - AlertChannel: 单一输出后端接口
 *   - AlertManager: 单例管理器，聚合多个 channel
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config.js';

// ─── types ───

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  /** 告警类型：便于下游过滤/路由 */
  type: string;
  severity: AlertSeverity;
  message: string;
  /** 附加结构化数据 */
  metadata?: Record<string, unknown>;
  /** 来源组件 */
  source: string;
  /** 时间戳 (epoch ms) */
  timestamp: number;
}

/** 单一告警输出后端 */
export interface AlertChannel {
  readonly name: string;
  /** 发送告警。实现应无异常抛出（自行 try-catch）。 */
  send(alert: Alert): void | Promise<void>;
}

// ─── built-in channels ───

export class StdoutAlertChannel implements AlertChannel {
  readonly name = 'stdout';

  send(alert: Alert): void {
    const prefix = alert.severity === 'critical'
      ? '🚨'
      : alert.severity === 'warning'
        ? '⚠️'
        : 'ℹ️';
    const ts = new Date(alert.timestamp).toISOString();
    const meta = alert.metadata ? ` | ${JSON.stringify(alert.metadata)}` : '';
    process.stderr.write(
      `[AlertManager|${alert.source}] ${prefix} [${alert.severity}] ${ts}: ${alert.message}${meta}\n`,
    );
  }
}

export class LogFileAlertChannel implements AlertChannel {
  readonly name = 'log';
  private readonly filePath: string;

  constructor(baseDir: string = CONFIG_DIR) {
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
    this.filePath = join(baseDir, 'alerts.log');
  }

  send(alert: Alert): void {
    const line = JSON.stringify({
      ...alert,
      timestamp: new Date(alert.timestamp).toISOString(),
    });
    try {
      appendFileSync(this.filePath, line + '\n', 'utf-8');
    } catch {
      // silently drop — alerts are best-effort
    }
  }
}

export class WebhookAlertChannel implements AlertChannel {
  readonly name = 'webhook';
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async send(alert: Alert): Promise<void> {
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...alert,
          timestamp: new Date(alert.timestamp).toISOString(),
        }),
      });
    } catch {
      // Fire-and-forget: webhook failures must not crash the loop
    }
  }
}

// ─── manager ───

export class AlertManager {
  private channels: AlertChannel[] = [];
  private enabled = true;

  /** 注册告警通道 */
  register(channel: AlertChannel): void {
    // Dedup by name
    if (this.channels.some(c => c.name === channel.name)) return;
    this.channels.push(channel);
  }

  /** 移除告警通道 */
  unregister(name: string): void {
    this.channels = this.channels.filter(c => c.name !== name);
  }

  /** 全局开关 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** 发送告警到所有已注册通道 (fire-and-forget) */
  emit(alert: Omit<Alert, 'timestamp'>): void {
    if (!this.enabled) return;

    const full: Alert = { ...alert, timestamp: Date.now() };
    for (const channel of this.channels) {
      // Fire-and-forget — never await, but log failures
      void Promise.resolve()
        .then(() => channel.send(full))
        .catch((err) => {
          console.warn(`[AlertManager] 通道 "${channel.name}" 告警投递失败:`, err instanceof Error ? err.message : String(err));
        });
    }
  }

  /** 仅发送到指定通道名 (用于紧急路径) */
  emitTo(channelName: string, alert: Omit<Alert, 'timestamp'>): void {
    if (!this.enabled) return;
    const channel = this.channels.find(c => c.name === channelName);
    if (!channel) return;

    const full: Alert = { ...alert, timestamp: Date.now() };
    void Promise.resolve()
      .then(() => channel.send(full))
      .catch((err) => {
        console.warn(`[AlertManager] 通道 "${channelName}" 告警投递失败:`, err instanceof Error ? err.message : String(err));
      });
  }
}

/** 全局单例 */
export const alertManager = new AlertManager();
