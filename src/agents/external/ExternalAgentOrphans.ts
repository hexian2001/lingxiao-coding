import { existsSync, readdirSync, readFileSync } from 'fs';
import { agentLogger } from '../../core/Log.js';
import { killProcess } from '../../utils/platform.js';
import { PidRegistry, isOrphanedEntry } from '../../core/PidRegistry.js';

/**
 * 扫描并终止孤儿外部 Agent 进程（claude / codex 子进程）。
 *
 * 实现策略（跨平台，确定性，与 killOrphanWorkers 对称）：
 *   1. 主路径 —— 枚举持久化注册表（PidRegistry）中所有 external-agent 条目。
 *      - 指定 sessionId（会话收尾）：清掉该会话的全部残留外部 Agent。
 *      - 未指定 sessionId（全局孤儿回收）：仅回收 isOrphanedEntry 判定为真孤儿的条目。
 *      全平台可用，不再依赖 /proc（旧实现 darwin 会落到 readdirSync('/proc') 抛错再被
 *      catch 兜底，每次调用都产生 warn 噪声 —— 已根治）。
 *   2. Linux 补充网 —— 旧版本遗留、未进注册表的孤儿仍可通过 /proc environ 标记兜底回收。
 *
 * @param sessionId 如果指定，只清理该 session 的外部 Agent；否则只清理真孤儿
 * @returns 清理的进程数
 */
export async function killExternalAgentOrphans(sessionId?: string): Promise<number> {
  let cleaned = 0;

  // 主路径：持久化注册表，全平台可用。
  try {
    const candidates = PidRegistry.listAll().filter(e => e.kind === 'external-agent');
    for (const entry of candidates) {
      if (sessionId) {
        if (entry.sessionId !== sessionId) continue;
      } else if (!isOrphanedEntry(entry)) {
        continue;
      }
      try {
        await killProcess(entry.pid, 'SIGTERM', { tree: true });
        cleaned++;
        PidRegistry.unregister(entry.pid);
        agentLogger.info(`[ExternalAgentOrphans] Sent SIGTERM to orphan external agent PID ${entry.pid} (session=${entry.sessionId})`);
      } catch {
        // Process may have already exited.
      }
    }
  } catch (error) {
    agentLogger.warn(`[ExternalAgentOrphans] Registry orphan scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Linux 补充网：回收旧版本遗留、未进注册表的孤儿外部 Agent。
  if (process.platform === 'linux') {
    cleaned += await scanProcForOrphanExternalAgents(sessionId);
  }

  return cleaned;
}

/**
 * Linux /proc 兜底扫描：找出 environ 中带 LINGXIAO_EXTERNAL_AGENT_SESSION 但不在注册表内
 * 的进程（旧版本遗留孤儿）。已在注册表内的由主路径处理，这里跳过避免重复计数。
 */
async function scanProcForOrphanExternalAgents(sessionId?: string): Promise<number> {
  let cleaned = 0;
  try {
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const envPath = `/proc/${pid}/environ`;
        if (!existsSync(envPath)) continue;
        const envContent = readFileSync(envPath, 'utf-8');
        if (!envContent.includes('LINGXIAO_EXTERNAL_AGENT_SESSION=')) continue;
        if (sessionId) {
          const match = envContent.match(/LINGXIAO_EXTERNAL_AGENT_SESSION=([^\x00]+)/);
          if (match && match[1] !== sessionId) continue;
        }
        const pidNum = Number.parseInt(pid, 10);
        // 已被注册表管辖 → 交主路径处理，避免重复。
        if (PidRegistry.findByPid(pidNum)) continue;
        try {
          await killProcess(pidNum, 'SIGTERM', { tree: true });
          cleaned++;
          agentLogger.info(`[ExternalAgentOrphans] /proc fallback: Sent SIGTERM to legacy orphan external agent PID ${pidNum}`);
        } catch {
          // Process may have already exited.
        }
      } catch {
        // Process may have exited or /proc env may be unreadable.
      }
    }
  } catch (error) {
    agentLogger.warn(`[ExternalAgentOrphans] /proc fallback scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cleaned;
}
