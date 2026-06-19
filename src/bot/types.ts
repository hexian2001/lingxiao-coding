/**
 * QQ Bot 类型定义
 *
 * 基于 QQ 官方机器人 API (bot.q.qq.com)
 */

import type { CoreQQBotStatus } from '../core/StateSemantics.js';

/** QQ Bot 配置 */
export interface QQBotConfig {
  /** 是否启用 */
  enabled: boolean;
  /** QQ 开放平台 App ID */
  appId: string;
  /** QQ 开放平台 App Secret */
  secret: string;
  /** 是否为沙箱环境 */
  sandbox?: boolean;
  /** 允许的频道 ID 列表（空 = 全部允许） */
  allowedGuilds?: string[];
  /**
   * 允许的用户 ID 白名单（openid）。
   *
   * 安全语义为 fail-closed：未配置/为空时**默认拒绝所有人**，而非放行。
   * QQBot 接入的是公网任意 QQ 用户输入，消息会被直接投喂给拥有完整工具
   * 权限的 daemon 守护会话，空白名单放行等于把 prompt injection → RCE 的
   * 入口对全网开放。仅命中此列表的用户才会被处理。
   */
  allowedUsers?: string[];
  /**
   * 显式放行所有用户的逃生开关（默认 false）。
   *
   * 仅当确实需要让任意公网 QQ 用户都能与 Bot 交互时才设为 true，且需自行
   * 承担风险——启动时会打印安全告警。绝大多数场景应保持 false 并配置
   * allowedUsers 白名单。
   */
  allowAnyone?: boolean;
}

/** QQ Bot 连接状态 */
export type QQBotStatus = CoreQQBotStatus;

/** QQ Bot 运行时状态 */
export interface QQBotRuntimeStatus {
  status: QQBotStatus;
  appId?: string;
  connectedAt?: number;
  messageCount?: number;
  lastMessageAt?: number;
  error?: string;
}

/** QQ 收到的消息 */
export interface QQBotIncomingMessage {
  /** 消息 ID */
  id: string;
  /** 频道 ID (频道消息) */
  guildId?: string;
  /** 子频道 ID */
  channelId?: string;
  /** 发送者 ID */
  authorId: string;
  /** 发送者名称 */
  authorName: string;
  /** 消息内容 */
  content: string;
  /** 是否为私信 */
  isDirectMessage: boolean;
  /** 时间戳 */
  timestamp: number;
  /** 消息来源: group(群聊) | c2c(单聊) | guild(频道) | dm(频道私信) */
  source?: 'group' | 'c2c' | 'guild' | 'dm';
  /** 群聊的群 openid (GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE) */
  groupOpenid?: string;
}

/** QQ 发送的消息 */
export interface QQBotOutgoingMessage {
  /** 目标频道 ID */
  channelId?: string;
  /** 目标消息 ID（用于回复） */
  msgId?: string;
  /** 消息内容 */
  content: string;
  /** 图片 URL */
  imageUrl?: string;
}

/** QQ Bot 会话绑定 */
export interface QQBotSessionBinding {
  /** QQ 频道/用户 ID → 凌霄 session ID */
  channelKey: string;
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
}
