/**
 * QQBotConfig — QQ Bot 配置管理
 *
 * 配置存储在文件 ~/.lingxiao/qqbot.json（两个进程都能读写）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../config.js';
import type { QQBotConfig } from './types.js';

const CONFIG_FILE = join(CONFIG_DIR, 'qqbot.json');

const DEFAULT_CONFIG: QQBotConfig = {
  enabled: false,
  appId: '',
  secret: '',
  sandbox: false,
  allowedGuilds: [],
  allowedUsers: [],
  // fail-closed：默认不放行任意用户，必须显式配置 allowedUsers 或开启 allowAnyone
  allowAnyone: false,
};

/**
 * 从文件读取 QQ Bot 配置
 */
export function getQQBotConfig(): QQBotConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {/* expected: fallback to default */
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 保存 QQ Bot 配置到文件
 */
export function setQQBotConfig(config: Partial<QQBotConfig>): QQBotConfig {
  const current = getQQBotConfig();
  const merged = { ...current, ...config };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/**
 * 验证配置是否完整
 */
export function isConfigValid(config: QQBotConfig): boolean {
  return !!(config.appId && config.secret);
}
