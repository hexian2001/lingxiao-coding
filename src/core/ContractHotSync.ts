/**
 * ContractHotSync — 契约热同步
 *
 * 监听 SharedLedger 的 contract 类型条目变更，
 * 向所有消费该 surface 的 running worker 广播增量更新。
 *
 * 架构：
 * - 订阅 SharedLedger 的 append/update 事件（通过轮询版本号）
 * - 维护 surface → consumer agents 的映射
 * - 变更时通过 MessageBus 发送 contract_delta 消息
 * - Worker 收到后更新内部契约认知（不中断执行）
 *
 * 与现有系统的关系：
 * - 补充 ContractPack 的启动时注入（ContractPack 只在 spawn 时生效）
 * - 与 BlackboardGraph 的 broadcastDelta 协同（blackboard 广播图变更，这里广播契约语义变更）
 */

import type { SharedLedger, LedgerEntry } from './SharedLedger.js';
import type { MessageBus } from './MessageBus.js';

export interface ContractConsumer {
  /** Agent 名称 */
  agentName: string;
  /** Agent 的 bus 地址 */
  busAddress: string;
  /** 该 agent 关注的 contract surface 列表 */
  surfaces: string[];
}

export interface ContractDelta {
  /** 变更类型 */
  action: 'created' | 'updated';
  /** 变更的 contract surface */
  surface: string;
  /** 新版本内容 */
  content: string;
  /** 版本号 (ledger entry id) */
  entryId: string;
  /** 被替代的旧版本 id */
  supersedes?: string;
}

export class ContractHotSync {
  private lastCheckedVersion = 0;
  private consumers = new Map<string, ContractConsumer>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private readonly pollMs: number;

  constructor(
    private readonly ledger: SharedLedger,
    private readonly bus: MessageBus,
    private readonly sessionId: string,
    options?: { pollMs?: number },
  ) {
    this.pollMs = options?.pollMs ?? 2000;
  }

  /**
   * 注册一个 contract consumer（worker 启动时调用）
   */
  registerConsumer(consumer: ContractConsumer): void {
    this.consumers.set(consumer.agentName, consumer);
  }

  /**
   * 移除 consumer（worker 结束时调用）
   */
  unregisterConsumer(agentName: string): void {
    this.consumers.delete(agentName);
  }

  /**
   * 根据任务的 contract_surface 自动注册 consumer
   */
  registerFromTask(agentName: string, busAddress: string, contractSurface?: string): void {
    if (!contractSurface) return;
    const existing = this.consumers.get(agentName);
    if (existing) {
      if (!existing.surfaces.includes(contractSurface)) {
        existing.surfaces.push(contractSurface);
      }
    } else {
      this.consumers.set(agentName, {
        agentName,
        busAddress,
        surfaces: [contractSurface],
      });
    }
  }

  /**
   * 启动轮询
   */
  start(): void {
    if (this.pollInterval) return;
    this.lastCheckedVersion = this.ledger.currentVersion;
    this.pollInterval = setInterval(() => this.check(), this.pollMs);
  }

  /**
   * 停止轮询
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * 手动触发检查（测试用或事件驱动模式）
   */
  check(): ContractDelta[] {
    const currentVersion = this.ledger.currentVersion;
    if (currentVersion === this.lastCheckedVersion) return [];

    // 查询自上次检查以来的新 contract 条目
    const newContracts = this.ledger.query({
      type: 'contract',
      latestOnly: false,
    }).filter(entry => {
      // 通过 id 编号判断是否是新的
      const num = parseInt(entry.id.replace('L-', ''), 10);
      return num > this.getLastCheckedEntryNum();
    });

    this.lastCheckedVersion = currentVersion;

    if (newContracts.length === 0) return [];

    const deltas: ContractDelta[] = [];
    for (const entry of newContracts) {
      const delta: ContractDelta = {
        action: entry.supersedes ? 'updated' : 'created',
        surface: entry.surface,
        content: entry.content,
        entryId: entry.id,
        supersedes: entry.supersedes,
      };
      deltas.push(delta);
      this.broadcastToConsumers(delta);
    }

    return deltas;
  }

  /**
   * 向关注该 surface 的所有 consumer 广播
   */
  private broadcastToConsumers(delta: ContractDelta): void {
    for (const consumer of this.consumers.values()) {
      const interested = consumer.surfaces.some(
        s => s.toLowerCase() === delta.surface.toLowerCase() || s === '*',
      );
      if (interested) {
        this.bus.send(
          `${this.sessionId}:contract-sync`,
          consumer.busAddress,
          'system_context',
          `[Contract Update] ${delta.action}: ${delta.surface}\n${delta.content}`,
        );
      }
    }
  }

  /**
   * 获取上次检查时的最大 entry 编号
   */
  private getLastCheckedEntryNum(): number {
    // 利用 ledger 的 snapshot 来推算
    // 简化实现：用 version 差值近似
    return Math.max(0, this.lastCheckedVersion - 1);
  }

  /** 当前注册的 consumer 数量 */
  get consumerCount(): number { return this.consumers.size; }

  /** 是否正在轮询 */
  get isRunning(): boolean { return this.pollInterval !== null; }

  dispose(): void {
    this.stop();
    this.consumers.clear();
  }
}
