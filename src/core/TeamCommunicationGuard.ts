/**
 * TeamCommunicationGuard — 防止 agent 间通信失控的安全护栏
 *
 * 控制机制：
 * 1. 消息频率限制 — 单 agent 每分钟最多 30 条消息
 * 2. 广播限制 — 每分钟最多 5 次广播
 * 3. 循环检测 — A→B→A→B 乒乓模式（5 轮 / 60s 内）阻断
 * 4. 总量预算 — 单 session 每小时最多 500 条 team 消息（滑动窗口）
 * 5. 内容去重 — 相同 from+to+content(指纹) 30s 内不重复投递
 * 6. 日志审计 — 所有消息记录到结构化日志
 */

import { createHash } from 'node:crypto';
import { coreLogger } from './Log.js';

export interface GuardConfig {
  /** 单 agent 每分钟最大消息数 */
  maxMessagesPerMinute: number;
  /** 每分钟最大广播数 */
  maxBroadcastsPerMinute: number;
  /** 乒乓循环检测阈值（轮数） */
  pingPongThreshold: number;
  /** 乒乓时间窗口（ms）— 仅在窗口内严格交替才视为乒乓 */
  pingPongWindowMs: number;
  /** 总量预算窗口（ms）— 滑动窗口，避免长跑必锁死 */
  totalBudgetWindowMs: number;
  /** 总量预算窗口内最大消息数 */
  maxTotalMessagesPerWindow: number;
  /** 内容去重窗口（ms） */
  dedupeWindowMs: number;
}

const DEFAULT_CONFIG: GuardConfig = {
  maxMessagesPerMinute: 30,
  maxBroadcastsPerMinute: 5,
  pingPongThreshold: 5,
  pingPongWindowMs: 60_000,
  totalBudgetWindowMs: 60 * 60_000, // 1 小时
  maxTotalMessagesPerWindow: 500,
  dedupeWindowMs: 30_000,
};

export type GuardVerdict = 'allow' | 'rate_limited' | 'deduplicated' | 'ping_pong_degraded' | 'ping_pong_blocked' | 'budget_exhausted';

export interface GuardResult {
  verdict: GuardVerdict;
  /** 如果被降级，建议的新 urgency */
  degradedUrgency?: 'normal';
  reason?: string;
}

interface RateWindow {
  timestamps: number[];
}

interface PingPongTracker {
  /** 最近的消息方向序列：'A→B' | 'B→A' */
  directions: string[];
  lastTimestamp: number;
}

export class TeamCommunicationGuard {
  private config: GuardConfig;
  private sessionId: string;

  /** agent name → 发送频率窗口 */
  private sendRates = new Map<string, RateWindow>();
  /** 广播频率窗口 */
  private broadcastRate: RateWindow = { timestamps: [] };
  /** 去重缓存：fingerprint → ts */
  private dedupeCache = new Map<string, number>();
  /** 乒乓检测：pair key → tracker */
  private pingPongTrackers = new Map<string, PingPongTracker>();
  /** 总量预算滑动窗口（ts 列表） */
  private totalMessageWindow: number[] = [];

  constructor(sessionId: string, config?: Partial<GuardConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 仅检查是否允许通过，不计数（不修改内部状态）。
   * 给工具入口（TeamSendMessage）做"前置反馈"使用，让 LLM 立即拿到 rate_limited / deduplicated 反馈。
   */
  preCheck(from: string, to: string | undefined, content: string, isBroadcast: boolean): GuardResult {
    return this.evaluate(from, to, content, isBroadcast, /*record*/ false);
  }

  /**
   * 检查并计数（service 主路径用）。
   */
  check(from: string, to: string | undefined, content: string, isBroadcast: boolean): GuardResult {
    return this.evaluate(from, to, content, isBroadcast, /*record*/ true);
  }

  private evaluate(from: string, to: string | undefined, content: string, isBroadcast: boolean, record: boolean): GuardResult {
    const now = Date.now();

    // 1. 总量预算滑动窗口
    this.pruneTotalWindow(now);
    if (this.totalMessageWindow.length >= this.config.maxTotalMessagesPerWindow) {
      coreLogger.warn(`[TeamGuard] session=${this.sessionId} 滑动窗口预算超限 (${this.totalMessageWindow.length}/${this.config.maxTotalMessagesPerWindow}/${Math.round(this.config.totalBudgetWindowMs / 60_000)}min)`);
      return { verdict: 'budget_exhausted', reason: `滑动窗口内消息超限 ${this.config.maxTotalMessagesPerWindow}/${Math.round(this.config.totalBudgetWindowMs / 60_000)}min` };
    }

    // 2. 频率限制
    if (isBroadcast) {
      this.pruneWindow(this.broadcastRate, now);
      if (this.broadcastRate.timestamps.length >= this.config.maxBroadcastsPerMinute) {
        coreLogger.warn(`[TeamGuard] ${from} 广播频率超限 (${this.broadcastRate.timestamps.length}/${this.config.maxBroadcastsPerMinute}/min)`);
        return { verdict: 'rate_limited', reason: `广播频率超限 (${this.config.maxBroadcastsPerMinute}/min)` };
      }
    }

    const senderWindow = this.getOrCreateWindow(from);
    this.pruneWindow(senderWindow, now);
    if (senderWindow.timestamps.length >= this.config.maxMessagesPerMinute) {
      coreLogger.warn(`[TeamGuard] ${from} 发送频率超限 (${senderWindow.timestamps.length}/${this.config.maxMessagesPerMinute}/min)`);
      return { verdict: 'rate_limited', reason: `发送频率超限 (${this.config.maxMessagesPerMinute}/min)` };
    }

    // 3. 内容去重（用 sha1 截断指纹避免大 content 拷贝）
    if (to) {
      const fingerprint = this.makeFingerprint(from, to, content);
      this.pruneDedupeCache(now);
      const lastTs = this.dedupeCache.get(fingerprint);
      if (lastTs !== undefined) {
        coreLogger.debug(`[TeamGuard] 去重拦截: ${from}→${to} (fingerprint=${fingerprint.slice(0, 16)}...)`);
        return { verdict: 'deduplicated', reason: '相同消息在去重窗口内已发送' };
      }
      if (record) this.dedupeCache.set(fingerprint, now);
    }

    // 4. 乒乓循环检测（仅 P2P）
    if (to) {
      const pairKey = [from, to].sort().join('↔');
      const direction = `${from}→${to}`;
      const tracker = this.getOrCreatePingPong(pairKey);

      // 仅在 record 阶段才追加方向；preCheck 时只读，避免污染序列
      if (record) {
        tracker.directions.push(direction);
        tracker.lastTimestamp = now;
        const maxLen = this.config.pingPongThreshold * 2;
        if (tracker.directions.length > maxLen) {
          tracker.directions = tracker.directions.slice(-maxLen);
        }
      }

      const pingPongDetected = this.detectPingPong(tracker, now, direction, record);
      if (pingPongDetected === 'blocked') {
        coreLogger.warn(`[TeamGuard] 乒乓循环阻断: ${pairKey} (${tracker.directions.length} 条交替消息 in 60s)`);
        return { verdict: 'ping_pong_blocked', reason: `检测到乒乓循环 (${pairKey})，发送被阻断` };
      }
      if (pingPongDetected === 'degraded') {
        coreLogger.warn(`[TeamGuard] 乒乓循环检测: ${pairKey} (${tracker.directions.length} 条交替消息)，urgency 降级`);
        if (record) this.recordSend(from, isBroadcast, now);
        return { verdict: 'ping_pong_degraded', degradedUrgency: 'normal', reason: `检测到乒乓循环 (${pairKey})，urgency 降级为 normal` };
      }
    }

    // 通过所有检查
    if (record) this.recordSend(from, isBroadcast, now);
    return { verdict: 'allow' };
  }

  /** 记录一次成功发送 */
  private recordSend(from: string, isBroadcast: boolean, now: number): void {
    this.totalMessageWindow.push(now);
    const window = this.getOrCreateWindow(from);
    window.timestamps.push(now);
    if (isBroadcast) {
      this.broadcastRate.timestamps.push(now);
    }
  }

  /** 获取当前统计 */
  getStats(): { totalMessages: number; budget: number; agentRates: Record<string, number> } {
    const now = Date.now();
    this.pruneTotalWindow(now);
    const agentRates: Record<string, number> = {};
    for (const [name, window] of this.sendRates) {
      this.pruneWindow(window, now);
      agentRates[name] = window.timestamps.length;
    }
    return {
      totalMessages: this.totalMessageWindow.length,
      budget: this.config.maxTotalMessagesPerWindow - this.totalMessageWindow.length,
      agentRates,
    };
  }

  /** 重置（用于测试或 session 结束） */
  reset(): void {
    this.sendRates.clear();
    this.broadcastRate = { timestamps: [] };
    this.dedupeCache.clear();
    this.pingPongTrackers.clear();
    this.totalMessageWindow = [];
  }

  // ─── 内部方法 ───

  private getOrCreateWindow(agentName: string): RateWindow {
    let w = this.sendRates.get(agentName);
    if (!w) {
      w = { timestamps: [] };
      this.sendRates.set(agentName, w);
    }
    return w;
  }

  private pruneWindow(window: RateWindow, now: number): void {
    const cutoff = now - 60_000; // 1 分钟窗口
    window.timestamps = window.timestamps.filter(t => t > cutoff);
  }

  private pruneTotalWindow(now: number): void {
    const cutoff = now - this.config.totalBudgetWindowMs;
    this.totalMessageWindow = this.totalMessageWindow.filter(t => t > cutoff);
  }

  private pruneDedupeCache(now: number): void {
    const cutoff = now - this.config.dedupeWindowMs;
    for (const [fp, ts] of this.dedupeCache) {
      if (ts <= cutoff) this.dedupeCache.delete(fp);
    }
  }

  private makeFingerprint(from: string, to: string, content: string): string {
    const hash = createHash('sha1').update(content).digest('hex').slice(0, 16);
    return `${from}→${to}::${hash}`;
  }

  private getOrCreatePingPong(pairKey: string): PingPongTracker {
    let t = this.pingPongTrackers.get(pairKey);
    if (!t) {
      t = { directions: [], lastTimestamp: 0 };
      this.pingPongTrackers.set(pairKey, t);
    }
    // 超过 pingPongWindowMs 无活动则重置
    if (t.lastTimestamp > 0 && Date.now() - t.lastTimestamp > this.config.pingPongWindowMs) {
      t.directions = [];
    }
    return t;
  }

  /**
   * 乒乓检测策略：
   * - 4-5 次内严格交替 → degraded（仅降级 urgency）
   * - ≥ pingPongThreshold * 2 次（默认 10 次）严格交替 → blocked（阻断）
   * - 必须在 60s 时间窗内
   */
  private detectPingPong(tracker: PingPongTracker, now: number, currentDirection: string, record: boolean): null | 'degraded' | 'blocked' {
    // preCheck 时 tracker.directions 还没追加 currentDirection，需要临时考量
    const sequence = record
      ? tracker.directions
      : [...tracker.directions, currentDirection].slice(-this.config.pingPongThreshold * 2);

    if (sequence.length < this.config.pingPongThreshold) return null;

    // 时间窗校验：tracker 最近活动必须在窗口内
    if (tracker.lastTimestamp > 0 && now - tracker.lastTimestamp > this.config.pingPongWindowMs) {
      return null;
    }

    // 检查最近 N 条是否严格交替
    const checkLen = Math.min(sequence.length, this.config.pingPongThreshold * 2);
    const recent = sequence.slice(-checkLen);
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] === recent[i - 1]) return null;
    }

    if (recent.length >= this.config.pingPongThreshold * 2) return 'blocked';
    if (recent.length >= this.config.pingPongThreshold) return 'degraded';
    return null;
  }
}
