import os from 'os';
import fs from 'fs';
import type { SessionStateRepository } from '../core/DatabaseRepositories.js';
import { VERSION } from '../version.js';

/**
 * Storage KV API — UI 状态持久化
 */
export class StorageApi {
  constructor(private sessionState: SessionStateRepository) {}

  getValue(key: string, scope: string): { value: unknown } | null {
    try {
      const value = this.sessionState.get(scope, `web:${key}`);
      return value ? { value } : null;
    } catch (err) {
      // 声称「DB 可能未就绪」，但实际 catch 覆盖了查询/序列化/锁竞争等所有错误；
      // 持久化的 DB 故障不应静默退化成「无保存状态」，记 warn 以便定位。
      console.warn(`[StorageApi] getValue(${key}) 失败，返回 null:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  getNamespace(namespace: string, scope: string): Record<string, unknown> {
    try {
      const fullPrefix = `web:${namespace}`;
      const rows = this.sessionState.listByPrefix(scope, fullPrefix) ?? [];
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        const displayKey = row.key.startsWith('web:') ? row.key.slice(4) : row.key;
        result[displayKey] = row.value;
      }
      return result;
    } catch (err) {
      console.warn(`[StorageApi] getNamespace(${namespace}) 失败，返回空对象:`, err instanceof Error ? err.message : String(err));
      return {};
    }
  }

  setValue(key: string, value: unknown, scope: string): { success: boolean; error?: string } {
    try {
      const serializedValue = typeof value === 'string' ? value : JSON.stringify(value);
      this.sessionState.set(scope, `web:${key}`, serializedValue);
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `setValue failed for key "${key}": ${message}` };
    }
  }

  setEntries(entries: Array<{ key: string; value: unknown }>, scope: string): { success: boolean; errors?: string[] } {
    const errors: string[] = [];
    for (const entry of entries) {
      const result = this.setValue(entry.key, entry.value, scope);
      if (!result.success && result.error) errors.push(result.error);
    }
    return errors.length > 0 ? { success: false, errors } : { success: true };
  }

  deleteValue(key: string, scope: string): { success: boolean; error?: string } {
    try {
      this.sessionState.delete(scope, `web:${key}`);
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `deleteValue failed for key "${key}": ${message}` };
    }
  }
}

/**
 * 系统信息 API
 */
export function getSystemInfo() {
  const uptime = process.uptime();
  const osRelease = `${os.type()} ${os.release()}`;
  return {
    cwd: process.cwd(),
    version: VERSION,
    os: process.platform,
    osRelease,
    arch: process.arch,
    nodeVersion: process.version,
    gatewayMode: 'local',
    tunnelUrl: null as string | null,
    uptime,
    hostname: os.hostname(),
    userName: os.userInfo().username,
    homeDir: os.homedir(),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemMib: Math.round(os.totalmem() / (1024 * 1024)),
  };
}

/**
 * 获取磁盘使用量。在 Linux 上优先用 statfs(cwd) 拿真实剩余/总量；
 * 失败（Windows、文件系统不支持）时返回 0，由前端显示 "—"。
 */
function getDiskUsage(): { used: number; total: number } {
  try {
    const anyFs = fs as unknown as { statfsSync?: (path: string) => { bsize?: number; f_frsize?: number; blocks?: number; bavail?: number; bfree?: number } };
    if (typeof anyFs.statfsSync === 'function') {
      const s = anyFs.statfsSync(process.cwd());
      const blockSize = Number(s.bsize ?? s.f_frsize ?? 4096);
      const total = Number(s.blocks ?? 0) * blockSize;
      const free = Number(s.bavail ?? s.bfree ?? 0) * blockSize;
      if (total > 0) return { used: total - free, total };
    }
  } catch { /* expected: statfsSync may not be available on all platforms */
    // fall through
  }
  return { used: 0, total: 0 };
}

/**
 * 系统指标 API
 */
export function getSystemMetrics() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  // 真实 CPU 使用率：对每个核心的 times(idle/total) 做采样差分。
  // 单次调用退化为 loadavg 近似，但调用频繁时（前端轮询）后续采样即为真值。
  const cpuUsedPct = computeCpuUsedPct();
  const disk = getDiskUsage();

  return {
    ts: Math.floor(Date.now() / 1000),
    cpuCount: cpus.length,
    cpuUsedPct,
    memTotalMib: Math.round(totalMem / (1024 * 1024)),
    memUsedMib: Math.round((totalMem - freeMem) / (1024 * 1024)),
    diskUsed: Math.round(disk.used / (1024 * 1024)),
    diskTotal: Math.round(disk.total / (1024 * 1024)),
    // instances: reserved for future multi-daemon cluster view.
    // Currently the web-server runs inside a single daemon process and has no
    // registry of peer instances, so this is always empty.
    instances: [] as Array<Record<string, unknown>>,
  };
}

// — CPU 使用率采样 —
let lastCpuSample: { idle: number; total: number; ts: number } | null = null;

function snapshotCpu(): { idle: number; total: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.idle + t.user + t.nice + t.sys + t.irq;
  }
  return { idle, total };
}

function computeCpuUsedPct(): number {
  try {
    const now = snapshotCpu();
    if (!lastCpuSample || now.total <= lastCpuSample.total) {
      lastCpuSample = { ...now, ts: Date.now() };
      // 无差分可用：退化到 loadavg 近似
      const cpus = os.cpus().length || 1;
      return Math.max(0, Math.min(100, Math.round((os.loadavg()[0] / cpus) * 100 * 100) / 100));
    }
    const idleDelta = now.idle - lastCpuSample.idle;
    const totalDelta = now.total - lastCpuSample.total;
    lastCpuSample = { ...now, ts: Date.now() };
    if (totalDelta <= 0) return 0;
    const pct = (1 - idleDelta / totalDelta) * 100;
    return Math.max(0, Math.min(100, Math.round(pct * 100) / 100));
  } catch { /* expected: os.cpus() may return empty on some environments */
    return 0;
  }
}
